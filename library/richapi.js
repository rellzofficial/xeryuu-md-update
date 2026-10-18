'use strict'

const http = require('http')
const { URL } = require('url')
const { Readable } = require('stream')
const fetch = global.fetch || require('node-fetch')
const { searchYouTube, resolveYouTubeAudio, publicApiBase } = require('./richmedia.js')
const { resolveSpotify, searchSpotify } = require('./richspotify.js')

let server = null
const rateMap = new Map()
const thumbnailCache = new Map()
const thumbnailInflight = new Map()
const WINDOW_MS = 60 * 1000
// Rich YouTube renders several images at once and may reload them when tracks change.
// A small global per-IP quota made the thumbnail/player endpoints hit HTTP 429 too quickly.
const MAX_REQ = 120
const MAX_RATE_KEYS = 10000
const THUMB_CACHE_MS = 6 * 60 * 60 * 1000
const MAX_THUMB_CACHE = 180

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...options, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

function json(res, status, data) {
    const body = JSON.stringify(data)
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Range',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body)
    })
    res.end(body)
}

function allowed(req) {
    const ip = String(req.socket?.remoteAddress || 'unknown')
    const now = Date.now()
    const item = rateMap.get(ip)
    if (rateMap.size > MAX_RATE_KEYS) {
        for (const [key, value] of rateMap) {
            if (now - value.started > WINDOW_MS) rateMap.delete(key)
            if (rateMap.size <= MAX_RATE_KEYS) break
        }
    }
    if (!item || now - item.started > WINDOW_MS) {
        rateMap.set(ip, { started: now, count: 1 })
        return true
    }
    item.count++
    return item.count <= MAX_REQ
}

function videoIdFromUrl(value) {
    try {
        const u = new URL(String(value || ''))
        if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname)) return ''
        if (u.hostname.toLowerCase() === 'youtu.be') return (u.pathname.split('/').filter(Boolean)[0] || '').slice(0, 11)
        const v = u.searchParams.get('v')
        if (v) return v.slice(0, 11)
        const parts = u.pathname.split('/').filter(Boolean)
        const idx = parts.findIndex(x => ['shorts', 'embed', 'live'].includes(x.toLowerCase()))
        return idx >= 0 ? String(parts[idx + 1] || '').slice(0, 11) : ''
    } catch {
        return ''
    }
}

function streamHeaders(upstream, fallbackType = 'audio/mpeg') {
    const type = String(upstream.headers.get('content-type') || '').trim().toLowerCase()
    return {
        'Content-Type': type && type !== 'application/octet-stream' ? type : fallbackType,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Range',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range'
    }
}

async function handleImage(req, res, u) {
    const id = String(u.searchParams.get('id') || '').trim()
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { error: 'Video ID YouTube tidak valid' })

    const now = Date.now()
    const cached = thumbnailCache.get(id)
    if (cached && now - cached.at < THUMB_CACHE_MS) {
        res.writeHead(200, {
            'Content-Type': cached.type,
            'Content-Length': cached.body.length,
            'Cache-Control': 'public, max-age=21600, stale-while-revalidate=86400',
            'Access-Control-Allow-Origin': '*',
            'X-Rich-Thumbnail-Cache': 'HIT'
        })
        res.end(cached.body)
        return
    }
    if (cached) thumbnailCache.delete(id)

    // De-duplicate simultaneous fetches: list and hero often request the same image.
    let pending = thumbnailInflight.get(id)
    if (!pending) {
        pending = (async () => {
            const candidates = [
                `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
                `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
                `https://i.ytimg.com/vi/${id}/default.jpg`
            ]
            let lastError = null
            for (const imageUrl of candidates) {
                try {
                    const upstream = await fetchWithTimeout(imageUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 Xeryuu-Rich' },
                        redirect: 'follow'
                    }, 10000)
                    if (!upstream.ok || !upstream.body) {
                        lastError = new Error(`Thumbnail upstream HTTP ${upstream.status}`)
                        continue
                    }
                    const body = Buffer.from(await upstream.arrayBuffer())
                    const type = String(upstream.headers.get('content-type') || 'image/jpeg').split(';')[0]
                    if (!body.length || !type.startsWith('image/')) {
                        lastError = new Error('Thumbnail upstream mengembalikan data kosong/bukan gambar')
                        continue
                    }
                    const image = { body, type, at: Date.now() }
                    if (thumbnailCache.size >= MAX_THUMB_CACHE) {
                        const oldest = thumbnailCache.keys().next().value
                        if (oldest) thumbnailCache.delete(oldest)
                    }
                    thumbnailCache.set(id, image)
                    return image
                } catch (error) {
                    lastError = error
                }
            }
            throw lastError || new Error('Thumbnail tidak tersedia')
        })()
        thumbnailInflight.set(id, pending)
    }

    try {
        const image = await pending
        res.writeHead(200, {
            'Content-Type': image.type,
            'Content-Length': image.body.length,
            'Cache-Control': 'public, max-age=21600, stale-while-revalidate=86400',
            'Access-Control-Allow-Origin': '*',
            'X-Rich-Thumbnail-Cache': 'MISS'
        })
        res.end(image.body)
    } catch (error) {
        console.error('[RICH API THUMB]', error?.message || error)
        return json(res, 502, { error: 'Thumbnail YouTube tidak dapat diambil; player akan mencoba sumber alternatif.' })
    } finally {
        thumbnailInflight.delete(id)
    }
}

async function handleAudio(req, res, u) {
    const target = String(u.searchParams.get('url') || '').trim()
    if (!target) return json(res, 400, { error: 'Parameter url wajib diisi' })
    if (!/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(target)) {
        return json(res, 400, { error: 'URL YouTube tidak valid' })
    }

    // Some resolver providers return a URL that later serves an HTML error page
    // instead of audio. Never pass that page to <audio>; try a fresh YouTube
    // audio-only format from @distube/ytdl-core before failing.
    const range = String(req.headers.range || '').trim()
    const requestHeaders = { 'User-Agent': 'Mozilla/5.0 Xeryuu-Rich AudioProxy' }
    if (range) requestHeaders.Range = range
    const candidates = []
    let resolverError = null

    try {
        const audioUrl = await resolveYouTubeAudio(target)
        if (audioUrl) candidates.push({ url: audioUrl, type: '', source: 'resolver' })
    } catch (error) {
        resolverError = error
        console.error('[RICH API AUDIO RESOLVER]', error?.message || error)
    }

    let fallbackFormats = null
    let fallbackLoaded = false
    for (let attempt = 0; attempt < 2; attempt++) {
        if (!fallbackLoaded && (attempt === 1 || candidates.length === 0)) {
            fallbackLoaded = true
            try {
                const ytdlCore = require('@distube/ytdl-core')
                const info = await ytdlCore.getInfo(target)
                fallbackFormats = (info.formats || [])
                    .filter(f => f && f.url && f.hasAudio && !f.hasVideo)
                    // AAC in MP4 is more compatible with embedded Android WebViews
                    // than WebM/Opus, which can trigger 'no supported source'.
                    .sort((a, b) => {
                        const score = f => (/audio\/mp4/i.test(f.mimeType || '') ? 100000 : 0) + Number(f.audioBitrate || 0)
                        return score(b) - score(a)
                    })
                for (const format of fallbackFormats) {
                    if (!candidates.some(c => c.url === format.url)) {
                        candidates.push({
                            url: format.url,
                            type: String(format.mimeType || 'audio/mp4').split(';')[0].trim() || 'audio/mp4',
                            source: 'ytdl-core'
                        })
                    }
                }
            } catch (error) {
                resolverError = resolverError || error
                console.error('[RICH API AUDIO FALLBACK]', error?.message || error)
            }
        }

        while (candidates.length) {
            const candidate = candidates.shift()
            let upstream
            try {
                upstream = await fetchWithTimeout(candidate.url, {
                    headers: requestHeaders,
                    redirect: 'follow'
                }, 20000)
            } catch (error) {
                resolverError = error
                continue
            }

            const contentType = String(upstream.headers.get('content-type') || '').toLowerCase()
            const looksLikeErrorPage = /text\/html|application\/json|text\/plain|xml/.test(contentType)
            const unknownResolverType = candidate.source === 'resolver' && (!contentType || contentType === 'application/octet-stream')
            if (!upstream.ok || !upstream.body || looksLikeErrorPage || unknownResolverType) {
                resolverError = new Error(`Sumber audio tidak valid (HTTP ${upstream.status}, ${contentType || 'content-type kosong'})`)
                try { await upstream.body?.cancel() } catch {}
                continue
            }

            const actualType = contentType && contentType !== 'application/octet-stream'
                ? contentType
                : candidate.type
            const outHeaders = streamHeaders({
                headers: {
                    get(name) {
                        if (String(name).toLowerCase() === 'content-type') return actualType
                        return upstream.headers.get(name)
                    }
                }
            }, actualType || 'audio/mpeg')
            const length = upstream.headers.get('content-length')
            const contentRange = upstream.headers.get('content-range')
            if (length) outHeaders['Content-Length'] = length
            if (contentRange) outHeaders['Content-Range'] = contentRange

            res.writeHead(upstream.status === 206 ? 206 : 200, outHeaders)
            const stream = typeof upstream.body.getReader === 'function'
                ? Readable.fromWeb(upstream.body)
                : upstream.body
            stream.on('error', error => {
                console.error('[RICH API AUDIO STREAM]', error?.message || error)
                try { res.destroy(error) } catch {}
            })
            stream.pipe(res)
            return
        }

        // The first pass attempts the configured resolver; the second pass
        // refreshes the native YouTube audio-only URLs if necessary.
        if (attempt === 0 && candidates.length === 0) continue
    }

    return json(res, 502, {
        error: resolverError?.message || 'Tidak menemukan sumber audio yang didukung. Periksa resolver YouTube/API.'
    })
}

async function handle(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Accept, Range',
            'Access-Control-Max-Age': '86400'
        })
        return res.end()
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' })

    let u
    try { u = new URL(req.url, 'http://127.0.0.1') } catch { return json(res, 400, { error: 'Invalid URL' }) }

    // Health and thumbnail GETs are cached / read-only. Do not let them consume
    // the same quota as audio resolution and searches.
    const lightRoutes = new Set(['/api/rich/health', '/api/rich/youtube/thumb'])
    if (!lightRoutes.has(u.pathname) && !allowed(req)) {
        res.setHeader('Retry-After', '60')
        return json(res, 429, { error: 'Rate limit exceeded. Coba lagi sekitar satu menit.' })
    }

    try {
        if (u.pathname === '/api/rich/health') return json(res, 200, { ok: true, service: 'xeryuu-rich-api' })
        if (u.pathname === '/api/rich/youtube/search') {
            const q = String(u.searchParams.get('q') || '').trim()
            const limit = Number(u.searchParams.get('limit') || 8)
            if (!q) return json(res, 400, { error: 'Parameter q wajib diisi' })
            const results = await searchYouTube(q, Math.min(Math.max(limit, 1), 10))
            return json(res, 200, { ok: true, query: q, results })
        }
        if (u.pathname === '/api/rich/youtube/resolve') {
            const target = String(u.searchParams.get('url') || '').trim()
            if (!target) return json(res, 400, { error: 'Parameter url wajib diisi' })
            const audio = await resolveYouTubeAudio(target)
            const base = publicApiBase()
            const stream = base ? `${base}/api/rich/youtube/stream?url=${encodeURIComponent(target)}` : ''
            return json(res, 200, { ok: true, audio, stream })
        }
        if (u.pathname === '/api/rich/youtube/stream') return handleAudio(req, res, u)
        if (u.pathname === '/api/rich/youtube/thumb') return handleImage(req, res, u)
        if (u.pathname === '/api/rich/spotify/resolve') {
            const target = String(u.searchParams.get('url') || '').trim()
            if (!target) return json(res, 400, { error: 'Parameter url wajib diisi' })
            const item = await resolveSpotify(target)
            return json(res, 200, { ok: true, item })
        }
        if (u.pathname === '/api/rich/spotify/search') {
            const q = String(u.searchParams.get('q') || '').trim()
            const limit = Number(u.searchParams.get('limit') || 8)
            if (!q) return json(res, 400, { error: 'Parameter q wajib diisi' })
            const results = await searchSpotify(q, Math.min(Math.max(limit, 1), 10))
            return json(res, 200, { ok: true, query: q, results })
        }
        return json(res, 404, { error: 'Not found' })
    } catch (error) {
        console.error('[RICH API]', error?.stack || error)
        if (!res.headersSent) return json(res, 500, { error: error?.message || 'Internal server error' })
        try { res.destroy(error) } catch {}
    }
}

function startRichApiServer(options = {}) {
    if (server) return server
    const port = Number(options.port || global.richApiConfig?.port || 3001)
    const host = String(options.host || global.richApiConfig?.host || '0.0.0.0')
    server = http.createServer((req, res) => {
        handle(req, res).catch(err => {
            console.error('[RICH API HANDLE]', err?.stack || err)
            if (!res.headersSent) json(res, 500, { error: 'Internal server error' })
            else { try { res.destroy(err) } catch {} }
        })
    })
    server.on('error', error => console.error('[RICH API SERVER]', error?.stack || error))
    server.listen(port, host, () => console.log(`[RICH API] listening on ${host}:${port}`))
    return server
}

function stopRichApiServer() {
    if (!server) return
    try { server.close() } catch {}
    server = null
}

module.exports = { startRichApiServer, stopRichApiServer }
