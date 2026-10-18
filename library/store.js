'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const economy = require('./economy.js')
const depositService = require('./deposit.js')
const sewaService = require('./sewa.js')
const jadibotService = require('./jadibot.js')
const { migrateLegacyCwdDatabaseFile } = require('./global-database.js')
for (const fileName of ['store-orders.json', 'store-rentals.json', 'store-inventory.json']) {
    migrateLegacyCwdDatabaseFile(fileName)
}

const BASE = path.join(__dirname, 'database')
const ORDER_FILE = path.join(BASE, 'store-orders.json')
const RENTAL_FILE = path.join(BASE, 'store-rentals.json')
const INVENTORY_FILE = path.join(BASE, 'store-inventory.json')

let sender = null
let ownerSender = null
let ownerTelegramSender = null
let contactSender = null
let waConnection = null
let monitor = null
const paidInFlight = new Map()

function cfg() {
    return global.storeConfig || {}
}

function escapeTelegram(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function formatMoney(n) {
    return Number(n || 0).toLocaleString('id-ID')
}

function ensureFile(file, fallback) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2))
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : fallback
    } catch {
        return fallback
    }
}

function saveFile(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
}

function loadOrders() { return ensureFile(ORDER_FILE, {}) }
function loadRentals() { return ensureFile(RENTAL_FILE, {}) }
function saveOrders(data) { saveFile(ORDER_FILE, data) }
function saveRentals(data) { saveFile(RENTAL_FILE, data) }

function configuredStock(key, value) {
    const raw = value?.stock ?? value?.stockCount
    if (raw == null || raw === '') return 1
    const n = Number(raw)
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 1
}

function isPaidOrder(order) {
    return String(order?.paymentStatus || '').toUpperCase() === 'PAID' || Number(order?.paidAt || 0) > 0
}

function isTerminalUnpaidOrder(order) {
    const status = String(order?.status || '').toUpperCase()
    const paymentStatus = String(order?.paymentStatus || '').toUpperCase()
    return ['CANCELED', 'CANCELLED', 'PAYMENT_FAILED', 'FAILED', 'EXPIRED', 'REFUNDED'].includes(status) ||
        ['CANCELED', 'CANCELLED', 'PAYMENT_FAILED', 'FAILED', 'EXPIRED', 'REFUNDED'].includes(paymentStatus)
}

function isOpenUnpaidOrder(order) {
    return Boolean(order?.ref) && !isPaidOrder(order) && !isTerminalUnpaidOrder(order)
}

function stockReservationTimeoutMs() {
    return Math.max(60_000, Number(cfg().stockReservationTimeoutMs || 20 * 60 * 1000))
}

function loadInventoryState() {
    const inventory = ensureFile(INVENTORY_FILE, { products: {} })
    if (!inventory.products || typeof inventory.products !== 'object' || Array.isArray(inventory.products)) {
        inventory.products = {}
    }
    const orders = loadOrders()
    let changed = false
    let ordersChanged = false
    const now = Date.now()
    const graceMs = Math.max(0, Number(cfg().stockReservationGraceMs ?? 2 * 60 * 1000))

    for (const [key, rawProduct] of Object.entries(global.storeProducts || {})) {
        const productKey = String(key)
        const wantedInitialStock = configuredStock(productKey, rawProduct)
        let record = inventory.products[productKey]

        if (!record || typeof record !== 'object' || Array.isArray(record)) {
            const historicalPaid = Object.values(orders).filter(order =>
                String(order?.productKey || '').toLowerCase() === productKey.toLowerCase() && isPaidOrder(order)
            )
            const soldOrders = {}
            for (const order of historicalPaid) soldOrders[order.ref] = Number(order.paidAt || order.fulfilledAt || order.updatedAt || now)

            const reservations = {}
            for (const order of Object.values(orders)) {
                if (String(order?.productKey || '').toLowerCase() !== productKey.toLowerCase() || !isOpenUnpaidOrder(order)) continue
                const createdAt = Number(order.createdAt || now)
                const expiresAt = Number(order.expiresAt || (createdAt + stockReservationTimeoutMs()))
                reservations[order.ref] = { createdAt, expiresAt }
            }

            record = inventory.products[productKey] = {
                initialStock: wantedInitialStock,
                remaining: Math.max(0, wantedInitialStock - historicalPaid.length),
                soldCount: historicalPaid.length,
                oversoldCount: 0,
                soldOrders,
                reservations
            }
            changed = true
        } else {
            if (!record.reservations || typeof record.reservations !== 'object' || Array.isArray(record.reservations)) {
                record.reservations = {}
                changed = true
            }
            if (!record.soldOrders || typeof record.soldOrders !== 'object' || Array.isArray(record.soldOrders)) {
                record.soldOrders = {}
                changed = true
            }
            record.soldCount = Math.max(0, Math.floor(Number(record.soldCount || 0)))
            record.remaining = Math.max(0, Math.floor(Number(record.remaining || 0)))
            record.oversoldCount = Math.max(0, Math.floor(Number(record.oversoldCount || 0)))

            // Stock di settings.js menjadi jumlah stok dasar. Bila owner mengubahnya,
            // stok tersedia dihitung ulang dengan tetap mempertahankan jumlah terjual.
            if (Number(record.initialStock) !== wantedInitialStock) {
                record.initialStock = wantedInitialStock
                record.remaining = Math.max(0, wantedInitialStock - record.soldCount)
                changed = true
            }
        }

        // Pulihkan transaksi PAID yang mungkin sempat terhenti ketika bot restart.
        // soldOrders menjadi penanda idempoten agar satu order tidak memotong stok dua kali.
        for (const order of Object.values(orders)) {
            if (String(order?.productKey || '').toLowerCase() !== productKey.toLowerCase() || !isPaidOrder(order)) continue
            if (record.soldOrders[order.ref]) continue
            delete record.reservations[order.ref]
            if (record.remaining > 0) record.remaining -= 1
            else record.oversoldCount += 1
            record.soldCount += 1
            record.soldOrders[order.ref] = Number(order.paidAt || order.fulfilledAt || order.updatedAt || now)
            if (!order.stockConsumedAt) {
                order.stockConsumedAt = Number(record.soldOrders[order.ref])
                order.updatedAt = Number(order.updatedAt || now)
                ordersChanged = true
            }
            changed = true
        }

        // Lepaskan stok yang dipesan oleh order batal/gagal atau pembayaran yang sudah
        // lewat masa berlakunya. Pembayaran PAID ditangani sebagai stok terjual di atas.
        for (const [ref, reservationValue] of Object.entries(record.reservations)) {
            const reservation = reservationValue && typeof reservationValue === 'object'
                ? reservationValue
                : { createdAt: now, expiresAt: now + stockReservationTimeoutMs() }
            const order = orders[ref]
            const expired = Number(reservation.expiresAt || 0) > 0 && now > Number(reservation.expiresAt) + graceMs
            if (!order || isPaidOrder(order) || isTerminalUnpaidOrder(order) || expired) {
                delete record.reservations[ref]
                changed = true
            }
        }
    }

    if (changed) saveFile(INVENTORY_FILE, inventory)
    if (ordersChanged) saveOrders(orders)
    return inventory
}

function availableStock(record) {
    const remaining = Math.max(0, Number(record?.remaining || 0))
    const reserved = Object.keys(record?.reservations || {}).length
    return Math.max(0, remaining - reserved)
}

function reserveStock(productKey, ref) {
    let inventory = loadInventoryState()
    const key = String(productKey)
    let record = inventory.products[key]
    if (!record) {
        // Produk bisa saja ditambahkan melalui konfigurasi setelah stok pertama kali dibaca.
        inventory = loadInventoryState()
        record = inventory.products[key]
    }
    if (!record) throw new Error('Data stok produk tidak tersedia.')
    if (record.reservations[ref]) return
    if (availableStock(record) <= 0) throw new Error(`Stok *${global.storeProducts?.[key]?.name || key}* sedang habis.`)
    const now = Date.now()
    record.reservations[ref] = { createdAt: now, expiresAt: now + stockReservationTimeoutMs() }
    saveFile(INVENTORY_FILE, inventory)
}

function setStockReservationExpiry(productKey, ref, expiresAt) {
    const inventory = loadInventoryState()
    const reservation = inventory.products?.[String(productKey)]?.reservations?.[String(ref)]
    if (!reservation) return false
    const timestamp = Number(expiresAt || 0)
    if (Number.isFinite(timestamp) && timestamp > 0) reservation.expiresAt = timestamp
    saveFile(INVENTORY_FILE, inventory)
    return true
}

function releaseStockReservation(productKey, ref) {
    const inventory = loadInventoryState()
    const record = inventory.products?.[String(productKey)]
    if (!record || !record.reservations?.[String(ref)]) return false
    delete record.reservations[String(ref)]
    saveFile(INVENTORY_FILE, inventory)
    return true
}

function consumeStockForOrder(order) {
    if (!order?.ref || !order?.productKey) return false
    const inventory = loadInventoryState()
    const record = inventory.products?.[String(order.productKey)]
    if (!record) return false
    const ref = String(order.ref)
    delete record.reservations[ref]
    if (!record.soldOrders[ref]) {
        if (record.remaining > 0) record.remaining -= 1
        else record.oversoldCount += 1
        record.soldCount += 1
        record.soldOrders[ref] = Date.now()
        saveFile(INVENTORY_FILE, inventory)
    }
    order.stockConsumedAt = order.stockConsumedAt || Number(record.soldOrders[ref] || Date.now())
    order.updatedAt = Date.now()
    saveOrder(order)
    return true
}

function products() {
    const raw = global.storeProducts || {}
    const inventory = loadInventoryState()
    return Object.entries(raw).map(([key, value]) => {
        const stock = availableStock(inventory.products?.[String(key)])
        return {
            key: String(key),
            type: ['panel', 'rental', 'jadibot', 'jasher'].includes(String(value?.type || '').toLowerCase()) ? String(value.type).toLowerCase() : 'panel',
            name: String(value?.name || key),
            price: Math.max(0, Math.floor(Number(value?.price || 0))),
            description: String(value?.description || ''),
            durationDays: Math.max(1, Math.floor(Number(value?.durationDays || 30))),
            category: String(value?.category || (value?.type === 'rental' ? 'Sewa Bot' : 'Pterodactyl Panel')),
            ram: Math.max(128, Math.floor(Number(value?.ram || 0))),
            disk: Math.max(256, Math.floor(Number(value?.disk || 0))),
            cpu: Math.max(25, Math.floor(Number(value?.cpu || 0))),
            stock,
            stockCount: stock,
            soldCount: Math.max(0, Number(inventory.products?.[String(key)]?.soldCount || 0))
        }
    })
}
function getProduct(key) {
    const target = String(key || '').toLowerCase()
    return products().find(p => p.key.toLowerCase() === target) || null
}

function makeRef(prefix = 'ORD') {
    return `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`
}

function parseDuration(input) {
    const value = String(input || '').trim().toLowerCase()
    const match = value.match(/^(\d+(?:\.\d+)?)(d|day|days|h|hr|hour|hours|m|min|minute|minutes)$/)
    if (!match) return null
    const amount = Number(match[1])
    if (!Number.isFinite(amount) || amount <= 0) return null
    const unit = match[2]
    const factor = ['d', 'day', 'days'].includes(unit)
        ? 86400000
        : ['h', 'hr', 'hour', 'hours'].includes(unit) ? 3600000 : 60000
    return Math.floor(amount * factor)
}

function normalizeJid(input) {
    const raw = String(input || '').trim()
    if (!raw) return ''
    if (raw.endsWith('@s.whatsapp.net')) return raw
    const digits = raw.replace(/\D/g, '')
    return digits ? `${digits}@s.whatsapp.net` : ''
}

function getOrder(ref) {
    const db = loadOrders()
    return db[String(ref || '').toUpperCase()] || null
}

function saveOrder(order) {
    const db = loadOrders()
    db[order.ref] = order
    saveOrders(db)
    return order
}

async function createOrder({ jid, productKey, pushname = 'Customer' }) {
    if (!cfg().enabled) throw new Error('Store sedang dinonaktifkan.')
    const product = getProduct(productKey)
    if (!product) throw new Error(`Produk *${productKey}* tidak ditemukan. Gunakan ${cfg().prefix || '.'}listproduk.`)
    if (product.price <= 0) throw new Error('Harga produk belum diatur.')
    if (Number(product.stock) <= 0) throw new Error(`Stok *${product.name}* sedang habis.`)

    const ref = makeRef('ORD')
    // Reservasi stok dilakukan sebelum request pembayaran agar dua pembeli tidak
    // dapat mengambil unit terakhir secara bersamaan.
    reserveStock(product.key, ref)
    const order = {
        ref,
        jid,
        pushname,
        productKey: product.key,
        productType: product.type,
        productName: product.name,
        price: product.price,
        durationDays: product.durationDays,
        status: 'CREATING_PAYMENT',
        paymentStatus: 'UNPAID',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fulfilledAt: null,
        stockReservedAt: Date.now(),
        stockConsumedAt: null,
        panel: null,
        rental: null
    }
    saveOrder(order)

    try {
        const payment = await depositService.createPayment({
            jid,
            amount: product.price,
            pushname,
            kind: 'STORE',
            orderRef: ref,
            items: [{ sku: product.key, name: product.name, price: product.price, quantity: 1 }]
        })
        // Reload the order after invoice creation. Some gateways can report PAID
        // in the create response, causing the paid handler to run before this await
        // returns. Updating the stale object here could otherwise overwrite DONE,
        // WAITING_NUMBER, or WAITING_GROUP_LINK with WAITING_PAYMENT.
        const latestOrder = getOrder(ref) || order
        latestOrder.paymentRef = payment.merchantRef
        latestOrder.paymentReference = payment.reference
        latestOrder.paymentAmount = payment.paymentAmount
        latestOrder.paymentMethod = payment.paymentName || payment.method || 'QRIS'
        latestOrder.paymentProvider = payment.providerName || payment.provider || 'NasionalPay'
        latestOrder.qrString = payment.qrString || null
        latestOrder.qrUrl = payment.qrUrl || payment.qrImage || null
        latestOrder.checkoutUrl = payment.checkoutUrl || null
        latestOrder.expiresAt = payment.expiredAt
        const paymentStatus = String(payment.status || latestOrder.paymentStatus || 'UNPAID').toUpperCase()
        const isPaid = ['PAID', 'SUCCESS', 'SETTLED'].includes(paymentStatus) || String(latestOrder.paymentStatus || '').toUpperCase() === 'PAID' || Number(latestOrder.paidAt || 0) > 0
        if (isPaid) {
            latestOrder.paymentStatus = 'PAID'
            latestOrder.paidAt = latestOrder.paidAt || Number(payment.paidAt || Date.now())
            if (['CREATING_PAYMENT', 'WAITING_PAYMENT', ''].includes(String(latestOrder.status || '').toUpperCase())) {
                latestOrder.status = 'PAID_WAITING_FULFILLMENT'
            }
        } else {
            latestOrder.status = 'WAITING_PAYMENT'
            latestOrder.paymentStatus = paymentStatus
            setStockReservationExpiry(product.key, ref, payment.expiredAt)
        }
        latestOrder.updatedAt = Date.now()
        saveOrder(latestOrder)
        return { order: latestOrder, payment, product }
    } catch (err) {
        releaseStockReservation(product.key, ref)
        order.status = 'PAYMENT_FAILED'
        order.stockReservationReleasedAt = Date.now()
        order.error = err?.message || String(err)
        saveOrder(order)
        throw err
    }
}

async function qrBuffer(order) {
    const payment = depositService.get(order.paymentRef || order.ref)
    if (!payment) return null
    return depositService.qrBuffer(payment)
}

function panelResources(product) {
    const presets = {
        panel1gb: { ram: 1024, disk: 2048, cpu: 100 },
        panel2gb: { ram: 2048, disk: 4096, cpu: 150 },
        panel4gb: { ram: 4096, disk: 8192, cpu: 200 },
        panel8gb: { ram: 8192, disk: 12288, cpu: 300 }
    }
    const key = String(product?.key || '').toLowerCase()
    const preset = presets[key] || {}
    return {
        ram: Math.max(128, Number(product?.ram || preset.ram || 1024)),
        disk: Math.max(256, Number(product?.disk || preset.disk || 2048)),
        cpu: Math.max(25, Number(product?.cpu || preset.cpu || 100))
    }
}

function cleanPanelUsername(value) {
    const cleaned = String(value || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
    return cleaned || 'user'
}

function panelConfig() {
    return {
        baseUrl: String(global.panelConfig?.domain || global.panelConfig?.baseUrl || global.domain || '').trim().replace(/\/$/, ''),
        apiKey: String(global.panelConfig?.apikey || global.panelConfig?.apiKey || global.apikey || '').trim(),
        clientApiKey: String(global.panelConfig?.capikey || global.capikey || '').trim(),
        nestId: Number(global.panelConfig?.nestId || global.nestid || 5),
        eggId: Number(global.panelConfig?.eggId || global.egg || 15),
        locationId: Number(global.panelConfig?.locationId || global.loc || 1)
    }
}

async function panelRequest(baseUrl, apiKey, method, route, body) {
    const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: {
            Accept: 'Application/vnd.pterodactyl.v1+json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
        const message = data?.errors?.[0]?.detail || data?.errors?.[0]?.code || data?.message || `HTTP ${response.status}`
        throw new Error(message)
    }
    return data
}

async function createPanelForOrder(order) {
    const product = getProduct(order.productKey)
    const config = panelConfig()
    if (!product) throw new Error('Produk panel tidak ditemukan.')
    if (global.panelConfig?.enabled === false) {
        throw new Error('Auto-order Panel sedang dinonaktifkan di settings.js (global.panelConfig.enabled).')
    }
    if (!config.baseUrl || !config.apiKey) {
        throw new Error('Konfigurasi auto-order Panel belum lengkap. Isi global.panelConfig.domain dan global.panelConfig.apikey di settings.js. Gunakan URL panel Pterodactyl dan Application API Key (PTLA).')
    }

    const resources = panelResources(product)
    const seed = `${order.ref}${order.pushname || ''}`.replace(/[^a-zA-Z0-9]/g, '').slice(-16).toLowerCase()
    const username = `${cleanPanelUsername(order.pushname || 'user').slice(0, 12)}${seed.slice(0, 6)}`
    const email = `${username}@xeryuu.local`
    const password = crypto.randomBytes(8).toString('hex') + 'Xy!1'
    const user = await panelRequest(config.baseUrl, config.apiKey, 'POST', '/api/application/users', {
        email,
        username,
        first_name: String(order.pushname || 'Xeryuu').slice(0, 48),
        last_name: 'Customer',
        password
    })

    const egg = await panelRequest(
        config.baseUrl,
        config.apiKey,
        'GET',
        `/api/application/nests/${config.nestId}/eggs/${config.eggId}?include=variables`
    )

    const server = await panelRequest(config.baseUrl, config.apiKey, 'POST', '/api/application/servers', {
        name: `${product.name} - ${order.ref}`,
        user: user.attributes.id,
        nest: config.nestId,
        egg: config.eggId,
        docker_image: egg?.attributes?.docker_image || 'ghcr.io/parkervcp/yolks:nodejs_22',
        startup: egg?.attributes?.startup || 'npm start',
        environment: Object.fromEntries(
            Array.isArray(egg?.attributes?.relationships?.variables?.data)
                ? egg.attributes.relationships.variables.data.map(v => [v.attributes.env_variable, v.attributes.default_value ?? ''])
                : []
        ),
        limits: {
            memory: resources.ram,
            swap: 0,
            disk: resources.disk,
            io: 500,
            cpu: resources.cpu
        },
        feature_limits: {
            databases: 1,
            backups: 1,
            allocations: 1
        },
        deploy: {
            locations: [config.locationId],
            dedicated_ip: false,
            port_range: []
        },
        start_on_completion: true
    })

    const panel = {
        url: config.baseUrl,
        username,
        email,
        password,
        userId: user.attributes.id,
        serverId: server.attributes.id,
        identifier: server.attributes.identifier,
        resources
    }
    order.panel = panel
    return panel
}

async function handlePaid(payment) {
    const ref = String(payment.orderRef || payment.merchantRef || '').toUpperCase()
    if (!ref.startsWith('ORD')) return false
    if (paidInFlight.has(ref)) return paidInFlight.get(ref)

    const promise = (async () => {
        let order = getOrder(ref)
        if (!order || order.fulfilledAt) return true

        // Jika invoice Store dibayar setelah pembeli membatalkan order, jangan
        // membuat panel/Jadibot/sewa secara diam-diam dan jangan menghilangkan dana.
        // Kreditkan nilainya ke saldo bot secara idempoten, lalu tahan fulfillment.
        const orderState = String(order.status || '').toUpperCase()
        const paymentState = String(order.paymentStatus || '').toUpperCase()
        if (['CANCELED', 'CANCELLED'].includes(orderState) || ['CANCELED', 'CANCELLED'].includes(paymentState)) {
            const amount = Math.max(0, Math.floor(Number(payment?.totalPay || payment?.paymentAmount || payment?.amount || order.price || 0)))
            const credit = economy.applyMoneyTransaction(
                order.jid,
                amount,
                `store-late-cancel:${order.ref}`,
                'Pembayaran Store terlambat setelah order dibatalkan'
            )
            order.paymentStatus = 'PAID_AFTER_CANCEL_REFUNDED'
            order.latePaymentWalletCreditedAt = order.latePaymentWalletCreditedAt || Date.now()
            order.latePaymentAmount = amount
            order.latePaymentCreditBalance = Number(credit?.balance ?? economy.getBalance(order.jid))
            order.updatedAt = Date.now()
            saveOrder(order)

            if (!order.latePaymentBuyerNoticeSentAt && sender) {
                const buyerNotice =
                    `⚠️ PEMBAYARAN MASUK SETELAH ORDER DIBATALKAN\n\n` +
                    `Order: ${order.ref}\n` +
                    `Produk: ${order.productName}\n` +
                    `Nominal: Rp${formatMoney(amount)}\n\n` +
                    `Agar dana tidak hilang, nominal sudah diamankan ke saldo bot sebesar Rp${formatMoney(amount)}. Produk tidak dibuat karena order sudah dibatalkan. Hubungi owner bila kamu ingin bantuan lanjutan.`
                try {
                    await sender(order.jid, `\`\`\`${buyerNotice}\`\`\``)
                    order.latePaymentBuyerNoticeSentAt = Date.now()
                    saveOrder(order)
                } catch (error) {
                    console.error('[STORE LATE PAYMENT BUYER NOTICE]', error?.message || error)
                }
            }
            if (!order.latePaymentOwnerNoticeSentAt && ownerSender) {
                try {
                    await ownerSender(
                        `STORE LATE PAYMENT REFUNDED TO BOT BALANCE\n\n` +
                        `Order: ${order.ref}\nCustomer: ${order.pushname || '-'}\nJID: ${order.jid}\n` +
                        `Product: ${order.productName}\nAmount: Rp${formatMoney(amount)}\n` +
                        `Wallet credited: ${credit?.applied ? 'YES' : 'ALREADY CREDITED'}\n` +
                        `Order fulfillment skipped because cancellation was already recorded.`
                    )
                    order.latePaymentOwnerNoticeSentAt = Date.now()
                    saveOrder(order)
                } catch (error) {
                    console.error('[STORE LATE PAYMENT OWNER NOTICE]', error?.message || error)
                }
            }
            return {
                reviewRequired: true,
                paused: true,
                message: `Order ${order.ref} was canceled before payment was reported; Rp${formatMoney(amount)} was credited to the buyer bot balance and fulfillment was skipped.`
            }
        }

        const product = getProduct(order.productKey)
        if (!product) throw new Error('Produk order tidak ditemukan.')

        order.paymentStatus = 'PAID'
        order.paidAt = order.paidAt || Date.now()
        order.updatedAt = Date.now()
        saveOrder(order)
        // Stok hanya menjadi terjual ketika pembayaran tervalidasi. Fungsi ini
        // idempoten, jadi callback pembayaran berulang tidak mengurangi stok lagi.
        consumeStockForOrder(order)
        order = getOrder(ref) || order

        if (!order.paymentNotifiedAt && sender) {
            try {
                await sender(
                    order.jid,
                    `> ✅ *PEMBAYARAN DITERIMA*\n> \n` +
                    `> 🧾 Order: *${order.ref}*\n` +
                    `> 📦 Produk: *${order.productName}*\n` +
                    `> 💰 Total: *Rp${formatMoney(order.price)}*\n> \n` +
                    `> Pembayaran berhasil diterima.`
                )
                order.paymentNotifiedAt = Date.now()
                order.updatedAt = Date.now()
                saveOrder(order)
            } catch (e) { console.error('[STORE USER PAYMENT NOTIFY]', e?.message || e) }
        }

        if (order.productType === 'jasher') {
            if (order.jasher?.paymentHandledAt) return true
            order.status = 'WAITING_CONTENT'
            order.jasher = order.jasher || { content: null, target: null, submittedAt: null, processedAt: null }
            order.jasher.paymentHandledAt = Date.now()
            order.updatedAt = Date.now()
            saveOrder(order)
            if (sender) {
                try {
                    await sender(
                        order.jid,
                        `> ✅ *JASHER BERHASIL DIBAYAR*\n> \n` +
                        `> 🧾 Order: *${order.ref}*\n` +
                        `> 📦 Paket: *${order.productName}*\n> \n` +
                        `> Kirim materi share dengan:\n` +
                        `> *${cfg().prefix || '.'}jasherkirim ${order.ref} | LINK/TARGET | PESAN*\n> \n` +
                        `> Setelah itu owner akan memproses campaign kamu.`
                    )
                } catch (e) { console.error('[JASHER USER NOTIFY]', e?.message || e) }
            }
            if (ownerSender && cfg().notifyOwner !== false) {
                try {
                    await ownerSender(
                        `✅ *JASHER PAYMENT MASUK*\n\n` +
                        `🧾 Order: *${order.ref}*\n` +
                        `👤 Customer: *${order.pushname || '-'}*\n` +
                        `📱 JID: *${order.jid}*\n` +
                        `📦 Paket: *${order.productName}*\n` +
                        `💰 Rp${formatMoney(order.price)}\n\n` +
                        `Gunakan *${cfg().prefix || '.'}jasherstatus ${order.ref}* untuk melihat detail.`
                    )
                } catch (e) { console.error('[JASHER OWNER NOTIFY]', e?.message || e) }
            }
            if (ownerTelegramSender) {
                try {
                    await ownerTelegramSender(
                        `<blockquote>\n<b>💸 JASHER PAYMENT MASUK</b>\n\n` +
                        `🧾 Order: <code>${escapeTelegram(order.ref)}</code>\n` +
                        `👤 Customer: <b>${escapeTelegram(order.pushname || '-')}</b>\n` +
                        `📱 JID: <code>${escapeTelegram(order.jid)}</code>\n` +
                        `📦 Paket: <b>${escapeTelegram(order.productName)}</b>\n` +
                        `💰 Rp${formatMoney(order.price)}</blockquote>`
                    )
                } catch (e) { console.error('[JASHER TELEGRAM NOTIFY]', e?.message || e) }
            }
            return true
        }

        if (order.productType === 'panel') {
            order.status = 'PROCESSING'
            saveOrder(order)
            try {
                const panel = await createPanelForOrder(order)
                order.status = 'DONE'
                order.fulfilledAt = Date.now()
                order.updatedAt = Date.now()
                order.panel = panel
                saveOrder(order)

                if (sender) {
                    await sender(
                        order.jid,
                        `> ✅ *PANEL / VPS BERHASIL DIBUAT*\n> \n` +
                        `> 🧾 Order: *${order.ref}*\n` +
                        `> 📦 Produk: *${order.productName}*\n> \n` +
                        `> 🌐 Panel: *${panel.url}*\n` +
                        `> 👤 Username: *${panel.username}*\n` +
                        `> 📧 Email: *${panel.email}*\n` +
                        `> 🔑 Password: \`${panel.password}\`\n` +
                        `> 🧠 RAM: *${panel.resources.ram} MB*\n` +
                        `> 💾 Disk: *${panel.resources.disk} MB*\n` +
                        `> ⚙️ CPU: *${panel.resources.cpu}%*\n> \n` +
                        `> Simpan data login ini dengan aman.`
                    )
                }

                if (ownerSender && cfg().notifyOwner !== false) {
                    try {
                        await ownerSender(
                            `✅ *PANEL AUTO-FULFILL BERHASIL*\n\n` +
                            `🧾 Order: *${order.ref}*\n` +
                            `👤 Customer: *${order.pushname || '-'}*\n` +
                            `📱 JID: *${order.jid}*\n` +
                            `📦 Produk: *${order.productName}*\n` +
                            `🌐 Panel: *${panel.url}*\n` +
                            `👤 Username: *${panel.username}*\n` +
                            `🆔 Server ID: *${panel.serverId}*`
                        )
                    } catch (e) { console.error('[STORE OWNER NOTIFY]', e?.message || e) }
                }

                if (ownerTelegramSender) {
                    try {
                        await ownerTelegramSender(
                            `<blockquote>\n<b>🖥️ PANEL / VPS BERHASIL DIBUAT</b>\n\n` +
                            `🧾 Order: <code>${escapeTelegram(order.ref)}</code>\n` +
                            `👤 Customer: <b>${escapeTelegram(order.pushname || '-')}</b>\n` +
                            `📱 JID: <code>${escapeTelegram(order.jid)}</code>\n` +
                            `📦 Produk: <b>${escapeTelegram(order.productName)}</b>\n` +
                            `🌐 Panel: <code>${escapeTelegram(panel.url)}</code>\n` +
                            `👤 Username: <code>${escapeTelegram(panel.username)}</code>\n` +
                            `🆔 Server ID: <code>${escapeTelegram(panel.serverId)}</code></blockquote>`
                        )
                    } catch (e) { console.error('[STORE TELEGRAM OWNER NOTIFY]', e?.message || e) }
                }
                return true
            } catch (error) {
                order.status = 'FULFILLMENT_FAILED'
                order.fulfillmentError = error?.message || String(error)
                order.updatedAt = Date.now()
                saveOrder(order)

                if (sender) {
                    try {
                        await sender(
                            `> ⚠️ *PEMBAYARAN SUDAH DITERIMA*\n> \n` +
                            `> 🧾 Order: *${order.ref}*\n` +
                            `> 📦 Produk: *${order.productName}*\n` +
                            `> ❌ Auto fulfill gagal: *${order.fulfillmentError}*\n> \n` +
                            `> Hubungi owner untuk pengecekan order.`
                        )
                    } catch (e) { console.error('[STORE USER ERROR NOTIFY]', e?.message || e) }
                }

                if (ownerSender && cfg().notifyOwner !== false) {
                    try {
                        await ownerSender(
                            `⚠️ *AUTO FULFILL GAGAL*\n\n` +
                            `🧾 Order: *${order.ref}*\n` +
                            `👤 Customer: *${order.pushname || '-'}*\n` +
                            `📦 Produk: *${order.productName}*\n` +
                            `❌ Error: *${order.fulfillmentError}*`
                        )
                    } catch (e) { console.error('[STORE OWNER ERROR NOTIFY]', e?.message || e) }
                }
                return false
            }
        }

        if (order.productType === 'rental') {
            if (order.status === 'WAITING_GROUP_LINK') return true
            order.status = 'WAITING_GROUP_LINK'
            order.updatedAt = Date.now()
            saveOrder(order)

            if (sender) {
                await sender(
                    order.jid,
                    `> 🤖 *SEWA BOT OTOMATIS*\n> \n` +
                    `> Pembayaran sudah diterima.\n> \n` +
                    `> 🔗 Kirim *link grup WhatsApp* yang ingin dimasuki bot.\n` +
                    `> \n` +
                    `> Contoh:\n` +
                    `> https://chat.whatsapp.com/XXXXXXXXXXXX\n> \n` +
                    `> Setelah link diterima, bot akan otomatis masuk dan mengaktifkan masa sewa.`
                )
            }

            if (ownerTelegramSender) {
                try {
                    await ownerTelegramSender(
                        `<blockquote>\n<b>🤖 SEWA BOT MENUNGGU LINK GRUP</b>\n\n` +
                        `🧾 Order: <code>${escapeTelegram(order.ref)}</code>\n` +
                        `👤 Customer: <b>${escapeTelegram(order.pushname || '-')}</b>\n` +
                        `📦 Produk: <b>${escapeTelegram(order.productName)}</b></blockquote>`
                    )
                } catch (e) { console.error('[STORE TELEGRAM OWNER NOTIFY]', e?.message || e) }
            }
            return true
        }

        if (order.productType === 'jadibot') {
            if (order.status === 'WAITING_NUMBER') return true
            order.status = 'WAITING_NUMBER'
            order.updatedAt = Date.now()
            saveOrder(order)

            if (sender) {
                await sender(
                    order.jid,
                    `> 🤖 *JADIBOT*\n> \n` +
                    `> Pembayaran sudah diterima.\n> \n` +
                    `> 📱 Kirim *nomor WhatsApp* yang ingin dipairing.\n` +
                    `> \n` +
                    `> Contoh: *628123456789*\n> \n` +
                    `> Setelah nomor diterima, sistem akan membuat session khusus jadibot dan mengirim kode pairing.`
                )
            }

            if (ownerTelegramSender) {
                try {
                    await ownerTelegramSender(
                        `<blockquote>\n<b>🤖 JADIBOT MENUNGGU NOMOR</b>\n\n` +
                        `🧾 Order: <code>${escapeTelegram(order.ref)}</code>\n` +
                        `👤 Customer: <b>${escapeTelegram(order.pushname || '-')}</b>\n` +
                        `📦 Produk: <b>${escapeTelegram(order.productName)}</b></blockquote>`
                    )
                } catch (e) { console.error('[STORE TELEGRAM OWNER NOTIFY]', e?.message || e) }
            }
            return true
        }

        throw new Error('Tipe produk tidak didukung.')
    })().finally(() => paidInFlight.delete(ref))

    paidInFlight.set(ref, promise)
    return promise
}

function normalizeInviteCode(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const match = raw.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)
    return match ? match[1].split(/[/?#\s]/)[0] : ''
}

async function handleCustomerInput(jid, input) {
    const customer = String(jid || '').trim()
    if (!customer) return false
    const text = String(input || '').trim()
    if (!text) return false
    const pairingDigits = text.replace(/\D/g, '')
    const looksLikePhoneNumber = /^[+\d\s()-]+$/.test(text) && pairingDigits.length >= 8 && pairingDigits.length <= 15

    const orders = Object.values(loadOrders())
        .filter(order =>
            order?.jid === customer &&
            String(order.paymentStatus || '').toUpperCase() === 'PAID' &&
            // PAIRING can remain on disk if PM2/process restarts during Jadibot
            // pairing. Retrying the same orderRef is idempotent in jadibot.js and
            // resumes/returns its existing session rather than creating another.
            // Only intercept number-shaped messages in PAIRING state so commands
            // like .menu are not accidentally consumed as an invalid phone number.
            (
                ['WAITING_GROUP_LINK', 'WAITING_NUMBER'].includes(String(order.status || '').toUpperCase()) ||
                (order.productType === 'jadibot' && String(order.status || '').toUpperCase() === 'PAIRING' && looksLikePhoneNumber)
            )
        )
        .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))

    const order = orders[0]
    if (!order) return false

    if (order.productType === 'rental') {
        if (!waConnection) {
            if (sender) await sender(customer, '> ⚠️ Koneksi WhatsApp utama sedang tidak tersedia. Order sewa tetap menunggu; jangan membayar ulang. Coba kirim link grup lagi setelah koneksi bot utama aktif.')
            return true
        }
        const inviteCode = normalizeInviteCode(text)
        if (!inviteCode) {
            if (sender) await sender(customer, `> ❌ Link grup tidak valid.\n> \n> Kirim link seperti:\n> https://chat.whatsapp.com/XXXXXXXXXXXX`)
            return true
        }

        order.status = 'PROCESSING'
        order.updatedAt = Date.now()
        saveOrder(order)

        try {
            const groupId = await waConnection.groupAcceptInvite(inviteCode)
            if (!groupId || !String(groupId).endsWith('@g.us')) throw new Error('Bot gagal masuk ke grup.')
            const rental = await activateRental(order.ref, String(groupId))
            if (sender) {
                await sender(
                    customer,
                    `> ✅ *SEWA BOT AKTIF*\n> \n` +
                    `> 🧾 Order: *${order.ref}*\n` +
                    `> 📦 Produk: *${order.productName}*\n` +
                    `> 👥 Grup: *${groupId}*\n` +
                    `> 🆔 ID Sewa: *${rental.id}*\n` +
                    `> 📅 Mulai: *${new Date(rental.startAt).toLocaleString('id-ID')}*\n` +
                    `> ⏳ Expired: *${new Date(rental.expiresAt).toLocaleString('id-ID')}*\n> \n` +
                    `> Bot sudah masuk ke grup dan siap digunakan.`
                )
            }
            return true
        } catch (e) {
            order.status = 'WAITING_GROUP_LINK'
            order.fulfillmentError = e?.message || String(e)
            order.updatedAt = Date.now()
            saveOrder(order)
            if (sender) await sender(customer, `> ❌ Gagal memasukkan bot ke grup.\n> \n> ${order.fulfillmentError}\n> \n> Kirim link grup lain yang masih aktif.`)
            return true
        }
    }

    if (order.productType === 'jadibot') {
        const phone = String(text).replace(/\D/g, '')
        if (phone.length < 8 || phone.length > 15) {
            if (sender) await sender(customer, `> ❌ Nomor WhatsApp tidak valid.\n> \n> Contoh: *628123456789*`)
            return true
        }

        order.status = 'PAIRING'
        order.updatedAt = Date.now()
        saveOrder(order)

        try {
            const result = await jadibotService.pair({
                ownerJid: customer,
                phoneNumber: phone,
                orderRef: order.ref
            })
            const pairingCode = String(result?.code || '').trim()
            if (!['CONNECTED', 'CONNECTING', 'PAIRING'].includes(String(result?.status || '').toUpperCase())) {
                throw new Error('Status sesi Jadibot tidak dikenali; order dikembalikan ke tahap nomor.')
            }
            if (String(result.status).toUpperCase() === 'PAIRING' && !pairingCode) {
                throw new Error('Kode pairing tidak tersedia. Silakan coba ulang setelah koneksi stabil.')
            }
            order.jadibot = {
                ownerJid: customer,
                phoneNumber: phone,
                status: result.status,
                pairingRequestedAt: Date.now()
            }
            order.status = 'DONE'
            order.fulfilledAt = Date.now()
            order.updatedAt = Date.now()
            saveOrder(order)

            if (sender) {
                if (String(result.status).toUpperCase() === 'CONNECTED') {
                    await sender(customer, `> ✅ *JADIBOT SUDAH TERHUBUNG*\n> \n> Session jadibot untuk nomor *${phone}* sudah aktif.`)
                } else if (String(result.status).toUpperCase() === 'CONNECTING') {
                    await sender(
                        customer,
                        `> 🔄 *JADIBOT SEDANG MENYAMBUNG ULANG*\n> \n` +
                        `> 📱 Nomor: *${phone}*\n` +
                        `> Session terdaftar sedang mencoba tersambung kembali. Tidak perlu memasukkan kode pairing baru atau membuat order ulang.\n> \n` +
                        `> Bot akan mengirim notifikasi lagi setelah koneksi aktif.`
                    )
                } else {
                    await sender(
                        customer,
                        `> ✅ *JADIBOT SIAP DIPAIRING*\n> \n` +
                        `> 📱 Nomor: *${phone}*\n` +
                        `> 🔐 Kode Pairing: *${pairingCode}*\n> \n` +
                        `> Cara menghubungkan:\n` +
                        `> 1. Buka WhatsApp pada nomor tersebut.\n` +
                        `> 2. Pilih *Perangkat tertaut*.\n` +
                        `> 3. Pilih *Tautkan perangkat dengan nomor telepon*.\n` +
                        `> 4. Masukkan kode pairing di atas.\n> \n` +
                        `> Jangan bagikan kode pairing kepada orang lain.`
                    )
                }
            }
            return true
        } catch (e) {
            order.status = 'WAITING_NUMBER'
            order.fulfillmentError = e?.message || String(e)
            order.updatedAt = Date.now()
            saveOrder(order)
            if (sender) await sender(customer, `> ❌ Gagal membuat session jadibot.\n> \n> ${order.fulfillmentError}\n> \n> Kirim nomor lain atau coba lagi.`)
            return true
        }
    }

    return false
}

async function markProcessing(ref, actor = 'owner') {
    const order = getOrder(ref)
    if (!order) throw new Error('Order tidak ditemukan.')
    if (order.paymentStatus !== 'PAID') throw new Error('Order belum dibayar.')
    order.status = 'PROCESSING'
    order.updatedAt = Date.now()
    order.processingBy = actor
    saveOrder(order)
    return order
}

async function finishPanel(ref, { url, username, password }) {
    const order = getOrder(ref)
    if (!order) throw new Error('Order tidak ditemukan.')
    if (order.productType !== 'panel') throw new Error('Order ini bukan produk panel.')
    if (order.paymentStatus !== 'PAID') throw new Error('Order belum dibayar.')
    if (!url || !username || !password) throw new Error('Format: paneldone <REF> | URL | USERNAME/EMAIL | PASSWORD')

    order.status = 'DONE'
    order.updatedAt = Date.now()
    order.fulfilledAt = Date.now()
    order.panel = { url: String(url).trim(), username: String(username).trim(), password: String(password).trim() }
    saveOrder(order)

    if (sender) {
        await sender(order.jid,
            `✅ *PANEL SUDAH SIAP*\n\n` +
            `🧾 Order: *${order.ref}*\n` +
            `📦 Produk: *${order.productName}*\n\n` +
            `🌐 Panel: ${order.panel.url}\n` +
            `👤 Username: *${order.panel.username}*\n` +
            `🔑 Password: \`${order.panel.password}\`\n\n` +
            `Simpan data login ini dengan aman.`
        )
    }
    return order
}

async function activateRental(ref, groupId = '') {
    const order = getOrder(ref)
    if (!order) throw new Error('Order tidak ditemukan.')
    if (order.productType !== 'rental') throw new Error('Order ini bukan produk sewa bot.')
    if (order.paymentStatus !== 'PAID') throw new Error('Order belum dibayar.')

    const rentals = loadRentals()
    const existing = Object.values(rentals).find(r => r.orderRef === order.ref && r.active)
    if (existing) {
        // Recover the final order write if the process stopped after the rental
        // record was committed. The paid order must not remain stuck in PROCESSING.
        if (String(order.status || '').toUpperCase() !== 'DONE' || !order.rental) {
            order.status = 'DONE'
            order.updatedAt = Date.now()
            order.fulfilledAt = Number(order.fulfilledAt || existing.createdAt || Date.now())
            order.rental = { id: existing.id, startAt: existing.startAt, expiresAt: existing.expiresAt }
            saveOrder(order)
        }
        return existing
    }

    const durationMs = Math.max(1, Number(order.durationDays || 30)) * 86400000
    const now = Date.now()
    let effectiveExpiresAt = now + durationMs
    let sewaRecord = null
    if (groupId) {
        // Persist an order-specific idempotency key in sewa.json before the
        // store-rental record. If a restart happens between the two files, retry
        // will reuse the already-applied extension rather than adding it twice.
        sewaRecord = sewaService.add(String(groupId), Math.floor(durationMs / 1000), { orderRef: order.ref })
        effectiveExpiresAt = Number(sewaRecord.endTime || effectiveExpiresAt)
        // One group should have one current store-rental countdown. Supersede old
        // in-bot records when a new paid order renews the same group to avoid an
        // old expiry timer kicking in before the group-level lease ends.
        for (const prior of Object.values(rentals)) {
            if (prior?.active && String(prior.groupId || '') === String(groupId) && prior.orderRef !== order.ref) {
                prior.active = false
                prior.supersededBy = order.ref
                prior.updatedAt = now
            }
        }
    }

    const rental = {
        id: makeRef('SEWA'),
        orderRef: order.ref,
        jid: order.jid,
        pushname: order.pushname,
        productKey: order.productKey,
        productName: order.productName,
        groupId: String(groupId || ''),
        startAt: now,
        expiresAt: effectiveExpiresAt,
        active: true,
        warned72h: false,
        warned24h: false,
        createdAt: now,
        updatedAt: now
    }

    if (sewaRecord) {
        rental.sewaRecord = { groupId: sewaRecord.groupId, endTime: sewaRecord.endTime }
    }

    rentals[rental.id] = rental
    saveRentals(rentals)

    order.status = 'DONE'
    order.updatedAt = now
    order.fulfilledAt = now
    order.rental = { id: rental.id, startAt: rental.startAt, expiresAt: rental.expiresAt }
    saveOrder(order)

    if (sender) {
        await sender(order.jid,
            `✅ *SEWA BOT AKTIF*\n\n` +
            `🧾 Order: *${order.ref}*\n` +
            `📦 Produk: *${order.productName}*\n` +
            `🗓️ Mulai: *${new Date(rental.startAt).toLocaleString('id-ID')}*\n` +
            `⏳ Expired: *${new Date(rental.expiresAt).toLocaleString('id-ID')}*\n` +
            `🆔 Sewa: *${rental.id}*`
        )
    }
    return rental
}

async function addTime(target, durationInput) {
    const durationMs = parseDuration(durationInput)
    if (!durationMs) throw new Error('Format masa salah. Contoh: 7d, 30d, 12h.')
    const rentals = loadRentals()
    const key = String(target || '').toUpperCase()
    let rental = rentals[key]
    if (!rental) {
        const jid = normalizeJid(target)
        rental = Object.values(rentals).find(r => r.jid === jid && (r.active || r.expiresAt))
    }
    if (!rental) throw new Error('Data sewa aktif tidak ditemukan.')

    const base = Math.max(Date.now(), Number(rental.expiresAt || 0))
    rental.expiresAt = base + durationMs
    rental.active = true
    rental.warned72h = false
    rental.warned24h = false
    rental.updatedAt = Date.now()
    rentals[rental.id] = rental
    saveRentals(rentals)
    return rental
}

function getRental(target) {
    const rentals = loadRentals()
    const text = String(target || '').trim()
    if (rentals[text.toUpperCase()]) return rentals[text.toUpperCase()]
    const jid = normalizeJid(text)
    if (jid) return Object.values(rentals).find(r => r.jid === jid && r.active) || null
    return null
}

async function cancelOrder(ref, requesterJid = '') {
    const order = getOrder(ref)
    if (!order) throw new Error('Order tidak ditemukan.')
    if (requesterJid && order.jid !== requesterJid) throw new Error('Order ini bukan milik kamu.')
    const orderState = String(order.status || '').toUpperCase()
    const paymentState = String(order.paymentStatus || '').toUpperCase()
    if (paymentState === 'PAID' || ['DONE', 'PAID_WAITING_FULFILLMENT', 'PROCESSING'].includes(orderState)) {
        throw new Error('Order sudah dibayar atau sedang diproses.')
    }
    if (order.paymentRef) {
        const payment = depositService.get(order.paymentRef)
        const state = String(payment?.status || paymentState || '').toUpperCase()
        if (!['EXPIRED', 'FAILED', 'CANCELED', 'REFUNDED'].includes(state)) {
            await depositService.cancel(order.paymentRef, requesterJid)
        }
    }
    order.status = 'CANCELED'
    order.paymentStatus = 'CANCELED'
    order.canceledAt = Date.now()
    order.stockReservationReleasedAt = Date.now()
    order.updatedAt = Date.now()
    saveOrder(order)
    releaseStockReservation(order.productKey, order.ref)
    return order
}

function updateOrder(ref, patch = {}) {
    const order = getOrder(ref)
    if (!order) return null
    return saveOrder({ ...order, ...patch, updatedAt: Date.now() })
}

function listOrders(limit = 20) {
    return Object.values(loadOrders()).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).slice(0, limit)
}

async function notifyExpiration(rental, kind) {
    const remaining = Math.max(0, rental.expiresAt - Date.now())
    const dayText = Math.ceil(remaining / 86400000)
    const msg = kind === 'expired'
        ? `⛔ *SEWA BOT EXPIRED*\n\n🧾 Sewa: *${rental.id}*\n📦 ${rental.productName}\n⏳ Masa sewa telah berakhir.\n\nHubungi owner untuk perpanjangan.`
        : `⚠️ *SEWA BOT AKAN BERAKHIR*\n\n🧾 Sewa: *${rental.id}*\n📦 ${rental.productName}\n⏳ Tersisa sekitar *${dayText} hari*\n📅 Expired: *${new Date(rental.expiresAt).toLocaleString('id-ID')}*`
    if (sender) {
        try { await sender(rental.jid, msg) } catch (e) { console.error('[SEWA NOTIFY USER]', e?.message || e) }
    }
    // Kirim kartu kontak owner ke grup penyewa tepat saat sewa kedaluwarsa.
    if (kind === 'expired' && contactSender) {
        try { await contactSender(rental.jid) } catch (e) { console.error('[SEWA OWNER CONTACT]', e?.message || e) }
    }
    if (ownerSender) {
        try { await ownerSender(`📢 *MONITOR SEWA*\n\n${msg}\n\n👤 JID: *${rental.jid}*\n➡️ Gunakan *${cfg().prefix || '.'}tambahmasa ${rental.id} 30d* untuk memperpanjang.`) } catch (e) { console.error('[SEWA NOTIFY OWNER]', e?.message || e) }
    }
}

async function monitorRentals() {
    const rentals = loadRentals()
    const orders = loadOrders()
    let changed = false
    let ordersChanged = false
    const now = Date.now()

    // Repair paid rental orders left in PROCESSING by a crash between the
    // rental-file and order-file writes. If no rental exists, return it to the
    // group-link step so the customer can safely retry without paying again.
    for (const order of Object.values(orders)) {
        if (order?.productType !== 'rental' || String(order.paymentStatus || '').toUpperCase() !== 'PAID' || String(order.status || '').toUpperCase() !== 'PROCESSING') continue
        const linkedRental = Object.values(rentals).find(r => r?.orderRef === order.ref && r?.active)
        if (linkedRental) {
            order.status = 'DONE'
            order.fulfilledAt = Number(order.fulfilledAt || linkedRental.createdAt || now)
            order.rental = { id: linkedRental.id, startAt: linkedRental.startAt, expiresAt: linkedRental.expiresAt }
        } else {
            order.status = 'WAITING_GROUP_LINK'
            order.fulfillmentError = 'Order dipulihkan setelah proses terhenti. Kirim ulang link grup WhatsApp; jangan membayar ulang.'
        }
        order.updatedAt = now
        ordersChanged = true
    }
    for (const rental of Object.values(rentals)) {
        if (!rental?.active) continue
        if (now >= Number(rental.expiresAt || 0)) {
            rental.active = false
            rental.updatedAt = now
            changed = true
            await notifyExpiration(rental, 'expired')
            continue
        }
        const remaining = rental.expiresAt - now
        if (remaining <= 86400000 && !rental.warned24h) {
            rental.warned24h = true
            rental.updatedAt = now
            changed = true
            await notifyExpiration(rental, 'warning')
        } else if (remaining <= 3 * 86400000 && !rental.warned72h) {
            rental.warned72h = true
            rental.updatedAt = now
            changed = true
            await notifyExpiration(rental, 'warning')
        }
    }
    if (changed) saveRentals(rentals)
    if (ordersChanged) saveOrders(orders)
}

function startMonitor() {
    if (monitor) return monitor
    monitor = setInterval(() => {
        try { loadInventoryState() } catch (e) { console.error('[STORE STOCK MONITOR]', e?.stack || e) }
        monitorRentals().catch(e => console.error('[STORE RENTAL MONITOR]', e?.stack || e))
    }, Number(cfg().monitorIntervalMs || 300000))
    return monitor
}

function setSender(fn) { sender = fn }
function setWaConnection(connection) { waConnection = connection }
function setOwnerSender(fn) { ownerSender = fn }
function setOwnerTelegramSender(fn) { ownerTelegramSender = fn }
function setContactSender(fn) { contactSender = fn }
function setPrefix(prefix) { global.storeConfig = { ...(global.storeConfig || {}), prefix } }

module.exports = {
    products, getProduct, formatMoney, parseDuration, normalizeJid,
    createOrder, qrBuffer, getOrder, updateOrder, cancelOrder, listOrders, handlePaid,
    markProcessing, finishPanel, activateRental, addTime, getRental,
    startMonitor, monitorRentals, handleCustomerInput, setSender, setWaConnection, setOwnerSender, setOwnerTelegramSender, setContactSender, setPrefix
}
