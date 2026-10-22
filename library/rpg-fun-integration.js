'use strict'

// Restored Furina-style SFW anime reaction commands. All are image/sticker
// reactions only; there is no real-world action or instructional content.
const SAFE_ACTION_CATEGORIES = new Set([
    'cry', 'kill', 'hug', 'pat', 'wink', 'poke', 'smile', 'wave', 'blush', 'smug',
    'happy', 'dance', 'cringe', 'highfive', 'shinobu', 'foxgirl', 'nom', 'kiss',
    'bite', 'yeet', 'bully', 'bonk', 'slap', 'glomp', 'cuddle', 'handhold', 'tickle',
    'lick', 'spank', 'feed', 'avatar', 'awoo'
])
const ACTION_LABELS = {
    cry: 'menangis', kill: 'aksi anime fiktif', hug: 'pelukan persahabatan', pat: 'menepuk kepala',
    wink: 'mengedipkan mata', poke: 'menyenggol', smile: 'tersenyum', wave: 'melambaikan tangan',
    blush: 'tersipu', smug: 'bergaya percaya diri', happy: 'bahagia', dance: 'menari',
    cringe: 'cringe', highfive: 'tos', shinobu: 'Shinobu', foxgirl: 'foxgirl', nom: 'nom',
    bite: 'gigitan kartun', slap: 'tamparan kartun', kiss: 'aksi anime non-eksplisit',
    yeet: 'aksi kartun', bully: 'reaksi anime fiktif', bonk: 'bonk kartun', glomp: 'pelukan ceria',
    cuddle: 'pelukan hangat', handhold: 'bergandengan tangan', tickle: 'gelitikan kartun',
    lick: 'reaksi anime', spank: 'bonk kartun', feed: 'memberi makan', avatar: 'avatar anime',
    awoo: 'awoo'
}
const SCORE_COMMANDS = new Set([
    'stupidcheck', 'handsomecheck', 'uncleancheck', 'hotcheck', 'smartcheck', 'greatcheck',
    'evilcheck', 'dogcheck', 'coolcheck', 'waifucheck', 'awesomecheck', 'cutecheck',
    'prettycheck', 'lovelycheck', 'uglycheck'
])
const QUESTION_COMMANDS = new Set(['can', 'is', 'when', 'where', 'what', 'how'])
const COMMANDS = new Set([
    'pinjol', 'belivga', 'nambangkripto', 'jualkripto', 'pilihclass', 'mystats',
    'battle', 'invest', 'portofolio', 'blackinvest', 'balapan', 'nyawit',
    'math', 'fact', 'pick', 'soulmate', 'fitnah', 'funfeed', ...SCORE_COMMANDS, ...QUESTION_COMMANDS,
    ...SAFE_ACTION_CATEGORIES, 'hornycheck', 'gaycheck', 'lesbiancheck', 'lesbicheck',
    'awoo', 'lotre', 'poker3', 'hilo', 'rr', 'sabung', 'bomb', 'heist', 'begal'
])
const FURINA_GROUP_PERCENT_CHECKS = new Set([
    'awesomecheck', 'greatcheck', 'gaycheck', 'cutecheck', 'lesbicheck',
    'lesbiancheck', 'hornycheck', 'prettycheck', 'lovelycheck', 'uglycheck'
])
const FURINA_BARE_PERCENT_CHECKS = new Set([
    'stupidcheck', 'uncleancheck', 'hotcheck', 'smartcheck', 'evilcheck',
    'dogcheck', 'coolcheck', 'waifucheck'
])
const COOLDOWNS = {
    nambangkripto: 10 * 60 * 1000,
    blackinvest: 24 * 60 * 60 * 1000,
    balapan: 15 * 60 * 1000,
    nyawit: 30 * 60 * 1000,
    battle: 5 * 60 * 1000
}
const GPU_PRICE = 15000
const MAX_LOAN = 50000
const LOAN_FEE_RATE = 0.10
const CRYPTO_BASE_PRICE = 1250
const VALID_CLASSES = {
    petarung: { title: 'Petarung', bonus: 'Bonus stamina pada petualangan' },
    penambang: { title: 'Penambang', bonus: 'Bonus token saat menambang virtual' },
    petani: { title: 'Petani', bonus: 'Bonus hasil panen virtual' },
    pedagang: { title: 'Pedagang', bonus: 'Bonus pendapatan dari jual kripto virtual' },
    penjelajah: { title: 'Penjelajah', bonus: 'Bonus reward misi eksplorasi' }
}

function safeText(value, limit = 80) {
    return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function ensureDb(ctx) {
    const db = global.db || (global.db = {})
    if (!db.erpg || typeof db.erpg !== 'object' || Array.isArray(db.erpg)) db.erpg = {}
    const jid = String(ctx.m.sender || '')
    if (!db.erpg[jid] || typeof db.erpg[jid] !== 'object') db.erpg[jid] = {}
    const user = db.erpg[jid]
    const defaults = {
        rpg: false, bank: 0, stamina: 100, darahuser: 100, crypto: 0, vga: 0,
        cryptoMinedAt: 0, loanRpg: { principal: 0, totalDue: 0 }, classRpg: '',
        blackInvestAt: 0, balapanAt: 0, nyawitAt: 0, battleAt: 0,
        cryptoHoldings: {}, blackInvestPoints: 0, blackInvestDay: ''
    }
    for (const [key, value] of Object.entries(defaults)) {
        if (user[key] === undefined || user[key] === null) {
            user[key] = value && typeof value === 'object' ? (Array.isArray(value) ? [...value] : { ...value }) : value
        }
    }
    if (!user.loanRpg || typeof user.loanRpg !== 'object') user.loanRpg = { principal: 0, totalDue: 0 }
    if (!user.cryptoHoldings || typeof user.cryptoHoldings !== 'object' || Array.isArray(user.cryptoHoldings)) user.cryptoHoldings = {}
    return user
}
function save(ctx) {
    try { if (typeof ctx.saveGlobalDb === 'function') ctx.saveGlobalDb() } catch (error) {
        console.error('[XERYUU RPG/FUN SAVE]', error?.message || error)
    }
}
async function send(ctx, text, options = {}) {
    if (typeof ctx.reply === 'function') return ctx.reply(text, options)
    return ctx.conn.sendMessage(ctx.m.chat, { text, ...options }, { quoted: ctx.qtoko || ctx.m })
}
async function sendChatReply(ctx, chat, text, options = {}) {
    const quoted = ctx.qtoko || ctx.m
    if (typeof ctx.reply === 'function') {
        return ctx.reply(text, {
            ...options,
            chatOverride: chat,
            includeSenderMention: false,
            quoted
        })
    }
    return ctx.conn.sendMessage(chat, { text, ...options }, { quoted })
}
function money(ctx) { return Math.max(0, Number(ctx.economy?.getBalance?.(ctx.m.sender) || 0)) }
function formatMoney(ctx, amount) {
    return ctx.economy?.formatMoney ? ctx.economy.formatMoney(Math.round(amount)) : Math.round(amount).toLocaleString('id-ID')
}
function addMoney(ctx, amount) {
    if (typeof ctx.economy?.addMoney !== 'function') throw new Error('API saldo virtual tidak tersedia.')
    ctx.economy.addMoney(ctx.m.sender, Math.round(amount))
}
function cooldownLeft(user, field, now = Date.now()) { return Math.max(0, Number(user[field] || 0) - now) }
function durationText(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000))
    return minutes >= 60 ? `${Math.ceil(minutes / 60)} jam` : `${minutes} menit`
}
function joinedRpg(ctx, user) {
    if (user.rpg) return true
    send(ctx, `🔒 Kamu belum bergabung di RPG. Gunakan ${ctx.prefix}joinrpg terlebih dahulu.`).catch(() => {})
    return false
}
function stableDailyPrice() {
    const date = new Date().toISOString().slice(0, 10)
    let hash = 0
    for (const char of date) hash = ((hash * 31) + char.charCodeAt(0)) >>> 0
    const percentage = (hash % 31) - 15
    return Math.max(250, Math.round(CRYPTO_BASE_PRICE * (1 + percentage / 100)))
}
function parseCount(raw, fallback = 1) {
    const val = String(raw == null ? '' : raw).trim().toLowerCase()
    if (['all', 'semua'].includes(val)) return Infinity
    const number = Number(val || fallback)
    return Number.isSafeInteger(number) && number > 0 && number <= 1000000 ? number : null
}
function dateKey() { return new Date().toISOString().slice(0, 10) }
function tokenizeMath(input) {
    const source = String(input || '').replace(/,/g, '.').trim()
    if (!source || source.length > 100) return null
    const tokens = source.match(/\d+(?:\.\d+)?|[()+\-*/%]/g)
    if (!tokens || tokens.join('') !== source.replace(/\s+/g, '')) return null
    return tokens
}
function evaluateMath(input) {
    const tokens = tokenizeMath(input)
    if (!tokens || tokens.length > 50) return { error: 'Ekspresi tidak valid. Contoh: .math (12 + 8) * 3 / 2' }
    let index = 0
    function expression() {
        let value = term()
        while (tokens[index] === '+' || tokens[index] === '-') {
            const op = tokens[index++]
            const right = term()
            value = op === '+' ? value + right : value - right
        }
        return value
    }
    function term() {
        let value = factor()
        while (['*', '/', '%'].includes(tokens[index])) {
            const op = tokens[index++]
            const right = factor()
            if ((op === '/' || op === '%') && right === 0) throw new Error('Pembagian dengan nol tidak diperbolehkan.')
            value = op === '*' ? value * right : op === '/' ? value / right : value % right
        }
        return value
    }
    function factor() {
        if (tokens[index] === '+') { index++; return factor() }
        if (tokens[index] === '-') { index++; return -factor() }
        if (tokens[index] === '(') {
            index++
            const value = expression()
            if (tokens[index] !== ')') throw new Error('Kurung tutup belum lengkap.')
            index++
            return value
        }
        const token = tokens[index++]
        if (!token || !/^\d+(?:\.\d+)?$/.test(token)) throw new Error('Ekspresi tidak lengkap.')
        return Number(token)
    }
    try {
        const result = expression()
        if (index !== tokens.length || !Number.isFinite(result) || Math.abs(result) > 1e15) return { error: 'Ekspresi tidak valid atau hasil terlalu besar.' }
        return { value: Number(result.toPrecision(12)) }
    } catch (error) { return { error: error.message || 'Perhitungan tidak valid.' } }
}
const WAIFU_PICS_ACTIONS = new Set([
    'kill', 'hug', 'pat', 'wink', 'poke', 'nom', 'kiss', 'bite', 'yeet', 'bully', 'bonk',
    'slap', 'smile', 'wave', 'awoo', 'blush', 'smug', 'glomp', 'happy', 'dance', 'cringe',
    'cuddle', 'highfive', 'shinobu', 'handhold'
])

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Xeryuu-MD/17 (+Xeryuu anime reaction commands)' }
        })
        if (!response.ok) throw new Error(`API media HTTP ${response.status}`)
        return await response.json()
    } finally {
        clearTimeout(timer)
    }
}

async function fetchSafeAction(category) {
    // Furina V18 routed standard reactions through waifu.pics and the legacy
    // avatar/feed/fox-girl commands through image APIs. Use SFW sources only;
    // spank is mapped to the equivalent cartoon bonk category.
    const requestedCategory = String(category || '').toLowerCase()
    const sourceCategory = requestedCategory === 'spank' ? 'bonk' : requestedCategory
    const errors = []

    const parseUrl = data => {
        const url = data?.url || data?.results?.[0]?.url || data?.images?.[0]?.url || data?.items?.[0]?.url || data?.image || data?.result?.url
        return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null
    }

    if (requestedCategory === 'foxgirl') {
        // waifu.im has an explicit fox_girl tag; don't silently substitute a
        // generic image if the requested category is unavailable.
        try {
            const data = await fetchJsonWithTimeout('https://api.waifu.im/images?IncludedTags=fox_girl&PageSize=1')
            const url = parseUrl(data)
            if (url) return url
            throw new Error('API fox_girl tidak mengembalikan URL media yang valid.')
        } catch (error) { errors.push(error?.message || String(error)) }
    }

    if (requestedCategory === 'avatar' || requestedCategory === 'feed' || requestedCategory === 'tickle') {
        const legacyCategory = requestedCategory
        try {
            const data = await fetchJsonWithTimeout(`https://nekos.life/api/v2/img/${encodeURIComponent(legacyCategory)}`)
            const url = parseUrl(data)
            if (url) return url
            throw new Error(`API ${requestedCategory} tidak mengembalikan URL media yang valid.`)
        } catch (error) { errors.push(error?.message || String(error)) }
    }

    if (requestedCategory === 'feed') {
        try {
            const endpointData = await fetchJsonWithTimeout('https://nekos.best/api/v2/endpoints')
            if (endpointData && Object.prototype.hasOwnProperty.call(endpointData, 'feed')) {
                const data = await fetchJsonWithTimeout('https://nekos.best/api/v2/feed')
                const url = parseUrl(data)
                if (url) return url
                throw new Error('API feed tidak mengembalikan URL media yang valid.')
            }
        } catch (error) { errors.push(error?.message || String(error)) }
    }

    if (requestedCategory === 'avatar') {
        try {
            const data = await fetchJsonWithTimeout('https://api.waifu.pics/sfw/neko')
            const url = parseUrl(data)
            if (url) return url
            throw new Error('Fallback avatar tidak mengembalikan URL media yang valid.')
        } catch (error) { errors.push(error?.message || String(error)) }
    }

    const WAIFU_PICS_ACTIONS = new Set([
        'cry', 'kill', 'hug', 'pat', 'wink', 'poke', 'nom', 'kiss', 'lick', 'bite',
        'yeet', 'bully', 'bonk', 'slap', 'smile', 'wave', 'awoo', 'blush', 'smug',
        'glomp', 'happy', 'dance', 'cringe', 'cuddle', 'highfive', 'shinobu', 'handhold'
    ])
    if (WAIFU_PICS_ACTIONS.has(sourceCategory)) {
        try {
            const data = await fetchJsonWithTimeout(`https://api.waifu.pics/sfw/${encodeURIComponent(sourceCategory)}`)
            const url = parseUrl(data)
            if (url) return url
            throw new Error(`API ${sourceCategory} tidak mengembalikan URL media yang valid.`)
        } catch (error) { errors.push(error?.message || String(error)) }
    }

    // Keep legacy endpoints as fallback for categories Furina used with
    // nekos.life. These are read-only SFW image lookups; URLs are validated.
    const legacyCategories = { foxgirl: 'fox_girl' }
    if (Object.prototype.hasOwnProperty.call(legacyCategories, requestedCategory)) {
        try {
            const data = await fetchJsonWithTimeout(`https://nekos.life/api/v2/img/${encodeURIComponent(legacyCategories[requestedCategory])}`)
            const url = parseUrl(data)
            if (url) return url
            throw new Error(`API ${requestedCategory} tidak mengembalikan URL media yang valid.`)
        } catch (error) { errors.push(error?.message || String(error)) }
    }

    // Final category-aware fallback. Discover available categories first.
    // When a provider doesn't have an old Furina alias, use the closest SFW
    // reaction category rather than failing immediately.
    const fallbackCategories = {
        spank: 'bonk', lick: 'nom', awoo: 'happy', kill: 'bonk'
    }
    const candidates = [...new Set([requestedCategory, sourceCategory, fallbackCategories[requestedCategory]].filter(Boolean))]
    try {
        const endpointData = await fetchJsonWithTimeout('https://nekos.best/api/v2/endpoints')
        for (const candidate of candidates) {
            if (!endpointData || !Object.prototype.hasOwnProperty.call(endpointData, candidate)) continue
            try {
                const data = await fetchJsonWithTimeout(`https://nekos.best/api/v2/${encodeURIComponent(candidate)}`)
                const url = parseUrl(data)
                if (url) return url
                throw new Error(`API ${candidate} tidak mengembalikan URL media yang valid.`)
            } catch (error) { errors.push(error?.message || String(error)) }
        }
    } catch (error) { errors.push(error?.message || String(error)) }

    throw new Error(errors[0] || `Kategori media ${requestedCategory} belum tersedia dari penyedia SFW.`)
}

async function sendAction(ctx, command) {
    if (!SAFE_ACTION_CATEGORIES.has(command)) return false
    try {
        const url = await fetchSafeAction(command)
        const label = ACTION_LABELS[command] || 'gambar anime'

        // Match Furina V18: send reaction media as a sticker where the
        // runtime provides the project's sticker helper. Keep a proper image
        // fallback so a missing converter doesn't make the command unusable.
        if (typeof ctx.conn.sendImageAsSticker === 'function') {
            try {
                await ctx.conn.sendImageAsSticker(ctx.m.chat, url, ctx.qtoko || ctx.m, {
                    packname: global.packname || 'Xeryuu-Md',
                    author: global.author || 'XnalzNotDev'
                })
                return true
            } catch (stickerError) {
                console.warn(`[XERYUU FUN STICKER ${command}]`, stickerError?.message || stickerError)
            }
        }

        const message = { caption: `✨ ${label.toUpperCase()}` }
        if (/\.gif(?:\?|$)/i.test(url)) {
            message.video = { url }
            message.gifPlayback = true
        } else message.image = { url }
        await ctx.conn.sendMessage(ctx.m.chat, message, { quoted: ctx.qtoko || ctx.m })
        return true
    } catch (error) {
        await send(ctx, `❌ Media untuk .${command} gagal dimuat. Coba lagi sebentar.`)
        console.error(`[XERYUU FUN MEDIA ${command}]`, error?.message || error)
        return true
    }
}

async function handlePinjol(ctx, user, args) {
    if (!joinedRpg(ctx, user)) return true
    const loan = user.loanRpg
    const mode = String(args[0] || '').toLowerCase()
    if (mode === 'bayar' || mode === 'lunas') {
        const amountRequested = parseCount(args[1], 1)
        if (!Number.isSafeInteger(amountRequested) && amountRequested !== Infinity) return send(ctx, `Cara pakai: ${ctx.prefix}pinjol bayar <jumlah> atau ${ctx.prefix}pinjol bayar all`)
        const balance = money(ctx)
        const due = Math.max(0, Number(loan.totalDue || 0))
        if (!due) return send(ctx, '✅ Kamu tidak memiliki pinjaman RPG yang belum dibayar.')
        const payable = amountRequested === Infinity ? Math.min(balance, due) : Math.min(amountRequested, balance, due)
        if (payable <= 0) return send(ctx, `Saldo virtual: Rp${formatMoney(ctx, balance)}\nTotal tagihan: Rp${formatMoney(ctx, due)}.`)
        addMoney(ctx, -payable)
        loan.totalDue = due - payable
        loan.principal = Math.max(0, Number(loan.principal || 0) - Math.min(Number(loan.principal || 0), payable))
        if (loan.totalDue <= 0) user.loanRpg = { principal: 0, totalDue: 0 }
        save(ctx)
        return send(ctx, `✅ Pembayaran pinjaman RPG dicatat.\nDibayar: Rp${formatMoney(ctx, payable)}\nSisa tagihan: Rp${formatMoney(ctx, user.loanRpg.totalDue)}\nSaldo virtual: Rp${formatMoney(ctx, money(ctx))}`)
    }
    if (Number(loan.totalDue || 0) > 0) return send(ctx, `⚠️ Lunasi pinjaman sebelumnya terlebih dahulu.\nPokok: Rp${formatMoney(ctx, loan.principal)}\nTotal tagihan: Rp${formatMoney(ctx, loan.totalDue)}\nCara bayar: ${ctx.prefix}pinjol bayar <jumlah>`)
    const amount = Number(String(args[0] || '').replace(/[.,]/g, ''))
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > MAX_LOAN) {
        return send(ctx, `💼 *PINJAMAN RPG (SALDO VIRTUAL)*\n\nNominal: Rp1.000–Rp${formatMoney(ctx, MAX_LOAN)}\nBiaya simulasi: ${LOAN_FEE_RATE * 100}%\nContoh: ${ctx.prefix}pinjol 10000\n\nIni hanya saldo di dalam game, bukan layanan pinjaman uang sungguhan.`)
    }
    const due = Math.ceil(amount * (1 + LOAN_FEE_RATE))
    addMoney(ctx, amount)
    user.loanRpg = { principal: amount, totalDue: due, createdAt: Date.now() }
    save(ctx)
    return send(ctx, `✅ Pinjaman RPG berhasil dicatat.\nDana virtual: Rp${formatMoney(ctx, amount)}\nTotal tagihan virtual: Rp${formatMoney(ctx, due)}\nBiaya simulasi 10%.\nBayar dengan: ${ctx.prefix}pinjol bayar <jumlah>\n\n_Tidak ada uang sungguhan yang dipinjam atau ditagih._`)
}
async function handleCrypto(ctx, user, command, args) {
    if (!joinedRpg(ctx, user)) return true
    const now = Date.now()
    if (command === 'belivga') {
        const amount = parseCount(args[0], 1)
        if (!Number.isSafeInteger(amount) || amount > 10) return send(ctx, `Contoh: ${ctx.prefix}belivga 1 (maksimal 10 unit sekaligus).`)
        const cost = amount * GPU_PRICE
        if (money(ctx) < cost) return send(ctx, `Saldo virtual tidak cukup.\nHarga 1 VGA: Rp${formatMoney(ctx, GPU_PRICE)}\nSaldo kamu: Rp${formatMoney(ctx, money(ctx))}`)
        addMoney(ctx, -cost)
        user.vga = Math.max(0, Number(user.vga || 0)) + amount
        save(ctx)
        return send(ctx, `🖥️ Pembelian VGA virtual berhasil.\nJumlah dibeli: ${amount}\nBiaya: Rp${formatMoney(ctx, cost)}\nTotal VGA: ${user.vga}\n\n_VGA dan saldo ini hanya aset game; tidak menambang kripto sungguhan._`)
    }
    if (command === 'nambangkripto') {
        const left = cooldownLeft(user, 'cryptoMinedAt', now)
        if (left > 0) return send(ctx, `⏳ Mesin virtual sedang bekerja. Coba lagi dalam ${durationText(left)}.`)
        const vga = Math.max(0, Number(user.vga || 0))
        if (vga < 1) return send(ctx, `🖥️ Kamu belum punya VGA virtual. Beli dengan ${ctx.prefix}belivga 1.`)
        user.cryptoMinedAt = now + COOLDOWNS.nambangkripto
        const classBonus = user.classRpg === 'penambang' ? 2 : 0
        const mined = Math.max(1, vga + randInt(0, 2) + classBonus)
        user.crypto = Math.max(0, Number(user.crypto || 0)) + mined
        save(ctx)
        return send(ctx, `⛏️ *MINING KRIPTO VIRTUAL*\n\nUnit VGA: ${vga}\nToken didapat: ${mined}\nTotal token: ${user.crypto}\nHarga simulasi hari ini: Rp${formatMoney(ctx, stableDailyPrice())}/token\nCooldown: 10 menit\n\n_Tidak terhubung ke blockchain, wallet, atau aset sungguhan._`)
    }
    const available = Math.max(0, Number(user.crypto || 0))
    const requested = parseCount(args[0], 1)
    if (!Number.isSafeInteger(requested) && requested !== Infinity) return send(ctx, `Contoh: ${ctx.prefix}jualkripto 2 atau ${ctx.prefix}jualkripto all.`)
    const units = Math.min(available, requested === Infinity ? available : requested)
    if (units <= 0) return send(ctx, `Token virtual kamu: ${available}. Gunakan ${ctx.prefix}nambangkripto untuk menambang.`)
    const price = stableDailyPrice()
    const bonus = user.classRpg === 'pedagang' ? 0.05 : 0
    const proceeds = Math.round(units * price * (1 + bonus))
    user.crypto = available - units
    addMoney(ctx, proceeds)
    save(ctx)
    return send(ctx, `💱 Penjualan kripto virtual selesai.\nToken dijual: ${units}\nHarga simulasi/token: Rp${formatMoney(ctx, price)}\nHasil saldo virtual: Rp${formatMoney(ctx, proceeds)}\nSisa token: ${user.crypto}\n\n_Nilai ini hanya ekonomi permainan dan bukan harga pasar._`)
}
async function handleClass(ctx, user, args) {
    if (!joinedRpg(ctx, user)) return true
    const requested = String(args[0] || '').toLowerCase()
    if (!requested) {
        const rows = Object.entries(VALID_CLASSES).map(([key, item]) => `• ${key} — ${item.bonus}`).join('\n')
        return send(ctx, `🛡️ *PILIH CLASS RPG*\n\n${rows}\n\nContoh: ${ctx.prefix}pilihclass penambang\nPilihan hanya dapat dibuat satu kali.`)
    }
    if (user.classRpg) return send(ctx, `Class kamu sudah ditetapkan: *${VALID_CLASSES[user.classRpg]?.title || user.classRpg}*. Pilihan tidak bisa diganti.`)
    if (!VALID_CLASSES[requested]) return send(ctx, `Class tidak dikenal. Gunakan ${ctx.prefix}pilihclass untuk melihat opsi.`)
    user.classRpg = requested
    save(ctx)
    return send(ctx, `✅ Class RPG kamu: *${VALID_CLASSES[requested].title}*\nBonus pasif: ${VALID_CLASSES[requested].bonus}`)
}
async function handleMyStats(ctx, user) {
    const inventory = Array.isArray(user.pets) ? user.pets.length : 0
    const crypto = Math.max(0, Number(user.crypto || 0))
    const currentClass = VALID_CLASSES[user.classRpg]?.title || 'Belum dipilih'
    return send(ctx, `📊 *STATISTIK XERYUU RPG*\n\n💰 Saldo virtual: Rp${formatMoney(ctx, money(ctx))}\n🏦 Bank RPG: Rp${formatMoney(ctx, Number(user.bank || 0))}\n❤️ Health: ${Math.max(0, Number(user.darahuser || 0))}%\n⚡ Stamina: ${Math.max(0, Number(user.stamina || 0))}%\n🛡️ Class: ${currentClass}\n🖥️ VGA virtual: ${Math.max(0, Number(user.vga || 0))}\n🪙 Token virtual: ${crypto}\n📈 Estimasi nilai token: Rp${formatMoney(ctx, crypto * stableDailyPrice())}\n🐾 Pet: ${inventory}\n🧭 RPG aktif: ${user.rpg ? 'Ya' : 'Belum bergabung'}\n\n_Seluruh nilai ekonomi di sini fiktif dan hanya berlaku di dalam bot._`)
}
async function handleInvest(ctx, user, command, args) {
    if (!joinedRpg(ctx, user)) return true
    if (command === 'portofolio') {
        const qty = Math.max(0, Number(user.crypto || 0))
        const marketValue = qty * stableDailyPrice()
        const holdings = Object.entries(user.cryptoHoldings || {}).map(([asset, amount]) => `• ${asset.toUpperCase()}: ${amount} unit`).join('\n') || '• Belum ada aset latihan.'
        return send(ctx, `📈 *PORTOFOLIO LATIHAN*\n\n🪙 Token virtual: ${qty}\n💵 Nilai acuan token: Rp${formatMoney(ctx, stableDailyPrice())}/unit\n📊 Nilai token simulasi: Rp${formatMoney(ctx, marketValue)}\n\nAset latihan:\n${holdings}\n\n_Simulasi edukasi fiktif; bukan nasihat investasi dan tidak terhubung ke pasar nyata._`)
    }
    if (command === 'invest') {
        const sub = String(args[0] || '').toLowerCase()
        if (sub === 'harga') return send(ctx, `📊 *HARGA SIMULASI*\nToken XRY: Rp${formatMoney(ctx, stableDailyPrice())}/unit\n\nHarga diperbarui berdasarkan tanggal harian permainan, bukan bursa.`)
        if (sub === 'beli' || sub === 'jual') {
            const units = parseCount(args[1], 1)
            if (!Number.isSafeInteger(units)) return send(ctx, `Cara pakai: ${ctx.prefix}invest ${sub} <jumlah-token>`)
            if (sub === 'beli') {
                const cost = units * stableDailyPrice()
                if (money(ctx) < cost) return send(ctx, `Saldo virtual kurang. Butuh Rp${formatMoney(ctx, cost)}.`)
                addMoney(ctx, -cost)
                user.crypto = Math.max(0, Number(user.crypto || 0)) + units
            } else {
                if (Number(user.crypto || 0) < units) return send(ctx, `Token tidak cukup. Token kamu: ${user.crypto || 0}.`)
                user.crypto -= units
                addMoney(ctx, units * stableDailyPrice())
            }
            save(ctx)
            return send(ctx, `✅ Transaksi simulasi ${sub} ${units} token selesai.\nToken saat ini: ${user.crypto}\nSaldo virtual: Rp${formatMoney(ctx, money(ctx))}\nGunakan ${ctx.prefix}portofolio untuk ringkasan.`)
        }
        return send(ctx, `📈 *INVESTASI LATIHAN*\n\n${ctx.prefix}invest harga — cek harga simulasi\n${ctx.prefix}invest beli <jumlah-token>\n${ctx.prefix}invest jual <jumlah-token>\n${ctx.prefix}portofolio\n\n_Hanya saldo virtual; bukan rekomendasi investasi._`)
    }
    const now = Date.now()
    const left = cooldownLeft(user, 'blackInvestAt', now)
    if (left > 0) return send(ctx, `⏳ Sesi simulasi sudah dipakai. Coba lagi dalam ${durationText(left)}.`)
    user.blackInvestAt = now + COOLDOWNS.blackinvest
    const day = dateKey()
    const seed = day.split('-').reduce((acc, part) => acc + Number(part), 0)
    const change = (seed % 3) - 1
    const points = Math.max(0, Number(user.blackInvestPoints || 0) + change * 10)
    user.blackInvestPoints = points
    user.blackInvestDay = day
    save(ctx)
    const result = change > 0 ? '+10 poin latihan' : change < 0 ? '-10 poin latihan' : '0 poin latihan'
    return send(ctx, `🧪 *SIMULATOR PASAR GELAP — MODE LATIHAN*\n\nPerubahan poin hari ini: ${result}\nTotal poin simulasi: ${points}\n\nTidak ada aset atau saldo virtual yang dipertaruhkan; ini hanya simulasi edukasi dengan poin latihan.`)
}
async function handleBalapan(ctx, user) {
    if (!joinedRpg(ctx, user)) return true
    const left = cooldownLeft(user, 'balapanAt')
    if (left > 0) return send(ctx, `🏁 Balapan RPG cooldown ${durationText(left)} lagi.`)
    if (Number(user.stamina || 0) < 10) return send(ctx, '⚡ Stamina minimal 10% diperlukan. Istirahat dulu di dalam RPG.')
    user.balapanAt = Date.now() + COOLDOWNS.balapan
    user.stamina = Math.max(0, Number(user.stamina || 0) - 10)
    const won = Math.random() < 0.65
    if (won) {
        const reward = randInt(1000, 2500)
        addMoney(ctx, reward)
        save(ctx)
        return send(ctx, `🏁 *BALAPAN RPG*\n\nHasil: Kamu finis di posisi teratas!\nHadiah saldo virtual: Rp${formatMoney(ctx, reward)}\nStamina: ${user.stamina}%\nCooldown: 15 menit\n\n_Simulasi balapan ini tidak mengarahkan pengguna untuk balapan di jalan raya._`)
    }
    save(ctx)
    return send(ctx, `🏁 *BALAPAN RPG*\n\nKali ini kamu belum menang. Coba lagi setelah cooldown.\nStamina: ${user.stamina}%\nTidak ada saldo yang hilang.`)
}
async function handleNyawit(ctx, user) {
    if (!joinedRpg(ctx, user)) return true
    const left = cooldownLeft(user, 'nyawitAt')
    if (left > 0) return send(ctx, `🌴 Kebun virtual masih tumbuh. Coba lagi dalam ${durationText(left)}.`)
    user.nyawitAt = Date.now() + COOLDOWNS.nyawit
    const qty = randInt(2, 6) + (user.classRpg === 'petani' ? 2 : 0)
    user.sawit = Math.max(0, Number(user.sawit || 0)) + qty
    save(ctx)
    return send(ctx, `🌴 *KEBUN SAWIT VIRTUAL*\n\nPanen: ${qty} tandan virtual\nTotal simpanan: ${user.sawit} tandan\nCooldown: 30 menit\n\nIni hanya mini-game perkebunan di dalam bot.`)
}
async function handleBattle(ctx, user) {
    if (!joinedRpg(ctx, user)) return true
    const left = cooldownLeft(user, 'battleAt')
    if (left > 0) return send(ctx, `⚔️ Tantangan RPG cooldown ${durationText(left)} lagi.`)
    user.battleAt = Date.now() + COOLDOWNS.battle
    const success = Math.random() < 0.6
    if (success) {
        const reward = randInt(900, 1900)
        addMoney(ctx, reward)
        user.stamina = Math.max(0, Number(user.stamina || 0) - 5)
        save(ctx)
        return send(ctx, `⚔️ *BATTLE RPG*\n\nKamu memenangkan tantangan fantasi non-grafis.\nReward saldo virtual: Rp${formatMoney(ctx, reward)}\nStamina tersisa: ${user.stamina}%`)
    }
    user.stamina = Math.max(0, Number(user.stamina || 0) - 5)
    save(ctx)
    return send(ctx, `⚔️ *BATTLE RPG*\n\nKamu belum menang pada ronde ini. Tidak ada saldo yang dipotong.\nStamina tersisa: ${user.stamina}%`)
}
async function handleSoulmate(ctx, args) {
    const raw = String(ctx.text || '').trim()
    const pairText = raw.includes('|') ? raw.split('|').map(value => safeText(value, 40)).filter(Boolean) : []
    const mentioned = Array.isArray(ctx.m.mentionedJid)
        ? ctx.m.mentionedJid.map(jid => String(jid || '').replace(/:\d+(?=@)/, '')).filter(Boolean)
        : []
    const quoted = String(ctx.m.quoted?.sender || ctx.m.quoted?.participant || '').replace(/:\d+(?=@)/, '')

    // Prefer actual WhatsApp mention metadata over the @number text. This avoids
    // showing literal IDs in the names row when the command contains a pipe.
    let pair = mentioned.slice(0, 2)
    if (pair.length < 2 && mentioned.length === 1 && !pairText.length) {
        pair = [ctx.m.sender, mentioned[0]]
    } else if (pair.length < 2 && quoted && !pairText.length) {
        pair = [ctx.m.sender, quoted]
    }

    if (pair.length < 2 && pairText.length >= 2 && mentioned.length === 0) {
        const first = pairText[0]
        const second = pairText.slice(1).join(' | ')
        return send(ctx, `🤝 *SOULMATE TEAM CHECK*\n\n${first} + ${second}\n\nPasangan tim random untuk tantangan dan kerja sama.`)
    }
    if (pair.length < 2) {
        return send(ctx, `Contoh: ${ctx.prefix}soulmate nama1 | nama2 atau tag dua anggota grup.`)
    }

    const senderJid = String(ctx.m.sender || '').replace(/:\d+(?=@)/, '')
    const names = await Promise.all(pair.map(async jid => {
        if (String(jid).replace(/:\d+(?=@)/, '') === senderJid) {
            const senderName = safeText(ctx.m.pushName || '', 40)
            if (senderName && !/^\+?[0-9 .()-]+$/.test(senderName)) return senderName
        }
        try {
            const resolved = safeText(await ctx.conn.getName(jid), 40)
            return resolved && !/^\+?[0-9 .()-]+$/.test(resolved) ? resolved : 'Anggota'
        } catch {
            return 'Anggota'
        }
    }))
    const mentionTokens = pair.map(jid => {
        const local = String(jid).split('@')[0].split(':')[0]
        return /^[1-9]\d{4,15}$/.test(local) ? `@${local}` : ''
    })
    const mentionLine = mentionTokens.every(Boolean) ? `\n\n🎯 Mention: ${mentionTokens[0]} + ${mentionTokens[1]}` : ''
    return send(ctx, `🤝 *SOULMATE TEAM CHECK*\n\nNama: ${names[0]} & ${names[1]}${mentionLine}\n\nKalian dipilih sebagai duo random untuk bermain atau bekerja sama!`, { mentions: pair })
}
function normalizeFitnahJid(value) {
    const raw = String(value || '').trim().replace(/:\d+(?=@)/, '')
    if (/^\d{1,20}@(s\.whatsapp\.net|c\.us|lid)$/i.test(raw)) return raw
    if (/^\+?[\d\s().-]+$/.test(raw)) {
        const digits = raw.replace(/\D/g, '')
        if (/^\d{8,16}$/.test(digits)) return `${digits}@s.whatsapp.net`
    }
    return ''
}

function fitnahMentionJids(ctx) {
    const values = Array.isArray(ctx?.m?.mentionedJid) ? ctx.m.mentionedJid : []
    return values.map(normalizeFitnahJid).filter(Boolean)
}

function resolveFitnahTarget(ctx, targetField, precedingFields) {
    const targetText = String(targetField || '').trim()
    const mentions = fitnahMentionJids(ctx)
    const targetMentionTokens = [...targetText.matchAll(/@([1-9]\d{4,15})(?!\d)/g)]

    // Bila field target berisi mention WhatsApp, gunakan JID asli dari metadata.
    // Ini penting karena akun/group baru dapat memakai @lid, sementara teks yang
    // tampak di command masih memuat nomor PN. Jangan membuat JID baru dari teks.
    if (targetMentionTokens.length) {
        if (mentions.length) {
            const precedingMentionCount = [...String(precedingFields || '').matchAll(/@([1-9]\d{4,15})(?!\d)/g)].length
            const mentionIndex = precedingMentionCount + targetMentionTokens.length - 1
            if (mentions[mentionIndex]) return mentions[mentionIndex]

            const targetDigits = targetMentionTokens[targetMentionTokens.length - 1][1]
            const exact = mentions.filter(jid => jid.split('@')[0] === targetDigits)
            if (exact.length) return exact[exact.length - 1]
            // Jika hanya satu mention tersedia, metadata itulah identitas yang
            // dapat dipercaya meskipun teks mention menggunakan nomor alternatif.
            if (mentions.length === 1) return mentions[0]
        }
        const digits = targetMentionTokens[targetMentionTokens.length - 1][1]
        return normalizeFitnahJid(digits)
    }

    // Tetap mendukung format nomor yang diketik manual, seperti versi Furina.
    if (/^\+?[\d\s().-]+$/.test(targetText)) {
        const digits = targetText.replace(/\D/g, '')
        const jid = normalizeFitnahJid(digits)
        if (jid) return jid
    }

    // Jika client menampilkan nama kontak pada teks command (bukan @nomor),
    // nomor/JID yang sebenarnya tetap diambil dari metadata mention WhatsApp.
    if (mentions.length) return mentions[mentions.length - 1]
    return ''
}

function resolveFitnahGroupIdentity(ctx, requestedTarget) {
    if (!ctx?.m?.isGroup || !Array.isArray(ctx?.m?.metadata?.participants)) {
        return { target: requestedTarget, participantAlt: '' }
    }

    const fields = participant => [participant?.id, participant?.jid, participant?.lid, participant?.phoneNumber]
        .map(normalizeFitnahJid)
        .filter(Boolean)
    const found = ctx.m.metadata.participants.find(participant => fields(participant).includes(requestedTarget))
    if (!found) return { target: requestedTarget, participantAlt: '' }

    const aliases = fields(found)
    // Pada grup yang memakai LID, mention harus memakai identitas peserta di
    // grup (@lid), bukan sekadar PN dari teks mention. PN disimpan sebagai alias.
    const lid = aliases.find(jid => jid.endsWith('@lid'))
    const primary = lid || normalizeFitnahJid(found.id) || normalizeFitnahJid(found.jid) || requestedTarget
    const primaryDomain = primary.split('@').pop()
    const participantAlt = aliases.find(jid => jid !== primary && jid.split('@').pop() !== primaryDomain) || ''
    return { target: primary, participantAlt }
}

async function handleFitnah(ctx) {
    // Format dan perilaku quoted-message mengikuti Furina V18, tetapi target
    // diambil dari metadata mention agar identitas kontak/LID tidak berubah.
    const usage = `Example : ${ctx.prefix}fitnah pesan target|pesan mu|nomor/tag target`
    const raw = String(ctx.text || '').trim()
    if (!raw) return send(ctx, usage)

    const parts = raw.split('|')
    if (parts.length < 3) return send(ctx, usage)
    const [teks1, teks2, ...targetParts] = parts
    const teks3 = targetParts.join('|').trim()
    const targetMessage = String(teks1 || '').trim()
    const replyMessage = String(teks2 || '').trim()
    if (!targetMessage || !replyMessage || !teks3) return send(ctx, usage)

    const requestedTarget = resolveFitnahTarget(ctx, teks3, `${teks1}|${teks2}`)
    if (!requestedTarget) return send(ctx, `Tag orang di bagian terakhir atau masukkan nomor WhatsApp yang valid.\n\n${usage}`)
    const { target, participantAlt } = resolveFitnahGroupIdentity(ctx, requestedTarget)

    const fakeQuoted = {
        key: {
            fromMe: false,
            participant: target,
            ...(participantAlt ? { participantAlt } : {}),
            ...(ctx.m.isGroup ? { remoteJid: ctx.m.chat } : { remoteJid: target })
        },
        message: {
            conversation: targetMessage
        }
    }

    await ctx.conn.sendMessage(ctx.m.chat, { text: replyMessage }, { quoted: fakeQuoted })
}

function scoreDisplayName(command) {
    const labels = {
        stupidcheck: 'STUPID CHECK', handsomecheck: 'HANDSOME CHECK', uncleancheck: 'UNCLEAN CHECK',
        hotcheck: 'HOT CHECK', smartcheck: 'SMART CHECK', greatcheck: 'GREAT CHECK',
        evilcheck: 'EVIL CHECK', dogcheck: 'DOG CHECK', coolcheck: 'COOL CHECK',
        waifucheck: 'WAIFU CHECK', awesomecheck: 'AWESOME CHECK', cutecheck: 'CUTE CHECK',
        prettycheck: 'PRETTY CHECK', lovelycheck: 'LOVELY CHECK', uglycheck: 'UGLY CHECK',
        gaycheck: 'GAYCHECK', lesbiancheck: 'LESBIAN CHECK', lesbicheck: 'LESBI CHECK',
        hornycheck: 'HORNY CHECK'
    }
    return labels[command] || String(command || 'FUN CHECK').replace(/check/ig, ' CHECK').replace(/[-_]+/g, ' ').toUpperCase()
}

function makeScoreCard(command, subject, score, detail = '') {
    const title = scoreDisplayName(command)
    const label = safeText(subject || 'Kamu', 100) || 'Kamu'
    const resultNote = score >= 80
        ? 'Skor random tinggi. ✨'
        : score >= 50
            ? 'Skor random berada di tengah. 🎲'
            : 'Skor random rendah. 🌱'
    // Plain WhatsApp-friendly copy: no box drawing and no repeated disclaimer.
    if (FURINA_GROUP_PERCENT_CHECKS.has(command)) {
        return `🎲 *${title}*

👤 Target: ${label}
📊 Hasil: *${score}%*
✨ ${resultNote}`
    }
    return `🎲 *${title}*

👤 Nama: ${label}
📊 Hasil: *${score}%*
✨ ${resultNote}`
}

async function handleScore(ctx, command, args) {
    const m = ctx.m
    const score = randInt(1, 100)
    const tagged = Array.isArray(m.mentionedJid) ? m.mentionedJid.filter(Boolean) : []
    const quotedSender = m.quoted?.sender || m.quoted?.participant || ''
    // Only an explicit mention/reply makes a user the target. Otherwise use the
    // supplied name or sender display name; never treat a sender JID as a name.
    const targetJid = tagged[0] || quotedSender || ''
    const canonicalTarget = String(targetJid || '').replace(/:\d+(?=@)/, '')
    const targetLocalId = canonicalTarget.split('@')[0].split(':')[0]
    const targetToken = /^[1-9]\d{4,15}$/.test(targetLocalId) ? `@${targetLocalId}` : ''
    const mentions = targetJid ? [canonicalTarget] : []
    const inputText = String(ctx.text || args.join(' ') || '')
    const cleanInput = safeText(inputText.replace(/@[1-9]\d{4,15}/g, ''), 100)
    const pushName = safeText(m.pushName || 'Kamu', 100) || 'Kamu'
    let targetName = 'Anggota'
    if (targetJid && typeof ctx.conn?.getName === 'function') {
        try {
            const resolved = safeText(await ctx.conn.getName(canonicalTarget), 100)
            if (resolved && !/^\+?[0-9 .()-]+$/.test(resolved)) targetName = resolved
        } catch {}
    }
    const makeReply = (subject) => {
        const card = makeScoreCard(command, subject, score)
        // Keep a separate native @mention token so WhatsApp can render it as a
        // tappable mention, while the visible subject line uses the contact name.
        return targetJid && targetToken ? `${card}\n\n🎯 Mention: ${targetToken}` : card
    }

    if (FURINA_GROUP_PERCENT_CHECKS.has(command)) {
        if (!m.isGroup) return send(ctx, '🔒 Perintah ini digunakan di grup.')
        return send(ctx, makeReply(targetJid ? targetName : (cleanInput || pushName)), { mentions })
    }

    if (FURINA_BARE_PERCENT_CHECKS.has(command)) {
        return send(ctx, makeReply(targetJid ? targetName : (cleanInput || pushName)), { mentions })
    }

    if (command === 'handsomecheck') {
        if (!cleanInput && !targetJid) {
            return send(ctx, `Tag/reply seseorang atau tulis nama. Contoh: ${ctx.prefix || '.'}${command} @nomor`)
        }
        return send(ctx, makeReply(targetJid ? targetName : cleanInput), { mentions })
    }

    return send(ctx, makeReply(targetJid ? targetName : (cleanInput || pushName)), { mentions })
}
async function handleQuestion(ctx, command, args) {
    const input = safeText(args.join(' '), 180)
    if (!input) return send(ctx, `Masukkan pertanyaan. Contoh: ${ctx.prefix}${command} aku bisa belajar hal baru?`)
    const answerSets = {
        can: ['Bisa, mulai dari langkah kecil.', 'Mungkin bisa; rencanakan dan latihan.', 'Tergantung situasinya, coba evaluasi dulu.'],
        is: ['Bisa jadi, tapi cek faktanya dulu.', 'Belum cukup informasi untuk memastikan.', 'Mungkin; cari bukti yang relevan.'],
        when: ['Saat kamu siap dan kesempatannya tepat.', 'Mulai dari langkah kecil hari ini.', 'Belum bisa dipastikan.'],
        where: ['Tempat paling tepat adalah yang aman dan sesuai kebutuhanmu.', 'Cek sumber informasi resmi atau tanyakan orang tepercaya.'],
        what: ['Mulai dari hal paling penting dan jelas.', 'Cari informasi, bandingkan fakta, lalu putuskan.'],
        how: ['Pecah menjadi beberapa langkah kecil.', 'Pelajari dasarnya lalu praktik dengan aman.', 'Minta bantuan orang tepercaya bila diperlukan.']
    }
    const answer = answerSets[command] || answerSets.can
    return send(ctx, `🎲 *${command.toUpperCase()}*\n\n${input}\n\n💬 ${answer[randInt(0, answer.length - 1)]}\n\n_Hanya jawaban random untuk hiburan._`)
}
// ---------------------------------------------------------------------------
// Restored arcade handlers. Every balance here is Xeryuu's in-bot virtual
// balance; these commands never create, request, or settle real-money payments.
// ---------------------------------------------------------------------------
const ACTIVE_LOTTERIES = new Map()
const ACTIVE_HILO_GAMES = new Map()
const ACTIVE_RR_GAMES = new Map()
const ACTIVE_BOMB_PUZZLES = new Map()
const ARCADE_COMMANDS = new Set(['lotre', 'poker3', 'hilo', 'rr', 'sabung', 'bomb', 'heist', 'begal'])
const MAX_VIRTUAL_STAKE = 50000
const LOTTERY_DURATION_MS = 5 * 60 * 1000

function arcadeStore() {
    const db = global.db || (global.db = {})
    if (!db.xeryuuArcade || typeof db.xeryuuArcade !== 'object' || Array.isArray(db.xeryuuArcade)) {
        db.xeryuuArcade = { lotteries: {}, hilo: {}, rr: {}, bombs: {} }
    }
    for (const name of ['lotteries', 'hilo', 'rr', 'bombs']) {
        if (!db.xeryuuArcade[name] || typeof db.xeryuuArcade[name] !== 'object' || Array.isArray(db.xeryuuArcade[name])) {
            db.xeryuuArcade[name] = {}
        }
    }
    return db.xeryuuArcade
}
function persistArcadeGame(ctx, section, key, game) {
    const snapshot = { ...game }
    delete snapshot.timer
    delete snapshot.ctx
    if (snapshot.selected instanceof Set) snapshot.selected = Array.from(snapshot.selected)
    arcadeStore()[section][key] = JSON.parse(JSON.stringify(snapshot))
}
function deleteArcadeGame(ctx, section, key) {
    delete arcadeStore()[section][key]
}
function loadArcadeGame(section, key, map) {
    const active = map.get(key)
    if (active) return active
    const stored = arcadeStore()[section][key]
    if (!stored) return null
    const restored = { ...stored }
    if (section === 'bombs') restored.selected = new Set(Array.isArray(restored.selected) ? restored.selected : [])
    map.set(key, restored)
    return restored
}

function arcadeIsGroup(ctx) {
    return Boolean(ctx.m?.isGroup || String(ctx.m?.chat || '').endsWith('@g.us'))
}
function arcadeBalance(ctx, jid = ctx.m.sender) {
    return Math.max(0, Number(ctx.economy?.getBalance?.(jid) || 0))
}
function arcadeAddBalance(ctx, jid, delta) {
    if (typeof ctx.economy?.addMoney !== 'function') throw new Error('API saldo virtual tidak tersedia.')
    const amount = Math.round(Number(delta) || 0)
    if (amount < 0 && arcadeBalance(ctx, jid) < Math.abs(amount)) throw new Error('Saldo virtual tidak mencukupi.')
    ctx.economy.addMoney(jid, amount)
}
function arcadeMoney(ctx, amount) {
    return ctx.economy?.formatMoney ? ctx.economy.formatMoney(Math.round(amount)) : Math.round(amount).toLocaleString('id-ID')
}
function parseVirtualStake(raw, min = 100, max = MAX_VIRTUAL_STAKE) {
    const cleaned = String(raw ?? '').trim().replace(/^(rp|idr)\s*/i, '').replace(/[.\s,]/g, '')
    if (!/^\d+$/.test(cleaned)) return null
    const value = Number(cleaned)
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null
}
function arcadeKey(ctx) { return String(ctx.m?.chat || ctx.m?.sender || 'unknown') }
function arcadeSave(ctx) {
    try { if (typeof ctx.saveGlobalDb === 'function') ctx.saveGlobalDb() } catch (error) {
        console.error('[XERYUU ARCADE SAVE]', error?.message || error)
    }
}
function arcadeHelp(ctx, game, text) {
    return send(ctx, `🎮 *${game.toUpperCase()}*

${text}

_Semua saldo dan hadiah di sini bersifat virtual di dalam bot._`)
}
function buildCardDeck() {
    const suits = ['♣️', '♦️', '♠️', '♥️']
    const values = [
        { name: '2', value: 2 }, { name: '3', value: 3 }, { name: '4', value: 4 },
        { name: '5', value: 5 }, { name: '6', value: 6 }, { name: '7', value: 7 },
        { name: '8', value: 8 }, { name: '9', value: 9 }, { name: '10', value: 10 },
        { name: 'J', value: 11 }, { name: 'Q', value: 12 }, { name: 'K', value: 13 }, { name: 'A', value: 14 }
    ]
    const deck = suits.flatMap(suit => values.map(card => ({ ...card, suit, label: `${card.name}${suit}` })))
    for (let i = deck.length - 1; i > 0; i--) {
        const j = randInt(0, i)
        ;[deck[i], deck[j]] = [deck[j], deck[i]]
    }
    return deck
}
function evaluateThreeCardHand(hand) {
    const values = hand.map(card => card.value).sort((a, b) => b - a)
    const sameSuit = hand.every(card => card.suit === hand[0].suit)
    const counts = new Map()
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
    const groups = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])
    const isLowAceStraight = values[0] === 14 && values[1] === 3 && values[2] === 2
    const isStraight = isLowAceStraight || (values[0] - values[1] === 1 && values[1] - values[2] === 1)
    const straightHigh = isLowAceStraight ? 3 : values[0]
    let rank = 1
    let tiebreak = values
    let name = 'High Card'
    let multiplier = 1.5
    if (sameSuit && isStraight) { rank = 6; name = 'Straight Flush'; tiebreak = [straightHigh]; multiplier = 50 }
    else if (groups[0][1] === 3) { rank = 5; name = 'Three of a Kind'; tiebreak = [groups[0][0]]; multiplier = 35 }
    else if (isStraight) { rank = 4; name = 'Straight'; tiebreak = [straightHigh]; multiplier = 8 }
    else if (sameSuit) { rank = 3; name = 'Flush'; tiebreak = values; multiplier = 5 }
    else if (groups[0][1] === 2) { rank = 2; name = 'Pair'; tiebreak = [groups[0][0], groups[1][0]]; multiplier = 2 }
    const score = rank * 1000000 + (tiebreak[0] || 0) * 10000 + (tiebreak[1] || 0) * 100 + (tiebreak[2] || 0)
    return { rank, name, multiplier, score }
}

function scheduleLotteryDraw(ctx, chat, game) {
    if (game.timer) clearTimeout(game.timer)
    const remaining = Math.max(0, Number(game.openedAt || Date.now()) + LOTTERY_DURATION_MS - Date.now())
    game.timer = setTimeout(async () => {
        const active = ACTIVE_LOTTERIES.get(chat)
        if (active !== game || active.status !== 'open') return
        if (!active.tickets.length) {
            ACTIVE_LOTTERIES.delete(chat)
            deleteArcadeGame(ctx, 'lotteries', chat)
            arcadeSave(ctx)
            try { await sendChatReply(ctx, chat, '🎟️ Lotre ditutup karena tidak ada peserta. Tidak ada saldo yang dipotong.') } catch {}
            return
        }
        const winner = active.tickets[randInt(0, active.tickets.length - 1)]
        try {
            ctx.economy.addMoney(winner.jid, active.pool)
            active.status = 'closed'
            ACTIVE_LOTTERIES.delete(chat)
            deleteArcadeGame(ctx, 'lotteries', chat)
            arcadeSave(ctx)
            await sendChatReply(ctx, chat,
                `🎉 *LOTRE SELESAI*\n\nPemenang: @${winner.jid.split('@')[0]}\nTiket diundi: ${active.tickets.length}\nHadiah saldo virtual: Rp${arcadeMoney(ctx, active.pool)}`,
                { mentions: [winner.jid] }
            )
        } catch (error) {
            console.error('[XERYUU LOTRE SETTLE]', error?.stack || error)
            active.status = 'settlement_failed'
            active.timer = null
            persistArcadeGame(ctx, 'lotteries', chat, active)
            arcadeSave(ctx)
            try { await sendChatReply(ctx, chat, '❌ Lotre selesai, tetapi hadiah belum berhasil dicatat. Tiket tetap tersimpan; owner perlu memeriksa saldo virtual.') } catch {}
        }
    }, remaining)
    if (typeof game.timer.unref === 'function') game.timer.unref()
}
function restoreLotteryTimers(ctx) {
    const storedLotteries = arcadeStore().lotteries
    for (const [chat, saved] of Object.entries(storedLotteries)) {
        if (!saved || saved.status !== 'open' || ACTIVE_LOTTERIES.has(chat)) continue
        const game = { ...saved, timer: null }
        ACTIVE_LOTTERIES.set(chat, game)
        scheduleLotteryDraw(ctx, chat, game)
    }
}
async function handleLottery(ctx, args) {
    if (!arcadeIsGroup(ctx)) return send(ctx, '🎟️ Lotre grup hanya dapat digunakan di grup.')
    restoreLotteryTimers(ctx)
    const chat = arcadeKey(ctx)
    const action = String(args[0] || '').toLowerCase()
    let game = ACTIVE_LOTTERIES.get(chat) || loadArcadeGame('lotteries', chat, ACTIVE_LOTTERIES)
    if (action === 'open' || action === 'buka') {
        if (!(ctx.isAdmin || ctx.isOwner)) return send(ctx, '❌ Membuka atau membatalkan lotre hanya untuk admin grup/owner.')
        if (game?.status === 'open') return send(ctx, '🎟️ Lotre grup sedang berlangsung. Gunakan .lotre status.')
        const price = args[1] == null ? 5000 : parseVirtualStake(args[1], 100, MAX_VIRTUAL_STAKE)
        if (!price) return send(ctx, `Harga tiket harus 100–${arcadeMoney(ctx, MAX_VIRTUAL_STAKE)} saldo virtual. Contoh: .lotre open 5000`)
        game = { status: 'open', chat, ticketPrice: price, pool: 0, tickets: [], timer: null, openedAt: Date.now() }
        ACTIVE_LOTTERIES.set(chat, game)
        persistArcadeGame(ctx, 'lotteries', chat, game)
        arcadeSave(ctx)
        scheduleLotteryDraw(ctx, chat, game)
        return send(ctx, `🎟️ *LOTRE DIBUKA*\n\nHarga tiket: Rp${arcadeMoney(ctx, price)} saldo virtual\nDurasi: 5 menit\n\nGabung: .lotre buy <jumlah>\nCek: .lotre status\nLotre akan otomatis diundi setelah waktunya selesai.`)
    }
    if (action === 'buy' || action === 'beli') {
        if (!game || game.status !== 'open') return send(ctx, '🎟️ Tidak ada lotre aktif. Admin grup dapat membuka dengan .lotre open <harga>.')
        const count = Number(args[1] || 1)
        if (!Number.isSafeInteger(count) || count < 1 || count > 20) return send(ctx, 'Jumlah tiket harus 1–20 per transaksi.')
        const previousCount = game.tickets.filter(ticket => ticket.jid === ctx.m.sender).length
        if (previousCount + count > 50 || game.tickets.length + count > 500) return send(ctx, 'Batas tiket tercapai (50 per pengguna, 500 per lotre).')
        const total = game.ticketPrice * count
        if (arcadeBalance(ctx) < total) return send(ctx, `Saldo virtual tidak cukup. Dibutuhkan Rp${arcadeMoney(ctx, total)}.`)
        arcadeAddBalance(ctx, ctx.m.sender, -total)
        for (let i = 0; i < count; i++) game.tickets.push({ jid: ctx.m.sender, name: ctx.m.pushName || '' })
        game.pool += total
        persistArcadeGame(ctx, 'lotteries', chat, game)
        arcadeSave(ctx)
        const userTickets = game.tickets.filter(ticket => ticket.jid === ctx.m.sender).length
        return send(ctx, `✅ *TIKET LOTRE DIBELI*\n\nTiket kamu: ${userTickets}\nTotal tiket: ${game.tickets.length}\nPool hadiah virtual: Rp${arcadeMoney(ctx, game.pool)}\nPeluang berdasarkan tiket saat ini: ${(userTickets / game.tickets.length * 100).toFixed(1)}%`)
    }
    if (action === 'status') {
        if (!game || game.status !== 'open') return send(ctx, '🎟️ Lotre sedang tidak aktif.')
        return send(ctx, `🎟️ *STATUS LOTRE*\n\nHarga tiket: Rp${arcadeMoney(ctx, game.ticketPrice)}\nTiket terjual: ${game.tickets.length}\nHadiah virtual terkumpul: Rp${arcadeMoney(ctx, game.pool)}\nBerakhir sekitar ${Math.max(1, Math.ceil((LOTTERY_DURATION_MS - (Date.now() - game.openedAt)) / 60000))} menit lagi.`)
    }
    if (action === 'cancel' || action === 'batal') {
        if (!(ctx.isAdmin || ctx.isOwner)) return send(ctx, '❌ Membuka atau membatalkan lotre hanya untuk admin grup/owner.')
        if (!game || game.status !== 'open') return send(ctx, '🎟️ Tidak ada lotre aktif untuk dibatalkan.')
        clearTimeout(game.timer)
        const refundByJid = new Map()
        for (const ticket of game.tickets) refundByJid.set(ticket.jid, (refundByJid.get(ticket.jid) || 0) + game.ticketPrice)
        for (const [jid, refund] of refundByJid) ctx.economy.addMoney(jid, refund)
        game.status = 'cancelled'
        ACTIVE_LOTTERIES.delete(chat)
        deleteArcadeGame(ctx, 'lotteries', chat)
        arcadeSave(ctx)
        return send(ctx, `🚫 Lotre dibatalkan. ${refundByJid.size} peserta menerima pengembalian saldo virtual sesuai tiket mereka.`)
    }
    return arcadeHelp(ctx, 'LOTRE GRUP', '• .lotre open <harga> — buka lotre (admin)\n• .lotre buy <jumlah> — beli tiket virtual\n• .lotre status — lihat pool dan peserta\n• .lotre cancel — batalkan dan kembalikan saldo (admin)')
}

async function handlePoker3(ctx, args) {
    const action = String(args[0] || '').toLowerCase()
    if (!['start', 'main', 'play'].includes(action)) {
        return arcadeHelp(ctx, 'POKER 3 KARTU', 'Mulai: .poker3 start <saldo-virtual>\nContoh: .poker3 start 1000\nKartu dibandingkan dengan dealer. Payout bergantung pada kombinasi kartu.')
    }
    const stake = parseVirtualStake(args[1], 100, MAX_VIRTUAL_STAKE)
    if (!stake) return send(ctx, `Jumlah saldo virtual harus 100–${arcadeMoney(ctx, MAX_VIRTUAL_STAKE)}. Contoh: .poker3 start 1000`)
    if (arcadeBalance(ctx) < stake) return send(ctx, 'Saldo virtual tidak cukup untuk permainan ini.')
    arcadeAddBalance(ctx, ctx.m.sender, -stake)
    const deck = buildCardDeck()
    const player = deck.splice(0, 3)
    const dealer = deck.splice(0, 3)
    const playerRank = evaluateThreeCardHand(player)
    const dealerRank = evaluateThreeCardHand(dealer)
    let payout = 0
    let result
    if (playerRank.score > dealerRank.score) {
        payout = Math.floor(stake * playerRank.multiplier)
        result = 'MENANG'
    } else if (playerRank.score === dealerRank.score) {
        payout = stake
        result = 'SERI — saldo virtual dikembalikan'
    } else result = 'KALAH'
    if (payout) arcadeAddBalance(ctx, ctx.m.sender, payout)
    arcadeSave(ctx)
    return send(ctx, `🃏 *POKER 3 KARTU*\n\nKartu kamu: ${player.map(card => card.label).join(' ')}\nKombinasi: ${playerRank.name}\n\nKartu dealer: ${dealer.map(card => card.label).join(' ')}\nKombinasi dealer: ${dealerRank.name}\n\nHasil: *${result}*\nPayout: Rp${arcadeMoney(ctx, payout)} saldo virtual\nSaldo sekarang: Rp${arcadeMoney(ctx, arcadeBalance(ctx))}`)
}

async function handleHiLo(ctx, args) {
    const key = arcadeKey(ctx)
    const action = String(args[0] || '').toLowerCase()
    let game = ACTIVE_HILO_GAMES.get(key) || loadArcadeGame('hilo', key, ACTIVE_HILO_GAMES)
    if (['start', 'mulai'].includes(action) || (!game && args[0] && /^\d+$/.test(args[0]))) {
        if (game) return send(ctx, '📈 Selesaikan sesi Hi-Lo yang aktif dengan .hilo high/low atau .hilo take.')
        const stake = parseVirtualStake(args[action === 'start' || action === 'mulai' ? 1 : 0], 100, MAX_VIRTUAL_STAKE)
        if (!stake) return send(ctx, `Mulai dengan .hilo start <saldo-virtual>, minimal 100 dan maksimal ${arcadeMoney(ctx, MAX_VIRTUAL_STAKE)}.`)
        if (arcadeBalance(ctx) < stake) return send(ctx, 'Saldo virtual tidak cukup.')
        arcadeAddBalance(ctx, ctx.m.sender, -stake)
        const deck = buildCardDeck()
        game = { jid: ctx.m.sender, stake, deck, current: deck.pop(), streak: 0, multiplier: 1, startedAt: Date.now() }
        ACTIVE_HILO_GAMES.set(key, game)
        persistArcadeGame(ctx, 'hilo', key, game)
        arcadeSave(ctx)
        return send(ctx, `📈 *HI-LO DIMULAI*\n\nKartu saat ini: ${game.current.label}\nSaldo virtual: Rp${arcadeMoney(ctx, stake)}\n\nTebak kartu berikutnya: .hilo high atau .hilo low\nAmbil hasil saat siap: .hilo take`)
    }
    if (!game) return arcadeHelp(ctx, 'HI-LO', '• .hilo start <saldo-virtual>\n• .hilo high atau .hilo low — tebak kartu berikutnya\n• .hilo take — ambil payout saldo virtual')
    if (game.jid !== ctx.m.sender) return send(ctx, '📈 Sesi Hi-Lo ini dimulai pengguna lain. Tunggu hingga selesai.')
    if (action === 'take' || action === 'ambil') {
        const payout = game.streak === 0 ? game.stake : Math.floor(game.stake * game.multiplier)
        arcadeAddBalance(ctx, ctx.m.sender, payout)
        ACTIVE_HILO_GAMES.delete(key)
        deleteArcadeGame(ctx, 'hilo', key)
        arcadeSave(ctx)
        return send(ctx, `💰 *HI-LO SELESAI*\n\nTebakan benar: ${game.streak}\nMultiplier: ${game.multiplier.toFixed(2)}x\nSaldo virtual dikembalikan: Rp${arcadeMoney(ctx, payout)}\nSaldo sekarang: Rp${arcadeMoney(ctx, arcadeBalance(ctx))}`)
    }
    if (action === 'cancel' || action === 'batal') {
        arcadeAddBalance(ctx, ctx.m.sender, game.stake)
        ACTIVE_HILO_GAMES.delete(key)
        deleteArcadeGame(ctx, 'hilo', key)
        arcadeSave(ctx)
        return send(ctx, `Sesi Hi-Lo dibatalkan. Saldo virtual awal Rp${arcadeMoney(ctx, game.stake)} dikembalikan.`)
    }
    if (!['high', 'low', 'tinggi', 'rendah'].includes(action)) return send(ctx, 'Gunakan .hilo high, .hilo low, .hilo take, atau .hilo cancel.')
    const choice = ['high', 'tinggi'].includes(action) ? 'high' : 'low'
    if (game.deck.length < 1) game.deck = buildCardDeck()
    const next = game.deck.pop()
    const correct = choice === 'high' ? next.value > game.current.value : next.value < game.current.value
    if (next.value === game.current.value) {
        arcadeAddBalance(ctx, ctx.m.sender, game.stake)
        ACTIVE_HILO_GAMES.delete(key)
        deleteArcadeGame(ctx, 'hilo', key)
        arcadeSave(ctx)
        return send(ctx, `🤝 Kartu sama (${next.label}). Hasil seri; saldo virtual awal Rp${arcadeMoney(ctx, game.stake)} dikembalikan.`)
    }
    if (!correct) {
        ACTIVE_HILO_GAMES.delete(key)
        deleteArcadeGame(ctx, 'hilo', key)
        arcadeSave(ctx)
        return send(ctx, `📉 *HI-LO BERAKHIR*\n\nKartu berikutnya: ${next.label}\nTebakan tidak tepat. Saldo virtual yang digunakan: Rp${arcadeMoney(ctx, game.stake)}.`)
    }
    game.current = next
    game.streak += 1
    game.multiplier = Math.min(5, game.multiplier + Math.min(0.5, 0.15 * game.streak))
    persistArcadeGame(ctx, 'hilo', key, game)
    arcadeSave(ctx)
    return send(ctx, `✅ *TEBAKAN BENAR*\n\nKartu baru: ${next.label}\nStreak: ${game.streak}\nMultiplier saat ini: ${game.multiplier.toFixed(2)}x\nPayout jika take: Rp${arcadeMoney(ctx, Math.floor(game.stake * game.multiplier))}\n\nLanjut .hilo high/low atau ambil hasil dengan .hilo take.`)
}

async function handleRr(ctx, args) {
    const key = arcadeKey(ctx)
    const action = String(args[0] || '').toLowerCase()
    let game = ACTIVE_RR_GAMES.get(key) || loadArcadeGame('rr', key, ACTIVE_RR_GAMES)
    if (['join', 'start', 'mulai'].includes(action)) {
        if (game) return send(ctx, '🎡 Roda angka kamu masih berjalan. Gunakan .rr spin atau .rr claim.')
        const stake = parseVirtualStake(args[1], 100, MAX_VIRTUAL_STAKE)
        if (!stake) return send(ctx, `Format: .rr join <saldo-virtual>. Maksimal Rp${arcadeMoney(ctx, MAX_VIRTUAL_STAKE)}.`)
        if (arcadeBalance(ctx) < stake) return send(ctx, 'Saldo virtual tidak cukup.')
        arcadeAddBalance(ctx, ctx.m.sender, -stake)
        ACTIVE_RR_GAMES.set(key, game = { jid: ctx.m.sender, stake, safeSpins: 0, createdAt: Date.now() })
        persistArcadeGame(ctx, 'rr', key, game)
        arcadeSave(ctx)
        return send(ctx, `🎡 *RODA ANGKA DIMULAI*\n\nSaldo virtual: Rp${arcadeMoney(ctx, stake)}\nPutar: .rr spin\nAmbil payout: .rr claim\nBatalkan sebelum putaran pertama: .rr cancel\n\nPermainan ini hanya roda angka fiktif; tidak mensimulasikan senjata atau tindakan nyata.`)
    }
    if (!game) return arcadeHelp(ctx, 'RODA ANGKA (.rr)', '• .rr join <saldo-virtual>\n• .rr spin — putar roda angka\n• .rr claim — ambil payout saldo virtual\n• .rr cancel — kembalikan saldo jika belum memutar')
    if (game.jid !== ctx.m.sender) return send(ctx, '🎡 Roda angka ini sedang dimainkan pengguna lain.')
    if (['cancel', 'batal'].includes(action)) {
        if (game.safeSpins) return send(ctx, 'Roda sudah diputar; gunakan .rr claim untuk mengambil payout yang tersedia.')
        arcadeAddBalance(ctx, ctx.m.sender, game.stake)
        ACTIVE_RR_GAMES.delete(key)
        deleteArcadeGame(ctx, 'rr', key)
        arcadeSave(ctx)
        return send(ctx, `Roda dibatalkan. Saldo virtual Rp${arcadeMoney(ctx, game.stake)} dikembalikan.`)
    }
    if (['claim', 'take', 'ambil'].includes(action)) {
        if (!game.safeSpins) return send(ctx, 'Putar roda satu kali terlebih dahulu dengan .rr spin, atau .rr cancel untuk mengembalikan saldo sebelum bermain.')
        const multiplier = 1 + (game.safeSpins * 0.25)
        const payout = Math.floor(game.stake * multiplier)
        arcadeAddBalance(ctx, ctx.m.sender, payout)
        ACTIVE_RR_GAMES.delete(key)
        deleteArcadeGame(ctx, 'rr', key)
        arcadeSave(ctx)
        return send(ctx, `🎉 *PAYOUT RODA ANGKA*\nPutaran aman: ${game.safeSpins}\nMultiplier: ${multiplier.toFixed(2)}x\nPayout saldo virtual: Rp${arcadeMoney(ctx, payout)}`)
    }
    if (['spin', 'putar', 'fire'].includes(action)) {
        if (randInt(1, 6) === 1) {
            ACTIVE_RR_GAMES.delete(key)
            deleteArcadeGame(ctx, 'rr', key)
            arcadeSave(ctx)
            return send(ctx, `🎡 Roda berhenti pada zona zonk. Permainan berakhir; saldo virtual yang digunakan Rp${arcadeMoney(ctx, game.stake)}.`)
        }
        game.safeSpins += 1
        if (game.safeSpins >= 5) {
            const payout = game.stake * 3
            arcadeAddBalance(ctx, ctx.m.sender, payout)
            ACTIVE_RR_GAMES.delete(key)
            deleteArcadeGame(ctx, 'rr', key)
            arcadeSave(ctx)
            return send(ctx, `🏆 *RODA ANGKA SELESAI*\nLima putaran berhasil! Payout saldo virtual: Rp${arcadeMoney(ctx, payout)}.`)
        }
        const multiplier = 1 + game.safeSpins * 0.25
        persistArcadeGame(ctx, 'rr', key, game)
        arcadeSave(ctx)
        return send(ctx, `🎡 Putaran aman ke-${game.safeSpins}. Payout saat ini: Rp${arcadeMoney(ctx, Math.floor(game.stake * multiplier))}.\nLanjut .rr spin atau ambil hasil .rr claim.`)
    }
    return send(ctx, 'Gunakan .rr spin, .rr claim, atau .rr cancel.')
}

async function handleBombPuzzle(ctx, args) {
    const key = arcadeKey(ctx)
    const action = String(args[0] || '').toLowerCase()
    let game = ACTIVE_BOMB_PUZZLES.get(key) || loadArcadeGame('bombs', key, ACTIVE_BOMB_PUZZLES)
    if (['start', 'mulai'].includes(action)) {
        if (game) return send(ctx, '🧩 Puzzle ubin masih aktif. Pilih nomor dengan .bomb pilih <1-5>.')
        game = { jid: ctx.m.sender, trap: randInt(1, 5), selected: new Set(), startedAt: Date.now() }
        ACTIVE_BOMB_PUZZLES.set(key, game)
        persistArcadeGame(ctx, 'bombs', key, game)
        arcadeSave(ctx)
        return send(ctx, '🧩 *PUZZLE UBIN MISTERI*\n\nPilih 4 ubin aman dari nomor 1–5. Satu ubin hanya membuat ronde berakhir sebagai zonk; ini puzzle fiktif dan bukan instruksi bom sungguhan.\n\nPilih: .bomb pilih <1-5>')
    }
    if (!game) return arcadeHelp(ctx, 'PUZZLE UBIN (.bomb)', 'Mulai: .bomb start\nPilih ubin: .bomb pilih <1-5>\nAlias lama .bomb potong <1-5> juga tetap diterima.')
    if (game.jid !== ctx.m.sender) return send(ctx, '🧩 Puzzle ini sedang dimainkan pengguna lain.')
    if (['cancel', 'batal'].includes(action)) {
        ACTIVE_BOMB_PUZZLES.delete(key)
        deleteArcadeGame(ctx, 'bombs', key)
        arcadeSave(ctx)
        return send(ctx, 'Puzzle ubin dibatalkan.')
    }
    if (!['pilih', 'potong', 'pick'].includes(action)) return send(ctx, 'Pilih nomor dengan .bomb pilih <1-5>.')
    const selection = Number(args[1])
    if (!Number.isInteger(selection) || selection < 1 || selection > 5) return send(ctx, 'Nomor ubin harus 1–5.')
    if (game.selected.has(selection)) return send(ctx, 'Ubin itu sudah dipilih. Pilih nomor lain.')
    if (selection === game.trap) {
        ACTIVE_BOMB_PUZZLES.delete(key)
        deleteArcadeGame(ctx, 'bombs', key)
        arcadeSave(ctx)
        return send(ctx, `🧩 Ubin ${selection} adalah ubin zonk. Puzzle selesai, tidak ada hadiah di ronde ini.`)
    }
    game.selected.add(selection)
    if (game.selected.size === 4) {
        ACTIVE_BOMB_PUZZLES.delete(key)
        deleteArcadeGame(ctx, 'bombs', key)
        const reward = 1500
        arcadeAddBalance(ctx, ctx.m.sender, reward)
        arcadeSave(ctx)
        return send(ctx, `🏆 *PUZZLE SELESAI*\nSemua ubin aman ditemukan: ${Array.from(game.selected).join(', ')}\nReward saldo virtual: Rp${arcadeMoney(ctx, reward)}.`)
    }
    persistArcadeGame(ctx, 'bombs', key, game)
    arcadeSave(ctx)
    return send(ctx, `✅ Ubin ${selection} aman. Progress: ${game.selected.size}/4.\nPilih lagi: .bomb pilih <1-5>.`)
}

async function handleScoreContest(ctx, args) {
    const stake = parseVirtualStake(args[0], 100, MAX_VIRTUAL_STAKE)
    if (!stake) return send(ctx, `🐓 *SABUNG SKOR VIRTUAL*\nFormat: .sabung <saldo-virtual>\nMinimal 100, maksimal ${arcadeMoney(ctx, MAX_VIRTUAL_STAKE)}. Ini kontes skor fiktif tanpa adegan melukai hewan.`)
    if (arcadeBalance(ctx) < stake) return send(ctx, 'Saldo virtual tidak cukup.')
    const playerScore = randInt(1, 100)
    const rivalScore = randInt(1, 100)
    arcadeAddBalance(ctx, ctx.m.sender, -stake)
    let payout = 0
    let result = 'Kalah'
    if (playerScore > rivalScore) { payout = stake * 2; result = 'Menang' }
    else if (playerScore === rivalScore) { payout = stake; result = 'Seri — saldo dikembalikan' }
    if (payout) arcadeAddBalance(ctx, ctx.m.sender, payout)
    arcadeSave(ctx)
    return send(ctx, `🐓 *KONTES SKOR AYAM VIRTUAL*\nSkor kamu: ${playerScore}\nSkor rival: ${rivalScore}\nHasil: ${result}\nPayout: Rp${arcadeMoney(ctx, payout)} saldo virtual.`)
}

async function handleFictionalMission(ctx, cmd, user) {
    const field = cmd === 'heist' ? 'heistAt' : 'begalAt'
    const cooldownMs = cmd === 'heist' ? 30 * 60 * 1000 : 20 * 60 * 1000
    const now = Date.now()
    const until = Number(user[field] || 0)
    if (until > now) return send(ctx, `⏳ Misi ${cmd} masih cooldown ${durationText(until - now)}.`)
    user[field] = now + cooldownMs
    const success = Math.random() < (cmd === 'heist' ? 0.6 : 0.55)
    if (success) {
        const reward = cmd === 'heist' ? randInt(2000, 6000) : randInt(1000, 4000)
        arcadeAddBalance(ctx, ctx.m.sender, reward)
        arcadeSave(ctx)
        return send(ctx, `🎮 *MISI RPG ${cmd.toUpperCase()} BERHASIL*\n\nMisi ini bersifat fiktif dan tidak berisi langkah dunia nyata.\nReward saldo virtual: Rp${arcadeMoney(ctx, reward)}\nSaldo sekarang: Rp${arcadeMoney(ctx, arcadeBalance(ctx))}\nCooldown: ${Math.ceil(cooldownMs / 60000)} menit.`)
    }
    const fine = Math.min(arcadeBalance(ctx), cmd === 'heist' ? randInt(200, 800) : randInt(100, 500))
    if (fine) arcadeAddBalance(ctx, ctx.m.sender, -fine)
    arcadeSave(ctx)
    return send(ctx, `🎮 *MISI RPG ${cmd.toUpperCase()} GAGAL*\n\nHasil misi fiktif kali ini kurang beruntung.\nPengurangan saldo virtual: Rp${arcadeMoney(ctx, fine)}\nSaldo sekarang: Rp${arcadeMoney(ctx, arcadeBalance(ctx))}\nCooldown: ${Math.ceil(cooldownMs / 60000)} menit.`)
}

async function handleArcadeGame(cmd, ctx, args) {
    if (!ARCADE_COMMANDS.has(cmd)) return false
    if (cmd === 'lotre') return handleLottery(ctx, args).then(() => true)
    if (cmd === 'poker3') return handlePoker3(ctx, args).then(() => true)
    if (cmd === 'hilo') return handleHiLo(ctx, args).then(() => true)
    if (cmd === 'rr') return handleRr(ctx, args).then(() => true)
    if (cmd === 'bomb') return handleBombPuzzle(ctx, args).then(() => true)
    if (cmd === 'sabung') return handleScoreContest(ctx, args).then(() => true)
    if (cmd === 'heist' || cmd === 'begal') return handleFictionalMission(ctx, cmd, ensureDb(ctx)).then(() => true)
    return false
}

async function handle(command, ctx) {
    const cmd = String(command || '').toLowerCase()
    if (!COMMANDS.has(cmd) || !ctx?.m || !ctx?.conn) return false
    const args = Array.isArray(ctx.args) ? ctx.args : String(ctx.text || '').split(/\s+/).filter(Boolean)

    if (ARCADE_COMMANDS.has(cmd)) return handleArcadeGame(cmd, ctx, args)

    if (cmd === 'pinjol') return handlePinjol(ctx, ensureDb(ctx), args).then(() => true)
    if (['belivga', 'nambangkripto', 'jualkripto'].includes(cmd)) return handleCrypto(ctx, ensureDb(ctx), cmd, args).then(() => true)
    if (cmd === 'pilihclass') return handleClass(ctx, ensureDb(ctx), args).then(() => true)
    if (cmd === 'mystats') return handleMyStats(ctx, ensureDb(ctx)).then(() => true)
    if (cmd === 'battle') return handleBattle(ctx, ensureDb(ctx)).then(() => true)
    if (['invest', 'portofolio', 'blackinvest'].includes(cmd)) return handleInvest(ctx, ensureDb(ctx), cmd, args).then(() => true)
    if (cmd === 'balapan') return handleBalapan(ctx, ensureDb(ctx)).then(() => true)
    if (cmd === 'nyawit') return handleNyawit(ctx, ensureDb(ctx)).then(() => true)
    if (cmd === 'math') {
        const result = evaluateMath(args.join(' '))
        return send(ctx, result.error ? `🧮 ${result.error}` : `🧮 *HASIL PERHITUNGAN*\n\n${args.join(' ')} = *${result.value}*`).then(() => true)
    }
    if (cmd === 'fact') {
        const fact = require('./funmenu.js').fact()
        return send(ctx, fact).then(() => true)
    }
    if (cmd === 'pick') {
        const result = require('./funmenu.js').pickOption(String(ctx.text || args.join(' ')))
        return send(ctx, result).then(() => true)
    }
    if (cmd === 'soulmate') return handleSoulmate(ctx, args).then(() => true)
    if (cmd === 'fitnah') return handleFitnah(ctx).then(() => true)
    if (cmd === 'funfeed') return sendAction(ctx, 'feed').then(() => true)
    if (SCORE_COMMANDS.has(cmd) || ['gaycheck', 'lesbiancheck', 'lesbicheck', 'hornycheck'].includes(cmd)) return handleScore(ctx, cmd, args).then(() => true)
    if (QUESTION_COMMANDS.has(cmd)) return handleQuestion(ctx, cmd, args).then(() => true)
    if (SAFE_ACTION_CATEGORIES.has(cmd)) return sendAction(ctx, cmd).then(() => true)
    return false
}

module.exports = {
    handle,
    evaluateMath,
    stableDailyPrice,
    getCommandNames: () => Array.from(COMMANDS),
    _internals: { ensureDb, makeDailyPrice: stableDailyPrice, SAFE_ACTION_CATEGORIES }
}
