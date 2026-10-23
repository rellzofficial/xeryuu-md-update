'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const axios = require('axios')

const DB_DIR = path.join(__dirname, 'database')
const CACHE_FILE = path.join(DB_DIR, 'topup-products.json')
const TX_FILE = path.join(DB_DIR, 'topup-transactions.json')

function cfg() {
    return global.topupConfig || {}
}

function apiId() {
    const value = String(cfg().apiId || '').trim()
    return value && !['-', 'null', 'undefined'].includes(value) ? value : String(cfg().apiId || '').trim()
}

function apiKey() {
    const value = String(cfg().apiKey || '').trim()
    return value && !['-', 'null', 'undefined'].includes(value) ? value : String(cfg().apiKey || '').trim()
}

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return fallback
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(data, null, 2))
    fs.renameSync(temp, file)
}

function formatMoney(n) {
    return Number(n || 0).toLocaleString('id-ID')
}

function makeRef(prefix = 'TP') {
    return `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`
}

function sign() {
    return crypto
        .createHash('md5')
        .update(apiId() + apiKey())
        .digest('hex')
}

function ready() {
    return Boolean(
        cfg().enabled !== false &&
        apiId() &&
        apiKey() &&
        apiId() !== '-' &&
        apiKey() !== '-'
    )
}

function baseUrl() {
    return String(cfg().baseUrl || 'https://vip-reseller.co.id/api').replace(/\/$/, '')
}

function explainProviderError(message) {
    const text = String(message || '').trim()
    if (!text) return 'VIPayment menolak request.'

    const ip = text.match(/IP\s+([0-9.]+)\s+tidak\s+diizinkan/i)?.[1]
    if (ip) {
        return `VIPayment menolak IP server ${ip}. Tambahkan IP tersebut ke whitelist/izin API VIPayment pada akun kamu, lalu restart bot.`
    }

    return text
}

async function request(type, extra = {}) {
    if (!ready()) throw new Error('API VIPayment belum dikonfigurasi di settings.js.')

    const payload = {
        key: apiKey(),
        sign: sign(),
        type,
        ...extra
    }

    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined && value !== null && value !== '') body.set(key, String(value))
    }

    let res
    try {
        res = await axios.post(
            baseUrl() + '/game-feature',
            body.toString(),
            {
                timeout: Number(cfg().timeout || 20000),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        )
    } catch (error) {
        const providerMessage =
            error?.response?.data?.message ||
            error?.response?.data?.error ||
            error?.message
        const wrapped = new Error(explainProviderError(providerMessage || 'Gagal terhubung ke VIPayment.'))
        wrapped.status = Number(error?.response?.status || 0) || null
        wrapped.responseReceived = Boolean(error?.response)
        wrapped.uncertain = !error?.response
        wrapped.cause = error
        throw wrapped
    }

    if (!res.data?.result) {
        const error = new Error(explainProviderError(res.data?.message || 'VIPayment menolak request.'))
        error.status = Number(res.status || 200)
        error.providerRejected = true
        error.definiteFailure = true
        error.responseReceived = true
        throw error
    }

    return res.data
}

async function diagnose() {
    if (!ready()) throw new Error('VIPayment API belum dikonfigurasi.')
    let res
    try {
        res = await axios.post(
            String(cfg().profileUrl || 'https://vip-reseller.co.id/api/profile').replace(/\/$/, ''),
            new URLSearchParams({ key: apiKey(), sign: sign() }).toString(),
            {
                timeout: Number(cfg().timeout || 20000),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }
        )
    } catch (error) {
        const msg = error?.response?.data?.message || error?.response?.data?.error || error?.message
        throw new Error(explainProviderError(msg || 'Gagal terhubung ke VIPayment.'))
    }
    if (!res.data?.result) throw new Error(explainProviderError(res.data?.message || 'VIPayment menolak autentikasi.'))
    return res.data.data || {}
}

function normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function gameMatches(service, game) {
    const g = normalize(game)
    const hay = normalize(`${service?.game || ''} ${service?.name || ''} ${service?.description || ''}`)

    const aliases = {
        ff: ['freefire', 'freefiremax', 'garena'],
        ml: ['mobilelegends', 'mobilelegend'],
        roblox: ['roblox']
    }

    return (aliases[g] || [g]).some(alias => hay.includes(alias))
}

function parseNominal(name) {
    const text = String(name || '').toLowerCase()

    // Prioritaskan angka yang terlihat seperti nominal/diamond.
    const nums = text.match(/\d+(?:[.,]\d+)?/g) || []
    for (const raw of nums) {
        const n = Number(raw.replace(',', '.'))
        if (Number.isFinite(n) && n > 0) return n
    }

    return null
}

function getPrice(service) {
    const level = String(cfg().priceLevel || 'basic').toLowerCase()
    const prices = service?.price || {}

    const value =
        prices[level] ??
        prices.basic ??
        prices.premium ??
        prices.special ??
        0

    return Number(value || 0)
}

function sellPrice(service) {
    const base = getPrice(service)
    const fixed = Number(cfg().markup || 0)
    const percent = Number(cfg().markupPercent || 0)
    return Math.ceil(base + fixed + (base * percent / 100))
}

function pickService(services, game, nominal) {
    const target = Number(String(nominal).replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(target) || target <= 0) return null

    const candidates = services.filter(s =>
        String(s?.status || '').toLowerCase() === 'available' &&
        gameMatches(s, game)
    )

    // Exact nominal first.
    const exact = candidates.filter(s => parseNominal(s.name) === target)
    if (exact.length) {
        return exact.sort((a, b) => getPrice(a) - getPrice(b))[0]
    }

    // Fallback: nominal text appears in product name.
    const wanted = normalize(nominal)
    return candidates.find(s => normalize(s.name).includes(wanted)) || null
}

async function refreshPriceList(force = false, game = '') {
    if (!ready()) throw new Error('API VIPayment belum dikonfigurasi di settings.js.')

    const cached = readJson(CACHE_FILE, null)
    const ttl = Number(cfg().priceCacheMs || 300000)

    if (
        !force &&
        cached?.provider === 'VIPayment' &&
        cached?.scope === 'all' &&
        cached?.updatedAt &&
        Array.isArray(cached.data) &&
        Date.now() - cached.updatedAt < ttl
    ) {
        return cached.data
    }

    const data = await request('services', {
        filter_status: 'available'
    })

    if (!Array.isArray(data?.data)) {
        throw new Error('Daftar layanan VIPayment tidak valid.')
    }

    const normalized = data.data.filter(item => {
        const status = String(item?.status || '').toLowerCase()
        return !status || status === 'available'
    })

    writeJson(CACHE_FILE, {
        provider: 'VIPayment',
        scope: 'all',
        updatedAt: Date.now(),
        data: normalized
    })

    return normalized
}

function loadTransactions() {
    return readJson(TX_FILE, {})
}

function saveTransactions(data) {
    writeJson(TX_FILE, data)
}

function getTransaction(ref) {
    const key = String(ref || '').trim()
    const all = loadTransactions()
    if (all[key]) return all[key]
    const upper = key.toUpperCase()
    if (all[upper]) return all[upper]
    return Object.values(all).find(tx => [tx?.ref, tx?.localRef, tx?.providerRef].some(value => String(value || '').toUpperCase() === upper)) || null
}

function setTransaction(tx) {
    const all = loadTransactions()
    const key = String(tx.ref || tx.localRef || '').trim()
    if (!key) throw new Error('Ref transaksi VIPayment kosong; transaksi tidak disimpan.')
    const localRef = String(tx.localRef || '').trim()
    if (localRef && localRef !== key && all[localRef]?.localRef === localRef) delete all[localRef]
    all[key] = tx
    saveTransactions(all)
    return tx
}

function updateTransaction(ref, patch = {}) {
    const old = getTransaction(ref)
    if (!old) return null
    const next = { ...old, ...patch, updatedAt: Date.now() }
    return setTransaction(next)
}

function mapStatus(status) {
    const s = String(status || '').toLowerCase()

    if (s === 'success' || s === 'sukses') return 'Sukses'
    if (s === 'error' || s === 'failed' || s === 'gagal') return 'Gagal'
    if (s === 'processing') return 'Processing'
    if (s === 'waiting' || s === 'pending') return 'Pending'

    return status || 'Unknown'
}

async function create({ game, customerNo, zone, nominal, jid, serviceCode = '', expectedSellingPrice = null, purchaseToken = '' }) {
    if (!ready()) throw new Error('API VIPayment belum dikonfigurasi.')
    const services = await refreshPriceList(false, game)
    let service = serviceCode
        ? services.find(item => String(item?.code || '').trim() === String(serviceCode).trim())
        : null
    if (service && String(service.status || '').toLowerCase() && String(service.status || '').toLowerCase() !== 'available') service = null
    if (!service) service = pickService(services, game, nominal)

    if (!service) {
        throw new Error(`Produk ${String(game).toUpperCase()} nominal ${nominal} tidak ditemukan di layanan VIPayment.`)
    }

    const sellingPrice = sellPrice(service)
    if (expectedSellingPrice != null && Number(expectedSellingPrice) !== sellingPrice) {
        const error = new Error(`Harga produk berubah. Harga sebelumnya Rp${formatMoney(expectedSellingPrice)}, harga terbaru Rp${formatMoney(sellingPrice)}. Silakan ulangi konfirmasi.`)
        error.definiteFailure = true
        throw error
    }

    const localRef = makeRef('TP')
    const initial = {
        ref: localRef, localRef, providerRef: '', provider: 'VIPayment', jid,
        game, customerNo: String(customerNo), zone: zone ? String(zone) : '',
        nominal: String(nominal), serviceCode: service.code, productName: service.name,
        providerPrice: getPrice(service), sellingPrice, status: 'Membuat', providerStatus: '',
        message: 'Permintaan sedang dikirim ke VIPayment.', sn: '', rc: '',
        purchaseToken: String(purchaseToken || ''), providerCallStartedAt: Date.now(),
        createdAt: Date.now(), updatedAt: Date.now(), charged: false, refunded: false
    }
    setTransaction(initial)

    const payload = {
        service: service.code,
        data_no: String(customerNo),
        ...(zone ? { data_zone: String(zone) } : {})
    }

    let response
    try {
        response = await request('order', payload)
    } catch (err) {
        const current = getTransaction(localRef) || initial
        // A timeout, connection loss, 409/429, or 5xx can happen after the upstream
        // accepted the order. Only an explicit provider rejection or a clear client
        // validation/auth/route response is safe to classify as a failed purchase.
        const statusCode = Number(err?.status || err?.response?.status || 0)
        const definitelyRejected = Boolean(err?.providerRejected || err?.definiteFailure) || [400, 401, 403, 404, 405, 422].includes(statusCode)
        const uncertain = !definitelyRejected
        updateTransaction(localRef, {
            status: uncertain ? 'Verifikasi' : 'Gagal',
            providerStatus: uncertain ? 'UNKNOWN' : 'REJECTED',
            message: String(err?.message || err),
            uncertain,
            providerRejected: Boolean(err?.providerRejected || err?.definiteFailure || definitelyRejected),
            updatedAt: Date.now()
        })
        err.localRef = localRef
        err.transaction = getTransaction(localRef) || current
        err.definiteFailure = definitelyRejected
        err.uncertain = uncertain
        throw err
    }

    const data = response?.data && typeof response.data === 'object'
        ? response.data
        : (response?.result && typeof response.result === 'object' ? response.result : (response || {}))
    const providerRef = String(data.trxid || data.trx_id || data.transaction_id || '')
    const rawStatus = String(data.status || '').trim()
    const status = mapStatus(rawStatus)
    const tx = {
        ...initial,
        ...data,
        ref: providerRef,
        localRef,
        providerRef: providerRef || '',
        provider: 'VIPayment',
        jid,
        game,
        customerNo: String(customerNo),
        zone: zone ? String(zone) : '',
        nominal: String(nominal),
        serviceCode: service.code,
        productName: service.name,
        providerPrice: Number(data.price || getPrice(service)),
        sellingPrice,
        status,
        providerStatus: rawStatus || '',
        message: data.note || response?.message || '',
        sn: data.note || '',
        rc: '',
        purchaseToken: String(purchaseToken || ''),
        createdAt: initial.createdAt,
        updatedAt: Date.now(),
        charged: false,
        refunded: false,
        uncertain: false
    }
    // HTTP 200 alone is not proof of an order. Without a provider transaction
    // ID and a recognized state, persist the uncertain transaction for review;
    // never quietly report success or issue a replacement order.
    const knownStatus = ['Sukses', 'Gagal', 'Processing', 'Pending'].includes(String(status))
    if (!providerRef || !knownStatus) {
        tx.ref = providerRef || localRef
        tx.providerRef = providerRef
        tx.status = 'Verifikasi'
        tx.uncertain = true
        tx.message = !providerRef
            ? 'VIPayment memberi respons tanpa ID transaksi provider. Perlu rekonsiliasi manual; jangan membuat order ulang.'
            : `VIPayment memberi status yang tidak dikenal: ${rawStatus || '(kosong)'}. Perlu rekonsiliasi manual; jangan membuat order ulang.`
        setTransaction(tx)
        const error = new Error(tx.message)
        error.uncertain = true
        error.localRef = localRef
        error.transaction = tx
        throw error
    }
    tx.ref = providerRef
    tx.providerRef = providerRef
    try {
        setTransaction(tx)
    } catch (persistError) {
        const error = new Error(`VIPayment mengembalikan transaksi ${providerRef}, tetapi penyimpanan lokal gagal. Jangan membuat order ulang; owner perlu merekonsiliasi provider. (${persistError?.message || persistError})`)
        error.uncertain = true
        error.localRef = localRef
        error.providerRef = providerRef
        error.transaction = getTransaction(localRef) || initial
        error.cause = persistError
        throw error
    }
    return tx
}

async function status(ref) {
    const tx = getTransaction(ref)
    if (!tx) throw new Error('Transaksi tidak ditemukan.')

    let raw
    if (!tx.providerRef && String(tx.status || '').toLowerCase() === 'verifikasi') {
        // When a network timeout happened, do not create another purchase. Try
        // to reconcile it from VIPayment's status list only if exactly one match
        // exists for the same destination/service.
        const response = await request('status', { limit: 100 })
        const rows = Array.isArray(response?.data) ? response.data : (response?.data ? [response.data] : [])
        const startedAt = Number(tx.providerCallStartedAt || tx.createdAt || 0)
        const since = startedAt ? startedAt - 120000 : 0
        const timestampMs = value => {
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                return value < 1e12 ? value * 1000 : value
            }
            const raw = String(value || '').trim()
            if (!raw) return 0
            if (/^\d{10,13}$/.test(raw)) {
                const n = Number(raw)
                return raw.length <= 10 ? n * 1000 : n
            }
            const parsed = Date.parse(raw)
            return Number.isFinite(parsed) ? parsed : 0
        }
        const matches = rows.filter(item => {
            const sameTarget = String(item?.data ?? item?.data_no ?? '') === String(tx.customerNo || '')
            const sameZone = String(item?.zone ?? item?.data_zone ?? '') === String(tx.zone || '')
            const returnedCode = normalize(item?.service_code ?? item?.code ?? '')
            const expectedCode = normalize(tx.serviceCode || '')
            const returnedName = normalize(item?.service ?? item?.service_name ?? '')
            const expectedName = normalize(tx.productName || '')
            // VIPayment's documented status response does not guarantee a timestamp
            // or a service code. Only reconcile automatically when there is a clear
            // exact service identity and a recent provider timestamp; otherwise the
            // transaction remains under review instead of matching an old purchase.
            const sameService = returnedCode && expectedCode
                ? returnedCode === expectedCode
                : Boolean(returnedName && expectedName && returnedName === expectedName)
            const stamp = timestampMs(item?.created_at || item?.createdAt || item?.timestamp || item?.date || item?.time)
            const recent = Boolean(stamp && since && stamp >= since)
            return sameTarget && sameZone && sameService && recent
        })
        if (matches.length !== 1) {
            throw new Error(matches.length
                ? 'Ditemukan lebih dari satu transaksi yang mungkin cocok. Jangan membuat order ulang; perlu pemeriksaan owner.'
                : 'Status order belum dapat dipastikan dari daftar VIPayment. Jangan membuat order ulang; minta owner memeriksa riwayat transaksi provider.')
        }
        raw = matches[0]
        tx.ref = String(raw.trxid || tx.ref)
        tx.providerRef = String(raw.trxid || '')
    } else {
        const response = await request('status', { trxid: String(tx.providerRef || tx.ref) })
        raw = Array.isArray(response?.data) ? response.data[0] : response?.data
    }

    if (!raw) throw new Error('Status transaksi VIPayment tidak ditemukan.')
    tx.status = mapStatus(raw.status)
    tx.providerStatus = raw.status || tx.providerStatus
    tx.message = raw.note || tx.message
    tx.sn = raw.note || tx.sn
    tx.updatedAt = Date.now()
    tx.uncertain = false
    setTransaction(tx)
    return tx
}

async function prices(game) {
    const services = await refreshPriceList(false, game)

    const list = game
        ? services.filter(s => gameMatches(s, game))
        : services

    return list.map(s => ({
        code: s.code,
        name: s.name,
        price: getPrice(s),
        sellingPrice: sellPrice(s),
        game: s.game,
        description: s.description || '',
        server: s.server || '',
        status: s.status || ''
    }))
}

module.exports = {
    ready,
    formatMoney,
    refreshPriceList,
    prices,
    create,
    status,
    getTransaction,
    setTransaction,
    updateTransaction,
    sellPrice,
    diagnose
}
