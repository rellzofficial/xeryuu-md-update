'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const economy = require('./economy.js')
const nokosService = require('./nokos.js')
const topupService = require('./topup.js')
const depositService = require('./deposit.js')

const DB_FILE = path.join(__dirname, 'database', 'purchase-payment-intents.json')
const locks = new Map()
let paidFulfillmentHandler = null
let sendBuyerHandler = null
let notifyOwnerHandler = null
const nokosWatchers = new Map()

function ensureDb() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '{}')
}

function loadDb() {
    ensureDb()
    try {
        const value = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
        return {}
    }
}

function saveDb(db) {
    ensureDb()
    const temp = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(db, null, 2))
    fs.renameSync(temp, DB_FILE)
}

function token() { return crypto.randomBytes(8).toString('hex').toUpperCase() }
function amountOf(intent) { return Math.floor(Number(intent?.amount || 0)) }

function getIntent(value) {
    return loadDb()[String(value || '').trim().toUpperCase()] || null
}

function saveIntent(intent) {
    const db = loadDb()
    const key = String(intent?.token || '').trim().toUpperCase()
    if (!key) throw new Error('Token pesanan kosong; intent tidak dapat disimpan.')
    db[key] = { ...intent, token: key, updatedAt: Date.now() }
    saveDb(db)
    return db[key]
}

function createIntent({ type, jid, source = 'whatsapp', telegramId = '', pushname = '', amount, details, label = '' }) {
    const normalizedType = String(type || '').toUpperCase()
    if (!['NOKOS', 'TOPUP'].includes(normalizedType)) throw new Error('Jenis pembelian tidak didukung.')
    const numericAmount = Math.floor(Number(amount))
    if (!jid || !Number.isSafeInteger(numericAmount) || numericAmount <= 0) throw new Error('Data pembelian atau nominal tidak valid.')
    const cleanDetails = details && typeof details === 'object' && !Array.isArray(details) ? details : {}
    if (normalizedType === 'NOKOS') {
        if (!cleanDetails.service || !Number.isFinite(Number(cleanDetails.country)) || !cleanDetails.providerId || !(Number(cleanDetails.providerCost) > 0)) {
            throw new Error('Detail NOKOS tidak lengkap. Service, country, provider ID, dan harga provider wajib valid.')
        }
    } else if (!cleanDetails.game || !cleanDetails.customerNo || !cleanDetails.serviceCode) {
        throw new Error('Detail top up tidak lengkap. Game, target, dan kode produk wajib diisi.')
    }

    const now = Date.now()
    const normalizedJid = String(jid)
    // Reuse one intent for repeated identical requests. In-flight or ambiguous
    // purchases are reused even after the menu TTL: creating a second token could
    // charge the customer twice while the first provider/gateway operation is unresolved.
    const canonicalDetails = JSON.stringify(cleanDetails)
    const terminalStatuses = new Set(['FULFILLED', 'FAILED_REFUNDED', 'EXPIRED', 'CANCELLED', 'CANCELED'])
    const protectedStatuses = new Set(['QRIS_CREATING', 'QRIS_REVIEW_REQUIRED', 'QRIS_PAID', 'PROVIDER_PROCESSING', 'BALANCE_PROCESSING', 'REVIEW_REQUIRED'])
    const sameLogicalProduct = (other = {}) => normalizedType === 'NOKOS'
        ? String(other.service || '').toLowerCase() === String(cleanDetails.service || '').toLowerCase()
            && Number(other.country) === Number(cleanDetails.country)
            && String(other.operator || 'any').toLowerCase() === String(cleanDetails.operator || 'any').toLowerCase()
            && String(other.providerId || '') === String(cleanDetails.providerId || '')
        : String(other.game || '').toLowerCase() === String(cleanDetails.game || '').toLowerCase()
            && String(other.customerNo || '') === String(cleanDetails.customerNo || '')
            && String(other.zone || '') === String(cleanDetails.zone || '')
            && String(other.serviceCode || '') === String(cleanDetails.serviceCode || '')
            && String(other.nominal || '') === String(cleanDetails.nominal || '')
    for (const existing of Object.values(loadDb())) {
        if (!existing || existing.type !== normalizedType || String(existing.jid) !== normalizedJid) continue
        if (!sameLogicalProduct(existing.details || {})) continue
        const status = String(existing.status || '').toUpperCase()
        if (terminalStatuses.has(status)) continue
        if (protectedStatuses.has(status)) return existing
        if (status === 'WAITING_PAYMENT' && existing.paymentRef) {
            const payment = depositService.get(existing.paymentRef)
            const paymentStatus = String(payment?.status || '').toUpperCase()
            if (!payment) {
                // A payment reference exists but its durable invoice record is missing.
                // Never mint another token until the original transaction is reconciled.
                return saveIntent({ ...existing, status: 'QRIS_REVIEW_REQUIRED', reviewReason: 'Referensi invoice tersimpan tetapi data invoice lokal tidak ditemukan. Rekonsiliasi gateway diperlukan sebelum order baru.' })
            }
            if (['EXPIRED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(paymentStatus)) {
                saveIntent({ ...existing, status: 'EXPIRED', paymentEndedStatus: paymentStatus, paymentEndedAt: Date.now() })
                continue
            }
            // Reuse pending, paid, or otherwise unresolved invoices. A second token
            // could otherwise create a duplicate if the original invoice settles late.
            return existing
        }
        if (status === 'AWAITING_METHOD') {
            if (Number(existing.expiresAt || 0) <= now) {
                saveIntent({ ...existing, status: 'EXPIRED', expiredReason: 'payment_choice_timed_out', expiredAt: Date.now() })
                continue
            }
            if (Number(existing.amount) === numericAmount && JSON.stringify(existing.details || {}) === canonicalDetails) return existing
            // A refreshed price/quote replaces an uncharged intent. Old buttons/tokens
            // are invalidated so an old quote cannot be charged in parallel.
            saveIntent({ ...existing, status: 'EXPIRED', expiredReason: 'quote_replaced', expiredAt: Date.now() })
        }
    }
    const id = token()
    return saveIntent({
        token: id, type: normalizedType, jid: String(jid), source: String(source || 'whatsapp'),
        telegramId: String(telegramId || ''), pushname: String(pushname || ''), amount: numericAmount,
        label: String(label || (normalizedType === 'NOKOS' ? `NOKOS ${cleanDetails.service}` : `TOP UP ${cleanDetails.game}`)),
        details: cleanDetails, status: 'AWAITING_METHOD', paymentMethod: '', paymentRef: '',
        orderRef: '', providerCallStartedAt: null, providerCallFinishedAt: null,
        refunded: false, createdAt: now, expiresAt: now + 15 * 60 * 1000, updatedAt: now
    })
}

function ownedIntent(value, jid, expectedType = '') {
    const intent = getIntent(value)
    if (!intent) throw new Error('Token pembelian tidak ditemukan atau sudah kedaluwarsa.')
    if (String(intent.jid) !== String(jid)) throw new Error('Token pembelian tersebut bukan milik akun kamu.')
    if (expectedType && intent.type !== String(expectedType).toUpperCase()) throw new Error('Token pembelian tidak cocok dengan jenis transaksi.')
    if (intent.expiresAt && Number(intent.expiresAt) < Date.now() && intent.status === 'AWAITING_METHOD') {
        saveIntent({ ...intent, status: 'EXPIRED' })
        throw new Error('Pilihan pembayaran kedaluwarsa. Silakan buat pesanan baru.')
    }
    return intent
}

function currentPurchase(intent) {
    if (intent.type === 'NOKOS' && intent.orderRef) return nokosService.getOrder(intent.orderRef)
    if (intent.type === 'TOPUP' && intent.orderRef) return topupService.getTransaction(intent.orderRef)
    return null
}

function isDefinitelyRejected(error) {
    if (error?.providerRejected || error?.definiteFailure) return true
    return [400, 401, 403, 404, 405, 422].includes(Number(error?.status))
}

function applyCreditOnce(jid, amount, key, reason) {
    return economy.applyMoneyTransaction(jid, Math.floor(Number(amount || 0)), key, reason)
}

function refundTopup(intent, tx, reason) {
    const current = tx || topupService.getTransaction(intent.orderRef)
    if (current?.refunded || intent.refunded) return { creditedNow: false, alreadyRefunded: true }
    const result = applyCreditOnce(intent.jid, amountOf(intent), `purchase-refund:${intent.token}`, `Refund pembelian ${intent.type}: ${reason}`)
    intent = saveIntent({ ...intent, refunded: true, refundReason: reason, refundAt: Date.now(), status: 'FAILED_REFUNDED' })
    if (current) {
        topupService.updateTransaction(current.ref || current.localRef, {
            charged: true, refunded: true, refundReason: reason,
            purchaseToken: intent.token, updatedAt: Date.now()
        })
    }
    return { creditedNow: Boolean(result.applied), alreadyRefunded: Boolean(result.duplicate), intent }
}

function refundPurchase(intent, reason) {
    const amount = amountOf(intent)
    if (intent.type === 'NOKOS' && intent.orderRef) {
        const result = nokosService.refundOnce(intent.orderRef, reason)
        if (result) {
            const next = saveIntent({ ...intent, refunded: true, refundReason: reason, refundAt: Date.now(), status: 'FAILED_REFUNDED' })
            return { creditedNow: Boolean(result.refundedNow), alreadyRefunded: Boolean(result.alreadyCredited || result.alreadyRefunded), intent: next, order: result.order }
        }
    }
    if (intent.type === 'TOPUP') return refundTopup(intent, currentPurchase(intent), reason)
    const result = applyCreditOnce(intent.jid, amount, `purchase-refund:${intent.token}`, `Refund pembelian ${intent.type}: ${reason}`)
    const next = saveIntent({ ...intent, refunded: true, refundReason: reason, refundAt: Date.now(), status: 'FAILED_REFUNDED' })
    return { creditedNow: Boolean(result.applied), alreadyRefunded: Boolean(result.duplicate), intent: next }
}

function normalizeNokosStatus(value) {
    const status = String(value || '').toLowerCase().replace(/[-\s]+/g, '_')
    if (['wait_code', 'status_wait_code', 'waiting', 'pending', 'processing', 'in_progress', 'created'].includes(status)) return 'waiting'
    if (['success', 'completed', 'complete', 'done', 'received', 'status_ok'].includes(status)) return 'received'
    if (['cancel', 'cancelled', 'canceled', 'status_cancel'].includes(status)) return 'cancelled'
    if (['expired', 'expire'].includes(status)) return 'expired'
    if (['failed', 'failure', 'error'].includes(status)) return 'failed'
    return 'waiting'
}

async function fulfillNokos(intent, paymentMethod) {
    const d = intent.details
    let orderRef = intent.orderRef || nokosService.makeRef()
    let existing = nokosService.getOrder(orderRef)
    if (existing) {
        const existingStatus = String(existing.status || '').toLowerCase()
        const providerId = existing.providerTransactionId || existing.orderId || existing.activationId
        if (providerId) {
            if (['failed', 'cancelled', 'expired'].includes(existingStatus)) {
                if (existing.charged && !existing.refunded) {
                    const refund = refundPurchase({ ...intent, orderRef }, `existing_provider_${existingStatus}`)
                    return { intent: refund.intent || getIntent(intent.token), type: 'NOKOS', order: nokosService.getOrder(orderRef), failed: true, refunded: true, already: true, refund }
                }
                return { intent, type: 'NOKOS', order: existing, failed: true, refunded: Boolean(existing.refunded), already: true }
            }
            const finalizedIntent = existingStatus === 'provider_unknown'
                ? saveIntent({ ...intent, status: 'REVIEW_REQUIRED', orderRef, reviewReason: 'Order provider ditemukan tetapi statusnya belum pasti.' })
                : saveIntent({ ...intent, status: 'FULFILLED', orderRef, providerCallFinishedAt: intent.providerCallFinishedAt || Date.now() })
            return { intent: finalizedIntent, type: 'NOKOS', order: existing, already: true, success: existingStatus !== 'provider_unknown', reviewRequired: existingStatus === 'provider_unknown', message: existingStatus === 'provider_unknown' ? 'Status pembelian provider belum dapat dipastikan.' : '' }
        }
        // Any prior skeleton without a provider transaction ID means the process may
        // have died after sending the order request. Never send that request again.
        const reviewIntent = saveIntent({ ...intent, status: 'REVIEW_REQUIRED', orderRef, reviewReason: `Order internal ${existing.status || 'unknown'} tidak memiliki ID provider; perlu rekonsiliasi manual.` })
        return { intent: reviewIntent, type: 'NOKOS', order: existing, reviewRequired: true, message: reviewIntent.reviewReason }
    }
    if (!existing) {
        existing = nokosService.saveOrder({
            ref: orderRef, jid: intent.jid, telegramId: intent.telegramId || '', pushname: intent.pushname || '',
            service: d.service, country: Number(d.country), operator: d.operator || 'any',
            provider: d.provider || null, providerId: d.providerId, activationId: '', orderId: '', providerTransactionId: '',
            phone: '-', providerCost: Number(d.providerCost), sellingPrice: amountOf(intent),
            paymentMethod, paymentRef: intent.paymentRef || '', status: 'creating', otp: null, sms: null,
            createdAt: Date.now(), expiresAt: null, charged: true, refunded: false,
            purchaseToken: intent.token, source: intent.source
        })
    } else {
        nokosService.updateOrder(orderRef, { status: 'creating', paymentMethod, paymentRef: intent.paymentRef || '', purchaseToken: intent.token })
    }
    intent = saveIntent({ ...intent, orderRef, status: 'PROVIDER_PROCESSING', paymentMethod, providerCallStartedAt: Date.now() })

    let providerOrder
    try {
        providerOrder = await nokosService.getNumber({
            service: d.service, country: Number(d.country), operator: d.operator || 'any',
            provider: d.provider || null, providerId: d.providerId,
            expectedPrice: Number(d.providerCost), idempotencyKey: `xeryuu-${intent.token}`,
            dedupeKey: `purchase:${intent.token}`
        })
    } catch (error) {
        if (isDefinitelyRejected(error)) {
            nokosService.updateOrder(orderRef, { status: 'failed', providerError: String(error.message || error), providerCallFinishedAt: Date.now() })
            const refund = refundPurchase({ ...intent, orderRef }, error.message || 'provider_rejected')
            return { intent: refund.intent || getIntent(intent.token), type: 'NOKOS', order: nokosService.getOrder(orderRef), failed: true, refunded: true, error, refund }
        }
        const updatedOrder = nokosService.updateOrder(orderRef, {
            status: 'provider_unknown', providerError: String(error?.message || error), providerCallFinishedAt: Date.now(),
            paymentMethod, paymentRef: intent.paymentRef || '', purchaseToken: intent.token
        }) || existing
        const updatedIntent = saveIntent({ ...intent, status: 'REVIEW_REQUIRED', reviewReason: String(error?.message || error), providerCallFinishedAt: Date.now(), orderRef })
        return { intent: updatedIntent, type: 'NOKOS', order: updatedOrder, reviewRequired: true, error }
    }

    if (!providerOrder?.activationId && !providerOrder?.providerTransactionId) {
        const error = new Error('RuangOTP tidak mengembalikan ID transaksi yang valid; diperlukan pemeriksaan manual.')
        nokosService.updateOrder(orderRef, { status: 'provider_unknown', providerError: error.message })
        const updatedIntent = saveIntent({ ...intent, status: 'REVIEW_REQUIRED', reviewReason: error.message })
        return { intent: updatedIntent, type: 'NOKOS', order: nokosService.getOrder(orderRef), reviewRequired: true, error }
    }

    const providerTxId = String(providerOrder.providerTransactionId || providerOrder.orderId || providerOrder.activationId)
    const providerStatus = normalizeNokosStatus(providerOrder.status)
    const order = nokosService.updateOrder(orderRef, {
        service: providerOrder.service || d.service,
        country: Number(providerOrder.country || d.country),
        operator: d.operator || 'any',
        provider: providerOrder.provider || d.provider || null,
        providerId: providerOrder.providerId || d.providerId,
        activationId: providerOrder.activationId || providerTxId,
        orderId: providerOrder.orderId || providerTxId,
        providerTransactionId: providerTxId,
        phone: providerOrder.phone || '-',
        providerCost: Number(providerOrder.cost || d.providerCost),
        sellingPrice: amountOf(intent),
        status: providerStatus,
        otp: null, sms: null,
        expiresAt: providerOrder.expiresAt || null,
        paymentMethod, paymentRef: intent.paymentRef || '',
        charged: true, refunded: false, purchaseToken: intent.token,
        providerCallFinishedAt: Date.now(), updatedAt: Date.now()
    })
    if (['failed', 'cancelled', 'expired'].includes(String(order.status || '').toLowerCase())) {
        const refund = refundPurchase({ ...intent, orderRef }, `provider_returned_${String(order.status).toLowerCase()}`)
        return { intent: refund.intent || getIntent(intent.token), type: 'NOKOS', order: nokosService.getOrder(orderRef), failed: true, refunded: true, error: new Error(`RuangOTP mengembalikan status ${order.status}.`), refund }
    }
    const savedIntent = saveIntent({ ...intent, status: 'FULFILLED', orderRef, providerCallFinishedAt: Date.now(), providerId: order.providerId })
    return { intent: savedIntent, type: 'NOKOS', order, success: true }
}

async function fulfillTopup(intent, paymentMethod) {
    const d = intent.details
    let products
    try {
        products = await topupService.prices(d.game)
    } catch (error) {
        // This is the preflight catalogue lookup; no provider order call has been
        // sent yet, so it is safe to restore the buyer's value exactly once.
        const refund = refundPurchase(intent, `preflight_catalogue_failed: ${error?.message || error}`)
        return { intent: refund.intent || getIntent(intent.token), type: 'TOPUP', failed: true, refunded: true, error, refund }
    }
    const product = products.find(p => String(p.code || '') === String(d.serviceCode || ''))
    if (!product || String(product.status || '').toLowerCase() === 'empty') {
        const error = new Error('Produk top up sudah tidak tersedia. Dana dikembalikan ke saldo bot agar aman.')
        error.definiteFailure = true
        const refund = refundPurchase(intent, error.message)
        return { intent: refund.intent || getIntent(intent.token), type: 'TOPUP', failed: true, refunded: true, error, refund }
    }
    if (Number(product.sellingPrice) !== amountOf(intent)) {
        const error = new Error('Harga produk berubah setelah pesanan dibuat. Dana dikembalikan ke saldo bot.')
        error.definiteFailure = true
        const refund = refundPurchase(intent, error.message)
        return { intent: refund.intent || getIntent(intent.token), type: 'TOPUP', failed: true, refunded: true, error, refund }
    }

    intent = saveIntent({ ...intent, status: 'PROVIDER_PROCESSING', paymentMethod, providerCallStartedAt: Date.now() })
    let tx
    try {
        tx = await topupService.create({
            game: d.game, customerNo: d.customerNo, zone: d.zone || '', nominal: d.nominal,
            jid: intent.jid, serviceCode: d.serviceCode, expectedSellingPrice: amountOf(intent), purchaseToken: intent.token
        })
    } catch (error) {
        const partial = error?.transaction || topupService.getTransaction(error?.localRef || intent.orderRef)
        if (partial) {
            topupService.updateTransaction(partial.ref || partial.localRef, {
                purchaseToken: intent.token, charged: true, paymentMethod,
                sellingPrice: amountOf(intent), updatedAt: Date.now()
            })
            intent = saveIntent({ ...intent, orderRef: partial.ref || partial.localRef })
        }
        if (isDefinitelyRejected(error)) {
            const refund = refundPurchase({ ...intent, orderRef: partial?.ref || partial?.localRef || intent.orderRef }, error.message || 'provider_rejected')
            return { intent: refund.intent || getIntent(intent.token), type: 'TOPUP', tx: partial, failed: true, refunded: true, error, refund }
        }
        if (error?.uncertain || partial?.uncertain || String(partial?.status || '').toLowerCase() === 'verifikasi') {
            const updatedIntent = saveIntent({ ...intent, status: 'REVIEW_REQUIRED', orderRef: partial?.ref || partial?.localRef || intent.orderRef, reviewReason: String(error?.message || error), providerCallFinishedAt: Date.now() })
            return { intent: updatedIntent, type: 'TOPUP', tx: partial, reviewRequired: true, error }
        }
        // Local validation failure before the provider request is safe to refund.
        const refund = refundPurchase(intent, error.message || 'local_validation_failed')
        return { intent: refund.intent || getIntent(intent.token), type: 'TOPUP', tx: partial, failed: true, refunded: true, error, refund }
    }

    tx.purchaseToken = intent.token
    tx.paymentMethod = paymentMethod
    tx.charged = true
    tx.refunded = false
    tx.paymentRef = intent.paymentRef || ''
    try {
        topupService.setTransaction(tx)
    } catch (error) {
        // VIPayment already returned a transaction at this point. A local disk
        // failure must never trigger a refund or another provider order blindly.
        const reviewReason = `Order VIPayment mungkin sudah dibuat (${tx.providerRef || tx.ref || tx.localRef}), tetapi penyimpanan transaksi gagal: ${error?.message || error}`
        const reviewIntent = saveIntent({ ...intent, status: 'REVIEW_REQUIRED', orderRef: tx.ref || tx.localRef, reviewReason, providerCallFinishedAt: Date.now() })
        return { intent: reviewIntent, type: 'TOPUP', tx, reviewRequired: true, error }
    }
    if (String(tx.status || '').toLowerCase() === 'gagal' || String(tx.status || '').toLowerCase() === 'error') {
        const refund = refundPurchase({ ...intent, orderRef: tx.ref }, 'provider_status_failed')
        return { intent: refund.intent || getIntent(intent.token), type: 'TOPUP', tx: topupService.getTransaction(tx.ref), failed: true, refunded: true, refund }
    }
    const savedIntent = saveIntent({ ...intent, status: 'FULFILLED', orderRef: tx.ref, providerCallFinishedAt: Date.now() })
    return { intent: savedIntent, type: 'TOPUP', tx, success: true }
}

async function fulfillIntent(intent, paymentMethod) {
    const current = getIntent(intent.token) || intent
    const status = String(current.status || '').toUpperCase()
    if (status === 'FULFILLED') return { intent: current, type: current.type, already: true, success: true, order: current.type === 'NOKOS' ? currentPurchase(current) : null, tx: current.type === 'TOPUP' ? currentPurchase(current) : null }
    if (status === 'FAILED_REFUNDED') return { intent: current, type: current.type, failed: true, refunded: true, already: true }
    if (status === 'REVIEW_REQUIRED' || status === 'QRIS_REVIEW_REQUIRED') return { intent: current, type: current.type, reviewRequired: true, already: true, message: current.reviewReason || 'Menunggu pemeriksaan manual.' }
    if (status === 'PROVIDER_PROCESSING') {
        const item = currentPurchase(current)
        if (current.type === 'NOKOS' && item && (item.providerTransactionId || item.orderId || item.activationId)) {
            const providerStatus = String(item.status || '').toLowerCase()
            if (['failed', 'cancelled', 'expired'].includes(providerStatus)) {
                const refund = refundPurchase(current, `recovered_provider_${providerStatus}`)
                return { intent: refund.intent || getIntent(current.token), type: 'NOKOS', order: nokosService.getOrder(item.ref), failed: true, refunded: true, already: true, refund }
            }
            if (providerStatus !== 'provider_unknown') {
                const finalized = saveIntent({ ...current, status: 'FULFILLED', providerCallFinishedAt: current.providerCallFinishedAt || Date.now() })
                return { intent: finalized, type: 'NOKOS', order: item, success: true, already: true }
            }
        }
        if (current.type === 'TOPUP' && item && item.providerRef && !item.uncertain && !['verifikasi', 'membuat'].includes(String(item.status || '').toLowerCase())) {
            if (['gagal', 'error'].includes(String(item.status || '').toLowerCase())) {
                const refund = refundPurchase(current, 'recovered_provider_failure')
                return { intent: refund.intent || getIntent(current.token), type: 'TOPUP', tx: topupService.getTransaction(item.ref), failed: true, refunded: true, already: true, refund }
            }
            const finalized = saveIntent({ ...current, status: 'FULFILLED', providerCallFinishedAt: current.providerCallFinishedAt || Date.now() })
            return { intent: finalized, type: 'TOPUP', tx: item, success: true, already: true }
        }
        const updated = saveIntent({ ...current, status: 'REVIEW_REQUIRED', reviewReason: current.reviewReason || 'Bot restart atau proses terputus saat order provider; cek dashboard provider sebelum tindakan lanjutan.' })
        return { intent: updated, type: current.type, order: current.type === 'NOKOS' ? item : null, tx: current.type === 'TOPUP' ? item : null, reviewRequired: true, already: true, message: updated.reviewReason }
    }
    if (current.type === 'NOKOS') return fulfillNokos(current, paymentMethod)
    return fulfillTopup(current, paymentMethod)
}

async function buyWithBalance(value, jid, expectedType = '') {
    const intent = ownedIntent(value, jid, expectedType)
    const existingLock = locks.get(intent.token)
    if (existingLock) throw new Error('Pesanan ini sedang diproses. Tunggu hasilnya sebelum menekan tombol lagi.')
    if (intent.status === 'FULFILLED') return { intent, already: true, success: true, order: currentPurchase(intent), tx: currentPurchase(intent) }
    if (intent.status !== 'AWAITING_METHOD' && intent.status !== 'BALANCE_PROCESSING') {
        throw new Error(`Pesanan sudah berada pada status ${intent.status}; metode pembayaran tidak dapat diganti.`)
    }
    locks.set(intent.token, true)
    try {
        let current = getIntent(intent.token) || intent
        if (current.status === 'AWAITING_METHOD') {
            current = saveIntent({ ...current, status: 'BALANCE_PROCESSING', paymentMethod: 'BALANCE' })
        }
        if (!current.balanceDebitedAt) {
            const debit = economy.applyMoneyTransaction(current.jid, -amountOf(current), `purchase-debit:${current.token}`, `Pembelian ${current.type}`)
            if (debit.insufficient) {
                saveIntent({ ...current, status: 'AWAITING_METHOD', paymentMethod: '' })
                throw new Error(`Saldo tidak cukup. Harga Rp${amountOf(current).toLocaleString('id-ID')}, saldo kamu Rp${Number(debit.balance || 0).toLocaleString('id-ID')}. Lakukan deposit saldo bot melalui menu Deposit terlebih dahulu, lalu ulangi pembayaran dengan saldo bot.`)
            }
            current = saveIntent({ ...current, balanceDebitedAt: Date.now(), status: 'BALANCE_PROCESSING', paymentMethod: 'BALANCE' })
        }
        return await fulfillIntent(current, 'BALANCE')
    } finally {
        locks.delete(intent.token)
    }
}

async function createQrPayment(value, jid, pushname = '') {
    let intent = ownedIntent(value, jid)
    const initialStatus = String(intent.status || '').toUpperCase()
    if (initialStatus === 'QRIS_CREATING') {
        const oldInvoice = depositService.findByOrderRef?.(intent.token)
        if (!oldInvoice) {
            intent = saveIntent({ ...intent, status: 'QRIS_REVIEW_REQUIRED', reviewReason: 'Pembuatan invoice versi lama sempat dimulai tetapi invoice lokal tidak ditemukan. Owner harus memeriksa gateway sebelum pembayaran/metode baru diizinkan.', reviewAt: Date.now() })
            const error = new Error(intent.reviewReason)
            error.paymentReviewRequired = true
            throw error
        }
        const oldStatus = String(oldInvoice.status || '').toUpperCase()
        if (['PAID', 'SUCCESS', 'SETTLED'].includes(oldStatus)) {
            const result = await handlePaidPayment(oldInvoice)
            return { ...result, intent: result?.intent || getIntent(intent.token), payment: oldInvoice, existing: true, legacyNationalPayInvoice: true }
        }
        if (['EXPIRED', 'FAILED', 'CANCELED', 'CANCELLED', 'REFUNDED'].includes(oldStatus)) {
            const updated = saveIntent({ ...intent, status: 'EXPIRED', paymentRef: oldInvoice.merchantRef, paymentEndedStatus: oldStatus, paymentEndedAt: Date.now() })
            const error = new Error(`Invoice lama ${oldInvoice.merchantRef || intent.token} sudah berstatus ${oldStatus}. Buat pesanan baru hanya setelah memastikan invoice benar-benar final.`)
            error.legacyPurchaseInvoiceEnded = true
            error.intent = updated
            throw error
        }
        intent = saveIntent({ ...intent, status: 'WAITING_PAYMENT', paymentRef: oldInvoice.merchantRef, paymentMethod: 'QRIS', paymentCreatedAt: oldInvoice.createdAt, paymentExpiredAt: oldInvoice.expiredAt })
    }
    if (String(intent.status || '').toUpperCase() === 'WAITING_PAYMENT' && !intent.paymentRef) {
        intent = saveIntent({ ...intent, status: 'QRIS_REVIEW_REQUIRED', reviewReason: 'Intent lama berstatus WAITING_PAYMENT tetapi tidak memiliki referensi invoice. Rekonsiliasi diperlukan sebelum saldo atau invoice baru diizinkan.', reviewAt: Date.now() })
        const error = new Error(intent.reviewReason)
        error.paymentReviewRequired = true
        throw error
    }

    // Migrate old direct-purchase invoices carefully. Do not display or re-issue an
    // unpaid legacy NationalPay purchase invoice now that NationalPay is deposit-only.
    // If it already settled, reconcile it; if it is terminal, expire the intent; if
    // it is pending/missing, pause for owner review instead of letting the buyer pay
    // NationalPay for a new purchase or switch methods while settlement is ambiguous.
    if (String(intent.status || '').toUpperCase() === 'WAITING_PAYMENT' && intent.paymentRef) {
        const existing = depositService.get(intent.paymentRef)
        if (!existing || !['NOKOS_ORDER', 'TOPUP_ORDER'].includes(String(existing.kind || '').toUpperCase())) {
            const updated = saveIntent({ ...intent, status: 'QRIS_REVIEW_REQUIRED', reviewReason: 'Intent lama memiliki referensi invoice yang tidak dapat ditemukan atau tidak cocok dengan jenis pembelian. Periksa database/gateway sebelum menerima pembayaran baru.', reviewAt: Date.now() })
            const error = new Error(updated.reviewReason)
            error.paymentReviewRequired = true
            throw error
        }
        const existingStatus = String(existing.status || '').toUpperCase()
        if (['PAID', 'SUCCESS', 'SETTLED'].includes(existingStatus)) {
            const result = await handlePaidPayment(existing)
            return { ...result, intent: result?.intent || getIntent(intent.token), payment: existing, existing: true, legacyNationalPayInvoice: true }
        }
        if (['EXPIRED', 'FAILED', 'CANCELED', 'CANCELLED', 'REFUNDED'].includes(existingStatus)) {
            const updated = saveIntent({ ...intent, status: 'EXPIRED', paymentEndedStatus: existingStatus, paymentEndedAt: Date.now() })
            const error = new Error(`Invoice lama ${existing.merchantRef || intent.paymentRef} sudah berstatus ${existingStatus}. Pesanan ini tidak dibuat ulang otomatis; buat pesanan baru setelah memastikan invoice lama benar-benar final.`)
            error.legacyPurchaseInvoiceEnded = true
            error.intent = updated
            throw error
        }
        const reason = `Invoice pembelian dari versi lama (${existing.merchantRef || intent.paymentRef}) masih berstatus ${existingStatus || 'PENDING'} melalui gateway lama. Bot tidak akan menampilkan ulang invoice atau membuat invoice NationalPay baru untuk pembelian. Jangan bayar QR lama; owner harus memeriksa/membatalkan invoice lama sebelum metode pembayaran diganti.`
        const updated = saveIntent({ ...intent, status: 'QRIS_REVIEW_REQUIRED', reviewReason: reason, reviewAt: Date.now() })
        const error = new Error(reason)
        error.paymentReviewRequired = true
        throw error
    }
    if (intent.status === 'FULFILLED') return { intent, existing: true }
    if (intent.status === 'FAILED_REFUNDED') throw new Error('Pesanan ini sudah selesai dengan pengembalian nilai. Buat pesanan baru jika ingin membeli lagi.')
    if (locks.get(intent.token)) throw new Error('Pesanan ini sedang diproses. Tunggu hasilnya sebelum menekan tombol lagi.')
    if (!['AWAITING_METHOD', 'QRIS_CREATING', 'WAITING_PAYMENT'].includes(String(intent.status || '').toUpperCase())) {
        throw new Error(`Pesanan sudah berstatus ${intent.status}; metode QRIS tidak dapat dibuat.`)
    }

    // IMPORTANT: current documented RuangOTP API exposes /deposit/create (provider-wallet
    // funding), not an order-specific buyer invoice; VIPayment's documented order API
    // similarly has no dynamic customer invoice endpoint. Treating either provider's
    // wallet deposit as a product payment can misroute buyer funds. NationalPay is only
    // the bot-wallet deposit gateway. Fail closed until a real provider checkout/status
    // API is supplied; no HTTP request or charge is created by this branch.
    const provider = intent.type === 'NOKOS' ? 'RuangOTP' : 'VIPayment'
    const message = intent.type === 'NOKOS'
        ? 'QRIS pembelian langsung RuangOTP belum tersedia melalui API yang terdokumentasi. Endpoint /deposit/create milik RuangOTP menambah saldo akun provider, bukan membuat invoice produk. Agar dana buyer tidak salah diarahkan, bot tidak membuat QRIS dari endpoint deposit. Gunakan saldo deposit bot sementara.'
        : 'API VIPayment yang dikonfigurasi menyediakan pemesanan/status produk, tetapi tidak menyediakan endpoint API invoice QRIS pembelian langsung yang dapat diverifikasi oleh bot. NasionalPay tidak digunakan untuk pembelian. Gunakan saldo deposit bot sementara sampai API pembayaran resmi VIPayment tersedia.'
    const error = new Error(`${provider}: ${message}`)
    error.providerPaymentUnavailable = true
    error.definiteFailure = true
    throw error
}

async function handlePaidPayment(tx) {
    const orderRef = String(tx?.orderRef || tx?.merchantRef || '').toUpperCase()
    let intent = getIntent(orderRef)
    if (!intent) {
        const item = Array.isArray(tx?.items) ? tx.items.find(x => x && x.purchaseToken) : null
        if (item?.purchaseToken && item.details && item.purchaseType) {
            intent = saveIntent({
                token: String(item.purchaseToken).toUpperCase(), type: String(item.purchaseType).toUpperCase(),
                jid: tx.jid, source: item.source || 'whatsapp', telegramId: String(item.telegramId || ''),
                pushname: tx.pushname || '', amount: Math.floor(Number(item.price || tx.amount || 0)),
                label: item.name || item.purchaseType, details: item.details,
                status: 'QRIS_PAID', paymentMethod: 'QRIS', paymentRef: tx.merchantRef,
                orderRef: '', createdAt: tx.createdAt || Date.now(), expiresAt: Number.MAX_SAFE_INTEGER,
                recoveredFromInvoice: true
            })
        }
    }
    if (!intent) {
        const error = new Error(`Intent pembelian untuk invoice ${orderRef} tidak ditemukan; jangan proses otomatis tanpa detail pembelian.`)
        error.fulfillmentPaused = true
        throw error
    }
    const currentStatus = String(intent.status || '').toUpperCase()
    if (['FULFILLED', 'FAILED_REFUNDED', 'REVIEW_REQUIRED', 'QRIS_REVIEW_REQUIRED', 'PROVIDER_PROCESSING', 'BALANCE_PROCESSING'].includes(currentStatus)) {
        return {
            intent, type: intent.type, already: true,
            success: currentStatus === 'FULFILLED', failed: currentStatus === 'FAILED_REFUNDED',
            refunded: currentStatus === 'FAILED_REFUNDED',
            reviewRequired: ['REVIEW_REQUIRED', 'QRIS_REVIEW_REQUIRED', 'PROVIDER_PROCESSING', 'BALANCE_PROCESSING'].includes(currentStatus),
            message: intent.reviewReason || 'Transaksi memerlukan rekonsiliasi sebelum diproses.'
        }
    }
    if (['EXPIRED', 'CANCELLED', 'CANCELED'].includes(currentStatus)) {
        // A QRIS invoice can occasionally settle after its local expiry/cancel state.
        // Do not create the product twice; preserve the buyer's value as bot-wallet
        // credit and alert them that the original invoice was paid late.
        const credit = applyCreditOnce(intent.jid || tx.jid, amountOf(intent), `purchase-refund:${intent.token}`, 'Pembayaran QRIS terlambat setelah pesanan berakhir')
        const refundedIntent = saveIntent({ ...intent, status: 'FAILED_REFUNDED', refunded: true, refundAt: Date.now(), refundReason: 'late_qris_payment_after_expiry', latePayment: true })
        return { intent: refundedIntent, type: intent.type, already: Boolean(credit.duplicate), failed: true, refunded: true, latePayment: true, creditedNow: Boolean(credit.applied), message: 'Invoice QRIS dibayar setelah pesanan dinyatakan berakhir; nominal diamankan ke saldo bot dan tidak dibuat order baru.' }
    }
    intent = saveIntent({ ...intent, status: 'QRIS_PAID', paymentMethod: 'QRIS', paymentRef: tx.merchantRef, paidAt: intent.paidAt || Date.now() })
    return fulfillIntent(intent, 'QRIS')
}

async function cancelQrPayment(value, jid) {
    const intent = ownedIntent(value, jid)
    if (String(intent.status || '').toUpperCase() !== 'WAITING_PAYMENT' || !intent.paymentRef) {
        throw new Error(`Invoice tidak berada pada status menunggu pembayaran (${intent.status || 'unknown'}). Pembatalan otomatis tidak aman untuk status ini.`)
    }
    const payment = depositService.get(intent.paymentRef)
    if (!payment) throw new Error('Data invoice tidak ditemukan; owner harus memeriksa gateway sebelum transaksi diubah.')
    const expectedKind = intent.type === 'NOKOS' ? 'NOKOS_ORDER' : intent.type === 'TOPUP' ? 'TOPUP_ORDER' : ''
    if (!expectedKind || String(payment.kind || '').toUpperCase() !== expectedKind || String(payment.jid || '') !== String(jid || '')) {
        throw new Error('Invoice tidak cocok dengan token atau jenis pembelian ini. Pembatalan ditolak demi keamanan transaksi.')
    }
    const paymentStatus = String(payment.status || '').toUpperCase()
    if (['PAID', 'SUCCESS', 'SETTLED'].includes(paymentStatus)) {
        throw new Error('Pembayaran sudah terdeteksi. Jangan batalkan; cek status pembelian dan hubungi owner bila belum diproses.')
    }
    const canceledPayment = await depositService.cancel(intent.paymentRef, jid)
    const updatedIntent = saveIntent({
        ...intent,
        status: 'CANCELLED',
        cancelledAt: Date.now(),
        paymentEndedStatus: String(canceledPayment.status || 'CANCELED').toUpperCase(),
        paymentEndedAt: Date.now()
    })
    return { intent: updatedIntent, payment: canceledPayment }
}

async function refundFailedTopup(tx) {
    const existing = topupService.getTransaction(tx?.ref || tx?.localRef)
    if (!existing || !['gagal', 'error'].includes(String(existing.status || '').toLowerCase()) || existing.refunded || !existing.charged) return null
    const intent = existing.purchaseToken ? getIntent(existing.purchaseToken) : null
    const key = intent ? `purchase-refund:${intent.token}` : `topup-status-refund:${existing.localRef || existing.ref}`
    const result = applyCreditOnce(existing.jid, Math.floor(Number(existing.sellingPrice || 0)), key, 'Refund top up gagal')
    const updated = topupService.updateTransaction(existing.ref || existing.localRef, { refunded: true, refundReason: existing.message || 'provider_status_failed', updatedAt: Date.now() })
    if (intent) saveIntent({ ...intent, refunded: true, status: 'FAILED_REFUNDED', refundAt: Date.now(), refundReason: existing.message || 'provider_status_failed' })
    return { transaction: updated, creditedNow: Boolean(result.applied), alreadyRefunded: Boolean(result.duplicate) }
}

function setPaidFulfillmentHandler(fn) { paidFulfillmentHandler = typeof fn === 'function' ? fn : null }
async function notifyPaidFulfillment(result) {
    if (paidFulfillmentHandler && result) return paidFulfillmentHandler(result)
    return result
}


function setNotificationHandlers({ sendBuyer, notifyOwner } = {}) {
    sendBuyerHandler = typeof sendBuyer === 'function' ? sendBuyer : sendBuyerHandler
    notifyOwnerHandler = typeof notifyOwner === 'function' ? notifyOwner : notifyOwnerHandler
}

function startNokosWatcher(order) {
    if (!order?.ref || !(order.providerTransactionId || order.orderId || order.activationId)) return false
    const ref = String(order.ref).toUpperCase()
    if (nokosWatchers.has(ref)) return false
    const status = String(order.status || '').toLowerCase()
    if (!['waiting', 'wait_code', 'pending', 'processing', 'cancel_requested'].includes(status)) return false

    const run = async () => {
        try {
            const result = await nokosService.waitForOtp(
                order.providerTransactionId || order.orderId || order.activationId,
                Number(global.nokosConfig?.otpTimeoutMs || 20 * 60 * 1000),
                Number(global.nokosConfig?.pollIntervalMs || 5000)
            )
            const latest = nokosService.getOrder(ref)
            if (!latest || latest.refunded || ['cancelled', 'expired', 'failed'].includes(String(latest.status || '').toLowerCase())) return
            const updated = nokosService.updateOrder(ref, {
                status: 'received', otp: result.code || null, sms: result.sms || null,
                receivedAt: Date.now(), providerStatus: result.status || 'received'
            }) || { ...latest, status: 'received', otp: result.code || null, sms: result.sms || null }
            const message = `📨 OTP NOKOS MASUK\n\nRef: ${updated.ref}\nNomor: ${updated.phone || '-'}\nOTP: ${result.code || '-'}${result.sms ? `\nSMS: ${result.sms}` : ''}\nStatus: DITERIMA`
            if (sendBuyerHandler) await sendBuyerHandler(updated.jid, message).catch(err => console.error('[NOKOS OTP BUYER NOTICE]', err?.message || err))
            if (notifyOwnerHandler) await notifyOwnerHandler({
                type: 'NOKOS OTP', ref: updated.ref, customerName: updated.pushname || updated.telegramId || '-',
                customerJid: updated.jid, service: updated.service, country: updated.country,
                provider: updated.provider, providerId: updated.providerId, phone: updated.phone,
                activationId: updated.activationId, sellingPrice: updated.sellingPrice,
                providerPrice: updated.providerCost, profit: Number(updated.sellingPrice || 0) - Number(updated.providerCost || 0),
                status: 'OTP RECEIVED', otp: result.code || '-', refunded: Boolean(updated.refunded), createdAt: updated.createdAt
            }).catch(err => console.error('[NOKOS OTP OWNER NOTICE]', err?.message || err))
        } catch (error) {
            const latest = nokosService.getOrder(ref)
            if (!latest || latest.refunded || latest.otp || latest.receivedAt || !['waiting', 'wait_code', 'pending', 'processing', 'cancel_requested'].includes(String(latest.status || '').toLowerCase())) return
            const providerStatus = String(error?.status || '').toLowerCase()
            const tellBuyer = async message => {
                if (sendBuyerHandler) await sendBuyerHandler(latest.jid, message).catch(err => console.error('[NOKOS WATCHER BUYER NOTICE]', err?.message || err))
            }
            const tellOwner = async (status, note = '') => {
                if (notifyOwnerHandler) await notifyOwnerHandler({
                    type: 'NOKOS REFUND / CANCEL REVIEW', ref, customerName: latest.pushname || latest.telegramId || '-',
                    customerJid: latest.jid, service: latest.service, country: latest.country,
                    provider: latest.provider, providerId: latest.providerId, phone: latest.phone,
                    sellingPrice: latest.sellingPrice, providerPrice: latest.providerCost,
                    profit: Number(latest.sellingPrice || 0) - Number(latest.providerCost || 0),
                    status, refunded: Boolean(nokosService.getOrder(ref)?.refunded), note, createdAt: latest.createdAt
                }).catch(err => console.error('[NOKOS WATCHER OWNER NOTICE]', err?.message || err))
            }
            if (['expired', 'cancelled', 'failed'].includes(providerStatus)) {
                nokosService.updateOrder(ref, { status: providerStatus, providerStatus, autoRefundReason: providerStatus })
                const refund = nokosService.refundOnce(ref, providerStatus)
                if (refund) {
                    await tellBuyer(`⏰ Order NOKOS ${ref} berakhir menurut status provider (${providerStatus}). Refund Rp${Number(latest.sellingPrice || 0).toLocaleString('id-ID')} diproses ke saldo bot.`)
                    await tellOwner('REFUNDED', `Provider mengonfirmasi status ${providerStatus}.`)
                }
            } else if (providerStatus === 'timeout') {
                let result = null
                try { result = await nokosService.cancelOrderAndRefund(ref, 'otp_timeout') }
                catch (cancelError) { console.error('[NOKOS AUTO CANCEL VERIFY]', ref, cancelError?.message || cancelError) }
                if (result?.confirmed) {
                    await tellBuyer(`⏰ Order NOKOS ${ref} berakhir tanpa OTP dan status provider telah terkonfirmasi (${result.status}). Refund Rp${Number(latest.sellingPrice || 0).toLocaleString('id-ID')} diproses ke saldo bot.`)
                    await tellOwner('REFUNDED', `Status terminal provider terverifikasi: ${result.status}.`)
                } else {
                    const message = result?.message || 'Status pembatalan tidak dapat diverifikasi.'
                    await tellBuyer(`⚠️ Waktu tunggu OTP untuk ${ref} habis, tetapi provider belum mengonfirmasi pembatalan. Dana BELUM direfund. Jangan membeli ulang; owner akan memeriksa status provider.`)
                    await tellOwner('CANCEL_REVIEW_REQUIRED', message)
                    nokosService.updateOrder(ref, { status: 'cancel_requested', cancelRequestedAt: Date.now(), cancelVerificationError: message })
                    setTimeout(() => {
                        const fresh = nokosService.getOrder(ref)
                        if (fresh) startNokosWatcher(fresh)
                    }, 30000).unref?.()
                }
            } else {
                // Network/auth errors do not prove failure. Keep funds charged and
                // reconcile later; never auto-refund on an unknown provider state.
                console.error('[NOKOS WATCHER DEFERRED]', ref, error?.message || error)
                if (!latest.watcherErrorNoticeSentAt) {
                    const note = String(error?.message || error || 'Status provider belum dapat dipastikan.')
                    nokosService.updateOrder(ref, { watcherLastError: note, watcherErrorNoticeSentAt: Date.now() })
                    await tellBuyer(`⚠️ Status NOKOS ${ref} sementara tidak dapat diverifikasi. Dana/order tetap tercatat dan tidak akan direfund otomatis tanpa bukti gagal. Jangan membeli ulang; owner sudah diberi tahu untuk memeriksa provider.`)
                    await tellOwner('STATUS_REVIEW_REQUIRED', note)
                } else {
                    nokosService.updateOrder(ref, { watcherLastError: String(error?.message || error), watcherLastErrorAt: Date.now() })
                }
                setTimeout(() => {
                    const fresh = nokosService.getOrder(ref)
                    if (fresh) startNokosWatcher(fresh)
                }, 30000).unref?.()
            }
        } finally {
            nokosWatchers.delete(ref)
        }
    }
    const running = run()
    nokosWatchers.set(ref, running)
    return true
}

function resumeNokosWatchers() {
    const rows = nokosService.listOrders(null, 10000)
    let started = 0
    for (const order of rows) if (startNokosWatcher(order)) started++
    return started
}

function listIntents(statuses = null) {
    const wanted = Array.isArray(statuses) ? new Set(statuses.map(x => String(x).toUpperCase())) : null
    return Object.values(loadDb()).filter(item => !wanted || wanted.has(String(item.status || '').toUpperCase()))
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
}

module.exports = {
    createIntent, getIntent, saveIntent, ownedIntent, buyWithBalance, createQrPayment,
    cancelQrPayment, handlePaidPayment, refundFailedTopup, setPaidFulfillmentHandler, notifyPaidFulfillment,
    listIntents, isDefinitelyRejected, refundPurchase,
    setNotificationHandlers, startNokosWatcher, resumeNokosWatchers
}
