//Please don't change script credit creator
// Anti Kudeta service for Xeryuu-MD V10
'use strict'

require('../settings')
const fs = require('fs')
const path = require('path')
const { areJidsSameUser } = require('@whiskeysockets/baileys')

const file = path.join(process.cwd(), 'library', 'database', 'antikudeta.json')
if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true })
if (!fs.existsSync(file)) fs.writeFileSync(file, '{}')

let data = {}
try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
} catch {
    data = {}
}

function sameUser(a, b) {
    if (!a || !b) return false
    if (a === b) return true
    try {
        return areJidsSameUser(a, b)
    } catch {
        return false
    }
}

function ensure(groupId) {
    if (!groupId) throw new Error('groupId wajib diisi')
    if (!data[groupId] || typeof data[groupId] !== 'object') {
        data[groupId] = {
            active: false,
            protected: [],
            kudetaActors: []
        }
    }
    const cfg = data[groupId]
    if (!Array.isArray(cfg.protected)) cfg.protected = []
    if (!Array.isArray(cfg.kudetaActors)) cfg.kudetaActors = []
    if (typeof cfg.active !== 'boolean') cfg.active = false
    return cfg
}

function dedupe(list) {
    const out = []
    for (const item of Array.isArray(list) ? list : []) {
        if (!item) continue
        if (!out.some(existing => sameUser(existing, item))) out.push(item)
    }
    return out
}

function save() {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function removeUser(list, jid) {
    return (Array.isArray(list) ? list : []).filter(item => !sameUser(item, jid))
}

function isBotJid(sock, jid) {
    const botIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean)
    return botIds.some(botId => sameUser(botId, jid))
}

function isAdminParticipant(participant) {
    return participant?.admin === 'admin' || participant?.admin === 'superadmin'
}

async function enable(conn, groupId) {
    const cfg = ensure(groupId)
    const metadata = await conn.groupMetadata(groupId)
    const admins = []
    for (const p of metadata?.participants || []) {
        if (!isAdminParticipant(p)) continue
        for (const candidate of [p.id, p.lid, p.phoneNumber]) {
            if (candidate) admins.push(candidate)
        }
    }

    cfg.active = true
    // Actor yang sudah ditandai tetap diblok agar bot tidak mengangkatnya lagi.
    cfg.protected = dedupe([
        ...cfg.protected,
        ...admins
    ]).filter(id => !cfg.kudetaActors.some(actor => sameUser(actor, id)))
    save()
    return cfg
}

function disable(groupId) {
    const cfg = ensure(groupId)
    cfg.active = false
    save()
    return cfg
}

function resetActors(groupId) {
    const cfg = ensure(groupId)
    cfg.kudetaActors = []
    save()
    return cfg
}

function list(groupId) {
    return ensure(groupId)
}

async function handleParticipantsUpdate(conn, update) {
    if (!update?.id || !Array.isArray(update?.participants)) return

    const cfg = data?.[update.id]
    if (!cfg?.active) return

    const action = String(update.action || '').toLowerCase()
    if (!['demote', 'remove', 'promote'].includes(action)) return

    const protectedUsers = dedupe(cfg.protected)
    const blockedActors = dedupe(cfg.kudetaActors)
    const targets = update.participants
        .map(p => typeof p === 'string' ? p : (p?.id || p?.phoneNumber || p?.lid))
        .filter(Boolean)

    const metadata = await conn.groupMetadata(update.id).catch(() => null)
    if (!metadata) return

    const botParticipant = (metadata.participants || []).find(p =>
        [p.id, p.lid, p.phoneNumber].filter(Boolean).some(id => isBotJid(conn, id))
    )
    const botIsAdmin = isAdminParticipant(botParticipant)
    if (!botIsAdmin) return

    const actor = update.author || update.actor || update.by || update.initiator
    const actorIsBot = actor ? isBotJid(conn, actor) : false

    // Demote protected admin -> kunci pelaku, pulihkan target, lalu turunkan pelaku.
    if (action === 'demote') {
        const protectedTargets = targets.filter(jid =>
            protectedUsers.some(id => sameUser(id, jid)) &&
            !blockedActors.some(id => sameUser(id, jid))
        )
        if (!protectedTargets.length) return
        if (actorIsBot) return

        for (const target of protectedTargets) {
            await conn.groupParticipantsUpdate(update.id, [target], 'promote').catch(err =>
                console.error('[ANTI KUDETA] Gagal mengembalikan protected admin:', err?.message || err)
            )
        }

        if (actor && !actorIsBot) {
            if (!blockedActors.some(id => sameUser(id, actor))) blockedActors.push(actor)
            cfg.kudetaActors = dedupe(blockedActors)
            cfg.protected = removeUser(cfg.protected, actor)
            save()

            await new Promise(resolve => setTimeout(resolve, 800))
            await conn.groupParticipantsUpdate(update.id, [actor], 'demote').catch(err =>
                console.error('[ANTI KUDETA] Gagal mendemote pelaku:', err?.message || err)
            )
        } else {
            save()
            console.warn('[ANTI KUDETA] Demote terdeteksi tetapi actor tidak tersedia; target dipulihkan tanpa menghukum pelaku.')
        }

        await conn.sendMessage(update.id, {
            text:
                `🛡️ *ANTI KUDETA AKTIF*\n\n` +
                protectedTargets.map(jid => `✅ @${jid.split('@')[0]} dikembalikan menjadi admin.`).join('\n') +
                (actor && !actorIsBot ? `\n\n⛔ Pelaku @${actor.split('@')[0]} diturunkan dari admin dan diblokir dari auto-promote.` : ''),
            mentions: [...protectedTargets, ...(actor && !actorIsBot ? [actor] : [])]
        }).catch(() => {})
        return
    }

    // Pelaku yang sudah diblokir tidak boleh diangkat kembali.
    if (action === 'promote') {
        const forbidden = targets.filter(jid =>
            blockedActors.some(id => sameUser(id, jid))
        )
        if (!forbidden.length || actorIsBot) return

        await new Promise(resolve => setTimeout(resolve, 500))
        await conn.groupParticipantsUpdate(update.id, forbidden, 'demote').catch(err =>
            console.error('[ANTI KUDETA] Gagal membatalkan promote pelaku:', err?.message || err)
        )
        await conn.sendMessage(update.id, {
            text:
                `🚫 *AUTO-PROMOTE DITOLAK*\n\n` +
                forbidden.map(jid => `@${jid.split('@')[0]} masih diblokir oleh sistem anti-kudeta.`).join('\n'),
            mentions: forbidden
        }).catch(() => {})
        return
    }

    // Jika protected admin dihapus dari grup, pulihkan lalu promote kembali.
    if (action === 'remove') {
        const protectedTargets = targets.filter(jid =>
            protectedUsers.some(id => sameUser(id, jid)) &&
            !blockedActors.some(id => sameUser(id, jid))
        )
        if (!protectedTargets.length || actorIsBot) return

        await conn.groupParticipantsUpdate(update.id, protectedTargets, 'add').catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 1000))
        await conn.groupParticipantsUpdate(update.id, protectedTargets, 'promote').catch(() => {})
        return
    }
}

module.exports = {
    data,
    file,
    ensure,
    save,
    enable,
    disable,
    resetActors,
    list,
    handleParticipantsUpdate,
    sameUser
}
