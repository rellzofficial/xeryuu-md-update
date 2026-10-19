'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const pino = require('pino')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeInMemoryStore,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys')
const { MessagesUpsert, Solving, getMessageBody } = require('../source/message')
const { shouldProcessLiveAppendMessage, isCommandCandidate } = require('../source/upsert-policy')
const waConn = require('./wa-connection')

// Every purchase/order gets its own Baileys auth directory and socket. Never
// reuse one auth directory for different buyers: creds.json and Signal keys are
// account-specific and would cause sessions to replace or corrupt each other.
const PROJECT_ROOT = path.resolve(__dirname, '..')
const PROJECT_JADIBOT_ROOT = path.join(PROJECT_ROOT, 'connection', 'jadibot')
const LEGACY_JADIBOT_ROOT = path.join(process.cwd(), 'connection', 'jadibot')
function hasJadibotAuthState(root) {
    try {
        if (fs.existsSync(path.join(root, 'creds.json'))) return true
        return fs.readdirSync(root, { withFileTypes: true }).some(entry =>
            entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'creds.json'))
        )
    } catch { return false }
}
const useLegacyJadibotRoot = path.resolve(LEGACY_JADIBOT_ROOT) !== path.resolve(PROJECT_JADIBOT_ROOT) &&
    fs.existsSync(LEGACY_JADIBOT_ROOT) && (
        !fs.existsSync(PROJECT_JADIBOT_ROOT) ||
        (hasJadibotAuthState(LEGACY_JADIBOT_ROOT) && !hasJadibotAuthState(PROJECT_JADIBOT_ROOT))
    )
const ROOT = useLegacyJadibotRoot ? LEGACY_JADIBOT_ROOT : PROJECT_JADIBOT_ROOT
const PROJECT_META_FILE = path.join(PROJECT_ROOT, 'library', 'database', 'jadibot-session.json')
const LEGACY_META_FILE = path.join(process.cwd(), 'library', 'database', 'jadibot-session.json')
const META_FILE = path.resolve(LEGACY_META_FILE) !== path.resolve(PROJECT_META_FILE) &&
    fs.existsSync(LEGACY_META_FILE) && !fs.existsSync(PROJECT_META_FILE)
    ? LEGACY_META_FILE
    : PROJECT_META_FILE
const logger = pino({ level: global.runtimeConfig?.logLevel || 'silent' })
const WA_VERSION = String(
    global.runtimeConfig?.waVersion ||
    global.waVersion ||
    '2,3000,1044539926'
).split(',').map(v => Number(v.trim())).filter(Number.isFinite)

// sessionId -> live session; metadata is persisted separately so every buyer's
// linked device can be restored independently after a VPS/process restart.
const sessions = new Map()
// Prevent duplicate pairing attempts for the same order from opening two sockets
// against the same auth directory when repeated inputs arrive close together.
const pendingPairs = new Map()
let notify = null
let shuttingDown = false

function ensureDirs() {
    fs.mkdirSync(ROOT, { recursive: true })
    fs.mkdirSync(path.dirname(META_FILE), { recursive: true })
}

// Nomor untuk pairing: 0812... dan +62 0812... diubah ke 62812... agar kode pairing valid
// baik untuk WhatsApp biasa maupun WhatsApp Business.
function normalizePhone(value) {
    return waConn.normalizePairingNumber(value) || String(value || '').replace(/\D/g, '')
}

function normalizeNumber(value) {
    return String(value || '').replace(/\D/g, '')
}

function hashId(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24)
}

function makeSessionId(meta = {}) {
    const orderRef = String(meta.orderRef || '').trim()
    if (orderRef) return `order-${hashId(orderRef)}`
    // Compatibility for older callers that did not supply an order reference.
    return `owner-${hashId(`${meta.ownerJid || ''}|${normalizeNumber(meta.phoneNumber)}`)}`
}

function safeSessionId(value) {
    const id = String(value || '')
    return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : `session-${hashId(id)}`
}

function sessionPath(sessionId) {
    return path.join(ROOT, safeSessionId(sessionId))
}

function rawReadMeta() {
    ensureDirs()
    try {
        return JSON.parse(fs.readFileSync(META_FILE, 'utf8'))
    } catch {
        return null
    }
}

function writeSessionStore(store) {
    ensureDirs()
    const tmp = `${META_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
    fs.renameSync(tmp, META_FILE)
}

function migrateLegacyAuthFiles(sessionId) {
    // Version before multi-buyer support kept creds directly in ROOT. Move only
    // root-level files into that legacy session's private subdirectory; leave
    // already-created session directories untouched.
    ensureDirs()
    const destination = sessionPath(sessionId)
    const entries = fs.readdirSync(ROOT, { withFileTypes: true })
        .filter(entry => entry.isFile())
    if (!entries.length) return
    fs.mkdirSync(destination, { recursive: true })
    for (const entry of entries) {
        const from = path.join(ROOT, entry.name)
        const to = path.join(destination, entry.name)
        try {
            if (!fs.existsSync(to)) fs.renameSync(from, to)
            else fs.rmSync(from, { force: true })
        } catch (err) {
            console.error('[JADIBOT LEGACY MIGRATION]', entry.name, err?.message || err)
        }
    }
}

function loadSessionStore() {
    const raw = rawReadMeta()
    if (raw && raw.version === 2 && raw.sessions && typeof raw.sessions === 'object') {
        return { version: 2, sessions: raw.sessions }
    }

    // Migrate the old single-session metadata structure without forcing the
    // existing buyer to scan a new QR/pairing code.
    if (raw && raw.ownerJid) {
        const sessionId = safeSessionId(raw.sessionId || makeSessionId(raw))
        migrateLegacyAuthFiles(sessionId)
        const migrated = {
            version: 2,
            sessions: {
                [sessionId]: { ...raw, sessionId }
            }
        }
        writeSessionStore(migrated)
        return migrated
    }
    return { version: 2, sessions: {} }
}

function saveMeta(sessionId, meta) {
    const id = safeSessionId(sessionId || makeSessionId(meta))
    const store = loadSessionStore()
    const previous = store.sessions[id] || {}
    store.sessions[id] = {
        ...previous,
        ...meta,
        sessionId: id,
        updatedAt: Date.now()
    }
    store.version = 2
    writeSessionStore(store)
    return store.sessions[id]
}

function clearMeta(sessionId) {
    if (!sessionId) {
        try { fs.unlinkSync(META_FILE) } catch {}
        return
    }
    const id = safeSessionId(sessionId)
    const store = loadSessionStore()
    delete store.sessions[id]
    writeSessionStore(store)
}

function allMetas() {
    const store = loadSessionStore()
    return Object.entries(store.sessions).map(([sessionId, meta]) => ({
        ...meta,
        sessionId: safeSessionId(meta?.sessionId || sessionId)
    }))
}

function clearAuthFiles(sessionId) {
    const directory = sessionPath(sessionId)
    try { fs.rmSync(directory, { recursive: true, force: true }) } catch (err) {
        console.error('[JADIBOT AUTH CLEANUP]', err?.message || err)
    }
}

function isConnected(next) {
    // Baileys may retain `socket.user` after a temporary disconnect. Treat the
    // session as connected only after our connection.update listener has marked
    // the current socket open as well.
    return Boolean(next?.socket?.isConnected === true && next?.socket?.user)
}

function connected() {
    for (const next of sessions.values()) {
        if (isConnected(next)) return true
    }
    return false
}

function normalizeOwner(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/:\d+(?=@)/, '')
    if (!raw) return ''
    if (raw.includes('@s.whatsapp.net')) return `${normalizeNumber(raw.split('@')[0])}@s.whatsapp.net`
    if (raw.includes('@c.us')) return `${normalizeNumber(raw.split('@')[0])}@s.whatsapp.net`
    return raw
}

function sameOwner(a, b) {
    const left = normalizeOwner(a)
    const right = normalizeOwner(b)
    if (!left || !right) return false
    if (left === right) return true
    const leftDigits = normalizeNumber(left.split('@')[0])
    const rightDigits = normalizeNumber(right.split('@')[0])
    // Match the command router's fallback for Baileys variants that expose a
    // phone JID on one event and a LID/device JID on another.
    return leftDigits.length >= 7 && leftDigits === rightDigits
}

function ownerSelectorMatches(meta, selector) {
    const selectors = Array.isArray(selector) ? selector : [selector]
    return selectors.filter(Boolean).some(value => sameOwner(meta?.ownerJid, value))
}

function describeSession(meta) {
    const id = safeSessionId(meta?.sessionId || makeSessionId(meta))
    const live = sessions.get(id)
    let status = String(meta?.status || 'DISCONNECTED').toUpperCase()
    if (live) {
        if (isConnected(live)) status = 'CONNECTED'
        else if (live.connectionClosed && (live.reconnecting || live.reconnectTimer)) status = 'CONNECTING'
        else if (live.pairingCode && !live.connectionClosed) status = 'PAIRING'
        else if (!live.connectionClosed) status = 'CONNECTING'
        else status = 'DISCONNECTED'
    }
    return {
        ...meta,
        sessionId: id,
        status,
        pairingCode: live?.pairingCode || ''
    }
}

function getInfo(ownerSelector) {
    let infos = allMetas().map(describeSession)
    if (ownerSelector) infos = infos.filter(info => ownerSelectorMatches(info, ownerSelector))
    // Repair UX: when the buyer has several sessions, surface a logged-out one
    // first; otherwise use the most recently updated session for that buyer.
    infos.sort((a, b) => {
        const aLoggedOut = String(a.status).toUpperCase() === 'LOGGED_OUT' ? 1 : 0
        const bLoggedOut = String(b.status).toUpperCase() === 'LOGGED_OUT' ? 1 : 0
        return bLoggedOut - aLoggedOut || Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)
    })
    return infos[0] || null
}

function getInfos(ownerSelector) {
    let infos = allMetas().map(describeSession)
    if (ownerSelector) infos = infos.filter(info => ownerSelectorMatches(info, ownerSelector))
    return infos.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
}

async function sendNotice(jid, text) {
    if (typeof notify !== 'function') return false
    try {
        await notify(jid, text)
        return true
    } catch (e) {
        console.error('[JADIBOT NOTIFY]', e?.message || e)
        return false
    }
}

async function sendPairingCodeNotice(sessionId, current, attempt = 0) {
    const code = String(current?.pairingCode || '').trim()
    if (!code || shuttingDown || current?.credentialsRegistered || current?.socket?.isConnected === true || sessions.get(sessionId)?.socket !== current?.socket) return false
    const text =
        `> 🔐 *KODE PAIRING JADIBOT DIPERBARUI*\n> \n` +
        `> 📱 Nomor: *${current.phoneNumber || '-'}*\n` +
        `> 🧾 Order: *${current.orderRef || '-'}*\n` +
        `> 🔑 Kode pairing terbaru: *${code}*\n> \n` +
        `> Buka WhatsApp pada nomor tersebut → *Perangkat tertaut* → *Tautkan perangkat dengan nomor telepon*, lalu masukkan kode ini.\n> \n` +
        `> Gunakan kode terbaru ini; jangan bagikan kepada orang lain.`
    const sent = await sendNotice(current.ownerJid, text)
    if (!sent && attempt < 5 && !shuttingDown) {
        const retry = setTimeout(() => {
            void sendPairingCodeNotice(sessionId, current, attempt + 1)
        }, 5000)
        retry.unref?.()
    }
    return sent
}

function makeOptions(state, store, version) {
    const options = {
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(
                state.keys,
                pino({ level: 'silent' }).child({ level: 'silent', stream: 'jadibot-keys' })
            )
        },
        logger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: waConn.KEEPALIVE_INTERVAL_MS,
        browser: ['Ubuntu', 'Chrome', '22.04.4'],
        getMessage: async key => {
            try {
                const saved = await store?.loadMessage?.(key.remoteJid, key.id)
                return saved?.message || undefined
            } catch {
                return undefined
            }
        }
    }
    if (Array.isArray(version) && version.length === 3) options.version = version
    return options
}

function scheduleReconnect(next, delay = 5000) {
    if (!next || shuttingDown || next.reconnectTimer || next.loggedOut) return
    const sessionId = next.sessionId
    next.reconnectTimer = setTimeout(async () => {
        next.reconnectTimer = null
        if (shuttingDown || sessions.get(sessionId) !== next || next.loggedOut) return
        // Reserve this session while the replacement socket is being created.
        // Without this flag, a repeated pair/order request could create another
        // socket against the same auth directory during the reconnect window.
        next.reconnecting = true
        try {
            // A session that has not completed pairing needs a fresh pairing
            // code after reconnect. A registered linked-device session only
            // needs the socket restored and must not be forced through pairing.
            const requestCode = !next.credentialsRegistered
            const replacement = await openSession({
                sessionId,
                ownerJid: next.ownerJid,
                phoneNumber: next.phoneNumber,
                orderRef: next.orderRef,
                waAttempt: next.waAttempt,
                failures: next.failures,
                status: requestCode ? 'PAIRING' : 'CONNECTING'
            }, requestCode)
            if (requestCode && replacement.pairingCode) {
                void sendPairingCodeNotice(sessionId, replacement)
            }
        } catch (err) {
            next.reconnecting = false
            console.error('[JADIBOT RECONNECT]', err?.stack || err)
            saveMeta(sessionId, {
                ownerJid: next.ownerJid,
                phoneNumber: next.phoneNumber,
                orderRef: next.orderRef,
                status: next.credentialsRegistered ? 'RECONNECT_FAILED' : 'PAIRING',
                lastError: String(err?.message || err).slice(0, 300)
            })
            // Keep retrying transient network/session setup errors. A real
            // LOGGED_OUT status is handled separately and does not auto-retry.
            // openSession may have installed and then removed a partially-created
            // socket before throwing. Re-register the old session object only as
            // a retry anchor; its socket is closed and cannot process messages.
            if (!shuttingDown && !sessions.has(sessionId)) sessions.set(sessionId, next)
            if (sessions.get(sessionId) === next) scheduleReconnect(next, 10000)
        }
    }, delay)
}

async function openSession(meta, requestCode = false) {
    ensureDirs()
    const sessionId = safeSessionId(meta.sessionId || makeSessionId(meta))
    const authDir = sessionPath(sessionId)
    fs.mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const store = makeInMemoryStore({
        logger: pino({ level: 'silent' }).child({ level: 'silent', stream: `jadibot-store-${sessionId}` })
    })
    const resolvedVersion = await waConn.resolveWaVersion({
        attempt: Number(meta.waAttempt) || 0,
        force: Number(meta.waAttempt) > 0
    })
    const socket = makeWASocket(makeOptions(state, store, resolvedVersion.version))
    socket.__xeryuuStore = store
    socket.__xeryuuRole = 'JADIBOT'
    socket.isConnected = false
    socket.__xeryuuOpenedAt = 0
    // Register this observer immediately: connection can progress while Solving
    // initializes helpers, and append-live filtering must know the first open time.
    socket.ev.on('connection.update', update => {
        if (update?.connection === 'open') {
            socket.__xeryuuOpenedAt = Math.floor(Date.now() / 1000)
        }
    })

    const next = {
        sessionId,
        socket,
        store,
        ownerJid: String(meta.ownerJid || ''),
        phoneNumber: normalizePhone(meta.phoneNumber),
        orderRef: String(meta.orderRef || ''),
        waAttempt: Number(meta.waAttempt) || 0,
        failures: Number(meta.failures) || 0,
        pairingCode: '',
        pairingRequested: false,
        credentialsRegistered: Boolean(state.creds?.registered),
        reconnecting: false,
        connectionClosed: false,
        loggedOut: false,
        reconnectTimer: null
    }
    socket.__xeryuuSessionId = sessionId
    socket.__xeryuuOwnerJid = next.ownerJid
    socket.__xeryuuOwnerJids = next.ownerJid ? [next.ownerJid] : []
    socket.__xeryuuOrderRef = next.orderRef
    sessions.set(sessionId, next)

    try {
        await Solving(socket, store)
        socket.public = true
        store.bind(socket.ev)

        // A replaced/closed socket must not race-write this session's auth data.
        socket.ev.on('creds.update', update => {
            if (next.loggedOut || next.connectionClosed || sessions.get(sessionId)?.socket !== socket) return
            next.credentialsRegistered = Boolean(state.creds?.registered)
            Promise.resolve(saveCreds(update)).catch(err => {
                console.error(`[JADIBOT SAVE CREDS][${sessionId}]`, err?.message || err)
            })
        })

        const dispatchUpsert = async update => {
            try {
                if (shuttingDown || !Array.isArray(update?.messages) || !update.messages.length) return
                if (sessions.get(sessionId)?.socket !== socket) return
                const updateType = String(update?.type || 'notify')
                let fresh = update.messages
                if (updateType === 'append') {
                    // Same guarded compatibility path as the main socket: a
                    // fresh command synthesized from a button can be handled,
                    // but historical order/admin commands are never replayed.
                    fresh = update.messages.filter(msg => {
                        const body = String(getMessageBody({ message: msg?.message || {} }) || '').trim()
                        const chat = String(msg?.key?.remoteJid || '')
                        const prefix = chat.endsWith('@g.us')
                            ? (global.db?.groups?.[chat]?.prefix || '.')
                            : '.'
                        return shouldProcessLiveAppendMessage(
                            msg,
                            socket.__xeryuuOpenedAt,
                            body,
                            prefix
                        )
                    })
                    if (!fresh.length) {
                        const candidateCount = update.messages.filter(msg => {
                            const body = String(getMessageBody({ message: msg?.message || {} }) || '').trim()
                            const chat = String(msg?.key?.remoteJid || '')
                            const prefix = chat.endsWith('@g.us')
                                ? (global.db?.groups?.[chat]?.prefix || '.')
                                : '.'
                            return isCommandCandidate(body, chat, prefix)
                        }).length
                        if (candidateCount) {
                            console.warn(`[JADIBOT UPSERT SKIPPED][${sessionId}] type=append candidates=${candidateCount}; tidak diproses karena bukan command live setelah koneksi siap.`)
                        }
                        return
                    }
                    console.log(`[JADIBOT UPSERT APPEND LIVE][${sessionId}] count=${fresh.length}`)
                }

                const commandMessages = fresh.filter(msg => {
                    const body = String(getMessageBody({ message: msg?.message || {} }) || '').trim()
                    const chat = String(msg?.key?.remoteJid || '')
                    const prefix = chat.endsWith('@g.us')
                        ? (global.db?.groups?.[chat]?.prefix || '.')
                        : '.'
                    return isCommandCandidate(body, chat, prefix)
                })
                if (commandMessages.length) {
                    console.log(`[UPSERT COMMAND CANDIDATE][JADIBOT:${sessionId}] type=${updateType} count=${commandMessages.length}`)
                }

                await MessagesUpsert(socket, { ...update, messages: fresh }, store)
            } catch (err) {
                console.error(`[JADIBOT MESSAGE HANDLER][${sessionId}]`, err?.stack || err)
            }
        }

        socket.ev.on('messages.upsert', update => {
            void dispatchUpsert(update).catch(err => console.error(`[JADIBOT UPSERT ERROR][${sessionId}]`, err?.stack || err))
        })
        console.log(`[DIAGNOSTIC][JADIBOT:${sessionId}] message pipeline: single ev.on listener aktif; append-live guard armed; dedup terpusat`)

        socket.ev.on('connection.update', async update => {
            const { connection, lastDisconnect } = update || {}
            if (connection === 'open') {
                socket.isConnected = true
                socket.__xeryuuOpenedAt = Math.floor(Date.now() / 1000)
                next.credentialsRegistered = Boolean(state.creds?.registered || socket.user)
                next.connectionClosed = false
                next.loggedOut = false
                next.reconnecting = false
                next.pairingRequested = true
                next.failures = 0
                next.waAttempt = 0
                saveMeta(sessionId, {
                    ownerJid: next.ownerJid,
                    phoneNumber: next.phoneNumber,
                    orderRef: next.orderRef,
                    status: 'CONNECTED',
                    connectedAt: Date.now()
                })
                await sendNotice(
                    next.ownerJid,
                    `> ✅ *JADIBOT BERHASIL TERHUBUNG*\n> \n> 📱 Nomor: *${next.phoneNumber}*\n> 🧾 Order: *${next.orderRef || '-'}*\n> \n> Session bot kamu sekarang sudah aktif.`
                )
                return
            }

            if (connection !== 'close' || shuttingDown) return
            socket.isConnected = false
            next.connectionClosed = true
            if (sessions.get(sessionId)?.socket !== socket) return

            const code = Number(lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode ?? 0)
            console.warn(`[JADIBOT CONNECTION CLOSED][${sessionId}] code=${code || 'unknown'} error=${String(lastDisconnect?.error?.message || 'unknown').slice(0, 180)}`)
            if (code === DisconnectReason.loggedOut) {
                next.loggedOut = true
                if (sessions.get(sessionId) === next) sessions.delete(sessionId)
                clearAuthFiles(sessionId)
                saveMeta(sessionId, {
                    ownerJid: next.ownerJid,
                    phoneNumber: next.phoneNumber,
                    orderRef: next.orderRef,
                    status: 'LOGGED_OUT',
                    loggedOutAt: Date.now()
                })
                console.warn(`[JADIBOT LOGGED OUT][${sessionId}] auth files cleared; order=${next.orderRef || '-'}`)
                await sendNotice(
                    next.ownerJid,
                    '> ❌ *SESSION JADIBOT TERPUTUS DARI WHATSAPP*\n> \n> WhatsApp menandai perangkat tertaut ini sebagai logout. Kredensial sesi ini sudah dibersihkan.\n> \n> Kamu tidak perlu membuat order baru untuk mencoba pairing ulang. Buka chat pribadi bot penjual dan kirim *.jadibotrepair*.\n> \n> Logout resmi dari WhatsApp tidak dapat dicegah oleh bot; perangkat perlu ditautkan ulang.'
                )
                return
            }

            const pairingPending = !Boolean(state.creds?.registered || next.credentialsRegistered)
            saveMeta(sessionId, {
                ownerJid: next.ownerJid,
                phoneNumber: next.phoneNumber,
                orderRef: next.orderRef,
                status: pairingPending ? 'PAIRING' : 'RECONNECTING',
                lastDisconnectAt: Date.now(),
                lastDisconnectCode: code || null
            })

            // 515 = WhatsApp minta socket dibuat ulang; wajib terjadi setelah pairing berhasil.
            if (code === 515 && next.failures < 5) {
                scheduleReconnect(next, 1500)
                return
            }
            next.failures += 1
            // 405: coba versi WhatsApp Web berbeda pada socket berikutnya.
            if (code === 405) next.waAttempt += 1
            // Instance lain memakai folder session yang sama. Mengulang terus hanya membuat
            // dua proses saling menendang dan menghajar server WhatsApp.
            if (code === DisconnectReason.connectionReplaced && next.failures >= 3) {
                console.warn(`[JADIBOT STOP][${sessionId}] session dipakai koneksi lain berulang kali; reconnect dihentikan.`)
                saveMeta(sessionId, {
                    ownerJid: next.ownerJid,
                    phoneNumber: next.phoneNumber,
                    orderRef: next.orderRef,
                    status: 'RECONNECT_FAILED',
                    lastError: 'Session dipakai koneksi lain (440). Pastikan hanya satu instance bot berjalan.'
                })
                return
            }
            if (next.failures > 12) {
                console.warn(`[JADIBOT STOP][${sessionId}] gagal tersambung ${next.failures} kali beruntun; reconnect dihentikan sampai bot di-restart.`)
                saveMeta(sessionId, {
                    ownerJid: next.ownerJid,
                    phoneNumber: next.phoneNumber,
                    orderRef: next.orderRef,
                    status: pairingPending ? 'PAIRING' : 'RECONNECT_FAILED',
                    lastError: `Gagal tersambung ${next.failures} kali beruntun (kode terakhir ${code || 'unknown'}).`
                })
                return
            }
            scheduleReconnect(next, waConn.backoffDelay(next.failures, 5000, 60000))
        })

        if (requestCode && !state.creds.registered) {
            await new Promise(resolve => setTimeout(resolve, 2500))
            if (sessions.get(sessionId)?.socket !== socket || next.connectionClosed) {
                throw new Error('Session jadibot tidak aktif.')
            }
            const code = await socket.requestPairingCode(next.phoneNumber)
            if (!code) throw new Error('Pairing code tidak berhasil dibuat.')
            next.pairingCode = String(code)
            next.pairingRequested = true
            saveMeta(sessionId, {
                ownerJid: next.ownerJid,
                phoneNumber: next.phoneNumber,
                orderRef: next.orderRef,
                status: 'PAIRING',
                pairingRequestedAt: Date.now()
            })
        }
        return next
    } catch (err) {
        if (sessions.get(sessionId)?.socket === socket) sessions.delete(sessionId)
        next.connectionClosed = true
        clearTimeout(next.reconnectTimer)
        try { socket.ws?.close() } catch {}
        try { socket.end?.(err) } catch {}
        throw err
    }
}

async function pairSession({ ownerJid, phoneNumber, orderRef = '' }) {
    const owner = String(ownerJid || '')
    const phone = normalizePhone(phoneNumber)
    if (!owner) throw new Error('Pemilik jadibot tidak valid.')
    if (phone.length < 8 || phone.length > 15) throw new Error('Nomor WhatsApp tidak valid.')

    const meta = { ownerJid: owner, phoneNumber: phone, orderRef: String(orderRef || '') }
    const sessionId = makeSessionId(meta)
    const existingLive = sessions.get(sessionId)
    if (existingLive) {
        if (!sameOwner(existingLive.ownerJid, owner)) throw new Error('Order Jadibot ini dimiliki user lain.')
        if (isConnected(existingLive)) return { status: 'CONNECTED', socket: existingLive.socket, sessionId }
        if (existingLive.pairingCode && !existingLive.connectionClosed && !existingLive.reconnecting) {
            return { status: 'PAIRING', code: existingLive.pairingCode, socket: existingLive.socket, sessionId }
        }
        if (!existingLive.connectionClosed) throw new Error('Session Jadibot sedang diproses, coba lagi sebentar.')
        // A reconnect timer/in-flight replacement already owns this auth folder.
        // Do not start another socket in parallel; the caller can wait for the
        // normal connection notice rather than receive a stale pairing code.
        if (existingLive.reconnecting || existingLive.reconnectTimer) {
            return { status: 'CONNECTING', socket: existingLive.socket, sessionId }
        }
    }

    const persisted = allMetas().find(item => item.sessionId === sessionId)
    if (persisted?.ownerJid && !sameOwner(persisted.ownerJid, owner)) {
        throw new Error('Order Jadibot ini dimiliki user lain.')
    }

    // If this exact order's linked device was already restored from disk, reuse
    // it instead of creating a second socket for the same auth directory. When
    // the credential set is registered, never fall through to a fresh-pair flow
    // after a transient connection error: doing so can overwrite or delete a
    // valid linked-device session.
    let registeredCredentials = false
    try {
        const { state } = await useMultiFileAuthState(sessionPath(sessionId))
        registeredCredentials = Boolean(state?.creds?.registered)
    } catch (err) {
        console.error(`[JADIBOT AUTH READ][${sessionId}]`, err?.message || err)
    }

    const canRestorePersistedSession = persisted &&
        !['LOGGED_OUT', 'PAIRING_FAILED', 'WAITING_NUMBER'].includes(String(persisted.status || '').toUpperCase())

    if (registeredCredentials && canRestorePersistedSession) {
        try {
            const restored = await openSession({ ...persisted, sessionId }, false)
            return { status: isConnected(restored) ? 'CONNECTED' : 'CONNECTING', socket: restored.socket, sessionId }
        } catch (err) {
            saveMeta(sessionId, {
                ownerJid: persisted.ownerJid,
                phoneNumber: persisted.phoneNumber,
                orderRef: persisted.orderRef || '',
                status: 'RECONNECT_FAILED',
                lastError: String(err?.message || err).slice(0, 300)
            })
            throw new Error(`Sesi Jadibot tersimpan gagal dibuka; kredensial yang ada dipertahankan. Coba lagi setelah koneksi stabil. Detail: ${String(err?.message || err).slice(0, 180)}`)
        }
    }

    saveMeta(sessionId, {
        ...meta,
        status: 'PAIRING',
        createdAt: persisted?.createdAt || Date.now(),
        pairingStartedAt: Date.now()
    })

    try {
        const current = await openSession({ ...meta, sessionId }, true)
        return {
            status: 'PAIRING',
            code: current.pairingCode,
            socket: current.socket,
            sessionId
        }
    } catch (err) {
        const failed = sessions.get(sessionId)
        if (failed) {
            clearTimeout(failed.reconnectTimer)
            try { failed.socket?.ws?.close() } catch {}
            try { failed.socket?.end?.(err) } catch {}
            if (sessions.get(sessionId) === failed) sessions.delete(sessionId)
        }
        clearAuthFiles(sessionId)
        saveMeta(sessionId, {
            ...meta,
            status: 'PAIRING_FAILED',
            lastError: String(err?.message || err).slice(0, 300),
            failedAt: Date.now()
        })
        throw err
    }
}


async function pair(options = {}) {
    const meta = {
        ownerJid: String(options.ownerJid || ''),
        phoneNumber: normalizePhone(options.phoneNumber),
        orderRef: String(options.orderRef || '')
    }
    const sessionId = safeSessionId(makeSessionId(meta))
    const existingPending = pendingPairs.get(sessionId)
    if (existingPending) {
        // Share the same in-flight result rather than constructing a duplicate
        // Baileys socket/auth-state writer for this order.
        return existingPending
    }

    const task = pairSession(meta)
    pendingPairs.set(sessionId, task)
    try {
        return await task
    } finally {
        if (pendingPairs.get(sessionId) === task) pendingPairs.delete(sessionId)
    }
}

async function repair({ ownerJid, orderRef = '' }) {
    const selector = ownerJid
    if (!selector || !(Array.isArray(selector) ? selector.length : String(selector).trim())) {
        throw new Error('Pemilik Jadibot tidak valid.')
    }
    const candidates = allMetas()
        .filter(meta => String(meta.status || '').toUpperCase() === 'LOGGED_OUT')
        .filter(meta => ownerSelectorMatches(meta, selector))
        .filter(meta => !orderRef || String(meta.orderRef || '') === String(orderRef))
        .sort((a, b) => Number(b.loggedOutAt || b.updatedAt || 0) - Number(a.loggedOutAt || a.updatedAt || 0))
    const meta = candidates[0]
    if (!meta) throw new Error('Tidak ada sesi Jadibot milik kamu yang berstatus logout dan perlu dipairing ulang.')

    const sessionId = safeSessionId(meta.sessionId || makeSessionId(meta))
    clearAuthFiles(sessionId)
    try {
        return await pair({
            ownerJid: meta.ownerJid,
            phoneNumber: meta.phoneNumber,
            orderRef: meta.orderRef || ''
        })
    } catch (err) {
        saveMeta(sessionId, {
            ownerJid: meta.ownerJid,
            phoneNumber: meta.phoneNumber,
            orderRef: meta.orderRef || '',
            status: 'LOGGED_OUT',
            loggedOutAt: meta.loggedOutAt || Date.now(),
            lastRepairError: String(err?.message || err).slice(0, 300)
        })
        throw err
    }
}

async function startExisting() {
    const metas = allMetas()
    let started = 0
    for (const meta of metas) {
        const sessionId = safeSessionId(meta.sessionId || makeSessionId(meta))
        if (!meta.ownerJid || !meta.phoneNumber) continue
        if (String(meta.status || '').toUpperCase() === 'LOGGED_OUT') continue
        if (sessions.has(sessionId)) continue
        try {
            const { state } = await useMultiFileAuthState(sessionPath(sessionId))
            if (!state.creds.registered) {
                // An order may already be paid and marked DONE while the buyer
                // has not linked the device yet. Reopen only metadata explicitly
                // marked PAIRING and issue a fresh code rather than leaving the
                // buyer with an expired one after a VPS restart.
                if (String(meta.status || '').toUpperCase() !== 'PAIRING') continue
                const pending = await openSession({ ...meta, sessionId, status: 'PAIRING' }, true)
                started++
                if (pending.pairingCode) void sendPairingCodeNotice(sessionId, pending)
                continue
            }
            await openSession({ ...meta, sessionId }, false)
            started++
        } catch (err) {
            const live = sessions.get(sessionId)
            if (live) {
                try { live.socket?.ws?.close() } catch {}
                try { live.socket?.end?.(err) } catch {}
                sessions.delete(sessionId)
            }
            console.error(`[JADIBOT START][${sessionId}]`, err?.stack || err)
            saveMeta(sessionId, {
                ownerJid: meta.ownerJid,
                phoneNumber: meta.phoneNumber,
                orderRef: meta.orderRef || '',
                // Keep unregistered orders recoverable; a transient startup
                // error should not permanently hide a pending pairing request.
                status: String(meta.status || '').toUpperCase() === 'PAIRING' ? 'PAIRING' : 'START_FAILED',
                lastError: String(err?.message || err).slice(0, 300)
            })
        }
    }
    console.log(`[JADIBOT START] ${started}/${metas.length} sesi dipulihkan.`)
    return started > 0
}

async function stop(clear = false) {
    shuttingDown = true
    const current = [...sessions.entries()]
    sessions.clear()
    for (const [sessionId, next] of current) {
        clearTimeout(next.reconnectTimer)
        next.connectionClosed = true
        try { next.socket?.ws?.close() } catch {}
        try { next.socket?.end?.(undefined) } catch {}
        if (clear) {
            clearAuthFiles(sessionId)
            clearMeta(sessionId)
        }
    }
    if (clear) {
        // Clean up any old root-level auth files left by an interrupted migration.
        try {
            for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
                if (entry.isFile()) fs.rmSync(path.join(ROOT, entry.name), { force: true })
            }
        } catch {}
        const remaining = allMetas()
        if (!remaining.length) clearMeta()
    }
    shuttingDown = false
}

function setNotifier(fn) {
    notify = typeof fn === 'function' ? fn : null
}

module.exports = {
    pair,
    repair,
    startExisting,
    stop,
    connected,
    getInfo,
    getInfos,
    setNotifier
}
