'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Canonical database path is anchored to this bot's installation directory,
// not process.cwd(), so PM2/Termius launch-directory changes cannot switch DBs.
const DATABASE_DIR = path.join(__dirname, 'database')
const DATABASE_FILE = path.join(DATABASE_DIR, 'database.json')

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function mergeLegacyData(current, legacy) {
    if (!isPlainObject(current) || !isPlainObject(legacy)) return legacy
    const merged = { ...current }
    for (const [key, legacyValue] of Object.entries(legacy)) {
        const currentValue = current[key]
        merged[key] = isPlainObject(currentValue) && isPlainObject(legacyValue)
            ? mergeLegacyData(currentValue, legacyValue)
            : legacyValue
    }
    return merged
}

// One-time import for files previously stored under process.cwd()/library/database.
// This protects existing balances/orders when PM2 was originally launched from
// a different directory. A marker prevents a stale legacy file overwriting newer
// canonical data on every subsequent restart.
function migrateLegacyCwdDatabaseFile(filename) {
    const safeName = path.basename(String(filename || '').trim())
    if (!safeName || safeName !== String(filename || '').trim()) return path.join(DATABASE_DIR, safeName || 'database.json')

    const canonicalFile = path.join(DATABASE_DIR, safeName)
    const legacyFile = path.resolve(process.cwd(), 'library', 'database', safeName)
    if (legacyFile === path.resolve(canonicalFile) || !fs.existsSync(legacyFile)) return canonicalFile

    const markerHash = crypto.createHash('sha256').update(legacyFile).digest('hex').slice(0, 12)
    const markerFile = path.join(DATABASE_DIR, `.legacy-cwd-${safeName.replace(/[^a-z0-9._-]/gi, '_')}-${markerHash}.migrated`)
    if (fs.existsSync(markerFile)) return canonicalFile

    try {
        const legacy = JSON.parse(fs.readFileSync(legacyFile, 'utf8'))
        if (!isPlainObject(legacy)) return canonicalFile

        let current = {}
        if (fs.existsSync(canonicalFile)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'))
                if (isPlainObject(parsed)) current = parsed
            } catch {}
        }

        const merged = mergeLegacyData(current, legacy)
        fs.mkdirSync(DATABASE_DIR, { recursive: true })
        const tempFile = `${canonicalFile}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
        fs.writeFileSync(tempFile, JSON.stringify(merged, null, 2))
        fs.renameSync(tempFile, canonicalFile)
        fs.writeFileSync(markerFile, `${Date.now()}\n`)
        console.log(`[DATABASE MIGRATION] Imported legacy ${safeName} from ${legacyFile}`)
    } catch (error) {
        console.error(`[DATABASE MIGRATION] ${safeName}:`, error?.message || error)
    }

    return canonicalFile
}

function saveGlobalDatabase() {
    const data = global.db
    // Avoid writing a partial object if a command somehow runs before index.js
    // finishes loading the persisted database.
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !data.users || typeof data.users !== 'object' ||
        !data.groups || typeof data.groups !== 'object' ||
        !data.settings || typeof data.settings !== 'object') {
        return false
    }

    let tempFile = ''
    try {
        fs.mkdirSync(DATABASE_DIR, { recursive: true })
        tempFile = `${DATABASE_FILE}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
        fs.writeFileSync(tempFile, JSON.stringify(data, null, 2))
        fs.renameSync(tempFile, DATABASE_FILE)
        return true
    } catch (error) {
        if (tempFile) {
            try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile) } catch {}
        }
        console.error('[GLOBAL DATABASE SAVE]', error?.stack || error)
        return false
    }
}

module.exports = { saveGlobalDatabase, migrateLegacyCwdDatabaseFile, DATABASE_FILE }
