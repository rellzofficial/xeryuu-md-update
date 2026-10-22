'use strict'

const KEEPALIVE_INTERVAL_MS = 25000
const VERSION_CACHE_TTL_MS = 30 * 60 * 1000
const VERSION_FETCH_TIMEOUT_MS = 8000

// Alfabet kode pairing WhatsApp (Crockford base32 tanpa 0, I, O, U).
const PAIRING_ALPHABET = /^[1-9A-HJ-NP-TV-Z]{8}$/

let versionCache = null // { version: number[], at: number }

function parseVersion(value) {
    if (Array.isArray(value)) {
        const parts = value.map(Number).filter(Number.isFinite)
        return parts.length === 3 ? parts : null
    }
    const parts = String(value || '')
        .split(/[.,]/)
        .map(part => Number(part.trim()))
        .filter(Number.isFinite)
    return parts.length === 3 ? parts : null
}

function withTimeout(promise, ms) {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout mengambil versi WhatsApp')), ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function loadDefaultFetcher() {
    try {
        const baileys = require('@whiskeysockets/baileys')
        const fn = baileys.fetchLatestBaileysVersion || baileys.default?.fetchLatestBaileysVersion
        return typeof fn === 'function' ? fn : null
    } catch {
        return null
    }
}

/**
 * Menentukan versi WhatsApp Web untuk socket baru.
 *
 * Urutan percobaan (attempt naik setiap socket gagal dengan 405):
 *   mode "auto"   : terbaru -> patokan di settings -> default library
 *   mode "pinned" : patokan di settings -> terbaru -> default library
 *
 * Hasil `undefined` berarti "biarkan Baileys memakai versi bawaannya".
 */
async function resolveWaVersion(options = {}) {
    const runtime = global.runtimeConfig || {}
    const attempt = Math.max(0, Number(options.attempt) || 0)
    const mode = String(options.mode || runtime.waVersionMode || 'auto').toLowerCase() === 'pinned'
        ? 'pinned'
        : 'auto'
    const pinned = parseVersion(options.pinned ?? runtime.waVersion ?? global.waVersion)
    const fetcher = options.fetcher === undefined ? loadDefaultFetcher() : options.fetcher
    const timeoutMs = Number(options.timeoutMs) || VERSION_FETCH_TIMEOUT_MS

    const ladder = mode === 'pinned' ? ['pinned', 'latest', 'default'] : ['latest', 'pinned', 'default']
    const step = ladder[Math.min(attempt, ladder.length - 1)]

    const useLatest = async () => {
        const now = Date.now()
        if (!options.force && versionCache && now - versionCache.at < VERSION_CACHE_TTL_MS) {
            return { version: versionCache.version, source: 'latest (cache)' }
        }
        if (typeof fetcher !== 'function') return null
        try {
            const result = await withTimeout(Promise.resolve(fetcher()), timeoutMs)
            const version = parseVersion(result?.version)
            // Baileys mengembalikan { isLatest:false, error } bila gagal mengambil
            // versi terbaru dan hanya memberi versi bawaan. Itu tidak kita cache.
            if (version && result?.isLatest !== false) {
                versionCache = { version, at: now }
                return { version, source: 'latest' }
            }
        } catch {
            // jatuh ke tahap berikutnya
        }
        return null
    }

    if (step === 'latest') {
        const latest = await useLatest()
        if (latest) return latest
        if (pinned) return { version: pinned, source: 'pinned (fallback)' }
        return { version: undefined, source: 'default library' }
    }
    if (step === 'pinned') {
        if (pinned) return { version: pinned, source: 'pinned' }
        const latest = await useLatest()
        if (latest) return latest
        return { version: undefined, source: 'default library' }
    }
    return { version: undefined, source: 'default library' }
}

function resetVersionCache() {
    versionCache = null
}

/**
 * Nomor pairing: hanya digit, kode negara wajib.
 * 0812xxxx -> 62812xxxx, 620812xxxx -> 62812xxxx. Mengembalikan '' bila tidak valid.
 */
function normalizePairingNumber(value) {
    let digits = String(value || '').replace(/\D/g, '')
    if (!digits) return ''
    if (digits.startsWith('00')) digits = digits.slice(2)
    if (digits.startsWith('620')) digits = '62' + digits.slice(3)
    else if (digits.startsWith('0')) digits = '62' + digits.slice(1)
    if (digits.length < 8 || digits.length > 15) return ''
    return digits
}

/**
 * Kode pairing custom harus 8 karakter dari alfabet WhatsApp. Kode yang tidak
 * valid dibuang (bukan melempar error) supaya pairing tetap jalan dengan kode acak.
 */
function sanitizeCustomPairingCode(value) {
    const code = String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
    if (!code) return { code: '', reason: '' }
    if (code.length !== 8) return { code: '', reason: 'harus tepat 8 karakter' }
    if (!PAIRING_ALPHABET.test(code)) {
        return { code: '', reason: 'tidak boleh memakai huruf/angka 0, I, O, U' }
    }
    return { code, reason: '' }
}

/** Jeda reconnect eksponensial dengan jitter kecil. attempt mulai dari 1. */
function backoffDelay(attempt, baseMs = 3000, maxMs = 60000) {
    const n = Math.max(1, Number(attempt) || 1)
    const raw = Math.min(maxMs, baseMs * Math.pow(2, n - 1))
    const jitter = Math.floor(raw * 0.1 * Math.random())
    return Math.min(maxMs, raw + jitter)
}

const DISCONNECT_INFO = {
    401: { retry: false, text: 'Session logout dari WhatsApp (perangkat dihapus dari Perangkat Tertaut / nomor di-logout). Pairing ulang diperlukan.' },
    403: { retry: false, text: 'WhatsApp menolak akses (forbidden). Nomor mungkin dibatasi/diblokir sementara.' },
    405: { retry: true, text: 'WhatsApp menolak koneksi (405). Biasanya versi WhatsApp Web yang dipakai sudah basi atau pairing ditolak server.' },
    408: { retry: true, text: 'Koneksi timeout / terputus (408). Biasanya jaringan atau event loop terblokir.' },
    411: { retry: false, text: 'Multi-device mismatch (411). Session tidak cocok, pairing ulang diperlukan.' },
    428: { retry: true, text: 'Koneksi ditutup oleh server atau jaringan (428).' },
    440: { retry: false, text: 'Session dipakai oleh koneksi lain (440). Ada instance bot ganda (PM2 + manual / dua panel / dua server) memakai folder session yang sama.' },
    500: { retry: true, text: 'Bad session (500). File session rusak sebagian.' },
    503: { retry: true, text: 'Server WhatsApp sedang tidak tersedia (503).' },
    515: { retry: true, text: 'WhatsApp meminta restart socket (515). Ini normal sesaat setelah pairing berhasil.' }
}

function describeDisconnect(code) {
    return DISCONNECT_INFO[Number(code)] || { retry: true, text: `Koneksi ditutup (kode ${code ?? 'unknown'}).` }
}

module.exports = {
    KEEPALIVE_INTERVAL_MS,
    parseVersion,
    resolveWaVersion,
    resetVersionCache,
    normalizePairingNumber,
    sanitizeCustomPairingCode,
    backoffDelay,
    describeDisconnect
}
