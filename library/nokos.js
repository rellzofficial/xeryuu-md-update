"use strict"

const fs = require("fs")
const path = require("path")
const axios = require("axios")
const economy = require("./economy.js")
const { migrateLegacyCwdDatabaseFile } = require("./global-database.js")
migrateLegacyCwdDatabaseFile("nokos-orders.json")

const DB_FILE = path.join(__dirname, "database", "nokos-orders.json")
const cache = new Map()
const inFlight = new Map()
const statusInFlight = new Map()
const orderInFlight = new Map()
let requestChain = Promise.resolve()
let lastRequestAt = 0
let authBlockedUntil = 0
let lastAuthFailureMessage = ""
let lastAuthFailureStatus = 0

function config() { return global.nokosConfig || {} }

function getRoutes() {
    const r = config().routes || {}
    return {
        countries: r.countries || "/country-v2/list",
        services: r.services || "/services-v2/list",
        price: r.price || "/cekharga-v2/info",
        order: r.order || "/order-v2/buy",
        status: r.status || "/order-v2/check-status",
        cancel: r.cancel || "/order-v2/cancel",
        resend: r.resend || "/order-v2/resend"
    }
}

function baseUrl() {
    const value = String(config().baseUrl || "").trim()
    if (!value) throw new Error("Base URL API RuangOTP belum diatur di settings.js.")
    return value.replace(/\/$/, "")
}

function getApiKey() {
    const value = String(config().apiKey || "").trim()
    return value && !["-", "null", "undefined"].includes(value) ? value : ""
}

function ready() {
    return Boolean(config().enabled !== false && baseUrl() && String(config().userId || "").trim())
}

function maskedApiKey() {
    const key = getApiKey()
    return key.length >= 8
        ? `${key.slice(0, 4)}${"*".repeat(Math.max(0, key.length - 8))}${key.slice(-4)}`
        : key ? "****" : "(kosong)"
}

function headers(extra = {}) {
    const userId = String(config().userId || "").trim()
    const key = getApiKey()
    return {
        ...(userId ? { "x-user-id": userId } : {}),
        ...(config().sendApiKeyHeader && key ? { "X-API-Key": key } : {}),
        "Accept": "application/json",
        ...extra
    }
}

function money(n) { return Number(n || 0).toLocaleString("id-ID") }

function sellPrice(providerCost) {
    const cost = Math.max(0, Number(providerCost || 0))
    const cfg = config()
    const fixed = Number(cfg.markup || 0)
    const percent = Number(cfg.markupPercent || 0)
    const raw = cost + fixed + (cost * Math.max(0, percent) / 100)
    return Math.max(cost, Math.ceil(raw))
}

function refundOnce(ref, reason = "refund") {
    const db = loadDb()
    const key = String(ref || "").toUpperCase()
    const order = db[key]
    if (!order) return null
    if (order.refunded) return { order, refundedNow: false, alreadyRefunded: true }
    let walletResult = null
    const amount = Math.floor(Number(order.sellingPrice || 0))
    if (order.charged && amount > 0) {
        // Use a durable idempotency key: crash/retry between wallet credit and
        // order-file update cannot credit the same order a second time.
        walletResult = economy.applyMoneyTransaction(order.jid, amount, `nokos-refund:${key}`, `NOKOS refund: ${reason}`)
    }
    const latest = { ...order, refunded: true, refundReason: reason, refundedAt: Date.now(), refundTransactionKey: order.charged && amount > 0 ? `nokos-refund:${key}` : null, updatedAt: Date.now() }
    db[key] = latest
    saveDb(db)
    return { order: latest, refundedNow: Boolean(walletResult?.applied), alreadyCredited: Boolean(walletResult?.duplicate) }
}

function makeRef() {
    return `NOK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

function ensureDb() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}")
}

function loadDb() {
    ensureDb()
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
        return data && typeof data === "object" && !Array.isArray(data) ? data : {}
    } catch {
        return {}
    }
}

function saveDb(data) {
    ensureDb()
    const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, DB_FILE)
}

function unwrap(body) {
    if (body == null) return body
    if (Array.isArray(body)) return body
    if (typeof body !== "object") return body
    if (body.data !== undefined && body.data !== null) return body.data
    if (body.result !== undefined && body.result !== null) return body.result
    if (body.response !== undefined && body.response !== null) return body.response
    return body
}

function firstDefined(obj, keys, fallback = undefined) {
    for (const key of keys) {
        const value = key.split(".").reduce((acc, part) => acc == null ? undefined : acc[part], obj)
        if (value !== undefined && value !== null && value !== "") return value
    }
    return fallback
}

function numeric(value) {
    if (typeof value === "string") {
        const cleaned = value.replace(/rp\.?/ig, "").replace(/[^0-9,.-]/g, "").trim()
        if (cleaned.includes(",") && cleaned.includes(".")) {
            value = cleaned.replace(/\./g, "").replace(/,/g, ".")
        } else if (/^\d{1,3}(?:\.\d{3})+$/.test(cleaned)) {
            value = cleaned.replace(/\./g, "")
        } else if (cleaned.includes(",")) {
            value = cleaned.replace(/,/g, ".")
        } else {
            value = cleaned
        }
    }
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function normalizeList(value) {
    if (Array.isArray(value)) return value
    if (!value || typeof value !== "object") return []
    for (const key of ["items", "list", "rows", "countries", "services", "data", "results"]) {
        if (Array.isArray(value[key])) return value[key]
    }
    return Object.entries(value).map(([key, item]) => {
        if (item && typeof item === "object" && !Array.isArray(item)) return { _key: key, ...item }
        return { _key: key, value: item }
    })
}

const COUNTRY_ISO_ALIASES = {
    afghanistan: 'AF', albania: 'AL', algeria: 'DZ', andorra: 'AD', angola: 'AO',
    antiguaandbarbuda: 'AG', argentina: 'AR', armenia: 'AM', australia: 'AU', austria: 'AT',
    azerbaijan: 'AZ', bahamas: 'BS', bahrain: 'BH', bangladesh: 'BD', barbados: 'BB',
    belarus: 'BY', belgium: 'BE', belize: 'BZ', benin: 'BJ', bhutan: 'BT', bolivia: 'BO',
    bosniaandherzegovina: 'BA', bosniaherzegovina: 'BA', botswana: 'BW', brazil: 'BR',
    brunei: 'BN', bulgaria: 'BG', burkinafaso: 'BF', burundi: 'BI', cambodia: 'KH',
    cameroon: 'CM', canada: 'CA', capeverde: 'CV', centralafricanrepublic: 'CF', chad: 'TD',
    chile: 'CL', china: 'CN', cina: 'CN', tiongkok: 'CN', colombia: 'CO', comoros: 'KM', costarica: 'CR', croatia: 'HR',
    cuba: 'CU', cyprus: 'CY', czechrepublic: 'CZ', czechia: 'CZ', denmark: 'DK', djibouti: 'DJ',
    dominica: 'DM', dominicanrepublic: 'DO', ecuador: 'EC', egypt: 'EG', elsalvador: 'SV',
    equatorialguinea: 'GQ', eritrea: 'ER', estonia: 'EE', ethiopia: 'ET', fiji: 'FJ', finland: 'FI',
    france: 'FR', gabon: 'GA', gambia: 'GM', georgia: 'GE', germany: 'DE', ghana: 'GH', greece: 'GR',
    grenada: 'GD', guatemala: 'GT', guinea: 'GN', guineabissau: 'GW', guyana: 'GY', haiti: 'HT',
    honduras: 'HN', hongkong: 'HK', hungary: 'HU', iceland: 'IS', india: 'IN', indonesia: 'ID',
    iran: 'IR', iraq: 'IQ', ireland: 'IE', israel: 'IL', italy: 'IT', jamaica: 'JM', japan: 'JP',
    jordan: 'JO', kazakhstan: 'KZ', kenya: 'KE', kiribati: 'KI', kuwait: 'KW', kyrgyzstan: 'KG',
    laos: 'LA', latvia: 'LV', lebanon: 'LB', lesotho: 'LS', liberia: 'LR', libya: 'LY',
    liechtenstein: 'LI', lithuania: 'LT', luxembourg: 'LU', macau: 'MO', madagascar: 'MG', malawi: 'MW',
    malaysia: 'MY', maldives: 'MV', mali: 'ML', malta: 'MT', mauritania: 'MR', mauritius: 'MU',
    mexico: 'MX', moldova: 'MD', monaco: 'MC', mongolia: 'MN', montenegro: 'ME', morocco: 'MA',
    mozambique: 'MZ', myanmar: 'MM', namibia: 'NA', nepal: 'NP', netherlands: 'NL', newzealand: 'NZ',
    nicaragua: 'NI', niger: 'NE', nigeria: 'NG', northkorea: 'KP', northmacedonia: 'MK', norway: 'NO',
    oman: 'OM', pakistan: 'PK', panama: 'PA', papuanewguinea: 'PG', paraguay: 'PY', peru: 'PE',
    philippines: 'PH', poland: 'PL', portugal: 'PT', puertorico: 'PR', puertorico: 'PR', qatar: 'QA',
    romania: 'RO', russia: 'RU', rwanda: 'RW', samoa: 'WS', sanmarino: 'SM', saudiarabia: 'SA',
    senegal: 'SN', serbia: 'RS', seychelles: 'SC', sierraleone: 'SL', singapore: 'SG', slovakia: 'SK',
    slovenia: 'SI', somalia: 'SO', southafrica: 'ZA', southkorea: 'KR', southsudan: 'SS', spain: 'ES',
    srilanka: 'LK', sudan: 'SD', suriname: 'SR', swaziland: 'SZ', eswatini: 'SZ', sweden: 'SE',
    switzerland: 'CH', syria: 'SY', taiwan: 'TW', tajikistan: 'TJ', tanzania: 'TZ', thailand: 'TH',
    togo: 'TG', tonga: 'TO', trinidadandtobago: 'TT', tunisia: 'TN', turkey: 'TR', turkmenistan: 'TM',
    uganda: 'UG', ukraine: 'UA', unitedarabemirates: 'AE', unitedkingdom: 'GB', uk: 'GB',
    unitedstates: 'US', unitedstatesofamerica: 'US', usa: 'US', amerika: 'US', amerikasarikat: 'US',
    unitedkingdom: 'GB', inggris: 'GB', britania: 'GB',
    uruguay: 'UY', uzbekistan: 'UZ',
    vanuatu: 'VU', vatican: 'VA', venezuela: 'VE', vietnam: 'VN', yemen: 'YE', zambia: 'ZM', zimbabwe: 'ZW'
}

const COUNTRY_PREFIX_ISO = {
    '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL', '32': 'BE', '33': 'FR', '34': 'ES', '36': 'HU',
    '39': 'IT', '40': 'RO', '41': 'CH', '43': 'AT', '44': 'GB', '45': 'DK', '46': 'SE', '47': 'NO',
    '48': 'PL', '49': 'DE', '51': 'PE', '52': 'MX', '53': 'CU', '54': 'AR', '55': 'BR', '56': 'CL',
    '57': 'CO', '58': 'VE', '60': 'MY', '61': 'AU', '62': 'ID', '63': 'PH', '64': 'NZ', '65': 'SG',
    '66': 'TH', '81': 'JP', '82': 'KR', '84': 'VN', '86': 'CN', '90': 'TR', '91': 'IN', '92': 'PK',
    '93': 'AF', '94': 'LK', '95': 'MM', '98': 'IR', '211': 'SS', '212': 'MA', '213': 'DZ', '216': 'TN',
    '218': 'LY', '220': 'GM', '221': 'SN', '222': 'MR', '223': 'ML', '224': 'GN', '225': 'CI', '226': 'BF',
    '227': 'NE', '228': 'TG', '229': 'BJ', '230': 'MU', '231': 'LR', '232': 'SL', '233': 'GH', '234': 'NG',
    '235': 'TD', '236': 'CF', '237': 'CM', '238': 'CV', '239': 'ST', '240': 'GQ', '241': 'GA', '242': 'CG',
    '243': 'CD', '244': 'AO', '245': 'GW', '246': 'IO', '248': 'SC', '249': 'SD', '250': 'RW', '251': 'ET',
    '252': 'SO', '253': 'DJ', '254': 'KE', '255': 'TZ', '256': 'UG', '257': 'BI', '258': 'MZ', '260': 'ZM',
    '261': 'MG', '262': 'RE', '263': 'ZW', '264': 'NA', '265': 'MW', '266': 'LS', '267': 'BW', '268': 'SZ',
    '269': 'KM', '290': 'SH', '291': 'ER', '297': 'AW', '298': 'FO', '299': 'GL', '350': 'GI', '351': 'PT',
    '352': 'LU', '353': 'IE', '354': 'IS', '355': 'AL', '356': 'MT', '357': 'CY', '358': 'FI', '359': 'BG',
    '370': 'LT', '371': 'LV', '372': 'EE', '373': 'MD', '374': 'AM', '375': 'BY', '376': 'AD', '377': 'MC',
    '378': 'SM', '380': 'UA', '381': 'RS', '382': 'ME', '383': 'XK', '385': 'HR', '386': 'SI', '387': 'BA',
    '389': 'MK', '420': 'CZ', '421': 'SK', '423': 'LI', '500': 'FK', '501': 'BZ', '502': 'GT', '503': 'SV',
    '504': 'HN', '505': 'NI', '506': 'CR', '507': 'PA', '508': 'PM', '509': 'HT', '590': 'GP', '591': 'BO',
    '592': 'GY', '593': 'EC', '594': 'GF', '595': 'PY', '596': 'MQ', '597': 'SR', '598': 'UY', '599': 'CW',
    '670': 'TL', '672': 'AQ', '673': 'BN', '674': 'NR', '675': 'PG', '676': 'TO', '677': 'SB', '678': 'VU',
    '679': 'FJ', '680': 'PW', '685': 'WS', '686': 'KI', '687': 'NC', '688': 'TV', '689': 'PF', '690': 'TK',
    '691': 'FM', '692': 'MH', '850': 'KP', '852': 'HK', '853': 'MO', '855': 'KH', '856': 'LA', '880': 'BD',
    '960': 'MV', '961': 'LB', '962': 'JO', '963': 'SY', '964': 'IQ', '965': 'KW', '966': 'SA', '967': 'YE',
    '968': 'OM', '970': 'PS', '971': 'AE', '972': 'IL', '973': 'BH', '974': 'QA', '975': 'BT', '976': 'MN',
    '977': 'NP', '992': 'TJ', '993': 'TM', '994': 'AZ', '995': 'GE', '996': 'KG', '998': 'UZ'
}

function normalizeCountryKey(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
}

function isoToFlag(iso2) {
    const code = String(iso2 || '').trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(code)) return ''
    return [...code].map(ch => String.fromCodePoint(127397 + ch.charCodeAt(0))).join('')
}

function countryIso2(name = '', prefix = '', raw = {}) {
    const explicit = firstDefined(raw, ['iso2', 'iso', 'country_code', 'countryCode', 'alpha2', 'alpha_2', 'code_iso2', 'iso_code'], '')
    if (/^[A-Za-z]{2}$/.test(String(explicit || '').trim())) return String(explicit).trim().toUpperCase()

    const normalized = normalizeCountryKey(name)
    if (COUNTRY_ISO_ALIASES[normalized]) return COUNTRY_ISO_ALIASES[normalized]

    const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean)
    if (tokens.length) {
        const compact = tokens.join('')
        if (COUNTRY_ISO_ALIASES[compact]) return COUNTRY_ISO_ALIASES[compact]
    }

    const digits = String(prefix || '').replace(/\D/g, '')
    if (digits && COUNTRY_PREFIX_ISO[digits]) return COUNTRY_PREFIX_ISO[digits]
    return ''
}

function countryFlag(name = '', prefix = '', raw = {}) {
    return isoToFlag(countryIso2(name, prefix, raw)) || String(firstDefined(raw, ['flag', 'emoji', 'country_flag'], '') || '').trim() || '🏳️'
}

function normalizeCountry(item) {
    const raw = item || {}
    const idValue = firstDefined(raw, ["id", "country_id", "countryId", "code", "value", "_key"])
    const id = numeric(idValue)
    const name = String(firstDefined(raw, ["name", "country_name", "countryName", "title", "label", "country"], "")).trim()
    const prefix = String(firstDefined(raw, ["prefix", "phone_prefix", "calling_code", "dial_code", "code_phone"], "")).trim()
    const iso2 = countryIso2(name, prefix, raw)
    const flag = countryFlag(name, prefix, raw)
    return { id, name, prefix, iso2, flag, raw }
}

function normalizeService(item) {
    const raw = item || {}
    const code = String(firstDefined(raw, ["code", "service", "service_code", "serviceId", "service_id", "id", "_key"], "")).trim()
    const name = String(firstDefined(raw, ["name", "service_name", "serviceName", "title", "label", "code"], code)).trim()
    const id = firstDefined(raw, ["id", "service_id", "serviceId", "code"], null)
    return { code, name, id: id == null ? null : String(id), raw }
}

function normalizeProvider(item, index = 0) {
    const raw = item || {}
    const providerId = firstDefined(raw, ["provider_id", "providerId", "id", "code", "_key"], null)
    const provider = firstDefined(raw, ["provider", "provider_name", "providerName", "name", "label", "operator"], providerId || `provider-${index + 1}`)
    const cost = numeric(firstDefined(raw, [
        "cost_idr", "provider_cost", "provider_price", "price_provider", "harga_provider",
        "modal", "cost", "price", "harga", "amount", "rate", "sell_price",
        "selling_price", "sellingPrice", "price_idr", "priceIdr"
    ]))
    const stock = numeric(firstDefined(raw, ["stock", "stok", "count", "quantity", "available", "qty", "total_stock", "totalStock"]))
    return {
        provider: String(provider),
        providerId: providerId == null ? null : String(providerId),
        cost: cost == null ? 0 : Math.max(0, cost),
        stock,
        raw
    }
}

function collectProviderCandidates(body) {
    const root = unwrap(body)
    const out = []
    const seen = new Set()
    const priceKeys = [
        "cost_idr", "provider_cost", "provider_price", "price_provider", "harga_provider",
        "modal", "cost", "price", "harga", "amount", "rate", "sell_price",
        "selling_price", "sellingPrice", "price_idr", "priceIdr"
    ]
    const hasPrice = (obj) => obj && typeof obj === "object" && priceKeys.some(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== "")
    const push = (item, fallbackKey = "") => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return
        const prepared = fallbackKey && item._key == null ? { _key: fallbackKey, ...item } : item
        const p = normalizeProvider(prepared, out.length)
        if (p.cost <= 0 && !p.providerId && !p.raw.provider && !p.raw.name && !hasPrice(prepared)) return
        const key = `${p.providerId || p.provider}:${p.cost}:${p.stock == null ? "?" : p.stock}`
        if (seen.has(key)) return
        seen.add(key)
        out.push(p)
    }
    const walk = (value, depth = 0, fallbackKey = "") => {
        if (depth > 5 || value == null) return
        if (Array.isArray(value)) {
            value.forEach((v, i) => walk(v, depth + 1, String(i)))
            return
        }
        if (typeof value !== "object") return
        if (hasPrice(value) || value.provider || value.provider_id || value.providerId || value.operator || value.operator_id) {
            push(value, fallbackKey)
        }
        for (const [key, child] of Object.entries(value)) {
            if (child && typeof child === "object") walk(child, depth + 1, key)
        }
    }
    walk(root)
    return out
}

function serviceMatches(requested, item) {
    const q = String(requested || "").trim().toLowerCase()
    if (!q) return false
    const vals = [item?.code, item?.id, item?.name, item?.raw?.service, item?.raw?.service_code, item?.raw?.service_id, item?.raw?.name]
        .filter(v => v !== undefined && v !== null).map(v => String(v).trim().toLowerCase())
    if (vals.includes(q)) return true
    if (q === "wa" || q === "whatsapp") return vals.some(v => /(^|[^a-z])whatsapp([^a-z]|$)|(^|[^a-z])wa([^a-z]|$)/i.test(v))
    return false
}

async function resolveServiceCandidates(service, country) {
    const requested = String(service || "").trim()
    const out = [requested]
    try {
        const list = await services(country)
        const matches = list.filter(item => serviceMatches(requested, item))
        for (const item of matches) {
            for (const value of [item.code, item.id, item.raw?.service, item.raw?.service_code, item.raw?.service_id]) {
                if (value !== undefined && value !== null && String(value).trim() && !out.includes(String(value).trim())) out.push(String(value).trim())
            }
        }
    } catch {}
    return out
}

function chooseProvider(providers, providerId = null) {
    if (!providers.length) return null
    const wanted = providerId == null || providerId === "" ? null : String(providerId).toLowerCase()
    const eligible = providers.filter(p => p.cost > 0 && (p.stock == null || p.stock > 0))
    const pool = eligible.length ? eligible : providers.filter(p => p.cost > 0)
    if (!pool.length) return null
    if (wanted) {
        const exact = pool.find(p => [p.providerId, p.provider].filter(Boolean).some(v => String(v).toLowerCase() === wanted))
        if (exact) return exact
    }
    return pool.slice().sort((a, b) => Number(a.cost) - Number(b.cost))[0]
}

function parseErrorBody(body, status) {
    const raw = firstDefined(body || {}, ["error.message", "error", "errors.0.message", "message", "msg", "status_message", "detail"])
    if (typeof raw === "string" && raw.trim()) return raw.trim()
    if (raw && typeof raw === "object") return raw.message || raw.error || JSON.stringify(raw)
    return `HTTP ${status}`
}

function authError(message, status, body = null) {
    const text = String(message || "").trim() || `HTTP ${status}`
    const code = Number(status)
    const authLike = [401, 403].includes(code) || /invalid|unauthori[sz]ed|forbidden|api.?key|whitelist|user.?id|user tidak ditemukan/i.test(text)
    if (!authLike) return text

    // RuangOTP's documented API authenticates with x-user-id and requires
    // the VPS public IP to be whitelisted. Include provider diagnostics when supplied.
    const detectedIp = firstDefined(body || {}, ["error.detected_ip", "detected_ip", "data.detected_ip"], "")
    const whitelistedIp = firstDefined(body || {}, ["error.whitelisted_ip", "whitelisted_ip", "data.whitelisted_ip"], "")
    const lower = text.toLowerCase()
    let guidance = "Periksa User ID RuangOTP pada settings.js dan pastikan IP publik VPS terdaftar di menu Profile → Whitelist IP."
    if (/ip.*(whitelist|terdaftar|tidak sesuai)|whitelist.*ip/i.test(lower) || detectedIp || whitelistedIp) {
        guidance = "Respons provider mengarah ke masalah whitelist IP. Daftarkan IP publik VPS yang tertera di bawah pada menu Profile → Whitelist IP RuangOTP."
    } else if (/user tidak ditemukan|user.?id|invalid user|user.*(invalid|tidak valid|tidak aktif)/i.test(lower)) {
        guidance = "Respons provider mengarah ke User ID. Isi x-user-id dengan User ID akun RuangOTP dari panel; jangan menganggap API key pasti sama dengan User ID."
    } else if (code === 401) {
        guidance = "HTTP 401: autentikasi ditolak. Periksa User ID yang digunakan pada header x-user-id dan cocokkan dengan akun RuangOTP."
    }
    const details = []
    if (detectedIp) details.push(`IP VPS terdeteksi: ${String(detectedIp)}`)
    if (whitelistedIp) details.push(`IP whitelist tercatat provider: ${String(whitelistedIp)}`)
    return `RuangOTP menolak request (HTTP ${code || "?"}): ${text}. ${guidance}${details.length ? ` ${details.join("; ")}.` : ""}`
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function enqueueRequest(task) {
    const run = requestChain.then(async () => {
        const minInterval = Math.max(0, Number(config().minRequestIntervalMs || 750))
        const wait = Math.max(0, lastRequestAt + minInterval - Date.now())
        if (wait > 0) await sleep(wait)
        lastRequestAt = Date.now()
        return task()
    })
    requestChain = run.catch(() => {})
    return run
}

function routeUrl(route) { return `${baseUrl()}/${String(route || "").replace(/^\//, "")}` }

async function requestApi(method, route, options = {}, fallbackMethod = null, requestPolicy = {}) {
    if (authBlockedUntil > Date.now() && !requestPolicy.allowAuthProbe) {
        const previous = lastAuthFailureMessage || "RuangOTP sebelumnya menolak autentikasi (HTTP 401/403). Periksa x-user-id dan whitelist IP VPS."
        const waitSeconds = Math.max(1, Math.ceil((authBlockedUntil - Date.now()) / 1000))
        throw Object.assign(new Error(`${previous} Request otomatis ditahan selama sekitar ${waitSeconds} detik untuk mencegah request berulang. Owner dapat memakai .nokosdiag untuk satu pemeriksaan ulang.`), { definiteFailure: true, status: lastAuthFailureStatus, authBlocked: true })
    }
    if (!ready()) throw Object.assign(new Error("API RuangOTP belum diatur. Isi User ID akun RuangOTP yang valid pada settings.js dan daftarkan IP publik VPS di menu Profile → Whitelist IP."), { definiteFailure: true })
    const timeout = Number(config().timeoutMs || 20000)
    const params = options.params && Object.keys(options.params).length ? options.params : undefined
    const data = options.data
    const perform = async (httpMethod) => {
        const res = await axios({
            method: httpMethod,
            url: routeUrl(route),
            params,
            data,
            headers: headers(options.headers || {}),
            timeout,
            validateStatus: () => true
        })
        if (res.status >= 200 && res.status < 300) {
            const body = res.data
            if (body?.success === false || body?.status === false || body?.error) {
                const providerText = parseErrorBody(body, res.status)
                const authFailure = /invalid|unauthori[sz]ed|forbidden|api.?key|whitelist|user.?id|user tidak ditemukan|akses ditolak/i.test(providerText)
                const message = authError(providerText, res.status, body)
                if (authFailure) {
                    authBlockedUntil = Date.now() + 60000
                    lastAuthFailureMessage = message
                    lastAuthFailureStatus = res.status
                }
                throw Object.assign(new Error(message), { status: res.status, response: res, providerRejected: true, definiteFailure: true })
            }
            authBlockedUntil = 0
            lastAuthFailureMessage = ""
            lastAuthFailureStatus = 0
            return body
        }
        const providerText = parseErrorBody(res.data, res.status)
        const message = authError(providerText, res.status, res.data)
        const error = new Error(message)
        error.status = res.status
        error.response = res
        if ([401, 403].includes(Number(res.status))) {
            authBlockedUntil = Date.now() + 60000
            lastAuthFailureMessage = message
            lastAuthFailureStatus = res.status
        }
        if (res.status === 429) {
            const retryAfterRaw = res.headers?.["retry-after"] || res.headers?.["Retry-After"]
            const retryAfter = Math.min(15000, Math.max(1000, Number(retryAfterRaw) * 1000 || 3000))
            error.retryAfterMs = retryAfter
        }
        throw error
    }

    return enqueueRequest(async () => {
        try {
            return await perform(method)
        } catch (e) {
            if (Number(e?.status) === 405 && fallbackMethod && fallbackMethod !== method) {
                return perform(fallbackMethod)
            }
            if (Number(e?.status) === 429) {
                if (requestPolicy.noRetry429) {
                    e.uncertain = true
                    throw e
                }
                await sleep(Number(e.retryAfterMs || 3000))
                return perform(method)
            }
            if (e?.code === "ECONNABORTED" || !e?.response) {
                const timeoutError = new Error(e?.code === "ECONNABORTED" ? "Request ke RuangOTP timeout; status order belum dapat dipastikan." : `Koneksi ke RuangOTP gagal; status order belum dapat dipastikan: ${e?.message || e}`)
                timeoutError.uncertain = true
                timeoutError.cause = e
                throw timeoutError
            }
            throw e
        }
    })
}

function cacheGet(key) {
    const entry = cache.get(key)
    if (!entry || entry.expiresAt <= Date.now()) {
        cache.delete(key)
        return undefined
    }
    return entry.value
}

function cacheSet(key, value, ttl = 60000) {
    cache.set(key, { value, expiresAt: Date.now() + Math.max(1000, ttl) })
    return value
}

async function memo(key, fn) {
    const cached = cacheGet(key)
    if (cached !== undefined) return cached
    if (inFlight.has(key)) return inFlight.get(key)
    const promise = Promise.resolve().then(fn).then(value => {
        cacheSet(key, value, Number(config().cacheMs || 60000))
        return value
    }).finally(() => inFlight.delete(key))
    inFlight.set(key, promise)
    return promise
}

async function balance() {
    throw new Error("Endpoint saldo belum dimasukkan karena tidak termasuk daftar API v2 yang diminta. Atur RUANGOTP_BALANCE_PATH bila provider menyediakan endpoint saldo.")
}

async function countries(service = "") {
    const svc = String(service || "").trim()
    const key = `countries:${svc}`
    return memo(key, async () => {
        const body = await requestApi("GET", getRoutes().countries)
        const root = unwrap(body)
        const raw = normalizeList(root?.countries ?? root)
        return raw.map(normalizeCountry).filter(x => Number.isFinite(x.id))
    })
}

async function diagnoseConnection() {
    // One owner-triggered probe is allowed during cooldown so the actual provider
    // response (including detected/whitelisted IP) can be shown instead of a generic lock message.
    const body = await requestApi("GET", getRoutes().countries, {}, null, { allowAuthProbe: true })
    const root = unwrap(body)
    const raw = normalizeList(root?.countries ?? root)
    return raw.map(normalizeCountry).filter(x => Number.isFinite(x.id))
}

async function services(country) {
    const c = Number(country)
    if (!Number.isFinite(c)) throw new Error("Country ID wajib diisi untuk /services-v2/list.")
    const key = `services:${c}`
    return memo(key, async () => {
        const body = await requestApi("GET", getRoutes().services, {
            params: { country: c, country_id: c }
        })
        const root = unwrap(body)
        const raw = normalizeList(root?.services ?? root)
        return raw.map(normalizeService).filter(x => x.code)
    })
}

async function prices(service, country, providerId = null, operator = "any") {
    const params = {
        service: String(service),
        service_id: String(service),
        country: String(country),
        country_id: String(country)
    }
    if (providerId != null && providerId !== "") {
        params.provider_id = String(providerId)
    }
    if (operator && !['any', 'all', '*'].includes(String(operator).toLowerCase())) {
        params.operator = String(operator)
        params.operator_id = String(operator)
    }
    const key = `price:${String(service)}:${String(country)}:${String(providerId || "")} :${String(operator || "any")}`.replace(/\s+/g, "")
    return memo(key, async () => unwrap(await requestApi("GET", getRoutes().price, { params })))
}

async function getPrices(service, country, operator = "any") {
    const serviceCandidates = await resolveServiceCandidates(service, country)
    const output = []
    const seen = new Set()

    for (const candidate of serviceCandidates) {
        const raw = await prices(candidate, country, null, operator)
        const providers = collectProviderCandidates(raw)

        for (const provider of providers) {
            const key = `${provider.providerId || provider.provider}:${provider.cost}:${provider.stock == null ? "?" : provider.stock}`
            if (seen.has(key)) continue
            seen.add(key)
            output.push({
                ...provider,
                resolvedService: candidate
            })
        }

        const root = unwrap(raw)
        if (root && typeof root === "object") {
            const keyedCandidates = [
                root[String(country)]?.[String(candidate)],
                root[String(country)],
                root[String(candidate)],
                root.data?.[String(country)]?.[String(candidate)],
                root.data?.[String(country)],
                root.data?.[String(candidate)]
            ].filter(Boolean)

            for (const keyed of keyedCandidates) {
                const nested = collectProviderCandidates(keyed)
                for (const provider of nested) {
                    const key = `${provider.providerId || provider.provider}:${provider.cost}:${provider.stock == null ? "?" : provider.stock}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    output.push({
                        ...provider,
                        resolvedService: candidate
                    })
                }
            }
        }

        if (output.length) break
    }

    return output
}

async function getPrice(service, country, providerId = null, operator = "any") {
    const serviceCandidates = await resolveServiceCandidates(service, country)
    let lastRaw = null
    let lastProviders = []

    for (const candidate of serviceCandidates) {
        const raw = await prices(candidate, country, providerId, operator)
        lastRaw = raw
        const providers = collectProviderCandidates(raw)
        lastProviders = providers
        const selected = chooseProvider(providers, providerId)
        if (selected) return { ...selected, providers, raw, resolvedService: candidate }

        const root = unwrap(raw)
        if (root && typeof root === "object") {
            const keyedCandidates = [
                root[String(country)]?.[String(candidate)],
                root[String(country)],
                root[String(candidate)],
                root.data?.[String(country)]?.[String(candidate)],
                root.data?.[String(country)],
                root.data?.[String(candidate)]
            ].filter(Boolean)
            for (const keyed of keyedCandidates) {
                const p = chooseProvider(collectProviderCandidates(keyed), providerId)
                if (p) return { ...p, providers, raw, resolvedService: candidate }
            }
        }
    }

    const tried = serviceCandidates.join(", ")
    throw new Error(`Harga RuangOTP tidak ditemukan untuk service=${service}, country=${country}. Service yang dicoba: ${tried || "-"}. Pastikan service tersebut memang tersedia pada /services-v2/list untuk country ${country}.`)
}

async function getCatalog(service = "wa") {
    const list = await countries(service)
    return list
        .map(c => ({
            id: c.id,
            name: c.name,
            prefix: c.prefix,
            providerName: Boolean(c.name),
            providers: []
        }))
        .sort((a, b) => Number(a.id) - Number(b.id))
}

function orderBody({ service, country, providerId, expectedPrice }) {
    const price = numeric(expectedPrice)
    if (!String(service || '').trim()) throw new Error('Kode service RuangOTP kosong.')
    if (!Number.isSafeInteger(Number(country)) || Number(country) <= 0) throw new Error('Country ID RuangOTP tidak valid.')
    if (!String(providerId ?? '').trim()) throw new Error('Provider ID wajib diisi untuk membeli nomor RuangOTP.')
    if (!Number.isFinite(price) || price <= 0) throw new Error('Expected price RuangOTP tidak valid.')
    return {
        service: String(service),
        country: Number(country),
        provider_id: String(providerId),
        expected_price: price
    }
}

function pickObject(body) {
    const root = unwrap(body)
    if (!root || typeof root !== "object") return {}
    for (const key of ["order", "transaction", "data", "result"]) {
        if (root[key] && typeof root[key] === "object" && !Array.isArray(root[key])) return root[key]
    }
    return root
}

function parseOrder(body, defaults) {
    const d = pickObject(body)
    const orderId = String(firstDefined(d, ["order_id", "orderId", "transaction_id", "transactionId", "id", "ref"], ""))
    const activationId = String(firstDefined(d, ["activation_id", "activationId"], orderId))
    const phone = String(firstDefined(d, ["phone_number", "phoneNumber", "phone", "number", "msisdn", "nomor"], ""))
    const service = String(firstDefined(d, ["service", "service_code", "serviceId", "service_id"], defaults.service || ""))
    const country = String(firstDefined(d, ["country", "country_id", "countryId"], defaults.country || ""))
    const cost = numeric(firstDefined(d, ["cost", "price", "harga", "amount", "cost_idr"], defaults.cost || 0)) || 0
    return {
        activationId,
        orderId,
        providerTransactionId: orderId || activationId,
        phone,
        service,
        country,
        cost,
        expiresAt: firstDefined(d, ["activationEndTime", "expires_at", "expiresAt", "expired_at", "expire_at"], null),
        provider: firstDefined(d, ["provider", "provider_name", "providerName"], defaults.provider || null),
        providerId: firstDefined(d, ["provider_id", "providerId"], defaults.providerId || null),
        status: firstDefined(d, ["status", "state", "order_status", "transaction_status"], "waiting"),
        raw: body
    }
}

async function getNumber({ service, country, operator = "any", provider, providerId, expectedPrice, idempotencyKey, dedupeKey }) {
    const key = String(idempotencyKey || `nokos-${Date.now()}-${Math.random().toString(36).slice(2)}`).slice(0, 120)
    const signature = String(dedupeKey || `${service}|${country}|${operator}|${providerId || provider || "auto"}|${key}`)
    const recent = orderInFlight.get(signature)
    if (recent && Date.now() - recent.startedAt < 15000) return recent.promise

    const promise = (async () => {
        let params
        try {
            params = orderBody({ service, country, providerId, expectedPrice })
        } catch (error) {
            // Local validation failed before any request was sent, so the buyer
            // can be safely refunded instead of having funds held for review.
            error.definiteFailure = true
            throw error
        }
        let response
        try {
            // RuangOTP's documented purchase endpoint is GET /order-v2/buy.
            // Do not retry ambiguous network timeouts: a purchase may already exist.
            response = await requestApi("GET", getRoutes().order, { params }, null, { noRetry429: true })
        } catch (error) {
            if (error?.definiteFailure || error?.providerRejected || [400, 401, 403, 404, 405, 422].includes(Number(error?.status))) {
                error.definiteFailure = true
            } else {
                error.uncertain = true
            }
            throw error
        }
        const parsed = parseOrder(response, { service, country, provider, providerId, cost: expectedPrice })
        if (!parsed.activationId) {
            const error = new Error("RuangOTP menerima request tetapi tidak mengembalikan activation ID; status order belum dapat dipastikan.")
            error.uncertain = true
            error.providerResponseReceived = true
            throw error
        }
        if (!parsed.orderId) parsed.orderId = parsed.activationId
        parsed.providerTransactionId = parsed.orderId || parsed.activationId
        return parsed
    })()
    orderInFlight.set(signature, { promise, startedAt: Date.now() })
    const cleanup = () => {
        const current = orderInFlight.get(signature)
        if (current?.promise === promise) orderInFlight.delete(signature)
    }
    promise.then(cleanup, cleanup)
    return promise
}

function parseStatus(body) {
    const d = pickObject(body)
    let rawStatus = String(firstDefined(d, ["status", "state", "transaction_status", "order_status"], "unknown")).toLowerCase().replace(/[-\s]+/g, "_")
    const code = firstDefined(d, ["code", "otp", "verification_code", "otp_code"], null)
    const sms = firstDefined(d, ["sms", "message", "sms_text", "text"], null)
    const phone = firstDefined(d, ["phone_number", "phoneNumber", "phone", "number", "msisdn", "nomor"], null)
    if (["status_ok", "success", "completed", "complete", "done", "received", "otp_received", "completed_otp"].includes(rawStatus)) rawStatus = code ? "received" : "waiting"
    else if (["status_wait_code", "wait_code", "status_wait_retry", "wait_retry", "pending", "waiting", "wait", "processing", "in_progress", "created", "new"].includes(rawStatus)) rawStatus = "waiting"
    else if (["status_cancel", "status_cancelled", "cancel", "cancelled", "canceled"].includes(rawStatus)) rawStatus = "cancelled"
    else if (["expired", "expire"].includes(rawStatus)) rawStatus = "expired"
    else if (["failed", "failure", "error"].includes(rawStatus)) rawStatus = "failed"
    return { ...d, status: rawStatus, code: code || null, sms: sms || null, phone: phone || null, raw: body }
}

function transactionIdentifiers(id) {
    const value = String(id)
    return { id: value, activation_id: value, order_id: value, transaction_id: value, ref: value }
}

function isMethodError(e) { return [400, 405, 422].includes(Number(e?.status)) }

async function status(activationId) {
    const id = String(activationId || "").trim()
    if (!id) throw new Error("Activation ID kosong.")
    if (statusInFlight.has(id)) return statusInFlight.get(id)
    const promise = (async () => {
        const body = await requestApi("GET", getRoutes().status, { params: transactionIdentifiers(id) }, "POST")
        return parseStatus(body)
    })().finally(() => statusInFlight.delete(id))
    statusInFlight.set(id, promise)
    return promise
}

async function resend(activationId) {
    const id = String(activationId || "").trim()
    if (!id) throw new Error("Activation ID kosong.")
    const body = await requestApi("GET", getRoutes().resend, { params: transactionIdentifiers(id) }, "POST")
    return unwrap(body) || body || {}
}

async function cancel(activationId) {
    const id = String(activationId || "").trim()
    if (!id) throw new Error("Activation ID kosong.")
    const body = await requestApi("GET", getRoutes().cancel, { params: transactionIdentifiers(id) }, "POST")
    return unwrap(body) || body || {}
}

async function cancelOrderAndRefund(ref, reason = 'manual_cancel') {
    const key = String(ref || '').trim().toUpperCase()
    const order = getOrder(key)
    if (!order) throw new Error('Order NOKOS tidak ditemukan.')
    if (order.otp || order.receivedAt || String(order.status || '').toLowerCase() === 'received') {
        return { confirmed: false, delivered: true, order, message: 'OTP sudah diterima; refund/cancel ditolak untuk mencegah pengembalian dana atas layanan yang sudah diberikan.' }
    }
    const providerId = order.providerTransactionId || order.orderId || order.activationId
    if (!providerId) throw new Error('ID transaksi provider tidak tersedia; order memerlukan rekonsiliasi owner.')
    const currentStatus = String(order.status || '').toLowerCase()
    if (!['waiting', 'wait_code', 'pending', 'processing', 'cancel_requested'].includes(currentStatus)) {
        if (['cancelled', 'expired', 'failed'].includes(currentStatus)) {
            const refund = order.charged ? refundOnce(key, reason) : null
            return { confirmed: true, status: currentStatus, order: refund?.order || order, refund }
        }
        return { confirmed: false, order, message: `Order berstatus ${currentStatus || 'unknown'} dan tidak dapat dibatalkan.` }
    }

    let cancelError = null
    try { await cancel(providerId) } catch (error) { cancelError = error }
    let verified
    try {
        verified = await status(providerId)
    } catch (error) {
        const latest = updateOrder(key, {
            status: 'cancel_requested', cancelRequestedAt: order.cancelRequestedAt || Date.now(),
            cancelVerificationError: String(error?.message || error),
            cancelRequestError: cancelError ? String(cancelError?.message || cancelError) : ''
        }) || order
        return { confirmed: false, order: latest, message: 'Permintaan batal telah dicoba tetapi status provider tidak dapat diverifikasi. Dana belum direfund; owner perlu mengecek dashboard provider.' }
    }

    const verifiedStatus = String(verified?.status || 'unknown').toLowerCase()
    if (!['cancelled', 'expired', 'failed'].includes(verifiedStatus)) {
        const latest = updateOrder(key, {
            status: 'cancel_requested', cancelRequestedAt: order.cancelRequestedAt || Date.now(),
            cancelVerificationStatus: verifiedStatus,
            cancelRequestError: cancelError ? String(cancelError?.message || cancelError) : '',
            cancelVerificationCheckedAt: Date.now()
        }) || order
        return { confirmed: false, order: latest, status: verifiedStatus, message: `Provider belum mengonfirmasi pembatalan (status: ${verifiedStatus}). Dana belum direfund. Jangan membuat order baru; status perlu dicek lagi atau diperiksa owner.` }
    }

    updateOrder(key, { status: verifiedStatus, cancelConfirmedAt: Date.now(), cancelVerificationStatus: verifiedStatus })
    const refund = order.charged ? refundOnce(key, reason) : null
    const updated = getOrder(key)
    return { confirmed: true, status: verifiedStatus, order: updated || order, refund, cancelResponseError: cancelError ? String(cancelError?.message || cancelError) : '' }
}

function saveOrder(order) {
    const db = loadDb()
    db[String(order.ref).toUpperCase()] = order
    saveDb(db)
    return order
}

function getOrder(ref) { return loadDb()[String(ref || "").toUpperCase()] || null }

function updateOrder(ref, patch) {
    const db = loadDb()
    const key = String(ref || "").toUpperCase()
    if (!db[key]) return null
    db[key] = { ...db[key], ...patch, updatedAt: Date.now() }
    saveDb(db)
    return db[key]
}

function listOrders(jid, limit = 10) {
    return Object.values(loadDb())
        .filter(x => !jid || x.jid === jid)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        .slice(0, limit)
}

async function waitForOtp(activationId, timeoutMs = Number(config().otpTimeoutMs || 20 * 60 * 1000), intervalMs = Number(config().pollIntervalMs || 5000)) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const s = await status(activationId)
        if (s.status === "received" && s.code) return s
        if (["cancelled", "expired", "failed"].includes(s.status)) {
            const e = new Error(`Activation ${s.status}`)
            e.status = s.status
            throw e
        }
        await sleep(Math.max(2500, Number(intervalMs) || 5000))
    }
    const e = new Error("OTP timeout")
    e.status = "timeout"
    throw e
}

module.exports = {
    ready,
    getApiKey,
    maskedApiKey,
    baseUrl,
    getRoutes,
    balance,
    services,
    countries,
    diagnoseConnection,
    prices,
    getPrices,
    getPrice,
    getCatalog,
    countryFlag,
    countryIso2,
    getNumber,
    status,
    resend,
    cancel,
    cancelOrderAndRefund,
    money,
    sellPrice,
    refundOnce,
    makeRef,
    saveOrder,
    getOrder,
    updateOrder,
    listOrders,
    waitForOtp
}
