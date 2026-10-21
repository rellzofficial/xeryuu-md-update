'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {
    cleanPaymentNumber,
    makePaymentMethods,
    createPaymentCarouselSender
} = require('../library/payment-carousel.js')

const identity = { fromObject: value => value }
function fakeProto() {
    return {
        Message: {
            InteractiveMessage: {
                fromObject: value => value,
                Header: identity,
                Body: identity,
                Footer: identity,
                NativeFlowMessage: identity,
                CarouselMessage: identity
            }
        }
    }
}

async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xeryuu-payment-'))
    const qrisPath = path.join(root, 'qris.jpg')
    const brandPath = path.join(root, 'brand.jpg')
    await fs.writeFile(qrisPath, Buffer.from('fake qris image bytes'))
    await fs.writeFile(brandPath, Buffer.from('fake brand image bytes'))
    return { root, qrisPath, brandPath, cleanup: () => fs.rm(root, { recursive: true, force: true }) }
}

test('payment number validation rejects placeholders and non-numbers', () => {
    assert.equal(cleanPaymentNumber('089 663 152244'), '089663152244')
    assert.equal(cleanPaymentNumber('+62 812-1234-5678'), '+6281212345678')
    assert.equal(cleanPaymentNumber('-'), '')
    assert.equal(cleanPaymentNumber('Tersedia'), '')
    assert.equal(cleanPaymentNumber('nomor admin'), '')
    assert.equal(cleanPaymentNumber('1234'), '')
})

test('payment methods only include valid configured wallets', () => {
    const methods = makePaymentMethods({ dana: '089663152244', ovo: '-', gopay: 'not set', shopeepay: '+6281234567890' })
    assert.deepEqual(methods.map(method => method.key), ['dana', 'shopeepay'])
    assert.deepEqual(methods.map(method => method.number), ['089663152244', '+6281234567890'])
})

test('sends a real native carousel and copy buttons match configured payment numbers', async t => {
    const files = await fixture()
    t.after(files.cleanup)
    let relayArgs = null
    let generated = null
    const sender = createPaymentCarouselSender({
        proto: fakeProto(),
        projectRoot: files.root,
        sleep: async () => {},
        generateWAMessageFromContent: (chat, payload, options) => {
            generated = { chat, payload, options }
            return { key: { id: 'payment-carousel-message-id' }, message: payload }
        },
        prepareWAMessageMedia: async ({ image }) => ({ imageMessage: { byteLength: image.length } })
    })
    const conn = {
        user: { id: '999@s.whatsapp.net' },
        waUploadToServer: async () => {},
        relayMessage: async (...args) => { relayArgs = args; return { tag: 'ack' } },
        sendMessage: async () => { throw new Error('fallback should not be used') }
    }
    const msg = { chat: '123@s.whatsapp.net', sender: '123@s.whatsapp.net', key: { id: 'incoming' } }
    const result = await sender(conn, msg, { dana: '089 663 152244', ovo: '-', gopay: '081234567890' }, {
        qrisPath: files.qrisPath,
        brandPath: files.brandPath
    })

    assert.equal(result.mode, 'carousel')
    assert.equal(result.cards, 3)
    assert.ok(generated)
    assert.equal(generated.options.userJid, '999@s.whatsapp.net')
    assert.ok(relayArgs)
    assert.equal(relayArgs[2].messageId, 'payment-carousel-message-id')
    const cards = relayArgs[1].interactiveMessage.carouselMessage.cards
    const walletCards = cards.filter(card => card.nativeFlowMessage.buttons.some(button => button.name === 'cta_copy'))
    const copiedNumbers = walletCards.map(card => JSON.parse(card.nativeFlowMessage.buttons[0].buttonParamsJson).copy_code)
    assert.deepEqual(copiedNumbers, ['089663152244', '081234567890'])
    assert.ok(cards.some(card => card.body.text.includes('QRIS')))
})

test('omits unconfigured wallet placeholders and still creates two honest cards', async t => {
    const files = await fixture()
    t.after(files.cleanup)
    let cardsSeen = []
    const sender = createPaymentCarouselSender({
        proto: fakeProto(), projectRoot: files.root, sleep: async () => {},
        generateWAMessageFromContent: (chat, payload) => ({ key: { id: 'id' }, message: payload }),
        prepareWAMessageMedia: async ({ image }) => ({ imageMessage: { byteLength: image.length } })
    })
    const conn = {
        user: { id: '999@s.whatsapp.net' }, waUploadToServer: async () => {},
        relayMessage: async (chat, payload) => { cardsSeen = payload.interactiveMessage.carouselMessage.cards; return { tag: 'ack' } },
        sendMessage: async () => { throw new Error('fallback should not be used') }
    }
    const result = await sender(conn, { chat: '123@s.whatsapp.net' }, { dana: '-', ovo: '', gopay: 'Tersedia' }, {
        qrisPath: files.qrisPath, brandPath: files.brandPath
    })
    assert.equal(result.mode, 'carousel')
    assert.equal(result.cards, 2)
    assert.ok(cardsSeen.some(card => card.body.text.includes('QRIS')))
    assert.ok(cardsSeen.some(card => card.body.text.includes('Nomor e-wallet belum dikonfigurasi')))
    assert.equal(cardsSeen.some(card => card.nativeFlowMessage.buttons.some(button => button.name === 'cta_copy')), false)
})

test('uses a text and QRIS fallback if WhatsApp rejects carousel relay', async t => {
    const files = await fixture()
    t.after(files.cleanup)
    const sent = []
    const sender = createPaymentCarouselSender({
        proto: fakeProto(), projectRoot: files.root, sleep: async () => {},
        generateWAMessageFromContent: () => ({ key: { id: 'id' }, message: {} }),
        prepareWAMessageMedia: async ({ image }) => ({ imageMessage: { byteLength: image.length } })
    })
    const conn = {
        user: { id: '999@s.whatsapp.net' }, waUploadToServer: async () => {},
        relayMessage: async () => { throw new Error('forced relay failure') },
        sendMessage: async (chat, payload) => { sent.push({ chat, payload }) }
    }
    const result = await sender(conn, { chat: '123@s.whatsapp.net' }, { dana: '089663152244' }, {
        qrisPath: files.qrisPath, brandPath: files.brandPath
    })
    assert.equal(result.mode, 'fallback')
    assert.equal(sent.length, 2)
    assert.ok(sent[0].payload.text.includes('089663152244'))
    assert.ok(Buffer.isBuffer(sent[1].payload.image))
})
