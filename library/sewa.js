'use strict'

const fs = require('fs')
const path = require('path')
const { areJidsSameUser } = require('@whiskeysockets/baileys')

const SEWA_FILE = path.join(__dirname, 'database', 'sewa.json')
let monitor = null
let connection = null
let running = false

function ensureFile() {
    fs.mkdirSync(path.dirname(SEWA_FILE), { recursive: true })
    if (!fs.existsSync(SEWA_FILE)) fs.writeFileSync(SEWA_FILE, '{}')
}

function normalizeRecord(key, value, now = Date.now()) {
    if (!value || typeof value !== 'object') return null
    const rawGroupId = String(value.groupId || key || '').trim()
    if (!rawGroupId) return null
    const endTime = Number(value.endTime ?? value.expired ?? value.expiresAt ?? 0)
    if (!Number.isFinite(endTime) || endTime <= 0) return null
    const startTime = Number(value.startTime ?? value.startAt ?? now)
    const status = endTime > now && value.status !== 'left' ? 'active' : (value.status === 'left' ? 'left' : 'expired')
    return {
        groupId: rawGroupId,
        legacyRef: value.legacyRef ? String(value.legacyRef) : (rawGroupId.endsWith('@g.us') ? '' : rawGroupId),
        startTime: Number.isFinite(startTime) && startTime > 0 ? startTime : now,
        endTime,
        expired: endTime,
        status,
        warned24h: Boolean(value.warned24h ?? value.warned),
        // Idempotency keys used by paid store orders. Keeping these through
        // normalization lets activateRental recover safely after a restart.
        appliedOrderRefs: Array.isArray(value.appliedOrderRefs)
            ? [...new Set(value.appliedOrderRefs.map(ref => String(ref || '').trim()).filter(Boolean))].slice(-100)
            : [],
        notifiedAt: Number(value.notifiedAt || 0),
        leaveAttemptedAt: Number(value.leaveAttemptedAt || 0),
        leftAt: Number(value.leftAt || 0),
        lastError: value.lastError ? String(value.lastError) : ''
    }
}

function loadRaw() {
    ensureFile()
    try {
        const raw = fs.readFileSync(SEWA_FILE, 'utf8').trim()
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
        return {}
    }
}

function load() {
    const raw = loadRaw()
    const result = {}
    const now = Date.now()
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const record = normalizeRecord(item?.groupId, item, now)
            if (record) result[record.groupId] = record
        }
    } else {
        for (const [key, value] of Object.entries(raw)) {
            const record = normalizeRecord(key, value, now)
            if (record) result[record.groupId] = record
        }
    }
    return result
}

function save(data) {
    ensureFile()
    const normalized = {}
    for (const [key, value] of Object.entries(data || {})) {
        const record = normalizeRecord(key, value)
        if (record) normalized[record.groupId] = { ...value, ...record }
    }
    const tmp = `${SEWA_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2))
    fs.renameSync(tmp, SEWA_FILE)
    return normalized
}

function add(groupId, totalDetik, options = {}) {
    const jid = String(groupId || '').trim()
    const seconds = Number(totalDetik)
    if (!jid.endsWith('@g.us')) throw new Error('ID grup tidak valid.')
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Durasi sewa tidak valid.')
    const data = load()
    const now = Date.now()
    const orderRef = String(options?.orderRef || '').trim().toUpperCase()
    const previous = data[jid]

    // The same store order may be retried after a crash between writing sewa.json
    // and store-rentals.json. Do not add the purchased duration a second time.
    if (orderRef && previous?.appliedOrderRefs?.includes(orderRef)) return previous

    // Manual owner command keeps its historical "set duration from now" behavior.
    // Paid store renewals, however, extend an unexpired group lease instead of
    // accidentally shortening the remaining time.
    const baseTime = orderRef && previous && previous.status === 'active' && Number(previous.endTime) > now
        ? Number(previous.endTime)
        : now
    const endTime = baseTime + Math.floor(seconds * 1000)
    const appliedOrderRefs = [...new Set([...(previous?.appliedOrderRefs || []), ...(orderRef ? [orderRef] : [])])].slice(-100)
    const record = {
        groupId: jid,
        legacyRef: previous?.legacyRef || '',
        startTime: orderRef && previous && Number(previous.startTime) > 0 ? Number(previous.startTime) : now,
        endTime,
        expired: endTime,
        status: 'active',
        warned24h: false,
        appliedOrderRefs,
        notifiedAt: 0,
        leaveAttemptedAt: 0,
        leftAt: 0,
        lastError: ''
    }
    data[jid] = record
    save(data)
    return record
}

function remove(groupId) {
    const data = load()
    const jid = String(groupId || '').trim()
    if (data[jid]) {
        delete data[jid]
        save(data)
        return true
    }
    const entry = Object.entries(data).find(([, record]) => String(record?.legacyRef || '') === jid || String(record?.groupId || '') === jid)
    if (!entry) return false
    delete data[entry[0]]
    save(data)
    return true
}

function list(activeOnly = false) {
    const data = load()
    const now = Date.now()
    return Object.values(data)
        .filter(item => !activeOnly || (item.status === 'active' && Number(item.endTime) > now))
        .sort((a, b) => Number(a.endTime) - Number(b.endTime))
}

function botIsParticipant(metadata, sock) {
    const botIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean)
    return (metadata?.participants || []).some(p => {
        const ids = [p?.id, p?.jid, p?.lid, p?.phoneNumber].filter(Boolean)
        return botIds.some(botId => ids.some(id => {
            try {
                return areJidsSameUser(String(id), String(botId))
            } catch {
                return String(id) === String(botId)
            }
        }))
    })
}

async function resolveGroupId(sock, record) {
    const raw = String(record?.groupId || '').trim()
    if (raw.endsWith('@g.us')) return raw
    if (!raw) return ''
    try {
        if (typeof sock?.groupGetInviteInfo === 'function') {
            const info = await sock.groupGetInviteInfo(raw)
            const jid = String(info?.id || info?.jid || '').trim()
            if (jid.endsWith('@g.us')) return jid
        }
    } catch (error) {
        record.lastError = String(error?.message || error)
    }
    return ''
}

async function notifyExpired(sock, record, targetGroupId) {
    if (record.notifiedAt) return true
    const message =
        `⛔ *MASA SEWA BOT TELAH BERAKHIR*\n\n` +
        `🆔 Grup: *${record.groupId}*\n` +
        `⏰ Berakhir: *${new Date(record.endTime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB*\n\n` +
        `Bot akan keluar dari grup karena masa sewa sudah habis.\n` +
        `Untuk memperpanjang, hubungi owner.`
    try {
        await sock.sendMessage(targetGroupId, { text: message })
        record.notifiedAt = Date.now()
        return true
    } catch (error) {
        record.lastError = String(error?.message || error)
        return false
    }
}

async function notifyWarning(sock, record) {
    if (record.warned24h) return
    const remaining = Math.max(0, Number(record.endTime) - Date.now())
    if (remaining > 86400000) return
    try {
        await sock.sendMessage(record.groupId, {
            text:
                `⚠️ *SEWA BOT AKAN BERAKHIR*\n\n` +
                `🆔 Grup: *${record.groupId}*\n` +
                `⏰ Berakhir: *${new Date(record.endTime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB*\n\n` +
                `Sisa waktu kurang dari 24 jam. Hubungi owner untuk perpanjangan.`
        })
        record.warned24h = true
    } catch (error) {
        record.lastError = String(error?.message || error)
    }
}

async function processOnce(sock = connection) {
    if (running || !sock?.user) return
    running = true
    try {
        const data = load()
        const now = Date.now()
        let changed = false
        for (const record of Object.values(data)) {
            if (!record?.groupId) continue
            if (record.status === 'left') continue
            const targetGroupId = await resolveGroupId(sock, record)
            if (!targetGroupId) {
                if (Number(record.endTime) <= now) record.status = 'expired_pending_leave'
                record.lastError = record.lastError || 'ID grup tidak dapat di-resolve dari data sewa.'
                changed = true
                continue
            }
            if (record.groupId !== targetGroupId) {
                record.legacyRef = record.groupId
                record.groupId = targetGroupId
                changed = true
            }
            if (Number(record.endTime) > now) {
                await notifyWarning(sock, record)
                changed = true
                continue
            }
            if (record.status !== 'expired' && record.status !== 'expired_pending_leave') {
                record.status = 'expired_pending_leave'
                changed = true
            }
            if (!record.notifiedAt) {
                const notified = await notifyExpired(sock, record, targetGroupId)
                changed = true
                if (!notified) continue
            }
            try {
                const metadata = await sock.groupMetadata(targetGroupId)
                if (!botIsParticipant(metadata, sock)) {
                    record.status = 'left'
                    record.leftAt = record.leftAt || now
                    record.lastError = ''
                    changed = true
                    continue
                }
            } catch (error) {
                record.lastError = String(error?.message || error)
                record.leaveAttemptedAt = now
                changed = true
                continue
            }
            try {
                record.leaveAttemptedAt = now
                await sock.groupLeave(targetGroupId)
                record.status = 'left'
                record.leftAt = Date.now()
                record.lastError = ''
                changed = true
                console.log(`[SEWA EXPIRED] ${targetGroupId} -> bot keluar`)
                const owner = String(global.owner || '').replace(/\D/g, '')
                if (owner) {
                    await sock.sendMessage(`${owner}@s.whatsapp.net`, {
                        text: `📢 *SEWA EXPIRED*\n\nGrup: *${targetGroupId}*\nStatus: *Bot sudah keluar*\nExpired: *${new Date(record.endTime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB*`
                    }).catch(() => {})
                }
            } catch (error) {
                record.status = 'expired_pending_leave'
                record.lastError = String(error?.message || error)
                changed = true
                console.error(`[SEWA LEAVE ERROR] ${targetGroupId}:`, error?.message || error)
            }
        }
        if (changed) save(data)
    } catch (error) {
        console.error('[SEWA SCHEDULER ERROR]', error?.stack || error)
    } finally {
        running = false
    }
}

function setConnection(sock) {
    connection = sock || null
    return connection
}

function startMonitor(sock, intervalMs = 30000) {
    connection = sock || connection
    if (monitor) return monitor
    monitor = setInterval(() => processOnce(connection), Math.max(10000, Number(intervalMs) || 30000))
    processOnce(connection).catch(error => console.error('[SEWA START ERROR]', error?.stack || error))
    return monitor
}

function stopMonitor() {
    if (monitor) clearInterval(monitor)
    monitor = null
    connection = null
    running = false
}

module.exports = {
    load,
    save,
    add,
    remove,
    list,
    setConnection,
    startMonitor,
    stopMonitor,
    processOnce,
    SEWA_FILE
}
