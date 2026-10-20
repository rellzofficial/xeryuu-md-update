'use strict'

function isPublicPinterestUrl(value) {
    try {
        const parsed = new URL(String(value || '').trim())
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
        const validHost = host === 'pin.it' || host.endsWith('.pin.it') ||
            host === 'pinterest.com' || host.endsWith('.pinterest.com') ||
            /^pinterest\.[a-z]{2,3}$/i.test(host) || /^pinterest\.co\.[a-z]{2}$/i.test(host)
        return ['http:', 'https:'].includes(parsed.protocol) && validHost ? parsed.toString() : ''
    } catch {
        return ''
    }
}

function createPinterestCarouselSender(dependencies = {}) {
    const proto = dependencies.proto
    const generateWAMessageFromContent = dependencies.generateWAMessageFromContent
    const prepareWAMessageMedia = dependencies.prepareWAMessageMedia
    const sleep = typeof dependencies.sleep === 'function'
        ? dependencies.sleep
        : ms => new Promise(resolve => setTimeout(resolve, ms))

    return async function sendPinterestCarousel(conn, incomingMessage, inputItems, query, limit = 5) {
        const Interactive = proto?.Message?.InteractiveMessage
        const Carousel = Interactive?.CarouselMessage
        if (!Interactive?.fromObject || !Carousel?.fromObject || typeof generateWAMessageFromContent !== 'function') {
            throw new Error('Struktur native carousel tidak tersedia pada library WhatsApp yang terpasang.')
        }
        if (typeof prepareWAMessageMedia !== 'function' || typeof conn?.waUploadToServer !== 'function') {
            throw new Error('Fungsi upload media WhatsApp tidak tersedia untuk membuat carousel.')
        }

        const maxCards = Math.max(2, Math.min(10, Number(limit) || 5))
        const sourceItems = (Array.isArray(inputItems) ? inputItems : [])
            .filter(item => typeof item?.image === 'string' && /^https:\/\//i.test(item.image))
            .slice(0, maxCards)
        if (sourceItems.length < 2) throw new Error('Carousel membutuhkan minimal dua gambar valid.')

        const cards = []
        for (let index = 0; index < sourceItems.length; index++) {
            const item = sourceItems[index]
            try {
                const uploadedMedia = await prepareWAMessageMedia(
                    { image: { url: item.image } },
                    { upload: conn.waUploadToServer }
                )
                if (!uploadedMedia?.imageMessage) throw new Error('Gambar gagal diproses untuk WhatsApp.')

                const pinUrl = isPublicPinterestUrl(item.source)
                const sourceUrl = pinUrl || item.image
                const cardButtons = sourceUrl ? [{
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: pinUrl ? 'Buka Pin' : 'Buka Gambar',
                        url: sourceUrl,
                        merchant_url: sourceUrl
                    })
                }] : []
                const shortTitle = String(item.title || `Hasil ${index + 1}`)
                    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120)

                cards.push({
                    header: Interactive.Header.fromObject({
                        title: `Pinterest ${cards.length + 1}`,
                        hasMediaAttachment: true,
                        ...uploadedMedia
                    }),
                    body: Interactive.Body.fromObject({ text: shortTitle || `Hasil ${index + 1}` }),
                    footer: Interactive.Footer.fromObject({ text: 'Pinterest • Xeryuu-MD' }),
                    nativeFlowMessage: Interactive.NativeFlowMessage.fromObject({
                        buttons: cardButtons,
                        messageParamsJson: ''
                    })
                })
            } catch (error) {
                console.warn(`[PINTEREST CAROUSEL CARD ${index + 1}]`, error?.message || error)
            }
            if (index < sourceItems.length - 1) await sleep(250)
        }

        if (cards.length < 2) throw new Error('Kurang dari dua gambar berhasil diunggah, carousel tidak bisa dibuat.')

        const bodyText = `📌 Hasil Pinterest untuk: ${String(query || 'pencarian').slice(0, 100)}\nGeser kartu ke samping untuk melihat gambar lainnya.`
        const botJid = conn?.user?.id || conn?.user?.jid
        if (!botJid) throw new Error('JID akun bot tidak tersedia untuk membentuk pesan carousel.')

        // Build the interactive message as a native-flow payload. In compatible
        // Baileys forks the relay must include the biz/native_flow node; otherwise
        // WhatsApp may ACK the stanza but silently omit the carousel in the chat.
        const waMessage = await generateWAMessageFromContent(incomingMessage.chat, {
            messageContextInfo: {
                deviceListMetadata: {},
                deviceListMetadataVersion: 2
            },
            interactiveMessage: Interactive.fromObject({
                body: Interactive.Body.fromObject({ text: bodyText }),
                footer: Interactive.Footer.fromObject({ text: 'Xeryuu-MD • Pinterest Search' }),
                header: Interactive.Header.fromObject({ hasMediaAttachment: false }),
                carouselMessage: Carousel.fromObject({ cards })
            })
        }, { userJid: botJid })

        if (!waMessage?.message || !waMessage?.key?.id) {
            throw new Error('Baileys tidak menghasilkan payload/message ID carousel yang valid.')
        }
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
        const isGroup = String(incomingMessage.chat || '').endsWith('@g.us')
        const additionalNodes = isGroup
            ? [bizNode]
            : [{ tag: 'bot', attrs: { biz_bot: '1' } }, bizNode]
        const relayResult = await conn.relayMessage(incomingMessage.chat, waMessage.message, {
            messageId: waMessage.key.id,
            additionalNodes
        })
        if (relayResult?.tag === 'error' || relayResult?.attrs?.type === 'error') {
            throw new Error('Server WhatsApp menolak payload carousel.')
        }
        return cards.length
    }
}

async function sendPinterestSearchFallback(conn, incomingMessage, items, query, limit = 5, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    let sent = 0
    const maxItems = Math.min(10, Math.max(1, Number(limit) || 5))
    for (const item of (Array.isArray(items) ? items : []).slice(0, maxItems)) {
        if (typeof item?.image !== 'string' || !/^https:\/\//i.test(item.image)) continue
        try {
            await conn.sendMessage(incomingMessage.chat, {
                image: { url: item.image },
                caption: `📌 ${String(item.title || query || 'Pinterest').slice(0, 120)}\n${item.source || 'Hasil pencarian Pinterest'}`
            }, { quoted: incomingMessage })
            sent++
            await sleep(300)
        } catch (error) {
            console.warn('[PINTEREST NORMAL IMAGE FALLBACK]', error?.message || error)
        }
    }
    return sent
}

module.exports = {
    isPublicPinterestUrl,
    createPinterestCarouselSender,
    sendPinterestSearchFallback
}
