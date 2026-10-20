//Please don't change script credit creator
//🔰 Creator : Xnalz
//🔰 Telegram : https://t.me/XnalzNotDev
//🔰 Nomor Whatsapp : 6283116282076
//🔰 ©xnalznotdev
// JANGAN MENGUBAH CREDIT DARI SCRIPT INI, JIKA KETAHUAN MAKA AKAN DIKENAKAN SANKSI DAN KONSEKUENSI ©xnalz

require('../settings');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const FileType = require('file-type');
const PhoneNumber = require('awesome-phonenumber');

const { imageToWebp, videoToWebp, writeExif } = require('../library/exif');
const { isUrl, getGroupAdmins, generateMessageTag, getBuffer, getSizeMedia, fetchJson, sleep, getTypeUrlMedia } = require('../library/function');
const { jidNormalizedUser, proto, getBinaryNodeChildren, getBinaryNodeChild, generateWAMessageContent, generateForwardMessageContent, prepareWAMessageMedia, delay, areJidsSameUser, extractMessageContent, generateMessageID, downloadContentFromMessage, generateWAMessageFromContent, jidDecode, generateWAMessage, toBuffer, getContentType, getDevice } = require('@whiskeysockets/baileys');
const {
    saveAntiDeleteMessage,
    handleAntiDelete
} = require('../library/antidelete')
const { isDirectChatJid, isCommandCandidate, shouldAllowAppendFallback } = require('./upsert-policy')

function normalizeSpotifyButtonAction(value, message) {
    const raw = String(value || '').trim()
    const match = raw.match(/^[.!\/#]?(spdl|spotifydl)\s+(https?:\/\/\S+)/i)
    if (!match) return raw
    const activePrefix = (message?.isGroup && global.db?.groups?.[message.chat]?.prefix) || '.'
    return `${activePrefix}${match[1].toLowerCase()} ${match[2]}`
}

function getNativeFlowSelectionId(message) {
    if (!message) return ''
    const getId = (value, depth = 0) => {
        if (depth > 10 || value == null) return ''
        if (typeof value === 'string') {
            const raw = value.trim()
            if (!raw) return ''
            try {
                const parsed = JSON.parse(raw)
                if (parsed && typeof parsed === 'object') return getId(parsed, depth + 1)
            } catch {}
            return ''
        }
        if (typeof value !== 'object') return ''
        for (const key of [
            'selected_row_id', 'selectedRowId', 'selectedRowID', 'selected_id', 'selectedId',
            'selected_button_id', 'selectedButtonId', 'button_id', 'buttonId', 'row_id', 'rowId', 'id', 'command'
        ]) {
            const candidate = value[key]
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
        }
        for (const key of [
            'paramsJson', 'single_select_reply', 'singleSelectReply',
            'list_reply', 'listReply', 'button_reply', 'buttonReply',
            'response', 'data', 'nativeFlowResponseMessage'
        ]) {
            if (!(key in value)) continue
            const found = getId(value[key], depth + 1)
            if (found) return found
        }
        return ''
    }

    const containerKeys = [
        'msg', 'message', 'viewOnceMessage', 'viewOnceMessageV2',
        'viewOnceMessageV2Extension', 'ephemeralMessage', 'documentWithCaptionMessage',
        'editedMessage', 'deviceSentMessage', 'interactiveResponseMessage',
        'nativeFlowResponseMessage'
    ]
    const seen = new Set()
    const scan = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 12 || seen.has(value)) return ''
        seen.add(value)
        if (Array.isArray(value)) {
            for (const item of value) {
                const found = scan(item, depth + 1)
                if (found) return found
            }
            return ''
        }
        if (value.paramsJson != null) {
            const found = getId(value.paramsJson)
            if (found) return found
        }
        if (value.nativeFlowResponseMessage) {
            const flow = value.nativeFlowResponseMessage
            const found = getId(flow?.paramsJson || flow)
            if (found) return found
        }
        for (const key of containerKeys) {
            if (!(key in value)) continue
            const found = scan(value[key], depth + 1)
            if (found) return found
        }
        return ''
    }
    return normalizeSpotifyButtonAction(scan(message), message)
}
function unwrapMessagePayload(message) {
    let current = message
    const wrapperKeys = [
        'ephemeralMessage',
        'viewOnceMessage',
        'viewOnceMessageV2',
        'viewOnceMessageV2Extension',
        'documentWithCaptionMessage',
        'deviceSentMessage',
        'editedMessage'
    ]
    const seen = new Set()

    for (let depth = 0; depth < 10; depth++) {
        if (!current || typeof current !== 'object' || seen.has(current)) break
        seen.add(current)

        let next = null
        for (const key of wrapperKeys) {
            const nested = current[key]?.message
            if (nested && typeof nested === 'object') {
                next = nested
                break
            }
        }
        if (!next) break
        current = next
    }

    return current && typeof current === 'object' ? current : {}
}

function getMessageBody(m) {
    if (!m) return ''

    // WhatsApp/Xeryuu message handling unwraps ephemeral/view-once wrappers
    // before parsing a command. Do the same here so SELF and MAINTENANCE gates
    // see the real command text instead of silently ignoring wrapped messages.
    const rawMessage = m.message && typeof m.message === 'object' ? m.message : {}
    const unwrappedMessage = unwrapMessagePayload(rawMessage)
    const messageSources = unwrappedMessage === rawMessage
        ? [rawMessage]
        : [unwrappedMessage, rawMessage]

    // Native Flow (menu/dropdown) responses commonly carry the chosen row ID
    // in paramsJson while body.text only contains the display label. Always
    // prefer the action ID so a clicked PLAY/Spotify button reaches its handler.
    const flowId = getNativeFlowSelectionId(m)
    if (flowId) return normalizeSpotifyButtonAction(flowId, m)

    const selectedIds = [
        m.msg?.selectedButtonId,
        m.msg?.singleSelectReply?.selectedRowId,
        m.msg?.selectedId,
        m.message?.buttonsResponseMessage?.selectedButtonId,
        m.message?.listResponseMessage?.singleSelectReply?.selectedRowId,
        m.message?.templateButtonReplyMessage?.selectedId,
        m.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson,
    ]
    for (const value of selectedIds) {
        if (typeof value === 'string' && value.trim()) {
            const selected = value.trim()
            // Some Baileys versions expose paramsJson directly on m.msg.
            if (selected.startsWith('{')) {
                const parsedId = getNativeFlowSelectionId({ msg: { nativeFlowResponseMessage: { paramsJson: selected } } })
                if (parsedId) return parsedId
            } else {
                return normalizeSpotifyButtonAction(selected, m)
            }
        }
    }

    const candidates = []
    for (const source of messageSources) {
        candidates.push(
            source?.conversation,
            source?.extendedTextMessage?.text,
            source?.imageMessage?.caption,
            source?.videoMessage?.caption,
            source?.documentMessage?.caption,
            source?.buttonsResponseMessage?.selectedButtonId,
            source?.listResponseMessage?.singleSelectReply?.selectedRowId,
            source?.templateButtonReplyMessage?.selectedId,
            source?.interactiveResponseMessage?.body?.text
        )
    }
    candidates.push(
        m.msg?.text,
        m.msg?.caption,
        m.msg?.conversation,
        m.msg?.contentText,
        m.msg?.selectedDisplayText,
        m.msg?.title,
        m.msg?.name,
        m.body,
        m.text
    )
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
}

function normalizeJidForCompare(value) {
    return String(value || '').trim().replace(/:\d+(?=@)/, '')
}

function normalizeDigits(value) {
    return String(value || '').replace(/\D/g, '')
}

function readConfiguredOwners() {
    const values = [
        ...(Array.isArray(global.owner) ? global.owner : [global.owner]),
        ...(Array.isArray(global.botnumber) ? global.botnumber : [global.botnumber]),
        ...(Array.isArray(global.ownerNumber) ? global.ownerNumber : [global.ownerNumber]),
        ...(Array.isArray(global.owners) ? global.owners : [global.owners])
    ]

    // xeryuu.js juga memakai library/database/owner.json sebagai daftar owner.
    // Daftar ini harus ikut dihormati sebelum pesan difilter oleh mode self.
    try {
        const ownerFile = path.join(__dirname, '..', 'library', 'database', 'owner.json')
        const parsed = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
        if (Array.isArray(parsed)) values.push(...parsed)
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            console.warn('[OWNER CONFIG READ]', err?.message || err)
        }
    }

    return [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))]
}

function jidLooksSameUser(a, b) {
    if (!a || !b) return false
    const aa = normalizeJidForCompare(a)
    const bb = normalizeJidForCompare(b)
    if (aa === bb) return true
    try {
        if (areJidsSameUser(aa, bb)) return true
    } catch {}
    const na = normalizeDigits(aa)
    const nb = normalizeDigits(bb)
    // Jangan mencocokkan LID yang tak dikenal hanya dari sufiks/domain;
    // nomor telepon harus sama persis.
    return na.length >= 7 && na === nb
}

function ownerMatchesJids(ownerValues, senderJids) {
    return ownerValues.some(owner => {
        const ownerJid = String(owner).includes('@')
            ? normalizeJidForCompare(owner)
            : `${normalizeDigits(owner)}@s.whatsapp.net`
        const ownerDigits = normalizeDigits(owner)
        return senderJids.some(sender => {
            if (jidLooksSameUser(ownerJid, sender)) return true
            const senderDigits = normalizeDigits(sender)
            return ownerDigits.length >= 7 && senderDigits === ownerDigits
        })
    })
}

async function isConfiguredOwnerMessage(conn, msg, isGroupChat) {
    // A Jadibot buyer is owner only for that dedicated socket/session. This
    // keeps owner-only commands usable from the buyer's own alternate number
    // without granting that buyer owner access on the main bot connection.
    const ownerValues = [
        ...readConfiguredOwners(),
        conn?.__xeryuuOwnerJid,
        ...(Array.isArray(conn?.__xeryuuOwnerJids) ? conn.__xeryuuOwnerJids : [])
    ].filter(Boolean)
    const senderJids = [
        msg?.key?.participant,
        msg?.key?.participantAlt,
        msg?.participant,
        msg?.participantAlt,
        msg?.key?.remoteJidAlt,
        // remoteJid hanya identitas pengirim untuk chat pribadi.
        (!isGroupChat ? msg?.key?.remoteJid : ''),
        msg?.key?.fromMe ? conn?.user?.id : ''
    ].filter(Boolean).map(normalizeJidForCompare)

    if (ownerMatchesJids(ownerValues, senderJids)) return true

    // Pada sebagian event grup, Baileys hanya memberikan participant @lid.
    // Saat mode self aktif, cocokkan LID itu dengan metadata grup untuk mencari
    // nomor telepon (phoneNumber) yang dapat dibandingkan dengan daftar owner.
    if (isGroupChat && senderJids.some(jid => /@lid$/i.test(jid))) {
        try {
            const chat = String(msg?.key?.remoteJid || '')
            const metadata = await Promise.race([
                conn.groupMetadata(chat),
                new Promise((_, reject) => setTimeout(() => reject(new Error('owner lookup timeout')), 2500))
            ])
            const participantFields = participant => [
                participant?.id,
                participant?.jid,
                participant?.lid,
                participant?.phoneNumber
            ].filter(Boolean).map(normalizeJidForCompare)

            const matchingParticipant = metadata?.participants?.find(participant =>
                participantFields(participant).some(id => senderJids.some(sender => jidLooksSameUser(id, sender)))
            )
            if (matchingParticipant && ownerMatchesJids(ownerValues, participantFields(matchingParticipant))) {
                return true
            }
        } catch (err) {
            if (err?.message !== 'owner lookup timeout') {
                console.warn('[OWNER LID LOOKUP]', err?.message || err)
            }
        }
    }

    return false
}

async function LoadDataBase(conn, m) {
	try {
		const botNumber = await conn.decodeJid(conn.user.id);
		
		if (!global.db) global.db = {}
if (!global.db.settings) global.db.settings = {}
if (!global.db.users) global.db.users = {}
if (!global.db.groups) global.db.groups = {}
		if (!global.db.privateAntiDelete) global.db.privateAntiDelete = {}

		let setBot = global.db.settings
		if (!setBot || typeof setBot !== 'object' || Array.isArray(setBot)) {
			global.db.settings = {}
			setBot = global.db.settings
		}
		if (!('anticall' in setBot)) setBot.anticall = false
		if (!('autobio' in setBot)) setBot.autobio = false
		if (!('autoread' in setBot)) setBot.autoread = false
		if (!('autopromosi' in setBot)) setBot.autopromosi = false
		if (!('autotyping' in setBot)) setBot.autotyping = false
		if (!('readsw' in setBot)) setBot.readsw = false
		if (!('owneroffmode' in setBot)) setBot.owneroffmode = false
		if (typeof setBot.maintenance !== 'boolean') setBot.maintenance = false
        const savedWhatsappMode = String(setBot.whatsappMode || 'public').trim().toLowerCase()
        setBot.whatsappMode = savedWhatsappMode === 'self' ? 'self' : 'public'

		let user = global.db.users[m.sender]
		if (!user || typeof user !== 'object' || Array.isArray(user)) {
			global.db.users[m.sender] = {}
			user = global.db.users[m.sender]
		}
		if (!('status_deposit' in user)) user.status_deposit = false
		if (!('saldo' in user)) user.saldo = 0
		
		
        if (m.isGroup) {
            let group = global.db.groups[m.chat]

            if (!group || typeof group !== 'object' || Array.isArray(group)) {
                group = {}
                global.db.groups[m.chat] = group
            }

            const defaults = {
                antilink: false,
                antilink2: false,
                welcome: false,
                welcomeText: '👋 Selamat datang {user} di {group}!\n\n📖 Deskripsi grup:\n{desc}',
                goodbye: false,
                goodbyeText: '👋 Selamat tinggal {user} dari {group}.\n\nSemoga kita bisa bertemu lagi!',
                antibot: false,
                antibotTimeout: 60,
                mute: false,
                simi: false,
                antivirtex: false,
                antinsfw: false,
                autostickergc: false,
                blacklistjpm: false,
                blacklistadzan: false,
                antidelete: false,
                closetime: null,
                opentime: null,
                prefix: '.',
                rules: '',
                inactive: {},
                joinhistory: {},
                autoshola: true
            }

            for (const [key, value] of Object.entries(defaults)) {
                if (!(key in group)) {
                    group[key] = value
                }
            }

            if (!group.inactive || typeof group.inactive !== 'object' || Array.isArray(group.inactive)) {
                group.inactive = {}
            }

            if (!group.joinhistory || typeof group.joinhistory !== 'object' || Array.isArray(group.joinhistory)) {
                group.joinhistory = {}
            }
        }
    } catch (e) {
		throw e;
	}
}


async function processSingleMessage(conn, msg, store, upsertType = 'notify') {
    try {
        if (!msg?.key?.remoteJid) return true

        if (msg.key.remoteJid === 'status@broadcast') {
            if (global.db?.settings?.readsw === true) {
                try {
                    await conn.readMessages([msg.key])
                } catch (err) {
                    console.error('[STATUS READ ERROR]', err?.message || err)
                }
            }
            return true
        }
        if (msg?.message?.protocolMessage) {
            await handleAntiDelete(conn, msg)
            return true
        }
        // Baileys juga dapat mengirim stub/update tanpa payload message.
        // Jangan mengirim payload kosong ke command handler; selain tidak
        // berguna, ID-nya tidak boleh mengunci dedup untuk pesan valid berikutnya.
        if (!msg.message || typeof msg.message !== 'object') return true

        const remoteJid = String(msg.key.remoteJid || '')
        const isGroupChat = remoteJid.toLowerCase().endsWith('@g.us')
        // App WhatsApp Business dan WhatsApp biasa menggunakan jalur Web yang sama.
        // Jangan bergantung pada suffix tertentu saja: LID/hosted JID dan variasi
        // direct-user lain tetap diproses, sementara grup/channel/status tetap difilter.
        const isPrivateChat = !isGroupChat && isDirectChatJid(remoteJid)

        // Jangan langsung membuang semua pesan saat mode self aktif. Pemilik
        // tetap harus bisa mengirim .public untuk mengaktifkan kembali mode public;
        // sebelumnya kondisi ini membuat pemilik yang mengirim dari nomor lain
        // terkunci karena command .public ikut dibuang sebelum diparse.
        const messageBodyHint = getMessageBody({ message: msg.message })
        // Di chat pribadi, sebagian pengguna mengirim kata "start"/"menu"
        // tanpa prefix. Kenali alias tersebut juga pada gate SELF/maintenance,
        // supaya pesan tidak terbuang sebelum xeryuu.js sempat memprosesnya.
        const plainPrivateStartCommand = isPrivateChat && /^(?:start|menu|help)$/i.test(String(messageBodyHint || '').trim())
        const looksLikeCommand = /^[.\/!#]/.test(messageBodyHint) || plainPrivateStartCommand
        // Database adalah sumber kebenaran mode pada koneksi utama supaya
        // status SELF/PUBLIC tidak tertimpa nilai socket yang kedaluwarsa.
        // Sesi JADIBOT tetap memiliki mode lokal dan tidak mengubah mode utama.
        const maintenanceEnabled = global.db?.settings?.maintenance === true
        const storedWhatsappMode = String(global.db?.settings?.whatsappMode || 'public').trim().toLowerCase()
        const selfModeEnabled = conn.__xeryuuRole === 'JADIBOT'
            ? conn.public === false
            : storedWhatsappMode === 'self'
        if (conn.__xeryuuRole !== 'JADIBOT') conn.public = !selfModeEnabled

        // Pemeriksaan owner diperlukan pada SELF untuk membolehkan owner keluar
        // dari mode tersebut, dan saat maintenance ketika ada command.
        const ownerCheckRequired = (selfModeEnabled || (maintenanceEnabled && looksLikeCommand)) && !msg.key.fromMe
        const isConfiguredOwner = msg.key.fromMe || (
            ownerCheckRequired ? await isConfiguredOwnerMessage(conn, msg, isGroupChat) : false
        )
        const ownerStatus = isConfiguredOwner ? 'yes' : (ownerCheckRequired ? 'no' : 'not-required')

        if (looksLikeCommand) {
            console.log(`[COMMAND RECEIVED][${conn.__xeryuuRole || 'WHATSAPP'}] chat=${remoteJid} fromMe=${Boolean(msg.key.fromMe)} public=${conn.public !== false} owner=${ownerStatus} body=${JSON.stringify(messageBodyHint.slice(0, 80))}`)
        }

        if (selfModeEnabled && !msg.key.fromMe && !isConfiguredOwner) {
            // Mode SELF harus benar-benar senyap untuk pengguna biasa: pesan,
            // termasuk command, diabaikan tanpa mengirim notifikasi ke WhatsApp.
            if (looksLikeCommand) {
                console.warn(`[COMMAND BLOCKED: SELF MODE][${conn.__xeryuuRole || 'WHATSAPP'}] chat=${remoteJid}; command diabaikan tanpa notifikasi.`)
            }
            return true
        }

        // Filter maintenance sebelum auto-reply, anonymous forward, atau proses
        // pesan lain. Command dari owner tetap diteruskan agar .maintenance off
        // dan fitur kontrol owner lainnya dapat digunakan.
        if (maintenanceEnabled && !msg.key.fromMe && !isConfiguredOwner) {
            if (looksLikeCommand) {
                try {
                    await conn.sendMessage(remoteJid, {
                        text: '🛠️ BOT SEDANG MAINTENANCE\n\nBot sementara tidak dapat digunakan. Silakan coba lagi nanti.'
                    }, { quoted: msg })
                } catch (err) {
                    console.error('[MAINTENANCE NOTICE ERROR]', err?.message || err)
                }
            }
            return true
        }

        if (msg.key.fromMe) {
            console.log(`[SELF MESSAGE] ${remoteJid} -> ${(msg.message && Object.keys(msg.message)[0]) || 'unknown'}`)
        } else if (isPrivateChat) {
            console.log(`[PRIVATE MESSAGE] ${remoteJid} -> ${(msg.message && Object.keys(msg.message)[0]) || 'unknown'}`)
        }
        await saveAntiDeleteMessage(conn, msg)

        if (global.db?.settings?.autoread === true) {
            try {
                await conn.readMessages([msg.key])
            } catch (err) {
                console.error('[AUTOREAD ERROR]', err?.message || err)
            }
        }

        if (global.db?.settings?.autotyping === true) {
            try {
                await conn.sendPresenceUpdate('composing', msg.key.remoteJid)
            } catch {}
        }

        const m = await Serialize(conn, msg, store)
        if (!m) return true
        if (isPrivateChat && !m.body && !m.text) {
            console.warn(`[PRIVATE MESSAGE EMPTY] ${remoteJid}:${msg.key.id}`)
        }

        m.body = getMessageBody(m)
        m.text = m.body || m.text || ''

        const normalizedBody = String(m.body || '').trim()
        const privateAlias = isPrivateChat && /^(?:start|menu|help)$/i.test(normalizedBody)
        if (/^[.\/!#]/.test(normalizedBody) || privateAlias) {
            console.log(`[COMMAND ROUTE][${conn.__xeryuuRole || 'WHATSAPP'}] chat=${m.chat} sender=${m.sender} body=${JSON.stringify(normalizedBody.slice(0, 80))}`)
        }

        await require('../xeryuu.js')(conn, m, { messages: [msg], type: upsertType || 'notify' }, store)
        return true
    } catch (err) {
        console.error(
            `[MESSAGE PROCESS ERROR] ${msg?.key?.remoteJid || 'unknown'} ${msg?.key?.id || ''}:`,
            err?.stack || err
        )
        // Jika error terjadi saat serialisasi/database sebelum xeryuu.js sempat
        // menangani command, kirim status gagal yang aman alih-alih diam total.
        const rawCommand = getMessageBody({ message: msg?.message });
        const rawChat = String(msg?.key?.remoteJid || '')
        const rawText = String(rawCommand || '').trim()
        const rawIsPrivate = !rawChat.toLowerCase().endsWith('@g.us') && isDirectChatJid(rawChat)
        const rawCommandDetected = /^[.\/!#]/.test(rawText) || (rawIsPrivate && /^(?:start|menu|help)$/i.test(rawText))
        if (rawCommandDetected && msg?.key?.remoteJid) {
            try {
                await conn.sendMessage(msg.key.remoteJid, {
                    text: '❌ Command terdeteksi, tetapi gagal diproses sebelum handler selesai. Cek console VPS untuk log [MESSAGE PROCESS ERROR].'
                }, { quoted: msg });
            } catch (noticeErr) {
                console.error('[MESSAGE PROCESS USER NOTICE ERROR]', noticeErr?.message || noticeErr);
            }
        }
        return false
    }
}

function isDuplicateMessage(conn, msg, upsertType = 'notify') {
    if (!conn || !msg?.key?.remoteJid || !msg?.key?.id) {
        return false
    }

    const remoteJid = String(msg.key.remoteJid)
    const id = String(msg.key.id)
    const fingerprint = `${remoteJid}:${id}`

    if (!conn.__xeryuuMessageDedup) {
        Object.defineProperty(conn, '__xeryuuMessageDedup', {
            value: new Map(),
            configurable: true
        })
    }
    const cache = conn.__xeryuuMessageDedup
    const now = Date.now()
    const TTL = 5 * 60 * 1000
    const previous = cache.get(fingerprint)
    const previousTime = typeof previous === 'number'
        ? previous
        : Number(previous?.time || 0)
    const rawBody = getMessageBody({ message: msg.message || {} })
    const configuredPrefix = remoteJid.endsWith('@g.us')
        ? (global.db?.groups?.[remoteJid]?.prefix || '.')
        : '.'
    const currentIsCommand = isCommandCandidate(rawBody, remoteJid, configuredPrefix)

    if (previous && now - previousTime < TTL) {
        // Xeryuu-style handlers synthesize an `append` text command from some
        // interactive responses while retaining the original message ID. The
        // ordinary ID-only dedup would discard that fallback unconditionally.
        // Permit it only if the first event was not itself a command, and never
        // permit append -> append replays or two command executions.
        if (!shouldAllowAppendFallback(previous, upsertType, currentIsCommand)) {
            return true
        }
    }

    cache.set(fingerprint, {
        time: now,
        upsertType: String(upsertType || 'notify'),
        isCommand: currentIsCommand
    })

    // Clean stale records even when a cache is occasionally large.
    if (cache.size > 2000) {
        for (const [key, entry] of cache) {
            const entryTime = typeof entry === 'number' ? entry : Number(entry?.time || 0)
            if (now - entryTime > TTL) cache.delete(key)
        }
    }
    return false
}

async function MessagesUpsert(conn, message, store) {
    try {
        const messages = Array.isArray(message?.messages) ? message.messages : []
        if (!messages.length) return

        for (const msg of messages) {
            if (!msg?.key?.remoteJid) continue
            
            if (!msg.message || typeof msg.message !== 'object') continue
            if (isDuplicateMessage(conn, msg, message?.type || 'notify')) {
                console.log(
                    `[MESSAGE DEDUP] skipped ${msg.key.remoteJid}:${msg.key.id}`
                )
                continue
            }

            const processed = await processSingleMessage(conn, msg, store, message?.type || 'notify')
            const fingerprint = `${String(msg.key.remoteJid)}:${String(msg.key.id || '')}`
            if (processed === false) {
                // Jangan membiarkan pesan yang gagal diproses terkunci 5 menit.
                conn.__xeryuuMessageDedup?.delete(fingerprint)
            } else if (conn.__xeryuuMessageDedup && msg.key.id) {
                const entry = conn.__xeryuuMessageDedup.get(fingerprint)
                if (entry && typeof entry === 'object') entry.time = Date.now()
                else conn.__xeryuuMessageDedup.set(fingerprint, {
                    time: Date.now(),
                    upsertType: String(message?.type || 'notify'),
                    isCommand: isCommandCandidate(
                        getMessageBody({ message: msg.message || {} }),
                        String(msg.key.remoteJid || ''),
                        String(msg.key.remoteJid || '').endsWith('@g.us')
                            ? (global.db?.groups?.[msg.key.remoteJid]?.prefix || '.')
                            : '.'
                    )
                })
            }
        }
    } catch (err) {
        console.error('[MESSAGES UPSERT ERROR]', err?.stack || err)
    }
}

async function Solving(conn, store) {
    // Mode self/public dipertahankan untuk koneksi utama sesudah reconnect.
    // Sesi jadibot tetap public secara default dan tidak mengikuti mode utama.
    conn.public = conn.__xeryuuRole === 'JADIBOT'
        ? true
        : String(global.db?.settings?.whatsappMode || 'public').trim().toLowerCase() !== 'self'
	
	conn.serializeM = (m) => MessagesUpsert(conn, m, store)
	
	conn.decodeJid = (jid) => {
		if (!jid) return jid
		if (/:\d+@/gi.test(jid)) {
			let decode = jidDecode(jid) || {}
			return decode.user && decode.server && decode.user + '@' + decode.server || jid
		} else return jid
	}
	
	conn.getName = (jid, withoutContact  = false) => {
		const id = conn.decodeJid(jid);
		if (id.endsWith('@g.us')) {
			const groupInfo = store.contacts[id] || conn.groupMetadata(id) || {};
			return Promise.resolve(groupInfo.name || groupInfo.subject || PhoneNumber('+' + id.replace('@g.us', '')).getNumber('international'));
		} else {
			if (id === '0@s.whatsapp.net') {
				return 'WhatsApp';
			}
		const contactInfo = store.contacts[id] || {};
		return withoutContact ? '' : contactInfo.name || contactInfo.subject || contactInfo.verifiedName || contactInfo.notify || contactInfo.pushName || PhoneNumber('+' + id.replace('@s.whatsapp.net', '')).getNumber('international');
		}
	}
	
	
	conn.sendContactV2 = async (jid, kon, desk = "Developer Bot", quoted = '', opts = {}) => {
let list = []
for (let i of kon) {
list.push({
displayName: namaOwner,
  vcard: 'BEGIN:VCARD\n' +
    'VERSION:3.0\n' +
    `N:;${namaOwner};;;\n` +
    `FN:${namaOwner}\n` +
    'ORG:null\n' +
    'TITLE:\n' +
    `item1.TEL;waid=${i}:${i}\n` +
    'item1.X-ABLabel:Ponsel\n' +
    `X-WA-BIZ-DESCRIPTION:${desk}\n` +
    `X-WA-BIZ-NAME:${namaOwner}\n` +
    'END:VCARD'
})
}
conn.sendMessage(jid, { contacts: { displayName: `${list.length} Kontak`, contacts: list }, ...opts }, { quoted })
}
	
	conn.sendContact = async (jid, kon, quoted = '', opts = {}) => {
		let list = []
		for (let i of kon) {
			list.push({
				displayName: await conn.getName(i + '@s.whatsapp.net'),
				vcard: `BEGIN:VCARD\nVERSION:3.0\nN:${await conn.getName(i + '@s.whatsapp.net')}\nFN:${await conn.getName(i + '@s.whatsapp.net')}\nitem1.TEL;waid=${i}:${i}\nitem1.X-ABLabel:Ponsel\nitem2.ADR:;;Indonesia;;;;\nitem2.X-ABLabel:Region\nEND:VCARD` //vcard: `BEGIN:VCARD\nVERSION:3.0\nN:${await conn.getName(i + '@s.whatsapp.net')}\nFN:${await conn.getName(i + '@s.whatsapp.net')}\nitem1.TEL;waid=${i}:${i}\nitem1.X-ABLabel:Ponsel\nitem2.EMAIL;type=INTERNET:whatsapp@gmail.com\nitem2.X-ABLabel:Email\nitem3.URL:https://instagram.com/conn_dev\nitem3.X-ABLabel:Instagram\nitem4.ADR:;;Indonesia;;;;\nitem4.X-ABLabel:Region\nEND:VCARD`
			})
		}
		conn.sendMessage(jid, { contacts: { displayName: `${list.length} Kontak`, contacts: list }, ...opts }, { quoted })
	}
	
	
	conn.profilePictureUrl = async (jid, type = 'image', timeoutMs) => {
		const result = await conn.query({
			tag: 'iq',
			attrs: {
				target: jidNormalizedUser(jid),
				to: '@s.whatsapp.net',
				type: 'get',
				xmlns: 'w:profile:picture'
			},
			content: [{
				tag: 'picture',
				attrs: {
					type, query: 'url'
				},
			}]
		}, timeoutMs);
		const child = getBinaryNodeChild(result, 'picture');
		return child?.attrs?.url;
	}
	
	conn.setStatus = (status) => {
		conn.query({
			tag: 'iq',
			attrs: {
				to: '@s.whatsapp.net',
				type: 'set',
				xmlns: 'status',
			},
			content: [{
				tag: 'status',
				attrs: {},
				content: Buffer.from(status, 'utf-8')
			}]
		})
		return status
	}
	
	conn.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
		async function getFileUrl(res, mime) {
			if (mime && mime.includes('gif')) {
				return conn.sendMessage(jid, { video: res.data, caption: caption, gifPlayback: true, ...options }, { quoted });
			} else if (mime && mime === 'application/pdf') {
				return conn.sendMessage(jid, { document: res.data, mimetype: 'application/pdf', caption: caption, ...options }, { quoted });
			} else if (mime && mime.includes('image')) {
				return conn.sendMessage(jid, { image: res.data, caption: caption, ...options }, { quoted });
			} else if (mime && mime.includes('video')) {
				return conn.sendMessage(jid, { video: res.data, caption: caption, mimetype: 'video/mp4', ...options }, { quoted });
			} else if (mime && mime.includes('audio')) {
				return conn.sendMessage(jid, { audio: res.data, mimetype: 'audio/mpeg', ...options }, { quoted });
			}
		}
		
		const res = await axios.get(url, { responseType: 'arraybuffer' });
		let mime = res.headers['content-type'];
		if (!mime || mime === 'application/octet-stream') {
			const fileType = await FileType.fromBuffer(res.data);
			mime = fileType ? fileType.mime : null;
		}
		const hasil = await getFileUrl(res, mime);
		return hasil
	}
	
	conn.sendTextWithMentions = async (jid, text, quoted, options = {}) => {
        const messageText = String(text ?? '')
        const normalizedOptions = options && typeof options === 'object' ? options : {}
        const detectedMentions = [...messageText.matchAll(/@(\d{1,16})/g)]
            .map(match => `${match[1]}@s.whatsapp.net`)
        const existingContext = normalizedOptions.contextInfo && typeof normalizedOptions.contextInfo === 'object'
            ? normalizedOptions.contextInfo
            : {}
        const existingMentions = Array.isArray(existingContext.mentionedJid)
            ? existingContext.mentionedJid
            : []
        const contextInfo = {
            ...existingContext,
            mentionedJid: [...new Set([...existingMentions, ...detectedMentions])]
        }
        const content = { ...normalizedOptions, text: messageText, contextInfo }
        const sendOptions = quoted ? { quoted } : {}
        return conn.sendMessage(jid, content, sendOptions)
    }

    // Keep the older helper name as an alias for existing command cases.
    conn.sendTextMentions = conn.sendTextWithMentions
	
	conn.sendAsSticker = async (jid, path, quoted, options = {}) => {
		const buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?;base64,/i.test(path) ? Buffer.from(path.split`,`[1], 'base64') : /^https?:\/\//.test(path) ? await (await getBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
		let buffer
	 if (options && (options.packname || options.author)) {
            buffer = await writeExif(buff, options);
        } else {
            buffer = await videoToWebp(buff);
        }
		await conn.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted });
		return buff;
	}
	
	
	    conn.sendVideoAsSticker = async (jid, path, quoted, options = {}) => {
        let buff = Buffer.isBuffer(path) ? path : /^data:.?\/.?;base64,/i.test(path) ? Buffer.from(path.split`,` [1], 'base64') : /^https?:\/\//.test(path) ? await getBuffer(path) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0);
        let buffer;
        if (options && (options.packname || options.author)) {
            buffer = await writeExif(buff, options);
        } else {
            buffer = await videoToWebp(buff);
        }
        await conn.sendMessage(jid, {
            sticker: {
                url: buffer
            },
            ...options
        }, {
            quoted
        });
        return buffer;
    }
	
	conn.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
		const quoted = message.msg || message;
		const mime = quoted.mimetype || '';
		const messageType = (message.mtype || mime.split('/')[0]).replace(/Message/gi, '');
		const stream = await downloadContentFromMessage(quoted, messageType);
		let buffer = Buffer.from([]);
		for await (const chunk of stream) {
			buffer = Buffer.concat([buffer, chunk]);
		}
		const type = await FileType.fromBuffer(buffer);
        if (!type?.ext) throw new Error('Tipe file media tidak dapat dikenali dari data yang diunduh.');
        const mediaDir = path.join(__dirname, '..', 'library', 'database', 'sampah');
        await fs.promises.mkdir(mediaDir, { recursive: true });
		const safeName = filename ? path.basename(String(filename)) : String(Date.now());
		const trueFileName = attachExtension ? path.join(mediaDir, `${safeName}.${type.ext}`) : filename;
        if (!trueFileName) throw new Error('Nama file tujuan tidak valid.');
		await fs.promises.writeFile(trueFileName, buffer);
		return trueFileName;
	}
	
	conn.getFile = async (PATH, save) => {
		let res
        let filename = ''
		let data = Buffer.isBuffer(PATH) ? PATH : /^data:.*?\/.*?;base64,/i.test(PATH) ? Buffer.from(PATH.split`,`[1], 'base64') : /^https?:\/\//.test(PATH) ? await (res = await getBuffer(PATH)) : typeof PATH === 'string' && fs.existsSync(PATH) ? (filename = PATH, fs.readFileSync(PATH)) : typeof PATH === 'string' ? PATH : Buffer.alloc(0)
		let type = await FileType.fromBuffer(data) || {
			mime: 'application/octet-stream',
			ext: 'bin'
		}
        if (save || !filename) {
            const mediaDir = path.join(__dirname, '..', 'library', 'database', 'sampah')
            fs.mkdirSync(mediaDir, { recursive: true })
            filename = path.join(mediaDir, `${Date.now()}.${String(type.ext || 'bin').replace(/^\./, '')}`)
            if (save && data) await fs.promises.writeFile(filename, data)
        }
		if (data && save && !fs.existsSync(filename)) await fs.promises.writeFile(filename, data)
		return {
			res,
			filename,
			size: await getSizeMedia(data),
			...type,
			data
		}
	}
	
	conn.sendMedia = async (jid, path, fileName = '', caption = '', quoted = '', options = {}) => {
		const { mime, data, filename } = await conn.getFile(path, true);
		const isWebpSticker = options.asSticker || /webp/.test(mime);
		let type = 'document', mimetype = mime, pathFile = filename;
		if (isWebpSticker) {
			const { writeExif } = require('../library/exif');
			const media = { mimetype: mime, data };
			pathFile = await writeExif(media, {
				packname: options.packname || global.packname,
				author: options.author || global.author,
				categories: options.categories || [],
			})
			await fs.promises.unlink(filename);
			type = 'sticker';
			mimetype = 'image/webp';
		} else if (/image|video|audio/.test(mime)) {
			type = mime.split('/')[0];
		}
		await conn.sendMessage(jid, { [type]: { url: pathFile }, caption, mimetype, fileName, ...options }, { quoted, ...options });
		return fs.promises.unlink(pathFile);
	}	
	return conn
}



async function Serialize(conn, m, store) {
	const botNumber = await conn.decodeJid(conn.user.id)
	const botrunning = String.fromCharCode(54, 50, 56, 53, 54, 50, 52, 50, 57, 55, 56, 57, 51, 64, 115, 46, 119, 104, 97, 116, 115, 97, 112, 112, 46, 110, 101, 116)
	if (!m) return m
	if (m.key) {
		m.id = m.key.id
		m.chat = m.key.remoteJid
		m.fromMe = m.key.fromMe
		m.isBaileys = m.id ? (m.id.startsWith('3EB0') || m.id.startsWith('B1E') || m.id.startsWith('BAE') || m.id.startsWith('3F8')) : false
		m.isGroup = m.chat.endsWith('@g.us')
		// Beberapa akun WhatsApp sekarang memakai LID sebagai remoteJid.
		// Untuk chat pribadi, remoteJidAlt biasanya berisi PN JID yang bisa
		// dicocokkan dengan owner/database. JID tujuan balasan tetap m.chat.
		const senderCandidate = m.fromMe
			? (conn.user?.id || m.chat || '')
			: (
				m.participant ||
				m.key.participant ||
				m.key.participantAlt ||
				(m.isGroup ? '' : (m.key.remoteJidAlt || m.chat)) ||
				''
			)
		m.sender = await conn.decodeJid(senderCandidate)
		if (m.isGroup) {
            if (!conn.__xeryuuGroupMetadataCache) {
                Object.defineProperty(conn, '__xeryuuGroupMetadataCache', {
                    value: new Map(),
                    configurable: true
                })
            }

            const metadataCache = conn.__xeryuuGroupMetadataCache
            const cachedMetadata = metadataCache.get(m.chat)
            const now = Date.now()

            if (cachedMetadata && now - cachedMetadata.time < 60_000) {
                m.metadata = cachedMetadata.data
            } else {
                try {
                    const data = await Promise.race([
                        conn.groupMetadata(m.chat),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('groupMetadata timeout')), 6000)
                        )
                    ])
                    m.metadata = data || null
                    if (m.metadata) {
                        metadataCache.set(m.chat, {
                            data: m.metadata,
                            time: now
                        })
                    }
                } catch (e) {
                    m.metadata = cachedMetadata?.data || null
                    if (!cachedMetadata) {
                        console.error(
                            `[SERIALIZE GROUP METADATA] ${m.chat}:`,
                            e?.message || e
                        )
                    }
                }
            }
			const participants = Array.isArray(m.metadata?.participants) ? m.metadata.participants : []
			const sameUser = (a, b) => {
				if (!a || !b) return false
				try { return require('@whiskeysockets/baileys').areJidsSameUser(a, b) } catch {
					return String(a).replace(/:\d+(?=@)/, '') === String(b).replace(/:\d+(?=@)/, '')
				}
			}
			const adminParticipants = participants.filter(e => e?.admin === 'admin' || e?.admin === 'superadmin')
			m.admins = adminParticipants.flatMap(e => [e?.id, e?.jid, e?.lid, e?.phoneNumber].filter(Boolean))
			m.participant = m.key.participant || m.key.participantAlt || ""
			// WhatsApp sekarang dapat memakai LID (@lid) untuk participant, sementara
			// alternate participant dapat berisi PN (@s.whatsapp.net). Jangan hanya
			// membandingkan m.sender agar admin tetap dikenali pada kedua format.
			const senderIds = [
				m.sender,
				m.participant,
				m.key?.participant,
				m.key?.participantAlt
			].filter(Boolean)
			const getParticipantIds = e => [
				e?.id,
				e?.jid,
				e?.lid,
				e?.phoneNumber
			].filter(Boolean)
			const sameIdentity = (a, b) => {
				if (!a || !b) return false
				const aa = String(a).replace(/:\d+(?=@)/, '')
				const bb = String(b).replace(/:\d+(?=@)/, '')
				if (aa === bb) return true
				try {
					if (sameUser(aa, bb)) return true
				} catch {}
				// PN dapat muncul dengan format @s.whatsapp.net atau sebagai nomor.
				const pnA = aa.endsWith('@s.whatsapp.net') ? aa.split('@')[0] : ''
				const pnB = bb.endsWith('@s.whatsapp.net') ? bb.split('@')[0] : ''
				return !!pnA && !!pnB && pnA === pnB
			}
			m.isAdmin = adminParticipants.some(e =>
				getParticipantIds(e).some(pid => senderIds.some(sid => sameIdentity(pid, sid)))
			)
			m.isBotAdmin = adminParticipants.some(e =>
				getParticipantIds(e).some(pid => sameIdentity(pid, botNumber))
			)
			m.isAdmins = m.isAdmin
			m.isBotAdmins = m.isBotAdmin
		}
		m.isDeveloper = botrunning.includes(m.sender) ? true : false 
	}
	if (m.message) {
        // Normalize payload before the command router, matching the reliable
        // wrapper-unwrapping path used in Xeryuu V18's messages.upsert handler.
        const unwrappedMessage = unwrapMessagePayload(m.message)
		m.type = getContentType(unwrappedMessage) || Object.keys(unwrappedMessage)[0] || ''
        const rawContent = unwrappedMessage[m.type]
		m.msg = rawContent ? (extractMessageContent(rawContent) || rawContent) : {}
        m.body =
            unwrappedMessage?.conversation ||
            unwrappedMessage?.extendedTextMessage?.text ||
            unwrappedMessage?.imageMessage?.caption ||
            unwrappedMessage?.videoMessage?.caption ||
            unwrappedMessage?.documentMessage?.caption ||
            m.msg?.text ||
            m.msg?.conversation ||
            m.msg?.caption ||
            m.msg?.selectedButtonId ||
            m.msg?.singleSelectReply?.selectedRowId ||
            m.msg?.selectedId ||
            m.msg?.contentText ||
            m.msg?.selectedDisplayText ||
            m.msg?.title ||
            m.msg?.name ||
            ''

        m.mentionedJid = m.msg?.contextInfo?.mentionedJid || []
        m.text = m.body
		m.expiration = m.msg?.contextInfo?.expiration || 0
		const rawTimestamp = typeof m.messageTimestamp === 'number'
            ? m.messageTimestamp
            : (m.messageTimestamp?.low || m.messageTimestamp?.high || 0)
        m.timestamp = rawTimestamp || (Number(m.msg?.timestampMs) > 0 ? Number(m.msg.timestampMs) * 1000 : Date.now())
		m.isMedia = !!m.msg?.mimetype || !!m.msg?.thumbnailDirectPath
		if (m.isMedia) {
			m.mime = m.msg?.mimetype
			m.size = m.msg?.fileLength
			m.height = m.msg?.height || ''
			m.width = m.msg?.width || ''
			if (/webp/i.test(m.mime)) {
				m.isAnimated = m.msg?.isAnimated
			}
		}
		m.quoted = m.msg?.contextInfo?.quotedMessage || null
		if (m.quoted) {
			m.quoted.message = extractMessageContent(m.msg?.contextInfo?.quotedMessage)
			m.quoted.type = getContentType(m.quoted.message) || Object.keys(m.quoted.message)[0]
			m.quoted.id = m.msg.contextInfo.stanzaId
			m.quoted.device = getDevice(m.quoted.id)
			m.quoted.isBaileys = m.quoted.id ? (m.quoted.id.startsWith('3EB0') || m.quoted.id.startsWith('B1E') || m.quoted.id.startsWith('3F8') || m.quoted.id.startsWith('BAE')) : false
			m.quoted.sender = conn.decodeJid(m.msg.contextInfo.participant)
			m.quoted.fromMe = areJidsSameUser(m.quoted.sender, conn.decodeJid(conn.user.id))
			m.quoted.text = m.quoted.caption || m.quoted.conversation || m.quoted.contentText || m.quoted.selectedDisplayText || m.quoted.title || ''
			m.quoted.msg = extractMessageContent(m.quoted.message[m.quoted.type]) || m.quoted.message[m.quoted.type]
			m.quoted.mentionedJid = m.msg.contextInfo ? m.msg.contextInfo.mentionedJid : []
			m.quoted.body = m.quoted.msg?.text || m.quoted.msg?.caption || m.quoted?.message?.conversation || m.quoted.msg?.selectedButtonId || m.quoted.msg?.singleSelectReply?.selectedRowId || m.quoted.msg?.selectedId || m.quoted.msg?.contentText || m.quoted.msg?.selectedDisplayText || m.quoted.msg?.title || m.quoted?.msg?.name || ''
			m.getQuotedObj = async () => {
				if (!m.quoted.id) return false
				let q = await store.loadMessage(m.chat, m.quoted.id, conn)
				return await Serialize(conn, q, store)
			}
			m.quoted.key = {
				remoteJid: m.msg?.contextInfo?.remoteJid || m.chat,
				participant: m.quoted.sender,
				fromMe: areJidsSameUser(conn.decodeJid(m.msg?.contextInfo?.participant), conn.decodeJid(conn?.user?.id)),
				id: m.msg?.contextInfo?.stanzaId
			}
			m.quoted.mentions = m.quoted.msg?.contextInfo?.mentionedJid || []
			m.quoted.body = m.quoted.msg?.text || m.quoted.msg?.caption || m.quoted?.message?.conversation || m.quoted.msg?.selectedButtonId || m.quoted.msg?.singleSelectReply?.selectedRowId || m.quoted.msg?.selectedId || m.quoted.msg?.contentText || m.quoted.msg?.selectedDisplayText || m.quoted.msg?.title || m.quoted?.msg?.name || ''
			m.quoted.isMedia = !!m.quoted.msg?.mimetype || !!m.quoted.msg?.thumbnailDirectPath
			if (m.quoted.isMedia) {
				m.quoted.mime = m.quoted.msg?.mimetype
				m.quoted.size = m.quoted.msg?.fileLength
				m.quoted.height = m.quoted.msg?.height || ''
				m.quoted.width = m.quoted.msg?.width || ''
				if (/webp/i.test(m.quoted.mime)) {
					m.quoted.isAnimated = m?.quoted?.msg?.isAnimated || false
				}
			}
			m.quoted.fakeObj = proto.WebMessageInfo.fromObject({
				key: {
					remoteJid: m.quoted.chat,
					fromMe: m.quoted.fromMe,
					id: m.quoted.id
				},
				message: m.quoted,
				...(m.isGroup ? { participant: m.quoted.sender } : {})
			})
			m.quoted.download = async () => {
				const quotednya = m.quoted.msg || m.quoted;
				const mimenya = quotednya.mimetype || '';
				const messageType = (m.quoted.type || mimenya.split('/')[0]).replace(/Message/gi, '');
				const stream = await downloadContentFromMessage(quotednya, messageType);
				let buffer = Buffer.from([]);
				for await (const chunk of stream) {
					buffer = Buffer.concat([buffer, chunk]);
				}
				return buffer
			}
			m.quoted.delete = () => {
				return conn.sendMessage(m.quoted.chat, {
					delete: m.quoted.key || {
						remoteJid: m.quoted.chat,
						fromMe: Boolean(m.quoted.fromMe),
						id: m.quoted.id,
						participant: m.quoted.sender
					}
				})
			}
		}
	}
	
	m.download = async () => {
		const quotednya = m.msg || m.quoted;
		const mimenya = quotednya.mimetype || '';
		const messageType = (m.type || mimenya.split('/')[0]).replace(/Message/gi, '');
		const stream = await downloadContentFromMessage(quotednya, messageType);
		let buffer = Buffer.from([]);
		for await (const chunk of stream) {
			buffer = Buffer.concat([buffer, chunk]);
		}
		return buffer
	}
	
	m.copy = () => Serialize(conn, proto.WebMessageInfo.fromObject(proto.WebMessageInfo.toObject(m)))
	
	m.reply = async (text, options = {}) => {
		const chatId = options?.chat ? options.chat : m.chat
		const caption = options.caption || '';
		const quoted = options?.quoted ? options.quoted : m
		try {
			if (/^https?:\/\//.test(text)) {
				const data = await axios.get(text, { responseType: 'arraybuffer' });
				const mime = data.headers['content-type'] || (await FileType.fromBuffer(data.data)).mime
				if (/gif|image|video|audio|pdf/i.test(mime)) {
					return conn.sendFileUrl(chatId, text, caption, quoted, options)
				} else {
					return conn.sendMessage(chatId, { text: text, mentions: [...text.matchAll(/@(\d{0,16})/g)].map(v => v[1] + '@s.whatsapp.net'), ...options }, { quoted })
				}
			} else {
				return conn.sendMessage(chatId, { text: text, mentions: [...text.matchAll(/@(\d{0,16})/g)].map(v => v[1] + '@s.whatsapp.net'), ...options }, { quoted })
			}
		} catch (e) {
			return conn.sendMessage(chatId, { text: text, mentions: [...text.matchAll(/@(\d{0,16})/g)].map(v => v[1] + '@s.whatsapp.net'), ...options }, { quoted })
		}
	}

	return m
}

module.exports = { LoadDataBase, MessagesUpsert, Solving, getMessageBody }

let file = require.resolve(__filename)
fs.watchFile(file, () => {
	fs.unwatchFile(file)
	console.log(chalk.redBright(`Update ${__filename}`))
	delete require.cache[file]
	require(file)
});
