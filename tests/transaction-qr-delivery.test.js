'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sendQrImageMessage } = require('../library/transaction-qr-delivery.js')

const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const quoted = { key: { id: 'input-message' }, message: { conversation: '.deposit 1000' } }

 test('sends QR using a minimal image payload without externalAdReply context', async () => {
    const calls = []
    const conn = {
        async sendMessage(chat, payload, options) {
            calls.push({ chat, payload, options })
            return { key: { id: 'qr-image-1', remoteJid: chat, fromMe: true } }
        }
    }
    const result = await sendQrImageMessage({
        conn, chat: 'user@s.whatsapp.net', quoted, imageBuffer: png,
        caption: 'QRIS deposit', contextInfo: { externalAdReply: { thumbnail: Buffer.alloc(1800000) } }
    })
    assert.equal(result.sent, true)
    assert.equal(result.message.key.id, 'qr-image-1')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].payload.image, png)
    assert.equal(calls[0].payload.caption, 'QRIS deposit')
    assert.equal(Object.hasOwn(calls[0].payload, 'contextInfo'), false)
    assert.equal(calls[0].options.quoted, quoted)
})

test('falls back to an unquoted image if this Baileys connection rejects quoted media', async () => {
    const calls = []
    const conn = {
        async sendMessage(chat, payload, options) {
            calls.push({ chat, payload, options })
            if (options?.quoted) throw new Error('quoted media not supported')
            return { key: { id: 'qr-image-2', remoteJid: chat, fromMe: true } }
        }
    }
    const logs = []
    const result = await sendQrImageMessage({ conn, chat: 'user@s.whatsapp.net', quoted, imageBuffer: png, caption: 'QRIS', onError: e => logs.push(e.message) })
    assert.equal(result.sent, true)
    assert.equal(result.attempt, 'caption tanpa quoted')
    assert.equal(calls.length, 2)
    assert.equal(calls[1].options, undefined)
    assert.equal(logs.length, 1)
    assert.match(logs[0], /fallback caption tanpa quoted/)
})

test('falls back to image-only when WhatsApp rejects the caption payload', async () => {
    const calls = []
    const conn = {
        async sendMessage(chat, payload, options) {
            calls.push({ chat, payload, options })
            if (payload.caption) throw new Error('caption too long')
            return { key: { id: 'qr-image-3', remoteJid: chat, fromMe: true } }
        }
    }
    const result = await sendQrImageMessage({ conn, chat: 'user@s.whatsapp.net', quoted, imageBuffer: png, caption: 'very long caption' })
    assert.equal(result.sent, true)
    assert.equal(result.attempt, 'gambar tanpa caption + quoted')
    assert.equal(calls.length, 3)
    assert.equal(Object.hasOwn(calls[2].payload, 'caption'), false)
})

test('reports useful errors if all image delivery fallbacks fail', async () => {
    const conn = { async sendMessage() { throw new Error('connection closed') } }
    let logged = ''
    const result = await sendQrImageMessage({ conn, chat: 'user@s.whatsapp.net', quoted, imageBuffer: png, caption: 'QRIS', onError: e => { logged = e.message } })
    assert.equal(result.sent, false)
    assert.match(result.error.message, /semua cara/i)
    assert.match(result.error.message, /connection closed/)
    assert.equal(logged, result.error.message)
})

test('rejects missing QR media instead of silently sending an empty image', async () => {
    let called = false
    const result = await sendQrImageMessage({ conn: { async sendMessage() { called = true } }, chat: 'user@s.whatsapp.net', imageBuffer: Buffer.alloc(0) })
    assert.equal(result.sent, false)
    assert.equal(called, false)
    assert.match(result.error.message, /kosong/i)
})
