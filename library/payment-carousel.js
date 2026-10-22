'use strict'

const fs = require('fs')
const path = require('path')

function cleanPaymentNumber(value) {
    const raw = String(value == null ? '' : value).trim()
    if (!raw || /^[-–—]+$/.test(raw) || /^(?:belum|tidak tersedia|n\/a|none|null|undefined)$/i.test(raw)) return ''
    const number = raw.replace(/[\s().-]/g, '')
    if (!/^\+?\d{8,16}$/.test(number)) return ''
    return number
}

function makePaymentMethods(settings = {}) {
    const definitions = [
        { key: 'dana', label: 'DANA', icon: '💙' },
        { key: 'ovo', label: 'OVO', icon: '💜' },
        { key: 'gopay', label: 'GoPay', icon: '💚' },
        { key: 'shopeepay', label: 'ShopeePay', icon: '🧡' },
        { key: 'linkaja', label: 'LinkAja', icon: '❤️' }
    ]
    return definitions.map(method => ({
        ...method,
        number: cleanPaymentNumber(settings[method.key])
    })).filter(method => method.number)
}

function createPaymentCarouselSender(dependencies = {}) {
    const proto = dependencies.proto
    const generateWAMessageFromContent = dependencies.generateWAMessageFromContent
    const prepareWAMessageMedia = dependencies.prepareWAMessageMedia
    const projectRoot = dependencies.projectRoot || process.cwd()
    const sleep = typeof dependencies.sleep === 'function'
        ? dependencies.sleep
        : ms => new Promise(resolve => setTimeout(resolve, ms))

    async function readImage(relativePath) {
        const fullPath = path.isAbsolute(relativePath) ? relativePath : path.join(projectRoot, relativePath)
        return fs.promises.readFile(fullPath)
    }

    async function fallback(conn, m, methods, qrisPath, error) {
        console.error('[XERYUU PAYMENT CAROUSEL]', error?.stack || error)
        const chunks = ['💳 *METODE PEMBAYARAN XERYUU-MD*', '', 'Nomor pembayaran yang dikonfigurasi:']
        if (methods.length) {
            for (const method of methods) chunks.push(`• ${method.label}: ${method.number}`)
        } else {
            chunks.push('• Belum ada nomor e-wallet yang dikonfigurasi.')
        }
        chunks.push('', 'Kirim bukti pembayaran kepada admin setelah membayar.')
        try {
            await conn.sendMessage(m.chat, { text: chunks.join('\n') }, { quoted: m })
            const qrisBuffer = await readImage(qrisPath)
            await conn.sendMessage(m.chat, {
                image: qrisBuffer,
                caption: '📷 QRIS pembayaran\nPeriksa nama merchant dan nominal sebelum mengonfirmasi pembayaran.'
            }, { quoted: m })
            return { mode: 'fallback', cards: 0 }
        } catch (fallbackError) {
            console.error('[XERYUU PAYMENT FALLBACK]', fallbackError?.stack || fallbackError)
            try {
                await conn.sendMessage(m.chat, { text: chunks.join('\n') }, { quoted: m })
            } catch {}
            return { mode: 'text-fallback', cards: 0 }
        }
    }

    return async function sendPaymentCarousel(conn, m, settings = {}, options = {}) {
        const qrisPath = options.qrisPath || 'qris.jpg'
        const brandPath = options.brandPath || path.join('media', 'payment1.jpg')
        const methods = makePaymentMethods(settings)
        const Interactive = proto?.Message?.InteractiveMessage
        const Carousel = Interactive?.CarouselMessage

        if (!Interactive?.fromObject || !Interactive?.Header?.fromObject || !Interactive?.Body?.fromObject ||
            !Interactive?.Footer?.fromObject || !Interactive?.NativeFlowMessage?.fromObject ||
            !Carousel?.fromObject || typeof generateWAMessageFromContent !== 'function' ||
            typeof prepareWAMessageMedia !== 'function' || typeof conn?.waUploadToServer !== 'function' ||
            typeof conn?.relayMessage !== 'function') {
            return fallback(conn, m, methods, qrisPath, new Error('Native carousel tidak tersedia pada library WhatsApp yang sedang dipakai.'))
        }

        let qrisBuffer
        let brandBuffer
        try {
            qrisBuffer = await readImage(qrisPath)
            try { brandBuffer = await readImage(brandPath) } catch { brandBuffer = qrisBuffer }
        } catch (error) {
            return fallback(conn, m, methods, qrisPath, error)
        }

        // Setidaknya dua kartu dibutuhkan untuk carousel. QRIS selalu satu kartu;
        // kartu kedua hanya berisi informasi admin jika nomor e-wallet belum disetel.
        const cardDefinitions = [
            ...methods.map(method => ({ type: 'wallet', ...method })),
            { type: 'qris', label: 'QRIS', icon: '📷', number: '' }
        ]
        if (cardDefinitions.length < 2) {
            cardDefinitions.push({
                type: 'info', label: 'Pembayaran manual', icon: 'ℹ️', number: '',
                note: 'Nomor e-wallet belum dikonfigurasi. Hubungi admin untuk metode pembayaran lain.'
            })
        }

        const cards = []
        for (let index = 0; index < cardDefinitions.length; index++) {
            const payment = cardDefinitions[index]
            try {
                const imageBuffer = payment.type === 'qris' ? qrisBuffer : brandBuffer
                const media = await prepareWAMessageMedia(
                    { image: imageBuffer },
                    { upload: conn.waUploadToServer }
                )
                if (!media?.imageMessage) throw new Error(`Media kartu ${payment.label} tidak terbentuk.`)

                let bodyText
                let buttons = []
                if (payment.type === 'wallet') {
                    bodyText = `${payment.icon} *${payment.label}*\n\nNomor pembayaran:\n${payment.number}\n\nTekan tombol di bawah untuk menyalin nomor dengan tepat.`
                    buttons = [{
                        name: 'cta_copy',
                        buttonParamsJson: JSON.stringify({
                            display_text: `Salin nomor ${payment.label}`.slice(0, 25),
                            copy_code: payment.number
                        })
                    }]
                } else if (payment.type === 'qris') {
                    bodyText = '📷 *Pembayaran QRIS*\n\nPindai QR pada kartu ini melalui aplikasi pembayaran yang mendukung QRIS. Pastikan nama merchant dan nominal benar sebelum membayar.'
                } else {
                    bodyText = `ℹ️ *${payment.label}*\n\n${payment.note}\n\nSilakan gunakan kartu QRIS atau hubungi admin.`
                }

                cards.push({
                    header: Interactive.Header.fromObject({
                        title: `${payment.icon} ${payment.label}`.slice(0, 60),
                        hasMediaAttachment: true,
                        ...media
                    }),
                    body: Interactive.Body.fromObject({ text: bodyText }),
                    footer: Interactive.Footer.fromObject({ text: 'Xeryuu-MD • Pembayaran manual' }),
                    nativeFlowMessage: Interactive.NativeFlowMessage.fromObject({
                        buttons,
                        messageParamsJson: ''
                    })
                })
            } catch (error) {
                console.error(`[XERYUU PAYMENT CARD ${payment.label}]`, error?.message || error)
            }
            if (index < cardDefinitions.length - 1) await sleep(120)
        }

        if (cards.length < 2) {
            return fallback(conn, m, methods, qrisPath, new Error('Kurang dari dua kartu pembayaran berhasil dibuat.'))
        }

        const botJid = conn?.user?.id || conn?.user?.jid
        if (!botJid) return fallback(conn, m, methods, qrisPath, new Error('JID akun bot belum tersedia.'))

        try {
            const waMessage = await generateWAMessageFromContent(m.chat, {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: Interactive.fromObject({
                    body: Interactive.Body.fromObject({ text: '💳 METODE PEMBAYARAN XERYUU-MD\nGeser kartu ke samping untuk memilih metode. Tombol salin hanya tersedia untuk nomor yang memang dikonfigurasi.' }),
                    footer: Interactive.Footer.fromObject({ text: 'Xeryuu-MD • Created by XnalzNotDev' }),
                    header: Interactive.Header.fromObject({ hasMediaAttachment: false }),
                    carouselMessage: Carousel.fromObject({ cards })
                })
            }, { userJid: botJid })

            if (!waMessage?.message || !waMessage?.key?.id) throw new Error('Payload carousel tidak valid.')
            const bizNode = {
                tag: 'biz',
                attrs: {
                    actual_actors: '2',
                    host_storage: '2',
                    privacy_mode_ts: String(Math.floor(Date.now() / 1000))
                },
                content: [{
                    tag: 'interactive',
                    attrs: { type: 'native_flow', v: '1' },
                    content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
                }]
            }
            const isGroup = String(m.chat || '').endsWith('@g.us')
            const additionalNodes = isGroup ? [bizNode] : [{ tag: 'bot', attrs: { biz_bot: '1' } }, bizNode]
            const relayResult = await conn.relayMessage(m.chat, waMessage.message, {
                messageId: waMessage.key.id,
                additionalNodes
            })
            if (relayResult?.tag === 'error' || relayResult?.attrs?.type === 'error') throw new Error('WhatsApp menolak payload carousel.')
            return { mode: 'carousel', cards: cards.length, methods: methods.map(method => method.key) }
        } catch (error) {
            return fallback(conn, m, methods, qrisPath, error)
        }
    }
}

module.exports = { cleanPaymentNumber, makePaymentMethods, createPaymentCarouselSender }
