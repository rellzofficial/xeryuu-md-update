'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Telegraf, Markup } = require('telegraf')
const axios = require('axios')
const chalk = require('chalk')
const { resolveScraprPlatform, extractScrapr, sendScraprToTelegram } = require('./library/scrapr-downloader.js')

const economy = require('./library/economy.js')
const depositService = require('./library/deposit.js')
const convertPulsaService = require('./library/convert-pulsa.js')
const nokosService = require('./library/nokos.js')
const topupService = require('./library/topup.js')
const purchasePayment = require('./library/purchase-payment.js')
const storeService = require('./library/store.js')
const providerWallets = require('./library/provider-wallets.js')
const { migrateLegacyCwdDatabaseFile } = require('./library/global-database.js')
const developerGithubUpdater = require('./library/github-update-developer.js')
const githubUpdateUser = require('./library/github-update-user.js')
migrateLegacyCwdDatabaseFile('telegram.json')
migrateLegacyCwdDatabaseFile('topup-transactions.json')

const DB_FILE = path.join(__dirname, 'library', 'database', 'telegram.json')
const UI_PAGE_SIZE = 8
let bot = null
let waConn = null
const CHANNEL_MEMBER_STATUSES = new Set(['creator', 'administrator', 'member'])
let telegramRateLimitedUntil = 0
let telegramRateLimitNoticeAt = 0
const telegramEditNextAt = new Map()
const telegramActionLocks = new Map()
let startImageCache = { key: '', buffer: null, expiresAt: 0 }
let richDraftCounter = Math.max(1, Date.now() % 1000000000)

function telegramRetryAfterMs(err) {
    const seconds = Number(
        err?.parameters?.retry_after ??
        err?.response?.parameters?.retry_after ??
        err?.response?.data?.parameters?.retry_after ??
        0
    )
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0
}

function isTelegramRateLimitError(err) {
    const status = Number(err?.response?.error_code || err?.response?.status || err?.code || 0)
    const message = String(err?.description || err?.message || err || '').toLowerCase()
    return status === 429 || message.includes('too many requests') || message.includes('retry after')
}

function setTelegramRateLimit(err) {
    const waitMs = telegramRetryAfterMs(err) || 5000
    telegramRateLimitedUntil = Math.max(telegramRateLimitedUntil, Date.now() + waitMs)
    if (Date.now() - telegramRateLimitNoticeAt > 15000) {
        telegramRateLimitNoticeAt = Date.now()
        const seconds = Math.ceil(waitMs / 1000)
        console.error(`edit ditahan ${seconds}s untuk mencegah flood.`)
    }
    return waitMs
}

function telegramRenderKey(type, text, keyboard) {
    let markup = keyboard?.reply_markup || keyboard || null
    try { markup = JSON.stringify(markup) } catch { markup = String(markup || '') }
    return `${type}|${String(text || '')}|${markup}`
}

function shouldSkipTelegramRender(tgId, key) {
    const session = getUi(tgId)
    if (!session || session.lastRenderKey !== key) return false
    return Date.now() - Number(session.lastRenderAt || 0) < 5000
}

function markTelegramRender(tgId, key) {
    setUi(tgId, { lastRenderKey: key, lastRenderAt: Date.now() })
}

async function waitTelegramEditSlot(chatId) {
    const key = String(chatId || 'global')
    const now = Date.now()
    const slotAt = Math.max(now, Number(telegramEditNextAt.get(key) || 0), telegramRateLimitedUntil)
    // Reserve the next slot before awaiting, so parallel callbacks cannot all
    // wake up and hit the Telegram API at the same instant.
    telegramEditNextAt.set(key, slotAt + 350)
    const waitMs = slotAt - now
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
    while (Date.now() < telegramRateLimitedUntil) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, telegramRateLimitedUntil - Date.now())))
    }
}

async function withTelegramActionLock(ctx, action, fn) {
    const key = `${String(ctx.from?.id || '')}:${String(action || '')}`
    if (telegramActionLocks.has(key)) {
        await editTracked(ctx, `⏳ <b>Permintaan sebelumnya masih diproses.</b>\n\nMohon tunggu sampai proses selesai.`, backHomeKeyboard()).catch(() => {})
        return null
    }
    telegramActionLocks.set(key, Date.now())
    try {
        return await fn()
    } finally {
        telegramActionLocks.delete(key)
    }
}

function forceJoinConfig() {
    return global.telegramConfig || {}
}

function forceJoinEnabled() {
    const cfg = forceJoinConfig()
    return cfg.forceJoinEnabled !== false && Boolean(String(cfg.forceJoinChannel || '').trim())
}

function privateChat(ctx) {
    return ctx?.chat?.type === 'private' || !ctx?.chat?.type
}

function joinChannelKeyboard() {
    const cfg = forceJoinConfig()
    const url = String(cfg.forceJoinUrl || '').trim()
    const title = String(cfg.forceJoinTitle || 'Channel Xeryuu').trim()
    const rows = []
    if (url && /^https?:\/\//i.test(url)) rows.push([Markup.button.url(`📢 Follow ${title}`, url)])
    rows.push([Markup.button.callback('✅ Saya Sudah Follow', 'tg_check_join')])
    return Markup.inlineKeyboard(rows)
}

async function isChannelMember(ctx) {
    if (!forceJoinEnabled() || !privateChat(ctx) || !ctx?.from?.id || !bot) return true
    const channel = String(forceJoinConfig().forceJoinChannel || '').trim()
    try {
        const member = await bot.telegram.getChatMember(channel, ctx.from.id)
        if (CHANNEL_MEMBER_STATUSES.has(member?.status)) return true
        if (member?.status === 'restricted' && member?.is_member !== false) return true
        return false
    } catch (err) {
        console.error('[TELEGRAM FORCE JOIN]', err?.description || err?.message || err)
        return null
    }
}

async function showForceJoin(ctx, { edit = false } = {}) {
    const cfg = forceJoinConfig()
    const channel = String(cfg.forceJoinChannel || '').trim()
    const title = String(cfg.forceJoinTitle || 'Channel Xeryuu').trim()
    const text =
        `🔒 <b>AKSES TERKUNCI</b>\n\n` +
        `Untuk menggunakan bot, silakan follow <b>${escapeHtml(title)}</b> terlebih dahulu.\n\n` +
        `📢 Channel: <code>${escapeHtml(channel)}</code>\n` +
        `Setelah follow, tekan <b>✅ Saya Sudah Follow</b>.`
    const richJoin = await tryRenderRichMenu(ctx, text, joinChannelKeyboard(), {
        stage: 'force_join', details: { channel, title },
        edit: Boolean(edit || ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId), hero: true
    }).catch(error => {
        console.warn('[TELEGRAM FORCE JOIN RICH FALLBACK]', error?.description || error?.message || error)
        return null
    })
    if (richJoin) return richJoin
    if (edit || ctx?.callbackQuery) return editTracked(ctx, text, joinChannelKeyboard())
    const sent = await ctx.reply(text, { parse_mode: 'HTML', ...joinChannelKeyboard() })
    setUi(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id, messageType: 'text', screen: 'force_join' })
    return sent
}

async function requireChannelJoin(ctx) {
    if (!forceJoinEnabled() || !privateChat(ctx)) return true
    const status = await isChannelMember(ctx)
    if (status === true) return true
    if (status === null) {
        if (ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId) {
            await editTracked(ctx, '⚠️ <b>Tidak dapat memeriksa membership channel.</b>\n\nPastikan bot adalah admin channel lalu tekan refresh.', joinChannelKeyboard()).catch(() => {})
        } else if (ctx?.reply) {
            await ctx.reply('⚠️ Tidak dapat memeriksa membership channel. Pastikan bot adalah admin channel, lalu coba lagi.')
        }
        return false
    }
    await showForceJoin(ctx, { edit: Boolean(ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId) })
    return false
}

const uiSessions = new Map()

function ensureDb() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, pending: {} }, null, 2))
    try {
        const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
        if (!data.users || typeof data.users !== 'object') data.users = {}
        if (!data.pending || typeof data.pending !== 'object') data.pending = {}
        return data
    } catch {
        return { users: {}, pending: {} }
    }
}

function saveDb(data) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true })
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

function normalizeWaJid(value) {
    const n = String(value || '').replace(/\D/g, '')
    if (!n) return ''
    return `${n}@s.whatsapp.net`
}

function registerTelegramUser(ctx) {
    const tgId = String(ctx?.from?.id || '').trim()
    if (!/^-?\d+$/.test(tgId)) return
    const db = ensureDb()
    const current = db.users[tgId] || {}
    db.users[tgId] = {
        ...current,
        firstName: ctx.from?.first_name || current.firstName || '',
        username: ctx.from?.username || current.username || '',
        chatType: ctx.chat?.type || current.chatType || 'private',
        lastSeenAt: Date.now()
    }
    saveDb(db)
}

function getLink(tgId) {
    const db = ensureDb()
    return db.users[String(tgId)]?.jid || ''
}

function isLinked(tgId) {
    return Boolean(getLink(tgId))
}

function getJid(ctx) {
    return getLink(ctx.from?.id)
}

function telegramAccountJid(tgId) {
    const id = String(tgId || '').trim()
    return /^-?\d+$/.test(id) ? `telegram:${id}` : ''
}

function getTransactionJid(ctx) {
    return telegramAccountJid(ctx?.from?.id)
}

function isTelegramAccountJid(value) {
    return /^telegram:-?\d+$/.test(String(value || '').trim())
}

function escapeTelegramHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

function telegramHtmlLooksExplicit(text) {
    return /<(?:b|strong|i|em|u|s|code|pre|blockquote|a|tg-spoiler)(?:\s|>)/i.test(String(text || ''))
}

function legacyTelegramNoticeToHtml(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n').trim()
    if (!raw) return ''
    if (telegramHtmlLooksExplicit(raw)) return raw

    const lines = raw.split('\n')
    const quoted = lines.some(line => /^\s*>/.test(line))
    const normalized = lines.map(line => line.replace(/^\s*>\s?/, ''))
    let body = normalized.map(escapeTelegramHtml).join('\n')

    // Convert the small WhatsApp-Markdown subset used by store/jadibot notifications.
    body = body.replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    body = body.replace(/`([^`\n]+)`/g, '<code>$1</code>')

    // Telegram supports native HTML blockquotes.  Legacy notifications that were
    // written with `>` are rendered as one clean, readable quote instead of
    // showing the `>` characters literally.
    if (quoted) return `<blockquote>${body}</blockquote>`
    return body
}

async function sendTelegramMessage(target, text, options = {}) {
    if (!bot) throw new Error('Bot Telegram belum aktif.')
    const raw = String(target || '').trim()
    const chatId = isTelegramAccountJid(raw) ? raw.slice('telegram:'.length) : raw
    if (!chatId) throw new Error('Telegram chat ID tidak valid.')

    const sourceText = String(text || '')
    const hasExplicitMode = Object.prototype.hasOwnProperty.call(options, 'parse_mode')
    const html = legacyTelegramNoticeToHtml(sourceText)
    const sendOptions = hasExplicitMode
        ? options
        : { parse_mode: 'HTML', ...options }

    return bot.telegram.sendMessage(chatId, html, sendOptions)
}

function createCode() {
    return crypto.randomBytes(3).toString('hex').toUpperCase()
}

function pendingLink(tgId, waJid) {
    const db = ensureDb()
    const code = createCode()
    db.pending[code] = {
        telegramId: String(tgId),
        jid: waJid,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000
    }
    saveDb(db)
    return code
}

function verifyBindCode(code, jid) {
    const key = String(code || '').trim().toUpperCase()
    const waJid = normalizeWaJid(jid)
    const db = ensureDb()
    const item = db.pending[key]
    if (!item) return { ok: false, error: 'Kode pairing Telegram tidak ditemukan.' }
    if (Date.now() > Number(item.expiresAt || 0)) {
        delete db.pending[key]
        saveDb(db)
        return { ok: false, error: 'Kode pairing Telegram sudah kedaluwarsa.' }
    }
    if (item.jid !== waJid) return { ok: false, error: 'Kode ini dibuat untuk nomor WhatsApp lain.' }

    db.users[String(item.telegramId)] = {
        jid: waJid,
        linkedAt: Date.now()
    }
    delete db.pending[key]
    saveDb(db)
    return { ok: true, telegramId: String(item.telegramId), jid: waJid }
}

function unlinkTelegram(tgId) {
    const db = ensureDb()
    const key = String(tgId)
    if (!db.users[key]) return false
    delete db.users[key]
    saveDb(db)
    return true
}

async function sendChunks(ctx, text, size = 3900) {
    const value = String(text || '')
    if (value.length <= size) return ctx.reply(value)
    for (let i = 0; i < value.length; i += size) await ctx.reply(value.slice(i, i + size))
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function pageInfo(total, page, size = UI_PAGE_SIZE) {
    const pages = Math.max(1, Math.ceil(total / size))
    const safePage = Math.min(Math.max(0, Number(page) || 0), pages - 1)
    return { page: safePage, pages, start: safePage * size, end: Math.min(total, safePage * size + size) }
}

function getUi(tgId) {
    return uiSessions.get(String(tgId)) || null
}

function setUi(tgId, patch = {}) {
    const key = String(tgId)
    const current = getUi(key) || {}
    const next = { ...current, ...patch }
    uiSessions.set(key, next)
    return next
}

function clearPending(tgId) {
    const session = getUi(tgId)
    if (!session) return
    const next = { ...session }
    delete next.pendingTopup
    setUi(tgId, next)
}

function mainMenu(ctx = null) {
    const rows = [
        [Markup.button.callback('🖥 VPS & SERVER', 'tg_home_store'), Markup.button.callback('📦 PANEL HOSTING', 'tg_store_category:panel')],
        [Markup.button.callback('⚙️ SCRIPT PREMIUM', 'tg_store_category:all'), Markup.button.callback('📱 NOKOS WA/TELE', 'tg_home_nokos')],
        [Markup.button.callback('🎮 TOP UP GAME', 'tg_home_topup'), Markup.button.callback('👤 PROFILE', 'tg_home_profile')],
        [Markup.button.callback('📦 PESANAN SAYA', 'tg_store_orders'), Markup.button.url('📞 SUPPORT', `https://t.me/${String(global.telegramConfig?.supportUsername || global.telegramConfig?.support || '').replace('@', '')}`)],
        [Markup.button.callback('💱 CONVERT PULSA', 'tg_home_convertpulsa'), Markup.button.callback('💳 DEPOSIT SALDO', 'tg_home_deposit')],
        [Markup.button.callback('💝 DONASI', 'tg_home_donasi')],
        [Markup.button.callback('💰 CEK SALDO', 'tg_home_balance'), Markup.button.callback('🎨 RICH UI', 'tg_rich_showcase')]
    ]
    const owner = String(global.owner || '').replace(/\D/g, '')
    const linked = getJid(ctx)?.replace(/\D/g, '')
    const adminIds = Array.isArray(global.telegramConfig?.adminIds) ? global.telegramConfig.adminIds.map(String) : []
    const isAdmin = adminIds.includes(String(ctx?.from?.id || '')) || Boolean(owner && linked === owner)
    if (isAdmin) rows.push([Markup.button.callback('👑 ADMIN PANEL', 'tg_admin_panel')])
    return Markup.inlineKeyboard(rows)
}

function backHomeKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('╰─ 🏠  KEMBALI KE MENU', 'tg_home')]
    ])
}

function currentMessageIsPhoto(ctx, session) {
    // For inline buttons, trust the exact message that was clicked rather than
    // a potentially older user session from a different chat/message.
    if (ctx?.callbackQuery?.message) return Boolean(ctx.callbackQuery.message.photo?.length)
    return Boolean(session?.messageType === 'photo')
}

function telegramStartImageUrl() {
    const url = String(global.telegramConfig?.startImageUrl || '').trim()
    return /^https?:\/\//i.test(url) ? url : ''
}

function telegramStartImagePath() {
    const configured = String(global.telegramConfig?.startImagePath || '').trim()
    const candidates = [
        configured ? path.resolve(configured) : '',
        path.join(process.cwd(), 'media', 'xeryuu.jpg'),
        path.join(process.cwd(), 'media', 'Xeryuu-MD V15 @xnalz.webp')
    ].filter(Boolean)
    return candidates.find(file => fs.existsSync(file)) || ''
}

async function getStartImageBuffer() {
    const url = telegramStartImageUrl()
    const localPath = telegramStartImagePath()
    const key = `${url}|${localPath}`
    if (startImageCache.buffer && startImageCache.key === key && startImageCache.expiresAt > Date.now()) {
        return startImageCache.buffer
    }

    let buffer = null
    if (url) {
        try {
            buffer = await fetchTelegramPhoto(url)
        } catch (err) {
            console.error('[TELEGRAM HOME IMAGE URL]', err?.message || err)
        }
    }
    if (!buffer && localPath) {
        try {
            buffer = fs.readFileSync(localPath)
        } catch (err) {
            console.error('[TELEGRAM HOME IMAGE LOCAL]', err?.message || err)
        }
    }

    if (buffer) {
        startImageCache = { key, buffer, expiresAt: Date.now() + 5 * 60 * 1000 }
    }
    return buffer
}

async function fetchTelegramPhoto(url) {
    const value = String(url || '').trim()
    if (!/^https?:\/\//i.test(value)) throw new Error('URL gambar Telegram tidak valid.')

    const response = await axios.get(value, {
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 10 * 1024 * 1024,
        maxBodyLength: 10 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0 Xeryuu-MD Telegram' }
    })

    const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
    if (contentType && !contentType.startsWith('image/')) {
        throw new Error(`URL tidak mengembalikan gambar (Content-Type: ${contentType}).`)
    }

    const buffer = Buffer.from(response.data)
    if (!buffer.length) throw new Error('File gambar kosong.')
    return buffer
}


function isTelegramCommandMessage(ctx) {
    if (!ctx?.message?.text || ctx?.callbackQuery) return false
    const text = String(ctx.message.text || '').trim()
    const entityCommand = Array.isArray(ctx.message.entities) && ctx.message.entities.some(entity =>
        entity?.type === 'bot_command' && Number(entity.offset) === 0
    )
    return entityCommand || /^\/[a-z0-9_]+(?:@[a-z0-9_]+)?(?:\s|$)/i.test(text)
}

function isTelegramStartCommand(ctx) {
    return isTelegramCommandMessage(ctx) && /^\/start(?:@[a-z0-9_]+)?(?:\s|$)/i.test(String(ctx.message.text || '').trim())
}

async function sendCommandReply(ctx, text, keyboard = null, extra = {}) {
    const chatId = ctx?.chat?.id
    if (!chatId) throw new Error('Chat Telegram tidak tersedia untuk membalas command.')

    // Command replies juga mencoba format Rich Message, bukan hanya /start.
    // Jika Bot API/client tidak menerima format Rich, jalur klasik tetap tersedia.
    const richSent = await tryRenderRichMenu(ctx, text, keyboard, {
        stage: 'command_reply', edit: false, hero: false
    }).catch(error => {
        console.warn('[TELEGRAM COMMAND RICH FALLBACK]', error?.description || error?.message || error)
        return null
    })
    if (richSent) return richSent

    const options = { parse_mode: 'HTML', ...(keyboard || {}), ...extra }
    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
        await waitTelegramEditSlot(chatId)
        try {
            const sent = await ctx.telegram.sendMessage(chatId, String(text ?? ''), options)
            if (privateChat(ctx) && ctx.from?.id) {
                setUi(ctx.from.id, {
                    chatId: sent.chat.id,
                    messageId: sent.message_id,
                    messageType: 'text',
                    screen: getUi(ctx.from.id)?.screen || 'command'
                })
                markTelegramRender(ctx.from.id, telegramRenderKey('text', text, keyboard))
            }
            return sent
        } catch (err) {
            lastError = err
            if (!isTelegramRateLimitError(err) || attempt > 0) break
            setTelegramRateLimit(err)
        }
    }
    if (isTelegramRateLimitError(lastError)) setTelegramRateLimit(lastError)
    throw lastError
}

async function sendCommandPhoto(ctx, photoSource, caption, keyboard = null) {
    const chatId = ctx?.chat?.id
    if (!chatId) throw new Error('Chat Telegram tidak tersedia untuk mengirim kartu.')
    const options = { caption: String(caption || '').slice(0, 1024), parse_mode: 'HTML', ...(keyboard || {}) }
    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
        await waitTelegramEditSlot(chatId)
        try {
            const sent = await ctx.telegram.sendPhoto(chatId, { source: photoSource }, options)
            if (privateChat(ctx) && ctx.from?.id) {
                setUi(ctx.from.id, {
                    chatId: sent.chat.id,
                    messageId: sent.message_id,
                    messageType: 'photo',
                    screen: getUi(ctx.from.id)?.screen || 'command'
                })
                markTelegramRender(ctx.from.id, telegramRenderKey('photo', options.caption, keyboard))
            }
            return sent
        } catch (err) {
            lastError = err
            if (!isTelegramRateLimitError(err) || attempt > 0) break
            setTelegramRateLimit(err)
        }
    }
    if (isTelegramRateLimitError(lastError)) setTelegramRateLimit(lastError)
    throw lastError
}

async function editTrackedPhoto(ctx, photo, caption, keyboard, { preferEdit = true } = {}) {
    const tgId = String(ctx.from?.id || '')
    const session = getUi(tgId)
    const chatId = ctx.callbackQuery?.message?.chat?.id || session?.chatId || ctx.chat?.id
    const messageId = ctx.callbackQuery?.message?.message_id || session?.messageId
    const normalizedCaption = String(caption || '').slice(0, 1024)
    const renderKey = telegramRenderKey('photo', normalizedCaption, keyboard)
    const commandContext = isTelegramCommandMessage(ctx) && !isTelegramStartCommand(ctx)

    if (!commandContext && shouldSkipTelegramRender(tgId, renderKey)) return null

    const photoSource = typeof photo === 'string'
        ? await fetchTelegramPhoto(photo)
        : photo
    if (!photoSource || (Buffer.isBuffer(photoSource) && !photoSource.length)) {
        throw new Error('Sumber gambar Telegram kosong.')
    }
    if (commandContext) return sendCommandPhoto(ctx, photoSource, normalizedCaption, keyboard)

    let replaceExistingMessage = false
    const media = {
        type: 'photo',
        media: { source: photoSource },
        caption: normalizedCaption,
        parse_mode: 'HTML'
    }

    if (chatId && messageId && preferEdit && currentMessageIsPhoto(ctx, session)) {
        await waitTelegramEditSlot(chatId)
        try {
            const result = await ctx.telegram.editMessageMedia(chatId, messageId, undefined, media, keyboard || {})
            setUi(tgId, { chatId, messageId, messageType: 'photo' })
            markTelegramRender(tgId, renderKey)
            return result
        } catch (err) {
            if (isTelegramRateLimitError(err)) {
                setTelegramRateLimit(err)
                return null
            }
            const msg = String(err?.description || err?.message || err)
            if (/message is not modified/i.test(msg)) {
                try {
                    await waitTelegramEditSlot(chatId)
                    const result = await ctx.telegram.editMessageCaption(
                        chatId, messageId, undefined, normalizedCaption,
                        { parse_mode: 'HTML', ...(keyboard || {}) }
                    )
                    setUi(tgId, { chatId, messageId, messageType: 'photo' })
                    markTelegramRender(tgId, renderKey)
                    return result
                } catch (fallbackErr) {
                    if (isTelegramRateLimitError(fallbackErr)) setTelegramRateLimit(fallbackErr)
                    else console.error('[TELEGRAM EDIT PHOTO CAPTION]', fallbackErr?.description || fallbackErr?.message || fallbackErr)
                }
            } else {
                console.error('[TELEGRAM EDIT PHOTO]', msg)
                replaceExistingMessage = true
            }
        }
    }

    if (chatId && messageId && (replaceExistingMessage || !currentMessageIsPhoto(ctx, session))) {
        try {
            await ctx.telegram.deleteMessage(chatId, messageId)
        } catch (err) {
            // Pesan mungkin sudah terhapus/terlalu lama; tetap lanjut kirim foto baru.
            const msg = String(err?.description || err?.message || err).toLowerCase()
            if (!msg.includes('message to delete not found') && !msg.includes("message can't be deleted")) {
                console.error('[TELEGRAM DELETE OLD TEXT]', err?.description || err?.message || err)
            }
        }
    }

    try {
        const sent = await ctx.telegram.sendPhoto(
            chatId || ctx.chat?.id,
            { source: photoSource },
            { caption: normalizedCaption, parse_mode: 'HTML', ...(keyboard || {}) }
        )
        setUi(tgId, {
            chatId: sent.chat.id,
            messageId: sent.message_id,
            messageType: 'photo'
        })
        markTelegramRender(tgId, renderKey)
        return sent
    } catch (err) {
        if (isTelegramRateLimitError(err)) setTelegramRateLimit(err)
        else console.error('[TELEGRAM SEND PHOTO]', err?.description || err?.message || err)
        return null
    }
}

async function editTrackedStartHome(ctx, caption, keyboard, { forcePhoto = false } = {}) {
    const session = getUi(ctx.from?.id)
    const shouldUsePhoto = forcePhoto || (session?.messageId && session?.chatId && currentMessageIsPhoto(ctx, session))
    if (shouldUsePhoto) {
        let image = null
        try {
            const profileAvatar = await getTelegramProfileAvatarBuffer(ctx)
            image = await makeTelegramHomeDashboard(autoOrderStats(), ctx.from?.first_name || 'User', profileAvatar)
        } catch (error) {
            console.error('[TELEGRAM HOME RE-RENDER]', error?.message || error)
        }
        if (!image) image = await getStartImageBuffer()
        if (image) return editTrackedPhoto(ctx, image, caption, keyboard)
    }
    return editTracked(ctx, caption, keyboard)
}

async function editTracked(ctx, text, keyboard, extra = {}) {
    const tgId = String(ctx.from?.id || '')
    const session = getUi(tgId)
    const commandContext = isTelegramCommandMessage(ctx) && !isTelegramStartCommand(ctx)
    if (commandContext) return sendCommandReply(ctx, text, keyboard, extra)

    // Seluruh transisi menu/callback mencoba Rich Message native terlebih dahulu.
    // Jika rich API tidak tersedia atau menolak format, kode lama di bawah tetap jadi fallback.
    try {
        const richSent = await tryRenderRichMenu(ctx, text, keyboard, {
            stage: session?.screen || 'menu', edit: Boolean(ctx?.callbackQuery || session?.messageId), hero: false
        })
        if (richSent) return richSent
    } catch (richError) {
        console.warn('[TELEGRAM RICH TRACKED FALLBACK]', richError?.description || richError?.message || richError)
    }

    const chatId = ctx.callbackQuery?.message?.chat?.id || session?.chatId || ctx.chat?.id
    const messageId = ctx.callbackQuery?.message?.message_id || session?.messageId
    const renderKey = telegramRenderKey(currentMessageIsPhoto(ctx, session) ? 'photo-caption' : 'text', text, keyboard)

    if (shouldSkipTelegramRender(tgId, renderKey)) return null

    if (!chatId || !messageId) {
        try {
            const sent = await ctx.reply(text, { parse_mode: 'HTML', ...(keyboard || {}) })
            setUi(tgId, { chatId: sent.chat.id, messageId: sent.message_id, messageType: 'text', screen: 'home' })
            markTelegramRender(tgId, renderKey)
            return sent
        } catch (err) {
            if (isTelegramRateLimitError(err)) setTelegramRateLimit(err)
            else console.error('[TELEGRAM SEND TEXT]', err?.description || err?.message || err)
            return null
        }
    }

    const options = { parse_mode: 'HTML', ...(keyboard || {}), ...extra }
    await waitTelegramEditSlot(chatId)
    try {
        if (currentMessageIsPhoto(ctx, session)) {
            const result = await ctx.telegram.editMessageCaption(chatId, messageId, undefined, String(text || '').slice(0, 1024), options)
            setUi(tgId, { chatId, messageId, messageType: 'photo' })
            markTelegramRender(tgId, renderKey)
            return result
        }

        const result = await ctx.telegram.editMessageText(chatId, messageId, undefined, text, options)
        setUi(tgId, { chatId, messageId, messageType: 'text' })
        markTelegramRender(tgId, renderKey)
        return result
    } catch (err) {
        if (isTelegramRateLimitError(err)) {
            setTelegramRateLimit(err)
            return null
        }
        const msg = String(err?.description || err?.message || err)
        if (!/message is not modified/i.test(msg)) {
            console.error('[TELEGRAM EDIT FALLBACK]', msg)
            try {
                const sent = await ctx.reply(text, { parse_mode: 'HTML', ...(keyboard || {}) })
                setUi(tgId, { chatId: sent.chat.id, messageId: sent.message_id, messageType: 'text' })
                markTelegramRender(tgId, renderKey)
                return sent
            } catch (fallbackErr) {
                if (isTelegramRateLimitError(fallbackErr)) setTelegramRateLimit(fallbackErr)
            }
        }
        return null
    }
}

async function commandOutput(ctx, text, keyboard = null) {
    // Perintah /menu layanan sering dipanggil sebelum sesi UI terbentuk. Tetap
    // coba native Rich Message agar bukan hanya /start yang mendapat tampilan kaya.
    if (isTelegramCommandMessage(ctx) && !isTelegramStartCommand(ctx)) {
        return sendCommandReply(ctx, text, keyboard || undefined)
    }
    const session = getUi(ctx.from?.id)
    if (session?.chatId && session?.messageId) {
        return editTracked(ctx, text, keyboard || undefined)
    }
    const richSent = await tryRenderRichMenu(ctx, text, keyboard || undefined, {
        stage: 'command_output', edit: false, hero: false
    }).catch(error => {
        console.warn('[TELEGRAM COMMAND OUTPUT RICH FALLBACK]', error?.description || error?.message || error)
        return null
    })
    if (richSent) return richSent
    return ctx.reply(text, { parse_mode: 'HTML', ...(keyboard || {}) })
}

async function commandOutputChunks(ctx, text, size = 3900) {
    const value = String(text || '')
    if (value.length <= size) return commandOutput(ctx, value)
    // Hindari membuat rangkaian pesan baru untuk command: tampilkan bagian
    // yang muat pada pesan UI yang sedang dilacak.
    return commandOutput(ctx, value.slice(0, size) + '\n\n… output dipotong agar tetap memakai 1 pesan.')
}

async function answer(ctx) {
    try { await ctx.answerCbQuery() } catch {}
}

async function makeTelegramHomeDashboard(stats, displayName = 'User', profileAvatarBuffer = null) {
    const canvasLib = storeCanvasModule()
    if (!canvasLib?.createCanvas) throw new Error('Canvas renderer tidak tersedia.')
    const { createCanvas, loadImage } = canvasLib
    const width = 1200
    const height = 675
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')

    const background = ctx.createLinearGradient(0, 0, width, height)
    background.addColorStop(0, '#030713')
    background.addColorStop(0.55, '#06152a')
    background.addColorStop(1, '#08263a')
    ctx.fillStyle = background
    ctx.fillRect(0, 0, width, height)

    ctx.save()
    ctx.globalAlpha = 0.12
    ctx.strokeStyle = '#20dfff'
    ctx.lineWidth = 1
    for (let x = 28; x < width; x += 42) {
        ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, height - 20); ctx.stroke()
    }
    for (let y = 25; y < height; y += 42) {
        ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(width - 20, y); ctx.stroke()
    }
    ctx.restore()

    const glow = ctx.createRadialGradient(600, 215, 10, 600, 215, 420)
    glow.addColorStop(0, 'rgba(0, 204, 255, 0.20)')
    glow.addColorStop(1, 'rgba(0, 204, 255, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(180, 20, 840, 400)

    canvasRoundRect(ctx, 24, 24, width - 48, height - 48, 22, 'rgba(2, 11, 25, 0.45)', 'rgba(35, 211, 255, 0.78)')
    // Sudut neon seperti kartu dashboard pada referensi.
    ctx.strokeStyle = '#27ddff'
    ctx.lineWidth = 5
    const corners = [
        [42, 80, 42, 42, 82, 42],
        [width - 82, 42, width - 42, 42, width - 42, 80],
        [42, height - 80, 42, height - 42, 82, height - 42],
        [width - 82, height - 42, width - 42, height - 42, width - 42, height - 80]
    ]
    for (const [x1, y1, x2, y2, x3, y3] of corners) {
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.stroke()
    }

    canvasRoundRect(ctx, 515, 48, 170, 34, 17, 'rgba(0, 194, 237, 0.12)', 'rgba(38, 220, 255, 0.8)')
    ctx.fillStyle = '#70eaff'
    ctx.font = '800 14px Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('✦  WELCOME  ✦', 600, 70)

    const avatarPath = path.join(process.cwd(), 'media', 'xnalz.png')
    try {
        const avatar = await loadImage(profileAvatarBuffer || avatarPath)
        ctx.save()
        ctx.beginPath(); ctx.arc(600, 158, 48, 0, Math.PI * 2); ctx.closePath(); ctx.clip()
        const side = Math.min(avatar.width || 1, avatar.height || 1)
        const sx = ((avatar.width || side) - side) / 2
        const sy = ((avatar.height || side) - side) / 2
        ctx.drawImage(avatar, sx, sy, side, side, 552, 110, 96, 96)
        ctx.restore()
    } catch {
        canvasRoundRect(ctx, 552, 110, 96, 96, 48, '#09283f', 'rgba(41, 217, 255, 0.9)')
        ctx.fillStyle = '#72eaff'; ctx.font = '800 42px Arial, sans-serif'; ctx.fillText('X', 600, 166)
    }
    ctx.beginPath(); ctx.arc(600, 158, 51, 0, Math.PI * 2)
    ctx.strokeStyle = '#31dfff'; ctx.lineWidth = 4; ctx.stroke()

    ctx.fillStyle = '#e8faff'
    ctx.font = '800 35px Arial, sans-serif'
    ctx.fillText('Auto Order Xeryuu-Md V16 × Sendrich', 600, 252)
    ctx.fillStyle = '#8faec2'
    ctx.font = '500 16px Arial, sans-serif'
    ctx.fillText(fitCanvasText(ctx, `Halo ${displayName} — selamat datang kembali`, 820, 16, 12, 500), 600, 282)

    const uptimeSeconds = Math.max(0, Math.floor(process.uptime()))
    const days = Math.floor(uptimeSeconds / 86400)
    const hours = Math.floor((uptimeSeconds % 86400) / 3600)
    const minutes = Math.floor((uptimeSeconds % 3600) / 60)
    const uptime = `${days}d ${hours}h ${minutes}m`
    const number = value => Number(value || 0).toLocaleString('id-ID')
    const isPaidOrder = order =>
        ['PAID', 'PAID_WAITING_FULFILLMENT', 'PROCESSING', 'DONE'].includes(String(order?.status || '').toUpperCase()) ||
        String(order?.paymentStatus || '').toUpperCase() === 'PAID'
    const revenue = (Array.isArray(stats.orders) ? stats.orders : [])
        .filter(isPaidOrder)
        .reduce((sum, order) => sum + Math.max(0, Number(order?.paymentAmount ?? order?.price ?? 0) || 0), 0)
    const metrics = [
        ['TOTAL PENGGUNA', number(stats.users), '#27dfff'],
        ['RUNTIME BOT', uptime, '#40e5ab'],
        ['PENDAPATAN TERCATAT', `Rp${number(revenue)}`, '#f4c24e'],
        ['TOTAL TRANSAKSI', number(stats.orders?.length || 0), '#a77bff']
    ]
    ctx.textAlign = 'left'
    metrics.forEach((item, index) => {
        const x = 58 + (index % 2) * 548
        const y = 322 + Math.floor(index / 2) * 126
        drawTelegramMenuMetric(ctx, x, y, 528, 104, item[0], item[1], item[2])
    })

    ctx.fillStyle = '#7f9eb2'
    ctx.font = '600 12px Arial, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText('XERYUU-MD  •  AUTO ORDER DIGITAL SERVICE', 58, 626)
    ctx.textAlign = 'right'
    ctx.fillText('SECURE ORDER FLOW', width - 58, 626)
    ctx.textAlign = 'left'
    return canvas.toBuffer('image/png')
}

async function getTelegramProfileAvatarBuffer(ctx) {
    try {
        const tgId = Number(ctx?.from?.id)
        if (!Number.isSafeInteger(tgId) || tgId <= 0 || !ctx?.telegram) return null
        const photos = await ctx.telegram.getUserProfilePhotos(tgId, 0, 1)
        const sizes = photos?.photos?.[0]
        const photo = Array.isArray(sizes) && sizes.length ? sizes[sizes.length - 1] : null
        if (!photo?.file_id) return null
        const fileUrl = await ctx.telegram.getFileLink(photo.file_id)
        return await fetchTelegramPhoto(String(fileUrl))
    } catch (error) {
        console.error('[TELEGRAM USER AVATAR]', error?.message || error)
        return null
    }
}

async function showHomeLegacy(ctx, { edit = true, forceImage = false } = {}) {
    const username = ctx.from?.username ? `@${ctx.from.username}` : escapeHtml(ctx.from?.first_name || 'User')
    const jid = getTransactionJid(ctx)
    const balance = jid ? economy.getBalance(jid) : 0
    const stats = autoOrderStats()
    const caption =
        `<blockquote>🐬 XNALZ AUTO ORDER SYSTEM</blockquote>\n` +
        `✨ <b>WELCOME, ${username}!</b> 👋\n\n` +
        `📊 <b>STATISTIK TOKO</b>\n` +
        `👥 Total Users: <b>${stats.users}</b>\n` +
        `💳 Saldo Biasa: <b>Rp${escapeHtml(economy.formatMoney(balance))}</b>\n` +
        `✅ Transaksi Sukses: <b>${stats.paid}</b>\n` +
        `<blockquote>⛈️Developer : @XnalzNotDev</blockquote>\n` +
        `📦 Produk Tersedia: <b>${stats.products.length}</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯 <b>SILAHKAN PILIH MENU:</b>` 

    if (!edit || (!ctx.callbackQuery && !forceImage)) {
        const startImageAvailable = Boolean(telegramStartImageUrl() || telegramStartImagePath())
        if (startImageAvailable) {
            try {
                const profileAvatar = await getTelegramProfileAvatarBuffer(ctx)
                let image = null
                try {
                    image = await makeTelegramHomeDashboard(stats, ctx.from?.first_name || 'User', profileAvatar)
                } catch (dashboardError) {
                    console.error('[TELEGRAM HOME DASHBOARD]', dashboardError?.message || dashboardError)
                }
                if (!image) image = await getStartImageBuffer()
                if (!image) throw new Error('Gambar menu tidak tersedia.')
                const sent = await ctx.replyWithPhoto({ source: image }, {
                    caption,
                    parse_mode: 'HTML',
                    ...mainMenu(ctx)
                })
                setUi(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id, messageType: 'photo', screen: 'home' })
                return sent
            } catch (err) {
                console.error('[TELEGRAM HOME IMAGE]', err?.message || err)
            }
        }
        const sent = await ctx.reply(caption, { parse_mode: 'HTML', ...mainMenu(ctx) })
        setUi(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id, messageType: 'text', screen: 'home' })
        return sent
    }

    clearPending(ctx.from.id)
    setUi(ctx.from.id, { screen: 'home' })
    // Saat kembali dari menu teks (NOKOS, topup, profile, dll), menu utama
    // tetap kembali ke foto home yang dikonfigurasi, bukan berubah menjadi teks.
    const homeImageConfigured = Boolean(telegramStartImageUrl() || telegramStartImagePath())
    return editTrackedStartHome(ctx, caption, mainMenu(ctx), { forcePhoto: forceImage || homeImageConfigured })
}

function makeRichButton(text, callbackData, style = 'primary') {
    return { text: String(text), style, callback_data: String(callbackData) }
}

function makeRichUrlButton(text, url) {
    return { text: String(text), url: String(url) }
}

function richButtonBlock(buttons, align = 'center') {
    return { type: 'buttons', align, buttons }
}

function makeRichTable(headers, rows, { striped = true, compact = true, caption = '' } = {}) {
    const cells = [headers.map(text => ({ text: String(text), is_header: true, align: 'center' }))]
    for (const row of rows) {
        cells.push(row.map(value => {
            if (value && typeof value === 'object' && Array.isArray(value.richText)) {
                return { text: value.richText, align: value.align || 'left' }
            }
            return { text: String(value ?? ''), align: 'left' }
        }))
    }
    const block = { type: 'table', cells, is_bordered: true, is_compact: Boolean(compact) }
    if (striped) block.is_striped = true
    if (caption) block.caption = String(caption)
    return block
}

function htmlToRichPlainText(value) {
    return String(value ?? '')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<\/(?:p|div|blockquote|pre|h[1-6]|li|tr|ul|ol)>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '• ')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => {
            const code = Number(n)
            try { return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '' }
            catch { return '' }
        })
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function getInlineKeyboardRows(keyboard) {
    if (!keyboard) return []
    let value = keyboard.reply_markup || keyboard
    if (typeof keyboard.toJSON === 'function') {
        try { value = keyboard.toJSON().reply_markup || keyboard.toJSON() || value } catch {}
    }
    const rows = value?.inline_keyboard
    return Array.isArray(rows) ? rows.filter(Array.isArray) : []
}

function guessRichButtonStyle(label) {
    const value = String(label || '').toLowerCase()
    if (/\b(batal|hapus|cancel|delete|tolak|keluar|refund)\b|❌|🗑/.test(value)) return 'danger'
    if (/\b(beli|bayar|deposit|lanjut|konfirmasi|cek saldo|refresh|menu utama)\b|✅|💳|🛒/.test(value)) return 'success'
    return 'primary'
}

function richKeyboardBlocks(keyboard) {
    const rows = getInlineKeyboardRows(keyboard)
    const blocks = []
    for (const row of rows) {
        const buttons = []
        for (const button of row.slice(0, 8)) {
            if (!button || typeof button !== 'object' || !button.text) continue
            const item = { text: String(button.text).slice(0, 64) }
            if (button.url && /^https?:\/\//i.test(String(button.url))) {
                item.url = String(button.url)
                item.style = 'link'
            } else if (button.callback_data != null || button.callbackData != null) {
                const callback = String(button.callback_data ?? button.callbackData)
                if (!callback || Buffer.byteLength(callback, 'utf8') > 64) continue
                item.callback_data = callback
                item.style = ['danger', 'success', 'primary'].includes(button.style)
                    ? button.style : guessRichButtonStyle(button.text)
            } else if (button.switch_inline_query != null) {
                item.switch_inline_query = String(button.switch_inline_query)
            } else if (button.switch_inline_query_current_chat != null) {
                item.switch_inline_query_current_chat = String(button.switch_inline_query_current_chat)
            } else {
                continue
            }
            buttons.push(item)
        }
        if (buttons.length) blocks.push({ type: 'buttons', align: 'center', buttons })
    }
    return blocks
}

function richRowsForStage(stage, details = {}) {
    const key = String(stage || '').toLowerCase()
    const money = value => {
        const n = Number(value)
        return Number.isFinite(n) ? n.toLocaleString('id-ID') : String(value ?? '-')
    }
    if (key === 'deposit_menu') return [
        ['Saldo saat ini', `Rp${money(details.balance)}`],
        ['Minimal deposit', `Rp${money(details.minimum)}`],
        ['Maksimal deposit', `Rp${money(details.maximum)}`],
        ['Metode', details.gateway || '-'],
        ['Tagihan pending', details.pendingCount ?? 0]
    ]
    if (key === 'store_catalog') return (details.products || []).map((product, index) => [
        Number(details.startIndex || 0) + index + 1,
        product.name || product.key || 'Produk',
        `Rp${money(product.price)}`,
        Number(product.stock ?? product.stockCount ?? 1) > 0 ? Number(product.stock ?? product.stockCount ?? 1) : 'Habis'
    ]).map((row, i) => i === 0 ? row : row)
    if (key === 'store_product' || key === 'store_checkout') {
        const product = details.product || {}
        const rows = [
            ['Produk', product.name || 'Produk'],
            ['Harga', `Rp${money(product.price)}`],
            ['Stok', Number(product.stock ?? product.stockCount ?? 1) > 0 ? Number(product.stock ?? product.stockCount ?? 1) : 'Habis']
        ]
        if (product.description) rows.push(['Deskripsi', String(product.description).slice(0, 240)])
        return rows
    }
    if (key === 'store_orders') return (details.orders || []).map((order, index) => [
        index + 1,
        order.productName || 'Produk',
        `Rp${money(order.price)}`,
        String(order.paymentStatus || order.status || '-').toUpperCase()
    ])
    if (key === 'nokos_services') return (details.services || []).slice(0, 18).map(service => [
        service.name || service.code || '-', service.code || '-'
    ])
    if (key === 'nokos_country') return (details.countries || []).map(country => [
        country.flag || '🏳️', country.providerName ? country.name : `Country ID ${country.id}`,
        country.prefix || '-', country.id ?? '-'
    ])
    if (key === 'nokos_servers') return (details.servers || []).slice(0, 18).map((server, index) => [
        server.provider || `Server ${index + 1}`,
        `Rp${money(server.sellingPrice ?? server.cost)}`,
        server.stock == null ? 'N/A' : server.stock
    ])
    if (key === 'nokos_server') return [
        ['Negara', details.countryName || '-'],
        ['Service', details.service || '-'],
        ['Server', details.provider || '-'],
        ['Provider ID', details.providerId || '-'],
        ['Stok', details.stock ?? 'Tidak diketahui'],
        ['Harga jual', `Rp${money(details.sellingPrice)}`]
    ]
    if (key === 'topup_games') return (details.games || []).map(game => [game.label || game.game || '-', game.count ?? 0])
    if (key === 'topup_products') return (details.products || []).map(product => [
        product.name || 'Produk', `Rp${money(product.sellingPrice ?? product.price)}`
    ])
    if (key === 'topup_confirm') return [
        ['Game', details.gameName || details.game || '-'],
        ['Produk', details.productName || '-'],
        ['Harga', `Rp${money(details.price)}`],
        ['Saldo', `Rp${money(details.balance)}`]
    ]
    if (key === 'admin_panel') return [
        ['Produk', details.products ?? '-'], ['Total order', details.orders ?? '-'],
        ['Pending', details.pending ?? '-'], ['Revenue', `Rp${money(details.revenue)}`]
    ]

    // Untuk layar detail/status lain, tampilkan field scalar sebagai tabel key-value.
    const rows = []
    for (const [name, value] of Object.entries(details || {})) {
        if (value == null || Array.isArray(value) || (typeof value === 'object')) continue
        const label = name.replace(/([A-Z])/g, ' $1').replace(/[_-]+/g, ' ').trim()
        rows.push([label.charAt(0).toUpperCase() + label.slice(1), String(value).slice(0, 180)])
        if (rows.length >= 10) break
    }
    return rows.length >= 2 ? rows : []
}

function legacyTextToRichMessage(ctx, text, keyboard = null, { stage = 'menu', details = {}, hero = false } = {}) {
    const plain = htmlToRichPlainText(text).slice(0, 12000)
    const lines = plain.split('\n')
    const title = (lines.find(line => line.trim()) || 'XERYUU-MD').trim().slice(0, 180)
    const remaining = lines.slice(Math.max(1, lines.findIndex(line => line.trim()) + 1))
    const dataRows = richRowsForStage(stage, details)
    const blocks = []
    if (hero) blocks.push(...richHeroBlocks())
    blocks.push({ type: 'heading', text: title, size: 2 })

    // Untuk menu yang memiliki table native, ringkaskan teks pendamping agar data
    // tidak ditampilkan dua kali; semua data tetap tersedia di tabel dan tombol.
    let bodyLines = remaining
    if (dataRows.length) {
        const keep = []
        for (const line of remaining) {
            const trimmed = line.trim()
            if (!trimmed) continue
            if (/^(?:\d+[.)]\s|[━─═╭╰┏┗┓┛╔╗╚╝])/u.test(trimmed)) break
            keep.push(trimmed)
            if (keep.length >= 4) break
        }
        bodyLines = keep
    }
    const body = bodyLines.join('\n').trim()
    if (body) {
        for (let offset = 0; offset < body.length; offset += 850) {
            blocks.push({ type: 'paragraph', text: body.slice(offset, offset + 850) })
            if (blocks.length > 20) break
        }
    }
    if (dataRows.length) {
        let headers = ['DETAIL', 'NILAI']
        if (['store_catalog'].includes(String(stage).toLowerCase())) headers = ['NO', 'PRODUK', 'HARGA', 'STOK']
        else if (['store_orders'].includes(String(stage).toLowerCase())) headers = ['NO', 'PRODUK', 'HARGA', 'STATUS']
        else if (['nokos_services'].includes(String(stage).toLowerCase())) headers = ['SERVICE', 'KODE']
        else if (['nokos_country'].includes(String(stage).toLowerCase())) headers = ['FLAG', 'NEGARA', 'PREFIX', 'ID']
        else if (['nokos_servers'].includes(String(stage).toLowerCase())) headers = ['SERVER', 'HARGA JUAL', 'STOK']
        else if (['topup_games'].includes(String(stage).toLowerCase())) headers = ['GAME', 'PRODUK']
        else if (['topup_products'].includes(String(stage).toLowerCase())) headers = ['NOMINAL', 'HARGA']
        blocks.push(makeRichTable(headers, dataRows.slice(0, 24), { striped: true, compact: true, caption: String(stage || 'DETAIL').replace(/[_-]+/g, ' ').toUpperCase() }))
    }
    blocks.push(...richKeyboardBlocks(keyboard))
    blocks.push({ type: 'footer', text: 'Xeryuu-Md V16 × Sendrich • pilih tombol untuk melanjutkan' })
    return { blocks }
}

async function tryRenderRichMenu(ctx, text, keyboard = null, options = {}) {
    const tgId = String(ctx?.from?.id || '')
    const session = getUi(tgId)
    const chatId = ctx?.callbackQuery?.message?.chat?.id ?? ctx?.chat?.id ?? session?.chatId
    const edit = options.edit == null
        ? Boolean(ctx?.callbackQuery || (session?.messageId && session?.chatId != null && String(session.chatId) === String(chatId)))
        : Boolean(options.edit)
    const rich = legacyTextToRichMessage(ctx, text, keyboard, options)
    const sent = await sendOrEditRichMessage(ctx, rich, { edit })
    if (tgId) {
        const sentChatId = sent?.chat?.id ?? chatId
        const sentMessageId = sent?.message_id ?? ctx?.callbackQuery?.message?.message_id ?? session?.messageId
        setUi(tgId, {
            chatId: sentChatId,
            messageId: sentMessageId,
            messageType: 'rich',
            screen: String(options.stage || session?.screen || 'rich')
        })
    }
    return sent || null
}

function telegramChatIdForUi(ctx, edit, session) {
    if (ctx?.callbackQuery?.message?.chat?.id != null) return ctx.callbackQuery.message.chat.id
    if (edit && ctx?.chat?.id != null) return ctx.chat.id
    if (ctx?.chat?.id != null) return ctx.chat.id
    return session?.chatId
}

async function sendOrEditRichMessage(ctx, richMessage, { edit = false } = {}) {
    const tgId = String(ctx.from?.id || '')
    const session = getUi(tgId)
    const chatId = telegramChatIdForUi(ctx, edit, session)
    if (chatId == null) throw new Error('Chat Telegram tidak tersedia untuk Rich Message.')

    const callbackMessage = ctx.callbackQuery?.message
    const sameChatSession = session?.chatId != null && String(session.chatId) === String(chatId)
    const messageId = callbackMessage?.message_id || (edit && sameChatSession ? session?.messageId : null)
    const currentIsPhoto = callbackMessage
        ? Boolean(callbackMessage.photo?.length)
        : Boolean(sameChatSession && session?.messageType === 'photo')

    if (edit && messageId && (sameChatSession || callbackMessage)) {
        if (currentIsPhoto) {
            try { await ctx.telegram.deleteMessage(chatId, messageId) } catch (error) {
                const reason = String(error?.description || error?.message || error).toLowerCase()
                if (!reason.includes('message to delete not found') && !reason.includes("message can't be deleted")) {
                    console.error('[TELEGRAM RICH EDIT DELETE]', error?.description || error?.message || error)
                }
            }
        } else {
            let editError = null
            for (let attempt = 0; attempt < 2; attempt++) {
                await waitTelegramEditSlot(chatId)
                try {
                    const updated = await ctx.telegram.callApi('editMessageText', {
                        chat_id: chatId,
                        message_id: messageId,
                        rich_message: richMessage
                    })
                    if (privateChat(ctx) && ctx.from?.id) {
                        setUi(ctx.from.id, { chatId, messageId, messageType: 'rich' })
                    }
                    return updated
                } catch (error) {
                    editError = error
                    if (/message is not modified/i.test(String(error?.description || error?.message || error))) {
                        if (privateChat(ctx) && ctx.from?.id) setUi(ctx.from.id, { chatId, messageId, messageType: 'rich' })
                        return callbackMessage || null
                    }
                    if (isTelegramRateLimitError(error) && attempt === 0) {
                        setTelegramRateLimit(error)
                        continue
                    }
                    break
                }
            }
            if (isTelegramRateLimitError(editError)) throw editError
            console.error('[TELEGRAM RICH EDIT FALLBACK]', editError?.description || editError?.message || editError)
            try { await ctx.telegram.deleteMessage(chatId, messageId) } catch {}
        }
    }

    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
        await waitTelegramEditSlot(chatId)
        try {
            const sent = await ctx.telegram.callApi('sendRichMessage', {
                chat_id: chatId,
                rich_message: richMessage,
                disable_notification: false
            })
            if (privateChat(ctx) && ctx.from?.id) {
                setUi(ctx.from.id, {
                    chatId: sent.chat?.id ?? chatId,
                    messageId: sent.message_id,
                    messageType: 'rich',
                    screen: getUi(ctx.from.id)?.screen || 'rich'
                })
            }
            return sent
        } catch (error) {
            lastError = error
            if (!isTelegramRateLimitError(error) || attempt > 0) break
            setTelegramRateLimit(error)
        }
    }
    if (isTelegramRateLimitError(lastError)) setTelegramRateLimit(lastError)
    throw lastError
}

async function trySendRichDraft(ctx) {
    if (!privateChat(ctx) || !ctx?.chat?.id) return
    try {
        richDraftCounter = richDraftCounter >= 2147483000 ? 1 : richDraftCounter + 1
        await ctx.telegram.callApi('sendRichMessageDraft', {
            chat_id: ctx.chat.id,
            draft_id: richDraftCounter,
            rich_message: { blocks: [{ type: 'thinking', text: 'Menyiapkan dashboard Xeryuu...' }] }
        })
    } catch (error) {
        // Drafts are an enhancement only; the persistent rich message is still sent below.
        console.warn('[TELEGRAM RICH DRAFT]', error?.description || error?.message || error)
    }
}

function richHeroBlocks() {
    const imageUrl = telegramStartImageUrl()
    return imageUrl ? [{ type: 'photo', photo: { type: 'photo', media: imageUrl } }] : []
}

function richHomeBlocks(ctx) {
    const stats = autoOrderStats()
    const jid = getTransactionJid(ctx)
    const balance = jid ? economy.getBalance(jid) : 0
    const name = String(ctx.from?.first_name || 'User')
    const blocks = [
        ...richHeroBlocks(),
        { type: 'heading', text: `WELCOME, ${name}!`, size: 2 },
        { type: 'paragraph', text: '🐬 Xeryuu-Md V16 × Sendrich • AUTO ORDER DIGITAL SERVICE\nFast • Stable • Powerful' },
        { type: 'divider' },
        makeRichTable(['RINGKASAN', 'TOTAL'], [
            ['👥 Pengguna', stats.users],
            ['📦 Produk tersedia', stats.products.length],
            ['✅ Transaksi sukses', stats.paid],
            ['💳 Saldo akun', `Rp${economy.formatMoney(balance)}`]
        ], { caption: 'STATISTIK XERYUU', striped: true }),
        { type: 'paragraph', text: 'Pilih layanan yang ingin kamu buka. Navigasi di bawah ini menggunakan tombol Rich Message Telegram.' },
        richButtonBlock([
            makeRichButton('🖥 VPS & SERVER', 'tg_home_store'),
            makeRichButton('📱 NOKOS', 'tg_home_nokos')
        ]),
        richButtonBlock([
            makeRichButton('🎮 TOP UP GAME', 'tg_home_topup'),
            makeRichButton('👤 PROFILE', 'tg_home_profile')
        ]),
        richButtonBlock([
            makeRichButton('📦 PESANAN SAYA', 'tg_store_orders'),
            makeRichButton('💳 DEPOSIT', 'tg_home_deposit')
        ]),
        richButtonBlock([
            makeRichButton('💱 CONVERT PULSA', 'tg_home_convertpulsa', 'success'),
            makeRichButton('💰 CEK SALDO', 'tg_home_balance')
        ]),
        richButtonBlock([makeRichButton('💝 DONASI', 'tg_home_donasi', 'success')]),
        richButtonBlock([makeRichButton('🎨 SEMUA RICH UI', 'tg_rich_showcase')])
    ]
    const channelUrl = String(global.telegramConfig?.forceJoinUrl || '').trim()
    if (/^https?:\/\//i.test(channelUrl)) blocks.push(richButtonBlock([makeRichUrlButton('📢 CHANNEL XERYUU', channelUrl)]))

    const owner = String(global.owner || '').replace(/\D/g, '')
    const linked = getJid(ctx)?.replace(/\D/g, '')
    const adminIds = Array.isArray(global.telegramConfig?.adminIds) ? global.telegramConfig.adminIds.map(String) : []
    const isAdmin = adminIds.includes(String(ctx?.from?.id || '')) || Boolean(owner && linked === owner)
    if (isAdmin) blocks.push(richButtonBlock([makeRichButton('👑 ADMIN PANEL', 'tg_admin_panel', 'danger')]))
    blocks.push({ type: 'footer', text: 'Developer: @XnalzNotDev • Xeryuu-Md V16 × Sendrich' })
    return { blocks }
}

async function showRichHome(ctx, { edit = true } = {}) {
    if (ctx?.from?.id != null) setUi(ctx.from.id, { screen: 'home' })
    const session = getUi(ctx.from?.id)
    const chatId = ctx.callbackQuery?.message?.chat?.id ?? ctx.chat?.id
    const sameChat = session?.chatId != null && String(session.chatId) === String(chatId)
    const shouldEdit = Boolean(ctx.callbackQuery || (edit && sameChat && session?.messageId))
    if (!shouldEdit && isTelegramStartCommand(ctx)) await trySendRichDraft(ctx)
    return sendOrEditRichMessage(ctx, richHomeBlocks(ctx), { edit: shouldEdit })
}

async function showHome(ctx, options = {}) {
    try {
        return await showRichHome(ctx, options)
    } catch (error) {
        console.error('[TELEGRAM RICH HOME FALLBACK]', error?.description || error?.message || error)
        return showHomeLegacy(ctx, options)
    }
}

function richShowcaseKeyboard() {
    return Markup.inlineKeyboard([
        [Markup.button.callback('📊 1. TABEL INTERAKTIF', 'tg_rich_demo:table')],
        [Markup.button.callback('💎 2. KARTU RICH MESSAGE', 'tg_rich_demo:card')],
        [Markup.button.callback('🚀 3. DASHBOARD PREMIUM', 'tg_rich_demo:dashboard')],
        [Markup.button.callback('🏠 KEMBALI KE MENU', 'tg_home')]
    ])
}

async function editTrackedText(ctx, text, keyboard = null) {
    const session = getUi(ctx.from?.id)
    const isPhoto = currentMessageIsPhoto(ctx, session)
    if (!isPhoto) return editTracked(ctx, text, keyboard)

    // Telegram cannot turn a photo message into a plain text message through editMessageText.
    // Replace the tracked photo with a text message so table-style output stays readable.
    const chatId = ctx.callbackQuery?.message?.chat?.id || session?.chatId || ctx.chat?.id
    const messageId = ctx.callbackQuery?.message?.message_id || session?.messageId
    if (isTelegramCommandMessage(ctx) && !isTelegramStartCommand(ctx)) {
        return sendCommandReply(ctx, text, keyboard)
    }
    // Ketika callback berpindah dari kartu bergambar ke daftar/tabel, coba
    // kirim Rich Message native sebelum jatuh ke pesan teks biasa.
    const richSent = await tryRenderRichMenu(ctx, text, keyboard, {
        stage: getUi(ctx.from?.id)?.screen || 'menu', edit: Boolean(chatId && messageId), hero: false
    }).catch(error => {
        console.warn('[TELEGRAM PHOTO TO RICH FALLBACK]', error?.description || error?.message || error)
        return null
    })
    if (richSent) return richSent
    if (chatId && messageId) {
        try { await ctx.telegram.deleteMessage(chatId, messageId) } catch (error) {
            const reason = String(error?.description || error?.message || error).toLowerCase()
            if (!reason.includes('message to delete not found') && !reason.includes("message can't be deleted")) {
                console.error('[TELEGRAM RICH UI REPLACE]', error?.description || error?.message || error)
            }
        }
    }
    const sent = await ctx.telegram.sendMessage(chatId || ctx.chat?.id, String(text || ''), { parse_mode: 'HTML', ...(keyboard || {}) })
    if (privateChat(ctx) && ctx.from?.id) {
        setUi(ctx.from.id, { chatId: sent.chat.id, messageId: sent.message_id, messageType: 'text' })
        markTelegramRender(ctx.from.id, telegramRenderKey('text', text, keyboard))
    }
    return sent
}

async function showRichShowcase(ctx) {
    const richMessage = {
        blocks: [
            ...richHeroBlocks(),
            { type: 'heading', text: 'XERYUU • RICH UI SHOWCASE', size: 2 },
            { type: 'paragraph', text: 'Pilih salah satu dari tiga format Rich Message di bawah ini. Setiap tampilan dibuat dengan struktur native Rich Message Telegram.' },
            { type: 'divider' },
            makeRichTable(['FORMAT', 'FITUR'], [
                ['📊 Tabel interaktif', 'Kolom, baris, tombol aksi'],
                ['💎 Kartu Rich', 'Banner, informasi, CTA'],
                ['🚀 Dashboard Premium', 'Statistik, rincian, navigasi']
            ], { caption: 'PILIH TAMPILAN', striped: true }),
            richButtonBlock([makeRichButton('📊 TABEL INTERAKTIF', 'tg_rich_demo:table')]),
            richButtonBlock([makeRichButton('💎 KARTU RICH', 'tg_rich_demo:card')]),
            richButtonBlock([makeRichButton('🚀 DASHBOARD PREMIUM', 'tg_rich_demo:dashboard')]),
            richButtonBlock([makeRichButton('🏠 KEMBALI KE MENU', 'tg_home', 'success')])
        ]
    }
    setUi(ctx.from.id, { screen: 'rich_showcase' })
    try {
        return await sendOrEditRichMessage(ctx, richMessage, { edit: Boolean(ctx.callbackQuery) })
    } catch (error) {
        console.error('[TELEGRAM RICH SHOWCASE FALLBACK]', error?.description || error?.message || error)
        return showRichShowcaseLegacy(ctx)
    }
}

async function renderRichDemo(ctx, mode) {
    const stats = autoOrderStats()
    const displayName = String(ctx.from?.first_name || 'User')
    const blocks = [...richHeroBlocks()]

    if (mode === 'table') {
        const products = storeService.products()
        const shown = products.slice(0, 6)
        setUi(ctx.from.id, {
            screen: 'store', storeProducts: products, storeAllProducts: products,
            storePage: 0, storeCategory: 'all'
        })
        blocks.push(
            { type: 'heading', text: 'TABEL PRODUK INTERAKTIF', size: 2 },
            { type: 'paragraph', text: `Katalog Xeryuu • ${shown.length} dari ${products.length} produk. Tekan tombol Beli di dalam tabel untuk membuka detail produk.` },
            {
                type: 'table',
                is_bordered: true,
                is_striped: true,
                is_compact: true,
                caption: 'PRODUK TERSEDIA',
                cells: [
                    [
                        { text: 'NO', is_header: true, align: 'center' },
                        { text: 'LAYANAN', is_header: true },
                        { text: 'HARGA', is_header: true, align: 'right' },
                        { text: 'STOK', is_header: true, align: 'center' },
                        { text: 'AKSI', is_header: true, align: 'center' }
                    ],
                    ...shown.map((product, index) => {
                        const stock = Number(product.stock ?? product.stockCount ?? 1)
                        return [
                            { text: String(index + 1), align: 'center' },
                            { text: String(product.name || 'Produk') },
                            { text: `Rp${storeService.formatMoney(product.price)}`, align: 'right' },
                            { text: stock > 0 ? String(stock) : 'Habis', align: 'center' },
                            { text: [{ type: 'button', button: makeRichButton('Beli', `tg_store_product:${index}`, 'success') }], align: 'center' }
                        ]
                    })
                ]
            },
            { type: 'paragraph', text: shown.length ? 'Tombol Beli pada setiap baris terhubung ke detail produk Xeryuu.' : 'Katalog masih kosong. Tambahkan produk terlebih dahulu melalui konfigurasi store.' },
            richButtonBlock([makeRichButton('📦 KATALOG LENGKAP', 'tg_store_category:all')]),
            richButtonBlock([makeRichButton('🔙 VARIASI RICH UI', 'tg_rich_showcase'), makeRichButton('🏠 MENU', 'tg_home', 'success')])
        )
    } else if (mode === 'card') {
        blocks.push(
            { type: 'heading', text: `WELCOME, ${displayName}!`, size: 2 },
            { type: 'paragraph', text: '💎 Xeryuu-Md V16 × Sendrich\nLayanan digital dengan pemesanan otomatis, pelacakan status transaksi, dan tombol navigasi yang responsif.' },
            { type: 'divider' },
            makeRichTable(['INFORMASI', 'STATUS'], [
                ['📦 Produk', stats.products.length],
                ['✅ Transaksi sukses', stats.paid],
                ['👥 Pengguna', stats.users],
                ['🟢 Bot', 'Online']
            ], { caption: 'RINGKASAN LAYANAN', striped: true }),
            richButtonBlock([makeRichButton('🛒 STORE', 'tg_home_store'), makeRichButton('💳 DEPOSIT', 'tg_home_deposit')]),
            richButtonBlock([makeRichButton('📱 NOKOS', 'tg_home_nokos'), makeRichButton('🎮 TOP UP', 'tg_home_topup')]),
            richButtonBlock([makeRichButton('🔙 VARIASI RICH UI', 'tg_rich_showcase'), makeRichButton('🏠 MENU', 'tg_home', 'success')])
        )
        const channelUrl = String(global.telegramConfig?.forceJoinUrl || '').trim()
        if (/^https?:\/\//i.test(channelUrl)) blocks.push(richButtonBlock([makeRichUrlButton('📢 BUKA CHANNEL XERYUU', channelUrl)]))
    } else if (mode === 'dashboard') {
        const orderStats = stats.orders || []
        const paid = orderStats.filter(order => ['PAID', 'PAID_WAITING_FULFILLMENT', 'PROCESSING', 'DONE'].includes(String(order.status || '').toUpperCase()) || String(order.paymentStatus || '').toUpperCase() === 'PAID').length
        const pending = orderStats.filter(order => !['DONE', 'CANCELED', 'PAYMENT_FAILED'].includes(String(order.status || '').toUpperCase()) && String(order.paymentStatus || '').toUpperCase() !== 'PAID').length
        blocks.push(
            { type: 'heading', text: 'XERYUU • PREMIUM DASHBOARD', size: 2 },
            { type: 'paragraph', text: `👤 Halo ${displayName}!\n🚀 Status sistem: Online\n⚡ Ringkasan langsung dari data bot.` },
            makeRichTable(['METRIK', 'NILAI'], [
                ['👥 Total pengguna', stats.users],
                ['📦 Produk aktif', stats.products.length],
                ['🧾 Total order', orderStats.length],
                ['✅ Order sukses', paid],
                ['⏳ Order pending', pending]
            ], { caption: 'SYSTEM OVERVIEW', striped: true }),
            {
                type: 'details',
                summary: '📈 Lihat status sistem',
                is_open: false,
                blocks: [
                    { type: 'paragraph', text: 'Pilih panel cepat di bawah untuk membuka fitur terkait. Status online menunjukkan proses bot berjalan, bukan jaminan bahwa setiap provider eksternal sedang tersedia.' },
                    makeRichTable(['LAYANAN', 'AKSI'], [
                        ['Store', { richText: [{ type: 'button', button: makeRichButton('Buka', 'tg_home_store') }] }],
                        ['Nokos', { richText: [{ type: 'button', button: makeRichButton('Buka', 'tg_home_nokos') }] }],
                        ['Top Up', { richText: [{ type: 'button', button: makeRichButton('Buka', 'tg_home_topup') }] }]
                    ], { striped: true, compact: true })
                ]
            },
            richButtonBlock([makeRichButton('📦 STORE', 'tg_home_store'), makeRichButton('📱 NOKOS', 'tg_home_nokos')]),
            richButtonBlock([makeRichButton('🎮 TOP UP', 'tg_home_topup'), makeRichButton('💰 SALDO', 'tg_home_balance')]),
            richButtonBlock([makeRichButton('🔙 VARIASI RICH UI', 'tg_rich_showcase'), makeRichButton('🏠 MENU', 'tg_home', 'success')])
        )
    } else {
        return showRichShowcase(ctx)
    }

    const richMessage = { blocks }
    try {
        return await sendOrEditRichMessage(ctx, richMessage, { edit: Boolean(ctx.callbackQuery) })
    } catch (error) {
        console.error(`[TELEGRAM RICH ${String(mode).toUpperCase()} FALLBACK]`, error?.description || error?.message || error)
        return renderRichDemoLegacy(ctx, mode)
    }
}

async function showRichShowcaseLegacy(ctx) {
    setUi(ctx.from.id, { screen: 'rich_showcase' })
    const text =
        `<blockquote>🎨 <b>XERYUU • RICH UI SHOWCASE</b></blockquote>\n` +
        `Pilih format tampilan yang ingin dibuka. Semua contoh memakai fitur resmi Telegram Bot API agar kompatibel dengan bot Telegram biasa.\n\n` +
        `📊 <b>Tabel interaktif</b> — data rapi dan tombol pilih produk.\n` +
        `💎 <b>Kartu Rich</b> — banner, deskripsi, dan tombol aksi.\n` +
        `🚀 <b>Dashboard premium</b> — ringkasan statistik dan akses cepat.\n\n` +
        `<i>Catatan: tabel dibuat dari teks terformat + inline keyboard, bukan elemen HTML table native.</i>`
    return editTrackedText(ctx, text, richShowcaseKeyboard())
}

function fitCell(value, width) {
    const clean = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim()
    const chars = Array.from(clean)
    const clipped = chars.length > width ? chars.slice(0, Math.max(1, width - 1)).join('') + '…' : clean
    return clipped.padEnd(width, ' ')
}

async function renderRichDemoLegacy(ctx, mode) {
    const stats = autoOrderStats()
    const displayName = escapeHtml(ctx.from?.first_name || 'User')

    if (mode === 'table') {
        const products = storeService.products()
        const shown = products.slice(0, 6)
        setUi(ctx.from.id, {
            screen: 'store', storeProducts: products, storeAllProducts: products,
            storePage: 0, storeCategory: 'all'
        })

        const lines = [
            `${fitCell('NO', 3)} ${fitCell('LAYANAN', 21)} ${fitCell('HARGA', 13)} ${fitCell('STOK', 6)}`,
            `${'─'.repeat(3)} ${'─'.repeat(21)} ${'─'.repeat(13)} ${'─'.repeat(6)}`
        ]
        shown.forEach((product, index) => {
            const stock = Number(product.stock ?? product.stockCount ?? 1)
            lines.push(`${fitCell(index + 1, 3)} ${fitCell(product.name || 'Produk', 21)} ${fitCell('Rp' + storeService.formatMoney(product.price), 13)} ${fitCell(stock > 0 ? stock : 'HABIS', 6)}`)
        })
        if (!shown.length) lines.push('Belum ada produk di katalog.')

        const text =
            `<blockquote>📊 <b>TABEL PRODUK INTERAKTIF</b></blockquote>\n` +
            `Katalog Xeryuu • ${shown.length} dari ${products.length} produk\n\n` +
            `<pre>${escapeHtml(lines.join('\n'))}</pre>\n` +
            `Pilih produk melalui tombol di bawah untuk membuka detail dan proses pembelian.`
        const rows = []
        for (let i = 0; i < shown.length; i += 2) {
            const first = shown[i]
            const second = shown[i + 1]
            const row = [Markup.button.callback(`${String(i + 1).padStart(2, '0')} • ${String(first.name || 'Produk').slice(0, 18)}`, `tg_store_product:${i}`)]
            if (second) row.push(Markup.button.callback(`${String(i + 2).padStart(2, '0')} • ${String(second.name || 'Produk').slice(0, 18)}`, `tg_store_product:${i + 1}`))
            rows.push(row)
        }
        rows.push([Markup.button.callback('📦 BUKA KATALOG LENGKAP', 'tg_store_category:all')])
        rows.push([Markup.button.callback('🔙 VARIASI RICH UI', 'tg_rich_showcase'), Markup.button.callback('🏠 MENU', 'tg_home')])
        return editTrackedText(ctx, text, Markup.inlineKeyboard(rows))
    }

    if (mode === 'card') {
        const caption =
            `<blockquote>💎 <b>XERYUU • RICH CARD</b></blockquote>\n` +
            `✨ <b>Selamat datang, ${displayName}!</b>\n\n` +
            `Layanan digital dengan alur pemesanan otomatis, status transaksi, dan navigasi tombol.\n\n` +
            `📦 Produk: <b>${stats.products.length}</b>\n` +
            `✅ Transaksi berhasil: <b>${stats.paid}</b>\n` +
            `👥 Pengguna tercatat: <b>${stats.users}</b>\n\n` +
            `<i>Pilih tombol untuk melanjutkan.</i>`
        const rows = []
        const channelUrl = String(global.telegramConfig?.forceJoinUrl || '').trim()
        if (/^https?:\/\//i.test(channelUrl)) rows.push([Markup.button.url('📢 BUKA CHANNEL', channelUrl)])
        rows.push([Markup.button.callback('🛒 STORE', 'tg_home_store'), Markup.button.callback('💳 DEPOSIT', 'tg_home_deposit')])
        rows.push([Markup.button.callback('🔙 VARIASI RICH UI', 'tg_rich_showcase'), Markup.button.callback('🏠 MENU', 'tg_home')])
        let image = await getStartImageBuffer()
        if (!image) {
            try { image = await makeTelegramHomeDashboard(stats, ctx.from?.first_name || 'User') } catch {}
        }
        if (image) return editTrackedPhoto(ctx, image, caption, Markup.inlineKeyboard(rows))
        return editTrackedText(ctx, caption, Markup.inlineKeyboard(rows))
    }

    if (mode === 'dashboard') {
        let image = null
        try {
            const avatar = await getTelegramProfileAvatarBuffer(ctx)
            image = await makeTelegramHomeDashboard(stats, ctx.from?.first_name || 'User', avatar)
        } catch (error) {
            console.error('[TELEGRAM RICH DASHBOARD]', error?.message || error)
        }
        if (!image) image = await getStartImageBuffer()
        const caption =
            `<blockquote>🚀 <b>XERYUU • PREMIUM DASHBOARD</b></blockquote>\n` +
            `👤 Pengguna: <b>${displayName}</b>\n` +
            `👥 Total user: <b>${stats.users}</b>\n` +
            `📦 Produk tersedia: <b>${stats.products.length}</b>\n` +
            `✅ Transaksi sukses: <b>${stats.paid}</b>\n` +
            `🟢 Status: <b>Online</b>\n\n` +
            `Pilih panel yang ingin dibuka.`
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📦 Store', 'tg_home_store'), Markup.button.callback('📱 Nokos', 'tg_home_nokos')],
            [Markup.button.callback('🎮 Top Up', 'tg_home_topup'), Markup.button.callback('💰 Saldo', 'tg_home_balance')],
            [Markup.button.callback('🔙 VARIASI RICH UI', 'tg_rich_showcase'), Markup.button.callback('🏠 MENU', 'tg_home')]
        ])
        if (image) return editTrackedPhoto(ctx, image, caption, keyboard)
        return editTrackedText(ctx, caption, keyboard)
    }

    return showRichShowcase(ctx)
}

async function sendBalance(ctx) {
    const jid = getTransactionJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const balance = economy.getBalance(jid)
    setUi(ctx.from.id, { screen: 'balance' })
    return editTracked(
        ctx,
        `💰 <blockquote>SALDO XERYUU</blockquote>\n\n` +
        `💳 <b>Saldo Biasa</b>\n` +
        `Rp${escapeHtml(economy.formatMoney(balance))}\n\n` +
        `💡 Jika ingin menambahkan saldo, silahkan deposit terlebih dahulu`,
        Markup.inlineKeyboard([
            [Markup.button.callback('💳 Deposit Saldo', 'tg_home_deposit')],
            [Markup.button.callback('🏠 Menu Utama', 'tg_home')]
        ])
    )
}

async function sendProfile(ctx) {
    const jid = getTransactionJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const user = economy.getUser(jid)
    const balance = economy.getBalance(jid)
    setUi(ctx.from.id, { screen: 'profile' })
    return editTracked(
        ctx,
        `👤 <blockquote>PROFILE XERYUU</blockquote>\n\n` +
        `🆔 Telegram ID: <b>${escapeHtml(jid.slice('telegram:'.length))}</b>\n` +
        `💳 Saldo Biasa: <b>Rp${escapeHtml(economy.formatMoney(balance))}</b>\n` +
        `⭐ EXP: <b>${Number(user.exp || 0)}</b>\n` +
        `🎚️ Level: <b>${Number(user.level || 0)}</b>`,
        backHomeKeyboard()
    )
}

function storeJid(ctx) {
    return getTransactionJid(ctx)
}

function storeCanvasModule() {
    // Canvafy sudah membawa @napi-rs/canvas sebagai dependency. Fallback ke canvas
    // untuk instalasi lama yang memasang node-canvas di root node_modules.
    try { return require('@napi-rs/canvas') } catch {}
    try { return require('canvas') } catch {}
    return null
}

function canvasRoundRect(ctx, x, y, width, height, radius, fill, stroke = null) {
    const r = Math.min(radius, width / 2, height / 2)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + width - r, y)
    ctx.quadraticCurveTo(x + width, y, x + width, y + r)
    ctx.lineTo(x + width, y + height - r)
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
    ctx.lineTo(x + r, y + height)
    ctx.quadraticCurveTo(x, y + height, x, y + height - r)
    ctx.lineTo(x, y + r)
    ctx.quadraticCurveTo(x, y, x + r, y)
    ctx.closePath()
    if (fill) { ctx.fillStyle = fill; ctx.fill() }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke() }
}

function fitCanvasText(ctx, value, maxWidth, startSize = 28, minSize = 17, weight = 700) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim()
    let size = startSize
    while (size > minSize) {
        ctx.font = `${weight} ${size}px Arial, sans-serif`
        if (ctx.measureText(text).width <= maxWidth) break
        size -= 1
    }
    ctx.font = `${weight} ${size}px Arial, sans-serif`
    if (ctx.measureText(text).width > maxWidth && text.length > 4) {
        let shortened = text
        while (shortened.length > 4 && ctx.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1)
        return `${shortened}…`
    }
    return text
}

function drawStoreCardBackground(ctx, stage, title, subtitle = '') {
    const width = 1200
    const height = 675
    const bg = ctx.createLinearGradient(0, 0, width, height)
    bg.addColorStop(0, '#050816')
    bg.addColorStop(0.54, '#07172b')
    bg.addColorStop(1, '#09283a')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    // Grid teknikal halus dan glow untuk identitas kartu auto-order.
    ctx.save()
    ctx.globalAlpha = 0.14
    ctx.strokeStyle = '#20d7ff'
    ctx.lineWidth = 1
    for (let x = 35; x < width; x += 48) {
        ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, height - 20); ctx.stroke()
    }
    for (let y = 28; y < height; y += 48) {
        ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(width - 20, y); ctx.stroke()
    }
    ctx.restore()

    const glow = ctx.createRadialGradient(1040, 40, 20, 1040, 40, 440)
    glow.addColorStop(0, 'rgba(0, 218, 255, 0.22)')
    glow.addColorStop(1, 'rgba(0, 218, 255, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(620, 0, 580, 400)

    canvasRoundRect(ctx, 24, 24, width - 48, height - 48, 22, 'rgba(4, 12, 27, 0.55)', 'rgba(31, 214, 255, 0.8)')
    ctx.fillStyle = '#29d9ff'
    ctx.fillRect(48, 48, 5, 50)
    ctx.fillStyle = '#f4fbff'
    ctx.font = '700 19px Arial, sans-serif'
    ctx.fillText('XNALZ', 66, 64)
    ctx.fillStyle = '#86a8bd'
    ctx.font = '500 14px Arial, sans-serif'
    ctx.fillText('AUTO ORDER SYSTEM', 66, 86)

    const tag = String(stage || 'ORDER').toUpperCase().replace(/_/g, ' ')
    ctx.font = '700 14px Arial, sans-serif'
    const tagWidth = Math.max(120, ctx.measureText(tag).width + 34)
    canvasRoundRect(ctx, width - tagWidth - 55, 48, tagWidth, 34, 17, 'rgba(0, 200, 235, 0.13)', 'rgba(35, 216, 255, 0.7)')
    ctx.fillStyle = '#71eaff'
    ctx.fillText(tag, width - tagWidth - 38, 70)

    ctx.fillStyle = '#f4fbff'
    ctx.font = '800 37px Arial, sans-serif'
    ctx.fillText(String(title || '').slice(0, 42), 56, 145)
    if (subtitle) {
        ctx.fillStyle = '#9bb8ca'
        ctx.font = '500 18px Arial, sans-serif'
        ctx.fillText(String(subtitle).slice(0, 95), 58, 177)
    }
    ctx.fillStyle = '#29d9ff'
    ctx.fillRect(56, 190, 72, 4)
    ctx.fillStyle = 'rgba(113, 234, 255, 0.8)'
    ctx.font = '500 13px Arial, sans-serif'
    ctx.fillText('XERYUU-MD  •  PREMIUM DIGITAL SERVICE', 58, height - 40)
    ctx.fillStyle = '#6b8da2'
    ctx.textAlign = 'right'
    ctx.fillText('SECURE ORDER FLOW', width - 58, height - 40)
    ctx.textAlign = 'left'
}

function drawStoreInfoRow(ctx, x, y, label, value, width = 480, accent = '#24d8ff') {
    canvasRoundRect(ctx, x, y, width, 66, 12, 'rgba(10, 31, 52, 0.92)', 'rgba(91, 145, 175, 0.28)')
    canvasRoundRect(ctx, x + 12, y + 12, 4, 42, 2, accent)
    ctx.fillStyle = '#8daec2'
    ctx.font = '600 13px Arial, sans-serif'
    ctx.fillText(String(label || '').toUpperCase().slice(0, 35), x + 28, y + 25)
    ctx.fillStyle = '#f2fbff'
    ctx.font = '700 21px Arial, sans-serif'
    ctx.fillText(fitCanvasText(ctx, value || '-', width - 52, 21, 14, 700), x + 28, y + 50)
}

async function makeTelegramStoreCard(stage, details = {}) {
    const canvasLib = storeCanvasModule()
    if (!canvasLib?.createCanvas) throw new Error('Canvas renderer tidak tersedia; jalankan npm install untuk memasang dependency canvafy.')
    const { createCanvas, loadImage } = canvasLib
    const canvas = createCanvas(1200, 675)
    const ctx = canvas.getContext('2d')
    const money = value => `Rp${Number(value || 0).toLocaleString('id-ID')}`
    const stageKey = String(stage || '').toLowerCase()

    if (stageKey === 'catalog') {
        const category = String(details.categoryTitle || 'SEMUA PRODUK')
        drawStoreCardBackground(ctx, 'KATALOG PRODUK', 'PILIH PRODUK', `${category}  •  ${Number(details.total || 0)} produk tersedia`)
        const items = Array.isArray(details.products) ? details.products : []
        if (!items.length) {
            canvasRoundRect(ctx, 58, 225, 1084, 310, 20, 'rgba(9, 28, 48, 0.94)', 'rgba(50, 196, 230, 0.42)')
            ctx.fillStyle = '#f4fbff'; ctx.font = '700 30px Arial, sans-serif'; ctx.fillText('BELUM ADA PRODUK', 92, 300)
            ctx.fillStyle = '#9ab4c7'; ctx.font = '500 21px Arial, sans-serif'; ctx.fillText('Pilih kategori lain untuk melihat katalog.', 92, 342)
        } else {
            items.slice(0, 6).forEach((product, i) => {
                const col = i % 2
                const row = Math.floor(i / 2)
                const x = 56 + col * 548
                const y = 211 + row * 137
                const width = 528
                const stock = Number(product.stock ?? product.stockCount ?? 1)
                canvasRoundRect(ctx, x, y, width, 122, 15, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.38)')
                canvasRoundRect(ctx, x + 16, y + 18, 54, 54, 12, 'rgba(0, 204, 239, 0.15)', 'rgba(37, 213, 255, 0.55)')
                ctx.fillStyle = '#5fe8ff'; ctx.font = '800 19px Arial, sans-serif'
                ctx.fillText(String(Number(details.startIndex || 0) + i + 1).padStart(2, '0'), x + 25, y + 51)
                ctx.fillStyle = '#effaff'
                ctx.font = `700 ${String(product.name || '').length > 24 ? 19 : 23}px Arial, sans-serif`
                ctx.fillText(fitCanvasText(ctx, product.name || 'Produk', width - 103, String(product.name || '').length > 24 ? 19 : 23, 15, 700), x + 88, y + 37)
                ctx.fillStyle = '#60e9ff'; ctx.font = '800 23px Arial, sans-serif'
                ctx.fillText(fitCanvasText(ctx, money(product.price), 210, 23, 17, 800), x + 88, y + 72)
                ctx.fillStyle = stock > 0 ? '#7bf0b2' : '#ff9292'
                ctx.font = '600 14px Arial, sans-serif'
                ctx.fillText(stock > 0 ? `STOK ${stock} UNIT` : 'STOK HABIS', x + 88, y + 99)
                ctx.fillStyle = '#7897aa'; ctx.font = '500 12px Arial, sans-serif'
                ctx.fillText(String(product.type || product.category || 'DIGITAL PRODUCT').toUpperCase().slice(0, 24), x + width - 175, y + 99)
            })
        }
        ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'
        ctx.fillText(`Halaman ${Number(details.page || 0) + 1}/${Number(details.pages || 1)}  •  Transaksi sukses ${Number(details.paid || 0)}`, 58, 625)
    } else if (stageKey === 'product') {
        const product = details.product || {}
        const stock = Number(product.stock ?? product.stockCount ?? 1)
        drawStoreCardBackground(ctx, 'DETAIL PRODUK', 'INFORMASI PRODUK', String(product.category || product.type || 'PREMIUM DIGITAL SERVICE'))
        canvasRoundRect(ctx, 58, 215, 1084, 348, 20, 'rgba(7, 25, 44, 0.94)', 'rgba(43, 201, 234, 0.46)')
        ctx.fillStyle = '#8caec1'; ctx.font = '700 15px Arial, sans-serif'; ctx.fillText('NAMA PRODUK', 90, 258)
        ctx.fillStyle = '#f4fbff'; ctx.font = `800 ${String(product.name || '').length > 27 ? 31 : 39}px Arial, sans-serif`
        ctx.fillText(fitCanvasText(ctx, product.name || 'Produk', 1000, String(product.name || '').length > 27 ? 31 : 39, 22, 800), 90, 306)
        ctx.fillStyle = '#64eaff'; ctx.font = '800 42px Arial, sans-serif'; ctx.fillText(money(product.price), 90, 372)
        const stockColor = stock > 0 ? '#77efb0' : '#ff8c8c'
        canvasRoundRect(ctx, 90, 398, 240, 42, 21, stock > 0 ? 'rgba(20, 155, 103, 0.18)' : 'rgba(220, 54, 72, 0.18)', stock > 0 ? 'rgba(87, 238, 172, 0.6)' : 'rgba(255, 120, 120, 0.6)')
        ctx.fillStyle = stockColor; ctx.font = '700 16px Arial, sans-serif'; ctx.fillText(stock > 0 ? `TERSEDIA • ${stock} UNIT` : 'STOK HABIS', 108, 424)
        const hasSpecs = Number(product.ram || 0) > 0 || Number(product.disk || 0) > 0 || Number(product.cpu || 0) > 0
        const specs = hasSpecs
            ? `RAM ${Number(product.ram || 0)} MB  •  DISK ${Number(product.disk || 0)} MB  •  CPU ${Number(product.cpu || 0)}%`
            : String(product.category || product.type || 'Digital')
        drawStoreInfoRow(ctx, 90, 462, hasSpecs ? 'Spesifikasi' : 'Kategori', specs, 650, '#29d9ff')
        drawStoreInfoRow(ctx, 770, 462, 'Durasi / Status', `${product.durationDays ? `${Number(product.durationDays)} hari` : 'Per unit'} • ${stock > 0 ? 'Tersedia' : 'Habis'}`, 330, stock > 0 ? '#38e5a2' : '#ff8d8d')
        if (product.description) {
            ctx.fillStyle = '#9ab4c6'; ctx.font = '500 16px Arial, sans-serif'
            ctx.fillText(fitCanvasText(ctx, product.description, 1010, 16, 13, 500), 92, 550)
        }
    } else if (stageKey === 'checkout') {
        const product = details.product || {}
        drawStoreCardBackground(ctx, 'KONFIRMASI', 'KONFIRMASI PESANAN', 'Periksa rincian pesanan sebelum membuat pembayaran')
        canvasRoundRect(ctx, 58, 218, 1084, 335, 20, 'rgba(7, 25, 44, 0.95)', 'rgba(49, 202, 233, 0.45)')
        canvasRoundRect(ctx, 90, 252, 90, 90, 22, 'rgba(15, 193, 230, 0.12)', 'rgba(46, 222, 255, 0.6)')
        ctx.fillStyle = '#70eaff'; ctx.font = '800 42px Arial, sans-serif'; ctx.fillText('03', 111, 309)
        ctx.fillStyle = '#89a8bb'; ctx.font = '700 15px Arial, sans-serif'; ctx.fillText('PRODUK DIPILIH', 210, 267)
        ctx.fillStyle = '#f4fbff'; ctx.font = `800 ${String(product.name || '').length > 25 ? 28 : 36}px Arial, sans-serif`
        ctx.fillText(fitCanvasText(ctx, product.name || 'Produk', 830, String(product.name || '').length > 25 ? 28 : 36, 20, 800), 210, 310)
        ctx.fillStyle = '#68eaff'; ctx.font = '800 40px Arial, sans-serif'; ctx.fillText(money(product.price), 210, 370)
        drawStoreInfoRow(ctx, 90, 410, 'Jumlah', '1 unit', 315, '#29d9ff')
        drawStoreInfoRow(ctx, 430, 410, 'Metode', 'QRIS otomatis', 315, '#a875ff')
        drawStoreInfoRow(ctx, 770, 410, 'Total bayar', money(product.price), 330, '#f3ba4e')
        ctx.fillStyle = '#98b7c8'; ctx.font = '500 17px Arial, sans-serif'; ctx.fillText('Tekan tombol QRIS di bawah untuk membuat invoice pembayaran.', 92, 535)
    } else if (stageKey === 'orders') {
        const orders = Array.isArray(details.orders) ? details.orders : []
        drawStoreCardBackground(ctx, 'RIWAYAT ORDER', 'PESANAN SAYA', `${orders.length} pesanan terbaru ditampilkan di daftar akun`)
        if (!orders.length) {
            canvasRoundRect(ctx, 58, 225, 1084, 310, 20, 'rgba(9, 28, 48, 0.94)', 'rgba(50, 196, 230, 0.42)')
            ctx.fillStyle = '#f4fbff'; ctx.font = '700 30px Arial, sans-serif'; ctx.fillText('BELUM ADA PESANAN', 92, 300)
            ctx.fillStyle = '#9ab4c7'; ctx.font = '500 21px Arial, sans-serif'; ctx.fillText('Pesanan baru akan muncul di sini setelah checkout.', 92, 342)
        } else {
            orders.slice(0, 4).forEach((order, i) => {
                const y = 214 + i * 98
                const state = String(order.paymentStatus || order.status || 'UNKNOWN').toUpperCase()
                const done = ['PAID', 'DONE', 'SUCCESS', 'COMPLETED'].includes(state)
                const color = done ? '#6fe9ad' : ['FAILED', 'CANCELED', 'EXPIRED', 'PAYMENT_FAILED'].includes(state) ? '#ff8d8d' : '#6de7ff'
                canvasRoundRect(ctx, 58, y, 1084, 84, 14, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.35)')
                ctx.fillStyle = '#6de7ff'; ctx.font = '800 21px Arial, sans-serif'; ctx.fillText(String(i + 1).padStart(2, '0'), 82, y + 33)
                ctx.fillStyle = '#f2fbff'; ctx.font = '700 22px Arial, sans-serif'
                ctx.fillText(fitCanvasText(ctx, order.productName || 'Produk', 495, 22, 15, 700), 135, y + 31)
                ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'; ctx.fillText(String(order.ref || '-').slice(0, 34), 135, y + 58)
                ctx.fillStyle = '#f3ba4e'; ctx.font = '800 21px Arial, sans-serif'; ctx.fillText(money(order.price), 720, y + 34)
                canvasRoundRect(ctx, 930, y + 20, 180, 38, 19, `${color}18`, `${color}88`)
                ctx.fillStyle = color; ctx.font = '700 14px Arial, sans-serif'; ctx.textAlign = 'center'
                ctx.fillText(fitCanvasText(ctx, state, 155, 14, 10, 700), 1020, y + 44)
                ctx.textAlign = 'left'
            })
        }
        ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'
        ctx.fillText('Pilih CEK STATUS pada invoice terkait untuk memperbarui status transaksi.', 58, 625)
    } else if (stageKey === 'qris') {
        const order = details.order || {}
        const qr = details.qrBuffer
        drawStoreCardBackground(ctx, 'PEMBAYARAN QRIS', 'SCAN QRIS UNTUK BAYAR', 'Selesaikan pembayaran sesuai nominal invoice')
        canvasRoundRect(ctx, 58, 210, 400, 390, 20, '#f9fcff', 'rgba(98, 229, 255, 0.75)')
        canvasRoundRect(ctx, 76, 227, 364, 354, 14, '#ffffff', 'rgba(16, 53, 76, 0.12)')
        let qrDrawn = false
        if (qr) {
            try {
                let qrSource = qr
                if (typeof qr === 'string') {
                    if (/^https?:\/\//i.test(qr)) qrSource = await fetchTelegramPhoto(qr)
                    else if (qr.startsWith('data:image/')) qrSource = Buffer.from(qr.slice(qr.indexOf(',') + 1), 'base64')
                }
                const qrImage = await loadImage(qrSource)
                const size = Math.min(300, qrImage.width || 300, qrImage.height || 300)
                const x = 258 - size / 2
                const y = 400 - size / 2
                ctx.imageSmoothingEnabled = false
                ctx.drawImage(qrImage, x, y, size, size)
                ctx.imageSmoothingEnabled = true
                qrDrawn = true
            } catch (err) {
                console.error('[TELEGRAM STORE QR CARD]', err?.message || err)
            }
        }
        if (!qrDrawn) {
            ctx.fillStyle = '#0b2336'; ctx.font = '800 23px Arial, sans-serif'; ctx.textAlign = 'center'
            ctx.fillText('QRIS TIDAK TERSEDIA', 258, 395)
            ctx.fillStyle = '#607e92'; ctx.font = '500 15px Arial, sans-serif'; ctx.fillText('Gunakan instruksi pembayaran', 258, 426)
            ctx.textAlign = 'left'
        }
        const amount = Number(details.amount || order.paymentAmount || order.price || 0)
        canvasRoundRect(ctx, 500, 215, 640, 390, 20, 'rgba(7, 25, 44, 0.95)', 'rgba(49, 202, 233, 0.45)')
        ctx.fillStyle = '#88aabe'; ctx.font = '700 14px Arial, sans-serif'; ctx.fillText('TOTAL PEMBAYARAN', 535, 260)
        ctx.fillStyle = '#69eaff'; ctx.font = '800 45px Arial, sans-serif'; ctx.fillText(money(amount), 535, 315)
        drawStoreInfoRow(ctx, 535, 345, 'Produk', order.productName || details.productName || 'Order', 565, '#29d9ff')
        drawStoreInfoRow(ctx, 535, 425, 'Order ID', order.ref || details.ref || '-', 565, '#a875ff')
        drawStoreInfoRow(ctx, 535, 505, 'Metode', details.paymentName || order.paymentMethod || 'QRIS', 565, '#f3ba4e')
    } else {
        const order = details.order || {}
        const state = String(details.state || order.status || 'UNKNOWN').toUpperCase()
        const paymentState = String(details.paymentState || order.paymentStatus || 'UNPAID').toUpperCase()
        const completed = ['DONE', 'SUCCESS', 'COMPLETED'].includes(state)
        const failed = ['CANCELED', 'CANCELLED', 'EXPIRED', 'FAILED', 'PAYMENT_FAILED', 'REFUNDED'].includes(state) || ['EXPIRED', 'FAILED', 'CANCELED', 'REFUNDED'].includes(paymentState)
        const title = completed ? 'PESANAN BERHASIL' : failed ? 'PESANAN TIDAK AKTIF' : 'STATUS PESANAN'
        drawStoreCardBackground(ctx, completed ? 'ORDER SELESAI' : failed ? 'ORDER BERHENTI' : 'ORDER STATUS', title, 'Status transaksi dan ringkasan pemesanan kamu')
        const accent = completed ? '#45e2a0' : failed ? '#ff8585' : '#31dfff'
        canvasRoundRect(ctx, 58, 218, 1084, 342, 20, 'rgba(7, 25, 44, 0.95)', `${accent}88`)
        canvasRoundRect(ctx, 90, 250, 280, 80, 16, `${accent}18`, `${accent}99`)
        ctx.fillStyle = accent; ctx.font = '800 28px Arial, sans-serif'; ctx.fillText(completed ? 'SUCCESS' : failed ? 'ATTENTION' : 'PROCESSING', 115, 299)
        ctx.fillStyle = '#8babbf'; ctx.font = '700 14px Arial, sans-serif'; ctx.fillText('ORDER REFERENCE', 410, 270)
        ctx.fillStyle = '#f3fbff'; ctx.font = '800 24px Arial, sans-serif'; ctx.fillText(fitCanvasText(ctx, order.ref || '-', 680, 24, 17, 800), 410, 305)
        drawStoreInfoRow(ctx, 90, 355, 'Produk', order.productName || 'Order', 315, '#29d9ff')
        drawStoreInfoRow(ctx, 430, 355, 'Pembayaran', paymentState, 315, '#a875ff')
        drawStoreInfoRow(ctx, 770, 355, 'Status order', state, 330, accent)
        drawStoreInfoRow(ctx, 90, 435, 'Total', money(order.paymentAmount || order.price), 315, '#f3ba4e')
        drawStoreInfoRow(ctx, 430, 435, 'Dibuat', order.createdAt ? new Date(order.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) : '-', 315, '#29d9ff')
        drawStoreInfoRow(ctx, 770, 435, 'Hasil', completed ? (order.panel?.username || order.rental?.id || 'Order selesai') : failed ? 'Order tidak aktif' : 'Menunggu pembaruan', 330, accent)
        if (order.panel?.url) {
            ctx.fillStyle = '#77eaff'; ctx.font = '600 16px Arial, sans-serif'
            ctx.fillText(fitCanvasText(ctx, `Panel: ${order.panel.url}`, 1000, 16, 12, 600), 94, 535)
        }
    }
    return canvas.toBuffer('image/png')
}


// Kartu menu Telegram menggunakan satu identitas visual (navy + cyan neon)
// yang sama dengan kartu katalog VPS/produk. Daftar tetap interaktif lewat inline keyboard.
function drawTelegramMenuTile(ctx, x, y, width, height, title, subtitle = '', index = '', accent = '#29d9ff') {
    canvasRoundRect(ctx, x, y, width, height, 14, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.42)')
    canvasRoundRect(ctx, x + 12, y + 12, 4, height - 24, 2, accent)
    if (index !== '' && index != null) {
        canvasRoundRect(ctx, x + 25, y + 17, 42, 42, 11, `${accent}18`, `${accent}99`)
        ctx.fillStyle = accent
        ctx.font = '800 15px Arial, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(String(index).slice(0, 5), x + 46, y + 43)
        ctx.textAlign = 'left'
    }
    const left = index !== '' && index != null ? x + 82 : x + 28
    const available = width - (left - x) - 22
    ctx.fillStyle = '#effaff'
    ctx.font = '700 22px Arial, sans-serif'
    ctx.fillText(fitCanvasText(ctx, title || '-', available, 22, 15, 700), left, y + Math.min(34, height * 0.42))
    if (subtitle) {
        ctx.fillStyle = '#8daec2'
        ctx.font = '500 15px Arial, sans-serif'
        ctx.fillText(fitCanvasText(ctx, subtitle, available, 15, 11, 500), left, y + Math.min(60, height - 13))
    }
}

function drawTelegramMenuMetric(ctx, x, y, width, height, label, value, accent = '#29d9ff') {
    canvasRoundRect(ctx, x, y, width, height, 14, 'rgba(10, 31, 52, 0.94)', 'rgba(91, 145, 175, 0.30)')
    canvasRoundRect(ctx, x + 13, y + 13, 4, height - 26, 2, accent)
    ctx.fillStyle = '#8daec2'
    ctx.font = '600 14px Arial, sans-serif'
    ctx.fillText(fitCanvasText(ctx, String(label || '').toUpperCase(), width - 48, 14, 11, 600), x + 29, y + 30)
    ctx.fillStyle = '#f2fbff'
    ctx.font = '800 25px Arial, sans-serif'
    ctx.fillText(fitCanvasText(ctx, value || '-', width - 48, 25, 15, 800), x + 29, y + 66)
}

async function makeTelegramMenuCard(stage, details = {}) {
    const canvasLib = storeCanvasModule()
    if (!canvasLib?.createCanvas) throw new Error('Canvas renderer tidak tersedia.')
    const { createCanvas } = canvasLib
    const canvas = createCanvas(1200, 675)
    const ctx = canvas.getContext('2d')
    const key = String(stage || '').toLowerCase()
    const accents = ['#29d9ff', '#a875ff', '#f3ba4e', '#38e5a2', '#ff8d8d', '#65a9ff']
    const money = value => `Rp${Number(value || 0).toLocaleString('id-ID')}`
    const subtitleFor = {
        nokos_services: `RuangOTP  •  ${Number(details.total || 0)} layanan tersedia`,
        nokos_country: `${String(details.service || 'WA').toUpperCase()}  •  Halaman ${Number(details.page || 0) + 1}/${Number(details.pages || 1)}`,
        nokos_servers: `${String(details.service || 'WA').toUpperCase()}  •  ${String(details.countryName || 'Negara terpilih')}`,
        nokos_server: `${String(details.service || 'WA').toUpperCase()}  •  ${String(details.countryName || 'Negara terpilih')}`,
        topup_games: `${Number(details.total || 0)} game tersedia  •  VIPayment`,
        topup_products: `${String(details.gameName || details.game || 'GAME').toUpperCase()}  •  Halaman ${Number(details.page || 0) + 1}/${Number(details.pages || 1)}`,
        topup_confirm: `${String(details.gameName || details.game || 'GAME').toUpperCase()}  •  Konfirmasi sebelum membeli`,
        nokos_order: `NOKOS  •  ${String(details.status || 'MENUNGGU OTP').toUpperCase()}`,
        nokos_status: `NOKOS  •  ${String(details.status || 'STATUS ORDER').toUpperCase()}`,
        topup_processing: `TOP UP  •  MEMPROSES TRANSAKSI`,
        topup_result: `TOP UP  •  ${String(details.status || 'HASIL TRANSAKSI').toUpperCase()}`,
        topup_status: `TOP UP  •  STATUS TERBARU ${String(details.status || '').toUpperCase()}`,
        deposit_menu: `SALDO WALLET  •  ${String(details.gateway || 'QRIS').toUpperCase()}`,
        deposit_order: `DEPOSIT  •  ${String(details.status || 'MENUNGGU PEMBAYARAN').toUpperCase()}`
    }
    const titleFor = {
        nokos_services: 'PILIH LAYANAN NOKOS',
        nokos_country: 'PILIH NEGARA',
        nokos_servers: 'PILIH SERVER NOKOS',
        nokos_server: 'DETAIL SERVER NOKOS',
        topup_games: 'PILIH GAME TOP UP',
        topup_products: 'PILIH NOMINAL TOP UP',
        topup_confirm: 'KONFIRMASI TOP UP',
        nokos_order: 'ORDER NOKOS BERHASIL',
        nokos_status: 'STATUS ORDER NOKOS',
        topup_processing: 'TOP UP SEDANG DIPROSES',
        topup_result: 'HASIL TRANSAKSI TOP UP',
        topup_status: 'STATUS TRANSAKSI TOP UP',
        deposit_menu: 'DEPOSIT SALDO',
        deposit_order: 'INVOICE DEPOSIT'
    }
    drawStoreCardBackground(ctx, key.replace(/_/g, ' '), titleFor[key] || 'XERYUU MENU', subtitleFor[key] || 'Xeryuu-Md V16 × Sendrich Digital Service')

    if (key === 'nokos_services') {
        const items = (details.services || []).slice(0, 8)
        if (!items.length) {
            drawTelegramMenuTile(ctx, 58, 235, 1084, 270, 'LAYANAN BELUM TERSEDIA', 'Periksa konfigurasi/provider RuangOTP lalu refresh.', '', '#ff8d8d')
        } else items.forEach((item, i) => {
            const x = 58 + (i % 2) * 548
            const y = 218 + Math.floor(i / 2) * 86
            const code = String(item.code || '-').toUpperCase()
            drawTelegramMenuTile(ctx, x, y, 528, 76, item.name || code, `SERVICE CODE  •  ${code}`, String(i + 1).padStart(2, '0'), accents[i % accents.length])
        })
        ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'
        ctx.fillText(`Menampilkan ${Math.min((details.services || []).length, 8)} layanan teratas`, 58, 605)
    } else if (key === 'nokos_country') {
        const items = (details.countries || []).slice(0, 8)
        if (!items.length) {
            drawTelegramMenuTile(ctx, 58, 235, 1084, 270, 'NEGARA BELUM TERSEDIA', 'Provider belum mengembalikan daftar negara untuk service ini.', '', '#ff8d8d')
        } else items.forEach((country, i) => {
            const x = 58 + (i % 2) * 548
            const y = 218 + Math.floor(i / 2) * 86
            const name = country.providerName ? country.name : `Country ID ${country.id}`
            const label = `${country.flag || '🌍'} ${name}`
            const detail = [country.prefix, country.providerName ? 'Nama dari provider' : 'ID dari provider'].filter(Boolean).join('  •  ')
            drawTelegramMenuTile(ctx, x, y, 528, 76, label, detail, String(i + 1).padStart(2, '0'), accents[i % accents.length])
        })
        ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'
        ctx.fillText(`Daftar negara  •  total ${Number(details.total || 0)}`, 58, 605)
    } else if (key === 'nokos_servers') {
        const items = (details.servers || []).slice(0, 8)
        if (!items.length) {
            drawTelegramMenuTile(ctx, 58, 235, 1084, 270, 'SERVER TIDAK TERSEDIA', 'Tidak ada server aktif atau stok yang bisa dibeli.', '', '#ff8d8d')
        } else items.forEach((server, i) => {
            const x = 58 + (i % 2) * 548
            const y = 218 + Math.floor(i / 2) * 86
            const sell = typeof server.sellingPrice === 'number' ? server.sellingPrice : server.cost
            const stock = server.stock == null ? 'Stok tidak diberikan' : `Stok ${server.stock}`
            drawTelegramMenuTile(ctx, x, y, 528, 76, server.provider || `Server ${i + 1}`, `${money(sell)}  •  ${stock}`, String(i + 1).padStart(2, '0'), accents[i % accents.length])
        })
        ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'
        ctx.fillText(`Harga mulai ${money(details.lowest || 0)}  •  Pilih server melalui tombol di bawah`, 58, 605)
    } else if (key === 'nokos_server') {
        const metrics = [
            ['NEGARA', details.countryName || '-'],
            ['SERVER', details.provider || '-'],
            ['HARGA JUAL', money(details.sellingPrice)],
            ['STOK', details.stock == null ? 'Tidak diketahui provider' : String(details.stock)]
        ]
        metrics.forEach((item, i) => {
            const x = 58 + (i % 2) * 548
            const y = 235 + Math.floor(i / 2) * 135
            drawTelegramMenuMetric(ctx, x, y, 528, 112, item[0], item[1], accents[i % accents.length])
        })
        canvasRoundRect(ctx, 58, 515, 1084, 48, 12, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.38)')
        ctx.fillStyle = '#8daec2'; ctx.font = '500 15px Arial, sans-serif'
        ctx.fillText(`Provider ID: ${String(details.providerId || '-')}`, 80, 545)
    } else if (key === 'topup_games') {
        const items = (details.games || []).slice(0, 8)
        if (!items.length) {
            drawTelegramMenuTile(ctx, 58, 235, 1084, 270, 'GAME BELUM TERSEDIA', 'Belum ada produk berstatus available dari VIPayment.', '', '#ff8d8d')
        } else items.forEach((game, i) => {
            const x = 58 + (i % 2) * 548
            const y = 218 + Math.floor(i / 2) * 86
            drawTelegramMenuTile(ctx, x, y, 528, 76, game.label || game.game || 'Game', `${Number(game.count || 0)} nominal tersedia`, String(i + 1).padStart(2, '0'), accents[i % accents.length])
        })
        ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'
        ctx.fillText('Harga jual mengikuti price list provider + markup', 58, 605)
    } else if (key === 'topup_products') {
        const items = (details.products || []).slice(0, 8)
        if (!items.length) {
            drawTelegramMenuTile(ctx, 58, 235, 1084, 270, 'NOMINAL BELUM TERSEDIA', 'Pilih game lain atau refresh daftar produk.', '', '#ff8d8d')
        } else items.forEach((product, i) => {
            const x = 58 + (i % 2) * 548
            const y = 218 + Math.floor(i / 2) * 86
            drawTelegramMenuTile(ctx, x, y, 528, 76, product.name || 'Produk', money(product.sellingPrice), String(i + 1).padStart(2, '0'), accents[i % accents.length])
        })
        ctx.fillStyle = '#8daec2'; ctx.font = '500 14px Arial, sans-serif'
        ctx.fillText(`Menampilkan ${Math.min((details.products || []).length, 8)} nominal pada halaman ini`, 58, 605)
    } else if (key === 'topup_confirm') {
        const metrics = [
            ['GAME', details.gameName || details.game || '-'],
            ['PRODUK', details.productName || '-'],
            ['TOTAL BAYAR', money(details.price)],
            ['SALDO SAAT INI', money(details.balance)]
        ]
        metrics.forEach((item, i) => {
            const x = 58 + (i % 2) * 548
            const y = 230 + Math.floor(i / 2) * 135
            drawTelegramMenuMetric(ctx, x, y, 528, 112, item[0], item[1], accents[i % accents.length])
        })
        canvasRoundRect(ctx, 58, 515, 1084, 48, 12, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.38)')
        ctx.fillStyle = '#8daec2'; ctx.font = '500 15px Arial, sans-serif'
        ctx.fillText('Data tujuan akan diminta lewat pesan berikutnya', 80, 545)
    } else if (key === 'deposit_menu') {
        const metrics = [
            ['SALDO SEKARANG', money(details.balance)],
            ['MINIMAL DEPOSIT', money(details.minimum)],
            ['MAKSIMAL DEPOSIT', money(details.maximum)],
            ['INVOICE PENDING', String(details.pendingCount || 0)]
        ]
        metrics.forEach((item, i) => {
            const x = 58 + (i % 2) * 548
            const y = 230 + Math.floor(i / 2) * 135
            drawTelegramMenuMetric(ctx, x, y, 528, 112, item[0], item[1], accents[i % accents.length])
        })
        canvasRoundRect(ctx, 58, 515, 1084, 48, 12, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.38)')
        ctx.fillStyle = '#8daec2'; ctx.font = '500 15px Arial, sans-serif'
        ctx.fillText(fitCanvasText(ctx, `Metode: ${details.gateway || 'QRIS'}  •  Pilih nominal melalui tombol di bawah`, 1035, 15, 11, 500), 80, 545)
    } else if (key === 'deposit_order') {
        const metrics = [
            ['INVOICE', details.ref || '-'],
            ['NOMINAL', money(details.amount)],
            ['TOTAL BAYAR', money(details.totalPay || details.amount)],
            ['STATUS', details.status || 'PENDING']
        ]
        metrics.forEach((item, i) => {
            const x = 58 + (i % 2) * 548
            const y = 230 + Math.floor(i / 2) * 135
            drawTelegramMenuMetric(ctx, x, y, 528, 112, item[0], item[1], accents[i % accents.length])
        })
        canvasRoundRect(ctx, 58, 515, 1084, 48, 12, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.38)')
        ctx.fillStyle = '#8daec2'; ctx.font = '500 15px Arial, sans-serif'
        ctx.fillText('Scan QRIS lalu refresh status jika saldo belum masuk', 80, 545)
    } else if (['nokos_order', 'nokos_status'].includes(key)) {
        const metrics = key === 'nokos_order' ? [
            ['SERVICE', details.service || '-'],
            ['NEGARA', details.country || '-'],
            ['NOMOR', details.phone || '-'],
            ['HARGA', money(details.price)]
        ] : [
            ['NOMOR', details.phone || '-'],
            ['STATUS', details.status || '-'],
            ['KODE OTP', details.otp || '-'],
            ['REFUND', details.refunded ? 'SUDAH' : 'BELUM']
        ]
        metrics.forEach((item, i) => {
            const x = 58 + (i % 2) * 548
            const y = 230 + Math.floor(i / 2) * 135
            drawTelegramMenuMetric(ctx, x, y, 528, 112, item[0], item[1], accents[i % accents.length])
        })
        canvasRoundRect(ctx, 58, 515, 1084, 48, 12, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.38)')
        ctx.fillStyle = '#8daec2'; ctx.font = '500 15px Arial, sans-serif'
        ctx.fillText(`Order: ${String(details.ref || '-')}  •  Provider: ${String(details.provider || '-')}`.slice(0, 115), 80, 545)
    } else if (['topup_processing', 'topup_result', 'topup_status'].includes(key)) {
        const metrics = [
            ['GAME', details.gameName || details.game || '-'],
            ['PRODUK', details.productName || '-'],
            ['TUJUAN', details.destination || '-'],
            ['HARGA', money(details.price)]
        ]
        metrics.forEach((item, i) => {
            const x = 58 + (i % 2) * 548
            const y = 230 + Math.floor(i / 2) * 135
            drawTelegramMenuMetric(ctx, x, y, 528, 112, item[0], item[1], accents[i % accents.length])
        })
        canvasRoundRect(ctx, 58, 515, 1084, 48, 12, 'rgba(8, 27, 47, 0.94)', 'rgba(55, 174, 205, 0.38)')
        ctx.fillStyle = '#8daec2'; ctx.font = '500 15px Arial, sans-serif'
        const refAndSn = [`Ref: ${details.ref || '-'}`, `Status: ${details.status || '-'}`, `SN: ${details.sn || '-'}`, `Refund: ${details.refunded ? 'YA' : 'TIDAK'}`].join('  •  ')
        ctx.fillText(fitCanvasText(ctx, refAndSn, 1035, 15, 11, 500), 80, 545)
    }
    return canvas.toBuffer('image/png')
}

async function renderTelegramMenuCard(ctx, stage, details, text, keyboard, logTag = stage) {
    try {
        const richSent = await tryRenderRichMenu(ctx, text, keyboard, {
            stage, details, edit: Boolean(ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId), hero: true
        })
        if (richSent) return richSent
    } catch (richError) {
        console.warn(`[TELEGRAM ${String(logTag || stage).toUpperCase()} RICH FALLBACK]`, richError?.description || richError?.message || richError)
    }
    try {
        const card = await makeTelegramMenuCard(stage, details)
        const rendered = await editTrackedPhoto(ctx, card, text, keyboard)
        if (rendered) return rendered
    } catch (imageError) {
        console.error(`[TELEGRAM ${String(logTag || stage).toUpperCase()} CARD]`, imageError?.message || imageError)
    }
    return editTracked(ctx, text, keyboard)
}

function autoOrderStats() {
    const products = storeService.products()
    const orders = storeService.listOrders(1000)
    const paid = orders.filter(order => ['PAID', 'PAID_WAITING_FULFILLMENT', 'PROCESSING', 'DONE'].includes(String(order.status || '').toUpperCase()) || String(order.paymentStatus || '').toUpperCase() === 'PAID').length
    let users = 0
    try { users = Object.keys(ensureDb().users || {}).length } catch {}
    return { products, orders, paid, users }
}

function storeActionKeyboard(ref, { showCancel = true, showStatus = true, checkoutUrl = '', category = 'rental' } = {}) {
    const rows = []
    if (checkoutUrl && /^https?:\/\//i.test(String(checkoutUrl))) rows.push([Markup.button.url('💳 BUKA PEMBAYARAN', String(checkoutUrl))])
    if (showStatus) rows.push([Markup.button.callback('🔄 CEK STATUS PEMBAYARAN', `tg_store_status:${ref}`)])
    if (showCancel) rows.push([Markup.button.callback('❌ BATAL ORDER', `tg_store_cancel:${ref}`)])
    rows.push([Markup.button.callback('🤖 SEWA BOT LAGI', 'tg_home_store'), Markup.button.callback('🏠 MENU UTAMA', 'tg_home')])
    return Markup.inlineKeyboard(rows)
}

async function renderStore(ctx, page = 0, category = 'rental') {
    try {
        const all = storeService.products()
        const normalizedCategory = String(category || 'rental').toLowerCase()
        const list = normalizedCategory === 'all'
            ? all
            : all.filter(product => String(product.type || product.category || '').toLowerCase() === normalizedCategory)
        const p = pageInfo(list.length, page, 6)
        const shown = list.slice(p.start, p.end)
        const stats = autoOrderStats()
        setUi(ctx.from.id, { screen: 'store', storeProducts: list, storeAllProducts: all, storePage: p.page, storeCategory: normalizedCategory })

        const categoryTitle = normalizedCategory === 'all' ? 'SEMUA PRODUK' : normalizedCategory === 'rental' ? 'SEWA BOT' : normalizedCategory === 'jadibot' ? 'JADI BOT' : 'PANEL / VPS'
        let text =
            `<blockquote>🐬 XNALZ AUTO ORDER SYSTEM</blockquote>\n` +
            `📦 <b>${escapeHtml(categoryTitle)}</b>\n\n`

        if (!shown.length) {
            text += `🛒 <b>Tidak ada produk tersedia.</b>\n\n` +
                `Silakan pilih kategori lain atau kembali ke menu utama.`
        } else {
            text += shown.map((product, i) => {
                const stock = Number(product.stock ?? product.stockCount ?? 1)
                const available = stock > 0
                return `${p.start + i + 1}. <b>${escapeHtml(product.name)}</b>\n` +
                    `   💰 ${escapeHtml(storeService.formatMoney(product.price))}\n` +
                    `   📦 Stok: ${available ? '✅ ' + stock : '❌ Habis'}\n`
            }).join('\n')
            text += `\n━━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 Produk: <b>${shown.length}</b> dari <b>${list.length}</b>\n` +
                `✅ Transaksi sukses: <b>${stats.paid}</b>\n\n` +
                `🛒 <b>Pilih produk yang ingin dibeli:</b>`
        }

        const rows = []
        for (let i = 0; i < shown.length; i += 2) {
            const first = shown[i]
            const second = shown[i + 1]
            const firstName = String(first.name || '').slice(0, 18)
            const firstButton = Markup.button.callback(`${p.start + i + 1}. ${firstName}`, `tg_store_product:${p.start + i}`)
            if (second) {
                const secondName = String(second.name || '').slice(0, 18)
                rows.push([firstButton, Markup.button.callback(`${p.start + i + 2}. ${secondName}`, `tg_store_product:${p.start + i + 1}`)])
            } else rows.push([firstButton])
        }
        rows.push([
            Markup.button.callback('🖥️ PANEL / VPS', 'tg_store_category:panel'),
            Markup.button.callback('🤖 SEWA BOT', 'tg_store_category:rental'),
            Markup.button.callback('📱 JADI BOT', 'tg_store_category:jadibot'),
            Markup.button.callback('📚 SEMUA PRODUK', 'tg_store_category:all')
        ])
        rows.push([
            Markup.button.callback('‹ PREV', `tg_store_page:${Math.max(0, p.page - 1)}:${normalizedCategory}`),
            Markup.button.callback(`📄 ${p.page + 1}/${p.pages}`, `tg_store_category:${normalizedCategory}`),
            Markup.button.callback('NEXT ›', `tg_store_page:${Math.min(p.pages - 1, p.page + 1)}:${normalizedCategory}`)
        ])
        rows.push([Markup.button.callback('📦 PESANAN SAYA', 'tg_store_orders'), Markup.button.callback('🏠 MENU UTAMA', 'tg_home')])
        const keyboard = Markup.inlineKeyboard(rows)
        try {
            const richSent = await tryRenderRichMenu(ctx, text, keyboard, {
                stage: 'store_catalog', details: { products: shown, startIndex: p.start, page: p.page, pages: p.pages, total: list.length, paid: stats.paid, categoryTitle },
                edit: Boolean(ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId), hero: true
            })
            if (richSent) return richSent
        } catch (richError) {
            console.warn('[TELEGRAM STORE CATALOG RICH FALLBACK]', richError?.description || richError?.message || richError)
        }
        try {
            const card = await makeTelegramStoreCard('catalog', {
                categoryTitle, products: shown, startIndex: p.start, page: p.page,
                pages: p.pages, total: list.length, paid: stats.paid
            })
            const rendered = await editTrackedPhoto(ctx, card, text, keyboard)
            if (rendered) return rendered
        } catch (imageError) {
            console.error('[TELEGRAM STORE CATALOG CARD]', imageError?.message || imageError)
        }
        return editTracked(ctx, text, keyboard)
    } catch (e) {
        return editTracked(ctx, `❌ <b>Gagal mengambil katalog.</b>\n\n${escapeHtml(e?.message || e)}`, backHomeKeyboard())
    }
}

async function selectStoreProduct(ctx, index) {
    const session = getUi(ctx.from.id)
    const list = session?.storeProducts || storeService.products()
    const selectedProduct = list[Number(index)]
    if (!selectedProduct) return renderStore(ctx, Math.floor(Number(index) / 6), session?.storeCategory || 'rental')
    const product = storeService.getProduct(selectedProduct.key) || selectedProduct
    setUi(ctx.from.id, { screen: 'store_product', storeSelected: { index: Number(index), product } })
    const stock = Number(product.stock ?? product.stockCount ?? 1)
    const message =
        `<blockquote>🐬 XNALZ AUTO ORDER SYSTEM</blockquote>\n` +
        `📦 <b>DETAIL PRODUK</b>\n\n` +
        `🏷️ <b>${escapeHtml(product.name)}</b>\n` +
        `💰 <b>Harga:</b> Rp${escapeHtml(storeService.formatMoney(product.price))}\n` +
        `📊 <b>Stok:</b> ${stock > 0 ? '✅ Tersedia' : '❌ Habis'}${stock > 0 ? ` (${stock} unit)` : ''}\n\n` +
        `📝 <b>Deskripsi:</b>\n${escapeHtml(product.description || 'Tidak ada deskripsi.')}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `${stock > 0 ? '🛒 <b>Apakah ingin membeli produk ini?</b>' : '⚠️ <b>Produk sedang habis.</b>'}`
    const rows = []
    if (stock > 0) rows.push([Markup.button.callback('🛒 BELI SEKARANG', `tg_store_payment:${index}`)])
    rows.push([Markup.button.callback('🔙 KEMBALI', `tg_store_category:${session?.storeCategory || 'all'}`)])
    const keyboard = Markup.inlineKeyboard(rows)
    try {
        const richSent = await tryRenderRichMenu(ctx, message, keyboard, {
            stage: 'store_product', details: { product },
            edit: Boolean(ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId), hero: true
        })
        if (richSent) return richSent
    } catch (richError) {
        console.warn('[TELEGRAM STORE PRODUCT RICH FALLBACK]', richError?.description || richError?.message || richError)
    }
    try {
        const card = await makeTelegramStoreCard('product', { product })
        const rendered = await editTrackedPhoto(ctx, card, message, keyboard)
        if (rendered) return rendered
    } catch (imageError) {
        console.error('[TELEGRAM STORE PRODUCT CARD]', imageError?.message || imageError)
    }
    return editTracked(ctx, message, keyboard)
}

async function showStorePayment(ctx, index) {
    const session = getUi(ctx.from.id)
    const list = session?.storeProducts || storeService.products()
    const selectedProduct = list[Number(index)]
    if (!selectedProduct) return renderStore(ctx, 0, session?.storeCategory || 'rental')
    const product = storeService.getProduct(selectedProduct.key) || selectedProduct
    if (Number(product.stock) <= 0) return selectStoreProduct(ctx, index)
    setUi(ctx.from.id, { screen: 'store_payment_method', storeSelected: { index: Number(index), product } })
    const message =
        `<blockquote>🐬 XNALZ AUTO ORDER SYSTEM</blockquote>\n` +
        `🎉 <b>ORDER SIAP DIBUAT!</b>\n\n` +
        `📦 Produk: <b>${escapeHtml(product.name)}</b>\n` +
        `💰 Total: <b>Rp${escapeHtml(storeService.formatMoney(product.price))}</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `💳 <b>PILIH METODE PEMBAYARAN:</b>\n` +
        `Silakan pilih metode pembayaran untuk melanjutkan.`
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('💳 QRIS', `tg_store_buy:${index}`)],
        [Markup.button.callback('🔙 KEMBALI', `tg_store_product:${index}`)],
        [Markup.button.callback('🏠 MENU UTAMA', 'tg_home')]
    ])
    try {
        const richSent = await tryRenderRichMenu(ctx, message, keyboard, {
            stage: 'store_checkout', details: { product },
            edit: Boolean(ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId), hero: true
        })
        if (richSent) return richSent
    } catch (richError) {
        console.warn('[TELEGRAM STORE CHECKOUT RICH FALLBACK]', richError?.description || richError?.message || richError)
    }
    try {
        const card = await makeTelegramStoreCard('checkout', { product })
        const rendered = await editTrackedPhoto(ctx, card, message, keyboard)
        if (rendered) return rendered
    } catch (imageError) {
        console.error('[TELEGRAM STORE CHECKOUT CARD]', imageError?.message || imageError)
    }
    return editTracked(ctx, message, keyboard)
}

function convertPulsaTelegramUserId(ctx) {
    return privateChat(ctx) && ctx?.from?.id != null ? `telegram:${String(ctx.from.id)}` : ''
}

function convertPulsaTelegramSession(ctx) {
    const userId = convertPulsaTelegramUserId(ctx)
    if (!userId) return null
    const session = convertPulsaService.getSession('telegram', userId)
    if (!session || String(session.chatId || '') !== String(ctx.chat?.id || '')) return null
    return session
}

function safeConvertPulsaOperators(items) {
    return (Array.isArray(items) ? items : []).map(({ raw, ...item }) => item)
}

function safeConvertPulsaMethods(items) {
    return (Array.isArray(items) ? items : []).map(({ raw, ...item }) => item)
}

function convertPulsaRateLabel(operator) {
    if (operator?.rate == null || !Number.isFinite(Number(operator.rate))) return 'Kurs mengikuti provider'
    return `${(Number(operator.rate) * 100).toFixed(2).replace(/\.00$/, '')}%`
}

function convertPulsaStatusLabel(status) {
    const key = String(status || '').toUpperCase()
    return ({
        CREATING: 'Menyiapkan order',
        WAITING_TRANSFER: 'Menunggu transfer pulsa',
        PENDING: 'Menunggu transfer pulsa',
        PROCESSING: 'Sedang diproses provider',
        SUCCESS: 'Berhasil menurut provider',
        FAILED: 'Gagal menurut provider',
        EXPIRED: 'Kedaluwarsa',
        CANCELLED: 'Dibatalkan provider',
        CREATE_FAILED: 'Order tidak dibuat oleh API',
        REVIEW_REQUIRED: 'Perlu rekonsiliasi manual'
    })[key] || key || 'Tidak diketahui'
}

function convertPulsaSafeInstruction(value, max = 900) {
    return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max)
}

function convertPulsaTelegramProofAllowed(tx) {
    return convertPulsaService.canSubmitProof(tx)
}

function convertPulsaTelegramProofStatusLabel(tx) {
    const count = Math.max(0, Math.floor(Number(tx?.proofCount) || 0))
    if (count > 0 && tx?.proofStatus === 'FORWARDED_TO_ADMIN') return `Diteruskan ke admin untuk review manual (${count}/3)`
    return 'Belum dikirim (opsional)'
}

function restoreConvertPulsaTelegramSession(ctx, session) {
    const userId = convertPulsaTelegramUserId(ctx)
    const returnStep = String(session?.proofReturnStep || '')
    if (returnStep) convertPulsaSaveTelegramSession(ctx, { step: returnStep, proofRef: '', proofReturnStep: '' })
    else if (userId) convertPulsaService.clearSession('telegram', userId)
}

async function startConvertPulsaTelegramProof(ctx, rawRef) {
    if (!privateChat(ctx)) return commandOutput(ctx, '🔒 Bukti convert pulsa hanya bisa dikirim melalui chat pribadi bot.')
    const userId = convertPulsaTelegramUserId(ctx)
    const ref = String(rawRef || '').trim().toUpperCase()
    if (!ref) return sendConvertPulsaRich(ctx, { title: '🧾 KIRIM BUKTI TRANSFER', lines: ['Gunakan /cpbukti <REF> atau buka detail transaksi dan tekan tombol Kirim Bukti.'], buttonRows: [[{ text: '📚 Riwayat', callbackData: 'tg_cp_history' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa_proof' })
    const tx = convertPulsaService.findOrder(ref)
    if (!tx || tx.channel !== 'telegram' || tx.userId !== userId) {
        return sendConvertPulsaRich(ctx, { title: '❌ TRANSAKSI TIDAK DITEMUKAN', lines: ['Referensi tidak ditemukan atau bukan milik akun Telegram ini.'], buttonRows: [[{ text: '📚 Riwayat', callbackData: 'tg_cp_history' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
    }
    if (!convertPulsaTelegramProofAllowed(tx)) return sendConvertPulsaRich(ctx, { title: '⚠️ BUKTI TIDAK TERSEDIA', lines: ['Bukti hanya dapat dikirim untuk order PesanJasa aktif yang mempunyai referensi provider. Cek status terlebih dahulu.'], buttonRows: [[{ text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }, { text: '📚 Riwayat', callbackData: 'tg_cp_history' }]], screen: 'convert_pulsa_transaction' })
    if (Number(tx.proofCount || 0) >= 3) return sendConvertPulsaRich(ctx, { title: '⚠️ BATAS BUKTI TERCAPAI', lines: ['Maksimal tiga bukti per transaksi. Hubungi admin untuk bantuan lanjutan.'], buttonRows: [[{ text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa_transaction' })
    if (Date.now() - Number(tx.proofSubmittedAt || 0) < 15000) return sendConvertPulsaRich(ctx, { title: '⏳ TUNGGU SEBENTAR', lines: ['Bukti baru saja diterima. Tunggu sekitar 15 detik sebelum mengirim bukti berikutnya.'], buttonRows: [[{ text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }]], screen: 'convert_pulsa_transaction' })
    const adminTargets = telegramAdminIds()
    if (!adminTargets.length) return sendConvertPulsaRich(ctx, { title: '❌ ADMIN BELUM DIKONFIGURASI', lines: ['Bukti belum diminta/dikirim karena ID admin Telegram tidak tersedia. Konfigurasikan global.telegramConfig.adminIds atau tautkan akun owner terlebih dahulu.'], buttonRows: [[{ text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa_transaction' })
    const previous = convertPulsaTelegramSession(ctx)
    const proofReturnStep = previous && previous.step !== 'proof_upload' && !previous.requestedAt ? String(previous.step || '') : ''
    convertPulsaSaveTelegramSession(ctx, { step: 'proof_upload', proofRef: tx.ref, proofReturnStep })
    return sendConvertPulsaRich(ctx, {
        title: '🧾 KIRIM BUKTI TRANSFER',
        stage: 'BUKTI TRANSFER',
        lines: [
            `Referensi lokal: ${tx.ref}`,
            `Referensi PesanJasa: ${tx.providerTrxId}`,
            `Operator: ${tx.operatorName || '-'}`,
            `Nominal pulsa: Rp${convertPulsaService.formatMoney(tx.amount)}`,
            `Status provider: ${convertPulsaStatusLabel(tx.status)}`,
            '',
            'Kirim screenshot bukti sebagai FOTO pada chat ini. Admin menerima salinannya untuk pemeriksaan manual.',
            'Catatan penting: bukti ini tidak diunggah ke API PesanJasa dan tidak mengubah status provider. Status transaksi tetap mengikuti pengecekan resmi PesanJasa.'
        ],
        buttonRows: [[{ text: '❌ Batal kirim bukti', callbackData: 'tg_cp_proof_cancel' }, { text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }]],
        screen: 'convert_pulsa_proof'
    })
}

async function handleConvertPulsaTelegramProofMedia(ctx) {
    if (!privateChat(ctx) || !ctx?.message?.photo?.length) return false
    const session = convertPulsaTelegramSession(ctx)
    if (!session || session.step !== 'proof_upload') return false
    const ref = String(session.proofRef || '').trim().toUpperCase()
    const tx = convertPulsaService.findOrder(ref)
    if (!tx || tx.channel !== 'telegram' || tx.userId !== convertPulsaTelegramUserId(ctx) || !convertPulsaTelegramProofAllowed(tx)) {
        restoreConvertPulsaTelegramSession(ctx, session)
        await sendConvertPulsaRich(ctx, { title: '⚠️ SESI BUKTI TIDAK VALID', lines: ['Transaksi tidak ditemukan, bukan milik akun ini, instruksi resmi belum tersedia, atau order sudah tidak aktif. Status provider tidak diubah.'], buttonRows: [[{ text: '📚 Riwayat', callbackData: 'tg_cp_history' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
        return true
    }
    if (Number(tx.proofCount || 0) >= 3 || Date.now() - Number(tx.proofSubmittedAt || 0) < 15000) {
        await sendConvertPulsaRich(ctx, { title: '⏳ BUKTI BELUM DAPAT DITERIMA', lines: ['Batas tiga bukti sudah tercapai atau bukti sebelumnya baru dikirim. Tidak ada file baru yang diteruskan.'], buttonRows: [[{ text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }]], screen: 'convert_pulsa_transaction' })
        return true
    }
    const photo = ctx.message.photo[ctx.message.photo.length - 1]
    const maxBytes = 8 * 1024 * 1024
    if (Number(photo?.file_size || 0) > maxBytes) {
        await sendConvertPulsaRich(ctx, { title: '❌ FOTO TERLALU BESAR', lines: ['Ukuran foto maksimal 8 MB. Kirim screenshot yang lebih kecil sebagai FOTO biasa.'], buttonRows: [[{ text: '❌ Batal', callbackData: 'tg_cp_proof_cancel' }]], screen: 'convert_pulsa_proof' })
        return true
    }
    const adminTargets = telegramAdminIds()
    if (!adminTargets.length) {
        await sendConvertPulsaRich(ctx, { title: '❌ ADMIN BELUM TERSEDIA', lines: ['Foto belum diteruskan karena tujuan admin tidak tersedia. Status PesanJasa tidak diubah.'], buttonRows: [[{ text: '❌ Batal', callbackData: 'tg_cp_proof_cancel' }]], screen: 'convert_pulsa_proof' })
        return true
    }

    let proofClaim = null
    let delivered = 0
    let updated = null
    try {
        proofClaim = convertPulsaService.claimProof(tx.ref, { channel: 'telegram', submitter: String(ctx.from.id) })
        const fileUrl = await ctx.telegram.getFileLink(photo.file_id)
        const response = await axios.get(String(fileUrl?.href || fileUrl), {
            responseType: 'arraybuffer', timeout: 20000,
            maxContentLength: maxBytes, maxBodyLength: maxBytes
        })
        const buffer = Buffer.from(response.data || [])
        if (!buffer.length || buffer.length > maxBytes) throw new Error('Foto kosong atau melebihi 8 MB.')
        const caption = `🧾 BUKTI CONVERT PULSA — REVIEW MANUAL\nReferensi lokal: ${tx.ref}\nReferensi PesanJasa: ${tx.providerTrxId}\nOperator: ${tx.operatorName || '-'}\nNominal pulsa: Rp${convertPulsaService.formatMoney(tx.amount)}\nStatus provider saat dikirim: ${convertPulsaStatusLabel(tx.status)}\nPengirim Telegram ID: ${ctx.from.id}\nCatatan: foto ini diteruskan untuk review manual, bukan diunggah ke API PesanJasa.`
        for (const target of adminTargets) {
            try {
                await ctx.telegram.sendPhoto(target, { source: buffer }, { caption })
                delivered++
            } catch (sendError) {
                console.warn('[TELEGRAM CONVERT PULSA PROOF ADMIN]', target, sendError?.description || sendError?.message || sendError)
            }
        }
        if (!delivered) throw new Error('Tidak ada admin yang dapat menerima foto. Periksa ID admin dan izin bot.')
        updated = convertPulsaService.recordProof(tx.ref, {
            channel: 'telegram', submitter: String(ctx.from.id), claimToken: proofClaim.token
        })
    } catch (error) {
        if (proofClaim?.token) {
            try { convertPulsaService.releaseProofClaim(tx.ref, proofClaim.token) } catch (releaseError) {
                console.error('[TELEGRAM CONVERT PULSA PROOF RELEASE]', releaseError?.stack || releaseError)
            }
        }
        console.error('[TELEGRAM CONVERT PULSA PROOF]', error?.stack || error)
        if (delivered > 0) {
            restoreConvertPulsaTelegramSession(ctx, session)
            await sendConvertPulsaRich(ctx, {
                title: '⚠️ FOTO SUDAH DITERUSKAN',
                lines: ['Admin sudah menerima foto untuk review manual, tetapi metadata bukti tidak berhasil disimpan ke riwayat bot.', convertPulsaSafeInstruction(error?.message || error, 300), 'Status PesanJasa tidak diubah. Hubungi admin dengan referensi transaksi ini.', `Referensi: ${tx.ref}`],
                buttonRows: [[{ text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }]],
                screen: 'convert_pulsa_transaction'
            })
        } else {
            await sendConvertPulsaRich(ctx, { title: '❌ BUKTI BELUM DITERUSKAN', lines: [convertPulsaSafeInstruction(error?.message || error, 350), 'Sesi tetap aktif agar kamu dapat mencoba mengirim foto lagi. Status PesanJasa tidak diubah.'], buttonRows: [[{ text: '❌ Batal kirim bukti', callbackData: 'tg_cp_proof_cancel' }, { text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }]], screen: 'convert_pulsa_proof' })
        }
        return true
    }

    restoreConvertPulsaTelegramSession(ctx, session)
    try {
        return await showConvertPulsaTelegramTransaction(ctx, updated)
    } catch (error) {
        console.error('[TELEGRAM CONVERT PULSA PROOF STATUS VIEW]', error?.stack || error)
        await commandOutput(ctx, `✅ Bukti telah diteruskan ke admin untuk review manual. Status PesanJasa tidak berubah otomatis. Referensi: ${updated.ref}. Gunakan /cpstatus ${updated.ref} untuk memeriksa status.`)
        return true
    }
}

function convertPulsaTransactionLines(tx) {
    const status = String(tx?.status || '').toUpperCase()
    const lines = [
        `Referensi lokal: ${tx?.ref || '-'}`,
        `Operator: ${tx?.operatorName || '-'}`,
        `Pulsa yang diminta: Rp${convertPulsaService.formatMoney(tx?.amount)}`,
        `Estimasi pencairan: ${tx?.estimatedAmount == null ? 'Tidak tersedia dari API' : `Rp${convertPulsaService.formatMoney(tx.estimatedAmount)}`}`,
        `Metode tujuan: ${tx?.payoutMethodLabel || tx?.payoutMethod || '-'}`,
        `Status: ${convertPulsaStatusLabel(status)}`,
        `Bukti transfer: ${convertPulsaTelegramProofStatusLabel(tx)}`
    ]
    if (tx?.providerTrxId) lines.push(`Referensi PesanJasa: ${tx.providerTrxId}`)
    const hasInstructions = convertPulsaService.hasOfficialInstructions(tx)
    const terminalOrUnsafe = ['SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED', 'CREATE_FAILED', 'REVIEW_REQUIRED'].includes(status)
    if (!terminalOrUnsafe && hasInstructions) {
        if (tx.receiverNumber) lines.push(`Nomor tujuan transfer pulsa: ${tx.receiverNumber}`)
        if (tx.ussd) lines.push(`Kode USSD: ${tx.ussd}`)
        if (tx.instructionText) lines.push(`Instruksi provider: ${convertPulsaSafeInstruction(tx.instructionText)}`)
        lines.push('Ikuti instruksi provider persis seperti yang ditampilkan. Jangan mengirim nominal tambahan dan jangan mengulangi transfer.')
    } else if (['WAITING_TRANSFER', 'PENDING'].includes(status)) {
        lines.push('PERINGATAN: PesanJasa belum mengirim instruksi transfer yang dapat dikenali. Jangan kirim pulsa ke nomor mana pun sebelum instruksi resmi terverifikasi.')
    } else if (status === 'PROCESSING') {
        lines.push('Provider sedang memproses transaksi. Jangan mengirim pulsa ulang; tekan Cek Status untuk pembaruan.')
    } else if (status === 'SUCCESS') {
        lines.push('PesanJasa melaporkan transaksi selesai. Cocokkan saldo tujuan sebelum menghubungi dukungan.')
    } else if (status === 'REVIEW_REQUIRED') {
        lines.push('Demi keamanan, jangan membuat order baru atau mengirim pulsa. Hubungi owner untuk rekonsiliasi referensi ini.')
    } else if (status === 'CREATE_FAILED') {
        lines.push('API menolak pembuatan order. Tidak ada instruksi transfer yang sah dari transaksi ini.')
    } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(status)) {
        lines.push('Status terminal dilaporkan provider. Simpan referensi transaksi bila perlu menghubungi dukungan.')
    }
    return lines
}

function convertPulsaMarkupKeyboard(buttonRows) {
    return Markup.inlineKeyboard((buttonRows || []).map(row => row.map(button => {
        if (button.url) return Markup.button.url(button.text, button.url)
        return Markup.button.callback(button.text, button.callbackData)
    })))
}

async function sendConvertPulsaRich(ctx, { title, lines = [], buttonRows = [], screen = 'convert_pulsa', edit = undefined, notice = '', details = {}, stage = '' }) {
    if (!privateChat(ctx)) return commandOutput(ctx, '🔒 Convert pulsa hanya tersedia di chat pribadi untuk melindungi data nomor dan rekening tujuan.')
    const safeTitle = String(title || 'CONVERT PULSA')
    const bodyLines = [...(Array.isArray(lines) ? lines : [lines])].map(value => String(value ?? ''))
    if (notice) bodyLines.push(String(notice))
    const plain = [safeTitle, ...bodyLines].join('\n')
    const keyboard = convertPulsaMarkupKeyboard(buttonRows)
    const shouldEdit = edit === undefined ? Boolean(ctx.callbackQuery || getUi(ctx.from?.id)?.messageId) : Boolean(edit)

    // Seluruh alur convert pulsa menggunakan Rich Message Sendrich, bukan kartu
    // canvas/foto. Ini menjaga tampilan konsisten pada menu, input, status, dan riwayat.
    const blocks = [
        { type: 'heading', text: safeTitle, size: 2 },
        { type: 'paragraph', text: bodyLines.join('\n') || 'Pilih aksi yang tersedia di bawah.' }
    ]
    if ((buttonRows || []).length) blocks.push({ type: 'divider' })
    for (const row of (buttonRows || [])) {
        const richButtons = (Array.isArray(row) ? row : []).map(button => button.url
            ? makeRichUrlButton(button.text, button.url)
            : makeRichButton(button.text, button.callbackData, button.style || 'primary'))
        if (richButtons.length) blocks.push(richButtonBlock(richButtons))
    }
    blocks.push({ type: 'footer', text: 'Xeryuu-MD V16 × Sendrich • PesanJasa Convert Pulsa' })

    try {
        const sent = await sendOrEditRichMessage(ctx, { blocks }, { edit: shouldEdit })
        if (sent && ctx.from?.id) setUi(ctx.from.id, {
            chatId: sent.chat?.id ?? ctx.callbackQuery?.message?.chat?.id ?? ctx.chat?.id,
            messageId: sent.message_id ?? ctx.callbackQuery?.message?.message_id ?? getUi(ctx.from.id)?.messageId,
            messageType: 'rich',
            screen
        })
        return sent
    } catch (error) {
        console.warn('[TELEGRAM CONVERT PULSA RICH FALLBACK]', error?.description || error?.message || error)
        const fallback = `<b>${escapeHtml(safeTitle)}</b>\n\n${escapeHtml(plain.slice(safeTitle.length).trim())}`
        if (shouldEdit && (ctx.callbackQuery || getUi(ctx.from?.id)?.messageId)) {
            try {
                const sent = await editTracked(ctx, fallback, keyboard)
                if (sent && ctx.from?.id) setUi(ctx.from.id, { messageType: 'text', screen })
                return sent
            } catch {}
        }
        const sent = await ctx.telegram.sendMessage(ctx.chat.id, fallback, {
            parse_mode: 'HTML',
            ...keyboard,
            disable_web_page_preview: true
        })
        if (ctx.from?.id) setUi(ctx.from.id, {
            chatId: sent.chat.id,
            messageId: sent.message_id,
            messageType: 'text',
            screen
        })
        return sent
    }
}


function configuredSaweriaUrl() {
    const raw = global.saweriaConfig?.enabled === false ? '' : String(global.saweriaConfig?.url || process.env.SAWERIA_URL || '').trim()
    try {
        const parsed = new URL(raw)
        if (parsed.protocol === 'https:' && (parsed.hostname === 'saweria.co' || parsed.hostname.endsWith('.saweria.co'))) {
            return parsed.toString()
        }
    } catch {}
    return ''
}

async function showTelegramDonation(ctx) {
    const url = configuredSaweriaUrl()
    const lines = [
        'Dukungan bersifat sukarela dan pembayaran ditangani langsung oleh Saweria.',
        'Donasi membantu biaya server, perawatan, serta pengembangan fitur Xeryuu.',
        'Bot tidak akan meminta PIN, OTP, atau data perbankan.'
    ]
    if (!url) lines.push('', 'Link Saweria belum diatur. Owner perlu mengisi global.saweriaConfig.url di settings.js atau environment SAWERIA_URL, lalu restart bot.')
    const blocks = [
        { type: 'heading', text: '💝 SUPPORT DEVELOPER', size: 2 },
        { type: 'paragraph', text: lines.join('\n') }
    ]
    if (url) blocks.push(richButtonBlock([makeRichUrlButton('💝 Donasi via Saweria', url)]))
    blocks.push({ type: 'footer', text: 'Xeryuu-MD V16 × Sendrich • Donasi sukarela' })
    try {
        return await sendOrEditRichMessage(ctx, { blocks }, { edit: false })
    } catch (error) {
        console.warn('[TELEGRAM SAWERIA]', error?.description || error?.message || error)
        const fallback = `💝 SUPPORT DEVELOPER\n\n${lines.join('\n')}${url ? `\n\nLink Saweria: ${url}` : ''}`
        return commandOutput(ctx, fallback)
    }
}

function convertPulsaSaveTelegramSession(ctx, patch = {}) {
    const userId = convertPulsaTelegramUserId(ctx)
    if (!userId) throw new Error('Transaksi convert pulsa hanya tersedia di chat pribadi Telegram.')
    const old = convertPulsaTelegramSession(ctx) || {}
    return convertPulsaService.setSession('telegram', userId, {
        ...old,
        ...patch,
        chatId: String(ctx.chat.id),
        expiresAt: Date.now() + Number(global.convertPulsaConfig?.sessionTtlMs || 15 * 60 * 1000)
    })
}

async function showConvertPulsaTelegramMenu(ctx, page = 0) {
    if (!privateChat(ctx)) return commandOutput(ctx, '🔒 Buka chat pribadi bot untuk memakai convert pulsa.')
    if (!convertPulsaService.ready()) {
        return sendConvertPulsaRich(ctx, {
            title: '💱 CONVERT PULSA',
            lines: ['API PesanJasa belum dikonfigurasi di VPS.', 'Atur PESANJASA_CONVERT_API_KEY di environment atau global.convertPulsaConfig.apiKey di settings.js, lalu restart bot.', 'Belum ada order yang dibuat.'],
            buttonRows: [[{ text: '🔄 Coba Lagi', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu', callbackData: 'tg_home' }]],
            screen: 'convert_pulsa'
        })
    }
    try {
        const rateData = await convertPulsaService.getRates()
        const operators = safeConvertPulsaOperators(rateData.operators)
        const payoutMethods = safeConvertPulsaMethods(rateData.payoutMethods)
        if (!operators.length) throw new Error('API belum mengembalikan operator yang dapat dikenali.')
        convertPulsaSaveTelegramSession(ctx, { step: 'operator', operators, payoutMethods, page: 0, operatorId: '', amount: null, requestedAt: null, localRef: '' })
        const pageSize = 6
        const pages = Math.max(1, Math.ceil(operators.length / pageSize))
        const currentPage = Math.max(0, Math.min(pages - 1, Number(page) || 0))
        const shown = operators.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
        const rows = []
        for (let i = 0; i < shown.length; i += 2) {
            rows.push(shown.slice(i, i + 2).map((operator, offset) => ({
                text: `${operator.available ? '🟢' : '🔴'} ${operator.name}`.slice(0, 35),
                callbackData: `tg_cp_operator:${currentPage * pageSize + i + offset}`,
                style: operator.available ? 'primary' : 'danger'
            })))
        }
        const nav = []
        if (currentPage > 0) nav.push({ text: '⬅️ Sebelumnya', callbackData: `tg_cp_page:${currentPage - 1}` })
        if (currentPage < pages - 1) nav.push({ text: '➡️ Berikutnya', callbackData: `tg_cp_page:${currentPage + 1}` })
        if (nav.length) rows.push(nav)
        rows.push([{ text: '📚 Riwayat', callbackData: 'tg_cp_history' }, { text: '❌ Tutup', callbackData: 'tg_cp_cancel' }])
        const lines = [
            `Operator aktif: ${operators.filter(item => item.available).length} dari ${operators.length}`,
            `Halaman ${currentPage + 1}/${pages}`,
            '',
            ...shown.map(operator => `${operator.available ? '🟢' : '🔴'} ${operator.name} · ${convertPulsaRateLabel(operator)} · min ${operator.minAmount ? `Rp${convertPulsaService.formatMoney(operator.minAmount)}` : 'sesuai API'}`),
            '',
            'Pilih operator dari tombol. Operator offline tidak dapat digunakan.',
            'Kurs, batas nominal, dan metode pencairan selalu mengikuti API PesanJasa.'
        ]
        return sendConvertPulsaRich(ctx, { title: '💱 CONVERT PULSA', lines, buttonRows: rows, screen: 'convert_pulsa' })
    } catch (error) {
        console.error('[TELEGRAM CONVERT PULSA RATES]', error?.stack || error)
        return sendConvertPulsaRich(ctx, {
            title: '⚠️ API CONVERT PULSA TIDAK TERSEDIA',
            lines: [convertPulsaSafeInstruction(error?.message || error, 500), 'Tidak ada transaksi yang dibuat. Coba lagi setelah API pulih.'],
            buttonRows: [[{ text: '🔄 Coba Lagi', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu Utama', callbackData: 'tg_home' }]],
            screen: 'convert_pulsa'
        })
    }
}

async function showConvertPulsaTelegramAmount(ctx, rawAmount = '') {
    const session = convertPulsaTelegramSession(ctx)
    if (!session || !['amount', 'operator'].includes(String(session.step || ''))) {
        return showConvertPulsaTelegramMenu(ctx)
    }
    const operator = (session.operators || []).find(item => String(item.id) === String(session.operatorId))
    if (!operator) return showConvertPulsaTelegramMenu(ctx)
    if (!operator.available) {
        return sendConvertPulsaRich(ctx, {
            title: '⚠️ OPERATOR SEDANG OFFLINE',
            lines: [`${operator.name} sedang offline atau maintenance menurut API PesanJasa. Pilih operator lain.`, 'Tidak ada transaksi yang dibuat.'],
            buttonRows: [[{ text: '⬅️ Pilih Operator', callbackData: 'tg_home_convertpulsa' }, { text: '❌ Tutup', callbackData: 'tg_cp_cancel' }]],
            screen: 'convert_pulsa'
        })
    }
    const amount = rawAmount ? convertPulsaService.amountValue(rawAmount) : NaN
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        const candidates = [10000, 20000, 50000, 100000, 200000, 500000]
            .map(value => Math.max(value, Number(operator.minAmount || 1)))
            .filter(value => Number.isSafeInteger(value) && value > 0 && (operator.maxAmount == null || value <= operator.maxAmount))
        if (operator.minAmount != null) candidates.push(Number(operator.minAmount))
        if (operator.maxAmount != null) candidates.push(Number(operator.maxAmount))
        const unique = [...new Set(candidates)].sort((a, b) => a - b).slice(0, 8)
        const rows = []
        for (let i = 0; i < unique.length; i += 2) rows.push(unique.slice(i, i + 2).map(value => ({ text: `Rp${convertPulsaService.formatMoney(value)}`, callbackData: `tg_cp_amount:${value}` })))
        rows.push([{ text: '⬅️ Ganti Operator', callbackData: 'tg_home_convertpulsa' }, { text: '❌ Batal', callbackData: 'tg_cp_cancel' }])
        convertPulsaSaveTelegramSession(ctx, { step: 'amount', operatorId: String(operator.id), operatorName: operator.name })
        return sendConvertPulsaRich(ctx, {
            title: '💵 MASUKKAN NOMINAL PULSA',
            lines: [
                `Operator: ${operator.name}`,
                `Kurs indikatif: ${convertPulsaRateLabel(operator)}`,
                `Minimum: ${operator.minAmount ? `Rp${convertPulsaService.formatMoney(operator.minAmount)}` : 'sesuai API PesanJasa'}`,
                `Maksimum: ${operator.maxAmount ? `Rp${convertPulsaService.formatMoney(operator.maxAmount)}` : 'sesuai API PesanJasa'}`,
                '',
                'Pilih nominal di tombol atau kirim nominal sebagai pesan angka, misalnya 50000.',
                'Nominal akhir dan estimasi akan dikalkulasi ulang melalui API sebelum order dibuat.'
            ],
            buttonRows: rows,
            screen: 'convert_pulsa'
        })
    }
    if (operator.minAmount != null && amount < operator.minAmount) {
        return sendConvertPulsaRich(ctx, { title: '❌ NOMINAL DI BAWAH MINIMUM', lines: [`Minimum ${operator.name}: Rp${convertPulsaService.formatMoney(operator.minAmount)}`], buttonRows: [[{ text: '⬅️ Coba Lagi', callbackData: 'tg_cp_prompt_amount' }, { text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
    }
    if (operator.maxAmount != null && amount > operator.maxAmount) {
        return sendConvertPulsaRich(ctx, { title: '❌ NOMINAL MELEBIHI BATAS', lines: [`Maksimum ${operator.name}: Rp${convertPulsaService.formatMoney(operator.maxAmount)}`], buttonRows: [[{ text: '⬅️ Coba Lagi', callbackData: 'tg_cp_prompt_amount' }, { text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
    }
    try {
        const quote = await convertPulsaService.calculate(operator.id, amount)
        const latest = convertPulsaTelegramSession(ctx) || session
        convertPulsaSaveTelegramSession(ctx, {
            ...latest, step: 'payout', operatorId: String(operator.id), operatorName: operator.name,
            amount, estimatedAmount: quote.estimatedAmount, fee: quote.fee, rate: quote.rate,
            payoutPage: 0, quoteAt: Date.now()
        })
        return showConvertPulsaTelegramPayouts(ctx, 0)
    } catch (error) {
        console.error('[TELEGRAM CONVERT PULSA CALCULATE]', error?.stack || error)
        return sendConvertPulsaRich(ctx, {
            title: '❌ GAGAL MENGHITUNG ESTIMASI',
            lines: [convertPulsaSafeInstruction(error?.message || error, 500), 'Belum ada order yang dibuat. Coba lagi nanti.'],
            buttonRows: [[{ text: '🔄 Ulangi Nominal', callbackData: 'tg_cp_prompt_amount' }, { text: '❌ Batal', callbackData: 'tg_cp_cancel' }]],
            screen: 'convert_pulsa'
        })
    }
}

async function showConvertPulsaTelegramPayouts(ctx, page = 0) {
    const session = convertPulsaTelegramSession(ctx)
    if (!session || session.step !== 'payout') return showConvertPulsaTelegramMenu(ctx)
    const methods = safeConvertPulsaMethods(session.payoutMethods)
    if (!methods.length) {
        convertPulsaService.clearSession('telegram', convertPulsaTelegramUserId(ctx))
        return sendConvertPulsaRich(ctx, {
            title: '⚠️ METODE PENCAIRAN BELUM TERSEDIA',
            lines: ['API /rates PesanJasa tidak mengembalikan daftar metode pencairan yang dapat dikenali.', 'Demi menghindari salah tujuan, tidak ada daftar e-wallet buatan sendiri dan order tidak dibuat. Hubungi PesanJasa untuk memastikan format respons API.'],
            buttonRows: [[{ text: '🔄 Ambil Ulang Data', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu', callbackData: 'tg_home' }]],
            screen: 'convert_pulsa'
        })
    }
    const pageSize = 8
    const pages = Math.max(1, Math.ceil(methods.length / pageSize))
    const currentPage = Math.max(0, Math.min(pages - 1, Number(page) || 0))
    const shown = methods.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    const rows = []
    for (let i = 0; i < shown.length; i += 2) rows.push(shown.slice(i, i + 2).map((method, offset) => ({
        text: `💳 ${method.label || method.value}`.slice(0, 35),
        callbackData: `tg_cp_payout:${currentPage * pageSize + i + offset}`
    })))
    const nav = []
    if (currentPage > 0) nav.push({ text: '⬅️ Sebelumnya', callbackData: `tg_cp_payoutpage:${currentPage - 1}` })
    if (currentPage < pages - 1) nav.push({ text: '➡️ Berikutnya', callbackData: `tg_cp_payoutpage:${currentPage + 1}` })
    if (nav.length) rows.push(nav)
    rows.push([{ text: '⬅️ Ubah Nominal', callbackData: 'tg_cp_prompt_amount' }, { text: '❌ Batal', callbackData: 'tg_cp_cancel' }])
    return sendConvertPulsaRich(ctx, {
        title: '💳 PILIH E-WALLET TUJUAN',
        lines: [
            `Operator: ${session.operatorName}`,
            `Pulsa: Rp${convertPulsaService.formatMoney(session.amount)}`,
            `Estimasi diterima: ${session.estimatedAmount == null ? 'Belum diberikan API' : `Rp${convertPulsaService.formatMoney(session.estimatedAmount)}`}`,
            `Kurs indikatif: ${session.rate == null ? 'sesuai kalkulasi API' : `${(Number(session.rate) * 100).toFixed(2).replace(/\.00$/, '')}%`}`,
            '',
            'Pilih metode yang benar-benar disediakan PesanJasa. Pastikan nama aplikasi dan nomor tujuan cocok sebelum lanjut.'
        ], buttonRows: rows, screen: 'convert_pulsa'
    })
}

async function handleConvertPulsaTelegramText(ctx, text) {
    if (!privateChat(ctx)) return false
    const session = convertPulsaTelegramSession(ctx)
    if (!session) return false
    const value = String(text || '').trim()
    if (!value || value.startsWith('/')) return false
    if (session.step === 'proof_upload') {
        await sendConvertPulsaRich(ctx, { title: '🧾 MENUNGGU FOTO BUKTI', lines: ['Kirim screenshot bukti transfer sebagai FOTO biasa, bukan teks atau dokumen. Maksimal 8 MB.', 'Foto akan diteruskan ke admin untuk review manual; status provider tetap mengikuti PesanJasa.'], buttonRows: [[{ text: '❌ Batal kirim bukti', callbackData: 'tg_cp_proof_cancel' }]], screen: 'convert_pulsa_proof' })
        return true
    }
    if (session.step === 'amount') {
        await showConvertPulsaTelegramAmount(ctx, value)
        return true
    }
    if (session.step === 'payout_number') {
        const number = value.replace(/[\s-]/g, '')
        if (!/^[0-9]{6,30}$/.test(number)) {
            await sendConvertPulsaRich(ctx, { title: '❌ NOMOR TUJUAN TIDAK VALID', lines: ['Masukkan nomor rekening/akun e-wallet sesuai arahan provider (6–30 digit).', 'Belum ada order dibuat.'], buttonRows: [[{ text: '↩️ Masukkan Lagi', callbackData: 'tg_cp_prompt_payout_number' }, { text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
            return true
        }
        convertPulsaSaveTelegramSession(ctx, { step: 'payout_name', payoutAccountNumber: number })
        await sendConvertPulsaRich(ctx, { title: '👤 NAMA PEMILIK E-WALLET', lines: [`Metode: ${session.payoutMethodLabel || session.payoutMethod}`, `Nomor tujuan: ${number}`, '', 'Kirim nama pemilik akun sesuai data di e-wallet.'], buttonRows: [[{ text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
        return true
    }
    if (session.step === 'payout_name') {
        const name = value.replace(/\s+/g, ' ').trim()
        if (name.length < 2 || name.length > 80) {
            await sendConvertPulsaRich(ctx, { title: '❌ NAMA TIDAK VALID', lines: ['Nama harus 2–80 karakter. Kirim ulang sesuai nama akun tujuan.'], buttonRows: [[{ text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
            return true
        }
        convertPulsaSaveTelegramSession(ctx, { step: 'sender_phone', payoutAccountName: name })
        await sendConvertPulsaRich(ctx, { title: '📱 NOMOR PENGIRIM PULSA', lines: ['Masukkan nomor HP pengirim pulsa yang akan dipakai mengirim pulsa ke nomor tujuan PesanJasa.', 'Gunakan format angka saja, termasuk kode negara bila diminta provider.'], buttonRows: [[{ text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
        return true
    }
    if (session.step === 'sender_phone') {
        const number = value.replace(/[\s()+-]/g, '')
        if (!/^[0-9]{8,15}$/.test(number)) {
            await sendConvertPulsaRich(ctx, { title: '❌ NOMOR PENGIRIM TIDAK VALID', lines: ['Gunakan nomor HP 8–15 digit tanpa karakter lain.'], buttonRows: [[{ text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
            return true
        }
        const final = convertPulsaSaveTelegramSession(ctx, { step: 'confirm', senderPhoneNumber: number })
        const estimate = final.estimatedAmount == null ? 'Belum diberikan API' : `Rp${convertPulsaService.formatMoney(final.estimatedAmount)}`
        await sendConvertPulsaRich(ctx, {
            title: '🔎 KONFIRMASI CONVERT PULSA',
            lines: [
                `Operator: ${final.operatorName}`,
                `Nominal pulsa: Rp${convertPulsaService.formatMoney(final.amount)}`,
                `Estimasi diterima: ${estimate}`,
                `Metode: ${final.payoutMethodLabel || final.payoutMethod}`,
                `Nomor e-wallet: ${final.payoutAccountNumber}`,
                `Nama penerima: ${final.payoutAccountName}`,
                `Nomor pengirim: ${final.senderPhoneNumber}`,
                '',
                'Periksa seluruh data. Tekan BUAT ORDER hanya bila semuanya benar. Setelah order dibuat, ikuti instruksi resmi PesanJasa. Jangan kirim pulsa sebelum nomor tujuan resmi muncul.'
            ],
            buttonRows: [[{ text: '✅ Buat Order', callbackData: 'tg_cp_create', style: 'success' }], [{ text: '✏️ Ganti Nominal', callbackData: 'tg_cp_prompt_amount' }, { text: '❌ Batalkan', callbackData: 'tg_cp_cancel', style: 'danger' }]],
            screen: 'convert_pulsa'
        })
        return true
    }
    return false
}

async function createConvertPulsaTelegramOrder(ctx) {
    const userId = convertPulsaTelegramUserId(ctx)
    if (!userId) return commandOutput(ctx, '🔒 Transaksi convert pulsa hanya dapat dibuat di chat pribadi.')
    const session = convertPulsaTelegramSession(ctx)
    if (!session || session.step !== 'confirm') return showConvertPulsaTelegramMenu(ctx)
    try {
        const tx = await convertPulsaService.createOrder({ channel: 'telegram', userId, pushname: ctx.from?.first_name || ctx.from?.username || 'Telegram User' })
        return showConvertPulsaTelegramTransaction(ctx, tx)
    } catch (error) {
        console.error('[TELEGRAM CONVERT PULSA CREATE]', error?.stack || error)
        const tx = error?.localRef ? convertPulsaService.findOrder(error.localRef) : null
        if (tx) return showConvertPulsaTelegramTransaction(ctx, tx)
        if (error?.code === 'ESTIMATE_CHANGED') {
            const latest = convertPulsaTelegramSession(ctx)
            if (latest?.step === 'confirm') {
                return sendConvertPulsaRich(ctx, {
                    title: '⚠️ KURS BERUBAH — KONFIRMASI ULANG',
                    lines: [
                        `Operator: ${latest.operatorName}`,
                        `Nominal pulsa: Rp${convertPulsaService.formatMoney(latest.amount)}`,
                        `Estimasi terbaru: Rp${convertPulsaService.formatMoney(latest.estimatedAmount)}`,
                        `Metode: ${latest.payoutMethodLabel || latest.payoutMethod}`,
                        `Nomor tujuan: ${latest.payoutAccountNumber}`,
                        `Nama penerima: ${latest.payoutAccountName}`,
                        `Nomor pengirim: ${latest.senderPhoneNumber}`,
                        '',
                        'Belum ada order dibuat. Periksa estimasi terbaru dan tekan Buat Order sekali lagi hanya jika setuju.'
                    ],
                    buttonRows: [[{ text: '✅ Setuju & Buat Order', callbackData: 'tg_cp_create', style: 'success' }], [{ text: '❌ Batalkan Draft', callbackData: 'tg_cp_cancel', style: 'danger' }]],
                    screen: 'convert_pulsa'
                })
            }
        }
        return sendConvertPulsaRich(ctx, { title: '❌ ORDER BELUM DIBUAT', lines: [convertPulsaSafeInstruction(error?.message || error, 650), 'Jangan kirim pulsa sebelum instruksi resmi dari PesanJasa muncul.'], buttonRows: [[{ text: '🔄 Mulai Ulang', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
    }
}

async function showConvertPulsaTelegramTransaction(ctx, tx) {
    const rows = []
    if (tx?.ref) rows.push([{ text: '🔄 Cek Status', callbackData: `tg_cp_status:${tx.ref}` }])
    if (convertPulsaTelegramProofAllowed(tx) && Number(tx.proofCount || 0) < 3) rows.push([{ text: '🧾 Kirim Bukti', callbackData: `tg_cp_proof_start:${tx.ref}` }])
    rows.push([{ text: '💱 Convert Lagi', callbackData: 'tg_home_convertpulsa' }, { text: '📚 Riwayat', callbackData: 'tg_cp_history' }])
    rows.push([{ text: '🏠 Menu Utama', callbackData: 'tg_home' }])
    return sendConvertPulsaRich(ctx, { title: '💱 DETAIL CONVERT PULSA', lines: convertPulsaTransactionLines(tx), buttonRows: rows, screen: 'convert_pulsa_transaction', edit: Boolean(ctx.callbackQuery) })
}

async function handleConvertPulsaTelegramStatus(ctx, ref) {
    const userId = convertPulsaTelegramUserId(ctx)
    const key = String(ref || '').trim().toUpperCase()
    const tx = convertPulsaService.findOrder(key)
    if (!userId || !tx || tx.channel !== 'telegram' || tx.userId !== userId) {
        return sendConvertPulsaRich(ctx, { title: '❌ TRANSAKSI TIDAK DITEMUKAN', lines: ['Referensi tidak ditemukan atau bukan milik akun Telegram ini.'], buttonRows: [[{ text: '📚 Riwayat', callbackData: 'tg_cp_history' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
    }
    try {
        let current = tx
        if (current.providerTrxId && !convertPulsaService.isTerminal(current.status) && current.status !== 'REVIEW_REQUIRED') {
            current = await convertPulsaService.refresh(key, { channel: 'telegram', userId })
        }
        return showConvertPulsaTelegramTransaction(ctx, current)
    } catch (error) {
        console.error('[TELEGRAM CONVERT PULSA STATUS]', error?.stack || error)
        return sendConvertPulsaRich(ctx, { title: '⚠️ STATUS BELUM BISA DIPERBARUI', lines: [...convertPulsaTransactionLines(tx), '', convertPulsaSafeInstruction(error?.message || error, 300), 'Status tersimpan tidak diganti. Jangan mengirim pulsa ulang.'], buttonRows: [[{ text: '🔄 Coba Lagi', callbackData: `tg_cp_status:${tx.ref}` }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa_transaction' })
    }
}

async function listConvertPulsaTelegramHistory(ctx) {
    const userId = convertPulsaTelegramUserId(ctx)
    if (!userId) return commandOutput(ctx, '🔒 Riwayat convert pulsa hanya tersedia di chat pribadi.')
    const txs = convertPulsaService.listByUser('telegram', userId, 8)
    if (!txs.length) return sendConvertPulsaRich(ctx, { title: '📚 RIWAYAT CONVERT PULSA', lines: ['Belum ada transaksi. Pilih Mulai Convert untuk mengambil kurs terbaru.'], buttonRows: [[{ text: '💱 Mulai Convert', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
    const rows = txs.slice(0, 8).map(tx => [{ text: `${tx.operatorName || 'Operator'} · Rp${convertPulsaService.formatMoney(tx.amount)}`.slice(0, 35), callbackData: `tg_cp_status:${tx.ref}` }])
    rows.push([{ text: '💱 Mulai Convert', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu', callbackData: 'tg_home' }])
    const lines = txs.map((tx, i) => `${i + 1}. ${tx.ref}\n   ${tx.operatorName || '-'} · Rp${convertPulsaService.formatMoney(tx.amount)}\n   ${convertPulsaStatusLabel(tx.status)}`)
    return sendConvertPulsaRich(ctx, { title: '📚 RIWAYAT CONVERT PULSA', lines, buttonRows: rows, screen: 'convert_pulsa_history' })
}

async function cancelConvertPulsaTelegramDraft(ctx) {
    const userId = convertPulsaTelegramUserId(ctx)
    if (!userId) return commandOutput(ctx, '🔒 Fitur ini hanya tersedia di chat pribadi.')
    const session = convertPulsaTelegramSession(ctx)
    if (!session) return sendConvertPulsaRich(ctx, { title: 'ℹ️ TIDAK ADA DRAFT', lines: ['Tidak ada draft convert pulsa yang aktif.'], buttonRows: [[{ text: '💱 Mulai Convert', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
    if (session.requestedAt || session.localRef) {
        const tx = session.localRef ? convertPulsaService.findOrder(session.localRef) : null
        return sendConvertPulsaRich(ctx, { title: '⚠️ ORDER PERLU DIPERIKSA', lines: [`Referensi lokal: ${tx?.ref || session.localRef || '-'}`, `Status: ${convertPulsaStatusLabel(tx?.status || 'REVIEW_REQUIRED')}`, 'Permintaan order sudah dimulai dan tidak bisa dibatalkan otomatis melalui bot. Jangan mengirim pulsa sebelum instruksi resmi dari PesanJasa muncul. Periksa status/riwayat atau hubungi owner untuk rekonsiliasi.'], buttonRows: [[{ text: '📚 Riwayat', callbackData: 'tg_cp_history' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
    }
    convertPulsaService.clearSession('telegram', userId)
    return sendConvertPulsaRich(ctx, { title: '✅ DRAFT DIBATALKAN', lines: ['Draft dihapus. Tidak ada order PesanJasa yang dibuat dan tidak ada pulsa yang diproses.'], buttonRows: [[{ text: '💱 Mulai Lagi', callbackData: 'tg_home_convertpulsa' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
}

async function persistTelegramPaymentMessages(paymentRef, messages = []) {
    const ref = String(paymentRef || '').trim()
    if (!ref || typeof depositService.updateMessageReferences !== 'function') return false
    const refs = (Array.isArray(messages) ? messages : []).filter(message => message?.chat?.id != null && message?.message_id != null)
        .map(message => ({ chatId: String(message.chat.id), messageId: Number(message.message_id) }))
        .filter(item => item.chatId && Number.isSafeInteger(item.messageId) && item.messageId > 0)
    try {
        await depositService.updateMessageReferences(ref, { telegramMessageRefs: refs, messagesDeletedAt: null })
        return true
    } catch (error) {
        console.error('[TELEGRAM PAYMENT MESSAGE REFERENCES]', ref, error?.message || error)
        return false
    }
}

async function deleteTelegramPaymentMessages(transaction, fallbackChatId = null) {
    const ref = String(transaction?.merchantRef || '').trim()
    if (!ref || typeof depositService.updateMessageReferences !== 'function') return { deleted: 0, failed: false }
    const refs = Array.isArray(transaction.telegramMessageRefs) ? transaction.telegramMessageRefs : []
    let deleted = 0
    let failed = false
    const unique = new Map()
    for (const item of refs) {
        const chatId = String(item?.chatId || fallbackChatId || '')
        const messageId = Number(item?.messageId)
        if (!chatId || !Number.isSafeInteger(messageId) || messageId <= 0) continue
        unique.set(`${chatId}:${messageId}`, { chatId, messageId })
    }
    // No persisted message IDs means we cannot honestly confirm deletion.
    if (!unique.size) {
        if (transaction?.messagesDeletedAt) return { deleted: 0, failed: false, alreadyDeleted: true }
        return { deleted: 0, failed: true, missingReferences: true }
    }
    for (const item of unique.values()) {
        try {
            await bot.telegram.deleteMessage(item.chatId, item.messageId)
            deleted++
        } catch (error) {
            const reason = String(error?.description || error?.message || error).toLowerCase()
            if (reason.includes('message to delete not found') || reason.includes('message identifier is not specified')) {
                deleted++
                continue
            }
            failed = true
            console.error('[TELEGRAM DELETE QRIS MESSAGE]', ref, item.chatId, item.messageId, error?.description || error?.message || error)
        }
    }
    if (!failed) {
        try {
            await depositService.updateMessageReferences(ref, { telegramMessageRefs: [], messagesDeletedAt: Date.now() })
        } catch (error) {
            failed = true
            console.error('[TELEGRAM CLEAR QRIS MESSAGE REFERENCES]', ref, error?.message || error)
        }
    }
    return { deleted, failed }
}

async function safeQrBuffer(label, producer) {
    try {
        const image = await producer()
        if (image && Buffer.isBuffer(image) && image.length) return image
        if (image) return image
        console.warn(`[TELEGRAM ${label} QR] Provider tidak mengembalikan gambar QR.`)
        return null
    } catch (err) {
        console.error(`[TELEGRAM ${label} QR]`, err?.stack || err)
        return null
    }
}

async function handleStoreOrder(ctx, index, { edit = true } = {}) {
    if (!privateChat(ctx)) return commandOutput(ctx, '🔒 Checkout Store hanya bisa dibuat di chat pribadi untuk menjaga data pembayaran dan mencegah order ganda.')
    const jid = storeJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const list = getUi(ctx.from.id)?.storeProducts || storeService.products()
    const product = list[Number(index)]
    if (!product) return edit ? renderStore(ctx, 0) : commandOutput(ctx, '❌ Produk tidak ditemukan.')

    try {
        const created = await storeService.createOrder({
            jid,
            productKey: product.key,
            pushname: ctx.from?.first_name || ctx.from?.username || 'Telegram User'
        })
        const order = created.order
        const payment = created.payment || {}
        const paymentRef = String(payment.merchantRef || order.paymentRef || '').trim()
        const image = await safeQrBuffer('STORE', () => storeService.qrBuffer(order))
        const paymentAmount = Number(payment.paymentAmount || order.paymentAmount || order.price || 0)
        const expiresAt = Number(payment.expiredAt || order.expiresAt || 0)
        const expiryText = expiresAt ? new Date(expiresAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) : 'Tidak diberikan provider'

        // Hapus kartu pemilih metode lama agar callback checkout yang sudah dipakai
        // tidak tersisa dan tidak membuat pesanan kedua ketika ditekan lagi.
        const origin = ctx.callbackQuery?.message
        if (origin?.chat?.id != null && origin?.message_id != null) {
            try { await ctx.telegram.deleteMessage(origin.chat.id, origin.message_id) } catch (error) {
                console.warn('[TELEGRAM STORE REMOVE CHECKOUT PICKER]', error?.description || error?.message || error)
            }
        }

        let qrMessage = null
        if (image) {
            let paymentCard = null
            try {
                paymentCard = await makeTelegramStoreCard('qris', {
                    order, amount: paymentAmount,
                    paymentName: `${payment.paymentName || order.paymentMethod || 'QRIS'} via ${payment.providerName || order.paymentProvider || 'NasionalPay'}`,
                    qrBuffer: image
                })
            } catch (imageError) {
                console.error('[TELEGRAM STORE QRIS CARD]', imageError?.message || imageError)
            }
            try {
                qrMessage = await ctx.replyWithPhoto({ source: paymentCard || image }, {
                    caption: `💳 QRIS ORDER STORE\nOrder: ${escapeHtml(order.ref)}\nNominal: Rp${escapeHtml(storeService.formatMoney(paymentAmount))}\nMasa berlaku: ${escapeHtml(expiryText)}\n\nGunakan tombol Rich Message di pesan berikut untuk cek status atau membatalkan order.`,
                    parse_mode: 'HTML'
                })
            } catch (imageError) {
                console.error('[TELEGRAM STORE QRIS PHOTO SEND]', imageError?.message || imageError)
                qrMessage = null
            }
        }

        const checkoutUrl = String(payment.checkoutUrl || order.checkoutUrl || '').trim()
        const lines = [
            `Order: ${order.ref}`,
            `Produk: ${order.productName}`,
            `Nominal bayar: Rp${storeService.formatMoney(paymentAmount)}`,
            `Metode: ${payment.paymentName || order.paymentMethod || 'QRIS'} via ${payment.providerName || order.paymentProvider || 'NasionalPay'}`,
            `Status: ${String(order.paymentStatus || order.status || 'UNPAID').toUpperCase()}`,
            `Batas waktu: ${expiryText}`,
            '',
            qrMessage ? 'QRIS terkirim pada pesan gambar sebelumnya. Bayar hanya sesuai nominal yang tertera.' : checkoutUrl ? 'Gambar QRIS tidak dapat ditampilkan. Gunakan tombol link pembayaran resmi di bawah.' : 'PERINGATAN: QRIS tidak berhasil ditampilkan dan tidak ada link pembayaran resmi. Jangan transfer; cek status atau batalkan invoice.'
        ]
        const richBlocks = [
            { type: 'heading', text: '🧾 ORDER STORE BERHASIL DIBUAT', size: 2 },
            { type: 'paragraph', text: lines.join('\n') },
            { type: 'divider' },
            richButtonBlock([
                makeRichButton('🔄 CEK STATUS PEMBAYARAN', `tg_store_status:${order.ref}`, 'success'),
                makeRichButton('❌ BATALKAN ORDER', `tg_store_cancel:${order.ref}`, 'danger')
            ])
        ]
        if (checkoutUrl && /^https?:\/\//i.test(checkoutUrl)) richBlocks.push(richButtonBlock([makeRichUrlButton('🔗 BUKA PEMBAYARAN RESMI', checkoutUrl)]))
        richBlocks.push(richButtonBlock([makeRichButton('📦 TOKO', 'tg_home_store'), makeRichButton('🏠 MENU UTAMA', 'tg_home')]))
        richBlocks.push({ type: 'footer', text: 'Xeryuu-MD V16 × Sendrich • Pembayaran Store' })

        let controlMessage = null
        try {
            controlMessage = await sendOrEditRichMessage(ctx, { blocks: richBlocks }, { edit: false })
        } catch (richError) {
            console.warn('[TELEGRAM STORE PAYMENT RICH FALLBACK]', richError?.description || richError?.message || richError)
            const rows = [
                [Markup.button.callback('🔄 CEK STATUS', `tg_store_status:${order.ref}`), Markup.button.callback('❌ BATALKAN', `tg_store_cancel:${order.ref}`)],
                ...(checkoutUrl && /^https?:\/\//i.test(checkoutUrl) ? [[Markup.button.url('🔗 BUKA PEMBAYARAN', checkoutUrl)]] : []),
                [Markup.button.callback('📦 TOKO', 'tg_home_store'), Markup.button.callback('🏠 MENU', 'tg_home')]
            ]
            controlMessage = await ctx.reply(`<b>🧾 ORDER STORE BERHASIL DIBUAT</b>\n\n${lines.map(escapeHtml).join('\n')}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows), disable_web_page_preview: true })
        }
        if (paymentRef) await persistTelegramPaymentMessages(paymentRef, [qrMessage, controlMessage])
        setUi(ctx.from.id, {
            chatId: controlMessage?.chat?.id || ctx.chat.id,
            messageId: controlMessage?.message_id,
            messageType: 'rich', screen: 'store_payment',
            storeRef: order.ref, storeOrder: order, storePaymentRef: paymentRef,
            storeQrMessageId: qrMessage?.message_id || null
        })
        return controlMessage
    } catch (error) {
        console.error('[TELEGRAM STORE CREATE ORDER]', error?.stack || error)
        return sendConvertPulsaRich(ctx, {
            title: '❌ ORDER STORE GAGAL',
            lines: [convertPulsaSafeInstruction(error?.message || error, 600), 'Jika error muncul setelah pembayaran dibuat, jangan membuat order berulang; periksa daftar pesanan terlebih dahulu.'],
            buttonRows: [[{ text: '📦 Pesanan Saya', callbackData: 'tg_store_orders' }, { text: '🏠 Menu Utama', callbackData: 'tg_home' }]],
            screen: 'store_payment_error'
        })
    }
}

async function handleStoreStatus(ctx, ref) {
    const jid = storeJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const key = String(ref || '').toUpperCase()
    const order = storeService.getOrder(key)
    if (!order) return editTracked(ctx, '❌ Order tidak ditemukan.', backHomeKeyboard())
    if (order.jid !== jid) return editTracked(ctx, '❌ Order tersebut bukan milik akun kamu.', backHomeKeyboard())
    try {
        let currentOrder = storeService.getOrder(key) || order
        if (currentOrder.paymentRef) {
            const payment = await depositService.check(currentOrder.paymentRef)
            const paymentState = String(payment.status || '').toUpperCase()
            if (paymentState === 'PAID') {
                await storeService.handlePaid(payment)
            } else if (['EXPIRED', 'FAILED', 'CANCELED', 'REFUNDED'].includes(paymentState)) {
                currentOrder = storeService.updateOrder(key, { status: paymentState, paymentStatus: paymentState }) || currentOrder
            }
            currentOrder = storeService.getOrder(key) || currentOrder
        }
        const state = String(currentOrder.status || 'UNKNOWN').toUpperCase()
        const paymentState = String(currentOrder.paymentStatus || 'UNPAID').toUpperCase()
        const cancellable = paymentState !== 'PAID' && !['DONE', 'CANCELED', 'PAYMENT_FAILED', 'PAID_WAITING_FULFILLMENT', 'PROCESSING'].includes(state)
        const payment = currentOrder.paymentRef ? depositService.get(currentOrder.paymentRef) : null
        const lines = [
            `Order: ${currentOrder.ref}`,
            `Produk: ${currentOrder.productName}`,
            `Harga: Rp${storeService.formatMoney(currentOrder.price)}`,
            `Pembayaran: ${paymentState}`,
            `Order: ${state}`
        ]
        if (payment?.paymentAmount) lines.push(`Total bayar: Rp${storeService.formatMoney(payment.paymentAmount)}`)
        if (currentOrder.panel?.url) lines.push(`Panel: ${currentOrder.panel.url}`)
        if (currentOrder.panel?.username) lines.push(`Username: ${currentOrder.panel.username}`)
        if (currentOrder.panel?.password) lines.push(`Password (salin): ${currentOrder.panel.password}`)
        if (currentOrder.panel?.email) lines.push(`Email: ${currentOrder.panel.email}`)
        if (currentOrder.rental?.id) lines.push(`ID sewa: ${currentOrder.rental.id}`)
        if (currentOrder.productType === 'rental' && state === 'WAITING_GROUP_LINK') lines.push('Langkah berikutnya: kirim link grup WhatsApp ke bot sesuai instruksi order.')
        if (currentOrder.productType === 'jadibot' && state === 'WAITING_NUMBER') lines.push('Langkah berikutnya: kirim nomor WhatsApp yang akan dipairing melalui pesan berikutnya.')

        const richBlocks = [
            { type: 'heading', text: '📦 STATUS PESANAN STORE', size: 2 },
            { type: 'paragraph', text: lines.join('\n') },
            { type: 'divider' }
        ]
        const actionButtons = [makeRichButton('🔄 REFRESH STATUS', `tg_store_status:${currentOrder.ref}`)]
        if (currentOrder.productType === 'panel' && currentOrder.panel?.password && state === 'DONE') {
            actionButtons.push(makeRichButton('🔑 KIRIM PASSWORD (SALIN)', `tg_store_password:${currentOrder.ref}`, 'success'))
        }
        if (cancellable) actionButtons.push(makeRichButton('❌ BATALKAN ORDER', `tg_store_cancel:${currentOrder.ref}`, 'danger'))
        richBlocks.push(richButtonBlock(actionButtons))
        const checkoutUrl = String(payment?.checkoutUrl || currentOrder.checkoutUrl || '').trim()
        if (checkoutUrl && /^https?:\/\//i.test(checkoutUrl) && cancellable) {
            richBlocks.push(richButtonBlock([makeRichUrlButton('🔗 BUKA PEMBAYARAN RESMI', checkoutUrl)]))
        }
        richBlocks.push(richButtonBlock([makeRichButton('📦 TOKO', 'tg_home_store'), makeRichButton('🏠 MENU', 'tg_home')]))
        richBlocks.push({ type: 'footer', text: 'Xeryuu-MD V16 × Sendrich • Status Store' })
        const sent = await sendOrEditRichMessage(ctx, { blocks: richBlocks }, { edit: Boolean(ctx.callbackQuery) })
        setUi(ctx.from.id, {
            chatId: sent?.chat?.id || ctx.chat?.id,
            messageId: sent?.message_id || ctx.callbackQuery?.message?.message_id || getUi(ctx.from.id)?.messageId,
            messageType: 'rich', screen: 'store_status', storeRef: currentOrder.ref,
            storeOrder: currentOrder, storePaymentRef: currentOrder.paymentRef || null
        })
        return sent
    } catch (error) {
        console.error('[TELEGRAM STORE STATUS]', error?.stack || error)
        return editTracked(ctx, `❌ Gagal cek status pembayaran: ${escapeHtml(error?.message || error)}`, storeActionKeyboard(key, { showCancel: true, showStatus: true }))
    }
}

async function handleStoreCancel(ctx, ref) {
    const jid = storeJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const order = storeService.getOrder(ref)
    if (!order) return editTracked(ctx, '❌ Order tidak ditemukan.', backHomeKeyboard())
    if (order.jid !== jid) return editTracked(ctx, '❌ Order tersebut bukan milik akun kamu.', backHomeKeyboard())
    if (String(order.paymentStatus || '').toUpperCase() === 'PAID') return editTracked(ctx, '❌ Order sudah dibayar dan tidak bisa dibatalkan.', storeActionKeyboard(order.ref, { showCancel: false, showStatus: true }))
    try {
        const cancelled = await storeService.cancelOrder(order.ref, jid)
        const payment = cancelled.paymentRef ? depositService.get(cancelled.paymentRef) : null
        const cleanup = payment ? await deleteTelegramPaymentMessages(payment, ctx.chat?.id) : { deleted: 0, failed: false }
        const lines = [
            `Order: ${cancelled.ref}`,
            `Produk: ${cancelled.productName}`,
            `Status: ${cancelled.status}`,
            `Reservasi stok: dilepas`,
            `Pesan QRIS/kontrol dihapus: ${cleanup.deleted}`,
            cleanup.failed ? '⚠️ Telegram belum dapat mengonfirmasi semua penghapusan (ID pesan tidak tersimpan atau Telegram menolak). Jangan gunakan QR lama; bila pesan masih terlihat, hubungi owner.' : '✅ Pesan QRIS dan kontrol tersimpan berhasil dihapus.',
            '',
            'Pembatalan pada bot tidak menjamin QR provider langsung tidak berlaku; tagihan tersimpan tetap dipantau agar pembayaran terlambat tidak membuat order produk dua kali.'
        ]
        return sendConvertPulsaRich(ctx, {
            title: '✅ ORDER DIBATALKAN', lines,
            buttonRows: [[{ text: '📦 Buka Toko', callbackData: 'tg_home_store' }, { text: '📚 Pesanan Saya', callbackData: 'tg_store_orders' }], [{ text: '🏠 Menu Utama', callbackData: 'tg_home' }]],
            screen: 'store_cancelled', edit: false
        })
    } catch (error) {
        console.error('[TELEGRAM STORE CANCEL]', error?.stack || error)
        return editTracked(ctx, `❌ Gagal membatalkan order: ${escapeHtml(error?.message || error)}`, storeActionKeyboard(order.ref, { showCancel: true, showStatus: true }))
    }
}

async function listTelegramStoreOrders(ctx) {
    const jid = storeJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const list = storeService.listOrders(100).filter(order => order.jid === jid).slice(0, 10)
    if (!list.length) {
        const emptyText = `<blockquote>🐬 XNALZ AUTO ORDER SYSTEM</blockquote>\n📦 <b>PESANAN SAYA</b>\n\nBelum ada pesanan auto order.`
        const emptyKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🤖 MULAI BELANJA', 'tg_home_store')],
            [Markup.button.callback('🏠 MENU UTAMA', 'tg_home')]
        ])
        setUi(ctx.from.id, { screen: 'store_orders' })
        try {
            const richSent = await tryRenderRichMenu(ctx, emptyText, emptyKeyboard, {
                stage: 'store_orders', details: { orders: [] },
                edit: Boolean(ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId), hero: true
            })
            if (richSent) return richSent
        } catch (richError) {
            console.warn('[TELEGRAM STORE ORDERS RICH FALLBACK]', richError?.description || richError?.message || richError)
        }
        try {
            const card = await makeTelegramStoreCard('orders', { orders: [] })
            const rendered = await editTrackedPhoto(ctx, card, emptyText, emptyKeyboard)
            if (rendered) return rendered
        } catch (imageError) {
            console.error('[TELEGRAM STORE ORDERS CARD]', imageError?.message || imageError)
        }
        return editTracked(ctx, emptyText, emptyKeyboard)
    }
    const text = `<blockquote>🐬 XNALZ AUTO ORDER SYSTEM</blockquote>\n📦 <b>PESANAN SAYA</b>\n\n` +
        list.map((order, i) => {
            const status = String(order.paymentStatus || order.status || '-').toUpperCase()
            const date = order.createdAt ? new Date(order.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) : '-'
            return `${i + 1}. <b>${escapeHtml(order.productName)}</b>\n   🧾 <code>${escapeHtml(order.ref)}</code>\n   💰 Rp${escapeHtml(storeService.formatMoney(order.price))}\n   🔄 ${escapeHtml(status)}\n   📅 ${escapeHtml(date)}`
        }).join('\n\n')
    setUi(ctx.from.id, { screen: 'store_orders' })
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔄 REFRESH', 'tg_store_orders')],
        [Markup.button.callback('🤖 SEWA BOT', 'tg_home_store'), Markup.button.callback('🏠 MENU', 'tg_home')]
    ])
    try {
        const richSent = await tryRenderRichMenu(ctx, text, keyboard, {
            stage: 'store_orders', details: { orders: list },
            edit: Boolean(ctx?.callbackQuery || getUi(ctx.from?.id)?.messageId), hero: true
        })
        if (richSent) return richSent
    } catch (richError) {
        console.warn('[TELEGRAM STORE ORDERS RICH FALLBACK]', richError?.description || richError?.message || richError)
    }
    try {
        const card = await makeTelegramStoreCard('orders', { orders: list })
        const rendered = await editTrackedPhoto(ctx, card, text, keyboard)
        if (rendered) return rendered
    } catch (imageError) {
        console.error('[TELEGRAM STORE ORDERS CARD]', imageError?.message || imageError)
    }
    return editTracked(ctx, text, keyboard)
}

async function renderAdminPanel(ctx) {
    const owner = String(global.owner || '').replace(/\D/g, '')
    const linked = getJid(ctx)?.replace(/\D/g, '')
    const adminIds = Array.isArray(global.telegramConfig?.adminIds) ? global.telegramConfig.adminIds.map(String) : []
    const isAdmin = adminIds.includes(String(ctx.from?.id || '')) || Boolean(owner && linked === owner)
    if (!isAdmin) return editTracked(ctx, '⛔ <b>AKSES DITOLAK</b>\n\nPanel ini hanya untuk owner.', backHomeKeyboard())
    const stats = autoOrderStats()
    const pending = stats.orders.filter(order => !['DONE', 'CANCELED', 'PAYMENT_FAILED'].includes(String(order.status || '').toUpperCase()) && String(order.paymentStatus || '').toUpperCase() !== 'PAID').length
    const revenue = stats.orders.filter(order => String(order.paymentStatus || '').toUpperCase() === 'PAID').reduce((sum, order) => sum + Number(order.price || 0), 0)
    const text =
        `<blockquote>🐬 XNALZ AUTO ORDER SYSTEM</blockquote>\n` +
        `👑 <b>ADMIN PANEL</b>\n\n` +
        `📊 <b>STATISTIK SISTEM</b>\n` +
        `📦 Total Produk: <b>${stats.products.length}</b>\n` +
        `🧾 Total Order: <b>${stats.orders.length}</b>\n` +
        `⏳ Pending: <b>${pending}</b>\n` +
        `💰 Revenue: <b>Rp${storeService.formatMoney(revenue)}</b>\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚙️ <b>MANAGEMENT</b>`
    return editTracked(ctx, text, Markup.inlineKeyboard([
        [Markup.button.callback('📦 KELOLA ORDER', 'tg_store_orders')],
        [Markup.button.callback('🛒 KATALOG', 'tg_home_store')],
        [Markup.button.callback('📱 NOKOS', 'tg_home_nokos'), Markup.button.callback('🎮 TOP UP', 'tg_home_topup')],
        [Markup.button.callback('🔄 REFRESH', 'tg_admin_panel')],
        [Markup.button.callback('🏠 MENU UTAMA', 'tg_home')]
    ]))
}

function depositWalletTitle() {
    return 'Saldo Biasa'
}

function depositMinimum() {
    return typeof depositService.minAmount === 'function' ? depositService.minAmount() : 1000
}

function depositMaximum() {
    return typeof depositService.maxAmount === 'function' ? depositService.maxAmount() : Number(global.depositConfig?.maxAmount || 10000000)
}

function depositWalletReady() {
    return typeof depositService.ready === 'function' ? depositService.ready() : true
}

function depositWalletGateway() {
    return 'NasionalPay QRIS'
}

function getLatestCancellableDeposit(jid, provider = '') {
    if (typeof depositService.findLatestPending === 'function') {
        return depositService.findLatestPending(jid, provider)
    }

    const db = global.db?.deposits && typeof global.db.deposits === 'object' ? global.db.deposits : {}
    const key = String(provider || '').toLowerCase()

    return Object.values(db)
        .filter(tx => {
            if (!tx || tx.jid !== jid || tx.credited || !tx.gatewayId) return false
            if (key && String(tx.provider || '').toLowerCase() !== key) return false
            return !['PAID', 'SUCCESS', 'SETTLED', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELED'].includes(String(tx.status || '').toUpperCase())
        })
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null
}

function pendingDepositText(tx) {
    if (!tx) return ''
    const provider = tx.providerName || 'NasionalPay'
    return `\n\n⚠️ <b>Tagihan pending ditemukan</b>\nProvider: <b>${escapeHtml(provider)}</b>\nInvoice: <b>${escapeHtml(tx.merchantRef)}</b>\nNominal: <b>Rp${escapeHtml(depositService.formatMoney(tx.amount))}</b>`
}

async function showDepositProviderMenu(ctx, amount = '') {
    const jid = getTransactionJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')

    const normalizedAmount = String(amount || '').replace(/[^0-9]/g, '')
    const balance = economy.getBalance(jid)
    const min = depositMinimum()
    const max = depositMaximum()

    setUi(ctx.from.id, {
        screen: 'deposit_amount',
        pendingDepositAmount: normalizedAmount
    })

    if (normalizedAmount) {
        const ui = getUi(ctx.from.id) || {}
        delete ui.pendingDepositAmount
        setUi(ctx.from.id, ui)
        return handleDeposit(ctx, normalizedAmount)
    }

    const pending = typeof depositService.findPending === 'function'
        ? depositService.findPending(jid)
        : (typeof depositService.findLatestPending === 'function' ? [depositService.findLatestPending(jid)].filter(Boolean) : [])

    const presets = [1000, 5000, 10000, 20000, 50000, 100000].map(value => Math.max(min, value))
    const rows = [
        [Markup.button.callback(`Rp${depositService.formatMoney(presets[0])}`, `tg_deposit:nasionalpay:${presets[0]}`),
         Markup.button.callback(`Rp${depositService.formatMoney(presets[1])}`, `tg_deposit:nasionalpay:${presets[1]}`)],
        [Markup.button.callback(`Rp${depositService.formatMoney(presets[2])}`, `tg_deposit:nasionalpay:${presets[2]}`),
         Markup.button.callback(`Rp${depositService.formatMoney(presets[3])}`, `tg_deposit:nasionalpay:${presets[3]}`)],
        [Markup.button.callback(`Rp${depositService.formatMoney(presets[4])}`, `tg_deposit:nasionalpay:${presets[4]}`),
         Markup.button.callback(`Rp${depositService.formatMoney(presets[5])}`, `tg_deposit:nasionalpay:${presets[5]}`)]
    ]

    for (const tx of pending.slice(0, 10)) {
        rows.push([Markup.button.callback(
            `❌ Batalkan Deposit Rp${depositService.formatMoney(tx.amount)}`,
            `tg_deposit_cancel:${tx.merchantRef}`
        )])
    }

    rows.push([Markup.button.callback('🏠 Menu Utama', 'tg_home')])

    const depositText =
        `💳 <blockquote>DEPOSIT SALDO</blockquote>\n\n` +
        `💰 Saldo sekarang: <b>Rp${escapeHtml(economy.formatMoney(balance))}</b>\n` +
        `💵 Minimal: <b>Rp${escapeHtml(depositService.formatMoney(min))}</b>\n` +
        `💵 Maksimal: <b>Rp${escapeHtml(depositService.formatMoney(max))}</b>\n` +
        `🏦 Metode: <b>${escapeHtml(depositWalletGateway())}</b>\n\n` +
        `<blockquote>Pilih nominal di tombol bawah. Tagihan pending bisa dibatalkan dari tombol invoice.</blockquote>`
    return renderTelegramMenuCard(ctx, 'deposit_menu', {
        balance,
        minimum: min,
        maximum: max,
        pendingCount: pending.length,
        gateway: depositWalletGateway()
    }, depositText, Markup.inlineKeyboard(rows))
}

function depositAmountKeyboard() {
    const min = depositMinimum()
    const presets = [1000, 5000, 10000, 20000, 50000, 100000].map(value => Math.max(min, value))
    return Markup.inlineKeyboard([
        [
            Markup.button.callback(`Rp${depositService.formatMoney(presets[0])}`, `tg_deposit:nasionalpay:${presets[0]}`),
            Markup.button.callback(`Rp${depositService.formatMoney(presets[1])}`, `tg_deposit:nasionalpay:${presets[1]}`)
        ],
        [
            Markup.button.callback(`Rp${depositService.formatMoney(presets[2])}`, `tg_deposit:nasionalpay:${presets[2]}`),
            Markup.button.callback(`Rp${depositService.formatMoney(presets[3])}`, `tg_deposit:nasionalpay:${presets[3]}`)
        ],
        [
            Markup.button.callback(`Rp${depositService.formatMoney(presets[4])}`, `tg_deposit:nasionalpay:${presets[4]}`),
            Markup.button.callback(`Rp${depositService.formatMoney(presets[5])}`, `tg_deposit:nasionalpay:${presets[5]}`)
        ],
        [Markup.button.callback('🏠 Menu Utama', 'tg_home')]
    ])
}

async function showDepositAmounts(ctx) {
    return showDepositProviderMenu(ctx)
}

async function handleDeposit(ctx, amount) {
    if (!privateChat(ctx)) return commandOutput(ctx, '🔒 Deposit hanya dapat dibuat di chat pribadi.')
    const jid = getTransactionJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')

    const value = Number(String(amount || '').replace(/[^0-9]/g, ''))
    const min = depositMinimum()
    const max = depositMaximum()
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        return sendConvertPulsaRich(ctx, {
            title: '❌ NOMINAL DEPOSIT TIDAK VALID',
            lines: [`Minimal: Rp${depositService.formatMoney(min)}`, `Maksimal: Rp${depositService.formatMoney(max)}`],
            buttonRows: [[{ text: '💳 Deposit Lagi', callbackData: 'tg_home_deposit' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'deposit'
        })
    }
    if (!depositWalletReady()) {
        return sendConvertPulsaRich(ctx, {
            title: '❌ NASIONALPAY BELUM SIAP',
            lines: ['Isi konfigurasi NasionalPay terlebih dahulu. Tidak ada invoice yang dibuat.'],
            buttonRows: [[{ text: '💳 Coba Lagi', callbackData: 'tg_home_deposit' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'deposit'
        })
    }

    try {
        const tx = await depositService.create({ jid, amount: value, pushname: ctx.from?.first_name || 'Telegram User' })
        const image = await safeQrBuffer('DEPOSIT', () => depositService.qrBuffer(tx))
        const totalPay = Number(tx.totalPay || tx.paymentAmount || 0)
        const expiresAt = Number(tx.expiredAt || 0)
        const expiryText = expiresAt ? new Date(expiresAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) : 'Tidak diberikan provider'
        const origin = ctx.callbackQuery?.message
        if (origin?.chat?.id != null && origin?.message_id != null) {
            try { await ctx.telegram.deleteMessage(origin.chat.id, origin.message_id) } catch (error) {
                console.warn('[TELEGRAM DEPOSIT REMOVE PICKER]', error?.description || error?.message || error)
            }
        }

        let qrMessage = null
        if (image) {
            try {
                qrMessage = await ctx.replyWithPhoto({ source: image }, {
                    caption: `💳 QRIS DEPOSIT\nInvoice: ${escapeHtml(tx.merchantRef)}\nNominal: Rp${escapeHtml(depositService.formatMoney(tx.amount))}${totalPay && totalPay !== Number(tx.amount) ? `\nTotal bayar: Rp${escapeHtml(depositService.formatMoney(totalPay))}` : ''}\nBatas waktu: ${escapeHtml(expiryText)}`,
                    parse_mode: 'HTML'
                })
            } catch (sendError) {
                console.error('[TELEGRAM DEPOSIT QR PHOTO SEND]', sendError?.stack || sendError)
                qrMessage = null
            }
        }
        const checkoutUrl = String(tx.checkoutUrl || '').trim()
        const txStatus = String(tx.status || '').toUpperCase()
        const canCancelDeposit = !tx.credited && !['PAID', 'SUCCESS', 'SETTLED', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELED', 'CANCELLED'].includes(txStatus)
        const lines = [
            `Invoice: ${tx.merchantRef}`,
            `Nominal saldo: Rp${depositService.formatMoney(tx.amount)}`,
            ...(totalPay && totalPay !== Number(tx.amount) ? [`Total bayar: Rp${depositService.formatMoney(totalPay)}`] : []),
            `Gateway: ${tx.providerName || 'NasionalPay QRIS'}`,
            `Status: ${tx.status}`,
            `Batas waktu: ${expiryText}`,
            '',
            qrMessage ? 'QRIS dikirim pada pesan gambar sebelumnya. Bayar sesuai nominal tepat.' : checkoutUrl ? 'Gambar QRIS gagal ditampilkan. Gunakan hanya tombol link pembayaran resmi di bawah.' : 'PERINGATAN: QRIS gagal ditampilkan dan link pembayaran tidak tersedia. Jangan transfer; batalkan invoice atau hubungi owner.'
        ]
        const blocks = [
            { type: 'heading', text: '💳 QRIS DEPOSIT SALDO', size: 2 },
            { type: 'paragraph', text: lines.join('\n') },
            { type: 'divider' },
            richButtonBlock([makeRichButton('🔄 CEK STATUS', `tg_deposit_status:${tx.merchantRef}`, 'success'), ...(canCancelDeposit ? [makeRichButton('❌ BATALKAN DEPOSIT', `tg_deposit_cancel:${tx.merchantRef}`, 'danger')] : [])])
        ]
        if (checkoutUrl && /^https?:\/\//i.test(checkoutUrl)) blocks.push(richButtonBlock([makeRichUrlButton('🔗 BUKA INVOICE RESMI', checkoutUrl)]))
        blocks.push(richButtonBlock([makeRichButton('💳 DEPOSIT LAGI', 'tg_home_deposit'), makeRichButton('🏠 MENU UTAMA', 'tg_home')]))
        blocks.push({ type: 'footer', text: 'Xeryuu-MD V16 × Sendrich • Deposit QRIS' })

        let controlMessage = null
        try {
            controlMessage = await sendOrEditRichMessage(ctx, { blocks }, { edit: false })
        } catch (richError) {
            console.warn('[TELEGRAM DEPOSIT RICH FALLBACK]', richError?.description || richError?.message || richError)
            const keyboardRows = [
                [Markup.button.callback('🔄 CEK STATUS', `tg_deposit_status:${tx.merchantRef}`), ...(canCancelDeposit ? [Markup.button.callback('❌ BATALKAN DEPOSIT', `tg_deposit_cancel:${tx.merchantRef}`)] : [])],
                ...(checkoutUrl && /^https?:\/\//i.test(checkoutUrl) ? [[Markup.button.url('🔗 BUKA INVOICE', checkoutUrl)]] : []),
                [Markup.button.callback('💳 Deposit Lagi', 'tg_home_deposit'), Markup.button.callback('🏠 Menu', 'tg_home')]
            ]
            controlMessage = await ctx.telegram.sendMessage(ctx.chat.id, `<b>💳 QRIS DEPOSIT SALDO</b>\n\n${lines.map(escapeHtml).join('\n')}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard(keyboardRows), disable_web_page_preview: true })
        }
        await persistTelegramPaymentMessages(tx.merchantRef, [qrMessage, controlMessage])
        setUi(ctx.from.id, {
            chatId: controlMessage?.chat?.id || ctx.chat.id,
            messageId: controlMessage?.message_id,
            messageType: 'rich', screen: 'deposit',
            depositProvider: 'nasionalpay', depositRef: tx.merchantRef,
            depositPhotoMessageId: qrMessage?.message_id || null
        })
        return controlMessage
    } catch (error) {
        console.error('[TELEGRAM DEPOSIT CREATE]', error?.stack || error)
        const pending = error?.pendingRef ? depositService.get(error.pendingRef) : null
        const rows = [[{ text: '🔁 Coba Lagi', callbackData: 'tg_home_deposit' }]]
        if (pending) rows.push([{ text: '❌ Batalkan Deposit Pending', callbackData: `tg_deposit_cancel:${pending.merchantRef}` }])
        rows.push([{ text: '🏠 Menu Utama', callbackData: 'tg_home' }])
        return sendConvertPulsaRich(ctx, {
            title: '❌ DEPOSIT BELUM DAPAT DIBUAT',
            lines: [convertPulsaSafeInstruction(error?.message || error, 600), ...(pending ? [`Invoice pending: ${pending.merchantRef}`, `Nominal: Rp${depositService.formatMoney(pending.amount)}`] : [])],
            buttonRows: rows, screen: 'deposit'
        })
    }
}

async function handleDepositCancel(ctx, ref = '', provider = '') {
    const jid = getTransactionJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')

    let targetRef = String(ref || '').trim()
    if (!targetRef) {
        const providers = ['nasionalpay']

        const pending = providers
            .map(item => getLatestCancellableDeposit(jid, item))
            .filter(Boolean)
            .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))

        if (!pending.length) {
            return editTracked(
                ctx,
                `ℹ️ <b>TIDAK ADA DEPOSIT PENDING</b>\n\nTidak ada tagihan deposit yang masih bisa dibatalkan.`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('💳 Deposit Lagi', 'tg_home_deposit')],
                    [Markup.button.callback('🏠 Menu Utama', 'tg_home')]
                ])
            )
        }

        if (pending.length > 1) {
            const rows = pending.map(tx => [
                Markup.button.callback(
                    `❌ ${depositWalletTitle(tx.provider || tx.wallet)} Rp${depositService.formatMoney(tx.amount)}`,
                    `tg_deposit_cancel:${tx.merchantRef}`
                )
            ])
            rows.push([Markup.button.callback('🏠 Menu Utama', 'tg_home')])
            return editTracked(
                ctx,
                `❌ <b>PILIH DEPOSIT YANG AKAN DIBATALKAN</b>\n\nAda lebih dari satu invoice pending pada provider yang berbeda. Pilih salah satu:`,
                Markup.inlineKeyboard(rows)
            )
        }

        targetRef = pending[0].merchantRef
    }

    try {
        const tx = depositService.get(targetRef)
        if (!tx || tx.jid !== jid) {
            return editTracked(ctx, '❌ Invoice tidak ditemukan atau bukan milik kamu.', backHomeKeyboard())
        }
        if (String(tx.kind || 'DEPOSIT').toUpperCase() !== 'DEPOSIT') {
            return editTracked(ctx, '❌ Perintah ini hanya untuk invoice deposit saldo. Untuk order Store/Jadibot/Sewa Bot, gunakan menu/status order agar alur pembayaran dan stok tetap sinkron.', backHomeKeyboard())
        }

        const current = await depositService.cancel(targetRef, jid)
        const cleanup = await deleteTelegramPaymentMessages(current, ctx.chat?.id)
        const providerName = current.providerName || depositWalletTitle(current.provider || current.wallet)
        return sendConvertPulsaRich(ctx, {
            title: '✅ DEPOSIT DIBATALKAN',
            lines: [
                `Provider: ${providerName}`,
                `Invoice: ${current.merchantRef}`,
                `Nominal: Rp${depositService.formatMoney(current.amount)}`,
                `Status lokal: ${current.status}`,
                `Pesan QRIS/kontrol dihapus: ${cleanup.deleted}`,
                cleanup.failed ? '⚠️ Telegram belum dapat mengonfirmasi semua penghapusan (ID pesan tidak tersimpan atau Telegram menolak). Jangan gunakan QR lama; bila pesan masih terlihat, hubungi owner.' : '✅ Pesan QRIS dan kontrol berhasil dihapus.',
                '',
                'Catatan: pembatalan ini lokal di bot, bukan pencabutan QR di provider. Jika QR lama sudah tersimpan dan tetap dibayar, sistem akan mengamankan nominal terkonfirmasi ke Saldo Biasa agar dana tidak hilang.'
            ],
            buttonRows: [[{ text: '💳 Deposit Lagi', callbackData: 'tg_home_deposit' }, { text: '🏠 Menu Utama', callbackData: 'tg_home' }]],
            screen: 'deposit_cancelled', edit: false
        })

    } catch (error) {
        const current = depositService.get(targetRef)
        const state = String(current?.status || '').toUpperCase()
        const cancellable = Boolean(
            current &&
            current.gatewayId &&
            !current.credited &&
            !['PAID', 'SUCCESS', 'SETTLED', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELED'].includes(state)
        )

        return editTracked(
            ctx,
            `❌ <b>GAGAL MEMBATALKAN DEPOSIT</b>\n\n${escapeHtml(error?.message || error)}`,
            targetRef
                ? depositActionKeyboard(targetRef, { showCancel: cancellable, showStatus: true })
                : backHomeKeyboard()
        )
    }
}

async function handleDepositCancelLatest(ctx, provider = '') {
    return handleDepositCancel(ctx, '', provider)
}

function nokosSelling(cost) {
    return typeof nokosService.sellPrice === 'function'
        ? nokosService.sellPrice(cost)
        : Number(cost || 0) + Number(global.nokosConfig?.markup || 0)
}

async function loadNokosCatalog(service = 'wa') {
    return nokosService.getCatalog(service)
}

async function renderNokosServices(ctx) {
    try {
        const countryId = Number(global.nokosConfig?.defaultCountry || 6)
        const list = await nokosService.services(countryId)
        const services = list.filter(x => x?.code).slice(0, 80)

        setUi(ctx.from.id, {
            screen: 'nokos_services',
            nokosServices: services,
            nokosDefaultCountry: countryId
        })

        let text =
            `📱 <b>NOKOS RUANGOTP</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Pilih layanan OTP yang ingin digunakan.\n` +
            `🌍 Negara awal: <b>${countryId}</b>\n\n`

        text += services.length
            ? `📦 <b>PILIH SERVICE</b>\n` +
                `Total layanan tersedia: <b>${services.length}</b>.\n` +
                `Pilih layanan melalui tombol di bawah; kartu menampilkan beberapa layanan pertama.`
            : '❌ Provider tidak mengembalikan service untuk negara tersebut.'

        const rows = []
        for (let i = 0; i < services.length; i += 2) {
            const row = []
            const a = services[i]
            const aCode = String(a.code).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
            if (aCode) row.push(Markup.button.callback(`📱 ${String(a.name || a.code).slice(0, 16)}`, `tg_nokos_service:${aCode}`))

            const b = services[i + 1]
            if (b) {
                const bCode = String(b.code).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)
                if (bCode) row.push(Markup.button.callback(`📱 ${String(b.name || b.code).slice(0, 16)}`, `tg_nokos_service:${bCode}`))
            }

            if (row.length) rows.push(row)
        }

        rows.push([Markup.button.callback('🔄 REFRESH SERVICE', 'tg_nokos_services')])
        rows.push([Markup.button.callback('🏠 MENU UTAMA', 'tg_home')])

        return renderTelegramMenuCard(ctx, 'nokos_services', { services, total: services.length, countryId }, text, Markup.inlineKeyboard(rows))
    } catch (error) {
        return editTracked(ctx, `❌ Gagal mengambil service NOKOS: ${escapeHtml(error?.message || error)}`, backHomeKeyboard())
    }
}

async function renderNokos(ctx, { page = 0, service = 'wa' } = {}) {
    try {
        const catalog = await loadNokosCatalog(service)
        const p = pageInfo(catalog.length, page)
        const shown = catalog.slice(p.start, p.end)

        setUi(ctx.from.id, {
            screen: 'nokos_country',
            nokosPage: p.page,
            nokosService: service,
            nokosCatalog: catalog,
            nokosSelectedPrice: null,
            nokosSelectedServers: null,
            nokosSelectedCountry: null
        })

        let text =
            `📱 <b>NOKOS ${escapeHtml(String(service).toUpperCase())}</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `💡 Pilih negara untuk melihat server yang tersedia.\n\n` +
            `🌍 <b>NEGARA</b> <i>(${catalog.length ? p.start + 1 : 0}-${p.end}/${catalog.length})</i>\n`

        if (!shown.length) text += '\n❌ Tidak ada negara yang dikembalikan provider.'
        else {
            text += shown.map(country => {
                const name = country.providerName ? country.name : `Country ID ${country.id}`
                const flag = country.flag || nokosService.countryFlag?.(country.name, country.prefix, country.raw) || '🏳️'
                return `${flag} <b>${escapeHtml(name)}</b>${country.prefix ? ` ${escapeHtml(country.prefix)}` : ''}`
            }).join('\n')
        }

        const rows = []
        for (let i = 0; i < shown.length; i += 2) {
            const row = []
            const a = shown[i]
            const ai = p.start + i
            const aLabel = a.providerName ? a.name : `ID ${a.id}`
            row.push(Markup.button.callback(
                `${a.flag || nokosService.countryFlag?.(a.name, a.prefix, a.raw) || '🏳️'} ${String(aLabel).slice(0, 15)} ›`,
                `tg_nokos_country:${ai}`
            ))

            const b = shown[i + 1]
            if (b) {
                const bi = p.start + i + 1
                const bLabel = b.providerName ? b.name : `ID ${b.id}`
                row.push(Markup.button.callback(
                    `${b.flag || nokosService.countryFlag?.(b.name, b.prefix, b.raw) || '🏳️'} ${String(bLabel).slice(0, 15)} ›`,
                    `tg_nokos_country:${bi}`
                ))
            }

            rows.push(row)
        }

        rows.push([
            Markup.button.callback('‹ PREV', `tg_nokos_page:${Math.max(0, p.page - 1)}`),
            Markup.button.callback(`📄 ${p.page + 1}/${p.pages}`, 'tg_nokos_refresh'),
            Markup.button.callback('NEXT ›', `tg_nokos_page:${Math.min(p.pages - 1, p.page + 1)}`)
        ])
        rows.push([Markup.button.callback('📦 GANTI SERVICE', 'tg_nokos_services')])
        rows.push([Markup.button.callback('🔄 REFRESH NEGARA', 'tg_nokos_refresh')])
        rows.push([Markup.button.callback('🏠 MENU UTAMA', 'tg_home')])

        return renderTelegramMenuCard(ctx, 'nokos_country', { service, countries: shown, total: catalog.length, page: p.page, pages: p.pages }, text, Markup.inlineKeyboard(rows))
    } catch (error) {
        return editTracked(ctx, `❌ Gagal mengambil daftar negara NOKOS: ${escapeHtml(error?.message || error)}`, backHomeKeyboard())
    }
}

async function renderNokosCountry(ctx, index) {
    try {
        const ui = getUi(ctx.from.id) || {}
        const service = String(ui.nokosService || 'wa').toLowerCase()
        const catalog = ui.nokosCatalog || await loadNokosCatalog(service)
        const country = catalog[Number(index)]

        if (!country) {
            return renderNokos(ctx, { service, page: 0 })
        }

        const servers = typeof nokosService.getPrices === 'function'
            ? await nokosService.getPrices(service, Number(country.id))
            : [await nokosService.getPrice(service, Number(country.id))]

        const availableServers = servers.filter(server =>
            server &&
            Number(server.cost || 0) > 0 &&
            (server.stock == null || Number(server.stock) > 0)
        )

        if (!availableServers.length) {
            throw new Error('Tidak ada server aktif atau stok tersedia untuk negara tersebut.')
        }

        const sellingPrices = availableServers
            .map(server => nokosSelling(server.cost))
            .filter(Number.isFinite)
        const lowest = sellingPrices.length ? Math.min(...sellingPrices) : 0
        const countryName = country.providerName ? country.name : `Country ID ${country.id}`
        const countryFlag = country.flag || nokosService.countryFlag?.(country.name, country.prefix, country.raw) || '🏳️'

        setUi(ctx.from.id, {
            screen: 'nokos_servers',
            nokosService: service,
            nokosSelectedCountry: {
                index: Number(index),
                country
            },
            nokosSelectedServers: availableServers,
            nokosSelectedPrice: null
        })

        let text =
            `🖥️ <b>PILIH SERVER NOKOS</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `${countryFlag} <b>${escapeHtml(countryName)}</b> ${escapeHtml(country.prefix || '')}\n` +
            `📱 Service: <b>${escapeHtml(service.toUpperCase())}</b>\n` +
            `📡 Server tersedia: <b>${availableServers.length}</b>\n` +
            `💰 Harga mulai: <b>Rp${escapeHtml(nokosService.money(lowest))}</b>\n\n`

        text += availableServers.slice(0, 8).map((server, i) => {
            const label = String(server.provider || `Server ${i + 1}`).slice(0, 48)
            const stock = server.stock == null ? 'N/A' : String(server.stock)
            return `${i + 1}. <b>${escapeHtml(label)}</b>\n   💰 Rp${escapeHtml(nokosService.money(nokosSelling(server.cost)))} · 📦 Stok: <b>${escapeHtml(stock)}</b>`
        }).join('\n')
        if (availableServers.length > 8) text += `\n\n… dan ${availableServers.length - 8} server lainnya tersedia melalui tombol.`

        const rows = []
        for (let i = 0; i < availableServers.length; i += 2) {
            const row = [
                Markup.button.callback(`🖥️ Server ${i + 1}`, `tg_nokos_server:${i}`)
            ]
            if (availableServers[i + 1]) {
                row.push(Markup.button.callback(`🖥️ Server ${i + 2}`, `tg_nokos_server:${i + 1}`))
            }
            rows.push(row)
        }

        rows.push([
            Markup.button.callback('🌍 GANTI NEGARA', `tg_nokos_page:${Math.floor(Number(index) / UI_PAGE_SIZE)}`),
            Markup.button.callback('📦 GANTI SERVICE', 'tg_nokos_services')
        ])
        rows.push([Markup.button.callback('🏠 MENU UTAMA', 'tg_home')])

        return renderTelegramMenuCard(ctx, 'nokos_servers', { service, countryName, servers: availableServers.map(server => ({ ...server, sellingPrice: nokosSelling(server.cost) })), lowest }, text, Markup.inlineKeyboard(rows))
    } catch (error) {
        return editTracked(ctx, `❌ Gagal mengambil server NOKOS: ${escapeHtml(error?.message || error)}`, backHomeKeyboard())
    }
}

async function renderNokosServers(ctx, index) {
    return renderNokosCountry(ctx, index)
}

async function renderNokosServer(ctx, index) {
    try {
        const ui = getUi(ctx.from.id) || {}
        const server = Array.isArray(ui.nokosSelectedServers)
            ? ui.nokosSelectedServers[Number(index)]
            : null
        const selectedCountry = ui.nokosSelectedCountry?.country

        if (!server || !selectedCountry) return renderNokosServers(ctx, ui.nokosSelectedCountry?.index || 0)

        const service = String(ui.nokosService || 'wa').toLowerCase()
        const selling = nokosSelling(server.cost)
        const stock = server.stock == null ? 'Tidak diberikan provider' : String(server.stock)
        const flag = selectedCountry.flag || nokosService.countryFlag?.(selectedCountry.name, selectedCountry.prefix, selectedCountry.raw) || '🏳️'
        const countryName = selectedCountry.providerName ? selectedCountry.name : `Country ID ${selectedCountry.id}`

        setUi(ctx.from.id, {
            screen: 'nokos_server',
            nokosSelectedPrice: server,
            nokosSelectedServerIndex: Number(index)
        })

        const text =
            `🖥️ <b>SERVER TERPILIH</b>\n\n` +
            `${flag} <b>${escapeHtml(countryName)}</b>\n` +
            `📱 Service: <b>${escapeHtml(service.toUpperCase())}</b>\n` +
            `🏷️ Server: <b>${escapeHtml(server.provider || `Server ${Number(index) + 1}`)}</b>\n` +
            `🔖 Provider ID: <b>${escapeHtml(server.providerId || '-')}</b>\n` +
            `📦 Stok: <b>${escapeHtml(stock)}</b>\n` +
            `💵 Harga provider: <b>Rp${escapeHtml(nokosService.money(server.cost))}</b>\n` +
            `💰 Harga jual: <b>Rp${escapeHtml(nokosService.money(selling))}</b>\n\n` +
            `Server ini akan digunakan saat pembelian.`
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🛒 BELI SEKARANG', `tg_nokos_buy_server:${Number(index)}`)],
            [Markup.button.callback('‹ PILIH SERVER LAIN', `tg_nokos_servers:${ui.nokosSelectedCountry.index}`)],
            [Markup.button.callback('🏠 MENU UTAMA', 'tg_home')]
        ])
        return renderTelegramMenuCard(ctx, 'nokos_server', {
            service, countryName, provider: server.provider || `Server ${Number(index) + 1}`,
            providerId: server.providerId || '-', sellingPrice: selling, stock: server.stock
        }, text, keyboard)
    } catch (error) {
        return editTracked(ctx, `❌ Gagal membuka server: ${escapeHtml(error?.message || error)}`, backHomeKeyboard())
    }
}

function purchaseMethodKeyboard(intent) {
    return Markup.inlineKeyboard([
        [Markup.button.callback('💰 SALDO DEPOSIT BOT', `tg_purchase_balance:${intent.type}:${intent.token}`)],
        [Markup.button.callback('📲 QRIS PEMBELIAN LANGSUNG', `tg_purchase_qris:${intent.type}:${intent.token}`)],
        [Markup.button.callback('🏠 MENU UTAMA', 'tg_home')]
    ])
}

async function showPurchaseMethodChoice(ctx, intent, { message = '' } = {}) {
    const isNokos = intent.type === 'NOKOS'
    let intentStatus = String(intent.status || '').toUpperCase()
    // Recover invoice linkage safely after a restart. If no local invoice exists,
    // block new payment methods until the gateway has been checked manually.
    if (intentStatus === 'QRIS_CREATING' && Date.now() - Number(intent.updatedAt || intent.createdAt || 0) > 60000) {
        const invoice = depositService.findByOrderRef?.(intent.token)
        if (invoice) {
            const invoiceStatus = String(invoice.status || '').toUpperCase()
            const nextStatus = ['PAID', 'SUCCESS', 'SETTLED'].includes(invoiceStatus) ? 'QRIS_PAID' : ['EXPIRED', 'FAILED', 'CANCELED', 'CANCELLED'].includes(invoiceStatus) ? 'EXPIRED' : 'WAITING_PAYMENT'
            intent = purchasePayment.saveIntent({ ...intent, status: nextStatus, paymentMethod: 'QRIS', paymentRef: invoice.merchantRef, paymentCreatedAt: invoice.createdAt, paymentExpiredAt: invoice.expiredAt })
            intentStatus = nextStatus
        } else {
            intent = purchasePayment.saveIntent({ ...intent, status: 'QRIS_REVIEW_REQUIRED', reviewReason: 'Proses membuat invoice terputus dan invoice tidak ditemukan di database lokal; cek dashboard provider terkait sebelum mencoba ulang.', reviewAt: Date.now() })
            intentStatus = 'QRIS_REVIEW_REQUIRED'
        }
    }
    if (intentStatus === 'WAITING_PAYMENT' && intent.paymentRef) return handlePurchaseQrTelegram(ctx, intent.type, intent.token)
    if (intentStatus === 'EXPIRED') return renderTelegramMenuCard(ctx, 'purchase_review', { token: intent.token, type: intent.type, status: 'INVOICE EXPIRED' }, `⚠️ Invoice QRIS untuk token <code>${escapeHtml(intent.token)}</code> berstatus berakhir. Pesanan tidak dibuat ulang otomatis. Pastikan invoice lama benar-benar final sebelum memulai pesanan baru.`, backHomeKeyboard())
    if (['QRIS_CREATING', 'QRIS_REVIEW_REQUIRED', 'QRIS_PAID', 'PROVIDER_PROCESSING', 'BALANCE_PROCESSING', 'REVIEW_REQUIRED'].includes(intentStatus)) {
        const text = intentStatus === 'QRIS_REVIEW_REQUIRED'
            ? `⚠️ <b>INVOICE QRIS BUTUH PEMERIKSAAN</b>\n\nStatus pembuatan invoice belum dapat dipastikan. Jangan membayar invoice lain dan jangan mencoba order ulang. Token: <code>${escapeHtml(intent.token)}</code>. Owner harus memeriksa status transaksi pada provider terkait terlebih dahulu.`
            : intentStatus === 'REVIEW_REQUIRED' || intentStatus === 'PROVIDER_PROCESSING'
                ? `⚠️ Pesanan <code>${escapeHtml(intent.token)}</code> sedang memerlukan rekonsiliasi status provider. Jangan membeli ulang sebelum owner memeriksa transaksi.`
                : intentStatus === 'QRIS_PAID'
                    ? `✅ Pembayaran QRIS untuk token <code>${escapeHtml(intent.token)}</code> sudah terdeteksi dan order sedang diproses. Jangan membayar ulang.`
                    : `⏳ Pesanan <code>${escapeHtml(intent.token)}</code> sedang diproses. Tunggu status akhir dan jangan membuat order baru.`
        if (intentStatus === 'QRIS_REVIEW_REQUIRED' && !intent.reviewNoticeSentAt) {
            const marked = purchasePayment.saveIntent({ ...intent, reviewNoticeSentAt: Date.now() })
            await notifyOwnerPurchase({ type: 'QRIS INVOICE REVIEW REQUIRED', ref: intent.token, customerName: marked.pushname || '-', customerJid: marked.jid, sellingPrice: marked.amount, status: 'REVIEW_REQUIRED', refunded: false, createdAt: marked.createdAt, note: marked.reviewReason || 'Periksa dashboard provider terkait; jangan membuat invoice ulang.' }).catch(err => console.error('[QRIS REVIEW OWNER NOTICE]', err?.message || err))
        }
        return renderTelegramMenuCard(ctx, 'purchase_review', { token: intent.token, label: intent.label, price: intent.amount, status: intentStatus, type: intent.type }, text, backHomeKeyboard())
    }
    const text =
        `${isNokos ? '📱 <b>PEMBELIAN NOKOS</b>' : '🎮 <b>PEMBELIAN TOP UP</b>'}\n\n` +
        `Produk: <b>${escapeHtml(intent.label)}</b>\n` +
        `Total: <b>Rp${escapeHtml(economy.formatMoney(intent.amount))}</b>\n\n` +
        `Pilih metode pembayaran:\n` +
        `• <b>Saldo Deposit Bot</b>: saldo wallet dipotong satu kali setelah konfirmasi.\n` +
        `• <b>QRIS Provider</b>: sementara belum aktif karena API provider yang tersedia belum menyediakan invoice pembelian langsung dengan verifikasi pembayaran. Tombolnya tidak membuat tagihan atau menarik pembayaran.\n\n` +
        `Token: <code>${escapeHtml(intent.token)}</code>` +
        (message ? `\n\n${escapeHtml(message)}` : '')
    return renderTelegramMenuCard(ctx, isNokos ? 'nokos_payment' : 'topup_payment', {
        token: intent.token, label: intent.label, price: intent.amount, status: 'PILIH PEMBAYARAN', type: intent.type
    }, text, purchaseMethodKeyboard(intent))
}

function ownerNoticeData(result, intent) {
    const item = result?.order || result?.tx
    if (!item) return null
    if (intent.type === 'NOKOS') return {
        type: 'NOKOS', ref: item.ref, customerName: intent.pushname || '-', customerJid: intent.jid,
        service: item.service, country: item.country, provider: item.provider, providerId: item.providerId,
        phone: item.phone, activationId: item.activationId || item.providerTransactionId,
        sellingPrice: item.sellingPrice, providerPrice: item.providerCost,
        profit: Number(item.sellingPrice || 0) - Number(item.providerCost || 0), status: item.status,
        refunded: Boolean(item.refunded), createdAt: item.createdAt
    }
    return {
        type: 'TOPUP', ref: item.ref, customerName: intent.pushname || '-', customerJid: intent.jid,
        game: item.game, productName: item.productName,
        destination: `${item.customerNo || ''}${item.zone ? ` | Zone ${item.zone}` : ''}`,
        sellingPrice: item.sellingPrice, providerPrice: item.providerPrice,
        profit: Number(item.sellingPrice || 0) - Number(item.providerPrice || 0), status: item.status,
        sn: item.sn, refunded: Boolean(item.refunded), createdAt: item.createdAt
    }
}

async function handlePurchaseBalanceTelegram(ctx, type, token) {
    const jid = getTransactionJid(ctx)
    if (!jid) return editTracked(ctx, '❌ Telegram ID tidak valid.', backHomeKeyboard())
    try {
        const result = await purchasePayment.buyWithBalance(token, jid, type)
        const intent = result.intent || purchasePayment.getIntent(token)
        if (result.reviewRequired) {
            const text = `⚠️ <b>TRANSAKSI BUTUH PEMERIKSAAN OWNER</b>\n\nPembayaran sudah tercatat, tetapi respons provider belum dapat dipastikan. Jangan tekan beli ulang.\nToken: <code>${escapeHtml(token)}</code>\nRef: <code>${escapeHtml(result.order?.ref || result.tx?.ref || token)}</code>`
            const notice = ownerNoticeData(result, intent) || { type: `${type} REVIEW`, ref: token, customerName: intent?.pushname || '-', customerJid: jid, sellingPrice: intent?.amount, status: 'REVIEW_REQUIRED', refunded: false }
            await notifyOwnerPurchase({ ...notice, status: 'REVIEW_REQUIRED' }).catch(() => {})
            return renderTelegramMenuCard(ctx, 'purchase_review', { ref: token, type, status: 'REVIEW REQUIRED' }, text, backHomeKeyboard())
        }
        if (result.failed && result.refunded) {
            const text = `❌ <b>PROVIDER MENOLAK PESANAN</b>\n\nRefund Rp${escapeHtml(economy.formatMoney(intent?.amount || 0))} sudah dikreditkan kembali ke saldo bot.\nAlasan: ${escapeHtml(result.error?.message || 'Provider menolak transaksi.')}`
            await notifyOwnerPurchase({ type: `${type} FAILED REFUNDED`, ref: result.order?.ref || result.tx?.ref || token, customerName: intent?.pushname || '-', customerJid: jid, sellingPrice: intent?.amount, status: 'FAILED_REFUNDED', refunded: true, createdAt: intent?.createdAt }).catch(() => {})
            return renderTelegramMenuCard(ctx, 'purchase_result', { ref: token, type, status: 'FAILED REFUNDED' }, text, Markup.inlineKeyboard([[Markup.button.callback('🛒 Beli Lagi', type === 'NOKOS' ? 'tg_home_nokos' : 'tg_home_topup')], [Markup.button.callback('🏠 Menu', 'tg_home')]]))
        }
        const item = result.order || result.tx
        if (!result.success || !item) return editTracked(ctx, '⚠️ Status pesanan belum dapat dipastikan. Jangan membuat pesanan ulang; owner perlu memeriksa transaksi.', backHomeKeyboard())
        if (!result.already) {
            const notice = ownerNoticeData(result, intent)
            if (notice) await notifyOwnerPurchase(notice).catch(err => console.error('[TELEGRAM PURCHASE OWNER]', err?.message || err))
        }
        if (type === 'NOKOS') {
            purchasePayment.startNokosWatcher(item)
            const text = `📱 <b>ORDER NOKOS BERHASIL</b>\n\nRef: <code>${escapeHtml(item.ref)}</code>\nService: <b>${escapeHtml(item.service)}</b>\nNegara: <b>${escapeHtml(item.country)}</b>\nProvider: <b>${escapeHtml(item.provider || '-')}</b>\nNomor: <code>${escapeHtml(item.phone || '-')}</code>\nHarga: <b>Rp${escapeHtml(nokosService.money(item.sellingPrice))}</b>\nStatus: <b>${escapeHtml(String(item.status || 'waiting').toUpperCase())}</b>\n\nBot akan mengecek OTP otomatis.`
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Cek OTP', `tg_nokos_status:${item.ref}`), Markup.button.callback('📨 Resend OTP', `tg_nokos_resend:${item.ref}`)],
                [Markup.button.callback('❌ Batalkan', `tg_nokos_cancel:${item.ref}`)],
                [Markup.button.callback('📱 NOKOS Lagi', 'tg_home_nokos'), Markup.button.callback('🏠 Menu', 'tg_home')]
            ])
            return renderTelegramMenuCard(ctx, 'nokos_order', { ref: item.ref, service: item.service, country: item.country, provider: item.provider, phone: item.phone, price: item.sellingPrice, status: item.status }, text, keyboard)
        }
        const text = `🎮 <b>ORDER TOP UP</b>\n\nRef: <code>${escapeHtml(item.ref)}</code>\nGame: <b>${escapeHtml(item.game)}</b>\nProduk: <b>${escapeHtml(item.productName)}</b>\nTujuan: <code>${escapeHtml(item.customerNo || '-')}${item.zone ? ` | Zone ${escapeHtml(item.zone)}` : ''}</code>\nHarga: <b>Rp${escapeHtml(topupService.formatMoney(item.sellingPrice))}</b>\nStatus: <b>${escapeHtml(item.status)}</b>\nSN: <code>${escapeHtml(item.sn || '-')}</code>\n\n${escapeHtml(item.message || 'Transaksi diproses.')}`
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔄 Cek Status', `tg_topup_status:${item.ref}`)], [Markup.button.callback('🎮 Top Up Lagi', 'tg_home_topup'), Markup.button.callback('🏠 Menu', 'tg_home')]])
        return renderTelegramMenuCard(ctx, 'topup_result', { ref: item.ref, game: item.game, productName: item.productName, destination: item.customerNo, price: item.sellingPrice, status: item.status, sn: item.sn }, text, keyboard)
    } catch (error) {
        const intent = purchasePayment.getIntent(token)
        if (intent && intent.status === 'AWAITING_METHOD') {
            return showPurchaseMethodChoice(ctx, intent, { message: error?.message || 'Metode saldo tidak dapat dipakai.' })
        }
        return editTracked(ctx, `❌ Tidak dapat menyelesaikan pembayaran saldo: ${escapeHtml(error?.message || error)}\n\nJangan tekan beli berulang kali bila transaksi sudah berstatus diproses.`, backHomeKeyboard())
    }
}

async function handlePurchaseQrTelegram(ctx, type, token) {
    const jid = getTransactionJid(ctx)
    if (!jid) return editTracked(ctx, '❌ Telegram ID tidak valid.', backHomeKeyboard())
    try {
        const created = await purchasePayment.createQrPayment(token, jid, ctx.from?.first_name || ctx.from?.username || 'Telegram User')
        const state = String(created.intent?.status || '').toUpperCase()
        if (state === 'FULFILLED') {
            return editTracked(ctx, `✅ <b>Pesanan ${escapeHtml(type)} berhasil diproses.</b>
Ref order: <code>${escapeHtml(created.intent.orderRef || token)}</code>
Tidak perlu membayar atau membuat invoice baru.`, backHomeKeyboard(), { parse_mode: 'HTML' })
        }
        if (state === 'FAILED_REFUNDED') {
            return editTracked(ctx, `❌ Pesanan ${escapeHtml(type)} gagal diproses. Nilai Rp${escapeHtml(Number(created.intent.amount || 0).toLocaleString('id-ID'))} sudah diamankan kembali ke saldo bot. Tidak ada order baru yang dibuat.
Token: <code>${escapeHtml(token)}</code>`, backHomeKeyboard(), { parse_mode: 'HTML' })
        }
        if (['REVIEW_REQUIRED', 'QRIS_REVIEW_REQUIRED', 'PROVIDER_PROCESSING', 'BALANCE_PROCESSING', 'QRIS_PAID'].includes(state)) {
            if (['REVIEW_REQUIRED', 'QRIS_REVIEW_REQUIRED'].includes(state) && !created.intent.reviewNoticeSentAt) {
                const marked = purchasePayment.saveIntent({ ...created.intent, reviewNoticeSentAt: Date.now() })
                await notifyOwnerPurchase({ type: `${type} REVIEW REQUIRED`, ref: marked.orderRef || token, customerName: marked.pushname || '-', customerJid: marked.jid, sellingPrice: marked.amount, status: state, refunded: false, createdAt: marked.createdAt, note: marked.reviewReason || 'Pembayaran terdeteksi tetapi status fulfillment perlu rekonsiliasi.' }).catch(err => console.error('[TELEGRAM QRIS REVIEW OWNER]', err?.message || err))
            }
            return editTracked(ctx, `⚠️ <b>Pesanan ${escapeHtml(type)} sedang dalam status ${escapeHtml(state)}.</b>
QRIS baru tidak ditampilkan agar tidak terjadi pembayaran ganda. Jangan membayar ulang. Token: <code>${escapeHtml(token)}</code>. Owner akan merekonsiliasi transaksi terlebih dahulu.`, backHomeKeyboard(), { parse_mode: 'HTML' })
        }
        const payment = created.payment
        if (!payment) throw new Error('Gateway tidak mengembalikan data invoice. Jangan membuat pesanan ulang.')
        const paid = ['PAID', 'SUCCESS', 'SETTLED'].includes(String(payment.status || '').toUpperCase())
        const amount = Number(payment.totalPay || payment.paymentAmount || payment.amount || 0)
        const expiry = payment.expiredAt ? new Date(Number(payment.expiredAt)).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-'
        const caption =
            `📲 <b>QRIS PEMBELIAN LANGSUNG</b>\n\n` +
            `Produk: <b>${escapeHtml(created.intent.label)}</b>\n` +
            `Invoice: <code>${escapeHtml(payment.merchantRef)}</code>\n` +
            `Total bayar: <b>Rp${escapeHtml(depositService.formatMoney(amount))}</b>\n` +
            `Status: <b>${escapeHtml(payment.status || 'PENDING')}</b>\n` +
            `Kedaluwarsa: <b>${escapeHtml(expiry)}</b>\n\n` +
            (paid ? '✅ Gateway sudah mendeteksi pembayaran. Proses order otomatis sedang berjalan.' : 'Scan QRIS untuk membayar pesanan ini. Ini invoice khusus produk, bukan deposit saldo bot. Jangan membayar dua kali.') +
            (payment.checkoutUrl ? `\n\n<a href="${escapeHtml(payment.checkoutUrl)}">Buka halaman pembayaran</a>` : '')
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Cek Status Pembayaran', `tg_purchase_qris_status:${payment.merchantRef}`)],
            [Markup.button.callback('🏠 Menu Utama', 'tg_home')]
        ])
        const image = await safeQrBuffer('PURCHASE', () => depositService.qrBuffer(payment))
        if (image) return editTrackedPhoto(ctx, image, caption, keyboard, { preferEdit: true })
        return editTracked(ctx, caption + (payment.checkoutUrl ? '' : '\n\nGateway tidak menyediakan gambar QR atau link pembayaran. Hubungi owner; jangan membuat order ulang.'), keyboard, { parse_mode: 'HTML', disable_web_page_preview: false })
    } catch (error) {
        const intent = purchasePayment.getIntent(token)
        if (error?.providerPaymentUnavailable && intent) {
            const text = `⚠️ <b>QRIS PEMBELIAN PROVIDER BELUM TERSEDIA</b>\n\nTidak ada invoice dibuat dan tidak ada pembayaran diproses.\n\n${escapeHtml(error.message)}\n\nPilih saldo deposit bot untuk melanjutkan pesanan.`
            const keyboard = Markup.inlineKeyboard([
                [Markup.button.callback('💰 BAYAR DENGAN SALDO BOT', `tg_purchase_balance:${intent.type}:${intent.token}`)],
                [Markup.button.callback('🏠 MENU UTAMA', 'tg_home')]
            ])
            return renderTelegramMenuCard(ctx, 'purchase_qris_unavailable', { token, type, label: intent.label, price: intent.amount, status: 'QRIS PROVIDER BELUM TERSEDIA' }, text, keyboard)
        }
        if (error?.legacyPurchaseInvoiceEnded) return editTracked(ctx, `ℹ️ ${escapeHtml(error.message)}\nTidak ada invoice baru dibuat dan saldo bot tidak dipotong. Buat pesanan baru setelah invoice lama dipastikan berakhir.`, backHomeKeyboard())
        if (intent && intent.status === 'AWAITING_METHOD') return showPurchaseMethodChoice(ctx, intent, { message: `QRIS belum dapat dibuat: ${error?.message || error}. Silakan pilih metode lain.` })
        if (intent?.status === 'QRIS_REVIEW_REQUIRED') {
            if (!intent.reviewNoticeSentAt) {
                const marked = purchasePayment.saveIntent({ ...intent, reviewNoticeSentAt: Date.now() })
                await notifyOwnerPurchase({ type: 'QRIS INVOICE REVIEW REQUIRED', ref: token, customerName: marked.pushname || '-', customerJid: marked.jid, sellingPrice: marked.amount, status: 'REVIEW_REQUIRED', refunded: false, createdAt: marked.createdAt, note: marked.reviewReason || String(error?.message || error) }).catch(err => console.error('[QRIS REVIEW OWNER NOTICE]', err?.message || err))
            }
            return renderTelegramMenuCard(ctx, 'purchase_review', { token, type, status: 'QRIS REVIEW REQUIRED' }, `⚠️ <b>INVOICE QRIS BUTUH PEMERIKSAAN</b>\n\n${escapeHtml(intent.reviewReason || 'Status transaksi belum dapat dipastikan.')}\nToken: <code>${escapeHtml(token)}</code>. Tidak ada invoice baru dibuat dan saldo bot tidak dipotong. Jangan membayar QR lama atau mengganti metode sampai owner mengonfirmasi statusnya.`, backHomeKeyboard())
        }
        return editTracked(ctx, `❌ QRIS pembelian gagal dibuat: ${escapeHtml(error?.message || error)}\nJangan membuat order ulang jika status sudah diproses.`, backHomeKeyboard())
    }
}

async function handlePurchaseQrStatus(ctx, ref) {
    const jid = getTransactionJid(ctx)
    if (!jid) return editTracked(ctx, '❌ Telegram ID tidak valid.', backHomeKeyboard())
    try {
        const old = depositService.get(ref)
        if (!old || old.jid !== jid || !['NOKOS_ORDER', 'TOPUP_ORDER'].includes(String(old.kind || '').toUpperCase())) {
            return editTracked(ctx, '❌ Invoice pembelian tidak ditemukan atau bukan milik akun kamu.', backHomeKeyboard())
        }
        const tx = await depositService.check(ref)
        const text = `📲 <b>STATUS QRIS PEMBELIAN</b>\n\nInvoice: <code>${escapeHtml(tx.merchantRef)}</code>\nProduk: <b>${escapeHtml(tx.items?.[0]?.name || '-')}</b>\nTotal: <b>Rp${escapeHtml(depositService.formatMoney(tx.totalPay || tx.amount))}</b>\nStatus: <b>${escapeHtml(tx.status)}</b>\nProses order: <b>${tx.handlerProcessedAt ? 'TERPROSES' : tx.fulfillmentPaused ? 'BUTUH PEMERIKSAAN OWNER' : ['PAID', 'SUCCESS', 'SETTLED'].includes(String(tx.status).toUpperCase()) ? 'DIPROSES OTOMATIS' : 'MENUNGGU PEMBAYARAN'}</b>\n\nPembayaran ini langsung untuk pesanan, bukan deposit saldo bot.`
        return renderTelegramMenuCard(ctx, 'purchase_qris_status', { ref: tx.merchantRef, price: tx.totalPay || tx.amount, status: tx.status, product: tx.items?.[0]?.name || '-' }, text, Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Status', `tg_purchase_qris_status:${tx.merchantRef}`)], [Markup.button.callback('🏠 Menu', 'tg_home')]]))
    } catch (error) {
        return editTracked(ctx, `❌ Gagal cek invoice: ${escapeHtml(error?.message || error)}`, backHomeKeyboard())
    }
}

async function watchTelegramNokosOrder(order, chatId) {
    try {
        const result = await nokosService.waitForOtp(
            order.providerTransactionId || order.orderId || order.activationId,
            Number(global.nokosConfig?.otpTimeoutMs || 1200000),
            Number(global.nokosConfig?.pollIntervalMs || 5000)
        )
        nokosService.updateOrder(order.ref, {
            status: 'received',
            otp: result.code || null,
            sms: result.sms || null,
            receivedAt: Date.now()
        })
        if (bot?.telegram && chatId) {
            await bot.telegram.sendMessage(
                chatId,
                `📨 <b>OTP NOKOS MASUK</b>\n\nRef: <b>${escapeHtml(order.ref)}</b>\nNomor: <b>${escapeHtml(order.phone)}</b>\nOTP: <code>${escapeHtml(result.code || '-')}</code>${result.sms ? `\nSMS: ${escapeHtml(result.sms)}` : ''}`,
                { parse_mode: 'HTML' }
            )
        }
        void notifyOwnerPurchase({
            type: 'NOKOS OTP',
            ref: order.ref,
            customerName: order.pushname || order.telegramId || '-',
            customerJid: order.jid,
            service: order.service,
            country: order.country,
            provider: order.provider,
            providerId: order.providerId,
            phone: order.phone,
            activationId: order.activationId,
            sellingPrice: order.sellingPrice,
            providerPrice: order.providerCost,
            profit: Number(order.sellingPrice || 0) - Number(order.providerCost || 0),
            status: 'OTP RECEIVED',
            otp: result.code || '-',
            refunded: Boolean(order.refunded),
            createdAt: order.createdAt
        }).catch(err => console.error('[TELEGRAM NOKOS OTP OWNER NOTIFY]', err?.stack || err))
    } catch (err) {
        const latest = nokosService.getOrder(order.ref)
        if (!latest || latest.refunded || latest.otp || latest.receivedAt || !['waiting', 'wait_code', 'pending', 'processing', 'cancel_requested'].includes(String(latest.status || '').toLowerCase())) return
        const providerStatus = String(err?.status || '').toLowerCase()
        if (['expired', 'cancelled', 'failed'].includes(providerStatus)) {
            nokosService.updateOrder(order.ref, { status: providerStatus, providerStatus })
            const refund = nokosService.refundOnce(order.ref, providerStatus)
            if (refund && bot?.telegram && chatId) {
                await bot.telegram.sendMessage(chatId, `⏰ Order <b>${escapeHtml(order.ref)}</b> berakhir menurut provider (${escapeHtml(providerStatus)}). Refund saldo bot diproses satu kali.`, { parse_mode: 'HTML' }).catch(() => {})
            }
            if (refund) void notifyOwnerPurchase({ type: 'NOKOS REFUND', ref: order.ref, customerName: order.pushname || order.telegramId || '-', customerJid: order.jid, service: order.service, country: order.country, provider: order.provider, providerId: order.providerId, phone: order.phone, sellingPrice: order.sellingPrice, providerPrice: order.providerCost, status: 'REFUNDED', refunded: true, createdAt: order.createdAt }).catch(() => {})
            return
        }
        if (providerStatus === 'timeout') {
            let result = null
            try { result = await nokosService.cancelOrderAndRefund(order.ref, 'otp_timeout') } catch (cancelError) { console.error('[TELEGRAM NOKOS CANCEL VERIFY]', cancelError?.message || cancelError) }
            if (result?.confirmed) {
                if (bot?.telegram && chatId) await bot.telegram.sendMessage(chatId, `⏰ Order <b>${escapeHtml(order.ref)}</b> berakhir dan status provider terkonfirmasi. Refund saldo bot diproses satu kali.`, { parse_mode: 'HTML' }).catch(() => {})
                void notifyOwnerPurchase({ type: 'NOKOS REFUND', ref: order.ref, customerName: order.pushname || order.telegramId || '-', customerJid: order.jid, sellingPrice: order.sellingPrice, status: 'REFUNDED', refunded: true, createdAt: order.createdAt }).catch(() => {})
            } else {
                const message = result?.message || 'Status provider tidak bisa diverifikasi.'
                nokosService.updateOrder(order.ref, { status: 'cancel_requested', cancelRequestedAt: Date.now(), cancelVerificationError: message })
                if (bot?.telegram && chatId) await bot.telegram.sendMessage(chatId, `⚠️ Waktu tunggu OTP untuk <b>${escapeHtml(order.ref)}</b> habis, tetapi pembatalan belum dikonfirmasi. Dana <b>belum direfund</b>. Jangan membeli ulang; owner perlu memeriksa provider.`, { parse_mode: 'HTML' }).catch(() => {})
                void notifyOwnerPurchase({ type: 'NOKOS CANCEL REVIEW REQUIRED', ref: order.ref, customerName: order.pushname || order.telegramId || '-', customerJid: order.jid, sellingPrice: order.sellingPrice, status: 'CANCEL_REVIEW_REQUIRED', refunded: false, createdAt: order.createdAt, note: message }).catch(() => {})
            }
            return
        }
        console.error('[TELEGRAM NOKOS WATCHER DEFERRED]', order.ref, err?.message || err)
    }
}

async function handleNokosOrder(ctx, args, { edit = false, countryOverride = null, priceOverride = null } = {}) {
    const jid = getTransactionJid(ctx)
    if (!jid) return
    const service = String(args?.[0] || 'wa').toLowerCase()
    const country = Number(countryOverride ?? args?.[1])
    const operator = String(args?.[2] || 'any').toLowerCase()
    const providerId = String(args?.[3] || global.nokosConfig?.defaultProviderId || '').trim()
    if (!Number.isFinite(country) || country <= 0) {
        const message = 'Format: <code>/nokosorder wa 6 any [provider_id]</code>'
        return edit ? editTracked(ctx, message, backHomeKeyboard()) : commandOutput(ctx, message, { parse_mode: 'HTML' })
    }
    if (!nokosService.ready()) return edit ? editTracked(ctx, '❌ RuangOTP belum siap. Periksa RUANGOTP_USER_ID dan whitelist IP VPS.', backHomeKeyboard()) : commandOutput(ctx, '❌ RuangOTP belum siap. Periksa kredensial dan whitelist IP VPS.')
    try {
        const price = priceOverride || await nokosService.getPrice(service, country, providerId || null, operator)
        const stockKnown = price?.stock != null
        if (!price || !(Number(price.cost) > 0) || (stockKnown && Number(price.stock) <= 0)) {
            const text = '❌ Harga/provider tidak tersedia atau stok sedang kosong. Belum ada pesanan dibuat.'
            return edit ? editTracked(ctx, text, backHomeKeyboard()) : commandOutput(ctx, text)
        }
        if (!price.providerId) throw new Error('Provider tidak memberikan provider ID yang valid; order dihentikan untuk mencegah salah transaksi.')
        const selling = nokosSelling(price.cost)
        const intent = purchasePayment.createIntent({
            type: 'NOKOS', jid, source: 'telegram', telegramId: String(ctx.from.id),
            pushname: ctx.from?.first_name || ctx.from?.username || 'Telegram User', amount: selling,
            label: `NOKOS ${service.toUpperCase()} • negara ${country}`,
            details: { service, country, operator, provider: price.provider || null, providerId: String(price.providerId), providerCost: Number(price.cost), sellingPrice: selling }
        })
        return showPurchaseMethodChoice(ctx, intent)
    } catch (error) {
        const text = `❌ Gagal menyiapkan order NOKOS: ${error?.message || error}. Belum ada order provider yang dibuat.`
        return edit ? editTracked(ctx, escapeHtml(text), backHomeKeyboard()) : commandOutput(ctx, text)
    }
}

async function handleNokosStatus(ctx, ref, { edit = false } = {}) {
    const jid = getTransactionJid(ctx)
    if (!jid) return
    const order = nokosService.getOrder(ref)
    if (!order) return edit ? editTracked(ctx, '❌ Ref NOKOS tidak ditemukan.', backHomeKeyboard()) : commandOutput(ctx, '❌ Ref NOKOS tidak ditemukan.')
    if (order.jid !== jid) return edit ? editTracked(ctx, '❌ Ref tersebut bukan milik akun kamu.', backHomeKeyboard()) : commandOutput(ctx, '❌ Ref tersebut bukan milik akun kamu.')
    try {
        const providerId = order.providerTransactionId || order.orderId || order.activationId
        const s = await nokosService.status(providerId)
        const providerStatus = String(s.status || 'unknown').toLowerCase()
        const hasOtp = Boolean(order.otp || order.receivedAt || s.code)
        const effectiveStatus = hasOtp ? 'received' : (order.cancelRequestedAt && providerStatus === 'waiting' ? 'cancel_requested' : providerStatus)
        const patch = { status: effectiveStatus, otp: s.code || order.otp || null, sms: s.sms || order.sms || null }
        if (hasOtp && s.code && !order.refunded) patch.completedAt = Date.now()
        if (!hasOtp && ['cancelled', 'expired', 'failed'].includes(providerStatus) && order.charged) {
            const refund = nokosService.refundOnce(order.ref, providerStatus)
            patch.refunded = Boolean(refund?.order?.refunded || order.refunded)
        }
        const updated = nokosService.updateOrder(order.ref, patch) || { ...order, ...patch }
        const text =
            `📱 <b>STATUS NOKOS</b>\n\n` +
            `Ref: <b>${escapeHtml(updated.ref)}</b>\n` +
            `Nomor: <b>${escapeHtml(updated.phone)}</b>\n` +
            `Status: <b>${escapeHtml(s.status)}</b>\n` +
            `OTP: <b>${escapeHtml(s.code || '-')}</b>\n` +
            `Refund: <b>${updated.refunded ? 'YA' : 'TIDAK'}</b>`
        if (!edit) return commandOutput(ctx, text, { parse_mode: 'HTML' })
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh OTP', `tg_nokos_status:${order.ref}`), Markup.button.callback('📨 Resend OTP', `tg_nokos_resend:${order.ref}`)],
            [Markup.button.callback('❌ Batalkan', `tg_nokos_cancel:${order.ref}`)],
            [Markup.button.callback('📱 NOKOS Lagi', 'tg_home_nokos')],
            [Markup.button.callback('🏠 Menu Utama', 'tg_home')]
        ])
        return renderTelegramMenuCard(ctx, 'nokos_status', {
            ref: updated.ref, phone: updated.phone, status: s.status, otp: s.code || updated.otp,
            refunded: Boolean(updated.refunded), provider: updated.provider
        }, text, keyboard)
    } catch (e) {
        return edit ? editTracked(ctx, `❌ Gagal cek status: ${escapeHtml(e?.message || e)}`, backHomeKeyboard()) : commandOutput(ctx, `❌ Gagal cek status: ${e?.message || e}`)
    }
}

async function handleNokosResend(ctx, ref, { edit = false } = {}) {
    const jid = getTransactionJid(ctx)
    if (!jid) return
    const order = nokosService.getOrder(ref)
    if (!order) return edit ? editTracked(ctx, '❌ Ref NOKOS tidak ditemukan.', backHomeKeyboard()) : commandOutput(ctx, '❌ Ref NOKOS tidak ditemukan.')
    if (order.jid !== jid) return edit ? editTracked(ctx, '❌ Ref tersebut bukan milik akun kamu.', backHomeKeyboard()) : commandOutput(ctx, '❌ Ref tersebut bukan milik akun kamu.')
    const providerId = order.providerTransactionId || order.orderId || order.activationId
    if (!providerId) return edit ? editTracked(ctx, '❌ Order tidak memiliki ID transaksi provider.', backHomeKeyboard()) : commandOutput(ctx, '❌ Order tidak memiliki ID transaksi provider.')
    if (!['waiting', 'wait_code', 'pending', 'processing'].includes(String(order.status || '').toLowerCase())) return edit ? editTracked(ctx, `❌ Resend hanya tersedia saat menunggu OTP. Status: ${escapeHtml(order.status)}`, backHomeKeyboard()) : commandOutput(ctx, `❌ Resend hanya tersedia saat menunggu OTP. Status: ${order.status}`)
    try {
        await nokosService.resend(providerId)
        const count = Number(order.resendCount || 0) + 1
        nokosService.updateOrder(order.ref, { lastResendAt: Date.now(), resendCount: count, status: 'waiting' })
        const text = `✅ <b>Resend OTP berhasil dikirim.</b>\n\nRef: <b>${escapeHtml(order.ref)}</b>\nNomor: <b>${escapeHtml(order.phone)}</b>\nResend: <b>${count}x</b>\nStatus: <b>MENUNGGU OTP</b>`
        if (!edit) return commandOutput(ctx, text, { parse_mode: 'HTML' })
        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Cek OTP', `tg_nokos_status:${order.ref}`), Markup.button.callback('📨 Resend OTP', `tg_nokos_resend:${order.ref}`)],
            [Markup.button.callback('❌ Batalkan', `tg_nokos_cancel:${order.ref}`)],
            [Markup.button.callback('📱 NOKOS Lagi', 'tg_home_nokos')],
            [Markup.button.callback('🏠 Menu Utama', 'tg_home')]
        ])
        return renderTelegramMenuCard(ctx, 'nokos_status', {
            ref: order.ref, phone: order.phone, status: 'MENUNGGU OTP', otp: order.otp,
            refunded: Boolean(order.refunded), provider: order.provider
        }, text, keyboard)
    } catch (e) {
        return edit ? editTracked(ctx, `❌ Gagal resend OTP: ${escapeHtml(e?.message || e)}`, backHomeKeyboard()) : commandOutput(ctx, `❌ Gagal resend OTP: ${e?.message || e}`)
    }
}

async function handleNokosCancel(ctx, ref, { edit = false } = {}) {
    const jid = getTransactionJid(ctx)
    if (!jid) return
    const order = nokosService.getOrder(ref)
    if (!order) return edit ? editTracked(ctx, '❌ Ref NOKOS tidak ditemukan.', backHomeKeyboard()) : commandOutput(ctx, '❌ Ref NOKOS tidak ditemukan.')
    if (order.jid !== jid) return edit ? editTracked(ctx, '❌ Ref tersebut bukan milik akun kamu.', backHomeKeyboard()) : commandOutput(ctx, '❌ Ref tersebut bukan milik akun kamu.')
    if (!['waiting', 'wait_code', 'pending', 'processing', 'cancel_requested'].includes(String(order.status || '').toLowerCase())) {
        return edit ? editTracked(ctx, `❌ Order berstatus ${escapeHtml(String(order.status).toUpperCase())} dan tidak dapat dibatalkan.`, backHomeKeyboard()) : commandOutput(ctx, `❌ Order berstatus ${String(order.status).toUpperCase()} dan tidak dapat dibatalkan.`)
    }
    try {
        const result = await nokosService.cancelOrderAndRefund(order.ref, 'manual_cancel')
        if (!result.confirmed) {
            const message = `⚠️ <b>PEMBATALAN BELUM TERKONFIRMASI</b>\n\nRef: <code>${escapeHtml(order.ref)}</code>\n${escapeHtml(result.message || 'Provider belum mengonfirmasi pembatalan.') }\nDana belum direfund. Jangan membuat order ulang; cek status lagi atau hubungi owner.`
            return edit ? editTracked(ctx, message, backHomeKeyboard()) : commandOutput(ctx, message, { parse_mode: 'HTML' })
        }
        const updated = result.order || nokosService.getOrder(order.ref) || order
        const refundAmount = result.refund ? nokosService.money(updated.sellingPrice || order.sellingPrice) : '0'
        const text = `✅ <b>STATUS PROVIDER TERKONFIRMASI</b>\n\nRef: <code>${escapeHtml(order.ref)}</code>\nStatus: <b>${escapeHtml(String(result.status || updated.status).toUpperCase())}</b>\nRefund saldo bot: <b>Rp${escapeHtml(refundAmount)}</b>\n${result.refund ? 'Refund diproses satu kali.' : 'Tidak ada pemotongan saldo tercatat pada order ini.'}`
        if (!edit) return commandOutput(ctx, text, { parse_mode: 'HTML' })
        const keyboard = Markup.inlineKeyboard([[Markup.button.callback('📱 NOKOS Lagi', 'tg_home_nokos')], [Markup.button.callback('🏠 Menu', 'tg_home')]])
        return renderTelegramMenuCard(ctx, 'nokos_status', { ref: updated.ref, phone: updated.phone, status: updated.status, refunded: Boolean(updated.refunded), provider: updated.provider }, text, keyboard)
    } catch (error) {
        const message = `⚠️ Pembatalan belum selesai: ${escapeHtml(error?.message || error)}\nJangan membeli ulang. Refund hanya dilakukan setelah status provider terverifikasi.`
        return edit ? editTracked(ctx, message, backHomeKeyboard()) : commandOutput(ctx, message, { parse_mode: 'HTML' })
    }
}

function normalizeGameCode(value) {
    const text = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (text.includes('freefire') || text.includes('garena')) return 'ff'
    if (text.includes('mobilelegend')) return 'ml'
    if (text.includes('roblox')) return 'roblox'
    return text || 'other'
}

function productNominal(name) {
    const nums = String(name || '').match(/\d+(?:[.,]\d+)?/g) || []
    return nums.find(raw => Number(raw.replace(',', '.')) > 0) || '-'
}

function topupGameName(code, products = []) {
    const known = ({ ff: 'FREE FIRE', ml: 'MOBILE LEGENDS', roblox: 'ROBLOX' })[code]
    if (known) return known
    const source = products.find(x => x?.game)?.game || code
    return String(source || code)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
        .toUpperCase()
}

function topupGameSlugLabel(code) {
    if (code === 'ff') return '🔥 FREE FIRE'
    if (code === 'ml') return '💎 MOBILE LEGENDS'
    if (code === 'roblox') return '🧱 ROBLOX'
    return `🎮 ${String(code).toUpperCase().slice(0, 24)}`
}

async function loadTopupCatalog() {
    if (!topupService.ready()) throw new Error('API VIPayment belum diatur di settings.js.')

    // prices() adalah async function. Pastikan Promise sudah di-resolve
    // sebelum memakai Array.prototype.filter(). Ini memperbaiki error:
    // "topupService.prices(...).filter is not a function".
    const result = await topupService.prices('')
    if (!Array.isArray(result)) {
        throw new Error('VIPayment mengembalikan daftar produk yang tidak valid.')
    }

    return result.filter(p =>
        String(p?.status || '').toLowerCase() === 'available' || !p?.status
    )
}

async function loadTopupProducts(game) {
    const list = await loadTopupCatalog()
    return list
        .filter(p => normalizeGameCode(p.game || p.name || p.code) === game)
        .sort((a, b) => {
            const na = Number(String(productNominal(a.name)).replace(',', '.'))
            const nb = Number(String(productNominal(b.name)).replace(',', '.'))
            return (Number.isFinite(na) ? na : 999999999) - (Number.isFinite(nb) ? nb : 999999999)
        })
}

async function getTopupGameGroups() {
    const list = await loadTopupCatalog()
    const groups = new Map()
    for (const p of list) {
        const code = normalizeGameCode(p.game || p.name || p.code)
        if (!code || code === 'other') continue
        if (!groups.has(code)) groups.set(code, { game: code, label: topupGameName(code, [p]), count: 0 })
        groups.get(code).count += 1
    }
    return [...groups.values()].sort((a, b) => String(a.label).localeCompare(String(b.label), 'id'))
}

async function renderTopupGames(ctx) {
    try {
        const groups = await getTopupGameGroups()
        let text =
            `╭━━〔 🎮 <b>TOP UP GAME</b> 〕━━╮\n` +
            `┃ Pilih game untuk membuka nominal tersedia.\n` +
            `┃ ⚡ Harga mengikuti price list provider + markup.\n` +
            `╰━━━━━━━━━━━━━━━━━━━━╯`
        if (!groups.length) text += `\n\n❌ API tersambung, tetapi belum ada layanan game dengan status <b>available</b>.`

        const rows = []
        for (let i = 0; i < groups.length; i += 2) {
            const row = [Markup.button.callback(`${topupGameSlugLabel(groups[i].game)} • ${groups[i].count}`, `tg_topup_game:${groups[i].game}`)]
            if (groups[i + 1]) row.push(Markup.button.callback(`${topupGameSlugLabel(groups[i + 1].game)} • ${groups[i + 1].count}`, `tg_topup_game:${groups[i + 1].game}`))
            rows.push(row)
        }
        rows.push([Markup.button.callback('🔄  REFRESH PRODUK', 'tg_topup_refresh')])
        rows.push([Markup.button.callback('╰─ 🏠 MENU UTAMA', 'tg_home')])
        setUi(ctx.from.id, { screen: 'topup_games', topupGame: null, topupProducts: null, topupPage: 0, topupGames: groups })
        return renderTelegramMenuCard(ctx, 'topup_games', { games: groups, total: groups.length }, text, Markup.inlineKeyboard(rows))
    } catch (e) {
        return editTracked(ctx, `❌ Gagal mengambil daftar top up: ${escapeHtml(e?.message || e)}`, backHomeKeyboard())
    }
}

async function renderTopupProducts(ctx, game, page = 0) {
    try {
        const products = await loadTopupProducts(game)
        const p = pageInfo(products.length, page)
        const shown = products.slice(p.start, p.end)
        setUi(ctx.from.id, { screen: 'topup_products', topupGame: game, topupProducts: products, topupPage: p.page })

        let text =
            `🎮 <b>${escapeHtml(topupGameName(game, products))}</b>\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Pilih nominal yang ingin dibeli.\n\n`
        text += shown.length
            ? shown.map((product, i) => `${p.start + i + 1}. <b>${escapeHtml(product.name)}</b> — Rp${escapeHtml(topupService.formatMoney(product.sellingPrice))}`).join('\n')
            : '❌ Tidak ada produk available untuk game ini.'

        const rows = []
        for (let i = 0; i < shown.length; i += 2) {
            const row = []
            const a = shown[i]
            row.push(Markup.button.callback(`💎 ${productNominal(a.name)} • Rp${topupService.formatMoney(a.sellingPrice)}`, `tg_topup_product:${game}:${p.start + i}`))
            const b = shown[i + 1]
            if (b) row.push(Markup.button.callback(`💎 ${productNominal(b.name)} • Rp${topupService.formatMoney(b.sellingPrice)}`, `tg_topup_product:${game}:${p.start + i + 1}`))
            rows.push(row)
        }
        rows.push([
            Markup.button.callback('‹ PREV', `tg_topup_page:${game}:${Math.max(0, p.page - 1)}`),
            Markup.button.callback(`📄 ${p.page + 1}/${p.pages}`, 'tg_topup_refresh'),
            Markup.button.callback('NEXT ›', `tg_topup_page:${game}:${Math.min(p.pages - 1, p.page + 1)}`)
        ])
        rows.push([Markup.button.callback('🎮  GANTI GAME', 'tg_home_topup'), Markup.button.callback('🏠  MENU', 'tg_home')])

        return renderTelegramMenuCard(ctx, 'topup_products', { game, gameName: topupGameName(game, products), products: shown, page: p.page, pages: p.pages }, text, Markup.inlineKeyboard(rows))
    } catch (e) {
        return editTracked(ctx, `❌ Gagal mengambil produk ${escapeHtml(game)}: ${escapeHtml(e?.message || e)}`, backHomeKeyboard())
    }
}

async function selectTopupProduct(ctx, game, index) {
    let session = getUi(ctx.from.id)
    let products = session?.topupProducts || []
    if (!products.length || session?.topupGame !== game) {
        try { products = await loadTopupProducts(game) } catch (e) {
            return editTracked(ctx, `❌ Gagal mengambil produk ${escapeHtml(game)}: ${escapeHtml(e?.message || e)}`, backHomeKeyboard())
        }
    }
    const product = products[Number(index)]
    if (!product) return renderTopupProducts(ctx, game, Math.floor(Number(index) / UI_PAGE_SIZE))

    const jid = getTransactionJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const balance = economy.getBalance(jid)
    const price = Number(product.sellingPrice || 0)

    const hint = game === 'ml'
        ? 'Kirim dengan format: <code>ID ZONE</code>\nContoh: <code>12345678 1234</code>'
        : game === 'roblox'
            ? 'Kirim <b>username Roblox</b> yang akan menerima top up.'
            : 'Kirim <b>ID game</b> tujuan top up.'

    setUi(ctx.from.id, {
        pendingTopup: { game, productIndex: Number(index), product, jid },
        screen: 'topup_input'
    })

    const text =
        `🛒 <b>KONFIRMASI TOP UP</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🎮 Game: <b>${escapeHtml(topupGameName(game, products))}</b>\n` +
        `📦 Produk: <b>${escapeHtml(product.name)}</b>\n` +
        `💰 Harga: <b>Rp${escapeHtml(topupService.formatMoney(price))}</b>\n` +
        `💳 Saldo Biasa: <b>Rp${escapeHtml(topupService.formatMoney(balance))}</b>\n\n` +
        `${hint}\n\n` +
        `Kirim ID sebagai <b>pesan berikutnya</b>.`
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('❌ Batal', `tg_topup_page:${game}:${Math.floor(Number(index) / UI_PAGE_SIZE)}`)],
        [Markup.button.callback('🏠 Menu Utama', 'tg_home')]
    ])
    return renderTelegramMenuCard(ctx, 'topup_confirm', {
        game, gameName: topupGameName(game, products), productName: product.name, price, balance
    }, text, keyboard)
}

async function processPendingTopup(ctx, rawText) {
    const session = getUi(ctx.from.id)
    const pending = session?.pendingTopup
    if (!pending) return false

    const input = String(rawText || '').trim()
    if (!input || input.startsWith('/')) return false

    const jid = getTransactionJid(ctx)
    if (!jid || jid !== pending.jid) {
        clearPending(ctx.from.id)
        return false
    }

    let customerNo = input
    let zone = ''
    if (pending.game === 'ml') {
        const parts = input.split(/\s+/)
        if (parts.length < 2) {
            await editTracked(ctx, '❌ Format Mobile Legends salah. Kirim: <code>ID ZONE</code>', Markup.inlineKeyboard([[Markup.button.callback('❌ Batal', `tg_topup_page:ml:${Math.floor(Number(pending.productIndex) / UI_PAGE_SIZE)}`)]]))
            return true
        }
        customerNo = parts[0]
        zone = parts[1]
    }

    const price = Math.floor(Number(pending.product?.sellingPrice || 0))
    if (!Number.isSafeInteger(price) || price <= 0 || !pending.product?.code) {
        clearPending(ctx.from.id)
        await editTracked(ctx, '❌ Harga/kode produk tidak valid. Pesanan belum dibuat.', backHomeKeyboard())
        return true
    }
    const intent = purchasePayment.createIntent({
        type: 'TOPUP', jid, source: 'telegram', telegramId: String(ctx.from.id),
        pushname: ctx.from?.first_name || ctx.from?.username || 'Telegram User', amount: price,
        label: `${topupGameName(pending.game, [pending.product])} • ${pending.product.name} • ${customerNo}${zone ? ` (${zone})` : ''}`,
        details: {
            game: pending.game, customerNo, zone,
            nominal: productNominal(pending.product.name),
            serviceCode: String(pending.product.code), productName: String(pending.product.name)
        }
    })
    clearPending(ctx.from.id)
    await showPurchaseMethodChoice(ctx, intent)
    return true
}

async function handleTopupStatus(ctx, ref) {
    const jid = getTransactionJid(ctx)
    if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
    const old = topupService.getTransaction(ref)
    if (!old) return editTracked(ctx, '❌ Transaksi top up tidak ditemukan.', backHomeKeyboard())
    if (old.jid !== jid) return editTracked(ctx, '❌ Transaksi tersebut bukan milik akun kamu.', backHomeKeyboard())

    try {
        const tx = await topupService.status(ref)
        if (['gagal', 'error'].includes(String(tx.status).toLowerCase()) && tx.charged && !tx.refunded) {
            const refunded = await purchasePayment.refundFailedTopup(tx)
            if (refunded?.transaction) Object.assign(tx, refunded.transaction)
        }

        const statusText =
            `🎮 <b>STATUS TOP UP</b>\n\n` +
            `🧾 Ref: <b>${escapeHtml(tx.ref)}</b>\n` +
            `📦 Produk: <b>${escapeHtml(tx.productName)}</b>\n` +
            `🔄 Status: <b>${escapeHtml(tx.status)}</b>\n` +
            `💰 Harga: <b>Rp${escapeHtml(topupService.formatMoney(tx.sellingPrice))}</b>\n` +
            `🔐 SN: <b>${escapeHtml(tx.sn || '-')}</b>\n` +
            `↩️ Refund: <b>${tx.refunded ? 'YA' : 'TIDAK'}</b>`
        const statusKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh Status', `tg_topup_status:${tx.ref}`)],
            [Markup.button.callback('🎮 Top Up Lagi', 'tg_home_topup'), Markup.button.callback('🏠 Menu', 'tg_home')]
        ])
        return renderTelegramMenuCard(ctx, 'topup_status', {
            ref: tx.ref, game: tx.game, gameName: topupGameName(tx.game, [tx]),
            productName: tx.productName, destination: tx.customerNo || tx.destination || '-',
            price: tx.sellingPrice, status: tx.status, sn: tx.sn, refunded: Boolean(tx.refunded)
        }, statusText, statusKeyboard)
    } catch (e) {
        return editTracked(ctx, `❌ Gagal cek status: ${escapeHtml(e?.message || e)}`, backHomeKeyboard())
    }
}

function depositActionKeyboard(ref, { showCancel = true, showStatus = true } = {}) {
    const rows = []
    if (showStatus) rows.push([Markup.button.callback('🔄 Cek Status', `tg_deposit_status:${ref}`)])
    if (showCancel) rows.push([Markup.button.callback('❌ Batalkan Deposit', `tg_deposit_cancel:${ref}`)])
    rows.push([Markup.button.callback('🏠 Menu Utama', 'tg_home')])
    return Markup.inlineKeyboard(rows)
}

async function showDepositMenu(ctx) {
    return showDepositProviderMenu(ctx)
}
function setWaConn(connection) {
    waConn = connection
}

function receiptEscapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;')
}

function ownerWaJid() {
    const owner = String(global.owner || '').replace(/\D/g, '')
    return owner ? `${owner}@s.whatsapp.net` : ''
}

function receiptMoney(n) {
    return Number(n || 0).toLocaleString('id-ID')
}

function ownerTelegramTargets() {
    const targets = new Set()
    const configuredChannel = String(global.telegramConfig?.ownerNotifyChannel || '').trim()
    if (configuredChannel && configuredChannel !== '-') targets.add(configuredChannel)

    // Jika akun owner pernah di-link dengan /link, kirim juga langsung ke chat Telegram owner.
    try {
        const db = ensureDb()
        const owner = ownerWaJid()
        for (const [telegramId, item] of Object.entries(db.users || {})) {
            if (normalizeWaJid(item?.jid) === owner) targets.add(String(telegramId))
        }
    } catch (e) {
        console.error('[TELEGRAM OWNER TARGETS]', e?.message || e)
    }

    return [...targets]
}

function telegramAdminIds() {
    const ids = Array.isArray(global.telegramConfig?.adminIds)
        ? global.telegramConfig.adminIds.map(x => String(x).trim()).filter(Boolean)
        : []
    const owner = String(global.owner || '').replace(/\D/g, '')
    if (owner) {
        try {
            const db = ensureDb()
            for (const [telegramId, item] of Object.entries(db.users || {})) {
                if (normalizeWaJid(item?.jid) === `${owner}@s.whatsapp.net`) ids.push(String(telegramId))
            }
        } catch {}
    }
    return [...new Set(ids)]
}

function isTelegramAdmin(ctx) {
    return telegramAdminIds().includes(String(ctx?.from?.id || ''))
}

function telegramMaintenanceEnabled() {
    return global.telegramConfig?.maintenance === true
}

function setTelegramMaintenance(enabled) {
    if (!global.telegramConfig || typeof global.telegramConfig !== 'object') global.telegramConfig = {}
    global.telegramConfig.maintenance = Boolean(enabled)
    try {
        const settingsPath = path.join(__dirname, 'settings.js')
        const source = fs.readFileSync(settingsPath, 'utf8')
        if (/global\.telegramConfig\.maintenance\s*=\s*(true|false)/.test(source)) {
            fs.writeFileSync(settingsPath, source.replace(/global\.telegramConfig\.maintenance\s*=\s*(true|false)/, `global.telegramConfig.maintenance = ${enabled ? 'true' : 'false'}`))
        } else if (/global\.telegramConfig\s*=\s*\{/.test(source)) {
            fs.writeFileSync(settingsPath, source.replace(/(global\.telegramConfig\s*=\s*\{)/, `$1\n    maintenance: ${enabled ? 'true' : 'false'},`))
        }
    } catch (e) {
        console.error('[TELEGRAM MAINTENANCE SAVE]', e?.message || e)
    }
}

function telegramBroadcastTargets() {
    const targets = new Set()
    try {
        const db = ensureDb()
        for (const id of Object.keys(db.users || {})) {
            if (/^-?\d+$/.test(String(id))) targets.add(String(id))
        }
    } catch (e) {
        console.error('[TELEGRAM BROADCAST TARGETS]', e?.message || e)
    }
    for (const id of telegramAdminIds()) targets.add(String(id))
    return [...targets]
}

async function telegramBroadcast(ctx, text) {
    if (!isTelegramAdmin(ctx)) return commandOutput(ctx, '⛔ <b>AKSES DITOLAK</b>\n\nCommand ini hanya untuk owner/admin Telegram.')
    const message = String(text || '').trim()
    if (!message) return commandOutput(ctx, 'Contoh: <code>/broadcast Halo semua, ada informasi baru.</code>')
    if (!bot) return commandOutput(ctx, '❌ Bot Telegram belum aktif.')

    const targets = telegramBroadcastTargets()
    if (!targets.length) return commandOutput(ctx, 'ℹ️ Belum ada pengguna Telegram yang tersimpan.')
    await commandOutput(ctx, `📢 <b>Broadcast dimulai</b>\n\nTarget: <b>${targets.length}</b> chat\nPesan: ${escapeHtml(message)}`)

    let success = 0, failed = 0
    for (const target of targets) {
        try {
            await bot.telegram.sendMessage(target, `📢 <b>INFORMASI XERYUU</b>\n\n${escapeHtml(message)}`, { parse_mode: 'HTML', disable_web_page_preview: true })
            success++
        } catch (e) {
            failed++
            console.error(`[TELEGRAM BROADCAST ${target}]`, e?.message || e)
        }
        await new Promise(resolve => setTimeout(resolve, 80))
    }
    return commandOutput(ctx, `✅ <b>Broadcast selesai</b>\n\n📨 Berhasil: <b>${success}</b>\n❌ Gagal: <b>${failed}</b>\n👥 Total target: <b>${targets.length}</b>`)
}

function buildPurchaseReceipt(data = {}, format = 'telegram') {
    const type = String(data.type || '').toUpperCase()
    const isTopup = type === 'TOPUP'
    const isNokos = type === 'NOKOS'
    const title = isTopup ? '🎮 STRUK PEMBELIAN TOP UP' : isNokos ? '📱 STRUK PEMBELIAN NOKOS' : '🧾 STRUK PEMBELIAN'
    const status = String(data.status || 'Unknown')
    const customer = String(data.customerName || '-').trim() || '-'
    const customerJid = String(data.customerJid || '-').trim() || '-'
    const ref = String(data.ref || '-')
    const sellingPrice = Number(data.sellingPrice || 0)
    const providerPrice = Number(data.providerPrice || 0)
    const profit = Number.isFinite(Number(data.profit)) ? Number(data.profit) : sellingPrice - providerPrice
    const when = data.createdAt ? new Date(Number(data.createdAt)) : new Date()
    const date = when.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })

    if (format === 'telegram') {
        let out =
            `<blockquote><b>${receiptEscapeHtml(title)}</b>\n\n` +
            `🧾 <b>Order:</b> <code>${receiptEscapeHtml(ref)}</code>\n` +
            `👤 <b>Customer:</b> ${receiptEscapeHtml(customer)}\n` +
            `📱 <b>WA/JID:</b> <code>${receiptEscapeHtml(customerJid)}</code>\n` +
            `🕒 <b>Waktu:</b> <code>${receiptEscapeHtml(date)}</code>\n`

        if (isTopup) {
            out +=
                `\n🎮 <b>Game:</b> ${receiptEscapeHtml(data.game || '-')}\n` +
                `📦 <b>Produk:</b> ${receiptEscapeHtml(data.productName || '-')}\n` +
                `🎯 <b>Tujuan:</b> <code>${receiptEscapeHtml(data.destination || '-')}</code>\n` +
                `💰 <b>Harga:</b> Rp${receiptEscapeHtml(receiptMoney(sellingPrice))}\n` +
                `💵 <b>Modal:</b> Rp${receiptEscapeHtml(receiptMoney(providerPrice))}\n` +
                `📈 <b>Margin:</b> Rp${receiptEscapeHtml(receiptMoney(profit))}\n`
        } else if (isNokos) {
            out +=
                `\n📦 <b>Service:</b> ${receiptEscapeHtml(data.service || '-')}\n` +
                `🌍 <b>Country:</b> ${receiptEscapeHtml(data.countryName || `Country ID ${data.country ?? '-'}`)}\n` +
                `🏷️ <b>Provider:</b> ${receiptEscapeHtml(data.provider || '-')}\n` +
                `🔖 <b>Provider ID:</b> ${receiptEscapeHtml(data.providerId || '-')}\n` +
                `☎️ <b>Nomor:</b> <code>${receiptEscapeHtml(data.phone || '-')}</code>\n` +
                `💰 <b>Harga:</b> Rp${receiptEscapeHtml(receiptMoney(sellingPrice))}\n` +
                `💵 <b>Modal:</b> Rp${receiptEscapeHtml(receiptMoney(providerPrice))}\n` +
                `📈 <b>Margin:</b> Rp${receiptEscapeHtml(receiptMoney(profit))}\n`
        }

        out +=
            `\n🔄 <b>Status:</b> ${receiptEscapeHtml(status)}\n` +
            `🧩 <b>${isTopup ? 'SN' : 'Provider ID'}:</b> <code>${receiptEscapeHtml(isTopup ? (data.sn || '-') : (data.activationId || '-'))}</code>\n` +
            `↩️ <b>Refund:</b> ${data.refunded ? 'YA' : 'TIDAK'}\n\n` +
            `🤖 <b>${receiptEscapeHtml(global.botname || 'Xeryuu-Md V16 × Sendrich')}</b></blockquote>`
        return out
    }

    let out =
        `╭─〔 ${title} 〕\n` +
        `│ 🧾 Ref       : *${ref}*\n` +
        `│ 👤 Customer  : *${customer}*\n` +
        `│ 📱 WA/JID    : *${customerJid}*\n` +
        `│ 🕒 Waktu     : *${date}*\n`

    if (isTopup) {
        out +=
            `│ 🎮 Game      : *${data.game || '-'}*\n` +
            `│ 📦 Produk    : *${data.productName || '-'}*\n` +
            `│ 🎯 Tujuan    : *${data.destination || '-'}*\n` +
            `│ 💰 Harga     : *Rp${receiptMoney(sellingPrice)}*\n` +
            `│ 💵 Modal     : Rp${receiptMoney(providerPrice)}\n` +
            `│ 📈 Margin    : Rp${receiptMoney(profit)}\n`
    } else if (isNokos) {
        out +=
            `│ 📦 Service   : *${data.service || '-'}*\n` +
            `│ 🌍 Country   : *${data.countryName || `Country ID ${data.country ?? '-'}`}*\n` +
            `│ 🏷️ Provider  : *${data.provider || '-'}*\n` +
            `│ 🔖 Provider ID: *${data.providerId || '-'}*\n` +
            `│ ☎️ Nomor     : *${data.phone || '-'}*\n` +
            `│ 💰 Harga     : *Rp${receiptMoney(sellingPrice)}*\n` +
            `│ 💵 Modal     : Rp${receiptMoney(providerPrice)}\n` +
            `│ 📈 Margin    : Rp${receiptMoney(profit)}\n`
    }

    return out +
        `│ 🔄 Status    : *${status}*\n` +
        `│ ${isTopup ? '🔐 SN        ' : '🧩 Provider  '} : *${isTopup ? (data.sn || '-') : (data.activationId || '-')}*\n` +
        `│ ↩️ Refund    : *${data.refunded ? 'YA' : 'TIDAK'}*\n` +
        `╰────────────────\n` +
        `🤖 *${global.botname || 'Xeryuu-Md V16 × Sendrich'}*`
}

async function notifyOwnerPurchase(data = {}) {
    const waJid = ownerWaJid()
    const telegramTargets = ownerTelegramTargets()
    const whatsappText = buildPurchaseReceipt(data, 'whatsapp')
    const telegramText = buildPurchaseReceipt(data, 'telegram')
    const result = { whatsapp: false, telegram: [], errors: [] }

    if (waConn && waJid && waJid !== '@s.whatsapp.net') {
        try {
            await waConn.sendMessage(waJid, { text: whatsappText })
            result.whatsapp = true
        } catch (e) {
            result.errors.push(`WhatsApp: ${e?.message || e}`)
            console.error('[PURCHASE NOTIFY WA OWNER]', e?.stack || e)
        }
    } else {
        result.errors.push('WhatsApp: koneksi bot belum tersedia atau nomor owner kosong.')
    }

    if (bot) {
        for (const target of telegramTargets) {
            try {
                await bot.telegram.sendMessage(target, telegramText, { parse_mode: 'HTML', disable_web_page_preview: true })
                result.telegram.push(target)
            } catch (e) {
                result.errors.push(`Telegram ${target}: ${e?.message || e}`)
                console.error(`[PURCHASE NOTIFY TELEGRAM ${target}]`, e?.stack || e)
            }
        }
    } else if (telegramTargets.length) {
        result.errors.push('Telegram: bot Telegram belum aktif.')
    }

    return result
}

async function handleTelegramScrapr(ctx, commandName) {
    const rawText = String(ctx.message?.text || '').trim()
    const rawArg = rawText.replace(/^\/[^\s]+\s*/i, '').trim()
    const url = rawArg.match(/https?:\/\/[^\s<>]+/i)?.[0] || rawArg.split(/\s+/)[0] || ''
    if (!url) return commandOutput(ctx, `Contoh: /${commandName} https://tautan-media.example/...`)

    const platform = resolveScraprPlatform(commandName, url)
    if (!platform) {
        return commandOutput(ctx, '❌ Domain belum dikenal oleh Scrapr. Gunakan URL platform yang didukung atau /unshorten <url> untuk shortlink publik.')
    }
    if (platform === 'spotify') return commandOutput(ctx, 'ℹ️ Spotify tetap memakai downloader Xeryuu yang sudah ada. Integrasi Scrapr tidak menggantikan alur Spotify.')
    if (platform === 'mediafire') return commandOutput(ctx, 'ℹ️ MediaFire tetap memakai downloader Xeryuu yang sudah ada. Integrasi Scrapr tidak menggantikan alur MediaFire.')

    await ctx.reply('⏳ Sedang mengambil media, mohon tunggu...')
    try {
        const result = await extractScrapr(url, platform)
        await sendScraprToTelegram(ctx, result)
    } catch (error) {
        console.error(`[TELEGRAM SCRAPR ${String(commandName).toUpperCase()}]`, error?.stack || error)
        const detail = String(error?.message || error).slice(0, 650).replace(/[<&>]/g, '')
        await commandOutput(ctx, `❌ Gagal memproses tautan ${platform}.\n\n${detail}\n\nPastikan tautan publik dan coba lagi beberapa saat.`)
    }
}

function start(connection) {
    waConn = connection
    const token = String(global.telegramConfig?.botToken || '').trim()
    if (!token || token === '-' || token === 'ISI_TOKEN_BOT_TELEGRAM_DI_SINI') {
        console.log('[TELEGRAM] Disabled: isi global.telegramConfig.botToken di settings.js')
        return null
    }
    if (bot) return bot

    bot = new Telegraf(token)
    developerGithubUpdater.attachTelegramBot(bot)
    convertPulsaService.setNotifier(async (transaction, previousStatus) => {
        const message = `🔄 UPDATE CONVERT PULSA\n\nReferensi: ${transaction.ref}\nOperator: ${transaction.operatorName || '-'}\nNominal pulsa: Rp${convertPulsaService.formatMoney(transaction.amount)}\nStatus sebelumnya: ${convertPulsaStatusLabel(previousStatus)}\nStatus terbaru: ${convertPulsaStatusLabel(transaction.status)}\n\nCek detail melalui ${transaction.channel === 'telegram' ? '/cpstatus ' : '.' + 'cpstatus '}${transaction.ref}.`
        if (transaction.channel === 'telegram' && bot) {
            const target = String(transaction.userId || '').replace(/^telegram:/, '')
            if (target) await bot.telegram.sendMessage(target, message, { disable_web_page_preview: true })
        } else if (transaction.channel === 'whatsapp' && waConn && transaction.userId) {
            await waConn.sendMessage(transaction.userId, { text: message })
        }
    })
    convertPulsaService.startPoller()

    // Keep a handler failure from looking like a completely ignored command.
    // This middleware runs before feature middleware/routes, so asynchronous failures
    // receive a visible, safe error message while detailed diagnostics stay in logs.
    bot.use(async (ctx, next) => {
        try {
            return await next()
        } catch (err) {
            console.error('[TELEGRAM HANDLER ERROR]', err?.stack || err)
            const rateLimited = isTelegramRateLimitError(err)
            if (rateLimited) {
                setTelegramRateLimit(err)
                const retryMs = telegramRetryAfterMs(err)
                if (retryMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(retryMs + 300, 60000)))
            }
            const notice = '⚠️ <b>Perintah belum berhasil diproses.</b>\n\nTerjadi kendala internal saat menjalankan fitur. Coba sekali lagi sebentar lagi. Jika terus terjadi, admin perlu memeriksa log bot.'
            if (ctx?.chat?.id) {
                try {
                    await waitTelegramEditSlot(ctx.chat.id)
                    await ctx.telegram.sendMessage(ctx.chat.id, notice, { parse_mode: 'HTML', disable_web_page_preview: true })
                } catch (noticeError) {
                    if (isTelegramRateLimitError(noticeError)) setTelegramRateLimit(noticeError)
                    console.error('[TELEGRAM ERROR NOTICE]', noticeError?.description || noticeError?.message || noticeError)
                }
            } else if (ctx?.callbackQuery) {
                try { await ctx.answerCbQuery('Terjadi kendala. Coba lagi sebentar.', { show_alert: true }) } catch {}
            }
            return undefined
        }
    })

    if (typeof storeService.setOwnerTelegramSender === 'function') {
        storeService.setOwnerTelegramSender(async html => {
            for (const target of ownerTelegramTargets()) {
                await bot.telegram.sendMessage(target, html, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                })
            }
        })
    }

    // Simpan setiap user yang berinteraksi agar broadcast Telegram dapat menjangkau
    // user yang belum pernah menghubungkan akun WhatsApp.
    bot.use(async (ctx, next) => {
        try { registerTelegramUser(ctx) } catch (e) { console.error('[TELEGRAM USER REGISTER]', e?.message || e) }
        return next()
    })

    // Semua fitur private Telegram dikunci sampai user follow channel.
    bot.use(async (ctx, next) => {
        if (ctx.callbackQuery?.data === 'tg_check_join') return next()
        const ok = await requireChannelJoin(ctx)
        if (!ok) return
        return next()
    })

    bot.use(async (ctx, next) => {
        if (!telegramMaintenanceEnabled() || isTelegramAdmin(ctx)) return next()
        if (ctx.callbackQuery) {
            await answer(ctx, '🛠️ Bot Telegram sedang maintenance.')
            return
        }
        if (ctx.message?.text) return commandOutput(ctx, '🛠️ <b>BOT TELEGRAM SEDANG MAINTENANCE</b>\n\nSilakan coba lagi setelah maintenance selesai.')
        return next()
    })

    bot.start(async ctx => {
        const existing = getUi(ctx.from.id)
        // A private-chat UI session must never redirect /start sent in a group
        // back into the user's private chat (and vice versa).
        const sameChat = existing?.chatId != null && String(existing.chatId) === String(ctx.chat?.id)
        return showHome(ctx, {
            edit: Boolean(sameChat && existing?.messageId),
            forceImage: true
        })
    })

    bot.command('update', async ctx => {
        try {
            await githubUpdateUser.update({
                projectRoot: __dirname,
                reply: message => ctx.reply(message, { disable_web_page_preview: true })
            })
        } catch (error) {
            console.error('[TELEGRAM GITHUB UPDATE]', error?.stack || error)
            await commandOutput(ctx, `❌ Update gagal.\n${error?.message || 'Kesalahan tidak diketahui.'}`)
        }
    })

    bot.command('richdemo', ctx => showRichShowcase(ctx))

    // Scrapr media extractor/resolver commands. Spotify and MediaFire are
    // deliberately kept on their existing Xeryuu download flows.
    for (const name of [
        'scrapr', 'scrapeurl', 'resolver', 'download', 'aio',
        'tiktok', 'instagram', 'facebook', 'youtube', 'twitter', 'soundcloud',
        'pinterest', 'applemusic', 'bilibili', 'douyin', 'bandcamp', 'pixiv',
        'rednote', 'xiaohongshu', 'threads', 'reddit', 'terabox', 'sfile',
        'safelinku', 'sub2unlock', 'rekonise', 'unshorten'
    ]) {
        bot.command(name, ctx => handleTelegramScrapr(ctx, name))
    }
    bot.command('convertpulsa', ctx => showConvertPulsaTelegramMenu(ctx))
    bot.command('convert', ctx => showConvertPulsaTelegramMenu(ctx))
    bot.command('cp', ctx => showConvertPulsaTelegramMenu(ctx))
    bot.command('donasi', showTelegramDonation)
    bot.command('donate', showTelegramDonation)
    bot.command('saweria', showTelegramDonation)
    bot.command('cpstatus', ctx => handleConvertPulsaTelegramStatus(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))
    bot.command('cpwayat', listConvertPulsaTelegramHistory)
    bot.command('cpbukti', ctx => startConvertPulsaTelegramProof(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))
    bot.command('cpproof', ctx => startConvertPulsaTelegramProof(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))

    bot.help(ctx => commandOutput(ctx, 
        '/richdemo\n/convertpulsa — convert pulsa\n/cpstatus <REF>\n/cpwayat\n/cpbukti <REF> — kirim foto bukti untuk review admin\n/donasi — dukung developer via Saweria\n/store\n/belistore &lt;produk&gt;\n/storestatus &lt;REF&gt;\n/storecancel &lt;REF&gt;\n/storeorders\n/adminstore\n/saldo\n/profile\n/link &lt;nomor&gt; (opsional)\n/unlink\n/deposit [nominal]\n/depositstatus &lt;ref&gt;\n/depositcancel &lt;ref&gt;\n/canceldeposit &lt;ref&gt;\n/nokosavailable [service]\n/nokosorder &lt;service&gt; &lt;country&gt; [operator] [provider_id]\n/nokosstatus &lt;ref&gt;\n/nokosresend &lt;ref&gt;\n/nokoscancel &lt;ref&gt;\n/nokoscountries\n/nokosservices\n/nokosprice &lt;service&gt; &lt;country&gt; [provider_id]\n/nokosdiag\n/scrapr &lt;url&gt; — deteksi otomatis downloader\n/tiktok, /instagram, /facebook, /youtube, /twitter, /soundcloud, /pinterest\n/applemusic, /bilibili, /douyin, /bandcamp, /pixiv, /rednote, /threads, /reddit, /terabox\n/sfile, /safelinku, /sub2unlock, /rekonise, /unshorten\n/broadcast &lt;pesan&gt; (owner/admin)\n/maintenance on|off|status (owner/admin)'
    ))

    bot.command('broadcast', async ctx => {
        const text = String(ctx.message.text || '').trim().split(/\s+/).slice(1).join(' ')
        return telegramBroadcast(ctx, text)
    })

    bot.command('maintenance', async ctx => {
        if (!isTelegramAdmin(ctx)) return commandOutput(ctx, '⛔ <b>AKSES DITOLAK</b>\n\nCommand ini hanya untuk owner/admin Telegram.')
        const arg = String(ctx.message.text || '').trim().split(/\s+/)[1]?.toLowerCase() || 'status'
        if (arg === 'status') return commandOutput(ctx, telegramMaintenanceEnabled()
            ? '🛠️ <b>MAINTENANCE TELEGRAM: AKTIF</b>\n\nUser biasa sementara tidak dapat menggunakan bot.'
            : '✅ <b>MAINTENANCE TELEGRAM: NONAKTIF</b>\n\nBot Telegram berjalan normal.')
        if (!['on', 'off'].includes(arg)) return commandOutput(ctx, 'Contoh: <code>/maintenance on</code> atau <code>/maintenance off</code>')
        setTelegramMaintenance(arg === 'on')
        return commandOutput(ctx, arg === 'on'
            ? '🛠️ <b>MAINTENANCE TELEGRAM AKTIF</b>\n\nUser biasa sekarang akan menerima pemberitahuan maintenance.'
            : '✅ <b>MAINTENANCE TELEGRAM DIMATIKAN</b>\n\nBot kembali dapat digunakan.')
    })

    bot.command('link', async ctx => {
        const number = String(ctx.message.text || '').split(/\s+/)[1] || ''
        const jid = normalizeWaJid(number)
        if (!jid) return commandOutput(ctx, 'Contoh: /link 6283112345678')
        if (!waConn || !waConn.user) return commandOutput(ctx, '❌ WhatsApp belum terhubung ke server. Coba lagi sebentar lagi.')
        const code = pendingLink(ctx.from.id, jid)
        try {
            await waConn.sendMessage(jid, { text: `🔐 *VERIFIKASI TELEGRAM XERYUU*\n\nAda permintaan menghubungkan akun Telegram ini ke WhatsApp kamu.\n\nKode: *${code}*\nBerlaku 10 menit.\n\nJika ini memang kamu, balas pesan ini dengan:\n*.tgbind ${code}*\n\nJika bukan kamu, abaikan pesan ini.` })
            return commandOutput(ctx, `📨 Kode verifikasi sudah dikirim ke WhatsApp ${number}.\n\nBuka WhatsApp tersebut dan kirim: .tgbind ${code}`)
        } catch (e) {
            return commandOutput(ctx, `❌ Gagal mengirim kode ke WhatsApp: ${e?.message || e}`)
        }
    })

    bot.command('unlink', ctx => commandOutput(ctx, unlinkTelegram(ctx.from.id) ? '✅ Telegram berhasil dilepas dari akun WhatsApp.' : 'ℹ️ Akun Telegram belum terhubung.'))
    bot.command('saldo', sendBalance)
    bot.command('profile', sendProfile)
    bot.command('deposit', ctx => withTelegramActionLock(ctx, 'deposit', () => showDepositProviderMenu(ctx, String(ctx.message.text || '').split(/\s+/)[1] || '')))
    const handleDepositCancelCommand = async ctx => {
        const jid = getTransactionJid(ctx)
        if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
        const ref = String(ctx.message.text || '').split(/\s+/)[1] || ''
        return handleDepositCancel(ctx, ref)
    }
    bot.command('depositcancel', handleDepositCancelCommand)
    bot.command('canceldeposit', handleDepositCancelCommand)
    bot.command('depositstatus', async ctx => {
        const jid = getTransactionJid(ctx)
        if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
        const ref = String(ctx.message.text || '').split(/\s+/)[1] || ''
        if (!ref) return commandOutput(ctx, 'Contoh: /depositstatus DEPXXXX')
        try {
            const tx = depositService.get(ref)
            if (!tx) return commandOutput(ctx, '❌ Invoice tidak ditemukan.')
            if (tx.jid !== jid) return commandOutput(ctx, '❌ Invoice tersebut bukan milik kamu.')
            if (String(tx.kind || 'DEPOSIT').toUpperCase() !== 'DEPOSIT') {
                return commandOutput(ctx, '❌ Referensi tersebut bukan invoice deposit saldo. Untuk Store/Jadibot/Sewa Bot gunakan /storestatus atau tombol status order.')
            }
            const current = await depositService.check(ref)
            const normalized = String(current.status || '').toUpperCase()
            const cancellable = !current.credited && !['PAID', 'SUCCESS', 'SETTLED', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELED'].includes(normalized)
            return editTracked(
                ctx,
                `💳 <b>STATUS DEPOSIT</b>\n\n` +
                `Invoice: <b>${escapeHtml(current.merchantRef)}</b>\n` +
                `Nominal: <b>Rp${escapeHtml(depositService.formatMoney(current.amount))}</b>\n` +
                `Gateway: <b>NasionalPay</b>\n` +
                `Status: <b>${escapeHtml(current.status)}</b>\n` +
                `Saldo masuk: <b>${current.credited ? 'YA' : 'BELUM'}</b>\n` +
                `Saldo Biasa: <b>Rp${escapeHtml(economy.formatMoney(economy.getBalance(jid)))}</b>`,
                depositActionKeyboard(ref, { showCancel: cancellable, showStatus: true })
            )
        } catch (e) {
            return editTracked(ctx, `❌ Gagal cek deposit: ${escapeHtml(e?.message || e)}`, backHomeKeyboard())
        }
    })

    bot.command('store', ctx => renderStore(ctx, 0, 'all'))
    bot.command('belistore', async ctx => {
        const key = String(ctx.message.text || '').trim().split(/\s+/)[1] || ''
        const list = storeService.products()
        const index = list.findIndex(x => String(x.key).toLowerCase() === key.toLowerCase())
        if (index < 0) return commandOutput(ctx, `❌ Produk <b>${escapeHtml(key || '-')}</b> tidak ditemukan. Gunakan /store untuk melihat katalog.`)
        return withTelegramActionLock(ctx, 'store-buy', () => handleStoreOrder(ctx, index))
    })
    bot.command('orderstore', async ctx => {
        const key = String(ctx.message.text || '').trim().split(/\s+/)[1] || ''
        const list = storeService.products()
        const index = list.findIndex(x => String(x.key).toLowerCase() === key.toLowerCase())
        if (index < 0) return commandOutput(ctx, `❌ Produk <b>${escapeHtml(key || '-')}</b> tidak ditemukan. Gunakan /store untuk melihat katalog.`)
        return withTelegramActionLock(ctx, 'store-buy', () => handleStoreOrder(ctx, index))
    })
    bot.command('storestatus', ctx => handleStoreStatus(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))
    bot.command('storecancel', ctx => handleStoreCancel(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))
    bot.command('sewagroup', async ctx => {
        const jid = storeJid(ctx)
        const value = String(ctx.message.text || '').trim().split(/\s+/).slice(1).join(' ')
        if (!value) return commandOutput(ctx, 'Contoh: /sewagroup https://chat.whatsapp.com/XXXXXXXXXXXX')
        const handled = await storeService.handleCustomerInput(jid, value)
        if (!handled) return commandOutput(ctx, '❌ Tidak ada order sewa yang sedang menunggu link grup.')
    })
    bot.command('jadipair', async ctx => {
        const jid = storeJid(ctx)
        const value = String(ctx.message.text || '').trim().split(/\s+/)[1] || ''
        if (!value) return commandOutput(ctx, 'Contoh: /jadipair 628123456789')
        const handled = await storeService.handleCustomerInput(jid, value)
        if (!handled) return commandOutput(ctx, '❌ Tidak ada order jadibot yang sedang menunggu nomor.')
    })
    bot.command('storeorders', listTelegramStoreOrders)
    bot.command('adminstore', renderAdminPanel)
    bot.command('nokosavailable', ctx => handleNokosAvailable(ctx, String(ctx.message.text || '').split(/\s+/)[1] || 'wa'))
    bot.command('nokoscountries', ctx => handleNokosAvailable(ctx, 'wa'))
    bot.command('nokosservices', async ctx => {
        try {
            const arg = String(ctx.message.text || '').trim().split(/\s+/)[1]
            const country = Number(arg || global.nokosConfig?.defaultCountry || 6)
            const list = await nokosService.services(Number.isFinite(country) ? country : undefined)
            return commandOutputChunks(ctx, `📱 LAYANAN NOKOS\nNegara: ${Number.isFinite(country) ? country : '-'}\n\n` + list.map(x => `${x.code} — ${x.name}`).join('\n'), 3900)
        } catch (e) { return commandOutput(ctx, `❌ Gagal mengambil layanan: ${e?.message || e}`) }
    })
    bot.command('nokosprice', async ctx => {
        const args = String(ctx.message.text || '').trim().split(/\s+/).slice(1)
        const service = String(args[0] || 'wa').toLowerCase(); const country = Number(args[1]); const providerId = String(args[2] || global.nokosConfig?.defaultProviderId || '').trim()
        if (!Number.isFinite(country)) return commandOutput(ctx, 'Contoh: /nokosprice wa 6 [provider_id]')
        try {
            const p = await nokosService.getPrice(service, country, providerId || null)
            const selling = nokosService.sellPrice(p?.cost || 0)
            return commandOutput(ctx, `📱 ${service.toUpperCase()} — negara ${country}\n💰 Harga jual: Rp${nokosService.money(selling)}\n📦 Stok: ${p?.stock == null ? 'Tidak diberikan provider' : p.stock}`)
        } catch (e) { return commandOutput(ctx, `❌ ${e?.message || e}`) }
    })
    bot.command('nokosorder', ctx => withTelegramActionLock(ctx, 'nokos-buy', () => handleNokosOrder(ctx, String(ctx.message.text || '').trim().split(/\s+/).slice(1))))
    bot.command('nokosstatus', ctx => handleNokosStatus(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))
    bot.command('nokosresend', ctx => handleNokosResend(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))
    bot.command('nokoscancel', ctx => handleNokosCancel(ctx, String(ctx.message.text || '').trim().split(/\s+/)[1] || ''))
    bot.command('nokosdiag', async ctx => {
        const owner = String(global.owner || '').replace(/\D/g, '')
        const linked = getJid(ctx)?.replace(/\D/g, '')
        if (!owner || linked !== owner) return commandOutput(ctx, '⛔ Command owner only.')
        try {
            const key = typeof nokosService.getApiKey === 'function' ? nokosService.getApiKey() : String(global.nokosConfig?.apiKey || '').trim()
            const masked = key.length >= 8 ? `${key.slice(0, 4)}${'*'.repeat(Math.max(0, key.length - 8))}${key.slice(-4)}` : '(kosong)'
            if (!key) return commandOutput(ctx, '❌ API key RuangOTP kosong di settings.js')
            const service = String(global.nokosConfig?.defaultService || 'wa').toLowerCase()
            const countries = await nokosService.countries(service)
            return commandOutput(ctx, `✅ RuangOTP API siap dipakai\n\n🔑 Key terbaca: ${masked}\n🌍 Negara bisa berbeda beda harga, contoh nya seperti dibawah: ${countries.length}\n🌐 Base URL: ${nokosService.baseUrl()}`)
        } catch (e) { return commandOutput(ctx, `❌ RuangOTP API gagal: ${e?.message || e}`) }
    })
    bot.command('nokosbalance', async ctx => {
        const owner = String(global.owner || '').replace(/\D/g, '')
        const linked = getJid(ctx)?.replace(/\D/g, '')
        if (!owner || linked !== owner) return commandOutput(ctx, '⛔ Command owner only.')
        return commandOutput(ctx, 'ℹ️ Endpoint saldo RuangOTP tidak termasuk integrasi v2 yang dipasang pada bot ini.')
    })
    bot.action('tg_check_join', async ctx => {
        await answer(ctx)
        const status = await isChannelMember(ctx)
        if (status === true) return showHome(ctx, { edit: true })
        if (status === null) return editTracked(ctx, `⚠️ <b>Gagal mengecek membership.</b>\n\nPastikan bot adalah admin channel.`, joinChannelKeyboard())
        return showForceJoin(ctx, { edit: true })
    })
    bot.action('tg_home', async ctx => { await answer(ctx); return showHome(ctx) })
    bot.action('tg_home_donasi', async ctx => { await answer(ctx); return showTelegramDonation(ctx) })
    bot.action('tg_home_convertpulsa', async ctx => { await answer(ctx); return showConvertPulsaTelegramMenu(ctx) })
    bot.action(/^tg_cp_page:(\d+)$/, async ctx => { await answer(ctx); return showConvertPulsaTelegramMenu(ctx, Number(ctx.match[1])) })
    bot.action(/^tg_cp_operator:(\d+)$/, async ctx => {
        await answer(ctx)
        if (!privateChat(ctx)) return commandOutput(ctx, '🔒 Buka chat pribadi bot untuk melanjutkan.')
        const session = convertPulsaTelegramSession(ctx)
        const operator = session?.operators?.[Number(ctx.match[1])]
        if (!operator) return showConvertPulsaTelegramMenu(ctx)
        if (!operator.available) return sendConvertPulsaRich(ctx, { title: '⚠️ OPERATOR OFFLINE', lines: [`${operator.name} tidak tersedia menurut data terbaru yang disimpan. Pilih operator lain.`], buttonRows: [[{ text: '⬅️ Pilih Operator', callbackData: 'tg_home_convertpulsa' }]], screen: 'convert_pulsa' })
        convertPulsaSaveTelegramSession(ctx, { step: 'amount', operatorId: String(operator.id), operatorName: operator.name, amount: null, estimatedAmount: null })
        return showConvertPulsaTelegramAmount(ctx)
    })
    bot.action(/^tg_cp_amount:(\d+)$/, async ctx => { await answer(ctx); return showConvertPulsaTelegramAmount(ctx, ctx.match[1]) })
    bot.action(/^tg_cp_payoutpage:(\d+)$/, async ctx => { await answer(ctx); return showConvertPulsaTelegramPayouts(ctx, Number(ctx.match[1])) })
    bot.action(/^tg_cp_payout:(\d+)$/, async ctx => {
        await answer(ctx)
        const session = convertPulsaTelegramSession(ctx)
        if (!session || session.step !== 'payout') return showConvertPulsaTelegramMenu(ctx)
        const method = session.payoutMethods?.[Number(ctx.match[1])]
        if (!method) return showConvertPulsaTelegramPayouts(ctx, session.payoutPage || 0)
        convertPulsaSaveTelegramSession(ctx, { step: 'payout_number', payoutMethod: String(method.value), payoutMethodLabel: String(method.label || method.value) })
        return sendConvertPulsaRich(ctx, { title: '📲 NOMOR E-WALLET TUJUAN', lines: [`Metode: ${method.label || method.value}`, 'Kirim nomor rekening/akun e-wallet penerima sebagai pesan berikutnya.', 'Periksa nomornya dengan teliti. Bot tidak akan memproses pembayaran ke nomor lain selain yang dikirimkan.'], buttonRows: [[{ text: '❌ Batalkan Draft', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
    })
    bot.action('tg_cp_prompt_amount', async ctx => {
        await answer(ctx)
        const session = convertPulsaTelegramSession(ctx)
        if (!session) return showConvertPulsaTelegramMenu(ctx)
        convertPulsaSaveTelegramSession(ctx, { step: 'amount', payoutMethod: '', payoutMethodLabel: '', payoutAccountNumber: '', payoutAccountName: '', senderPhoneNumber: '', requestedAt: null, localRef: '' })
        return showConvertPulsaTelegramAmount(ctx)
    })
    bot.action('tg_cp_prompt_payout_number', async ctx => {
        await answer(ctx)
        const session = convertPulsaTelegramSession(ctx)
        if (!session || session.step !== 'payout_number') return showConvertPulsaTelegramMenu(ctx)
        return sendConvertPulsaRich(ctx, { title: '📲 NOMOR E-WALLET TUJUAN', lines: [`Metode: ${session.payoutMethodLabel || session.payoutMethod}`, 'Kirim ulang nomor e-wallet penerima menggunakan angka 6–30 digit.'], buttonRows: [[{ text: '❌ Batalkan Draft', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
    })
    bot.action('tg_cp_create', async ctx => { await answer(ctx); return withTelegramActionLock(ctx, 'convert-pulsa-create', () => createConvertPulsaTelegramOrder(ctx)) })
    bot.action(/^tg_cp_status:(.+)$/, async ctx => { await answer(ctx); return handleConvertPulsaTelegramStatus(ctx, ctx.match[1]) })
    bot.action(/^tg_cp_proof_start:(.+)$/, async ctx => { await answer(ctx); return startConvertPulsaTelegramProof(ctx, ctx.match[1]) })
    bot.action('tg_cp_proof_cancel', async ctx => {
        await answer(ctx)
        const session = convertPulsaTelegramSession(ctx)
        if (!session || session.step !== 'proof_upload') return sendConvertPulsaRich(ctx, { title: 'ℹ️ TIDAK ADA SESI BUKTI', lines: ['Tidak ada sesi upload bukti yang aktif. Status provider tidak diubah.'], buttonRows: [[{ text: '📚 Riwayat', callbackData: 'tg_cp_history' }, { text: '🏠 Menu', callbackData: 'tg_home' }]], screen: 'convert_pulsa' })
        restoreConvertPulsaTelegramSession(ctx, session)
        return sendConvertPulsaRich(ctx, { title: '✅ PENGIRIMAN BUKTI DIBATALKAN', lines: ['Tidak ada foto yang diteruskan. Transaksi PesanJasa tetap berjalan seperti sebelumnya dan status provider tidak diubah.'], buttonRows: [[{ text: '🔄 Cek Status', callbackData: session.proofRef ? `tg_cp_status:${session.proofRef}` : 'tg_cp_history' }, { text: '📚 Riwayat', callbackData: 'tg_cp_history' }]], screen: 'convert_pulsa_transaction' })
    })
    bot.action('tg_cp_history', async ctx => { await answer(ctx); return listConvertPulsaTelegramHistory(ctx) })
    bot.action('tg_cp_cancel', async ctx => { await answer(ctx); return cancelConvertPulsaTelegramDraft(ctx) })
    bot.action('tg_rich_showcase', async ctx => { await answer(ctx); return showRichShowcase(ctx) })
    bot.action(/^tg_rich_demo:(table|card|dashboard)$/, async ctx => { await answer(ctx); return renderRichDemo(ctx, ctx.match[1]) })
    bot.action('tg_home_balance', async ctx => { await answer(ctx); return sendBalance(ctx) })
    bot.action('tg_home_profile', async ctx => { await answer(ctx); return sendProfile(ctx) })
    bot.action('tg_home_deposit', async ctx => { await answer(ctx); return showDepositProviderMenu(ctx) })
    bot.action('tg_deposit_provider:nasionalpay', async ctx => { await answer(ctx); return showDepositAmounts(ctx) })
    bot.action(/^tg_deposit:nasionalpay:(\d+)$/, async ctx => { await answer(ctx); return withTelegramActionLock(ctx, 'deposit', () => handleDeposit(ctx, ctx.match[1])) })
    bot.action(/^tg_deposit_status:(.+)$/, async ctx => {
        await answer(ctx)
        const ref = ctx.match[1]
        try {
            const jid = getTransactionJid(ctx)
            if (!jid) return commandOutput(ctx, '❌ Telegram ID tidak valid.')
            const tx = depositService.get(ref)
            if (!tx || tx.jid !== jid) return editTracked(ctx, '❌ Invoice tidak ditemukan atau bukan milik kamu.', backHomeKeyboard())
            const current = await depositService.check(ref)
            const normalized = String(current.status || '').toUpperCase()
            const cancellable = !current.credited && !['PAID', 'SUCCESS', 'SETTLED', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELED'].includes(normalized)
            return sendConvertPulsaRich(ctx, {
                title: '💳 STATUS DEPOSIT SALDO',
                lines: [
                    `Invoice: ${current.merchantRef}`,
                    `Nominal saldo: Rp${depositService.formatMoney(current.amount)}`,
                    ...(current.totalPay && Number(current.totalPay) !== Number(current.amount) ? [`Total bayar: Rp${depositService.formatMoney(current.totalPay)}`] : []),
                    `Gateway: ${current.providerName || 'NasionalPay'}`,
                    `Status: ${current.status}`,
                    `Saldo masuk: ${current.credited ? 'YA' : 'BELUM'}`,
                    `Saldo Biasa saat ini: Rp${economy.formatMoney(economy.getBalance(jid))}`
                ],
                buttonRows: [
                    [{ text: '🔄 CEK STATUS', callbackData: `tg_deposit_status:${current.merchantRef}` }, ...(cancellable ? [{ text: '❌ BATALKAN DEPOSIT', callbackData: `tg_deposit_cancel:${current.merchantRef}` }] : [])],
                    [{ text: '💳 DEPOSIT LAGI', callbackData: 'tg_home_deposit' }, { text: '🏠 MENU UTAMA', callbackData: 'tg_home' }]
                ],
                screen: 'deposit_status', edit: Boolean(ctx.callbackQuery)
            })
        } catch (e) {
            return editTracked(ctx, `❌ Gagal cek deposit: ${escapeHtml(e?.message || e)}`, backHomeKeyboard())
        }
    })

    bot.action(/^tg_deposit_cancel:(.+)$/, async ctx => {
        await answer(ctx)
        return handleDepositCancel(ctx, ctx.match[1])
    })

    bot.action('tg_deposit_cancel_latest:nasionalpay', async ctx => {
        await answer(ctx)
        return handleDepositCancelLatest(ctx, 'nasionalpay')
    })

    bot.action('tg_home_store', async ctx => { await answer(ctx); return renderStore(ctx, 0, 'all') })
    bot.action(/^tg_store_category:(all|panel|rental|jadibot)$/, async ctx => { await answer(ctx); return renderStore(ctx, 0, ctx.match[1]) })
    bot.action(/^tg_store_page:(\d+)(?::(all|panel|rental|jadibot))?$/, async ctx => { await answer(ctx); return renderStore(ctx, Number(ctx.match[1]), ctx.match[2] || getUi(ctx.from.id)?.storeCategory || 'rental') })
    bot.action(/^tg_store_product:(\d+)$/, async ctx => { await answer(ctx); return selectStoreProduct(ctx, Number(ctx.match[1])) })
    bot.action(/^tg_store_payment:(\d+)$/, async ctx => { await answer(ctx); return showStorePayment(ctx, Number(ctx.match[1])) })
    bot.action(/^tg_store_buy:(\d+)$/, async ctx => { await answer(ctx); return withTelegramActionLock(ctx, 'store-buy', () => handleStoreOrder(ctx, Number(ctx.match[1]), { edit: true })) })
    bot.action(/^tg_store_status:(.+)$/, async ctx => { await answer(ctx); return handleStoreStatus(ctx, ctx.match[1]) })
    bot.action(/^tg_store_password:(.+)$/, async ctx => {
        await answer(ctx)
        if (!privateChat(ctx)) return commandOutput(ctx, '🔒 Password panel hanya dapat dikirim lewat chat pribadi.')
        const ref = String(ctx.match[1] || '').trim().toUpperCase()
        const order = storeService.getOrder(ref)
        if (!order || order.jid !== storeJid(ctx)) return commandOutput(ctx, '❌ Order tidak ditemukan atau bukan milik akun kamu.')
        if (order.productType !== 'panel' || !order.panel?.password || String(order.status || '').toUpperCase() !== 'DONE') {
            return commandOutput(ctx, '❌ Password belum tersedia pada order ini.')
        }
        return ctx.telegram.sendMessage(ctx.chat.id,
            `<b>🔑 PASSWORD PANEL • SALIN DARI SINI</b>\n\n<code>${escapeHtml(order.panel.password)}</code>\n\nTekan atau tahan teks password untuk menyalinnya. Simpan rahasia ini dan jangan membagikannya.`,
            { parse_mode: 'HTML', disable_web_page_preview: true }
        )
    })
    bot.action(/^tg_store_cancel:(.+)$/, async ctx => { await answer(ctx); return handleStoreCancel(ctx, ctx.match[1]) })
    bot.action('tg_store_orders', async ctx => { await answer(ctx); return listTelegramStoreOrders(ctx) })
    bot.action('tg_admin_panel', async ctx => { await answer(ctx); return renderAdminPanel(ctx) })

    bot.action('tg_home_nokos', async ctx => {
        await answer(ctx)
        return renderNokosServices(ctx)
    })
    bot.action('tg_nokos_services', async ctx => { await answer(ctx); return renderNokosServices(ctx) })
    bot.action(/^tg_nokos_service:([a-z0-9_-]{1,24})$/i, async ctx => { await answer(ctx); return renderNokos(ctx, { service: String(ctx.match[1]).toLowerCase(), page: 0 }) })
    bot.action('tg_nokos_refresh', async ctx => { await answer(ctx); const ui = getUi(ctx.from.id); return renderNokos(ctx, { service: ui?.nokosService || 'wa', page: ui?.nokosPage || 0 }) })
    bot.action(/^tg_nokos_page:(\d+)$/, async ctx => {
        await answer(ctx)
        const ui = getUi(ctx.from.id)
        return renderNokos(ctx, {
            service: ui?.nokosService || 'wa',
            page: Number(ctx.match[1])
        })
    })

    bot.action(/^tg_nokos_country:(\d+)$/, async ctx => {
        await answer(ctx)
        return renderNokosCountry(ctx, Number(ctx.match[1]))
    })

    bot.action(/^tg_nokos_servers:(\d+)$/, async ctx => {
        await answer(ctx)
        return renderNokosServers(ctx, Number(ctx.match[1]))
    })

    bot.action(/^tg_nokos_server:(\d+)$/, async ctx => {
        await answer(ctx)
        return renderNokosServer(ctx, Number(ctx.match[1]))
    })

    bot.action(/^tg_nokos_buy_server:(\d+)$/, async ctx => {
        await answer(ctx)
        const ui = getUi(ctx.from.id) || {}
        const server = Array.isArray(ui.nokosSelectedServers)
            ? ui.nokosSelectedServers[Number(ctx.match[1])]
            : null
        const country = ui.nokosSelectedCountry?.country

        if (!server || !country) {
            return editTracked(ctx, '❌ Server yang dipilih sudah tidak tersedia. Silakan pilih server lagi.', backHomeKeyboard())
        }

        return withTelegramActionLock(ctx, 'nokos-buy', () => handleNokosOrder(
            ctx,
            [ui.nokosService || 'wa', Number(country.id), 'any', server.providerId || ''],
            {
                edit: true,
                countryOverride: Number(country.id),
                priceOverride: server
            }
        ))
    })

    bot.action(/^tg_nokos_buy:(\d+)$/, async ctx => {
        await answer(ctx)
        const ui = getUi(ctx.from.id)
        const country = Number(ctx.match[1])
        const selected = ui?.nokosSelected
        const price = selected?.country?.id === country ? selected.price : null

        return withTelegramActionLock(ctx, 'nokos-buy', () => handleNokosOrder(
            ctx,
            [ui?.nokosService || 'wa', country, 'any', price?.providerId || ''],
            {
                edit: true,
                countryOverride: country,
                priceOverride: price
            }
        ))
    })
    bot.action(/^tg_nokos_status:(.+)$/, async ctx => { await answer(ctx); return handleNokosStatus(ctx, ctx.match[1], { edit: true }) })
    bot.action(/^tg_nokos_resend:(.+)$/, async ctx => { await answer(ctx); return handleNokosResend(ctx, ctx.match[1], { edit: true }) })
    bot.action(/^tg_nokos_cancel:(.+)$/, async ctx => { await answer(ctx); return handleNokosCancel(ctx, ctx.match[1], { edit: true }) })

    bot.action(/^tg_purchase_balance:(NOKOS|TOPUP):([A-F0-9]{16})$/i, async ctx => {
        await answer(ctx)
        const type = String(ctx.match[1]).toUpperCase()
        const token = String(ctx.match[2]).toUpperCase()
        return withTelegramActionLock(ctx, `purchase-balance-${token}`, () => handlePurchaseBalanceTelegram(ctx, type, token))
    })
    bot.action(/^tg_purchase_qris:(NOKOS|TOPUP):([A-F0-9]{16})$/i, async ctx => {
        await answer(ctx)
        const type = String(ctx.match[1]).toUpperCase()
        const token = String(ctx.match[2]).toUpperCase()
        return withTelegramActionLock(ctx, `purchase-qris-${token}`, () => handlePurchaseQrTelegram(ctx, type, token))
    })
    bot.action(/^tg_purchase_qris_status:(.+)$/, async ctx => {
        await answer(ctx)
        return withTelegramActionLock(ctx, `purchase-qris-status-${ctx.match[1]}`, () => handlePurchaseQrStatus(ctx, ctx.match[1]))
    })

    bot.action('tg_home_topup', async ctx => { await answer(ctx); return renderTopupGames(ctx) })
    bot.action('tg_topup_refresh', async ctx => {
        await answer(ctx)
        const s = getUi(ctx.from.id)
        if (!s?.topupGame) return renderTopupGames(ctx)
        return renderTopupProducts(ctx, s.topupGame, s.topupPage || 0)
    })
    bot.action(/^tg_topup_game:([a-z0-9_-]{1,32})$/, async ctx => { await answer(ctx); return renderTopupProducts(ctx, ctx.match[1], 0) })
    bot.action(/^tg_topup_page:([a-z0-9_-]{1,32}):(\d+)$/, async ctx => { await answer(ctx); return renderTopupProducts(ctx, ctx.match[1], Number(ctx.match[2])) })
    bot.action(/^tg_topup_product:([a-z0-9_-]{1,32}):(\d+)$/, async ctx => { await answer(ctx); return selectTopupProduct(ctx, ctx.match[1], Number(ctx.match[2])) })
    bot.action(/^tg_topup_status:(.+)$/, async ctx => { await answer(ctx); return handleTopupStatus(ctx, ctx.match[1]) })

    bot.hears(/^\s*deposit(?:\s+(\d+))?\s*$/i, async ctx => {
        return showDepositProviderMenu(ctx, ctx.match?.[1] || '')
    })

    // Receipt photos are only handled when the same Telegram user started an
    // explicit proof-upload session from an owned, active provider transaction.
    bot.on('photo', async ctx => {
        try {
            const handled = await handleConvertPulsaTelegramProofMedia(ctx)
            if (handled) return
        } catch (error) {
            console.error('[TELEGRAM CONVERT PULSA PROOF ROUTE]', error?.stack || error)
            return sendConvertPulsaRich(ctx, { title: '❌ BUKTI BELUM DIPROSES', lines: [convertPulsaSafeInstruction(error?.message || error, 350), 'Status provider tidak diubah. Coba kirim foto lagi atau batalkan sesi.'], buttonRows: [[{ text: '❌ Batal kirim bukti', callbackData: 'tg_cp_proof_cancel' }]], screen: 'convert_pulsa_proof' })
        }
    })

    // Input ID top up diproses tanpa membuat menu baru.
    bot.on('text', async ctx => {
        if (String(ctx.message.text || '').startsWith('/')) return
        try {
            const handledConvertPulsa = await handleConvertPulsaTelegramText(ctx, ctx.message.text)
            if (handledConvertPulsa) return
        } catch (error) {
            console.error('[TELEGRAM CONVERT PULSA TEXT INPUT]', error?.stack || error)
            return sendConvertPulsaRich(ctx, { title: '⚠️ INPUT BELUM BERHASIL DIPROSES', lines: [convertPulsaSafeInstruction(error?.message || error, 500), 'Data transaksi belum dikirim ke provider. Coba ulangi tahap input atau batalkan draft.'], buttonRows: [[{ text: '🔄 Ulangi Menu', callbackData: 'tg_home_convertpulsa' }, { text: '❌ Batal', callbackData: 'tg_cp_cancel' }]], screen: 'convert_pulsa' })
        }
        const storeJidValue = storeJid(ctx)
        try {
            const handledStoreInput = await storeService.handleCustomerInput(storeJidValue, ctx.message.text)
            if (handledStoreInput) return
        } catch (e) {
            console.error('[TELEGRAM STORE INPUT]', e?.stack || e)
        }
        if (getUi(ctx.from.id)?.pendingTopup) {
            await withTelegramActionLock(ctx, 'topup-submit', () => processPendingTopup(ctx, ctx.message.text))
        }
    })

    bot.catch(err => console.error('[TELEGRAM ERROR]', err?.stack || err))
    bot.launch().then(() => console.log('[TELEGRAM] Bot Telegram aktif.')).catch(err => console.error('[TELEGRAM START ERROR]', err?.stack || err))
    process.once('SIGINT', () => bot?.stop('SIGINT'))
    process.once('SIGTERM', () => bot?.stop('SIGTERM'))
    return bot
}

// Legacy function kept for compatibility with existing command handlers/documentation.
async function handleNokosAvailable(ctx, service = 'wa') {
    try {
        const catalog = await nokosService.getCatalog(service)
        if (!catalog.length) return commandOutput(ctx, '❌ Tidak ada negara yang dikembalikan provider untuk layanan tersebut.')
        let out = `🌍 NEGARA NOKOS — ${String(service).toUpperCase()}\n━━━━━━━━━━━━━━━━━━\n`
        for (const c of catalog) {
            const flag = c.flag || nokosService.countryFlag?.(c.name, c.prefix, c.raw) || '🏳️'
            out += `\n${flag} ${c.id} — ${c.name || `Country ID ${c.id}`} ${c.prefix || ''}`
        }
        out += `\n\n📌 Total negara: ${catalog.length}`
        out += `\n💡 Gunakan /nokosprice ${service} <country_id> atau /nokosorder ${service} <country_id> any [provider_id]`
        return sendChunks(ctx, out)
    } catch (e) {
        return commandOutput(ctx, `❌ Gagal mengambil daftar negara NOKOS: ${e?.message || e}`)
    }
}

module.exports = {
    start,
    setWaConn,
    sendTelegramMessage,
    isTelegramAccountJid,
    verifyBindCode,
    getLink,
    unlinkTelegram,
    isLinked,
    notifyOwnerPurchase
}
//UPPPPPPP
let file = require.resolve(__filename)
fs.watchFile(file, () => {
	fs.unwatchFile(file)
	console.log(chalk.redBright(`Update ${__filename}`))
	delete require.cache[file]
	require(file)
})