'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DB_FILE = path.join(__dirname, 'database', 'convert-pulsa.json')
const createInFlight = new Map()
const refreshInFlight = new Map()
let poller = null
let pollRunning = false
let notifier = null

function config() {
    const value = global.convertPulsaConfig || {}
    return {
        enabled: value.enabled !== false,
        baseUrl: String(value.baseUrl || 'https://pesanjasa.com/api/v1/convert-pulsa').trim().replace(/\/+$/, ''),
        apiKey: String(value.apiKey || process.env.PESANJASA_CONVERT_API_KEY || '').trim(),
        timeoutMs: Math.max(5000, Math.min(60000, Number(value.timeoutMs || 20000))),
        pollIntervalMs: Math.max(15000, Number(value.pollIntervalMs || 30000)),
        sessionTtlMs: Math.max(60000, Number(value.sessionTtlMs || 15 * 60 * 1000))
    }
}

function ready() {
    const c = config()
    return Boolean(c.enabled && c.baseUrl && c.apiKey)
}

function ensureDb() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ version: 1, transactions: {}, sessions: {} }, null, 2), { mode: 0o600 })
    }
    try {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Struktur root database tidak valid.')
        if (raw.transactions == null) raw.transactions = {}
        if (raw.sessions == null) raw.sessions = {}
        if (typeof raw.transactions !== 'object' || Array.isArray(raw.transactions) || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions)) {
            throw new Error('Struktur transaksi/sesi database tidak valid.')
        }
        raw.version = 1
        try { fs.chmodSync(DB_FILE, 0o600) } catch {}
        return raw
    } catch (error) {
        console.error('[CONVERT PULSA DB READ]', error?.message || error)
        // Fail closed. Never silently reset the ledger, because that could erase
        // unresolved references and allow a duplicate paid order after corruption.
        throw new Error('Database convert pulsa tidak dapat dibaca. Pembuatan order dihentikan; simpan salinan file database dan lakukan pemeriksaan sebelum melanjutkan.')
    }
}

let dbCache = null
function db() {
    if (!dbCache) dbCache = ensureDb()
    return dbCache
}

function saveDb() {
    const database = db()
    const temp = `${DB_FILE}.${process.pid}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.tmp`
    try {
        fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
        fs.writeFileSync(temp, JSON.stringify(database, null, 2), { mode: 0o600 })
        fs.renameSync(temp, DB_FILE)
        try { fs.chmodSync(DB_FILE, 0o600) } catch {}
        return true
    } catch (error) {
        try { if (fs.existsSync(temp)) fs.unlinkSync(temp) } catch {}
        console.error('[CONVERT PULSA DB SAVE]', error?.message || error)
        throw new Error('Database convert pulsa gagal disimpan. Operasi dihentikan agar status transaksi tidak hilang.')
    }
}

function formatMoney(value) {
    return Math.max(0, Math.floor(Number(value) || 0)).toLocaleString('id-ID')
}

function makeRef() {
    return `CPX${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

function textField(object, names, fallback = '') {
    for (const name of names) {
        const value = name.split('.').reduce((current, key) => current == null ? undefined : current[key], object)
        if (value !== undefined && value !== null && value !== '') {
            if (typeof value === 'object') continue
            return String(value).trim()
        }
    }
    return fallback
}

function numberField(object, names, fallback = null) {
    for (const name of names) {
        const value = name.split('.').reduce((current, key) => current == null ? undefined : current[key], object)
        if (value === undefined || value === null || value === '') continue
        const n = Number(String(value).replace(/,/g, ''))
        if (Number.isFinite(n)) return n
    }
    return fallback
}

function boolField(object, names) {
    for (const name of names) {
        const value = name.split('.').reduce((current, key) => current == null ? undefined : current[key], object)
        if (value === undefined || value === null || value === '') continue
        if (typeof value === 'boolean') return value
        const normalized = String(value).toLowerCase().trim()
        if (['true', '1', 'yes', 'active', 'online', 'available', 'enabled'].includes(normalized)) return true
        if (['false', '0', 'no', 'inactive', 'offline', 'maintenance', 'disabled', 'unavailable'].includes(normalized)) return false
    }
    return null
}

function unwrap(body) {
    let result = body
    for (let i = 0; i < 3; i++) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) break
        if (result.data !== undefined && result.data !== null) result = result.data
        else if (result.result !== undefined && result.result !== null) result = result.result
        else if (result.response !== undefined && result.response !== null) result = result.response
        else break
    }
    return result
}

function responseRejected(body) {
    if (!body || typeof body !== 'object') return false
    if (body.success === false || body.ok === false) return true
    const status = String(body.status || '').trim().toLowerCase()
    return ['error', 'failed', 'failure', 'rejected'].includes(status) && Boolean(body.message || body.error)
}

async function request(method, route, data) {
    // Keep pure parser/status helpers loadable by the test runner even in a
    // source-only checkout where npm dependencies have not yet been installed.
    const axios = require('axios')
    const c = config()
    if (!ready()) throw new Error('API Convert Pulsa belum siap. Isi PESANJASA_CONVERT_API_KEY pada environment VPS atau settings.js.')
    const normalizedRoute = String(route || '').startsWith('/') ? String(route) : `/${route}`
    const url = `${c.baseUrl}${normalizedRoute}`
    try {
        const response = await axios({
            method,
            url,
            ...(data !== undefined ? { data } : {}),
            timeout: c.timeoutMs,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-API-KEY': c.apiKey
            },
            validateStatus: status => status >= 200 && status < 300
        })
        if (responseRejected(response.data)) {
            throw new Error(textField(response.data, ['message', 'error', 'description'], 'Provider menolak permintaan.'))
        }
        return response.data
    } catch (error) {
        const status = Number(error?.response?.status || 0)
        if (status) {
            const body = error?.response?.data
            const message = textField(body, ['message', 'error', 'description'], '')
            const wrapped = new Error(`PesanJasa API HTTP ${status}${message ? `: ${message}` : ''}`)
            // A 5xx response may happen after the provider accepted an order.
            // Treat it as ambiguous so a second POST is never automatic.
            if (status >= 500 || [408, 409, 425, 429].includes(status)) wrapped.ambiguous = true
            throw wrapped
        }
        if (/^provider menolak permintaan/i.test(String(error?.message || ''))) throw error
        if (/timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|network/i.test(String(error?.code || '') + ' ' + String(error?.message || ''))) {
            const wrapped = new Error('Koneksi ke PesanJasa terputus atau timeout. Status permintaan tidak dapat dipastikan; jangan membuat pesanan ulang sebelum rekonsiliasi.')
            wrapped.ambiguous = true
            throw wrapped
        }
        throw error
    }
}

function walkObjects(value, callback, depth = 0, seen = new Set()) {
    if (depth > 7 || value == null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    callback(value)
    if (Array.isArray(value)) {
        for (const item of value) walkObjects(item, callback, depth + 1, seen)
    } else {
        for (const child of Object.values(value)) walkObjects(child, callback, depth + 1, seen)
    }
}

function candidateArray(root, keys) {
    let found = null
    const targetKeys = new Set(keys.map(key => key.toLowerCase()))
    const visit = (value, depth = 0) => {
        if (found || depth > 6 || value == null || typeof value !== 'object') return
        if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1)
            return
        }
        for (const [key, child] of Object.entries(value)) {
            if (targetKeys.has(key.toLowerCase()) && Array.isArray(child) && child.length) {
                found = child
                return
            }
        }
        for (const child of Object.values(value)) visit(child, depth + 1)
    }
    visit(root)
    return found
}

function normaliseRate(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return null
    // Provider may represent 86% either as 0.86 or 86.
    return n > 1 ? n / 100 : n
}

function parseOperators(raw) {
    const body = unwrap(raw)
    const list = candidateArray(body, ['operators', 'operator_rates', 'operatorRates', 'rates', 'providers', 'carriers', 'items', 'data', 'results'])
    const entries = Array.isArray(list) ? list : (Array.isArray(body) ? body : [])
    const result = []
    const seen = new Set()
    for (const item of entries) {
        if (!item || typeof item !== 'object') continue
        const id = textField(item, ['operator_id', 'operatorId', 'id_operator', 'provider_id', 'id', 'code', 'operator_code', 'slug', 'key'])
        const name = textField(item, ['operator_name', 'operatorName', 'name', 'operator', 'provider_name', 'label', 'title', 'display_name'])
        if (!id || !name) continue
        const dedupeKey = id.toLowerCase()
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        const rateRaw = numberField(item, ['rate', 'exchange_rate', 'exchangeRate', 'conversion_rate', 'rate_value', 'percentage', 'rate_percent'])
        const minimum = numberField(item, ['min_amount', 'minAmount', 'minimum_amount', 'minimum', 'min_pulsa', 'min', 'min_nominal'])
        const maximum = numberField(item, ['max_amount', 'maxAmount', 'maximum_amount', 'maximum', 'max_pulsa', 'max', 'max_nominal'])
        const explicitAvailable = boolField(item, ['is_active', 'active', 'available', 'enabled', 'is_available'])
        const statusRaw = textField(item, ['status', 'server_status', 'availability', 'state'], '')
        const statusOffline = /maintenance|offline|inactive|disabled|unavailable|gangguan|non.?aktif/i.test(statusRaw)
        result.push({
            id,
            name,
            rate: normaliseRate(rateRaw),
            rateRaw,
            minAmount: Number.isFinite(minimum) && minimum > 0 ? Math.floor(minimum) : null,
            maxAmount: Number.isFinite(maximum) && maximum > 0 ? Math.floor(maximum) : null,
            status: statusRaw || (explicitAvailable === false || statusOffline ? 'OFFLINE' : explicitAvailable === true ? 'ONLINE' : 'UNKNOWN'),
            available: explicitAvailable !== false && !statusOffline,
            raw: item
        })
    }
    return result
}

function parsePayoutMethods(raw) {
    const body = unwrap(raw)
    const list = candidateArray(body, ['payout_methods', 'payoutMethods', 'withdraw_methods', 'withdrawMethods', 'payouts', 'destinations', 'payment_methods', 'paymentMethods', 'methods', 'channels', 'receivers'])
    const entries = Array.isArray(list) ? list : []
    const output = []
    const seen = new Set()
    for (const item of entries) {
        let value = ''
        let label = ''
        if (typeof item === 'string' || typeof item === 'number') {
            value = String(item).trim()
            label = value
        } else if (item && typeof item === 'object') {
            // Prefer the actual payout method/code over a generic database ID;
            // PesanJasa's create-order contract expects a method value like DANA.
            value = textField(item, ['payout_method', 'payoutMethod', 'method_code', 'methodCode', 'code', 'key', 'value', 'slug', 'method', 'name', 'label', 'id'])
            label = textField(item, ['label', 'name', 'title', 'method_name', 'methodName', 'display_name', 'method', 'payout_method'], value)
        }
        if (!value) continue
        const key = value.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const active = typeof item === 'object' && item ? boolField(item, ['is_active', 'active', 'available', 'enabled']) : null
        if (active === false) continue
        output.push({ value, label, raw: typeof item === 'object' ? item : null })
    }
    return output
}

async function getRates() {
    const raw = await request('GET', '/rates')
    const operators = parseOperators(raw)
    const payoutMethods = parsePayoutMethods(raw)
    if (!operators.length) {
        throw new Error('Respons /rates PesanJasa belum dikenali (operator_id/nama operator tidak ditemukan). Tidak ada pilihan operator yang dibuat agar ID tidak salah.')
    }
    const fetchedAt = Date.now()
    // Keep the verified provider rate table for calculate() when PesanJasa's
    // calculate response omits a separate estimated payout amount.
    db().lastRates = {
        operators: operators.map(({ id, name, rate, rateRaw, minAmount, maxAmount, status, available }) => ({
            id, name, rate, rateRaw, minAmount, maxAmount, status, available
        })),
        payoutMethods: payoutMethods.map(({ value, label }) => ({ value, label })),
        fetchedAt
    }
    saveDb()
    return { operators, payoutMethods, fetchedAt }
}

function getOperatorById(operators, id) {
    const key = String(id ?? '').trim().toLowerCase()
    return (Array.isArray(operators) ? operators : []).find(operator => String(operator.id).toLowerCase() === key) || null
}

function amountValue(value) {
    const digits = String(value ?? '').replace(/[^0-9]/g, '')
    if (!digits) return NaN
    const amount = Number(digits)
    return Number.isSafeInteger(amount) ? amount : NaN
}

async function calculate(operatorId, amount) {
    const value = amountValue(amount)
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Nominal pulsa tidak valid.')
    const raw = await request('POST', '/calculate', { operator_id: operatorId, pulsa_amount: value })
    const body = unwrap(raw)
    if (responseRejected(raw) || responseRejected(body)) throw new Error(textField(body, ['message', 'error'], 'PesanJasa menolak kalkulasi nominal.'))

    let estimated = numberField(body, [
        'net_amount', 'netAmount', 'payout_amount', 'payoutAmount', 'received_amount', 'receivedAmount',
        'estimated_amount', 'estimatedAmount', 'amount_received', 'amountReceived', 'total_receive', 'totalReceived',
        'amount_net', 'amountNet', 'net', 'amount_after_fee', 'amountAfterFee', 'estimated_payout'
    ])
    let fee = numberField(body, ['admin_fee', 'adminFee', 'fee', 'fee_amount', 'feeAmount', 'transfer_fee', 'transferFee'])
    let rate = normaliseRate(numberField(body, ['rate', 'exchange_rate', 'exchangeRate', 'conversion_rate', 'rate_value']))
    const gross = numberField(body, ['gross_amount', 'grossAmount', 'converted_amount', 'convertedAmount', 'payout_gross'])
    const rates = db().lastRates
    const operator = getOperatorById(rates?.operators, operatorId)
    if (rate == null) rate = operator?.rate ?? null
    if (estimated == null && gross != null && fee != null) estimated = Math.max(0, gross - fee)
    if (estimated == null && operator?.rate != null) estimated = Math.floor(value * operator.rate)
    if (fee == null) fee = 0
    if (!Number.isFinite(Number(estimated)) || Number(estimated) <= 0) {
        throw new Error('PesanJasa tidak mengembalikan estimasi pencairan yang dapat diverifikasi. Transaksi dihentikan agar pengguna tidak menyetujui konversi tanpa estimasi nominal.')
    }
    return {
        operatorId: String(operatorId),
        amount: value,
        estimatedAmount: estimated == null ? null : Math.max(0, Math.floor(estimated)),
        fee: Math.max(0, Math.floor(fee)),
        rate,
        raw: body
    }
}

function getSession(channel, userId) {
    const key = `${String(channel || '').toLowerCase()}:${String(userId || '')}`
    const value = db().sessions[key]
    if (!value) return null
    if (Number(value.expiresAt || 0) <= Date.now()) {
        delete db().sessions[key]
        saveDb()
        return null
    }
    return { ...value }
}

function setSession(channel, userId, patch) {
    const key = `${String(channel || '').toLowerCase()}:${String(userId || '')}`
    const previous = db().sessions[key] || {}
    const next = { ...previous, ...(patch || {}), channel: String(channel || '').toLowerCase(), userId: String(userId || ''), updatedAt: Date.now() }
    if (!next.createdAt) next.createdAt = Date.now()
    if (!next.expiresAt || Number(next.expiresAt) <= Date.now()) next.expiresAt = Date.now() + config().sessionTtlMs
    db().sessions[key] = next
    saveDb()
    return { ...next }
}

function clearSession(channel, userId) {
    const key = `${String(channel || '').toLowerCase()}:${String(userId || '')}`
    if (!db().sessions[key]) return false
    delete db().sessions[key]
    saveDb()
    return true
}

function findOrder(ref) {
    const key = String(ref || '').trim().toUpperCase()
    return db().transactions[key] ? { ...db().transactions[key] } : null
}

function saveOrder(tx) {
    const ref = String(tx?.ref || '').trim().toUpperCase()
    if (!ref) throw new Error('Referensi transaksi convert pulsa tidak valid.')
    db().transactions[ref] = { ...tx, ref, updatedAt: Date.now() }
    saveDb()
    return { ...db().transactions[ref] }
}

function proofEligible(tx) {
    const status = String(tx?.status || '').toUpperCase()
    const hasOfficialTransferDetails = hasOfficialInstructions(tx)
    return Boolean(tx?.providerTrxId && ['WAITING_TRANSFER', 'PENDING', 'PROCESSING'].includes(status) && (status === 'PROCESSING' || hasOfficialTransferDetails))
}

// Reserve a single receipt submission before any network I/O. This prevents two
// nearly simultaneous photos from both being forwarded while the first upload is
// still in progress. The reservation expires after two minutes on process restart.
function claimProof(ref, metadata = {}) {
    const tx = findOrder(ref)
    if (!tx) throw new Error('Referensi convert pulsa tidak ditemukan.')
    if (!proofEligible(tx)) throw new Error('Bukti hanya bisa dikirim untuk order aktif yang sudah memiliki instruksi resmi, atau berstatus sedang diproses PesanJasa.')
    const now = Date.now()
    const previousCount = Math.max(0, Math.floor(Number(tx.proofCount) || 0))
    if (previousCount >= 3) throw new Error('Batas 3 bukti per transaksi sudah tercapai. Hubungi owner untuk bantuan lanjutan.')
    if (now - Number(tx.proofSubmittedAt || 0) < 15000) throw new Error('Bukti baru saja dikirim. Tunggu sebentar sebelum mengirim bukti berikutnya.')
    const lockAt = Number(tx.proofProcessingAt || 0)
    if (tx.proofProcessingToken && now - lockAt < 120000) throw new Error('Bukti lain untuk transaksi ini sedang diproses. Tunggu hingga proses selesai.')
    const token = crypto.randomBytes(16).toString('hex')
    const reserved = saveOrder({
        ...tx,
        proofProcessingAt: now,
        proofProcessingToken: token,
        proofChannel: String(metadata.channel || tx.channel || '').toLowerCase(),
        proofSubmitter: String(metadata.submitter || tx.userId || '').slice(0, 100)
    })
    return { tx: reserved, token }
}

function releaseProofClaim(ref, token) {
    const tx = findOrder(ref)
    if (!tx || !token || String(tx.proofProcessingToken || '') !== String(token)) return false
    saveOrder({ ...tx, proofProcessingAt: 0, proofProcessingToken: '' })
    return true
}

// Stores bot-side receipt metadata only. PesanJasa's public convert-pulsa API
// documentation has no receipt-upload route, so this must never alter the
// provider transaction status or pretend the proof was submitted to PesanJasa.
function recordProof(ref, metadata = {}) {
    const tx = findOrder(ref)
    if (!tx) throw new Error('Referensi convert pulsa tidak ditemukan.')
    if (!proofEligible(tx)) throw new Error('Bukti hanya bisa dikirim untuk order aktif yang sudah memiliki instruksi resmi, atau berstatus sedang diproses PesanJasa.')
    const lockToken = String(tx.proofProcessingToken || '')
    const claimToken = String(metadata.claimToken || '')
    if (lockToken && lockToken !== claimToken) throw new Error('Klaim pengiriman bukti tidak cocok atau sedang diproses oleh sesi lain.')
    if (claimToken && lockToken !== claimToken) throw new Error('Klaim pengiriman bukti sudah tidak aktif. Periksa riwayat sebelum mencoba ulang.')
    const now = Date.now()
    const previousCount = Math.max(0, Math.floor(Number(tx.proofCount) || 0))
    if (previousCount >= 3) throw new Error('Batas 3 bukti per transaksi sudah tercapai. Hubungi owner untuk bantuan lanjutan.')
    if (now - Number(tx.proofSubmittedAt || 0) < 15000) throw new Error('Bukti baru saja dikirim. Tunggu sebentar sebelum mengirim bukti berikutnya.')
    return saveOrder({
        ...tx,
        proofStatus: 'FORWARDED_TO_ADMIN',
        proofSubmittedAt: now,
        proofCount: previousCount + 1,
        proofProcessingAt: 0,
        proofProcessingToken: '',
        proofChannel: String(metadata.channel || tx.proofChannel || tx.channel || '').toLowerCase(),
        proofSubmitter: String(metadata.submitter || tx.proofSubmitter || tx.userId || '').slice(0, 100)
    })
}

function isTerminal(status) {
    return ['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'CREATE_FAILED'].includes(String(status || '').toUpperCase())
}

function normaliseStatus(rawStatus, fallback = 'WAITING_TRANSFER') {
    const value = String(rawStatus || '').trim().toUpperCase().replace(/[\s-]+/g, '_')
    if (!value) return fallback
    if (['SUCCESS', 'SUCCEEDED', 'SETTLED', 'COMPLETED', 'COMPLETE', 'DONE', 'PAID_OUT', 'PAYOUT_SUCCESS', 'SUCCESSFUL', 'BERHASIL'].includes(value)) return 'SUCCESS'
    if (['FAIL', 'FAILED', 'FAILURE', 'REJECTED', 'CANCELLED', 'CANCELED', 'REFUSED', 'GAGAL'].includes(value)) return 'FAILED'
    if (['EXPIRED', 'EXPIRE', 'TIMEOUT', 'KEDALUWARSA'].includes(value)) return 'EXPIRED'
    if (['WAITING', 'PENDING', 'UNPAID', 'CREATED', 'REQUESTED', 'WAITING_TRANSFER', 'WAITING_TRANSFER_PULSA', 'WAITING_FOR_TRANSFER', 'WAITING_OPERATOR_TRANSFER', 'WAITING_PAYMENT', 'AWAITING_TRANSFER', 'PENDING_TRANSFER', 'WAITING_PULSA'].includes(value)) return 'WAITING_TRANSFER'
    if (['RECEIVED', 'PAYMENT_RECEIVED', 'TRANSFER_RECEIVED', 'DETECTED', 'APPROVED'].includes(value)) return 'PROCESSING'
    if (['PROCESSING', 'IN_PROGRESS', 'PAYOUT_PROCESSING', 'WITHDRAWING', 'DISBURSE_PROCESSING'].includes(value)) return 'PROCESSING'
    if (['REVIEW_REQUIRED', 'MANUAL_REVIEW'].includes(value)) return 'REVIEW_REQUIRED'
    return value.slice(0, 40)
}

function providerOrderId(body) {
    return textField(body, [
        'trx_id', 'trxId', 'transaction_id', 'transactionId', 'order_id', 'orderId',
        'reference_id', 'referenceId', 'invoice_id', 'invoiceId', 'id', 'transaction.trx_id', 'order.trx_id'
    ])
}

function extractInstructions(body) {
    const receiverNumber = textField(body, [
        'center_number', 'centerNumber', 'receiver_number', 'receiverNumber', 'destination_number',
        'destinationNumber', 'target_number', 'targetNumber', 'phone_number', 'phoneNumber',
        'transfer_to', 'transferTo', 'receiver.number', 'center.number', 'destination.number'
    ])
    const ussd = textField(body, ['ussd_code', 'ussdCode', 'ussd', 'transfer_code', 'transferCode', 'code_ussd', 'instructions.ussd', 'instruction.ussd'])
    const explicitInstruction = textField(body, [
        'instruction', 'instructions', 'how_to_transfer', 'howToTransfer', 'transfer_instruction', 'transferInstruction',
        'instructions.text', 'instruction.text'
    ])
    // A root `message`, `note`, or `description` commonly says only “order created”.
    // Accept it as instruction text only when it visibly contains transfer language
    // plus a destination/code, rather than presenting a generic API status as an instruction.
    const genericText = textField(body, ['message', 'note', 'description'], '')
    const destinationCue = /center|nomor|number|destination|tujuan|recipient|transfer\s+(?:ke|to)|send\s+to|dial|ussd|kode/i.test(genericText)
    const genericHasTransferDetails = destinationCue &&
        (/(?:\*\s*[0-9*#]{3,}\s*#?)/i.test(genericText) || /\b(?:\+?62|0)\d{7,14}\b/.test(genericText) || /\b\d{4,15}\b/.test(genericText))
    return {
        receiverNumber,
        ussd,
        instructionText: explicitInstruction || (genericHasTransferDetails ? genericText : ''),
        expiredAt: textField(body, ['expired_at', 'expiredAt', 'expires_at', 'expiresAt', 'expiry', 'deadline'])
    }
}

function hasOfficialInstructions(tx) {
    if (tx?.receiverNumber || tx?.ussd) return true
    const text = String(tx?.instructionText || '')
    return Boolean(/center|nomor|number|destination|tujuan|recipient|transfer\s+(?:ke|to)|send\s+to|dial|ussd|kode/i.test(text) &&
        (/(?:\*\s*[0-9*#]{3,}\s*#?)/i.test(text) || /\b(?:\+?62|0)\d{7,14}\b/.test(text) || /\b\d{4,15}\b/.test(text)))
}

function sanitizeErrorMessage(error) {
    const value = String(error?.message || error || 'Error tidak diketahui')
    return value.replace(/(X-API-KEY\s*[:=]\s*)[^\s,;]+/ig, '$1[REDACTED]').slice(0, 500)
}

async function createOrder(input = {}) {
    const userId = String(input.userId || '').trim()
    const channel = String(input.channel || '').trim().toLowerCase()
    if (!userId || !['whatsapp', 'telegram'].includes(channel)) throw new Error('Identitas pengguna atau channel transaksi tidak valid.')
    const lockKey = `${channel}:${userId}`
    if (createInFlight.has(lockKey)) return createInFlight.get(lockKey)

    const promise = (async () => {
        if (!ready()) throw new Error('API Convert Pulsa belum dikonfigurasi. Isi API key PesanJasa terlebih dahulu.')
        const unresolved = listByUser(channel, userId, 50).find(item =>
            ['CREATING', 'REVIEW_REQUIRED'].includes(String(item.status || '').toUpperCase()) && !item.providerTrxId &&
            Date.now() - Number(item.createdAt || 0) < 24 * 60 * 60 * 1000
        )
        if (unresolved) throw new Error(`Ada transaksi ${unresolved.ref} yang hasil pembuatan order-nya belum dapat dipastikan. Jangan membuat order baru sebelum rekonsiliasi.`)
        const currentSession = getSession(channel, userId)
        if (!currentSession || currentSession.step !== 'confirm') throw new Error('Konfirmasi transaksi sudah kedaluwarsa. Mulai ulang dari menu convert pulsa.')
        if (!currentSession.operatorId || !Number.isSafeInteger(Number(currentSession.amount)) || Number(currentSession.amount) <= 0 || !currentSession.payoutMethod || !currentSession.payoutAccountNumber || !currentSession.payoutAccountName || !currentSession.senderPhoneNumber) {
            throw new Error('Data transaksi belum lengkap. Mulai ulang agar data penerima dan pengirim divalidasi ulang.')
        }
        if (currentSession.requestedAt) throw new Error('Permintaan order sudah pernah dimulai. Periksa status/riwayat sebelum mencoba lagi agar order tidak terduplikasi.')

        // Revalidate choices against a fresh provider catalogue immediately before
        // creating the transaction. This avoids submitting stale/offline operator
        // IDs or payout-method IDs after rates/methods change.
        const liveRates = await getRates()
        const liveOperator = getOperatorById(liveRates.operators, currentSession.operatorId)
        if (!liveOperator || !liveOperator.available) {
            throw new Error('Operator sudah tidak tersedia menurut kurs terbaru PesanJasa. Tidak ada order dibuat; buka kembali menu dan pilih operator yang aktif.')
        }
        const requestedAmount = Math.floor(Number(currentSession.amount))
        if ((liveOperator.minAmount != null && requestedAmount < liveOperator.minAmount) || (liveOperator.maxAmount != null && requestedAmount > liveOperator.maxAmount)) {
            throw new Error('Batas minimum/maksimum nominal berubah pada PesanJasa. Tidak ada order dibuat; mulai ulang pilihan nominal sesuai batas terbaru.')
        }
        const liveMethod = liveRates.payoutMethods.find(method => String(method.value).trim().toLowerCase() === String(currentSession.payoutMethod).trim().toLowerCase())
        if (!liveMethod) {
            throw new Error('Metode e-wallet/rekening tujuan tidak lagi tersedia pada API PesanJasa. Tidak ada order dibuat; mulai ulang dan pilih metode yang tersedia.')
        }

        // Rates can change between the estimate screen and the final click. Recalculate
        // immediately before creating the provider order. If the amount/rate/fee changed,
        // persist the new estimate and require a new explicit user confirmation.
        const freshCalculation = await calculate(liveOperator.id, requestedAmount)
        const oldEstimate = Number(currentSession.estimatedAmount)
        const newEstimate = Number(freshCalculation.estimatedAmount)
        const oldRate = currentSession.rate == null ? null : Number(currentSession.rate)
        const newRate = freshCalculation.rate == null ? null : Number(freshCalculation.rate)
        const oldFee = Number(currentSession.fee || 0)
        const newFee = Number(freshCalculation.fee || 0)
        const changedEstimate = !Number.isFinite(oldEstimate) || oldEstimate !== newEstimate ||
            oldFee !== newFee || (oldRate == null) !== (newRate == null) ||
            (oldRate != null && newRate != null && Math.abs(oldRate - newRate) > 0.000001)
        if (changedEstimate) {
            setSession(channel, userId, {
                ...currentSession,
                estimatedAmount: newEstimate,
                fee: newFee,
                rate: newRate,
                calculationAt: Date.now(),
                recheckRequired: true
            })
            const error = new Error(`Kurs/estimasi PesanJasa berubah. Estimasi terbaru: Rp${formatMoney(newEstimate)}${newRate == null ? '' : ` (kurs ${(newRate * 100).toFixed(2)}%)`}. Belum ada order dibuat; tinjau ulang data dan tekan Buat Pesanan sekali lagi.`)
            error.code = 'ESTIMATE_CHANGED'
            throw error
        }

        const localRef = makeRef()
        const tx = saveOrder({
            ref: localRef,
            channel,
            userId,
            status: 'CREATING',
            providerStatus: 'CREATING',
            providerTrxId: '',
            operatorId: String(currentSession.operatorId),
            operatorName: String(liveOperator.name || currentSession.operatorName || ''),
            amount: Math.floor(Number(currentSession.amount)),
            estimatedAmount: currentSession.estimatedAmount == null ? null : Math.floor(Number(currentSession.estimatedAmount)),
            rate: currentSession.rate == null ? null : Number(currentSession.rate),
            payoutMethod: String(currentSession.payoutMethod),
            payoutMethodLabel: String(liveMethod.label || currentSession.payoutMethodLabel || currentSession.payoutMethod),
            payoutAccountNumber: String(currentSession.payoutAccountNumber),
            payoutAccountName: String(currentSession.payoutAccountName),
            senderPhoneNumber: String(currentSession.senderPhoneNumber),
            pushname: String(input.pushname || ''),
            createdAt: Date.now(),
            lastCheckedAt: 0,
            lastNotifiedStatus: 'CREATING'
        })
        // Durable lock is persisted before the outbound POST. A restart or client
        // timeout must never blindly issue a second paid order.
        setSession(channel, userId, { ...currentSession, requestedAt: Date.now(), localRef })

        let providerAccepted = false
        try {
            const body = {
                operator_id: tx.operatorId,
                pulsa_amount: tx.amount,
                payout_method: tx.payoutMethod,
                payout_account_number: tx.payoutAccountNumber,
                payout_account_name: tx.payoutAccountName,
                sender_phone_number: tx.senderPhoneNumber
            }
            const raw = await request('POST', '/orders', body)
            // From this point on the provider returned HTTP 2xx. Any parsing or
            // persistence error is ambiguous and must never be treated as a clean rejection.
            providerAccepted = true
            const responseBody = unwrap(raw)
            const id = providerOrderId(responseBody) || providerOrderId(raw)
            const instructions = extractInstructions(responseBody)
            const statusRaw = textField(responseBody, ['status', 'state', 'transaction_status', 'transactionStatus', 'order_status', 'orderStatus'], 'WAITING_TRANSFER')
            let status = normaliseStatus(statusRaw, 'WAITING_TRANSFER')
            if (!id) {
                status = 'REVIEW_REQUIRED'
                const updated = saveOrder({ ...tx, status, providerStatus: statusRaw, responseShapeError: 'Provider returned no transaction reference', reviewRequired: true, instructionText: '' })
                clearSession(channel, userId)
                return updated
            }
            const updated = saveOrder({
                ...tx,
                providerTrxId: id,
                status,
                providerStatus: statusRaw,
                receiverNumber: instructions.receiverNumber,
                ussd: instructions.ussd,
                instructionText: instructions.instructionText,
                providerExpiredAt: instructions.expiredAt || '',
                providerCreatedAt: Date.now(),
                responseReceivedAt: Date.now()
            })
            clearSession(channel, userId)
            return updated
        } catch (error) {
            const message = sanitizeErrorMessage(error)
            const latest = findOrder(localRef) || tx
            // If the request reached the provider but its response was lost, an
            // automatic retry can duplicate an order. Fail closed and reconcile.
            const nextStatus = (error?.ambiguous || providerAccepted) ? 'REVIEW_REQUIRED' : 'CREATE_FAILED'
            let updated
            try {
                updated = saveOrder({ ...latest, status: nextStatus, providerStatus: nextStatus, reviewRequired: nextStatus === 'REVIEW_REQUIRED', createError: message, errorAt: Date.now() })
            } catch (dbError) {
                // The durable CREATING intent was written before POST. Never clear
                // its session lock if its final state cannot be persisted.
                const detail = `${message}; database tidak dapat menyimpan status akhir (${sanitizeErrorMessage(dbError)}).`
                throw Object.assign(new Error(`${detail} Referensi lokal: ${localRef}. Jangan membuat order baru atau mengirim pulsa; status harus direkonsiliasi.`), { localRef, ambiguous: true })
            }
            if (nextStatus === 'CREATE_FAILED') clearSession(channel, userId)
            throw Object.assign(new Error(`${message}\nReferensi lokal: ${updated.ref}. ${nextStatus === 'REVIEW_REQUIRED' ? 'Jangan membuat order ulang; periksa riwayat/API PesanJasa dan hubungi owner untuk rekonsiliasi.' : 'Pesanan ditolak sebelum dapat dipastikan terbentuk; bila mencoba ulang, periksa riwayat dahulu.'}`), { localRef: updated.ref, ambiguous: nextStatus === 'REVIEW_REQUIRED' })
        }
    })().finally(() => createInFlight.delete(lockKey))
    createInFlight.set(lockKey, promise)
    return promise
}

async function refresh(ref, requester = {}) {
    const key = String(ref || '').trim().toUpperCase()
    if (refreshInFlight.has(key)) return refreshInFlight.get(key)
    const promise = (async () => {
        const tx = findOrder(key)
        if (!tx) throw new Error('Referensi convert pulsa tidak ditemukan.')
        if (requester.channel && tx.channel !== requester.channel) throw new Error('Transaksi ini bukan milik channel akun kamu.')
        if (requester.userId && tx.userId !== String(requester.userId)) throw new Error('Transaksi ini bukan milik akun kamu.')
        if (!tx.providerTrxId) {
            if (tx.status === 'REVIEW_REQUIRED') throw new Error('Referensi provider belum tersedia. Status perlu rekonsiliasi; jangan buat order baru atau mengirim pulsa.')
            return tx
        }
        const raw = await request('GET', `/orders/${encodeURIComponent(tx.providerTrxId)}`)
        const body = unwrap(raw)
        const statusRaw = textField(body, ['status', 'state', 'transaction_status', 'transactionStatus', 'order_status', 'orderStatus', 'payout_status', 'payoutStatus'], tx.providerStatus || tx.status)
        const status = normaliseStatus(statusRaw, tx.status)
        const instructions = extractInstructions(body)
        const updated = saveOrder({
            ...tx,
            status,
            providerStatus: statusRaw,
            receiverNumber: instructions.receiverNumber || tx.receiverNumber || '',
            ussd: instructions.ussd || tx.ussd || '',
            instructionText: instructions.instructionText || tx.instructionText || '',
            providerExpiredAt: instructions.expiredAt || tx.providerExpiredAt || '',
            lastCheckedAt: Date.now(),
            lastCheckError: ''
        })
        if (updated.status !== tx.status) await notifyStatus(updated, tx.status).catch(error => console.error('[CONVERT PULSA NOTIFIER]', error?.message || error))
        return updated
    })().finally(() => refreshInFlight.delete(key))
    refreshInFlight.set(key, promise)
    return promise
}

async function notifyStatus(tx, previousStatus = '') {
    if (!notifier || !tx) return
    try { await notifier({ ...tx }, String(previousStatus || '')) }
    catch (error) { console.error('[CONVERT PULSA NOTIFY]', error?.message || error) }
}

function setNotifier(fn) {
    notifier = typeof fn === 'function' ? fn : null
}

function listByUser(channel, userId, limit = 10) {
    return Object.values(db().transactions)
        .filter(tx => tx && tx.channel === String(channel || '').toLowerCase() && tx.userId === String(userId || ''))
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
        .map(tx => ({ ...tx }))
}

function startPoller() {
    if (poller) return poller
    poller = setInterval(async () => {
        if (!ready() || pollRunning) return
        pollRunning = true
        try {
            const pending = Object.values(db().transactions).filter(tx => tx && tx.providerTrxId && !isTerminal(tx.status) && tx.status !== 'REVIEW_REQUIRED')
            for (const tx of pending) {
                try {
                    // A failed check is not a status transition. Keep prior state intact.
                    await refresh(tx.ref)
                } catch (error) {
                    const latest = findOrder(tx.ref)
                    if (latest) {
                        try { saveOrder({ ...latest, lastCheckError: sanitizeErrorMessage(error), lastCheckErrorAt: Date.now() }) } catch {}
                    }
                    console.error('[CONVERT PULSA POLL]', tx.ref, error?.message || error)
                }
            }
        } finally {
            pollRunning = false
        }
    }, config().pollIntervalMs)
    if (typeof poller.unref === 'function') poller.unref()
    return poller
}

module.exports = {
    ready,
    config,
    formatMoney,
    amountValue,
    getRates,
    calculate,
    parseOperators,
    parsePayoutMethods,
    getOperatorById,
    getSession,
    setSession,
    clearSession,
    createOrder,
    refresh,
    findOrder,
    claimProof,
    releaseProofClaim,
    recordProof,
    listByUser,
    setNotifier,
    startPoller,
    normaliseStatus,
    isTerminal,
    extractInstructions,
    hasOfficialInstructions,
    canSubmitProof: proofEligible
}
