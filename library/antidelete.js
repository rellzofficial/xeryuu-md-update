//Please don't change script credit creator
// Anti Delete service for Xeryuu-MD V10
'use strict'

require('../settings')
const { areJidsSameUser, downloadContentFromMessage } = require('@whiskeysockets/baileys')

const CACHE_TTL = 24 * 60 * 60 * 1000
const cache = new Map()

function normalizeJid(jid) {
    if (!jid) return ''
    return String(jid).trim()
}

function sameUser(a, b) {
    if (!a || !b) return false
    const aa = normalizeJid(a)
    const bb = normalizeJid(b)
    if (aa === bb) return true

    const toNumber = value => {
        const raw = String(value)
        if (raw.includes('@') && !raw.endsWith('@s.whatsapp.net')) return null
        return raw.split('@')[0].split(':')[0].replace(/\D/g, '') || null
    }

    const an = toNumber(aa)
    const bn = toNumber(bb)
    if (an && bn && an === bn) return true

    try {
        return areJidsSameUser(aa, bb)
    } catch {
        return false
    }
}

function getPrivateAllowlist() {
    const configured = Array.isArray(global.antiDeletePrivateUsers)
        ? global.antiDeletePrivateUsers
        : []

    return configured
        .map(v => normalizeJid(v))
        .filter(Boolean)
}

function isPrivateAllowed(jid) {
    const normalized = normalizeJid(jid)
    if (!normalized || normalized.endsWith('@g.us') || normalized === 'status@broadcast') return false
    return getPrivateAllowlist().some(user => sameUser(user, normalized))
}

function getScope(jid) {
    const normalized = normalizeJid(jid)
    if (!normalized) return 'invalid'
    if (normalized === 'status@broadcast') return 'status'
    if (normalized.endsWith('@g.us')) return 'group'
    return 'private'
}

function isEnabledForChat(jid) {
    const normalized = normalizeJid(jid)
    const scope = getScope(normalized)
    if (scope === 'group') {
        return global.db?.groups?.[normalized]?.antidelete === true
    }
    if (scope === 'private') {
        if (!isPrivateAllowed(normalized)) return false
        return global.db?.privateAntiDelete?.[normalized] === true
    }
    return false
}

function clearChat(chat) {
    if (!chat) return
    for (const [id, saved] of cache.entries()) {
        if (sameUser(saved?.key?.remoteJid, chat)) {
            cache.delete(id)
        }
    }
}

async function saveAntiDeleteMessage(conn, msg) {
    try {
        if (!msg?.key?.id || !msg?.message) return false

        const chat = msg.key.remoteJid
        if (!isEnabledForChat(chat)) return false

        cache.set(msg.key.id, {
            key: {
                ...msg.key,
                participant: msg.key.participant
            },
            message: msg.message,
            pushName: msg.pushName || 'Unknown',
            timestamp: Date.now()
        })

        const timer = setTimeout(() => cache.delete(msg.key.id), CACHE_TTL)
        if (typeof timer.unref === 'function') timer.unref()
        return true
    } catch (err) {
        console.error('[ANTI-DELETE SAVE]', err)
        return false
    }
}

async function readMedia(message, type) {
    const media = await downloadContentFromMessage(message, type)
    const chunks = []
    for await (const chunk of media) chunks.push(chunk)
    return Buffer.concat(chunks)
}

async function handleAntiDelete(conn, msg) {
    try {
        const protocol = msg?.message?.protocolMessage
        if (!protocol || protocol.type !== 0) return false

        const deletedKey = protocol.key
        if (!deletedKey?.id) return false

        const chat = deletedKey.remoteJid || msg?.key?.remoteJid
        if (!isEnabledForChat(chat)) {
            cache.delete(deletedKey.id)
            return false
        }

        const saved = cache.get(deletedKey.id)
        if (!saved) return false

        const sender = saved.key.participant || saved.key.remoteJid
        const senderNumber = sender
            ? String(sender).split('@')[0].split(':')[0]
            : 'Unknown'
        const mention = sender && sender.includes('@') ? sender : null
        const contextInfo = mention ? { mentionedJid: [mention] } : undefined
        const message = saved.message

        const header = `🗑️ *ANTI DELETE*\n\n👤 Pengirim: @${senderNumber}`

        if (message.conversation || message.extendedTextMessage?.text) {
            const text = message.conversation || message.extendedTextMessage?.text || ''
            await conn.sendMessage(chat, {
                text: `${header}\n\n💬 *Pesan yang dihapus:*\n\n${text}`,
                ...(contextInfo ? { contextInfo } : {})
            })
        } else if (message.imageMessage) {
            const buffer = await readMedia(message.imageMessage, 'image')
            await conn.sendMessage(chat, {
                image: buffer,
                caption: `${header}\n\n🖼️ *Gambar yang dihapus*\n\n${message.imageMessage.caption || ''}`,
                ...(contextInfo ? { contextInfo } : {})
            })
        } else if (message.videoMessage) {
            const buffer = await readMedia(message.videoMessage, 'video')
            await conn.sendMessage(chat, {
                video: buffer,
                caption: `${header}\n\n🎥 *Video yang dihapus*\n\n${message.videoMessage.caption || ''}`,
                ...(contextInfo ? { contextInfo } : {})
            })
        } else if (message.audioMessage) {
            const buffer = await readMedia(message.audioMessage, 'audio')
            await conn.sendMessage(chat, {
                audio: buffer,
                mimetype: message.audioMessage.mimetype || 'audio/mpeg',
                ptt: Boolean(message.audioMessage.ptt)
            })
            await conn.sendMessage(chat, {
                text: `${header}\n\n🎵 *Audio yang dihapus*`,
                ...(contextInfo ? { contextInfo } : {})
            })
        } else if (message.documentMessage) {
            const buffer = await readMedia(message.documentMessage, 'document')
            await conn.sendMessage(chat, {
                document: buffer,
                mimetype: message.documentMessage.mimetype || 'application/octet-stream',
                fileName: message.documentMessage.fileName || 'deleted-file'
            })
            await conn.sendMessage(chat, {
                text: `${header}\n\n📄 *Dokumen yang dihapus*`,
                ...(contextInfo ? { contextInfo } : {})
            })
        } else if (message.stickerMessage) {
            const buffer = await readMedia(message.stickerMessage, 'sticker')
            await conn.sendMessage(chat, { sticker: buffer })
            await conn.sendMessage(chat, {
                text: `${header}\n\n🏷️ *Sticker yang dihapus*`,
                ...(contextInfo ? { contextInfo } : {})
            })
        } else if (message.contactMessage) {
            await conn.sendMessage(chat, {
                text: `${header}\n\n👤 *Kontak yang dihapus*\n\nNama: ${message.contactMessage.displayName || '-'}\nNomor: ${message.contactMessage.vcard || '-'}`,
                ...(contextInfo ? { contextInfo } : {})
            })
        } else {
            await conn.sendMessage(chat, {
                text: `${header}\n\n⚠️ Pesan telah dihapus.\n\nJenis pesan:\n${Object.keys(message)[0] || 'Unknown'}`,
                ...(contextInfo ? { contextInfo } : {})
            })
        }

        cache.delete(deletedKey.id)
        return true
    } catch (err) {
        console.error('[ANTI-DELETE ERROR]', err)
        return false
    }
}

module.exports = {
    saveAntiDeleteMessage,
    handleAntiDelete,
    clearChat,
    isEnabledForChat,
    isPrivateAllowed,
    getPrivateAllowlist
}
