'use strict'

/** Convert Baileys/protobuf timestamp values to Unix seconds. */
function timestampToSeconds(value) {
    let raw = value
    try {
        if (raw && typeof raw.toNumber === 'function') {
            raw = raw.toNumber()
        } else if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.low))) {
            const low = Number(raw.low) >>> 0
            const high = Number(raw.high || 0)
            raw = high * 0x100000000 + low
        }
    } catch {
        return 0
    }

    const number = Number(raw)
    if (!Number.isFinite(number) || number <= 0) return 0
    // Some custom forks emit milliseconds; Baileys normally uses seconds.
    return Math.floor(number > 1e12 ? number / 1000 : number)
}

function getMessageTimestampSeconds(message) {
    const candidates = [
        message?.messageTimestamp,
        message?.message?.messageContextInfo?.messageTimestamp,
        message?.key?.timestamp
    ]
    for (const candidate of candidates) {
        const seconds = timestampToSeconds(candidate)
        if (seconds > 0) return seconds
    }
    return 0
}

/**
 * Recognize direct-user chats by JID shape instead of hard-coding only today's
 * known WhatsApp domains. Regular WhatsApp, WhatsApp Business, PN JIDs, LIDs,
 * hosted LIDs and future direct-user aliases all use the same message path.
 * Group, status, broadcast and newsletter destinations are deliberately excluded.
 */
function isDirectChatJid(value) {
    const remoteJid = String(value || '').trim().toLowerCase()
    if (!remoteJid || remoteJid === 'status@broadcast') return false
    if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@broadcast') || remoteJid.endsWith('@newsletter')) return false
    return /^[^@\s]+@[^@\s]+$/.test(remoteJid)
}

function isCommandCandidate(body, chat, configuredPrefix = '.') {
    const text = String(body || '').trim()
    const remoteJid = String(chat || '')
    if (!text || !remoteJid) return false

    const isGroup = remoteJid.toLowerCase().endsWith('@g.us')
    const isPrivate = isDirectChatJid(remoteJid)
    const prefix = String(configuredPrefix || '.')

    if (isGroup && prefix && text.startsWith(prefix)) return true
    if (/^[.\/!#]/.test(text)) return true
    return isPrivate && /^(?:start|menu|help)$/i.test(text)
}

/**
 * `append` is used by Xeryuu-like forks both for history and for synthetic
 * command messages created from button/list/poll responses. Only permit a
 * clearly command-shaped message created at/after this socket's open time,
 * with a usable recent timestamp. This avoids replaying old payment/admin
 * commands when WhatsApp syncs history on startup.
 */
function shouldProcessLiveAppendMessage(message, socketOpenedAtSeconds, body, configuredPrefix = '.') {
    const openedAt = Number(socketOpenedAtSeconds)
    if (!Number.isFinite(openedAt) || openedAt <= 0) return false

    const timestamp = getMessageTimestampSeconds(message)
    if (!timestamp) return false

    const now = Math.floor(Date.now() / 1000)
    if (timestamp < openedAt) return false
    if (timestamp > now + 15) return false
    if (now - timestamp > 120) return false

    const chat = String(message?.key?.remoteJid || '')
    return isCommandCandidate(body, chat, configuredPrefix)
}

/** Allow a synthetic append to follow a same-ID interactive event only when
 * the original event did not already look like a command. */
function shouldAllowAppendFallback(previous, upsertType, currentIsCommand) {
    if (String(upsertType || 'notify') !== 'append' || !currentIsCommand || !previous) return false
    const previousType = typeof previous === 'object' ? String(previous.upsertType || '') : ''
    const previousWasCommand = typeof previous === 'object' && previous.isCommand === true
    return previousType !== 'append' && !previousWasCommand
}

module.exports = {
    timestampToSeconds,
    getMessageTimestampSeconds,
    isDirectChatJid,
    isCommandCandidate,
    shouldProcessLiveAppendMessage,
    shouldAllowAppendFallback
}
