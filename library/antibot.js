'use strict'

const pendingChallenges = new Map()
const challengeAliases = new Map()

function normalizeJid(value) {
    return String(value || '').trim().replace(/:\d+(?=@)/, '')
}

function getParticipantAliases(participant) {
    const values = typeof participant === 'string'
        ? [participant]
        : [participant?.id, participant?.jid, participant?.lid, participant?.phoneNumber]

    return [...new Set(values.map(normalizeJid).filter(Boolean))]
}

function challengeKey(groupJid, participantJid) {
    return `${normalizeJid(groupJid)}:${normalizeJid(participantJid)}`
}

function randomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function makeQuestion() {
    const operation = ['+', '−', '×'][randomNumber(0, 2)]
    let first = randomNumber(3, 18)
    let second = randomNumber(2, 15)
    let answer

    if (operation === '+') answer = first + second
    if (operation === '−') {
        if (second > first) [first, second] = [second, first]
        answer = first - second
    }
    if (operation === '×') {
        first = randomNumber(2, 9)
        second = randomNumber(2, 9)
        answer = first * second
    }

    return { question: `${first} ${operation} ${second} = ?`, answer: String(answer) }
}

async function renderChallengeImage(question, seconds) {
    let canvasLibrary
    try {
        canvasLibrary = require('@napi-rs/canvas')
    } catch {
        canvasLibrary = require('canvas')
    }

    const { createCanvas } = canvasLibrary
    const canvas = createCanvas(1200, 660)
    const ctx = canvas.getContext('2d')
    const bg = ctx.createLinearGradient(0, 0, 1200, 660)
    bg.addColorStop(0, '#080d1c')
    bg.addColorStop(0.54, '#132744')
    bg.addColorStop(1, '#082b32')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, 1200, 660)

    const glow = ctx.createRadialGradient(970, 90, 10, 970, 90, 390)
    glow.addColorStop(0, 'rgba(54, 231, 220, 0.23)')
    glow.addColorStop(1, 'rgba(54, 231, 220, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, 1200, 660)

    const roundedRect = (x, y, width, height, radius, fill, stroke) => {
        ctx.beginPath()
        ctx.moveTo(x + radius, y)
        ctx.arcTo(x + width, y, x + width, y + height, radius)
        ctx.arcTo(x + width, y + height, x, y + height, radius)
        ctx.arcTo(x, y + height, x, y, radius)
        ctx.arcTo(x, y, x + width, y, radius)
        ctx.closePath()
        ctx.fillStyle = fill
        ctx.fill()
        if (stroke) {
            ctx.strokeStyle = stroke
            ctx.lineWidth = 2
            ctx.stroke()
        }
    }

    roundedRect(34, 34, 1132, 592, 32, 'rgba(4, 12, 26, 0.82)', 'rgba(91, 234, 223, 0.66)')
    roundedRect(74, 70, 1052, 104, 22, 'rgba(24, 47, 72, 0.92)', 'rgba(91, 234, 223, 0.22)')

    ctx.textAlign = 'left'
    ctx.fillStyle = '#5de8dc'
    ctx.font = 'bold 24px Arial'
    ctx.fillText('XERYUU SECURITY CHECK', 108, 112)
    ctx.fillStyle = '#f0fbff'
    ctx.font = 'bold 40px Arial'
    ctx.fillText('Verifikasi anggota', 108, 151)

    roundedRect(74, 205, 1052, 245, 26, 'rgba(15, 32, 53, 0.96)', 'rgba(91, 234, 223, 0.33)')
    ctx.textAlign = 'center'
    ctx.fillStyle = '#9fb9cc'
    ctx.font = 'bold 23px Arial'
    ctx.fillText('BERAPA HASIL PERHITUNGAN INI?', 600, 260)
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 88px Arial'
    ctx.fillText(question, 600, 365)
    ctx.fillStyle = '#6bece1'
    ctx.font = 'bold 24px Arial'
    ctx.fillText('Jawab dengan angka saja di chat grup', 600, 414)

    roundedRect(74, 482, 1052, 92, 20, 'rgba(10, 40, 52, 0.94)', 'rgba(91, 234, 223, 0.25)')
    ctx.textAlign = 'left'
    ctx.fillStyle = '#c7d7e5'
    ctx.font = 'bold 23px Arial'
    ctx.fillText('BATAS WAKTU', 110, 520)
    ctx.fillStyle = '#f6ffff'
    ctx.font = 'bold 32px Arial'
    ctx.fillText(`${seconds} DETIK`, 110, 555)
    ctx.textAlign = 'right'
    ctx.fillStyle = '#7894a9'
    ctx.font = '18px Arial'
    ctx.fillText('Xeryuu-MD × Sendrich', 1084, 602)

    return canvas.toBuffer('image/png')
}

function removeChallenge(challenge) {
    if (!challenge) return
    clearTimeout(challenge.timer)
    pendingChallenges.delete(challenge.id)
    for (const alias of challenge.aliasKeys) {
        if (challengeAliases.get(alias) === challenge.id) challengeAliases.delete(alias)
    }
}

function findChallenge(groupJid, participants) {
    for (const participant of participants) {
        const id = challengeAliases.get(challengeKey(groupJid, participant))
        if (id && pendingChallenges.has(id)) return pendingChallenges.get(id)
    }
    return null
}

function isAdminMember(member) {
    return Boolean(member?.admin === 'admin' || member?.admin === 'superadmin' || member?.admin === true)
}

function isSameJid(first, second) {
    const a = normalizeJid(first)
    const b = normalizeJid(second)
    if (!a || !b) return false
    if (a === b) return true
    return a.split('@')[0] === b.split('@')[0] && a.includes('@') && b.includes('@')
}

async function timeoutChallenge(sock, challenge) {
    if (!challenge || pendingChallenges.get(challenge.id) !== challenge) return
    removeChallenge(challenge)

    try {
        const metadata = await sock.groupMetadata(challenge.groupJid)
        const member = metadata.participants?.find(entry =>
            getParticipantAliases(entry).some(alias => challenge.aliases.includes(alias))
        )
        if (!member) return
        const memberJid = member.id || member.phoneNumber || member.jid || member.lid || challenge.primaryJid

        if (isAdminMember(member)) {
            await sock.sendMessage(challenge.groupJid, {
                text: `🛡️ Verifikasi untuk @${memberJid.split('@')[0]} berakhir, tetapi akun tersebut adalah admin grup sehingga tidak dikeluarkan.`,
                mentions: [memberJid]
            })
            return
        }

        const botJids = getParticipantAliases(sock.user || {})
        const botMember = metadata.participants?.find(entry =>
            getParticipantAliases(entry).some(alias => botJids.includes(alias))
        )
        if (!isAdminMember(botMember)) {
            await sock.sendMessage(challenge.groupJid, {
                text: `⏱️ Waktu verifikasi @${memberJid.split('@')[0]} telah habis. Bot belum menjadi admin, jadi anggota tidak dapat dikeluarkan otomatis.`,
                mentions: [memberJid]
            })
            return
        }

        await sock.groupParticipantsUpdate(challenge.groupJid, [memberJid], 'remove')
        await sock.sendMessage(challenge.groupJid, {
            text: `🚪 @${memberJid.split('@')[0]} dikeluarkan karena tidak menyelesaikan verifikasi dalam ${challenge.timeoutSeconds} detik.`,
            mentions: [memberJid]
        })
    } catch (error) {
        console.error('[ANTIBOT TIMEOUT]', error?.stack || error)
        try {
            await sock.sendMessage(challenge.groupJid, {
                text: `⚠️ Waktu verifikasi telah habis, tetapi tindakan otomatis gagal. Periksa apakah bot masih menjadi admin grup.`
            })
        } catch {}
    }
}

async function startChallenge(sock, groupJid, participant, options = {}) {
    if (!sock || !groupJid || !String(groupJid).endsWith('@g.us')) return false
    const aliases = getParticipantAliases(participant)
    if (!aliases.length) return false

    const ownAliases = getParticipantAliases(sock.user || {})
    if (aliases.some(alias => ownAliases.includes(alias))) return false

    const timeoutValue = Number(options.timeoutMs)
    const timeoutMs = Math.min(300000, Math.max(15000, Number.isFinite(timeoutValue) && timeoutValue > 0 ? timeoutValue : 60000))
    const existing = findChallenge(groupJid, aliases)
    if (existing) return true

    let metadata
    try {
        metadata = options.metadata || await sock.groupMetadata(groupJid)
    } catch (error) {
        console.error('[ANTIBOT GROUP METADATA]', error?.message || error)
        return false
    }

    const member = metadata.participants?.find(entry =>
        getParticipantAliases(entry).some(alias => aliases.includes(alias))
    )
    if (member && isAdminMember(member)) return false

    const { question, answer } = makeQuestion()
    const timeoutSeconds = Math.round(timeoutMs / 1000)
    const id = `${challengeKey(groupJid, aliases[0])}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const aliasKeys = aliases.map(alias => challengeKey(groupJid, alias))
    const challenge = {
        id,
        groupJid,
        aliases,
        aliasKeys,
        primaryJid: aliases[0],
        answer,
        attempts: 0,
        maxAttempts: 3,
        timeoutMs,
        timeoutSeconds,
        timer: null
    }

    pendingChallenges.set(id, challenge)
    for (const key of aliasKeys) challengeAliases.set(key, id)
    challenge.timer = setTimeout(() => void timeoutChallenge(sock, challenge), timeoutMs)
    if (typeof challenge.timer.unref === 'function') challenge.timer.unref()

    const caption = [
        '🛡️ VERIFIKASI ANTI-BOT',
        '',
        `Selamat datang @${challenge.primaryJid.split('@')[0]}!`,
        'Untuk memastikan kamu anggota sungguhan, jawab soal pada gambar.',
        '',
        `⏳ Waktu: ${timeoutSeconds} detik`,
        '✍️ Kirim angka jawabannya langsung ke grup.',
        '💡 Hitung dengan teliti. Waktu tetap berjalan.'
    ].join('\n')

    try {
        const image = await renderChallengeImage(question, timeoutSeconds)
        await sock.sendMessage(groupJid, { image, caption, mentions: [challenge.primaryJid] })
    } catch (error) {
        console.error('[ANTIBOT CHALLENGE IMAGE]', error?.stack || error)
        try {
            await sock.sendMessage(groupJid, {
                text: `${caption}\n\nSoal: ${question}`,
                mentions: [challenge.primaryJid]
            })
        } catch (sendError) {
            console.error('[ANTIBOT CHALLENGE SEND]', sendError?.stack || sendError)
            removeChallenge(challenge)
            return false
        }
    }

    return true
}

async function handleIncomingMessage(sock, message, body) {
    if (!message || message.key?.fromMe) return false
    const groupJid = String(message.key?.remoteJid || '')
    if (!groupJid.endsWith('@g.us')) return false

    const senderIds = [
        message.key?.participant,
        message.key?.participantAlt,
        message.participant,
        message.participantAlt
    ].map(normalizeJid).filter(Boolean)
    const challenge = findChallenge(groupJid, senderIds)
    if (!challenge) return false

    const answer = String(body || '').trim()
    if (/^\d{1,4}$/.test(answer) && answer === challenge.answer) {
        removeChallenge(challenge)
        try {
            await sock.sendMessage(groupJid, {
                text: `✅ Verifikasi berhasil. Selamat bergabung, @${challenge.primaryJid.split('@')[0]}!`,
                mentions: [challenge.primaryJid]
            })
        } catch (error) {
            console.error('[ANTIBOT VERIFIED NOTICE]', error?.message || error)
        }
        return true
    }

    challenge.attempts += 1
    const remaining = challenge.maxAttempts - challenge.attempts
    const response = remaining > 0
        ? `❌ Jawaban belum tepat, @${challenge.primaryJid.split('@')[0]}. Silakan coba lagi. Sisa percobaan: ${remaining}.`
        : `⚠️ Kamu sudah salah ${challenge.maxAttempts} kali. Periksa gambar lagi; kamu masih bisa menjawab selama waktu belum habis.`

    try {
        await sock.sendMessage(groupJid, { text: response, mentions: [challenge.primaryJid] })
    } catch (error) {
        console.error('[ANTIBOT ANSWER NOTICE]', error?.message || error)
    }
    return true
}

function clearGroupChallenges(groupJid) {
    const normalizedGroup = normalizeJid(groupJid)
    for (const challenge of [...pendingChallenges.values()]) {
        if (normalizeJid(challenge.groupJid) === normalizedGroup) removeChallenge(challenge)
    }
}

function cancelParticipant(groupJid, participant) {
    const challenge = findChallenge(groupJid, getParticipantAliases(participant))
    if (challenge) removeChallenge(challenge)
}

module.exports = {
    startChallenge,
    handleIncomingMessage,
    clearGroupChallenges,
    cancelParticipant
}
