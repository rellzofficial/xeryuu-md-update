'use strict'

/**
 * Deliver a QRIS image and its status/cancel actions in one native WhatsApp
 * interactive message. The caller must keep its split-image fallback because
 * a few Baileys/client combinations reject interactive media headers.
 */
async function sendQrWithButtonsInteractive({
    conn,
    chat,
    quoted,
    imageBuffer,
    bodyText,
    footer = 'Xeryuu-Md V17 × Sendrich • Transaksi',
    nativeButtons = [],
    proto,
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    userJid
} = {}) {
    if (!conn || typeof conn.relayMessage !== 'function') throw new Error('Relay WhatsApp untuk pesan QRIS interaktif tidak tersedia.')
    if (!chat) throw new Error('Chat tujuan QRIS tidak tersedia.')
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) throw new Error('Buffer QRIS kosong; pesan gabungan tidak dibuat.')
    if (!Array.isArray(nativeButtons) || nativeButtons.length === 0) throw new Error('Tombol transaksi tidak tersedia untuk pesan QRIS gabungan.')
    if (typeof prepareWAMessageMedia !== 'function' || typeof generateWAMessageFromContent !== 'function') {
        throw new Error('Fungsi persiapan media WhatsApp tidak tersedia.')
    }

    const interactive = proto?.Message?.InteractiveMessage
    if (!interactive?.fromObject || !interactive.Header?.fromObject || !interactive.Body?.fromObject || !interactive.Footer?.fromObject || !interactive.NativeFlowMessage?.fromObject) {
        throw new Error('Struktur InteractiveMessage tidak kompatibel pada build Baileys ini.')
    }

    const preparedMedia = await prepareWAMessageMedia(
        { image: imageBuffer },
        { upload: conn.waUploadToServer }
    )
    if (!preparedMedia?.imageMessage) throw new Error('WhatsApp tidak mengembalikan imageMessage untuk QRIS.')

    const interactiveMessage = interactive.fromObject({
        header: interactive.Header.fromObject({
            title: '💳 QRIS PEMBAYARAN',
            hasMediaAttachment: true,
            ...preparedMedia
        }),
        body: interactive.Body.fromObject({ text: String(bodyText || '📲 Scan QRIS untuk membayar.') }),
        footer: interactive.Footer.fromObject({ text: String(footer || 'Xeryuu-Md V17 × Sendrich • Transaksi') }),
        nativeFlowMessage: interactive.NativeFlowMessage.fromObject({
            buttons: nativeButtons.slice(0, 3),
            messageParamsJson: '{}'
        })
    })

    const outgoing = generateWAMessageFromContent(chat, {
        viewOnceMessage: {
            message: {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage
            }
        }
    }, { quoted, userJid })

    if (!outgoing?.key?.id || !outgoing?.message) {
        throw new Error('WhatsApp tidak menghasilkan key pesan QRIS; tidak aman mengirim kontrol tanpa referensi hapus.')
    }

    await conn.relayMessage(chat, outgoing.message, { messageId: outgoing.key.id })
    return { sent: true, message: outgoing }
}

module.exports = { sendQrWithButtonsInteractive }
