'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const DATA_DIR = path.resolve(String(process.env.XERYUU_DATA_DIR || path.join(os.homedir(), '.xeryuu')))
const DATA_FILE = path.join(DATA_DIR, 'persistent-group-settings.json')
const BLACKLIST_KEYS = new Set(['blacklistadzan', 'blacklistjpm'])
let cachedState = null
const migratedLegacyDatabases = new WeakSet()

function emptyState() {
    return { version: 1, groups: {}, updatedAt: new Date().toISOString() }
}

function normalizeState(value) {
    const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    if (!state.groups || typeof state.groups !== 'object' || Array.isArray(state.groups)) state.groups = {}
    for (const [jid, item] of Object.entries(state.groups)) {
        if (!jid.endsWith('@g.us') || !item || typeof item !== 'object' || Array.isArray(item)) {
            delete state.groups[jid]
            continue
        }
        for (const key of BLACKLIST_KEYS) {
            if (typeof item[key] !== 'boolean') delete item[key]
        }
        item.subject = String(item.subject || '').slice(0, 150)
    }
    state.version = 1
    return state
}

function loadState({ refresh = false } = {}) {
    if (cachedState && !refresh) return cachedState
    try {
        cachedState = normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')))
    } catch (error) {
        if (error?.code !== 'ENOENT' && error instanceof SyntaxError) {
            console.error(`[PERSISTENT GROUP SETTINGS] JSON rusak (${DATA_FILE}): ${error.message}`)
        } else if (error?.code !== 'ENOENT') {
            console.error(`[PERSISTENT GROUP SETTINGS] Gagal membaca ${DATA_FILE}: ${error?.message || error}`)
        }
        cachedState = emptyState()
    }
    return cachedState
}

function saveState(state = loadState()) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(DATA_DIR, 0o700) } catch {}
    state.updatedAt = new Date().toISOString()
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`
    fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.renameSync(temporaryFile, DATA_FILE)
    try { fs.chmodSync(DATA_FILE, 0o600) } catch {}
    cachedState = state
    return state
}

function ensureGroup(state, jid, subject = '') {
    if (!jid || !String(jid).endsWith('@g.us')) throw new TypeError('JID grup tidak valid.')
    if (!state.groups[jid] || typeof state.groups[jid] !== 'object' || Array.isArray(state.groups[jid])) {
        state.groups[jid] = { subject: '' }
    }
    if (subject) state.groups[jid].subject = String(subject).replace(/[\r\n]+/g, ' ').trim().slice(0, 150)
    return state.groups[jid]
}

function migrateLegacyDatabase(db) {
    if (!db || typeof db !== 'object') return loadState()
    const state = loadState()
    if (migratedLegacyDatabases.has(db)) return state
    let changed = false
    for (const collectionName of ['groups', 'chats']) {
        const collection = db[collectionName]
        if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue
        for (const [jid, oldGroup] of Object.entries(collection)) {
            if (!jid.endsWith('@g.us') || !oldGroup || typeof oldGroup !== 'object') continue
            for (const key of BLACKLIST_KEYS) {
                if (oldGroup[key] !== true) continue
                const entry = state.groups[jid]
                if (!entry || typeof entry[key] !== 'boolean') {
                    const target = ensureGroup(state, jid, oldGroup.subject || oldGroup.name || '')
                    target[key] = true
                    changed = true
                }
            }
        }
    }
    migratedLegacyDatabases.add(db)
    if (changed) saveState(state)
    return state
}

function isGroupBlacklisted(jid, key, legacyDb) {
    if (!BLACKLIST_KEYS.has(key)) throw new TypeError(`Kunci blacklist tidak didukung: ${key}`)
    const state = migrateLegacyDatabase(legacyDb)
    const entry = state.groups[String(jid || '')]
    return Boolean(entry && entry[key] === true)
}

function setGroupBlacklist(jid, key, enabled, options = {}) {
    if (!BLACKLIST_KEYS.has(key)) throw new TypeError(`Kunci blacklist tidak didukung: ${key}`)
    const state = migrateLegacyDatabase(options.db)
    const entry = ensureGroup(state, String(jid || ''), options.subject || '')
    entry[key] = Boolean(enabled)
    entry.updatedAt = new Date().toISOString()
    saveState(state)
    return entry[key]
}

function getBlacklistedGroups(key, legacyDb) {
    if (!BLACKLIST_KEYS.has(key)) throw new TypeError(`Kunci blacklist tidak didukung: ${key}`)
    const state = migrateLegacyDatabase(legacyDb)
    return Object.entries(state.groups)
        .filter(([, group]) => group?.[key] === true)
        .map(([jid, group]) => ({ jid, subject: String(group.subject || '') }))
}

module.exports = {
    DATA_DIR,
    DATA_FILE,
    loadState,
    saveState,
    migrateLegacyDatabase,
    isGroupBlacklisted,
    setGroupBlacklist,
    getBlacklistedGroups
}
