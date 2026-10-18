const pendingChallenges = new Map()

const CHALLENGE_TIMEOUT = 45 * 1000
const MAX_ATTEMPTS = 2

function challengeKey(chat, sender) {
    return `${chat}:${sender}`
}

function randomInt(min, max) {
    return Math.floor(
        Math.random() * (max - min + 1)
    ) + min
}

function createMathChallenge() {
    const operations = ['+', '-', '×']
    const operation = operations[
        randomInt(0, operations.length - 1)
    ]

    let a
    let b
    let answer

    if (operation === '+') {
        a = randomInt(5, 50)
        b = randomInt(5, 50)
        answer = a + b
    }

    else if (operation === '-') {
        a = randomInt(20, 80)
        b = randomInt(5, a)
        answer = a - b
    }

    else {
        a = randomInt(2, 12)
        b = randomInt(2, 12)
        answer = a * b
    }

    return {
        question: `${a} ${operation} ${b}`,
        answer
    }
}

function getAdminJids(groupMetadata) {
    return (
        groupMetadata?.participants || []
    )
        .filter(participant =>
            participant?.admin === 'admin' ||
            participant?.admin === 'superadmin'
        )
        .map(participant =>
            participant?.id ||
            participant?.phoneNumber
        )
        .filter(Boolean)
}

function detectPromotion(text) {
    const body = String(text || '')

    if (!body.trim()) {
        return {
            detected: false,
            type: null
        }
    }

    // ==========================================
    // LINK GRUP WHATSAPP
    // ==========================================
    if (
        /chat\.whatsapp\.com\/[A-Za-z0-9]+/i.test(body)
    ) {
        return {
            detected: true,
            type: 'LINK GRUP WHATSAPP'
        }
    }

    // ==========================================
    // LINK WA.ME
    // ==========================================
    if (
        /(?:https?:\/\/)?wa\.me\/[0-9]+/i.test(body)
    ) {
        return {
            detected: true,
            type: 'LINK WHATSAPP'
        }
    }

    // ==========================================
    // MARKETPLACE / PRODUK
    // ==========================================
    const productPatterns = [
        /(?:https?:\/\/)?(?:www\.)?shopee\.co\.id\/[^\s]+/i,
        /(?:https?:\/\/)?(?:www\.)?tokopedia\.com\/[^\s]+/i,
        /(?:https?:\/\/)?(?:www\.)?lazada\.co\.id\/[^\s]+/i,
        /(?:https?:\/\/)?(?:www\.)?blibli\.com\/[^\s]+/i,
        /(?:https?:\/\/)?(?:www\.)?bukalapak\.com\/[^\s]+/i,
        /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/[^\s]*shop[^\s]*/i
    ]

    for (const pattern of productPatterns) {
        if (pattern.test(body)) {
            return {
                detected: true,
                type: 'LINK PRODUK'
            }
        }
    }

    // ==========================================
    // SHORTLINK / LINK PROMOSI
    // ==========================================
    const shortLinkPattern =
        /(?:https?:\/\/)?(?:www\.)?(?:s\.id|bit\.ly|tinyurl\.com|cutt\.ly|linktr\.ee|lynk\.id)\/[^\s]+/i

    if (shortLinkPattern.test(body)) {
        return {
            detected: true,
            type: 'LINK PROMOSI'
        }
    }

    // ==========================================
    // LINK PRODUK GENERIK
    // ==========================================
    const genericUrl =
        /https?:\/\/[^\s]+/i

    const productKeyword =
        /\b(?:produk|product|jual|jualan|promo|promosi|diskon|discount|order|pesan|harga|murah|stok|toko|shop|store)\b/i

    if (
        genericUrl.test(body) &&
        productKeyword.test(body)
    ) {
        return {
            detected: true,
            type: 'PROMOSI PRODUK'
        }
    }

    return {
        detected: false,
        type: null
    }
}

function clearChallenge(chat, sender) {
    const key = challengeKey(chat, sender)
    const pending = pendingChallenges.get(key)

    if (pending?.timeout) {
        clearTimeout(pending.timeout)
    }

    pendingChallenges.delete(key)
}

function clearGroupChallenges(chat) {
    for (const [key, pending] of pendingChallenges.entries()) {
        if (key.startsWith(`${chat}:`)) {
            if (pending?.timeout) {
                clearTimeout(pending.timeout)
            }

            pendingChallenges.delete(key)
        }
    }
}

async function alertAdmins(
    conn,
    m,
    groupMetadata,
    reason
) {
    const admins = getAdminJids(groupMetadata)

    const mentions = [
        m.sender,
        ...admins
    ].filter(Boolean)

    const uniqueMentions = [
        ...new Set(mentions)
    ]

    const adminText = admins.length
        ? admins
            .map(jid => `@${jid.split('@')[0]}`)
            .join(' ')
        : 'Tidak ditemukan admin.'

    await conn.sendMessage(
        m.chat,
        {
            text:
`🚨 *ANTI PROMOSI - VERIFIKASI GAGAL*

👤 Pengirim:
@${m.sender.split('@')[0]}

⚠️ Status:
*Terdeteksi sebagai akun mencurigakan / gagal verifikasi.*

📌 Alasan:
${reason}

👮 Admin yang ditandai:
${adminText}

Segera tindak lanjuti jika diperlukan.`,
            mentions: uniqueMentions
        },
        {
            quoted: m
        }
    )
}

async function handleAntiPromosi({
    conn,
    m,
    body,
    groupMetadata,
    isAdmins,
    isCreator,
    isBotAdmins,
    enabled
}) {

    if (
        !m?.isGroup ||
        !enabled ||
        m?.key?.fromMe ||
        isCreator ||
        isAdmins
    ) {
        return false
    }

    const sender = m.sender
    const chat = m.chat
    const key = challengeKey(chat, sender)

    // ==========================================
    // CEK CHALLENGE YANG SEDANG AKTIF
    // ==========================================
    const pending = pendingChallenges.get(key)

    if (pending) {

        if (Date.now() >= pending.expiresAt) {

            clearChallenge(chat, sender)

            await alertAdmins(
                conn,
                m,
                groupMetadata,
                'Tidak menjawab soal matematika dalam batas waktu 45 detik.'
            )

            return true
        }

        // Jangan ganggu command seperti .menu
        if (
            String(body || '').trim().startsWith('.')
        ) {
            return false
        }

        const answerText = String(body || '').trim()

        // Hanya angka yang dianggap jawaban
        if (!/^-?\d+$/.test(answerText)) {
            return false
        }

        const userAnswer = Number(answerText)

        // ==========================================
        // JAWABAN BENAR
        // ==========================================
        if (
            userAnswer === pending.answer
        ) {
            clearChallenge(chat, sender)

            await conn.sendMessage(
                chat,
                {
                    text:
`✅ *VERIFIKASI BERHASIL*

@${sender.split('@')[0]}

Jawaban kamu benar.

🧮 Soal:
*${pending.question}*

✅ Status: *TERVERIFIKASI*`,
                    mentions: [sender]
                },
                {
                    quoted: m
                }
            )

            return true
        }

        // ==========================================
        // JAWABAN SALAH
        // ==========================================
        pending.attempts++

        if (pending.attempts >= MAX_ATTEMPTS) {

            clearChallenge(chat, sender)

            await alertAdmins(
                conn,
                m,
                groupMetadata,
                `Jawaban matematika salah ${MAX_ATTEMPTS} kali.`
            )

            return true
        }

        const remaining =
            MAX_ATTEMPTS - pending.attempts

        await conn.sendMessage(
            chat,
            {
                text:
`❌ *JAWABAN SALAH*

@${sender.split('@')[0]}

Jawaban kamu salah.

🧮 Soal:
*${pending.question}*

🔁 Kesempatan tersisa: *${remaining}*

Balas dengan angka saja.`,
                mentions: [sender]
            },
            {
                quoted: m
            }
        )

        return true
    }

    // ==========================================
    // DETEKSI LINK PROMOSI
    // ==========================================
    const detected = detectPromotion(body)

    if (!detected.detected) {
        return false
    }

    // ==========================================
    // HAPUS PESAN PROMOSI
    // ==========================================
    if (isBotAdmins) {
        try {
            await conn.sendMessage(
                chat,
                {
                    delete: m.key
                }
            )
        } catch (error) {
            console.error(
                '[ANTI-PROMOSI DELETE]',
                error
            )
        }
    }

    // ==========================================
    // BUAT SOAL MATEMATIKA
    // ==========================================
    const challenge =
        createMathChallenge()

    const expiresAt =
        Date.now() + CHALLENGE_TIMEOUT

    const pendingData = {
        question: challenge.question,
        answer: challenge.answer,
        attempts: 0,
        expiresAt,
        timeout: null
    }

    pendingData.timeout = setTimeout(
        async () => {

            const current =
                pendingChallenges.get(key)

            if (
                current !== pendingData
            ) {
                return
            }

            clearChallenge(
                chat,
                sender
            )

            try {
                await alertAdmins(
                    conn,
                    m,
                    groupMetadata,
                    'Tidak menyelesaikan verifikasi matematika dalam 45 detik.'
                )
            } catch (error) {
                console.error(
                    '[ANTI-PROMOSI TIMEOUT]',
                    error
                )
            }

        },
        CHALLENGE_TIMEOUT
    )

    pendingChallenges.set(
        key,
        pendingData
    )

    // ==========================================
    // KIRIM CHALLENGE
    // ==========================================
    await conn.sendMessage(
        chat,
        {
            text:
`🛡️ *ANTI PROMOSI*

@${sender.split('@')[0]}

⚠️ Terdeteksi:
*${detected.type}*

Pesan promosi telah ${
    isBotAdmins
        ? 'dihapus'
        : 'terdeteksi'
}.

Untuk memastikan kamu bukan bot, jawab soal matematika berikut:

🧮 *${challenge.question} = ?*

⏱️ Waktu: *45 detik*
🔢 Balas dengan *angka saja*

❗ Maksimal *2 kali* percobaan.`,
            mentions: [sender]
        },
        {
            quoted: m
        }
    )

    return true
}

module.exports = {
    detectPromotion,
    handleAntiPromosi,
    clearChallenge,
    clearGroupChallenges
}