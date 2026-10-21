'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sendQrWithButtonsInteractive } = require('../library/transaction-qr-interactive.js')

const factory = { fromObject: value => value }
const proto = {
    Message: {
        InteractiveMessage: Object.assign((value) => value, {
            fromObject: value => value,
            Header: factory,
            Body: factory,
            Footer: factory,
            NativeFlowMessage: factory
        })
    }
}

const buttons = [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Cek Status', id: '.orderstatus ORD123' }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Batalkan Order', id: '.ordercancel ORD123' }) }
]

 test('sends QR image, invoice details, and cancel/status buttons as one interactive message', async () => {
    const sent = []
    const upload = async () => {}
    const conn = {
        waUploadToServer: upload,
        async relayMessage(chat, message, options) {
            sent.push({ chat, message, options })
        }
    }
    const message = { key: { id: 'combined-qr-1', remoteJid: 'buyer@s.whatsapp.net', fromMe: true } }
    const result = await sendQrWithButtonsInteractive({
        conn,
        chat: 'buyer@s.whatsapp.net',
        quoted: { key: { id: 'incoming' } },
        imageBuffer: Buffer.from('qr'),
        bodyText: 'Invoice ORD123\nRp3.000\nScan QRIS',
        footer: 'Store QRIS',
        nativeButtons: buttons,
        proto,
        generateWAMessageFromContent: (chat, content, options) => ({ ...message, message: content, options }),
        prepareWAMessageMedia: async (media, options) => {
            assert.equal(media.image.toString(), 'qr')
            assert.equal(options.upload, upload)
            return { imageMessage: { url: 'encrypted-media-url' } }
        },
        userJid: 'buyer@s.whatsapp.net'
    })

    assert.equal(result.sent, true)
    assert.equal(result.message.key.id, 'combined-qr-1')
    assert.equal(sent.length, 1, 'only one WhatsApp message should be relayed')
    assert.equal(sent[0].options.messageId, 'combined-qr-1')
    const interactive = sent[0].message.viewOnceMessage.message.interactiveMessage
    assert.equal(interactive.header.hasMediaAttachment, true)
    assert.deepEqual(interactive.header.imageMessage, { url: 'encrypted-media-url' })
    assert.match(interactive.body.text, /ORD123/)
    assert.equal(interactive.nativeFlowMessage.buttons.length, 2)
    assert.match(interactive.nativeFlowMessage.buttons[1].buttonParamsJson, /ordercancel/)
})

test('fails closed so caller can use the split QR fallback if combined relay is rejected', async () => {
    await assert.rejects(
        () => sendQrWithButtonsInteractive({
            conn: {
                waUploadToServer: async () => {},
                async relayMessage() { throw new Error('interactive media rejected') }
            },
            chat: 'buyer@s.whatsapp.net',
            imageBuffer: Buffer.from('qr'),
            bodyText: 'Invoice',
            nativeButtons: buttons,
            proto,
            generateWAMessageFromContent: (chat, content) => ({ key: { id: 'combined-fail' }, message: content }),
            prepareWAMessageMedia: async () => ({ imageMessage: { url: 'encrypted-media-url' } })
        }),
        /interactive media rejected/
    )
})
