'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
    isPublicPinterestUrl,
    createPinterestCarouselSender,
    sendPinterestSearchFallback
} = require('../library/pinterest-carousel.js')

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

test('Pinterest source URL validator only allows Pinterest hosts', () => {
    assert.equal(isPublicPinterestUrl('https://www.pinterest.com/pin/123/'), 'https://www.pinterest.com/pin/123/')
    assert.equal(isPublicPinterestUrl('https://pin.it/abc'), 'https://pin.it/abc')
    assert.equal(isPublicPinterestUrl('https://example.com/pin/123'), '')
    assert.equal(isPublicPinterestUrl('javascript:alert(1)'), '')
})

test('creates and relays a native carousel with multiple prepared image cards', async () => {
    let relayed = null
    let generationOptions = null
    const sender = createPinterestCarouselSender({
        proto: fakeProto(),
        generateWAMessageFromContent: (chat, message, options) => {
            generationOptions = options
            return { key: { id: 'generated-message-id' }, message: { chat, message, options } }
        },
        prepareWAMessageMedia: async ({ image }) => ({ imageMessage: { url: image.url } }),
        sleep: async () => {}
    })
    const conn = {
        user: { id: '99999@s.whatsapp.net' },
        waUploadToServer: async () => {},
        relayMessage: async (...args) => { relayed = args; return { tag: 'ack' } }
    }
    const message = { chat: '12345@s.whatsapp.net', sender: '12345@s.whatsapp.net', key: { id: 'incoming' } }
    const items = [
        { image: 'https://i.pinimg.com/one.jpg', title: 'Gambar satu', source: 'https://www.pinterest.com/pin/1/' },
        { image: 'https://i.pinimg.com/two.jpg', title: 'Gambar dua', source: 'https://example.com/not-a-pin' }
    ]

    const sentCount = await sender(conn, message, items, 'anime', 5)
    assert.equal(sentCount, 2)
    assert.ok(relayed)
    assert.equal(relayed[0], message.chat)
    assert.equal(relayed[2].messageId, 'generated-message-id')
    const interactive = relayed[1].message.interactiveMessage
    assert.equal(generationOptions.userJid, '99999@s.whatsapp.net')
    assert.equal(interactive.carouselMessage.cards.length, 2)
    assert.equal(interactive.carouselMessage.cards[0].nativeFlowMessage.buttons[0].name, 'cta_url')
    assert.equal(JSON.parse(interactive.carouselMessage.cards[0].nativeFlowMessage.buttons[0].buttonParamsJson).url, items[0].source)
    assert.deepEqual(relayed[2].additionalNodes.map(node => node.tag), ['bot', 'biz'])
    assert.equal(relayed[2].additionalNodes[1].content[0].attrs.type, 'native_flow')
})

test('carousel sender rejects one result so caller can use the normal-image fallback', async () => {
    const sender = createPinterestCarouselSender({
        proto: fakeProto(),
        generateWAMessageFromContent: () => ({ key: { id: 'id' }, message: {} }),
        prepareWAMessageMedia: async ({ image }) => ({ imageMessage: { url: image.url } }),
        sleep: async () => {}
    })
    const conn = { waUploadToServer: async () => {}, relayMessage: async () => {} }
    await assert.rejects(
        () => sender(conn, { chat: 'chat', sender: 'sender' }, [{ image: 'https://i.pinimg.com/one.jpg' }], 'anime', 5),
        /minimal dua gambar valid/
    )
})

test('normal-image fallback skips invalid URLs and sends valid Pinterest result', async () => {
    const sent = []
    const conn = { sendMessage: async (...args) => { sent.push(args) } }
    const message = { chat: 'chat', key: { id: 'incoming' } }
    const count = await sendPinterestSearchFallback(conn, message, [
        { image: 'javascript:alert(1)', title: 'invalid' },
        { image: 'https://i.pinimg.com/valid.jpg', title: 'Valid image', source: 'https://www.pinterest.com/pin/1/' }
    ], 'anime', 5, async () => {})
    assert.equal(count, 1)
    assert.equal(sent.length, 1)
    assert.equal(sent[0][1].image.url, 'https://i.pinimg.com/valid.jpg')
})
