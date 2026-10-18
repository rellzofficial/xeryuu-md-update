'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const fetch = require('node-fetch')
const { generateWAMessageFromContent, jidNormalizedUser } = require('@whiskeysockets/baileys')

const CACHE_DIR = path.join(__dirname, 'database', 'richhtml-cache')
const CERTIFICATE_URL = 'https://raw.githubusercontent.com/noxXza/data/refs/heads/main/certificate.json'

const GAME_DEFINITIONS = Object.freeze({
    plane: {
        aliases: ['plane', 'spacerush', 'richplane'],
        file: 'plane.html',
        title: 'Space Rush 🚀',
        trustedSources: ['noxXza.js', 'noxXza.dev']
    },
    dino: {
        aliases: ['dino', 'runner', 'richdino'],
        file: 'dino.html',
        title: 'Fiora Sylvie',
        trustedSources: ['nox.dev']
    },
    chess: {
        aliases: ['chess', 'catur', 'mini-chess', 'richchess'],
        file: 'chess.html',
        title: 'noxXza Mini Chess ♟️',
        trustedSources: ['thenuxofc.store', 'nixel.dev']
    },
    mbim: {
        aliases: ['mbim', 'highway', 'car', 'richmbim'],
        file: 'mbim.html',
        title: 'Highway Rush 🏎️',
        trustedSources: ['noxXza.store', 'noxXza.dev']
    },
    breakout: {
        aliases: ['breakout', 'arrowbreakout', 'richbreakout'],
        file: 'arrow-breakout.html',
        local: true,
        title: 'Arrow Breakout 🧱',
        trustedSources: []
    },
    'chess-ultimate': {
        aliases: ['fchess', 'chessultimate', 'richchess2'],
        file: 'chess-ultimate.html',
        local: true,
        title: 'Chess Furina Ultimate ♟️',
        trustedSources: []
    },
    tetromino: {
        aliases: ['tetromino', 'tetris', 'richtetris'],
        file: 'tetromino.html',
        local: true,
        title: 'Tetromino / Tetris 🧩',
        trustedSources: []
    },
    snake: {
        aliases: ['ular', 'snake', 'richsnake'],
        file: 'snake.html',
        local: true,
        title: 'Snake Neon Ultra 🐍',
        trustedSources: []
    },
    flappy: {
        aliases: ['flappy', 'flappybird', 'richflappy'],
        file: 'flappy.html',
        local: true,
        title: 'Flappy Bird 🐦',
        trustedSources: []
    },
    tictactoe: {
        aliases: ['ttc', 'tictactoe', 'rich-ttt', 'richttt'],
        file: 'ttc.html',
        title: 'Tic-Tac-Toe Premium',
        trustedSources: ['pastebin.com']
    }, 
    'quiz-hard': {
        aliases: ['quizhard', 'xquiz', 'richquiz'],
        file: 'quiz-hard.html',
        local: true,
        title: 'Xeryuu Quiz Hard 🧠',
        trustedSources: []
    },
    pong: {
        aliases: ['pong', 'richpong'],
        file: 'pong.html',
        local: true,
        title: 'Xeryuu Pong 🏓',
        trustedSources: []
    },
    racing: {
        aliases: ['racing', 'race', 'richracing'],
        file: 'racing.html',
        local: true,
        title: 'Xeryuu Racing 🏎️',
        trustedSources: []
    },
    'aim-shooter': {
        aliases: ['aim', 'aimshooter', 'shooting', 'richaim'],
        file: 'aim-shooter.html',
        local: true,
        title: 'Xeryuu Aim Shooter 🎯',
        trustedSources: []
    },
    platformer: {
        aliases: ['platformer', 'jump', 'richplatformer'],
        file: 'platformer.html',
        local: true,
        title: 'Xeryuu Platformer 🏃',
        trustedSources: []
    },
    space: {
        aliases: ['space', 'spaceshooter', 'spacegame', 'shooter', 'richspaceshooter', 'space-shooter'],
        file: 'space-shooter.html',
        local: true,
        title: 'Space Shooter 🚀',
        description: 'Space Shooter Game',
        trustedSources: []
    },
    'murder-mystery': {
        aliases: ['murder', 'murdermystery', 'mystery', 'detective', 'richmurder'],
        file: 'murder-mystery.html',
        local: true,
        title: 'Murder Mystery 🕵️',
        trustedSources: []
    }
})

const ALIAS_TO_GAME = new Map()
for (const [key, definition] of Object.entries(GAME_DEFINITIONS)) {
    ALIAS_TO_GAME.set(key, key)
    for (const alias of definition.aliases) ALIAS_TO_GAME.set(alias, key)
}

function ensureCacheDir() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
}

function safeName(name) {
    return String(name).replace(/[^a-z0-9._-]/gi, '_')
}

function randomId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    return crypto.randomBytes(16).toString('hex')
}

function randomStanzaId() {
    return crypto.randomBytes(16).toString('hex').toUpperCase()
}

async function fetchText(url, timeoutMs = 20000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

    try {
        const response = await fetch(url, controller ? { signal: controller.signal } : {})
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`)
        }
        return await response.text()
    } finally {
        if (timer) clearTimeout(timer)
    }
}

function readFreshCache(filePath, maxAgeMs) {
    try {
        const stat = fs.statSync(filePath)
        if (Date.now() - stat.mtimeMs > maxAgeMs) return null
        return fs.readFileSync(filePath, 'utf8')
    } catch {
        return null
    }
}

function readAnyCache(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8')
    } catch {
        return null
    }
}

async function loadTextWithCache(url, cacheFile, options = {}) {
    ensureCacheDir()
    const maxAgeMs = Number(options.maxAgeMs || 6 * 60 * 60 * 1000)
    const cached = readFreshCache(cacheFile, maxAgeMs)
    if (cached !== null) return cached

    try {
        const text = await fetchText(url, options.timeoutMs || 20000)
        fs.writeFileSync(cacheFile, text)
        return text
    } catch (error) {
        const stale = readAnyCache(cacheFile)
        if (stale !== null) return stale
        throw error
    }
}

async function loadCertificateChain() {
    const cacheFile = path.join(CACHE_DIR, 'certificate.json')
    const raw = await loadTextWithCache(
        CERTIFICATE_URL,
        cacheFile,
        { maxAgeMs: 24 * 60 * 60 * 1000, timeoutMs: 20000 }
    )

    try {
        return JSON.parse(raw)
    } catch (error) {
        throw new Error(`Certificate JSON tidak valid: ${error.message}`)
    }
}

async function loadGameHtml(gameKey) {
    const key = ALIAS_TO_GAME.get(String(gameKey || '').toLowerCase().trim())
    if (!key) throw new Error(`Game Rich HTML tidak dikenal: ${gameKey}`)

    const definition = GAME_DEFINITIONS[key]
    let html

    if (definition.local) {
        const localFile = path.join(__dirname, 'richhtml-games', definition.file)
        try {
            html = fs.readFileSync(localFile, 'utf8')
        } catch (error) {
            throw new Error(`File game ${definition.file} tidak ditemukan: ${error.message}`)
        }
    } else {
        const payloadUrl = `https://raw.githubusercontent.com/noxXza/data/refs/heads/main/${definition.file}`
        const cacheFile = path.join(CACHE_DIR, safeName(definition.file))
        html = await loadTextWithCache(
            payloadUrl,
            cacheFile,
            { maxAgeMs: 6 * 60 * 60 * 1000, timeoutMs: 20000 }
        )
    }

    if (!html || !html.trim()) throw new Error(`HTML ${definition.file} kosong`)
    if (Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) {
        throw new Error(`HTML ${definition.file} terlalu besar`)
    }

    return { key, definition, html }
}

function buildEmbeddedRichHtmlMessage({ html, definition }) {
    const title = String(definition?.title || 'Xeryuu Rich Game')
    const responseData = {
        response_id: randomId(),
        sections: [
            {
                __typename: 'GenAIUnifiedResponseSection',
                view_model: {
                    __typename: 'GenAISingleLayoutViewModel',
                    primitive: {
                        __typename: 'GenAIBotProgressStatusPrimitive',
                        title: String(definition?.buttonText || `*${title}*`),
                        is_in_progress: true
                    }
                }
            }
        ],
        embedded_screens: [
            {
                title: String(definition?.screenTitle || title),
                content: [
                    {
                        __typename: 'FOAIDNixelButtonSheets',
                        tabs: [
                            {
                                id: 'tab_0',
                                tab_header: String(definition?.tabHeader || title),
                                sections: [
                                    {
                                        __typename: 'GenAIUnifiedResponseSection',
                                        view_model: {
                                            __typename: 'GenAISingleLayoutViewModel',
                                            primitive: {
                                                __typename: 'GenAIaeacdsnwHtmlPrimitive',
                                                payload: html,
                                                trusted_sources: Array.isArray(definition?.trustedSources)
                                                    ? definition.trustedSources
                                                    : []
                                            }
                                        }
                                    }
                                ],
                                step_entries: []
                            }
                        ]
                    }
                ]
            }
        ]
    }

    return {
        messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            botMetadata: {
                messageDisclaimerText: '',
                richResponseSourcesMetadata: {}
            }
        },
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: 1,
                    unifiedResponse: {
                        data: Buffer.from(JSON.stringify(responseData)).toString('base64')
                    },
                    contextInfo: {
                        stanzaId: randomStanzaId(),
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedAiBotMessageInfo: { botJid: '0@bot' },
                        forwardOrigin: 4
                    }
                }
            }
        }
    }
}

function buildRichHtmlMessage({ html, title, trustedSources, certificateChain, withVerification = true }) {
    const responseData = {
        response_id: randomId(),
        sections: [
            {
                view_model: {
                    primitive: {
                        __typename: 'GenAIaeacdsnwHtmlPrimitive',
                        payload: html,
                        trusted_sources: Array.isArray(trustedSources) ? trustedSources : []
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            }
        ]
    }

    const dataBase64 = Buffer.from(JSON.stringify(responseData)).toString('base64')

    return {
        messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
            botMetadata: withVerification
                ? {
                    messageDisclaimerText: '',
                    botResponseId: randomId(),
                    verificationMetadata: {
                        proofs: [
                            {
                                version: 1,
                                useCase: 'WA_BOT_MSG',
                                signature: 'TklYRUwuTWVzc2FnZUJ1aWxkZXJWNC43LVZlcmlmaWNhdGlvblNpZ25hdHVyZS5NZXRhZGF0YeN55YRyad2+ZA==',
                                certificateChain
                            }
                        ]
                    }
                }
                : {
                    messageDisclaimerText: '',
                    botResponseId: randomId()
                }
        },
        botForwardedMessage: {
            message: {
                richResponseMessage: {
                    messageType: 1,
                    submessages: [
                        {
                            messageType: 2,
                            messageText: String(title || 'Xeryuu Rich HTML Game')
                        }
                    ],
                    unifiedResponse: {
                        data: dataBase64
                    },
                    contextInfo: {
                        stanzaId: randomStanzaId(),
                        forwardingScore: 1,
                        isForwarded: true,
                        forwardedAiBotMessageInfo: {
                            botJid: '867051314767696@bot'
                        },
                        forwardOrigin: 4
                    }
                }
            }
        }
    }
}

async function sendRichHtmlGame(conn, chat, gameKey) {
    if (!conn || typeof conn.relayMessage !== 'function') {
        throw new Error('Koneksi WhatsApp belum siap: relayMessage tidak tersedia')
    }
    if (!chat) throw new Error('Chat ID tidak tersedia')

    const now = Date.now()
    if (!global.__xeryuuRichHtmlCooldown) global.__xeryuuRichHtmlCooldown = new Map()
    const lastSent = Number(global.__xeryuuRichHtmlCooldown.get(chat) || 0)
    if (now - lastSent < 3000) {
        throw new Error('Tunggu 3 detik sebelum membuka game Rich HTML lagi.')
    }

    const { definition, html } = await loadGameHtml(gameKey)
    let certificateChain = null

    // Game hasil port dari FURINA tidak membutuhkan fetch certificate eksternal.
    // Game lama V16 tetap memakai certificate chain seperti sebelumnya.
    if (!definition.local) {
        certificateChain = await loadCertificateChain()
    }

    const message = definition.embeddedScreen
        ? buildEmbeddedRichHtmlMessage({ html, definition })
        : buildRichHtmlMessage({
            html,
            title: definition.title,
            trustedSources: definition.trustedSources,
            certificateChain,
            withVerification: !definition.local
        })

    const routedChat = typeof conn.decodeJid === 'function' ? conn.decodeJid(chat) : jidNormalizedUser(chat)
    let waMessage
    try {
        waMessage = await generateWAMessageFromContent(routedChat, message, { userJid: routedChat })
        await conn.relayMessage(routedChat, waMessage.message, { messageId: waMessage.key.id })
    } catch (error) {
        console.error('[RICHHTML RELAY FALLBACK]', error?.stack || error)
        await conn.relayMessage(routedChat, message, {})
    }
    global.__xeryuuRichHtmlCooldown.set(chat, Date.now())
    return definition.title
}


async function sendRichHtmlDocument(conn, chat, options = {}) {
    if (!conn || typeof conn.relayMessage !== 'function') {
        throw new Error('Koneksi WhatsApp belum siap: relayMessage tidak tersedia')
    }
    if (!chat) throw new Error('Chat ID tidak tersedia')

    const html = String(options.html || '')
    if (!html.trim()) throw new Error('Rich HTML kosong')
    if (Buffer.byteLength(html, 'utf8') > 4 * 1024 * 1024) {
        throw new Error('Rich HTML terlalu besar')
    }

    const cooldownMs = Number(options.cooldownMs || 3000)
    const cooldownKey = String(options.cooldownKey || 'document')
    if (!global.__xeryuuRichHtmlCooldown) global.__xeryuuRichHtmlCooldown = new Map()
    const mapKey = `${cooldownKey}:${chat}`
    const lastSent = Number(global.__xeryuuRichHtmlCooldown.get(mapKey) || 0)
    if (Date.now() - lastSent < cooldownMs) {
        throw new Error('Tunggu 3 detik sebelum membuka Rich HTML lagi.')
    }

    let certificateChain = null
    if (options.withVerification) {
        certificateChain = await loadCertificateChain()
    }

    const message = buildRichHtmlMessage({
        html,
        title: options.title || 'Xeryuu Rich HTML',
        trustedSources: Array.isArray(options.trustedSources) ? options.trustedSources : [],
        certificateChain,
        withVerification: Boolean(options.withVerification)
    })

    const routedChat = typeof conn.decodeJid === 'function' ? conn.decodeJid(chat) : jidNormalizedUser(chat)
    try {
        const waMessage = await generateWAMessageFromContent(routedChat, message, { userJid: routedChat })
        await conn.relayMessage(routedChat, waMessage.message, { messageId: waMessage.key.id })
    } catch (error) {
        console.error('[RICHHTML DOCUMENT RELAY FALLBACK]', error?.stack || error)
        await conn.relayMessage(routedChat, message, {})
    }
    global.__xeryuuRichHtmlCooldown.set(mapKey, Date.now())
    return options.title || 'Xeryuu Rich HTML'
}

function listRichHtmlGames() {
    return Object.entries(GAME_DEFINITIONS).map(([key, definition]) => ({
        key,
        title: definition.title,
        aliases: [...definition.aliases]
    }))
}

module.exports = {
    sendRichHtmlGame,
    sendRichHtmlDocument,
    listRichHtmlGames,
    GAME_DEFINITIONS
}
