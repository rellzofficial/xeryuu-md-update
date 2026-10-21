'use strict'

/**
 * Send a transaction QR as a normal WhatsApp image message.
 *
 * QR payment media deliberately uses a minimal payload: a large externalAdReply
 * thumbnail or an interactive-message context must not be able to break the
 * one message that actually contains the QR. If a Baileys build rejects the
 * quoted/captioned image, retry with progressively simpler payloads.
 */
async function sendQrImageMessage({
    conn,
    chat,
    quoted,
    imageBuffer,
    caption,
    contextInfo: _ignoredContextInfo = undefined,
    onError = undefined
} = {}) {
    if (!conn || typeof conn.sendMessage !== 'function') {
        return { sent: false, message: null, error: new Error('Koneksi WhatsApp belum tersedia.') }
    }
    if (!chat) {
        return { sent: false, message: null, error: new Error('Chat tujuan QRIS tidak tersedia.') }
    }
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        return { sent: false, message: null, error: new Error('Data gambar QRIS kosong atau tidak tersedia.') }
    }

    const captionText = String(caption || '📲 QRIS pembayaran')
    const attempts = [
        { payload: { image: imageBuffer, caption: captionText }, options: quoted ? { quoted } : undefined, label: 'caption + quoted' },
        { payload: { image: imageBuffer, caption: captionText }, options: undefined, label: 'caption tanpa quoted' },
        { payload: { image: imageBuffer }, options: quoted ? { quoted } : undefined, label: 'gambar tanpa caption + quoted' },
        { payload: { image: imageBuffer }, options: undefined, label: 'gambar minimal' }
    ]
    const errors = []

    for (const attempt of attempts) {
        try {
            const message = await conn.sendMessage(chat, attempt.payload, attempt.options)
            // A resolved send call is treated as sent even if a custom socket
            // wrapper omits the returned WAMessage. Do not retry a successful
            // send solely because it did not return a key; that could duplicate
            // the customer's QR payment message.
            if (!message?.key?.id && typeof onError === 'function') {
                try { onError(new Error(`QRIS terkirim dengan metode ${attempt.label}, tetapi socket tidak mengembalikan message key untuk pencatatan penghapusan.`)) } catch {}
            }
            if (errors.length && typeof onError === 'function') {
                try { onError(new Error(`Pengiriman QRIS memakai fallback ${attempt.label}. Percobaan sebelumnya: ${errors.map(item => item.message).join(' | ')}`)) } catch {}
            }
            return { sent: true, message: message || null, error: null, attempt: attempt.label }
        } catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)))
        }
    }

    const combinedError = new Error(`Semua cara pengiriman gambar QRIS gagal: ${errors.map((item, index) => `percobaan ${index + 1}: ${item.message}`).join(' || ')}`)
    combinedError.causes = errors
    if (typeof onError === 'function') {
        try { onError(combinedError) } catch {}
    }
    return { sent: false, message: null, error: combinedError }
}

module.exports = { sendQrImageMessage }
