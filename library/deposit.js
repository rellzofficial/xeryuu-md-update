'use strict'

const axios = require('axios')
const QRCode = require('qrcode')
const crypto = require('crypto')
const economy = require('./economy.js')
const { saveGlobalDatabase } = require('./global-database.js')

let sender = null
let paidHandler = null
let poller = null

const checkInFlight = new Map()
const createInFlight = new Map()
const paidHandlerInFlight = new Map()

function cfg() {
    return global.depositConfig || {}
}

function formatMoney(value) {
    return Number(value || 0).toLocaleString('id-ID')
}

function makeRef() {
    return `DEP${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`
}

function ensureDb() {
    if (!global.db) global.db = {}
    if (!global.db.deposits || typeof global.db.deposits !== 'object' || Array.isArray(global.db.deposits)) {
        global.db.deposits = {}
    }
    return global.db.deposits
}

function get(ref) {
    return ensureDb()[String(ref || '').toUpperCase()] || null
}

function save(tx) {
    const database = ensureDb()
    const key = String(tx.merchantRef).toUpperCase()
    const previous = database[key]
    database[key] = tx
    // Persist invoice references and paid/fulfillment states synchronously. If a
    // new invoice cannot be stored durably, remove it from memory and fail closed;
    // createQrPayment will pause for owner review instead of exposing an invoice
    // that the bot cannot later reconcile after restart.
    if (!saveGlobalDatabase()) {
        if (previous) database[key] = previous
        else delete database[key]
        throw new Error('Gagal menyimpan database pembayaran secara persisten. Transaksi perlu diperiksa; jangan membuat invoice ulang.')
    }
    return tx
}

// Simpan referensi pesan QRIS WhatsApp secara persisten agar pesan QR dan
// kontrol transaksinya bisa dihapus sesudah pembatalan, termasuk setelah restart.
function sanitizeWaMessageKey(value) {
    if (!value || typeof value !== 'object' || !value.id) return null
    const key = {
        id: String(value.id),
        remoteJid: String(value.remoteJid || ''),
        fromMe: value.fromMe !== false
    }
    if (value.participant) key.participant = String(value.participant)
    return key
}

function updateMessageReferences(ref, references = {}) {
    const tx = get(ref)
    if (!tx) throw new Error('Invoice pembayaran tidak ditemukan.')
    const next = { ...tx }
    for (const field of ['qrMessageKey', 'controlMessageKey']) {
        if (!Object.prototype.hasOwnProperty.call(references, field)) continue
        next[field] = sanitizeWaMessageKey(references[field])
    }
    if (Object.prototype.hasOwnProperty.call(references, 'telegramMessageRefs')) {
        const rawRefs = Array.isArray(references.telegramMessageRefs) ? references.telegramMessageRefs : []
        next.telegramMessageRefs = rawRefs.slice(0, 8).map(item => ({
            chatId: String(item?.chatId || '').slice(0, 80),
            messageId: Number(item?.messageId)
        })).filter(item => item.chatId && Number.isSafeInteger(item.messageId) && item.messageId > 0)
    }
    if (Object.prototype.hasOwnProperty.call(references, 'messagesDeletedAt')) {
        next.messagesDeletedAt = references.messagesDeletedAt == null ? null : Number(references.messagesDeletedAt)
    }
    return save(next)
}

function providerKey() {
    return 'nasionalpay'
}

function providerConfig() {
    const root = cfg().providers || {}
    const raw = root.nasionalpay || {}
    const np = global.nasionalPayConfig || {}
    return {
        key: 'nasionalpay',
        name: String(raw.name || 'NasionalPay'),
        driver: 'nasionalpay',
        enabled: raw.enabled !== false && np.enabled !== false && cfg().enabled !== false,
        baseUrl: String(raw.baseUrl || np.baseUrl || 'https://merchant.nasionalpay.com/api/payment').trim().replace(/\/$/, ''),
        storeKey: String(raw.storeKey || np.storeKey || '').trim(),
        minAmount: Number(raw.minAmount || np.minAmount || cfg().minAmount || 1000),
        maxAmount: Number(raw.maxAmount || np.maxAmount || cfg().maxAmount || 10000000),
        expiresInMinutes: Number(raw.expiresInMinutes || np.expiresInMinutes || cfg().expiresInMinutes || 10),
        timeoutMs: Number(raw.timeoutMs || np.timeoutMs || cfg().timeoutMs || 20000),
        pollIntervalMs: Number(raw.pollIntervalMs || np.pollIntervalMs || cfg().pollIntervalMs || 5000),
        routes: {
            create: raw.routes?.create || np.routes?.create || '/generate',
            status: raw.routes?.status || np.routes?.status || '/status',
            cancel: raw.routes?.cancel || np.routes?.cancel || ''
        }
    }
}

function minAmount() {
    const n = Number(providerConfig().minAmount)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000
}

function maxAmount() {
    const n = Number(providerConfig().maxAmount)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10000000
}

function providerName() {
    return providerConfig().name
}

function supportsAutomaticDeposit() {
    const provider = providerConfig()
    return Boolean(provider.enabled && provider.baseUrl && provider.storeKey)
}

function ready() {
    const provider = providerConfig()
    return Boolean(provider.enabled && provider.baseUrl && provider.storeKey)
}

function headers(extra = {}) {
    return {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...extra
    }
}

function unwrap(body) {
    if (!body || typeof body !== 'object') return body
    if (body.data !== undefined && body.data !== null) return body.data
    if (body.result !== undefined && body.result !== null) return body.result
    if (body.response !== undefined && body.response !== null) return body.response
    return body
}

function first(obj, keys, fallback = undefined) {
    for (const key of keys) {
        const value = key.split('.').reduce((acc, part) => acc == null ? undefined : acc[part], obj)
        if (value !== undefined && value !== null && value !== '') return value
    }
    return fallback
}

function numeric(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function parseExpiry(value, fallback) {
    if (value == null || value === '') return fallback
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) {
        return n < 100000000000 ? Math.floor(n * 1000) : Math.floor(n)
    }
    const parsed = new Date(value).getTime()
    return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeStatus(value) {
    const status = String(value || '').toLowerCase().replace(/[-\s]+/g, '_')
    if (['paid', 'success', 'succeeded', 'settled', 'completed', 'done', 'success_payment'].includes(status)) return 'PAID'
    if (['pending', 'unpaid', 'waiting', 'wait', 'processing', 'created', 'unpaid_payment'].includes(status)) return 'UNPAID'
    if (['expired', 'expire'].includes(status)) return 'EXPIRED'
    if (['cancel', 'cancelled', 'canceled'].includes(status)) return 'CANCELED'
    if (['failed', 'failure', 'error'].includes(status)) return 'FAILED'
    return String(value || 'UNPAID').toUpperCase()
}

function parseDeposit(body, defaults = {}) {
    const root = unwrap(body) || {}

    // NasionalPay mengembalikan amount sebagai nominal yang harus dibayar.
    const baseAmount = numeric(first(root, [
        'amount',
        'gross_amount',
        'grossAmount',
        'nominal',
        'deposit.amount'
    ], defaults.amount)) || Number(defaults.amount || 0)

    const finalAmount = numeric(first(root, [
        'payment_amount',
        'paymentAmount',
        'total_payment',
        'totalPayment',
        'charge_amount',
        'chargeAmount'
    ], null))

    const transactionId = String(first(root, [
        'trx_id',
        'trxId',
        'transaction_id',
        'transactionId',
        'deposit_id',
        'depositId',
        'id',
        'reference',
        'ref'
    ], defaults.gatewayId || '') || '')

    const status = normalizeStatus(first(root, [
        'status',
        'state',
        'payment_status',
        'paymentStatus'
    ], defaults.status || 'pending'))

    const merchantRef = String(
        defaults.merchantRef ||
        first(root, ['external_id', 'externalId', 'merchant_ref', 'merchantRef'], '') ||
        makeRef()
    )

    const fallbackExpiry =
        Date.now() +
        Number(defaults.expiresInMinutes || providerConfig().expiresInMinutes || 10) * 60000

    const qrisData = first(root, [
        'qris_data',
        'qrisData',
        'qris_string',
        'qrisString',
        'qr_string',
        'qrString',
        'qr_code',
        'qris'
    ], defaults.qrString || null)

    return {
        ...root,
        merchantRef,
        gatewayId: transactionId,
        depositId: transactionId,
        externalId: String(first(root, ['external_id', 'externalId'], merchantRef)),
        reference: String(first(root, ['reference', 'ref'], merchantRef)),
        jid: defaults.jid || root.jid,
        amount: baseAmount,
        paymentAmount: finalAmount || baseAmount,
        totalPay: finalAmount || baseAmount,
        method: 'QRIS',
        paymentName: 'QRIS',
        qrString: typeof qrisData === 'string' ? qrisData : (defaults.qrString || null),
        qrImage: first(root, [
            'qris_image',
            'qrisImage',
            'qr_image',
            'qrImage',
            'qr_url',
            'qrUrl',
            'data_url',
            'dataUrl'
        ], defaults.qrImage || null),
        checkoutUrl: first(root, [
            'checkout_url',
            'checkoutUrl',
            'payment_url',
            'paymentUrl',
            'url'
        ], defaults.checkoutUrl || null),
        finalAmount: finalAmount || baseAmount,
        uniqueSuffix: numeric(first(root, ['unique_suffix', 'uniqueSuffix'], null)),
        status,
        credited: Boolean(defaults.credited),
        kind: String(defaults.kind || 'DEPOSIT').toUpperCase(),
        orderRef: String(defaults.orderRef || merchantRef),
        createdAt: defaults.createdAt || Date.now(),
        expiredAt: parseExpiry(
            first(root, ['expired_at', 'expiredAt', 'expires_at', 'expiresAt', 'expiry'], null),
            defaults.expiredAt || fallbackExpiry
        ),
        gatewayData: body
    }
}

function apiError(response, bodyOverride = null) {
    const body = bodyOverride ?? response?.data ?? {}
    const root = unwrap(body) || {}
    const message = first(root, [
        'error.message',
        'error',
        'errors.0.message',
        'message',
        'msg',
        'detail'
    ], `HTTP ${response?.status || 0}`)
    return String(message)
}

async function request(route, data) {
    const provider = providerConfig()
    if (!readyForRequest()) {
        throw Object.assign(new Error('NasionalPay belum dikonfigurasi. Periksa storeKey pada global.nasionalPayConfig di settings.js.'), { definiteFailure: true })
    }

    const payload = {
        key: provider.storeKey,
        ...data
    }

    const response = await axios({
        method: 'POST',
        url: `${provider.baseUrl}/${String(route).replace(/^\//, '')}`,
        data: payload,
        headers: headers(),
        timeout: provider.timeoutMs,
        validateStatus: () => true
    })

    if (response.status < 200 || response.status >= 300) {
        const error = new Error(apiError(response))
        error.status = response.status
        error.response = response
        throw error
    }

    const body = response.data || {}
    if (body?.success === false || body?.status === false) {
        const error = new Error(apiError(response, body))
        error.status = Number(response.status || 400)
        error.response = response
        throw error
    }

    return body
}

function readyForRequest() {
    const provider = providerConfig()
    return Boolean(provider.enabled && provider.baseUrl && provider.storeKey)
}

function findPending(jid, provider = '') {
    const expectedProvider = String(provider || '').trim().toLowerCase()

    return Object.values(ensureDb())
        .filter(tx => {
            if (!tx || tx.jid !== jid || tx.credited || !tx.gatewayId) return false

            const txProvider = String(tx.provider || providerKey()).trim().toLowerCase()
            if (expectedProvider && txProvider !== expectedProvider) return false
            if (txProvider !== providerKey()) return false

            return tx.kind === 'DEPOSIT' &&
                ['UNPAID', 'PENDING', 'PROCESSING', 'WAITING', 'CREATED'].includes(String(tx.status || '').toUpperCase()) &&
                (!tx.expiredAt || Number(tx.expiredAt) > Date.now())
        })
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
}

function findLatestPending(jid, provider = '') {
    return findPending(jid, provider)[0] || null
}

function findByOrderRef(orderRef) {
    const target = String(orderRef || '').toUpperCase()
    if (!target) return null
    return Object.values(ensureDb()).find(tx => String(tx?.orderRef || '').toUpperCase() === target) || null
}

function createPayment({
    jid,
    amount,
    pushname = 'Customer',
    kind = 'DEPOSIT',
    orderRef = '',
    items = null
}) {
    const normalizedKind = String(kind || 'DEPOSIT').toUpperCase()
    // NasionalPay is used for wallet deposits and Xeryuu Store orders (panel,
    // Jadibot, and bot rental). NOKOS and top-up are deliberately excluded here:
    // those products must continue using their own supported payment flow.
    if (!['DEPOSIT', 'STORE'].includes(normalizedKind)) {
        const error = new Error('NasionalPay tersedia untuk deposit saldo dan checkout Store (Panel/Jadibot/Sewa Bot). Pembelian Nokos dan Top Up harus memakai metode pembayaran yang didukung providernya.')
        error.definiteFailure = true
        error.providerPaymentUnavailable = true
        throw error
    }
    const key = String(`${jid}:${normalizedKind}:${amount}:${orderRef || ''}`)
    if (createInFlight.has(key)) return createInFlight.get(key)

    const promise = (async () => {
        const provider = providerConfig()
        const nominal = Math.floor(Number(amount))
        const requestedRef = String(orderRef || '').toUpperCase()
        if (requestedRef) {
            const existing = get(requestedRef) || findByOrderRef(requestedRef)
            if (existing) {
                if (String(existing.jid) !== String(jid) || String(existing.kind).toUpperCase() !== String(kind).toUpperCase() || Number(existing.amount) !== nominal) {
                    throw new Error('Referensi checkout sudah dipakai transaksi lain; buat checkout baru.')
                }
                return existing
            }
        }

        if (!Number.isSafeInteger(nominal) || nominal < minAmount() || nominal > maxAmount()) {
            throw Object.assign(new Error(`Nominal pembayaran harus Rp${formatMoney(minAmount())} - Rp${formatMoney(maxAmount())}.`), { definiteFailure: true })
        }

        if (!ready()) {
            throw Object.assign(new Error('NasionalPay belum siap. Periksa storeKey pada global.nasionalPayConfig di settings.js.'), { definiteFailure: true })
        }

        if (normalizedKind === 'DEPOSIT') {
            const pending = findLatestPending(jid)
            if (pending) {
                const error = new Error(`Masih ada deposit unpaid: ${pending.merchantRef}. Batalkan deposit tersebut sebelum membuat yang baru.`)
                error.code = 'PENDING_DEPOSIT'
                error.pendingRef = pending.merchantRef
                throw error
            }
        }

        const merchantRef = String(orderRef || makeRef())
        const raw = await request(provider.routes.create, {
            channel: 'QRIS',
            amount: nominal,
            player_username: merchantRef
        })

        const tx = parseDeposit(raw, {
            jid,
            amount: nominal,
            kind,
            orderRef: orderRef || merchantRef,
            merchantRef,
            pushname,
            createdAt: Date.now(),
            expiresInMinutes: provider.expiresInMinutes
        })

        if (!tx.gatewayId) throw new Error('NasionalPay tidak mengembalikan transaction_id/trx_id.')
        if (!tx.qrString && !tx.qrImage && !tx.checkoutUrl) throw new Error('NasionalPay tidak mengembalikan QRIS.')
        if (tx.amount !== nominal) {
            throw new Error(`Nominal QRIS NasionalPay tidak sama. Diminta Rp${formatMoney(nominal)}, diterima Rp${formatMoney(tx.amount)}.`)
        }

        tx.pushname = String(pushname || 'Customer')
        tx.items = Array.isArray(items) ? items : null
        tx.provider = 'nasionalpay'
        tx.providerName = provider.name
        tx.wallet = ''
        tx.walletName = 'Saldo Biasa'
        tx.status = normalizeStatus(tx.status)
        save(tx)

        if (tx.status === 'PAID') {
            // A provider can return PAID immediately after invoice creation. Do not
            // reject an already-created/paid invoice merely because fulfilment had a
            // transient error; callers must retain the paid invoice/order reference.
            try {
                await processStatus(tx, 'PAID', raw)
            } catch (error) {
                console.error('[PAYMENT IMMEDIATE FULFILLMENT]', tx.merchantRef, error?.stack || error)
            }
        }
        return get(tx.merchantRef) || tx
    })().finally(() => createInFlight.delete(key))

    createInFlight.set(key, promise)
    return promise
}

async function create(args) {
    return createPayment({ ...args, kind: 'DEPOSIT' })
}

async function qrBuffer(tx) {
    if (tx?.qrString) {
        return QRCode.toBuffer(String(tx.qrString), { width: 900, margin: 2 })
    }

    if (!tx?.qrImage) return null

    const value = String(tx.qrImage)
    if (/^data:image\//i.test(value)) return Buffer.from(value.split(',')[1], 'base64')

    if (/^https?:\/\//i.test(value)) {
        const response = await axios.get(value, {
            responseType: 'arraybuffer',
            timeout: 20000
        })
        return Buffer.from(response.data)
    }

    if (/^[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length > 100) {
        return Buffer.from(value.replace(/\s+/g, ''), 'base64')
    }

    return null
}

async function check(ref) {
    const key = String(ref || '').toUpperCase()
    if (checkInFlight.has(key)) return checkInFlight.get(key)

    const tx = get(key)
    if (!tx) throw new Error('Invoice pembayaran tidak ditemukan.')

    // Jangan mencoba meminta status invoice lama dari provider yang sudah dicopot.
    if (String(tx.provider || providerKey()).toLowerCase() !== providerKey()) {
        throw new Error('Invoice ini dibuat oleh gateway lama dan tidak lagi dikelola oleh bot.')
    }

    const provider = providerConfig()

    const promise = (async () => {
        const raw = await request(provider.routes.status, {
            transaction_id: tx.gatewayId
        })

        const parsed = parseDeposit(raw, {
            ...tx,
            jid: tx.jid,
            amount: tx.amount,
            merchantRef: tx.merchantRef,
            orderRef: tx.orderRef,
            createdAt: tx.createdAt,
            credited: tx.credited,
            expiredAt: tx.expiredAt,
            expiresInMinutes: provider.expiresInMinutes
        })

        Object.assign(tx, parsed, {
            merchantRef: tx.merchantRef,
            gatewayId: tx.gatewayId,
            depositId: tx.depositId || tx.gatewayId,
            amount: tx.amount,
            paymentAmount: parsed.paymentAmount || tx.paymentAmount,
            totalPay: parsed.totalPay || tx.totalPay,
            jid: tx.jid,
            kind: tx.kind,
            orderRef: tx.orderRef,
            createdAt: tx.createdAt,
            credited: tx.credited,
            provider: 'nasionalpay',
            providerName: provider.name,
            wallet: '',
            walletName: 'Saldo Biasa',
            qrString: tx.qrString || parsed.qrString,
            qrImage: tx.qrImage || parsed.qrImage,
            checkoutUrl: tx.checkoutUrl || parsed.checkoutUrl,
            expiredAt: parsed.expiredAt || tx.expiredAt,
            status: normalizeStatus(parsed.status)
        })

        save(tx)
        await processStatus(tx, tx.status, raw)
        return get(tx.merchantRef) || tx
    })().finally(() => checkInFlight.delete(key))

    checkInFlight.set(key, promise)
    return promise
}

async function processStatus(tx, status, raw = {}) {
    if (!tx) return tx
    const normalized = normalizeStatus(status)
    tx.updatedAt = Date.now()
    tx.gatewayData = raw

    if (['PAID', 'SUCCESS', 'SETTLED'].includes(normalized)) {
        const kind = String(tx.kind || 'DEPOSIT').toUpperCase()
        if (tx.cancelledLocally && kind === 'DEPOSIT') {
            // A local cancel cannot invalidate a QR already saved by the payer.
            // If the gateway later confirms that this invoice was actually paid,
            // credit the exact invoice amount to the user's bot wallet, idempotently.
            // This is safer than silently withholding money or crediting twice.
            const amount = Math.floor(Number(tx.amount || 0))
            if (!tx.credited) {
                const credit = economy.applyMoneyTransaction(
                    tx.jid,
                    amount,
                    `deposit-credit:${tx.merchantRef}`,
                    'Deposit QRIS terlambat terkonfirmasi setelah pembatalan lokal'
                )
                tx.credited = true
                tx.creditedAmount = amount
                tx.balanceAfter = Number(credit?.balance ?? economy.getBalance(tx.jid))
                tx.depositCreditTransactionKey = `deposit-credit:${tx.merchantRef}`
                tx.wallet = ''
                tx.walletName = 'Saldo Biasa'
            }
            tx.status = 'PAID'
            tx.paidAt = tx.paidAt || Date.now()
            tx.latePaidAt = tx.latePaidAt || Date.now()
            tx.latePaidAfterCancel = true
            save(tx)
            if (!tx.latePaidNoticeSent && sender) {
                tx.latePaidNoticeSent = true
                save(tx)
                await sender(tx.jid,
                    `⚠️ *PEMBAYARAN TERDETEKSI SETELAH PEMBATALAN*\n\n` +
                    `Invoice: *${tx.merchantRef}*\n` +
                    `Nominal terkonfirmasi: *Rp${formatMoney(amount)}*\n` +
                    `Karena QR sempat dibayar setelah dibatalkan di bot, nominal telah ditambahkan ke Saldo Biasa agar dana tidak hilang.\n` +
                    `Saldo sekarang: *Rp${formatMoney(tx.balanceAfter)}*\n` +
                    `Simpan referensi invoice ini jika perlu bantuan.`
                ).catch(() => {})
            }
            return tx
        }

        tx.status = 'PAID'
        tx.paidAt = tx.paidAt || Date.now()
        if (kind === 'DEPOSIT') {
            if (!tx.credited) {
                const credit = economy.applyMoneyTransaction(tx.jid, Math.floor(Number(tx.amount || 0)), `deposit-credit:${tx.merchantRef}`, 'Deposit QRIS')
                tx.credited = true
                tx.creditedAmount = Number(tx.amount || 0)
                tx.balanceAfter = credit.balance
                tx.wallet = ''
                tx.walletName = 'Saldo Biasa'
                tx.depositCreditTransactionKey = `deposit-credit:${tx.merchantRef}`
                save(tx)
            } else {
                save(tx)
            }
            if (!tx.depositNoticeSent && sender) {
                tx.depositNoticeSent = true
                save(tx)
                await sender(tx.jid,
                    `> ✅ *DEPOSIT BERHASIL*\n> \n` +
                    `> 🧾 Invoice: *${tx.merchantRef}*\n` +
                    `> 🏦 Gateway: *NasionalPay*\n` +
                    `> 💰 Deposit: *Rp${formatMoney(tx.amount)}*\n` +
                    `> 💳 Saldo Biasa: *Rp${formatMoney(tx.balanceAfter ?? economy.getBalance(tx.jid))}*`
                ).catch(() => {})
            }
            return tx
        }

        // Non-deposit invoices are order-specific payments. Do not mark them as
        // wallet-credited; fulfilment must be retried safely after restart until
        // it succeeds or the purchase module explicitly pauses for manual review.
        save(tx)
        if (!paidHandler || tx.handlerProcessedAt || tx.fulfillmentPaused) return tx
        const key = String(tx.merchantRef || '').toUpperCase()
        if (paidHandlerInFlight.has(key)) return paidHandlerInFlight.get(key)
        const handlerPromise = (async () => {
            tx.handlerAttempts = Number(tx.handlerAttempts || 0) + 1
            tx.handlerLastStartedAt = Date.now()
            save(tx)
            try {
                const result = await paidHandler(tx)
                if (result?.reviewRequired || result?.paused || String(result?.intent?.status || '').toUpperCase() === 'REVIEW_REQUIRED') {
                    tx.fulfillmentPaused = true
                    tx.fulfillmentError = result?.message || result?.intent?.reviewReason || 'Memerlukan pemeriksaan manual.'
                } else {
                    tx.handlerProcessedAt = Date.now()
                    tx.fulfillmentPaused = false
                    tx.fulfillmentError = ''
                }
                save(tx)
                return result || tx
            } catch (error) {
                tx.fulfillmentError = String(error?.message || error)
                tx.fulfillmentPaused = Boolean(error?.fulfillmentPaused)
                tx.handlerLastErrorAt = Date.now()
                save(tx)
                console.error('[PAYMENT FULFILLMENT]', tx.merchantRef, error?.stack || error)
                throw error
            }
        })().finally(() => paidHandlerInFlight.delete(key))
        paidHandlerInFlight.set(key, handlerPromise)
        return handlerPromise
    }

    tx.status = tx.cancelledLocally ? 'CANCELED' : normalized
    save(tx)
    return tx
}

async function cancel(ref, requesterJid = '') {
    let tx = get(ref)
    if (!tx) throw new Error('Invoice pembayaran tidak ditemukan.')
    if (requesterJid && tx.jid !== requesterJid) throw new Error('Invoice ini bukan milik kamu.')

    // Refresh provider status before local cancellation where possible. Status
    // refresh is best-effort because cancelling the bot-side view must remain
    // available during a gateway outage; any payment discovered later is safely
    // credited by processStatus() through the idempotent wallet ledger above.
    const stateAtStart = String(tx.status || '').toUpperCase()
    if (!['PAID', 'SUCCESS', 'SETTLED'].includes(stateAtStart) && !tx.credited && tx.gatewayId) {
        try { await check(tx.merchantRef) }
        catch (error) { console.error('[DEPOSIT CANCEL STATUS CHECK]', tx.merchantRef, error?.message || error) }
        tx = get(tx.merchantRef) || tx
    }

    const state = String(tx.status || '').toUpperCase()
    if (tx.credited || ['PAID', 'SUCCESS', 'SETTLED'].includes(state)) {
        throw new Error('Transaksi sudah dibayar dan tidak bisa dibatalkan.')
    }
    if (['EXPIRED', 'FAILED', 'REFUNDED'].includes(state)) {
        throw new Error(`Transaksi sudah berstatus ${state}.`)
    }
    if (state === 'CANCELED') return tx

    const provider = providerConfig()

    // NasionalPay menyediakan endpoint generate/status pada dokumentasi publik.
    // Karena endpoint cancel tidak didokumentasikan secara publik, pembatalan di bot
    // dilakukan secara lokal; QR yang sudah dibuat tetap menunggu expiry di provider.
    if (provider.routes.cancel) {
        try {
            const raw = await request(provider.routes.cancel, {
                transaction_id: tx.gatewayId
            })

            const parsed = parseDeposit(raw, {
                ...tx,
                merchantRef: tx.merchantRef,
                amount: tx.amount
            })

            const providerState = normalizeStatus(parsed.status)
            if (['PAID', 'SUCCESS', 'SETTLED'].includes(providerState)) {
                throw new Error('NasionalPay melaporkan invoice sudah dibayar.')
            }

            tx.gatewayData = raw
            tx.providerStatus = parsed.status
        } catch (e) {
            if (Number(e?.status) !== 404 && Number(e?.status) !== 405) throw e
        }
    }

    tx.status = 'CANCELED'
    tx.cancelledAt = Date.now()
    tx.cancelledLocally = true
    save(tx)
    return tx
}

function startPoller() {
    if (poller) return poller

    const interval = Math.max(3000, Number(providerConfig().pollIntervalMs || 5000))

    poller = setInterval(async () => {
        try {
            for (const tx of Object.values(ensureDb())) {
                if (!tx || !tx.gatewayId) continue
                if (String(tx.provider || providerKey()).toLowerCase() !== providerKey()) continue
                const kind = String(tx.kind || 'DEPOSIT').toUpperCase()
                const state = String(tx.status || '').toUpperCase()
                if (kind === 'DEPOSIT' && tx.credited) continue
                if (kind !== 'DEPOSIT' && (tx.handlerProcessedAt || tx.fulfillmentPaused)) continue
                if (['FAILED', 'REFUNDED'].includes(state)) continue
                if (state === 'CANCELED' && !tx.cancelledLocally) continue

                try {
                    // Always ask the gateway once at/after expiry before marking
                    // an invoice expired. A payment that lands at the boundary
                    // must not be silently discarded by local clock drift.
                    const latest = await check(tx.merchantRef)
                    if (latest && ['UNPAID', 'PENDING', 'PROCESSING', 'CREATED', 'WAITING'].includes(String(latest.status || '').toUpperCase()) && latest.expiredAt && Number(latest.expiredAt) <= Date.now()) {
                        latest.status = 'EXPIRED'
                        latest.expiredLocallyAt = Date.now()
                        save(latest)
                    }
                } catch (error) {
                    console.error('[DEPOSIT POLL]', error?.message || error)
                }
            }
        } catch (error) {
            console.error('[DEPOSIT POLLER]', error?.message || error)
        }
    }, interval)

    return poller
}

function setSender(fn) {
    sender = fn
}

function setPaidHandler(fn) {
    paidHandler = fn
}

module.exports = {
    ready,
    formatMoney,
    minAmount,
    maxAmount,
    providerName,
    providerConfig,
    supportsAutomaticDeposit,
    findLatestPending,
    findPending,
    findByOrderRef,
    create,
    createPayment,
    qrBuffer,
    check,
    get,
    cancel,
    updateMessageReferences,
    processStatus,
    startPoller,
    setSender,
    setPaidHandler
}
