'use strict'

const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, 'database', 'games', 'xeryuu')
const SESSION_FILE = path.join(__dirname, 'database', 'xeryuu-game-sessions.json')
const SESSION_TTL = 2 * 60 * 1000
const COOLDOWN = 5 * 60 * 1000
const timers = new Map()
let activeConnection = null
let activeReplySender = null
let memorySessions = loadSessions()

function loadSessions() {
    try {
        const value = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
        return {}
    }
}

function saveSessions() {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
    const temporary = `${SESSION_FILE}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(memorySessions, null, 2))
    fs.renameSync(temporary, SESSION_FILE)
}

function readArray(file) {
    try {
        const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'))
        return Array.isArray(value) ? value : []
    } catch (error) {
        console.error(`[XERYUU DATA] ${file}:`, error.message)
        return []
    }
}

function pick(values) {
    return values[Math.floor(Math.random() * values.length)]
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min
}

function normalize(value) {
    return String(value ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ')
}

function maskVowels(value) {
    return String(value || '').replace(/[aiueo]/gi, '_')
}

function safeText(value, length = 180) {
    return String(value ?? '').replace(/[\r\n]+/g, ' ').slice(0, length)
}

async function send(ctx, text, options = {}) {
    if (typeof ctx.reply === 'function') return ctx.reply(String(text ?? ''), options)
    return ctx.conn.sendMessage(ctx.m.chat, { text: String(text ?? ''), ...options }, { quoted: ctx.m })
}

function getSessionsForChat(chat) {
    return Object.entries(memorySessions).filter(([, session]) => session && session.chat === chat)
}

function sessionKeyForChat(chat) {
    return `chat:${String(chat)}`
}

function clearTimer(key) {
    const timer = timers.get(key)
    if (timer) clearTimeout(timer)
    timers.delete(key)
}

function deleteSession(key) {
    clearTimer(key)
    delete memorySessions[key]
    saveSessions()
}

async function sessionTimeout(key) {
    const session = memorySessions[key]
    if (!session) {
        clearTimer(key)
        return
    }
    if (Number(session.expiresAt || 0) > Date.now()) {
        scheduleTimeout(key, session)
        return
    }
    deleteSession(key)
    if (!activeConnection) return
    const extra = session.timeoutText ? `\n\n${session.timeoutText}` : ''
    const answer = session.answerDisplay || session.answers?.[0] || 'Tidak tersedia'
    const message = `⏰ *Waktu permainan habis!*\n\nJawaban: *${answer}*${extra}`
    try {
        if (typeof activeReplySender === 'function') {
            await activeReplySender(session.chat, message)
        } else {
            // Fallback mandiri tetap memakai format dokumen palsu Xeryuu.
            const payload = {
                document: Buffer.from('Xeryuu | MD✨'),
                mimetype: 'image/jpg',
                fileName: global.botname || 'Xeryuu-MD',
                fileLength: 1099511627776,
                caption: `\`\`\`${String(message ?? '').replace(/\*/g, '')}\`\`\``,
                contextInfo: {
                    forwardingScore: 9999,
                    isForwarded: false,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: global.idSaluran || '120363426041078526@newsletter',
                        newsletterName: global.namaSaluran || global.botname || 'Xeryuu-MD',
                        serverMessageId: 127
                    }
                }
            }
            const thumbnailPath = path.join(__dirname, '..', 'media', 'XeryuMd-thumbnail.jpg')
            try {
                if (fs.existsSync(thumbnailPath)) payload.jpegThumbnail = fs.readFileSync(thumbnailPath)
            } catch {}
            await activeConnection.sendMessage(session.chat, payload)
        }
    } catch (error) {
        console.warn('[XERYUU GAME TIMEOUT]', error?.message || error)
    }
}

function scheduleTimeout(key, session) {
    clearTimer(key)
    const delay = Math.max(100, Number(session.expiresAt || 0) - Date.now())
    const timer = setTimeout(() => sessionTimeout(key).catch(error => {
        console.error('[XERYUU GAME TIMEOUT ERROR]', error?.stack || error)
    }), delay)
    if (typeof timer.unref === 'function') timer.unref()
    timers.set(key, timer)
}

function restoreTimers(conn, replySender) {
    activeConnection = conn || activeConnection
    if (typeof replySender === 'function') activeReplySender = replySender
    const now = Date.now()
    let changed = false
    for (const [key, session] of Object.entries(memorySessions)) {
        if (!session || !session.chat || !session.expiresAt) {
            clearTimer(key)
            delete memorySessions[key]
            changed = true
            continue
        }
        if (Number(session.expiresAt) <= now) {
            sessionTimeout(key).catch(error => {
                console.warn('[XERYUU GAME RESTORE]', error?.message || error)
            })
        } else if (!timers.has(key)) {
            scheduleTimeout(key, session)
        }
    }
    if (changed) saveSessions()
}

function createSession(ctx, { game, answer, answers, prompt, reward = 500, timeout = SESSION_TTL, timeoutText = '', privateAnswer = false }) {
    const chat = ctx.m.chat
    const existing = getSessionsForChat(chat)
    if (existing.length) return { ok: false, active: existing[0][1] }
    const key = sessionKeyForChat(chat)
    const session = {
        game,
        chat,
        sender: ctx.m.sender,
        prompt: String(prompt || ''),
        answers: [...new Set((answers || [answer]).map(normalize).filter(Boolean))],
        answerDisplay: String(answer || ''),
        reward: Math.max(0, Math.floor(Number(reward) || 0)),
        privateAnswer: Boolean(privateAnswer),
        timeoutText: String(timeoutText || ''),
        createdAt: Date.now(),
        expiresAt: Date.now() + timeout
    }
    memorySessions[key] = session
    saveSessions()
    scheduleTimeout(key, session)
    return { ok: true, key, session }
}

function activeSession(ctx) {
    const all = getSessionsForChat(ctx.m.chat)
    return all.length ? all[0] : null
}

function requireGroup(ctx) {
    if (ctx.m.isGroup) return true
    send(ctx, '🎮 Game ini dimainkan di grup WhatsApp. Tambahkan bot ke grup, lalu mulai permainan di sana.').catch(() => {})
    return false
}

async function startTextQuiz(ctx, game, data, { title, prompt, answerKey = 'jawaban', clueKey = 'soal', timeout = SESSION_TTL, reward = 500, aliases = item => [item[answerKey]] } = {}) {
    if (!requireGroup(ctx)) return true
    const key = sessionKeyForChat(ctx.m.chat)
    const existing = memorySessions[key]
    if (existing) return send(ctx, `⏳ Permainan *${existing.game}* masih aktif di grup ini. Jawab dulu atau ketik ${ctx.prefix}nyerah.`).then(() => true)
    if (!Array.isArray(data) || !data.length) return send(ctx, `❌ Data untuk *${game}* belum tersedia.`).then(() => true)
    const item = pick(data)
    const answer = String(item?.[answerKey] ?? item?.answer ?? '').trim()
    if (!answer) return send(ctx, `❌ Data soal *${game}* tidak valid.`).then(() => true)
    const clue = String(item?.[clueKey] ?? item?.question ?? item?.petunjuk ?? '').trim()
    const promptText = `🎮 *${title || game.toUpperCase()}*\n\n${clue}\n\nPetunjuk huruf: ${maskVowels(answer)}\nWaktu: ${Math.floor(timeout / 1000)} detik\nHadiah: Rp${Number(reward).toLocaleString('id-ID')} saldo virtual\n\nKetik ${ctx.prefix}nyerah untuk melihat jawabannya.`
    const created = createSession(ctx, { game, answer, answers: aliases(item), prompt: promptText, reward, timeout })
    if (!created.ok) return send(ctx, `⏳ Permainan *${created.active.game}* masih aktif. Selesaikan dulu atau ketik ${ctx.prefix}nyerah.`).then(() => true)
    await send(ctx, promptText)
    return true
}

const GAME_CLUES = {
    tebakgame: [
        { soal: 'Game sandbox dengan dunia blok; pemain bisa menambang, membuat alat, dan membangun.', jawaban: 'Minecraft' },
        { soal: 'Game battle royale dari Krafton yang terkenal dengan peta Erangel.', jawaban: 'PUBG' },
        { soal: 'Game MOBA 5 lawan 5 di ponsel yang memiliki hero seperti Layla dan Miya.', jawaban: 'Mobile Legends' },
        { soal: 'Game battle royale yang menampilkan bus terbang dan mode bangun struktur.', jawaban: 'Fortnite' },
        { soal: 'Game open-world action RPG dari HoYoverse dengan wilayah Teyvat.', jawaban: 'Genshin Impact' },
        { soal: 'Game taktis 5 lawan 5 dari Riot Games dengan agen dan kemampuan khusus.', jawaban: 'Valorant' },
        { soal: 'Game sepak bola yang pernah dikenal sebagai FIFA dan dikembangkan EA.', jawaban: 'EA Sports FC' },
        { soal: 'Game rhythm di Roblox yang memakai trek musik dan obstacle berbentuk lintasan.', jawaban: 'Geometry Dash' },
        { soal: 'Game digital card battle yang memakai karakter dari dunia Warcraft.', jawaban: 'Hearthstone' },
        { soal: 'Game petualangan dengan karakter Mario yang menyelamatkan Princess Peach.', jawaban: 'Super Mario' },
        { soal: 'Game horor bertahan hidup dengan animatronik di Freddy Fazbear’s Pizza.', jawaban: 'Five Nights at Freddys' },
        { soal: 'Game balapan kart yang menampilkan Mario dan karakter Nintendo.', jawaban: 'Mario Kart' },
        { soal: 'Game online deduction tentang crewmate dan impostor di pesawat luar angkasa.', jawaban: 'Among Us' },
        { soal: 'Game action RPG dari HoYoverse yang memakai sistem pertarungan turn-based di kereta antariksa.', jawaban: 'Honkai Star Rail' },
        { soal: 'Game survival crafting yang terkenal dengan dinosaurus yang bisa dijinakkan.', jawaban: 'ARK' }
    ],
    tebaklogo: [
        { soal: 'Logo berupa apel yang memiliki gigitan di salah satu sisinya.', jawaban: 'Apple' },
        { soal: 'Logo swoosh sederhana yang identik dengan sepatu dan perlengkapan olahraga.', jawaban: 'Nike' },
        { soal: 'Logo huruf M berwarna kuning dengan dua lengkungan seperti gerbang.', jawaban: 'McDonalds' },
        { soal: 'Logo mesin pencari dengan huruf G berwarna-warni.', jawaban: 'Google' },
        { soal: 'Logo tiga garis sejajar yang dipakai merek perlengkapan olahraga asal Jerman.', jawaban: 'Adidas' },
        { soal: 'Logo burung biru yang dahulu digunakan oleh Twitter.', jawaban: 'Twitter' },
        { soal: 'Logo layanan streaming dengan huruf N merah.', jawaban: 'Netflix' },
        { soal: 'Logo empat kotak warna merah, hijau, biru, dan kuning di produk perangkat lunak.', jawaban: 'Microsoft' },
        { soal: 'Logo lingkaran hijau dengan gelombang suara hitam pada aplikasi musik.', jawaban: 'Spotify' },
        { soal: 'Logo kamera sederhana dengan gradasi warna ungu, merah muda, dan oranye.', jawaban: 'Instagram' },
        { soal: 'Logo huruf A bergaya panah yang dipakai toko online besar.', jawaban: 'Amazon' },
        { soal: 'Logo tiga berlian yang tersusun membentuk simbol merek otomotif Jepang.', jawaban: 'Mitsubishi' },
        { soal: 'Logo huruf F putih pada latar biru yang dahulu dikenal luas sebagai media sosial.', jawaban: 'Facebook' },
        { soal: 'Logo berbentuk gelombang atau tanda centang berwarna merah untuk layanan video.', jawaban: 'YouTube' },
        { soal: 'Logo berbentuk mahkota pada merek jam tangan mewah asal Swiss.', jawaban: 'Rolex' }
    ],
    tekateki: [
        { soal: 'Aku punya gigi tetapi tidak bisa menggigit. Apakah aku?', jawaban: 'Sisir' },
        { soal: 'Semakin banyak diambil, semakin besar aku. Apakah aku?', jawaban: 'Lubang' },
        { soal: 'Aku punya jarum tetapi tidak bisa menjahit dan menunjukkan waktu.', jawaban: 'Jam' },
        { soal: 'Aku selalu naik tetapi tidak pernah turun. Apakah aku?', jawaban: 'Umur' },
        { soal: 'Aku punya banyak tombol tetapi bukan pintu, dan dipakai mengetik.', jawaban: 'Keyboard' },
        { soal: 'Aku basah saat mengeringkan. Apakah aku?', jawaban: 'Handuk' },
        { soal: 'Aku punya leher tetapi tidak punya kepala, dan sering diisi air.', jawaban: 'Botol' },
        { soal: 'Aku punya kota tanpa rumah, sungai tanpa air, dan jalan tanpa kendaraan.', jawaban: 'Peta' },
        { soal: 'Aku bisa terbang tanpa sayap dan menangis tanpa mata.', jawaban: 'Awan' },
        { soal: 'Aku mempunyai daun tetapi bukan tanaman, dan bisa dibaca.', jawaban: 'Buku' },
        { soal: 'Aku ringan seperti bulu, tetapi sulit ditahan lama oleh siapa pun.', jawaban: 'Napas' },
        { soal: 'Aku punya satu mata tetapi tidak dapat melihat, biasanya dipakai menjahit.', jawaban: 'Jarum' }
    ],
    tebaktebakan: [
        { soal: 'Apa yang selalu datang tetapi tidak pernah tiba?', jawaban: 'Besok' },
        { soal: 'Apa yang bisa pecah tanpa pernah disentuh?', jawaban: 'Janji' },
        { soal: 'Apa yang punya banyak kunci tetapi tidak bisa membuka pintu?', jawaban: 'Piano' },
        { soal: 'Apa yang makin diisi justru makin ringan?', jawaban: 'Balon' },
        { soal: 'Apa yang selalu mengikuti kita saat terang tetapi hilang saat gelap?', jawaban: 'Bayangan' },
        { soal: 'Apa yang bisa berjalan tanpa kaki dan punya mulut tanpa berbicara?', jawaban: 'Sungai' },
        { soal: 'Apa yang memiliki halaman tetapi bukan rumah?', jawaban: 'Buku' },
        { soal: 'Apa yang harus dibuka dulu sebelum bisa dipakai untuk menulis?', jawaban: 'Pulpen' },
        { soal: 'Apa yang makin dipotong malah makin panjang jika diukur dari awal?', jawaban: 'Jalan pintas' },
        { soal: 'Apa yang memiliki tangan tetapi tidak bisa bertepuk tangan?', jawaban: 'Jam' }
    ],
    tebakkabupaten: [
        { soal: 'Kabupaten di Jawa Timur yang terkenal dengan Taman Nasional dan berada di ujung timur Pulau Jawa.', jawaban: 'Banyuwangi' },
        { soal: 'Kabupaten di DI Yogyakarta yang wilayahnya berada di sisi utara Kota Yogyakarta.', jawaban: 'Sleman' },
        { soal: 'Kabupaten di Bali yang mencakup kawasan Kuta dan Nusa Dua.', jawaban: 'Badung' },
        { soal: 'Kabupaten di Jawa Barat yang dikenal dengan dodol dan memiliki ibu kota Garut.', jawaban: 'Garut' },
        { soal: 'Kabupaten di Kalimantan Timur yang beribu kota Tenggarong.', jawaban: 'Kutai Kartanegara' },
        { soal: 'Kabupaten di Sulawesi Selatan yang beribu kota Sungguminasa.', jawaban: 'Gowa' },
        { soal: 'Kabupaten di DI Yogyakarta yang beribu kota Bantul.', jawaban: 'Bantul' },
        { soal: 'Kabupaten di Bali yang beribu kota Singaraja.', jawaban: 'Buleleng' },
        { soal: 'Kabupaten di Jawa Tengah yang beribu kota Klaten.', jawaban: 'Klaten' },
        { soal: 'Kabupaten di Jawa Barat yang beribu kota Cibinong.', jawaban: 'Bogor' },
        { soal: 'Kabupaten di Nusa Tenggara Barat yang beribu kota Gerung.', jawaban: 'Lombok Barat' },
        { soal: 'Kabupaten di Sulawesi Selatan yang beribu kota Maros.', jawaban: 'Maros' },
        { soal: 'Kabupaten di Bali yang terkenal dengan kawasan Ubud dan beribu kota Gianyar.', jawaban: 'Gianyar' },
        { soal: 'Kabupaten di Jawa Barat yang beribu kota Sumber.', jawaban: 'Cirebon' },
        { soal: 'Kabupaten di Jawa Timur yang beribu kota Jember.', jawaban: 'Jember' },
        { soal: 'Kabupaten di Jawa Tengah yang beribu kota Purwokerto.', jawaban: 'Banyumas' },
        { soal: 'Kabupaten di Banten yang beribu kota Rangkasbitung.', jawaban: 'Lebak' },
        { soal: 'Kabupaten di Jawa Barat yang beribu kota Soreang.', jawaban: 'Bandung' },
        { soal: 'Kabupaten di Kalimantan Selatan yang beribu kota Martapura.', jawaban: 'Banjar' },
        { soal: 'Kabupaten di Sumatera Barat yang beribu kota Lubuk Basung.', jawaban: 'Agam' }
    ]
}

const PETS = {
    kucing: { name: 'Kucing', price: 12000, emoji: '🐱' },
    anjing: { name: 'Anjing', price: 15000, emoji: '🐶' },
    kelinci: { name: 'Kelinci', price: 10000, emoji: '🐰' },
    rubah: { name: 'Rubah', price: 25000, emoji: '🦊' },
    naga: { name: 'Naga mini', price: 50000, emoji: '🐉' }
}

const CREATURES = {
    fightnaga: { name: 'Naga', hp: 130, power: 22, reward: [4500, 8000], material: 'emas', quantity: [1, 3] },
    fightkucing: { name: 'Kucing Penjaga', hp: 45, power: 8, reward: [800, 1800], material: 'ikan', quantity: [1, 4] },
    fightphonix: { name: 'Phoenix', hp: 105, power: 19, reward: [3500, 7000], material: 'besi', quantity: [1, 3] },
    fightgriffin: { name: 'Griffin', hp: 95, power: 17, reward: [2800, 6200], material: 'kayu', quantity: [2, 6] },
    fightkyubi: { name: 'Kyubi', hp: 120, power: 21, reward: [4000, 7500], material: 'emas', quantity: [1, 3] },
    fightcentaur: { name: 'Centaur', hp: 90, power: 16, reward: [2500, 5500], material: 'besi', quantity: [1, 3] }
}

function ensureRpg(ctx) {
    const db = global.db || (global.db = {})
    if (!db.erpg || typeof db.erpg !== 'object') db.erpg = {}
    const jid = ctx.m.sender
    if (!db.erpg[jid] || typeof db.erpg[jid] !== 'object') db.erpg[jid] = {}
    const user = db.erpg[jid]
    const defaults = {
        rpg: false,
        bank: 0,
        stamina: 100,
        darahuser: 100,
        bonusclaim: 0,
        bansosclaim: 0,
        gajianclaim: 0,
        taxiAt: 0,
        mulungAt: 0,
        tradeAt: 0,
        orchard: null,
        pond: null,
        pets: [],
        referredBy: '',
        referrals: [],
        snakeBoard: 1,
        attackLevel: 1,
        armorLevel: 1,
        petFoodAt: 0
    }
    for (const [key, value] of Object.entries(defaults)) {
        if (user[key] === undefined || user[key] === null) user[key] = Array.isArray(value) ? [...value] : value && typeof value === 'object' ? { ...value } : value
    }
    if (!Array.isArray(user.pets)) user.pets = []
    if (!Array.isArray(user.referrals)) user.referrals = []
    return user
}

function saveGlobal(ctx) {
    try {
        if (typeof ctx.saveGlobalDb === 'function') ctx.saveGlobalDb()
    } catch (error) {
        console.error('[XERYUU EXT DB SAVE]', error?.message || error)
    }
}

function rpgGate(ctx, user) {
    if (user.rpg) return true
    send(ctx, `🔒 Kamu belum bergabung ke RPG. Jalankan ${ctx.prefix}joinrpg terlebih dahulu.`).catch(() => {})
    return false
}

function money(ctx) {
    return ctx.economy.getBalance(ctx.m.sender)
}

function parseMoney(ctx, value) {
    return ctx.economy.parseAmount(value, money(ctx))
}

function cooldownMessage(ctx, until, label) {
    const left = Math.max(0, Number(until || 0) - Date.now())
    const minutes = Math.ceil(left / 60000)
    return send(ctx, `⏳ ${label} masih cooldown. Coba lagi sekitar ${minutes} menit.`)
}

async function handleMoneyCommand(command, ctx, user) {
    const economy = ctx.economy
    const jid = ctx.m.sender
    const amountArg = ctx.args[0]
    const balance = economy.getBalance(jid)

    if (command === 'bankcek') {
        const profile = economy.profile(jid)
        return send(ctx, `╭━━〔 🏦 BANK CHECK 〕━━╮\n│ Wallet : Rp${economy.formatMoney(profile.wallet)}\n│ Bank   : Rp${economy.formatMoney(profile.bank)}\n│ Total  : Rp${economy.formatMoney(profile.total)}\n╰━━━━━━━━━━━━━━━━━━╯`).then(() => true)
    }
    if (command === 'nabung' || command === 'banknabung') {
        if (!amountArg) return send(ctx, `Cara: ${ctx.prefix}${command} <jumlah>\nContoh: ${ctx.prefix}${command} 10k`).then(() => true)
        const amount = parseMoney(ctx, amountArg)
        if (!amount || amount <= 0) return send(ctx, `❌ Jumlah tidak valid. Saldo wallet: Rp${economy.formatMoney(balance)}`).then(() => true)
        const result = economy.deposit(jid, amount)
        if (!result.ok) return send(ctx, `❌ Saldo wallet tidak cukup. Saldo: Rp${economy.formatMoney(result.balance)}`).then(() => true)
        return send(ctx, `✅ *UANG BERHASIL DITABUNG*\n\nJumlah: Rp${economy.formatMoney(amount)}\nSaldo wallet: Rp${economy.formatMoney(result.balance)}\nSaldo bank: Rp${economy.formatMoney(result.bank)}`).then(() => true)
    }
    if (command === 'banktarik') {
        if (!amountArg) return send(ctx, `Cara: ${ctx.prefix}banktarik <jumlah>\nContoh: ${ctx.prefix}banktarik 5k`).then(() => true)
        const amount = parseMoney(ctx, amountArg)
        if (!amount || amount <= 0) return send(ctx, '❌ Jumlah penarikan tidak valid.').then(() => true)
        const result = economy.withdraw(jid, amount)
        if (!result.ok) return send(ctx, `❌ Saldo bank tidak cukup. Saldo bank: Rp${economy.formatMoney(result.bank)}`).then(() => true)
        return send(ctx, `✅ *PENARIKAN BERHASIL*\n\nJumlah: Rp${economy.formatMoney(amount)}\nSaldo bank: Rp${economy.formatMoney(result.bank)}\nSaldo wallet: Rp${economy.formatMoney(result.balance)}`).then(() => true)
    }
    if (command === 'bonus' || command === 'bansos' || command === 'gajian') {
        const keys = { bonus: ['bonusclaim', 24 * 60 * 60 * 1000, [1200, 2200], 'Bonus harian'], bansos: ['bansosclaim', 24 * 60 * 60 * 1000, [1500, 3000], 'Bantuan sosial'], gajian: ['gajianclaim', 7 * 24 * 60 * 60 * 1000, [7000, 14000], 'Gajian mingguan'] }
        const [field, duration, range, label] = keys[command]
        const last = Number(user[field] || 0)
        if (Date.now() - last < duration) return cooldownMessage(ctx, last + duration, label).then(() => true)
        const reward = rand(range[0], range[1])
        user[field] = Date.now()
        economy.addMoney(jid, reward)
        saveGlobal(ctx)
        return send(ctx, `🎁 *${label.toUpperCase()}*\n\nReward: Rp${economy.formatMoney(reward)}\nSaldo sekarang: Rp${economy.formatMoney(money(ctx))}`).then(() => true)
    }
    if (command === 'maling') {
        const target = ctx.m.mentionedJid?.[0] || ctx.m.quoted?.sender
        if (target) {
            const result = economy.rob(jid, target)
            if (!result.ok) {
                const reasons = { COOLDOWN: `Tunggu ${Math.ceil(result.remaining / 60000)} menit.`, SELF: 'Tidak bisa mencuri dari diri sendiri.', POOR: 'Saldo target terlalu kecil.', ENERGY: 'Energi tidak cukup.' }
                return send(ctx, `❌ ${reasons[result.error] || 'Aksi tidak dapat dilakukan.'}`).then(() => true)
            }
            return send(ctx, result.success
                ? `🕵️ Aksi berhasil. Kamu mendapatkan Rp${economy.formatMoney(result.amount)} dari target.`
                : `🚨 Aksi gagal. Denda: Rp${economy.formatMoney(result.fine)}.`).then(() => true)
        }
        const result = economy.crime(jid)
        if (!result.ok) {
            if (result.error === 'COOLDOWN') return cooldownMessage(ctx, Date.now() + result.remaining, 'Maling').then(() => true)
            return send(ctx, result.error === 'ENERGY' ? '⚡ Energi tidak cukup.' : '❌ Aksi gagal diproses.').then(() => true)
        }
        return send(ctx, result.success
            ? `🕵️ *MALING BERHASIL*\n\nKamu mendapatkan Rp${economy.formatMoney(result.reward)}.`
            : `🚔 *MALING GAGAL*\n\nDenda: Rp${economy.formatMoney(result.fine)}.`).then(() => true)
    }
    if (command === 'bet') {
        if (!ctx.args[0] || !ctx.args[1]) return send(ctx, `Permainan saldo virtual saja.\nFormat: ${ctx.prefix}bet <jumlah> <1-6>\nContoh: ${ctx.prefix}bet 1000 4`).then(() => true)
        const amount = parseMoney(ctx, ctx.args[0])
        const guess = Number(ctx.args[1])
        if (!amount || amount < 100 || amount > 50000 || !Number.isInteger(guess) || guess < 1 || guess > 6) return send(ctx, '❌ Masukkan taruhan virtual 100–50.000 dan tebakan angka 1–6.').then(() => true)
        if (balance < amount) return send(ctx, `❌ Saldo tidak cukup. Saldo: Rp${economy.formatMoney(balance)}`).then(() => true)
        const rolled = rand(1, 6)
        economy.addMoney(jid, -amount)
        if (rolled === guess) {
            const payout = amount * 5
            economy.addMoney(jid, payout)
            return send(ctx, `🎲 Angka dadu: *${rolled}*\n✅ Tebakan benar! Payout: Rp${economy.formatMoney(payout)} (profit bersih Rp${economy.formatMoney(payout - amount)}).\nSaldo: Rp${economy.formatMoney(money(ctx))}\n\nHanya saldo virtual bot; tidak ada uang nyata.`).then(() => true)
        }
        return send(ctx, `🎲 Angka dadu: *${rolled}*\n❌ Belum tepat. Taruhan virtual berkurang Rp${economy.formatMoney(amount)}.\nSaldo: Rp${economy.formatMoney(money(ctx))}`).then(() => true)
    }
    return false
}

async function handleFight(command, ctx, user) {
    const creature = CREATURES[command] || { name: 'Monster liar', hp: 75, power: 13, reward: [1800, 3600], material: 'besi', quantity: [1, 2] }
    if (!rpgGate(ctx, user)) return true
    if (Number(user.stamina) < 12) return send(ctx, '⚡ Stamina kurang. Pulihkan dulu sebelum bertarung.').then(() => true)
    if (Number(user.darahuser) < 15) return send(ctx, '❤️ Health terlalu rendah. Pulihkan dulu sebelum bertarung.').then(() => true)
    const attackBonus = Math.max(0, Number(user.attackLevel || 1) - 1) * 8
    const armorBonus = Math.max(0, Number(user.armorLevel || 1) - 1) * 4
    const playerHp = Number(user.darahuser || 100)
    const monsterHp = creature.hp
    const playerPower = rand(22, 36) + attackBonus
    const damageTaken = Math.max(1, creature.power + rand(-5, 6) - armorBonus)
    user.stamina = Math.max(0, Number(user.stamina || 0) - 12)
    const won = playerPower >= Math.floor(monsterHp * 0.55) && playerHp > damageTaken
    const damage = won ? Math.min(playerHp - 1, rand(4, damageTaken)) : Math.min(playerHp, damageTaken + rand(5, 15))
    user.darahuser = Math.max(0, playerHp - damage)
    if (won) {
        const reward = rand(creature.reward[0], creature.reward[1])
        economyAdd(ctx, reward)
        const quantity = rand(creature.quantity[0], creature.quantity[1])
        user[creature.material] = Math.max(0, Number(user[creature.material] || 0)) + quantity
        saveGlobal(ctx)
        return send(ctx, `⚔️ *PERTARUNGAN SELESAI*\n\nLawan: ${creature.name}\nHasil: Menang\nReward: Rp${ctx.economy.formatMoney(reward)}\nLoot: ${quantity} ${creature.material}\nHealth tersisa: ${user.darahuser}%\nStamina tersisa: ${user.stamina}%`).then(() => true)
    }
    saveGlobal(ctx)
    return send(ctx, `⚔️ *PERTARUNGAN SELESAI*\n\nLawan: ${creature.name}\nHasil: Kalah\nHealth tersisa: ${user.darahuser}%\nStamina tersisa: ${user.stamina}%\n\nPulihkan diri sebelum mencoba lagi.`).then(() => true)
}

function economyAdd(ctx, amount) {
    ctx.economy.addMoney(ctx.m.sender, amount)
}

async function handlePetshop(command, ctx, user) {
    if (!rpgGate(ctx, user)) return true
    const [action, petKey] = ctx.args.map(value => String(value).toLowerCase())
    if (!action || action === 'list') {
        const list = Object.entries(PETS).map(([key, pet]) => `• ${pet.emoji} ${key} — Rp${ctx.economy.formatMoney(pet.price)}`).join('\n')
        const own = user.pets.length ? user.pets.map(pet => `${pet.emoji} ${pet.name} (Lv.${pet.level || 1})`).join('\n') : 'Belum punya peliharaan.'
        return send(ctx, `🐾 *PET SHOP*\n\n${list}\n\nPeliharaan kamu:\n${own}\n\nBeli: ${ctx.prefix}petshop beli <nama>`).then(() => true)
    }
    if (action !== 'beli' || !petKey || !PETS[petKey]) return send(ctx, `Pilihan tidak valid. Gunakan ${ctx.prefix}petshop untuk melihat daftar.`).then(() => true)
    if (user.pets.some(pet => pet.key === petKey)) return send(ctx, 'Kamu sudah memiliki peliharaan itu.').then(() => true)
    const pet = PETS[petKey]
    if (money(ctx) < pet.price) return send(ctx, `Saldo kurang. Harga ${pet.name}: Rp${ctx.economy.formatMoney(pet.price)}.`).then(() => true)
    ctx.economy.addMoney(ctx.m.sender, -pet.price)
    user.pets.push({ key: petKey, name: pet.name, emoji: pet.emoji, level: 1, hunger: 100, lastFed: 0 })
    saveGlobal(ctx)
    return send(ctx, `✅ Kamu membeli ${pet.emoji} *${pet.name}*.\nSaldo sekarang: Rp${ctx.economy.formatMoney(money(ctx))}\nGunakan ${ctx.prefix}feed ${petKey} untuk memberi makan.`).then(() => true)
}

async function handleGarden(command, ctx, user) {
    if (!rpgGate(ctx, user)) return true
    const economy = ctx.economy
    if (command === 'berkebon') {
        if (user.orchard && Number(user.orchard.readyAt || 0) > Date.now()) {
            const mins = Math.ceil((user.orchard.readyAt - Date.now()) / 60000)
            return send(ctx, `🌱 Kebun ${user.orchard.crop} sedang tumbuh. Panen tersedia sekitar ${mins} menit lagi.`).then(() => true)
        }
        if (user.orchard && Number(user.orchard.readyAt || 0) <= Date.now()) return send(ctx, `🍎 Kebun siap dipanen. Ketik ${ctx.prefix}buah atau ${ctx.prefix}collect.`).then(() => true)
        const crops = ['apel', 'mangga', 'jeruk', 'pisang', 'anggur']
        const crop = pick(crops)
        user.orchard = { crop, plantedAt: Date.now(), readyAt: Date.now() + 2 * 60 * 1000 }
        saveGlobal(ctx)
        return send(ctx, `🌱 Kamu menanam ${crop}.\nWaktu tumbuh: 2 menit.\nPanen dengan ${ctx.prefix}buah setelah kebun siap.`).then(() => true)
    }
    if (command === 'buah' || command === 'collect') {
        if (command === 'collect' && user.pond && Number(user.pond.readyAt || 0) <= Date.now()) {
            const reward = rand(700, 1800) * Math.max(1, Number(user.pond.level || 1))
            user.pond.readyAt = Date.now() + 15 * 60 * 1000
            user.pond.lastCollected = Date.now()
            economy.addMoney(ctx.m.sender, reward)
            saveGlobal(ctx)
            return send(ctx, `🐟 Kolam berhasil dikoleksi.\nReward virtual: Rp${economy.formatMoney(reward)}\nKoleksi berikutnya tersedia 15 menit lagi.`).then(() => true)
        }
        if (!user.orchard) return send(ctx, `Kamu belum memiliki kebun. Gunakan ${ctx.prefix}berkebon.`).then(() => true)
        if (Number(user.orchard.readyAt || 0) > Date.now()) return send(ctx, `⏳ Buah belum matang. Tunggu ${Math.ceil((user.orchard.readyAt - Date.now()) / 60000)} menit lagi.`).then(() => true)
        const crop = user.orchard.crop
        const amount = rand(3, 8)
        const reward = amount * rand(250, 650)
        user.orchard = null
        economy.addMoney(ctx.m.sender, reward)
        user[crop] = Math.max(0, Number(user[crop] || 0)) + amount
        saveGlobal(ctx)
        return send(ctx, `🍎 *PANEN SELESAI*\n\nHasil: ${amount} ${crop}\nNilai hasil panen: Rp${economy.formatMoney(reward)}\nSaldo: Rp${economy.formatMoney(money(ctx))}`).then(() => true)
    }
    return false
}

async function handlePond(command, ctx, user) {
    if (!rpgGate(ctx, user)) return true
    const action = String(ctx.args[0] || '').toLowerCase()
    if (!user.pond) {
        if (action !== 'beli') return send(ctx, `🎣 Kamu belum memiliki kolam.\nBangun kolam: ${ctx.prefix}kolam beli (Rp15.000 saldo virtual)`).then(() => true)
        const price = 15000
        if (money(ctx) < price) return send(ctx, `Saldo kurang. Biaya kolam Rp${ctx.economy.formatMoney(price)}.`).then(() => true)
        ctx.economy.addMoney(ctx.m.sender, -price)
        user.pond = { level: 1, readyAt: Date.now() + 15 * 60 * 1000, lastCollected: 0 }
        saveGlobal(ctx)
        return send(ctx, '✅ Kolam dibangun. Hasil pertama dapat dikoleksi dalam 15 menit dengan .collect.').then(() => true)
    }
    if (action === 'upgrade') {
        const level = Math.max(1, Number(user.pond.level || 1))
        const price = level * 10000
        if (money(ctx) < price) return send(ctx, `Biaya upgrade: Rp${ctx.economy.formatMoney(price)}.`).then(() => true)
        ctx.economy.addMoney(ctx.m.sender, -price)
        user.pond.level = level + 1
        saveGlobal(ctx)
        return send(ctx, `✅ Kolam naik ke level ${user.pond.level}. Hasil koleksi meningkat.`).then(() => true)
    }
    return send(ctx, `🎣 *KOLAM IKAN*\nLevel: ${user.pond.level}\nStatus: ${user.pond.readyAt <= Date.now() ? 'Siap dikoleksi' : `Siap dalam ${Math.ceil((user.pond.readyAt - Date.now()) / 60000)} menit`}\nGunakan .collect untuk mengambil hasil atau .kolam upgrade untuk meningkatkan level.`).then(() => true)
}

async function handleSnake(ctx, user) {
    if (!rpgGate(ctx, user)) return true
    const ladders = { 3: 22, 8: 30, 20: 41, 27: 56, 36: 55, 51: 72, 71: 92, 80: 99 }
    const snakes = { 17: 4, 34: 12, 49: 31, 62: 19, 64: 60, 87: 24, 95: 75, 99: 78 }
    if (ctx.args[0] === 'reset') {
        user.snakeBoard = 1
        saveGlobal(ctx)
        return send(ctx, '🐍 Posisi Ular Tangga direset ke kotak 1. Jalankan .ulartangga untuk lempar dadu.').then(() => true)
    }
    const dice = rand(1, 6)
    const previous = Math.max(1, Number(user.snakeBoard || 1))
    let next = previous + dice
    if (next > 100) next = previous
    let event = ''
    if (ladders[next]) { event = `🪜 Naik tangga dari ${next} ke ${ladders[next]}!`; next = ladders[next] }
    else if (snakes[next]) { event = `🐍 Kena ular, turun dari ${next} ke ${snakes[next]}.`; next = snakes[next] }
    user.snakeBoard = next
    let rewardText = ''
    if (next === 100) {
        const reward = 10000
        ctx.economy.addMoney(ctx.m.sender, reward)
        user.snakeBoard = 1
        rewardText = `\n🏆 Finish! Hadiah saldo virtual Rp${ctx.economy.formatMoney(reward)}. Posisi direset ke 1.`
    }
    saveGlobal(ctx)
    return send(ctx, `🎲 *ULAR TANGGA*\nDadu: ${dice}\nPosisi: ${previous} → ${user.snakeBoard}${event ? `\n${event}` : ''}${rewardText}\n\nKetik .ulartangga lagi untuk lempar dadu, atau .ulartangga reset untuk memulai ulang.`).then(() => true)
}

async function handleDuel(command, ctx, user) {
    if (!rpgGate(ctx, user)) return true
    if (!ctx.m.isGroup) return send(ctx, '⚔️ Mode duel hanya tersedia di grup.').then(() => true)
    const target = ctx.m.mentionedJid?.[0] || ctx.m.quoted?.sender
    if (!target || target === ctx.m.sender) return send(ctx, `Tag lawan yang berbeda. Contoh: ${ctx.prefix}${command} @user`).then(() => true)
    if (Number(user.stamina) < 10) return send(ctx, 'Stamina kurang untuk mengikuti duel.').then(() => true)
    const won = Math.random() >= 0.5
    const reward = won ? rand(300, 1200) : 0
    user.stamina = Math.max(0, Number(user.stamina || 0) - 10)
    if (reward) ctx.economy.addMoney(ctx.m.sender, reward)
    saveGlobal(ctx)
    return send(ctx, `⚔️ *DUEL NON-GRAFIS*\n\nPemain: @${ctx.m.sender.split('@')[0]} vs @${target.split('@')[0]}\nHasil simulasi: ${won ? 'kamu menang' : 'lawan unggul'}\n${won ? `Hadiah virtual: Rp${ctx.economy.formatMoney(reward)}` : 'Tidak ada saldo yang dipindahkan.'}\nStamina: ${user.stamina}%`, { mentions: [ctx.m.sender, target] }).then(() => true)
}

function drawCard() {
    const cards = [
        { label: 'A', value: 11 }, { label: '2', value: 2 }, { label: '3', value: 3 }, { label: '4', value: 4 },
        { label: '5', value: 5 }, { label: '6', value: 6 }, { label: '7', value: 7 }, { label: '8', value: 8 },
        { label: '9', value: 9 }, { label: '10', value: 10 }, { label: 'J', value: 10 }, { label: 'Q', value: 10 }, { label: 'K', value: 10 }
    ]
    return pick(cards)
}

function handValue(hand) {
    let total = hand.reduce((sum, card) => sum + card.value, 0)
    let aces = hand.filter(card => card.label === 'A').length
    while (total > 21 && aces > 0) { total -= 10; aces-- }
    return total
}

async function handleBlackjack(ctx, user) {
    const action = String(ctx.args[0] || '').toLowerCase()
    let game = user.blackjack && typeof user.blackjack === 'object' ? user.blackjack : null
    const settle = async (reason, result) => {
        const playerTotal = handValue(game.player)
        const dealerTotal = handValue(game.dealer)
        let reward = 0
        if (result === 'win') reward = 1000
        else if (result === 'blackjack') reward = 1500
        else if (result === 'draw') reward = 250
        if (reward) ctx.economy.addMoney(ctx.m.sender, reward)
        user.blackjack = null
        saveGlobal(ctx)
        return send(ctx, `🃏 *BLACKJACK*\n\nKartu kamu: ${game.player.map(card => card.label).join(' ')} (${playerTotal})\nKartu dealer: ${game.dealer.map(card => card.label).join(' ')} (${dealerTotal})\n\n${reason}${reward ? `\nReward saldo virtual: Rp${ctx.economy.formatMoney(reward)}` : ''}\n\nPermainan tanpa taruhan dan tanpa uang nyata.`).then(() => true)
    }
    if (!game || game.status !== 'playing' || action === 'start' || !action) {
        game = { status: 'playing', player: [drawCard(), drawCard()], dealer: [drawCard(), drawCard()], createdAt: Date.now() }
        user.blackjack = game
        saveGlobal(ctx)
        const total = handValue(game.player)
        if (total === 21) return settle('Blackjack! Kamu langsung menang.', 'blackjack')
        return send(ctx, `🃏 *BLACKJACK DIMULAI*\n\nKartu kamu: ${game.player.map(card => card.label).join(' ')} (${total})\nKartu dealer: ${game.dealer[0].label} ?\n\nGunakan:\n• ${ctx.prefix}blackjack hit — ambil kartu\n• ${ctx.prefix}blackjack stand — berhenti\n\nTidak ada taruhan; hadiah hanya saldo virtual.`).then(() => true)
    }
    if (action === 'hit') {
        game.player.push(drawCard())
        const total = handValue(game.player)
        if (total > 21) return settle('Nilai kartu kamu melewati 21.', 'loss')
        if (total === 21) return settle('Nilai kartu 21. Kamu menang jika dealer tidak menyamai.', 'win')
        saveGlobal(ctx)
        return send(ctx, `🃏 Kartu ditarik: ${game.player[game.player.length - 1].label}\nKartu kamu: ${game.player.map(card => card.label).join(' ')} (${total})\nKartu dealer: ${game.dealer[0].label} ?\n\nGunakan ${ctx.prefix}blackjack hit atau ${ctx.prefix}blackjack stand.`).then(() => true)
    }
    if (action === 'stand') {
        while (handValue(game.dealer) < 17) game.dealer.push(drawCard())
        const playerTotal = handValue(game.player)
        const dealerTotal = handValue(game.dealer)
        if (dealerTotal > 21 || playerTotal > dealerTotal) return settle('Kamu menang melawan dealer.', 'win')
        if (playerTotal === dealerTotal) return settle('Hasil seri.', 'draw')
        return settle('Dealer memiliki nilai kartu lebih tinggi.', 'loss')
    }
    return send(ctx, `Gunakan ${ctx.prefix}blackjack hit atau ${ctx.prefix}blackjack stand.`).then(() => true)
}

async function handle(command, ctx) {
    const cmd = String(command || '').toLowerCase()
    if (!ctx?.m || !ctx?.conn) return false
    activeConnection = ctx.conn

    if (cmd === 'nyerah') {
        const current = activeSession(ctx)
        if (!current) return false
        const [key, session] = current
        deleteSession(key)
        return send(ctx, `🏳️ Permainan *${session.game}* dihentikan. Jawabannya: *${session.answerDisplay || session.answers?.[0] || '-'}*`).then(() => true)
    }

    if (['tebakanml', 'tebakgame', 'tebaklogo', 'tebaktebakan', 'tekateki', 'tebakkabupaten'].includes(cmd)) {
        if (cmd === 'tebakanml') {
            const data = readArray('tebakanml.json')
            return startTextQuiz(ctx, cmd, data, { title: 'TEBAKAN HERO MOBILE LEGENDS', clueKey: 'soal', answerKey: 'jawaban', timeout: 120000, reward: 1000, aliases: item => [item.jawaban] })
        }
        if (cmd === 'tebakgame') return startTextQuiz(ctx, cmd, GAME_CLUES.tebakgame, { title: 'TEBAK GAME', clueKey: 'soal', answerKey: 'jawaban', timeout: 120000, reward: 800 })
        if (cmd === 'tebaklogo') return startTextQuiz(ctx, cmd, GAME_CLUES.tebaklogo, { title: 'TEBAK LOGO', clueKey: 'soal', answerKey: 'jawaban', timeout: 60000, reward: 500 })
        if (cmd === 'tebaktebakan') return startTextQuiz(ctx, cmd, GAME_CLUES.tebaktebakan, { title: 'TEBAK-TEBAKAN', clueKey: 'soal', answerKey: 'jawaban', timeout: 60000, reward: 400 })
        if (cmd === 'tekateki') return startTextQuiz(ctx, cmd, GAME_CLUES.tekateki, { title: 'TEKA-TEKI', clueKey: 'soal', answerKey: 'jawaban', timeout: 60000, reward: 400 })
        return startTextQuiz(ctx, cmd, GAME_CLUES.tebakkabupaten, { title: 'TEBAK KABUPATEN INDONESIA', clueKey: 'soal', answerKey: 'jawaban', timeout: 90000, reward: 700 })
    }

    if (cmd === 'tebaklirik') {
        if (!requireGroup(ctx)) return true
        const tracks = readArray('tebaklagu.json').filter(item => item && item.jawaban && item.artist)
        if (!tracks.length) return send(ctx, '❌ Database petunjuk musik belum tersedia.').then(() => true)
        const item = pick(tracks)
        const answer = String(item.jawaban).trim()
        const prompt = `🎤 *TEBAK LAGU — PETUNJUK JUDUL*\n\nArtis: ${safeText(item.artist)}\nJumlah kata judul: ${answer.split(/\s+/).length}\nHuruf pertama judul: ${answer[0].toUpperCase()}\n\nTebak judul lagu dalam 120 detik.\nCatatan: permainan ini memakai petunjuk judul/artis, bukan mengirim teks lirik berhak cipta.`
        const created = createSession(ctx, { game: cmd, answer, answers: [answer, `${item.artist} ${answer}`], prompt, timeout: 120000, reward: 700 })
        if (!created.ok) return send(ctx, `⏳ Permainan *${created.active.game}* masih aktif di grup ini.`).then(() => true)
        return send(ctx, prompt).then(() => true)
    }

    if (cmd === 'tebaklagu') {
        if (!requireGroup(ctx)) return true
        const tracks = readArray('tebaklagu.json').filter(item => item && item.jawaban && item.link_song)
        if (!tracks.length) return send(ctx, '❌ Database audio tebak lagu belum tersedia.').then(() => true)
        const key = sessionKeyForChat(ctx.m.chat)
        const existing = memorySessions[key]
        if (existing) return send(ctx, `⏳ Permainan *${existing.game}* masih aktif di grup ini. Jawab dulu atau ketik ${ctx.prefix}nyerah.`).then(() => true)
        const item = pick(tracks)
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 12000)
        let audio
        try {
            const response = await fetch(item.link_song, { signal: controller.signal })
            if (!response.ok) throw new Error(`Preview HTTP ${response.status}`)
            audio = Buffer.from(await response.arrayBuffer())
            if (!audio.length || audio.length > 8 * 1024 * 1024) throw new Error('Preview kosong atau terlalu besar')
        } catch (error) {
            return send(ctx, `❌ Preview audio belum bisa diambil (${error.message}). Coba ${ctx.prefix}tebaklagu lagi.`).then(() => true)
        } finally {
            clearTimeout(timeoutId)
        }
        const prompt = `🎧 *TEBAK LAGU*\n\nDengarkan audio preview lalu tebak judulnya.\nArtis tidak ditampilkan.\nWaktu: 120 detik\nReward: Rp700 saldo virtual\n\nKetik ${ctx.prefix}nyerah untuk menyerah.`
        const created = createSession(ctx, { game: cmd, answer: item.jawaban, answers: [item.jawaban, `${item.artist} ${item.jawaban}`], prompt, timeout: 120000, reward: 700, timeoutText: `Artis: ${safeText(item.artist)}` })
        if (!created.ok) return send(ctx, `⏳ Permainan *${created.active.game}* masih aktif di grup ini.`).then(() => true)
        await send(ctx, prompt)
        try {
            await ctx.conn.sendMessage(ctx.m.chat, { audio, mimetype: 'audio/mpeg', ptt: false }, { quoted: ctx.m })
        } catch (error) {
            deleteSession(created.key)
            return send(ctx, `❌ Audio preview gagal dikirim (${error.message}). Coba lagi nanti.`).then(() => true)
        }
        return true
    }

    if (cmd === 'tebaksurah') {
        if (!requireGroup(ctx)) return true
        const key = sessionKeyForChat(ctx.m.chat)
        const existing = memorySessions[key]
        if (existing) return send(ctx, `⏳ Permainan *${existing.game}* masih aktif di grup ini. Jawab dulu atau ketik ${ctx.prefix}nyerah.`).then(() => true)
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 12000)
        try {
            const ayahNumber = rand(1, 6236)
            const response = await fetch(`https://api.alquran.cloud/v1/ayah/${ayahNumber}/ar.alafasy`, { signal: controller.signal })
            if (!response.ok) throw new Error(`API Al-Quran HTTP ${response.status}`)
            const result = await response.json()
            const ayah = result?.data
            if (!ayah?.surah || !ayah?.audio) throw new Error('Data ayat tidak lengkap')
            const info = `Nama: ${ayah.surah.englishName} (${ayah.surah.name})\nNomor surah: ${ayah.surah.number}\nJumlah ayat: ${ayah.surah.numberOfAyahs}\nJenis wahyu: ${ayah.surah.revelationType}`
            const prompt = `📖 *TEBAK SURAH*\n\nDengarkan ayat berikut, lalu tebak nama surahnya.\nWaktu: 120 detik\nReward: Rp1.000 saldo virtual\n\nKetik ${ctx.prefix}nyerah untuk menyerah.`
            const aliases = [ayah.surah.englishName, ayah.surah.name, ayah.surah.englishNameTranslation].filter(Boolean)
            const created = createSession(ctx, { game: cmd, answer: ayah.surah.englishName, answers: aliases, prompt, timeout: 120000, reward: 1000, timeoutText: info })
            if (!created.ok) return send(ctx, `⏳ Permainan *${created.active.game}* masih aktif di grup ini.`).then(() => true)
            await send(ctx, prompt)
            const audioResponse = await fetch(ayah.audio, { signal: controller.signal })
            if (!audioResponse.ok) throw new Error(`Audio HTTP ${audioResponse.status}`)
            const audio = Buffer.from(await audioResponse.arrayBuffer())
            if (!audio.length || audio.length > 12 * 1024 * 1024) throw new Error('Audio kosong atau terlalu besar')
            await ctx.conn.sendMessage(ctx.m.chat, { audio, mimetype: 'audio/mpeg', ptt: true }, { quoted: ctx.m })
            return true
        } catch (error) {
            const active = memorySessions[key]
            if (active?.game === cmd) deleteSession(key)
            return send(ctx, `❌ Soal surah belum bisa dimuat: ${error.message}. Silakan coba lagi.`).then(() => true)
        } finally {
            clearTimeout(timeoutId)
        }
    }

    if (cmd === 'blackjack') return handleBlackjack(ctx, ensureRpg(ctx))

    const rpgCommands = new Set([
        'fightnaga', 'fightkucing', 'fightphonix', 'fightgriffin', 'fightkyubi', 'fightcentaur',
        'fight', 'nabung', 'bankcek', 'maling', 'banknabung', 'banktarik', 'berkebon', 'bet',
        'bonus', 'buah', 'bansos', 'taxy', 'mulung', 'berdagang', 'bunuh', 'collect', 'feed',
        'gajian', 'nguli', 'pasar', 'referal', 'petshop', 'kolam', 'koboy', 'casino',
        'perangsarung', 'ulartangga', 'slot', 'duel', 'petualang', 'upgrade', 'sampah'
    ])
    if (!rpgCommands.has(cmd)) return false

    const user = ensureRpg(ctx)
    if (['bankcek', 'nabung', 'banknabung', 'banktarik', 'bonus', 'bansos', 'gajian', 'maling', 'bet'].includes(cmd)) {
        return handleMoneyCommand(cmd, ctx, user)
    }
    if (CREATURES[cmd] || cmd === 'fight' || cmd === 'koboy' || cmd === 'petualang' || cmd === 'perangsarung') {
        if (['koboy', 'petualang', 'perangsarung'].includes(cmd)) {
            if (cmd === 'perangsarung') return handleDuel(cmd, ctx, user)
            if (!user.rpg) return send(ctx, `🔒 Gabung RPG dulu dengan ${ctx.prefix}joinrpg.`).then(() => true)
            const until = Number(user[cmd === 'koboy' ? 'koboyAt' : 'adventureAt'] || 0)
            const field = cmd === 'koboy' ? 'koboyAt' : 'adventureAt'
            if (until > Date.now()) return cooldownMessage(ctx, until, cmd).then(() => true)
            user[field] = Date.now() + COOLDOWN
            user.stamina = Math.max(0, Number(user.stamina || 0) - 10)
            const won = Math.random() < (cmd === 'koboy' ? 0.62 : 0.72)
            if (won) {
                const reward = rand(cmd === 'koboy' ? 1200 : 1500, cmd === 'koboy' ? 3500 : 5000)
                ctx.economy.addMoney(ctx.m.sender, reward)
                user.besi = Math.max(0, Number(user.besi || 0)) + rand(0, 2)
                saveGlobal(ctx)
                return send(ctx, `🧭 *${cmd === 'koboy' ? 'DUEL KOBOY' : 'PETUALANGAN'}*\n\nHasil: Berhasil\nReward: Rp${ctx.economy.formatMoney(reward)} saldo virtual\nStamina tersisa: ${user.stamina}%`).then(() => true)
            }
            user.darahuser = Math.max(0, Number(user.darahuser || 0) - rand(4, 12))
            saveGlobal(ctx)
            return send(ctx, `🧭 *${cmd === 'koboy' ? 'DUEL KOBOY' : 'PETUALANGAN'}*\n\nHasil: Belum berhasil.\nHealth: ${user.darahuser}%\nStamina: ${user.stamina}%`).then(() => true)
        }
        return handleFight(cmd, ctx, user)
    }
    if (cmd === 'berkebon' || cmd === 'buah' || cmd === 'collect') return handleGarden(cmd, ctx, user)
    if (cmd === 'petshop') return handlePetshop(cmd, ctx, user)
    if (cmd === 'kolam') return handlePond(cmd, ctx, user)
    if (cmd === 'ulartangga') return handleSnake(ctx, user)
    if (cmd === 'duel' || cmd === 'bunuh') return handleDuel('duel', ctx, user)

    if (cmd === 'feed') {
        if (!rpgGate(ctx, user)) return true
        if (!user.pets.length) return send(ctx, `Kamu belum memiliki pet. Gunakan ${ctx.prefix}petshop.`).then(() => true)
        const target = String(ctx.args[0] || '').toLowerCase()
        const pet = user.pets.find(value => value.key === target || normalize(value.name) === normalize(target)) || (user.pets.length === 1 ? user.pets[0] : null)
        if (!pet) return send(ctx, `Pilih peliharaan: ${user.pets.map(value => value.key).join(', ')}`).then(() => true)
        if (money(ctx) < 100) return send(ctx, 'Saldo virtual tidak cukup untuk membeli makanan pet (Rp100).').then(() => true)
        ctx.economy.addMoney(ctx.m.sender, -100)
        pet.hunger = Math.min(100, Number(pet.hunger || 0) + 30)
        pet.lastFed = Date.now()
        saveGlobal(ctx)
        return send(ctx, `🍖 ${pet.emoji} ${pet.name} sudah diberi makan. Kenyang: ${pet.hunger}%.`).then(() => true)
    }
    if (cmd === 'taxy') {
        if (!rpgGate(ctx, user)) return true
        const route = ctx.args.join(' ').trim()
        if (!route || !route.includes('|')) return send(ctx, `Format: ${ctx.prefix}taxy <lokasi awal>|<tujuan>\nContoh: ${ctx.prefix}taxy Bandung|Jakarta`).then(() => true)
        if (Number(user.taxiAt || 0) > Date.now()) return cooldownMessage(ctx, user.taxiAt, 'Taxy').then(() => true)
        const [from, to] = route.split('|').map(part => safeText(part.trim(), 50))
        if (!from || !to) return send(ctx, 'Isi lokasi awal dan tujuan.').then(() => true)
        const reward = rand(800, 2200)
        user.taxiAt = Date.now() + COOLDOWN
        user.stamina = Math.max(0, Number(user.stamina || 0) - 5)
        ctx.economy.addMoney(ctx.m.sender, reward)
        saveGlobal(ctx)
        return send(ctx, `🚕 *TAXY SELESAI*\nRute: ${from} → ${to}\nUpah virtual: Rp${ctx.economy.formatMoney(reward)}\nStamina: ${user.stamina}%`).then(() => true)
    }
    if (cmd === 'mulung' || cmd === 'sampah') {
        if (!rpgGate(ctx, user)) return true
        if (Number(user.mulungAt || 0) > Date.now()) return cooldownMessage(ctx, user.mulungAt, 'Mulung').then(() => true)
        const items = { plastik: rand(1, 4), kaleng: rand(0, 3), botol: rand(1, 4), kardus: rand(0, 2) }
        user.mulungAt = Date.now() + COOLDOWN
        user.darahuser = Math.max(0, Number(user.darahuser || 0) - 2)
        for (const [key, value] of Object.entries(items)) user[key] = Math.max(0, Number(user[key] || 0)) + value
        const reward = rand(300, 900)
        ctx.economy.addMoney(ctx.m.sender, reward)
        saveGlobal(ctx)
        return send(ctx, `♻️ *HASIL MULUNG*\n\nPlastik: ${items.plastik}\nKaleng: ${items.kaleng}\nBotol: ${items.botol}\nKardus: ${items.kardus}\nUpah virtual: Rp${ctx.economy.formatMoney(reward)}\nHealth: ${user.darahuser}%`).then(() => true)
    }
    if (cmd === 'berdagang' || cmd === 'nguli') {
        if (!rpgGate(ctx, user)) return true
        const field = cmd === 'berdagang' ? 'tradeAt' : 'nguliAt'
        if (Number(user[field] || 0) > Date.now()) return cooldownMessage(ctx, user[field], cmd).then(() => true)
        if (cmd === 'berdagang') {
            const stake = 1000
            if (money(ctx) < stake) return send(ctx, 'Modal berdagang minimal Rp1.000 saldo virtual.').then(() => true)
            ctx.economy.addMoney(ctx.m.sender, -stake)
            const result = rand(0, 100)
            const payout = result < 75 ? rand(1600, 3500) : rand(200, 800)
            ctx.economy.addMoney(ctx.m.sender, payout)
            user[field] = Date.now() + 20 * 60 * 1000
            saveGlobal(ctx)
            return send(ctx, `🧺 *BERDAGANG*\nModal: Rp${ctx.economy.formatMoney(stake)}\nHasil penjualan: Rp${ctx.economy.formatMoney(payout)}\nSaldo: Rp${ctx.economy.formatMoney(money(ctx))}`).then(() => true)
        }
        const reward = rand(900, 2600)
        user[field] = Date.now() + COOLDOWN
        user.stamina = Math.max(0, Number(user.stamina || 0) - 8)
        ctx.economy.addMoney(ctx.m.sender, reward)
        saveGlobal(ctx)
        return send(ctx, `🧱 *NGULI SELESAI*\nUpah virtual: Rp${ctx.economy.formatMoney(reward)}\nStamina: ${user.stamina}%`).then(() => true)
    }
    if (cmd === 'referal') {
        if (!rpgGate(ctx, user)) return true
        const target = ctx.m.mentionedJid?.[0] || ctx.m.quoted?.sender
        if (!target || target === ctx.m.sender) return send(ctx, `Tag pengguna yang kamu undang. Contoh: ${ctx.prefix}referal @user`).then(() => true)
        ensureRpg({ ...ctx, m: { ...ctx.m, sender: target } })
        const existingDbUser = global.db.erpg[target]
        if (existingDbUser?.referredBy) return send(ctx, 'Pengguna itu sudah memakai kode referral.').then(() => true)
        if (!Array.isArray(user.referrals)) user.referrals = []
        if (user.referrals.includes(target)) return send(ctx, 'Referral pengguna ini sudah pernah dicatat.').then(() => true)
        existingDbUser.referredBy = ctx.m.sender
        user.referrals.push(target)
        ctx.economy.addMoney(ctx.m.sender, 3000)
        ctx.economy.addMoney(target, 1000)
        saveGlobal(ctx)
        return send(ctx, `🎁 *REFERRAL TERCATAT*\nPengundang: @${ctx.m.sender.split('@')[0]}\nPengguna baru: @${target.split('@')[0]}\nReward pengundang: Rp3.000\nReward pengguna baru: Rp1.000`, { mentions: [ctx.m.sender, target] }).then(() => true)
    }
    if (cmd === 'upgrade') {
        if (!rpgGate(ctx, user)) return true
        const type = String(ctx.args[0] || 'senjata').toLowerCase()
        const field = ['armor', 'zirah', 'defense', 'pertahanan'].includes(type) ? 'armorLevel' : 'attackLevel'
        const level = Math.max(1, Number(user[field] || 1))
        const cost = level * 5000
        if (money(ctx) < cost) return send(ctx, `Upgrade ${field === 'armorLevel' ? 'zirah' : 'senjata'} level ${level + 1} membutuhkan Rp${ctx.economy.formatMoney(cost)}.`).then(() => true)
        ctx.economy.addMoney(ctx.m.sender, -cost)
        user[field] = level + 1
        saveGlobal(ctx)
        return send(ctx, `✅ Upgrade berhasil.\n${field === 'armorLevel' ? 'Zirah' : 'Senjata'}: level ${user[field]}\nBiaya: Rp${ctx.economy.formatMoney(cost)}`).then(() => true)
    }
    if (cmd === 'pasar') {
        if (!rpgGate(ctx, user)) return true
        if (String(ctx.args[0] || '').toLowerCase() === 'jual') {
            const item = String(ctx.args[1] || '').toLowerCase()
            const amount = Math.max(1, Math.floor(Number(ctx.args[2] || 1)))
            const result = ctx.economy.sell(ctx.m.sender, item, amount)
            if (!result.ok) return send(ctx, result.error === 'INVENTORY' ? 'Item tidak cukup di inventory.' : 'Item tidak ditemukan di pasar.').then(() => true)
            return send(ctx, `✅ Terjual ${amount} ${item}.\nHasil: Rp${ctx.economy.formatMoney(result.total)}\nSaldo: Rp${ctx.economy.formatMoney(money(ctx))}`).then(() => true)
        }
        const products = Object.entries(ctx.economy.shop()).map(([key, item]) => `• ${key} — beli Rp${ctx.economy.formatMoney(item.price)} / jual Rp${ctx.economy.formatMoney(item.sell || 0)}`).join('\n')
        return send(ctx, `🏪 *PASAR RPG*\n\n${products}\n\nJual item: ${ctx.prefix}pasar jual <item> <jumlah>`).then(() => true)
    }
    if (cmd === 'casino' || cmd === 'slot') {
        if (!ctx.args[0]) return send(ctx, `🎰 *SLOT VIRTUAL*\nFormat: ${ctx.prefix}${cmd} <jumlah>\nContoh: ${ctx.prefix}${cmd} 1000\nSaldo yang digunakan hanya saldo virtual bot, bukan uang nyata.`).then(() => true)
        const bet = parseMoney(ctx, ctx.args[0])
        if (!bet || bet < 100 || bet > 50000) return send(ctx, 'Nominal harus 100–50.000 saldo virtual.').then(() => true)
        if (money(ctx) < bet) return send(ctx, 'Saldo virtual tidak cukup.').then(() => true)
        const symbols = ['🍒', '🍋', '🔔', '💎', '7️⃣']
        const reels = [pick(symbols), pick(symbols), pick(symbols)]
        ctx.economy.addMoney(ctx.m.sender, -bet)
        const counts = reels.reduce((map, symbol) => (map[symbol] = (map[symbol] || 0) + 1, map), {})
        const top = Math.max(...Object.values(counts))
        const multiplier = top === 3 ? (reels[0] === '7️⃣' ? 8 : 5) : top === 2 ? 1.5 : 0
        const payout = Math.floor(bet * multiplier)
        if (payout) ctx.economy.addMoney(ctx.m.sender, payout)
        return send(ctx, `🎰 *SLOT VIRTUAL*\n\n${reels.join(' │ ')}\nTaruhan virtual: Rp${ctx.economy.formatMoney(bet)}\n${payout ? `Payout: Rp${ctx.economy.formatMoney(payout)}` : 'Belum menang di putaran ini.'}\nSaldo: Rp${ctx.economy.formatMoney(money(ctx))}\n\nTidak melibatkan uang nyata.`).then(() => true)
    }
    return false
}

async function processAnswer(ctx) {
    activeConnection = ctx.conn || activeConnection
    if (!ctx?.m?.isGroup || ctx.m.key?.fromMe || ctx.isCmd) return false
    const body = normalize(ctx.body)
    if (!body) return false
    const current = activeSession(ctx)
    if (!current) return false
    const [key, session] = current
    if (Number(session.expiresAt || 0) <= Date.now()) {
        await sessionTimeout(key)
        return true
    }
    if (session.privateAnswer && session.sender !== ctx.m.sender) return false
    const matched = (session.answers || []).some(answer => {
        if (!answer) return false
        if (body === answer) return true
        return answer.length >= 5 && body.includes(answer)
    })
    if (!matched) {
        await send(ctx, '❌ Belum tepat, coba lagi.').catch(error => {
            console.warn('[XERYUU GAME WRONG ANSWER]', error?.message || error)
        })
        return true
    }
    deleteSession(key)
    const reward = Math.max(0, Number(session.reward || 0))
    if (reward && ctx.economy?.addMoney) ctx.economy.addMoney(ctx.m.sender, reward)
    try {
        const user = global.db?.users?.[ctx.m.sender]
        if (user) user.exp = Math.max(0, Number(user.exp || 0)) + 100
        if (typeof ctx.saveGlobalDb === 'function') ctx.saveGlobalDb()
    } catch (error) {
        console.warn('[XERYUU GAME REWARD SAVE]', error?.message || error)
    }
    await send(ctx, `✅ *JAWABAN BENAR!*\n\nPermainan: ${session.game}\nJawaban: *${session.answerDisplay}*\nReward: Rp${ctx.economy?.formatMoney ? ctx.economy.formatMoney(reward) : reward} saldo virtual\n✨ Bonus: +100 EXP`).catch(error => {
        console.warn('[XERYUU GAME ANSWER REPLY]', error?.message || error)
    })
    return true
}

module.exports = {
    handle,
    processAnswer,
    restoreTimers,
    normalizeAnswer: normalize,
    getCommandNames() {
        return [
            'tebakanml', 'tebakgame', 'tebaklogo', 'tebaksurah', 'blackjack', 'tebaktebakan', 'tebaklirik', 'tebaklagu', 'tekateki', 'tebakkabupaten',
            'fightnaga', 'fightkucing', 'fightphonix', 'fightgriffin', 'fightkyubi', 'fightcentaur', 'nabung', 'bankcek', 'maling', 'banknabung', 'banktarik', 'berkebon', 'bet', 'bonus', 'buah', 'bansos', 'taxy', 'mulung', 'berdagang', 'bunuh', 'collect', 'feed', 'fight', 'gajian', 'nguli', 'pasar', 'referal', 'petshop', 'kolam', 'koboy', 'casino', 'perangsarung', 'ulartangga', 'slot', 'duel', 'petualang', 'upgrade', 'sampah', 'nyerah', 'ewe-paksa', 'ewepaksa'
        ]
    }
}
