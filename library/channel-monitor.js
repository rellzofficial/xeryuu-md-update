'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_CHANNEL_JID = '120363426041078526@newsletter'
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000
const EVENT_DEDUPE_TTL_MS = 30 * 60 * 1000
const EVENT_DEDUPE_FALLBACK_TTL_MS = 15 * 1000
const MAX_PENDING_EVENTS = 30

function renderChannelMonitorCard(channelName, noticeText) {
    try {
        const { createCanvas } = require('@napi-rs/canvas')
        const width = 1200
        const height = 675
        const canvas = createCanvas(width, height)
        const ctx = canvas.getContext('2d')
        const background = ctx.createLinearGradient(0, 0, width, height)
        background.addColorStop(0, '#081426')
        background.addColorStop(0.55, '#102b45')
        background.addColorStop(1, '#133e42')
        ctx.fillStyle = background
        ctx.fillRect(0, 0, width, height)

        ctx.fillStyle = 'rgba(255,255,255,0.045)'
        for (let x = -height; x < width + height; x += 150) {
            ctx.save()
            ctx.translate(x, 0)
            ctx.rotate(-Math.PI / 6)
            ctx.fillRect(0, 0, 34, height * 1.7)
            ctx.restore()
        }

        const roundedRect = (x, y, w, h, r, fill) => {
            ctx.beginPath()
            ctx.moveTo(x + r, y)
            ctx.lineTo(x + w - r, y)
            ctx.quadraticCurveTo(x + w, y, x + w, y + r)
            ctx.lineTo(x + w, y + h - r)
            ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
            ctx.lineTo(x + r, y + h)
            ctx.quadraticCurveTo(x, y + h, x, y + h - r)
            ctx.lineTo(x, y + r)
            ctx.quadraticCurveTo(x, y, x + r, y)
            ctx.closePath()
            ctx.fillStyle = fill
            ctx.fill()
        }
        roundedRect(54, 52, width - 108, height - 104, 34, 'rgba(4,12,24,0.56)')
        roundedRect(86, 86, 12, 110, 6, '#48e0bd')

        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = '#91f5df'
        ctx.font = '700 28px Arial, sans-serif'
        ctx.fillText('XERYUU-MD  /  SYSTEM NOTICE', 124, 122)
        ctx.fillStyle = '#ffffff'
        ctx.font = '900 56px Arial, sans-serif'
        ctx.fillText('MONITOR SALURAN', 124, 178)

        ctx.fillStyle = '#d5e5f4'
        ctx.font = '600 32px Arial, sans-serif'
        const title = String(channelName || 'Saluran developer').trim().slice(0, 58)
        ctx.fillText(title, 90, 262, width - 180)

        const details = String(noticeText || '')
            .split('\n')
            .map(line => line.replace(/^\s*[│|╭╰─═]+\s*/, '').replace(/[*_`]/g, '').trim())
            .filter(line => line && !/MONITOR SALURAN|PEMBARUAN PENGIKUT SALURAN|Notifikasi otomatis|Identitas dikirim|Identitas tidak tersedia/i.test(line))
            .filter(line => !/^─+$/.test(line))
            .slice(0, 5)
        let y = 330
        ctx.fillStyle = '#edf5fc'
        ctx.font = '500 27px Arial, sans-serif'
        for (const detail of details) {
            let remaining = detail
            const maxWidth = width - 190
            while (remaining && y < 525) {
                let line = remaining
                while (ctx.measureText(line).width > maxWidth && line.length > 1) line = line.slice(0, -1)
                if (line.length < remaining.length) {
                    const lastSpace = line.lastIndexOf(' ')
                    if (lastSpace > Math.floor(line.length * 0.55)) line = line.slice(0, lastSpace)
                }
                ctx.fillText(line, 94, y, maxWidth)
                remaining = remaining.slice(line.length).trim()
                y += 39
            }
            if (y >= 525) break
        }

        ctx.strokeStyle = 'rgba(145,245,223,0.45)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(92, 566)
        ctx.lineTo(width - 92, 566)
        ctx.stroke()
        ctx.fillStyle = '#91f5df'
        ctx.font = '700 22px Arial, sans-serif'
        ctx.fillText('PEMANTAUAN OTOMATIS', 94, 610)
        ctx.fillStyle = '#aebfd0'
        ctx.textAlign = 'right'
        ctx.font = '500 22px Arial, sans-serif'
        ctx.fillText(dateTimeJakarta(), width - 94, 610)
        return canvas.toBuffer('image/png')
    } catch (error) {
        console.warn('[CHANNEL MONITOR] Kartu visual gagal dibuat; memakai notifikasi teks:', error?.message || error)
        return null
    }
}

function makeOwnerNoticePayload(text, channelName) {
    const payload = { text }
    const thumbnailUrl = String(global.thumbnail2 || global.thumbnail || global.ppthumb || '').trim()
    const sourceUrl = String(global.linkSaluran || global.idSaluran || '').trim()
    const ad = {
        title: `Xeryuu-MD • ${String(channelName || 'Monitor Saluran').slice(0, 80)}`,
        body: 'Pembaruan otomatis monitoring saluran',
        mediaType: 1,
        renderLargerThumbnail: true
    }
    if (/^https?:\/\//i.test(thumbnailUrl)) ad.thumbnailUrl = thumbnailUrl
    if (/^https?:\/\//i.test(sourceUrl)) ad.sourceUrl = sourceUrl
    if (ad.thumbnailUrl || ad.sourceUrl) payload.contextInfo = { externalAdReply: ad }
    return payload
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '')
}

function normalizeOwnerJid(value) {
    const raw = String(value || '').trim()
    if (/^[1-9]\d{4,19}@s\.whatsapp\.net$/i.test(raw)) return raw
    if (/^[1-9]\d{4,19}@c\.us$/i.test(raw)) return `${raw.split('@')[0]}@s.whatsapp.net`
    const number = digitsOnly(raw)
    return number.length >= 5 ? `${number}@s.whatsapp.net` : ''
}

function normalizeChannelJid(value) {
    if (typeof value === 'string') {
        const raw = value.trim()
        const matched = raw.match(/(?:^|[^\d])(\d{5,25}@newsletter)(?:$|[^\w])/i)
        return matched ? matched[1] : (/^\d{5,25}@newsletter$/i.test(raw) ? raw : '')
    }
    if (value && typeof value === 'object') {
        for (const key of ['id', 'jid', 'newsletterJid', 'channelJid', 'channelId', 'newsletterId']) {
            const found = normalizeChannelJid(value[key])
            if (found) return found
        }
        for (const key of ['data', 'result', 'newsletter', 'channel', 'metadata']) {
            const found = normalizeChannelJid(value[key])
            if (found) return found
        }
    }
    return ''
}

function getInviteCode(value) {
    const raw = String(value || '').trim()
    const match = raw.match(/whatsapp\.com\/channel\/([^/?#]+)/i)
    return match?.[1] || ''
}

function getEventChannelId(event) {
    if (!event || typeof event !== 'object') return ''
    return normalizeChannelJid(
        event.id || event.newsletterJid || event.channelJid || event.newsletterId || event.channelId || event.jid || event.newsletter
    )
}

function normalizeAction(value) {
    const raw = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '')
    if (/remove|unfollow|leave|unsubscribe|delete|depart/.test(raw)) return 'remove'
    if (/add|follow|subscribe|join|create/.test(raw)) return 'add'
    return raw
}

function getEventAction(event, participant) {
    const candidates = [
        participant?.action, participant?.type, participant?.status, participant?.operation,
        event?.action, event?.type, event?.status, event?.operation, event?.eventType,
        event?.participantAction, event?.updateType
    ]
    for (const candidate of candidates) {
        const normalized = normalizeAction(candidate)
        if (normalized === 'remove' || normalized === 'add') return normalized
    }
    return ''
}

function normalizeUserCandidate(value) {
    if (typeof value === 'string') return value.trim()
    if (!value || typeof value !== 'object') return ''
    return String(value.phoneNumber || value.pn || value.jid || value.id || value.lid || value.user || value.participant || '').trim()
}

function getEventUsers(event) {
    if (!event || typeof event !== 'object') return []
    const candidates = []
    for (const key of ['user', 'participant', 'participantJid', 'phoneNumber', 'pn', 'jid', 'lid']) {
        if (event[key]) candidates.push(event[key])
    }
    for (const key of ['participants', 'users', 'members', 'removed', 'changes']) {
        const value = event[key]
        if (Array.isArray(value)) candidates.push(...value)
        else if (value) candidates.push(value)
    }
    const output = []
    const seen = new Set()
    for (const candidate of candidates) {
        const id = normalizeUserCandidate(candidate)
        if (!id || seen.has(id)) continue
        seen.add(id)
        output.push({ raw: id, source: candidate })
    }
    return output
}

function parseSubscriberCount(value, depth = 0) {
    if (depth > 5 || value == null) return null
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
    if (typeof value === 'string' && /^\d{1,12}$/.test(value.trim())) return Number(value.trim())
    if (Array.isArray(value)) return null
    if (typeof value !== 'object') return null
    for (const key of ['subscribers', 'subscriberCount', 'subscribersCount', 'subscriber_count', 'followers', 'followerCount', 'followersCount', 'followers_count', 'totalSubscribers', 'totalFollowers', 'participantsCount', 'participantCount', 'membersCount', 'total', 'count']) {
        if (key in value) {
            const parsed = parseSubscriberCount(value[key], depth + 1)
            if (parsed != null) return parsed
        }
    }
    for (const key of ['data', 'result', 'metadata', 'newsletter', 'channel']) {
        if (key in value) {
            const parsed = parseSubscriberCount(value[key], depth + 1)
            if (parsed != null) return parsed
        }
    }
    return null
}

async function resolveConfiguredChannel(sock, configuredValue) {
    const direct = normalizeChannelJid(configuredValue)
    if (direct) return { id: direct, source: 'configured-jid' }

    const raw = String(configuredValue || '').trim()
    const inviteCode = getInviteCode(raw)
    const calls = []
    if (raw && typeof sock.newsletterFromUrl === 'function') calls.push(() => sock.newsletterFromUrl(raw))
    if (raw && typeof sock.cekIDSaluran === 'function') calls.push(() => sock.cekIDSaluran(raw))
    if (raw && typeof sock.newsletterId === 'function') calls.push(() => sock.newsletterId(raw))
    if (inviteCode && typeof sock.newsletterMetadata === 'function') {
        calls.push(() => sock.newsletterMetadata('invite', inviteCode))
        calls.push(() => sock.newsletterMetadata('invite', raw))
        calls.push(() => sock.newsletterMetadata(inviteCode))
    }
    if (raw && typeof sock.newsletterMetadata === 'function') calls.push(() => sock.newsletterMetadata(raw))

    for (const call of calls) {
        try {
            const result = await call()
            const id = normalizeChannelJid(result)
            if (id) return { id, source: 'resolved-from-config' }
        } catch (_) {
            // Try the next supported resolver signature. Forks of Baileys differ.
        }
    }
    return null
}

async function getChannelMetadata(sock, channelJid) {
    const calls = []
    if (typeof sock.newsletterMetadata === 'function') {
        calls.push(() => sock.newsletterMetadata('jid', channelJid))
        calls.push(() => sock.newsletterMetadata(channelJid))
    }
    if (typeof sock.newsletterSubscribers === 'function') calls.push(() => sock.newsletterSubscribers(channelJid))
    if (typeof sock.newsletterFollowers === 'function') calls.push(() => sock.newsletterFollowers(channelJid))

    let lastError = null
    let firstUsableMetadata = null
    for (const call of calls) {
        try {
            const result = await call()
            if (result == null) continue
            if (firstUsableMetadata == null) firstUsableMetadata = result
            // A fork may expose metadata without a count but provide it via a
            // separate subscribers/followers method, so keep trying until found.
            if (parseSubscriberCount(result) != null) return result
        } catch (error) {
            lastError = error
        }
    }
    if (firstUsableMetadata != null) return firstUsableMetadata
    if (lastError) throw lastError
    throw new Error('Fork Baileys tidak menyediakan metadata/jumlah pengikut saluran.')
}

function readMonitorStore(filePath) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch (_) {
        return {}
    }
}

function writeMonitorStore(filePath, value) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        const temporaryPath = `${filePath}.tmp`
        fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2))
        fs.renameSync(temporaryPath, filePath)
        return true
    } catch (error) {
        console.error('[CHANNEL MONITOR] Gagal menyimpan state:', error?.message || error)
        return false
    }
}

function contactNameFor(sock, jid, source, contactStore) {
    const directName = source && typeof source === 'object'
        ? (source.pushName || source.notify || source.name || source.displayName || '')
        : ''
    if (directName) return String(directName).trim().slice(0, 80)
    const contact = sock?.store?.contacts?.[jid] || sock?.contacts?.[jid] || {}
    return String(contact.name || contact.notify || contact.verifiedName || contact.pushName || '').trim().slice(0, 80)
}

async function resolveUserJid(sock, raw) {
    const value = String(raw || '').trim().replace(/^@/, '')
    if (!value) return { jid: '', number: '' }
    const numberJid = value.match(/^([1-9]\d{4,19})(?:@s\.whatsapp\.net|@c\.us)?$/i)
    if (numberJid) {
        const number = numberJid[1]
        return { jid: `${number}@s.whatsapp.net`, number }
    }
    if (value.endsWith('@lid')) {
        const mappings = [
            sock?.signalRepository?.lidMapping?.getPNForLID,
            sock?.lidMapping?.getPNForLID,
            sock?.getPNForLID
        ].filter(fn => typeof fn === 'function')
        for (const mapper of mappings) {
            try {
                const mapped = await mapper.call(sock?.signalRepository?.lidMapping || sock?.lidMapping || sock, value)
                const parsed = await resolveUserJid(sock, typeof mapped === 'string' ? mapped : (mapped?.jid || mapped?.phoneNumber || mapped?.pn || ''))
                if (parsed.number) return parsed
            } catch (_) {}
        }
        return { jid: value, number: '' }
    }
    const maybeDigits = digitsOnly(value)
    if (maybeDigits.length >= 5 && maybeDigits.length <= 20) return { jid: `${maybeDigits}@s.whatsapp.net`, number: maybeDigits }
    return { jid: '', number: '' }
}

function dateTimeJakarta() {
    return new Intl.DateTimeFormat('id-ID', {
        timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'medium', hour12: false
    }).format(new Date()) + ' WIB'
}

function attachChannelMonitor(sock, options = {}) {
    if (sock.__xeryuuChannelMonitor) return sock.__xeryuuChannelMonitor

    const stateFile = options.stateFile || path.join(__dirname, 'database', 'channel-monitor.json')
    const pollIntervalMs = Math.max(60 * 1000, Number(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS)
    const configuredValue = options.channelUrl || global.idSaluran || global.linkSaluran || ''
    const fallbackJid = normalizeChannelJid(options.fallbackJid || global.channelMonitorFallbackJid || DEFAULT_CHANNEL_JID)
    const ownerJid = normalizeOwnerJid(options.ownerJid || global.owner || '')
    const channelName = String(options.channelName || global.namaSaluran || global.namaOwner || 'Saluran developer').trim().slice(0, 100)
    const contactStore = options.contactStore || options.contacts || null
    const persisted = readMonitorStore(stateFile)
    const monitor = {
        socket: sock,
        channelJid: normalizeChannelJid(options.channelJid) || '',
        channelSource: options.channelJid ? 'test/config' : '',
        ownerJid,
        timer: null,
        stopped: false,
        initializing: null,
        ready: false,
        pollRunning: false,
        lastSubscribers: null,
        lastCountCheckAt: 0,
        lastRemovalAt: 0,
        seenEvents: new Map(),
        bufferedEvents: [],
        warnedNoOwner: false,
        warnedResolver: false,
        getChannelJid() { return monitor.channelJid },
        async initialize() {
            if (monitor.ready) return monitor.channelJid
            if (monitor.initializing) return monitor.initializing
            monitor.initializing = (async () => {
                if (monitor.stopped) return ''
                if (!monitor.channelJid) {
                    const resolved = await resolveConfiguredChannel(sock, configuredValue)
                    if (resolved?.id) {
                        monitor.channelJid = resolved.id
                        monitor.channelSource = resolved.source
                    } else if (fallbackJid) {
                        monitor.channelJid = fallbackJid
                        monitor.channelSource = 'fallback'
                        console.warn(`[CHANNEL MONITOR] URL saluran belum bisa di-resolve; memakai JID fallback ${fallbackJid}. Verifikasi bahwa ID ini benar-benar saluran yang dimaksud.`)
                    } else if (!monitor.warnedResolver) {
                        monitor.warnedResolver = true
                        console.warn('[CHANNEL MONITOR] JID saluran belum tersedia; monitor akan mencoba resolve ulang otomatis.')
                    }
                }
                if (!monitor.channelJid) return ''
                monitor.ready = true

                const saved = persisted[monitor.channelJid]
                if (saved && Number.isFinite(Number(saved.subscribers))) monitor.lastSubscribers = Number(saved.subscribers)
                if (saved && Number.isFinite(Number(saved.lastCountCheckAt))) monitor.lastCountCheckAt = Number(saved.lastCountCheckAt)
                if (saved && Number.isFinite(Number(saved.lastRemovalAt))) monitor.lastRemovalAt = Number(saved.lastRemovalAt)

                console.log(`[CHANNEL MONITOR] Aktif otomatis untuk ${channelName} (${monitor.channelJid}); sumber=${monitor.channelSource || 'unknown'}.`)
                const pending = monitor.bufferedEvents.splice(0, MAX_PENDING_EVENTS)
                for (const event of pending) await monitor.handleEvent(event)
                await monitor.pollSubscribers('initialize')
                return monitor.channelJid
            })().finally(() => { monitor.initializing = null })
            return monitor.initializing
        },
        async sendNotices(privateText, channelText) {
            const tasks = []
            if (ownerJid && typeof sock.sendMessage === 'function') {
                tasks.push({
                    destination: 'owner-private-chat',
                    jid: ownerJid,
                    text: privateText,
                    payload: makeOwnerNoticePayload(privateText, channelName)
                })
            } else if (!monitor.warnedNoOwner) {
                monitor.warnedNoOwner = true
                console.warn('[CHANNEL MONITOR] Nomor owner tidak valid; notifikasi chat pribadi tidak dapat dikirim.')
            }
            if (monitor.channelJid && typeof sock.sendMessage === 'function') {
                const card = renderChannelMonitorCard(channelName, channelText)
                tasks.push({
                    destination: 'channel',
                    jid: monitor.channelJid,
                    text: channelText,
                    payload: card ? { image: card, caption: channelText } : { text: channelText }
                })
            }

            let delivered = 0
            for (const task of tasks) {
                let lastError = null
                // Retry sekali untuk gangguan sementara. Jika kiriman gambar channel
                // ditolak versi Baileys, fallback ke caption teks tanpa mematikan monitor.
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        let payload = task.payload
                        if (attempt === 1 && task.destination === 'channel' && payload.image) {
                            payload = { text: task.text }
                        }
                        await sock.sendMessage(task.jid, payload)
                        delivered++
                        lastError = null
                        break
                    } catch (error) {
                        lastError = error
                        if (attempt === 0) await sleep(800)
                    }
                }
                if (lastError) {
                    console.error(`[CHANNEL MONITOR] Pengiriman notifikasi gagal (${task.destination}) setelah retry:`, lastError?.message || lastError)
                }
                if (tasks.length > 1) await sleep(250)
            }
            // Anggap sukses hanya jika DM owner dan notifikasi channel sama-sama terkirim.
            return tasks.length === 2 && delivered === tasks.length
        },
        async handleEvent(rawUpdate) {
            const updates = Array.isArray(rawUpdate) ? rawUpdate : [rawUpdate]
            for (const event of updates) {
                if (!event || typeof event !== 'object') continue
                const eventChannelId = getEventChannelId(event)
                if (!monitor.channelJid) {
                    if (monitor.bufferedEvents.length < MAX_PENDING_EVENTS) monitor.bufferedEvents.push(event)
                    continue
                }
                if (!eventChannelId || eventChannelId !== monitor.channelJid) continue

                const eventUsers = getEventUsers(event)
                const relevantParticipants = eventUsers.length ? eventUsers : [{ raw: '', source: null }]
                for (const candidate of relevantParticipants) {
                    const action = getEventAction(event, candidate.source)
                    if (action !== 'remove') continue
                    const user = await resolveUserJid(sock, candidate.raw)
                    if (user.jid === monitor.channelJid) continue
                    const stableEventId = String(event.serverId || event.messageId || event.idEvent || event.timestamp || event.t || '')
                    const eventKey = `${eventChannelId}|${action}|${user.jid || candidate.raw}|${stableEventId}`
                    const now = Date.now()
                    for (const [key, record] of monitor.seenEvents) {
                        const at = typeof record === 'number' ? record : Number(record?.at || 0)
                        const ttl = typeof record === 'number' ? EVENT_DEDUPE_TTL_MS : Number(record?.ttl || EVENT_DEDUPE_TTL_MS)
                        if (now - at > ttl) monitor.seenEvents.delete(key)
                    }
                    if (monitor.seenEvents.has(eventKey)) continue
                    // Baileys payload tidak selalu membawa event ID/timestamp.
                    // Tanpa ID stabil, gunakan jendela pendek agar replay langsung terfilter,
                    // tetapi unfollow berikutnya oleh orang yang sama tidak hilang selama 30 menit.
                    monitor.seenEvents.set(eventKey, {
                        at: now,
                        ttl: stableEventId ? EVENT_DEDUPE_TTL_MS : EVENT_DEDUPE_FALLBACK_TTL_MS
                    })
                    const previousRemovalAt = monitor.lastRemovalAt
                    monitor.lastRemovalAt = now

                    const name = contactNameFor(sock, user.jid, candidate.source, contactStore) || 'Tidak tersedia'
                    const numberText = user.number ? `+${user.number}` : 'Tidak tersedia pada event WhatsApp'
                    const privateText = [
                        '╭─═⪩ 📉 *MONITOR SALURAN*',
                        '│',
                        `│ 📢 Saluran: ${channelName}`,
                        '│ 🚪 Status: Peserta berhenti mengikuti',
                        `│ 👤 Nama: ${name}`,
                        `│ 📱 Nomor: ${numberText}`,
                        `│ 🕒 Waktu: ${dateTimeJakarta()}`,
                        '│',
                        '╰─═─═─═─═─═─═⪩',
                        '',
                        '🤖 Notifikasi otomatis Xeryuu-MD'
                    ].join('\n')
                    const channelText = [
                        '╭─═⪩ 📉 *PEMBARUAN PENGIKUT SALURAN*',
                        '│',
                        `│ 📢 Saluran: ${channelName}`,
                        '│ 🚪 Terdeteksi satu peserta berhenti mengikuti saluran.',
                        `│ 🕒 Waktu: ${dateTimeJakarta()}`,
                        '│',
                        '╰─═─═─═─═─═─═⪩',
                        '',
                        '🔒 Detail identitas dikirim secara pribadi kepada pemilik saluran.'
                    ].join('\n')
                    console.log(`[CHANNEL MONITOR] Unfollow terdeteksi; channel=${monitor.channelJid}; identity=${user.number ? `+${user.number}` : 'unavailable'}.`)
                    const fullyDelivered = await monitor.sendNotices(privateText, channelText)
                    if (!fullyDelivered) monitor.lastRemovalAt = previousRemovalAt
                }
            }
        },
        async pollSubscribers(reason = 'interval') {
            if (monitor.stopped || monitor.pollRunning || !sock?.user || sock.isConnected === false) return
            monitor.pollRunning = true
            try {
                if (!monitor.channelJid) {
                    await monitor.initialize()
                    if (!monitor.channelJid) return
                }
                const metadata = await getChannelMetadata(sock, monitor.channelJid)
                const currentCount = parseSubscriberCount(metadata)
                if (currentCount == null) {
                    if (reason === 'initialize') console.warn('[CHANNEL MONITOR] Metadata saluran tersedia tetapi jumlah pengikut tidak diberikan; pemantauan event tetap berjalan.')
                    return
                }

                const now = Date.now()
                const lastCount = monitor.lastSubscribers
                const shouldReportDecrease = lastCount != null && currentCount < lastCount
                const eventAlreadyReported = monitor.lastRemovalAt > monitor.lastCountCheckAt
                if (shouldReportDecrease && !eventAlreadyReported) {
                    const difference = lastCount - currentCount
                    const privateText = [
                        '╭─═⪩ 📉 *MONITOR SALURAN*',
                        '│',
                        `│ 📢 Saluran: ${channelName}`,
                        `│ 📉 Jumlah pengikut turun: ${lastCount} → ${currentCount}`,
                        `│ 👤 Perkiraan peserta keluar: ${difference}`,
                        `│ 🕒 Waktu terdeteksi: ${dateTimeJakarta()}`,
                        '│',
                        '╰─═─═─═─═─═─═⪩',
                        '',
                        '⚠️ WhatsApp tidak menyertakan identitas peserta pada data jumlah pengikut. Nomor/nama tidak dapat dipastikan melalui polling jumlah saja.'
                    ].join('\n')
                    const channelText = [
                        '╭─═⪩ 📉 *PEMBARUAN PENGIKUT SALURAN*',
                        '│',
                        `│ 📢 Saluran: ${channelName}`,
                        `│ 📉 Jumlah pengikut berubah: ${lastCount} → ${currentCount}`,
                        `│ 🕒 Waktu terdeteksi: ${dateTimeJakarta()}`,
                        '│',
                        '╰─═─═─═─═─═─═⪩',
                        '',
                        '🔒 Identitas tidak tersedia dari data jumlah pengikut.'
                    ].join('\n')
                    console.warn(`[CHANNEL MONITOR] Fallback polling mendeteksi penurunan followers ${lastCount} -> ${currentCount}; identitas individu tidak disediakan metadata.`)
                    const sent = await monitor.sendNotices(privateText, channelText)
                    if (!sent) return // Keep the old baseline to retry the alert next cycle.
                }

                monitor.lastSubscribers = currentCount
                monitor.lastCountCheckAt = now
                persisted[monitor.channelJid] = {
                    subscribers: currentCount,
                    lastCountCheckAt: now,
                    lastRemovalAt: monitor.lastRemovalAt,
                    updatedAt: now
                }
                writeMonitorStore(stateFile, persisted)
            } catch (error) {
                console.warn(`[CHANNEL MONITOR] Polling subscriber count gagal (${reason}):`, error?.message || error)
            } finally {
                monitor.pollRunning = false
            }
        },
        stop() {
            monitor.stopped = true
            if (monitor.timer) clearInterval(monitor.timer)
            monitor.timer = null
        }
    }

    sock.__xeryuuChannelMonitor = monitor
    if (sock.ev && typeof sock.ev.on === 'function') {
        sock.ev.on('newsletter-participants.update', update => {
            void monitor.handleEvent(update).catch(error => {
                console.error('[CHANNEL MONITOR EVENT ERROR]', error?.stack || error?.message || error)
            })
        })
        sock.ev.on('connection.update', update => {
            if (update?.connection === 'close') monitor.stop()
            if (update?.connection === 'open') {
                void monitor.initialize()
                    .then(() => monitor.pollSubscribers('connection-open'))
                    .catch(error => console.error('[CHANNEL MONITOR INIT ERROR]', error?.message || error))
            }
        })
    }
    monitor.timer = setInterval(() => {
        void monitor.pollSubscribers('interval')
    }, pollIntervalMs)
    if (typeof monitor.timer.unref === 'function') monitor.timer.unref()

    return monitor
}

module.exports = {
    attachChannelMonitor,
    normalizeOwnerJid,
    normalizeChannelJid,
    parseSubscriberCount,
    getEventAction,
    getEventChannelId,
    getEventUsers,
    resolveConfiguredChannel
}
