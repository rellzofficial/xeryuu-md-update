'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x01])
const axiosCalls = []
let qrCalls = []
let fetchResult = PNG
const axiosStub = {
    get: async (url, options) => {
        axiosCalls.push({ url, options })
        return { data: fetchResult, headers: { 'content-type': 'image/png' }, status: 200 }
    }
}
const qrcodeStub = {
    toBuffer: async (text, options) => {
        qrCalls.push({ text, options })
        return PNG
    }
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (path.basename(parent?.filename || '') === 'deposit.js' && request === 'axios') return axiosStub
    if (path.basename(parent?.filename || '') === 'deposit.js' && request === 'qrcode') return qrcodeStub
    if (path.basename(parent?.filename || '') === 'deposit.js' && request === './economy.js') return { applyMoneyTransaction() {}, getBalance: () => 0 }
    if (path.basename(parent?.filename || '') === 'deposit.js' && request === './global-database.js') return { saveGlobalDatabase: () => true }
    return originalLoad.call(this, request, parent, isMain)
}
const depositService = require('../library/deposit.js')
Module._load = originalLoad

function resetMocks() {
    axiosCalls.length = 0
    qrCalls = []
    fetchResult = PNG
}

test('normalizes a wrapped provider response containing the documented qris_data field', () => {
    const tx = depositService.parseDeposit({
        data: {
            result: {
                trx_id: 'INV123',
                amount: 25000,
                qris_data: '00020101021226TEST6304ABCD',
                status: 'pending',
                expired_at: '2026-10-21T09:00:00+07:00'
            }
        }
    }, { jid: 'user@s.whatsapp.net', amount: 25000, merchantRef: 'DEP123' })

    assert.equal(tx.gatewayId, 'INV123')
    assert.equal(tx.qrString, '00020101021226TEST6304ABCD')
    assert.equal(tx.status, 'UNPAID')
    assert.equal(tx.amount, 25000)
})

test('treats provider status=true on invoice creation as a successful API response, not a paid invoice', () => {
    const tx = depositService.parseDeposit({
        status: true,
        trx_id: 'INV-BOOLEAN-STATUS',
        amount: 25000,
        qris_data: '00020101021226TEST6304ABCD'
    }, { jid: 'user@s.whatsapp.net', amount: 25000, merchantRef: 'DEP-BOOLEAN' })
    assert.equal(tx.status, 'UNPAID')
    assert.equal(tx.credited, false)
})

test('does not treat generic success from invoice generation as proof of payment', () => {
    const tx = depositService.parseDeposit({
        status: 'success',
        trx_id: 'INV-CREATE-SUCCESS',
        amount: 25000,
        qris_data: '00020101021226TEST6304ABCD'
    }, { jid: 'user@s.whatsapp.net', amount: 25000, merchantRef: 'DEP-CREATE-SUCCESS' })
    assert.equal(tx.status, 'UNPAID')
})

test('treats generic success from a status-check response as paid, but keeps active/open unpaid', () => {
    const checked = depositService.parseDeposit({ status: 'success', trx_id: 'INV-CHECK' }, {
        merchantRef: 'DEP-CHECK', status: 'UNPAID', statusContext: 'check'
    })
    const active = depositService.parseDeposit({ status: 'active', trx_id: 'INV-ACTIVE' }, {
        merchantRef: 'DEP-ACTIVE'
    })
    const open = depositService.parseDeposit({ status: 'open', trx_id: 'INV-OPEN' }, {
        merchantRef: 'DEP-OPEN'
    })
    assert.equal(checked.status, 'PAID')
    assert.equal(active.status, 'UNPAID')
    assert.equal(open.status, 'UNPAID')
})

test('prefers explicit payment_status over generic API status', () => {
    const tx = depositService.parseDeposit({
        status: true,
        payment_status: 'paid',
        trx_id: 'INV-EXPLICIT-PAID',
        amount: 25000,
        qris_data: '00020101021226TEST6304ABCD'
    }, { merchantRef: 'DEP-EXPLICIT-PAID' })
    assert.equal(tx.status, 'PAID')
})

test('renders the actual QRIS payload into a PNG buffer', async () => {
    resetMocks()
    const result = await depositService.qrBuffer({ qrString: '00020101021226TEST6304ABCD' })
    assert.ok(Buffer.isBuffer(result))
    assert.equal(result, PNG)
    assert.equal(qrCalls.length, 1)
    assert.equal(qrCalls[0].text, '00020101021226TEST6304ABCD')
    assert.equal(qrCalls[0].options.width, 900)
    assert.equal(axiosCalls.length, 0)
})

test('decodes a QR image data URL without wrapping it as a QR payload', async () => {
    resetMocks()
    const dataUrl = `data:image/png;base64,${PNG.toString('base64')}`
    const result = await depositService.qrBuffer({ qrImage: dataUrl })
    assert.deepEqual(result, PNG)
    assert.equal(qrCalls.length, 0)
})

test('downloads and validates a remote QR image', async () => {
    resetMocks()
    const result = await depositService.qrBuffer({ qrImage: 'https://cdn.example/qr.png' })
    assert.deepEqual(result, PNG)
    assert.equal(axiosCalls.length, 1)
    assert.equal(axiosCalls[0].url, 'https://cdn.example/qr.png')
    assert.equal(axiosCalls[0].options.responseType, 'arraybuffer')
})

test('rejects an HTML response returned by a QR image URL', async () => {
    resetMocks()
    fetchResult = Buffer.from('<html>403 forbidden</html>')
    await assert.rejects(
        () => depositService.qrBuffer({ qrImage: 'https://cdn.example/qr.png' }),
        /respons bukan PNG\/JPEG\/WEBP\/GIF/
    )
})

test('does not create a misleading QR from an invoice URL when no QRIS payload exists', async () => {
    resetMocks()
    const result = await depositService.qrBuffer({ checkoutUrl: 'https://merchant.example/invoice/DEP123' })
    assert.equal(result, null)
    assert.equal(qrCalls.length, 0)
})
