'use strict'
const fs = require('fs')
const path = require('path')
const yts = require('yt-search')
const ytdl = require('@vreden/youtube_scraper')
const { sendRichHtmlDocument } = require('./richhtml.js')

const PAGE_DIR = path.join(__dirname, 'richhtml-pages')
const YOUTUBE_PAGE = path.join(PAGE_DIR, 'richyoutube-v16.html')
const TOURL_PAGE = path.join(PAGE_DIR, 'richtourl2-v16.html')
const AUDIO_CACHE_TTL = 90 * 1000
const audioUrlCache = new Map()

function safeJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\\u2028/g, '\\u2028')
        .replace(/\\u2029/g, '\\u2029')
}

function readPage(file) {
    const html = fs.readFileSync(file, 'utf8')
    if (!html.trim()) throw new Error(`Rich page kosong: ${path.basename(file)}`)
    return html
}

function videoIdFromUrl(value) {
    try {
        const u = new URL(String(value || ''))
        const host = u.hostname.toLowerCase().replace(/^www\./, '')
        if (host === 'youtu.be') return (u.pathname.split('/').filter(Boolean)[0] || '').slice(0, 11)
        if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return ''
        const v = u.searchParams.get('v')
        if (v) return v.slice(0, 11)
        const parts = u.pathname.split('/').filter(Boolean)
        const marker = parts.findIndex(x => ['shorts', 'embed', 'live', 'v'].includes(x.toLowerCase()))
        return marker >= 0 ? String(parts[marker + 1] || '').slice(0, 11) : ''
    } catch {
        return ''
    }
}

function normalizeVideo(item) {
    if (!item) return null
    const url = String(item.url || item.link || '')
    const videoId = String(item.videoId || videoIdFromUrl(url) || '')
    const thumbnail = String(
        item.thumbnail || item.image || item.cover || item.thumbnails?.[0]?.url ||
        (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '')
    )
    return {
        title: String(item.title || 'Untitled'),
        url,
        videoId,
        thumbnail,
        channel: String(item.channel || item.author?.name || item.author || 'YouTube'),
        duration: item.timestamp || item.duration?.timestamp || item.duration || '',
        seconds: Number(item.seconds || item.duration?.seconds || 0) || 0,
        views: item.views || 0,
        ago: String(item.ago || ''),
        description: String(item.description || ''),
        audio: String(item.audio || '')
    }
}

async function searchYouTube(query, limit = 8) {
    const q = String(query || '').trim()
    if (!q) throw new Error('Query YouTube kosong')
    const result = await yts(q)
    const all = Array.isArray(result?.all) ? result.all : []
    return all.filter(x => x?.type === 'video' || x?.videoId || x?.url)
        .slice(0, Math.max(1, Math.min(Number(limit) || 8, 10)))
        .map(normalizeVideo)
        .filter(x => x?.url)
}

function timeoutAfter(promise, ms, label) {
    let timer
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout setelah ${Math.ceil(ms / 1000)} detik`)), ms) })
    ]).finally(() => clearTimeout(timer))
}

function validHttpUrl(value) {
    try { const u = new URL(String(value || '')); return ['http:', 'https:'].includes(u.protocol) ? u.href : '' } catch { return '' }
}

async function resolveYouTubeAudio(url) {
    const target = String(url || '').trim()
    if (!/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)\//i.test(target)) {
        throw new Error('URL YouTube tidak valid')
    }

    const cacheKey = videoIdFromUrl(target) || target
    const cached = audioUrlCache.get(cacheKey)
    if (cached && Date.now() - cached.at < AUDIO_CACHE_TTL) return cached.url
    if (cached) audioUrlCache.delete(cacheKey)

    let lastError = null
    // Beberapa provider kadang gagal sementara. Coba ulang dengan timeout agar
    // satu resolver yang hang tidak membuat command menunggu selamanya.
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const result = await timeoutAfter(Promise.resolve().then(() => ytdl.ytmp3(target)), 12000, 'YouTube resolver')
            const candidates = [
                result?.download?.url,
                result?.result?.download?.url,
                result?.data?.download?.url,
                result?.url,
                result?.audio
            ]
            const audio = candidates.map(validHttpUrl).find(Boolean) || ''
            if (audio) {
                cacheAudio(cacheKey, audio)
                return audio
            }
            lastError = new Error(result?.message || result?.error || 'Resolver tidak mengembalikan URL audio valid.')
        } catch (error) {
            lastError = error
        }
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 350 * attempt))
    }

    // Fallback bawaan @distube/ytdl-core. Format langsung dipakai sebagai opsi
    // terakhir; API Rich tetap memvalidasi upstream sebelum mengirim audio ke UI.
    try {
        const core = require('@distube/ytdl-core')
        const info = await timeoutAfter(core.getInfo(target), 15000, 'YouTube ytdl-core')
        const formats = (info?.formats || [])
            .filter(format => format?.url && format.hasAudio && !format.hasVideo)
            // Prefer AAC/MP4 audio: some Android WhatsApp WebViews reject WebM/Opus
            // and report the generic 'no supported source' media error.
            .sort((a, b) => {
                const score = f => (/audio\/mp4/i.test(f.mimeType || '') ? 100000 : 0) + Number(f.audioBitrate || 0)
                return score(b) - score(a)
            })
        const audio = formats.map(format => validHttpUrl(format.url)).find(Boolean) || ''
        if (audio) {
            cacheAudio(cacheKey, audio)
            return audio
        }
    } catch (error) {
        lastError = lastError || error
        console.error('[RICH YOUTUBE DISTUBE FALLBACK]', error?.message || error)
    }
    throw new Error(`Gagal menyiapkan audio YouTube setelah beberapa percobaan: ${lastError?.message || 'sumber audio tidak tersedia'}`)
}

function cacheAudio(cacheKey, audio) {
    if (audioUrlCache.size > 200) {
        for (const [key, value] of audioUrlCache) {
            if (Date.now() - value.at > AUDIO_CACHE_TTL || audioUrlCache.size > 150) audioUrlCache.delete(key)
        }
    }
    audioUrlCache.set(cacheKey, { url: audio, at: Date.now() })
}

function publicApiBase() {
    const raw = String(
        process.env.RICH_API_PUBLIC_URL || global.richApiConfig?.publicUrl || global.richApiUrl || ''
    ).trim()
    if (!raw) return ''
    try {
        const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
        const url = new URL(candidate)
        if (!['http:', 'https:'].includes(url.protocol)) return ''
        url.hash = ''
        url.search = ''
        return url.toString().replace(/\/+$/, '')
    } catch {
        console.error('[RICH API CONFIG] URL publik tidak valid:', raw)
        return ''
    }
}

async function prepareRichYoutubeData(query, results) {
    let list = Array.isArray(results) ? results.map(normalizeVideo).filter(Boolean) : []
    if (!list.length && query) list = await searchYouTube(query, 8)

    // Resolve the first result immediately with the existing ytdl backend so
    // the first track can play even when the API URL is not publicly reachable.
    if (list[0] && !list[0].audio) {
        try {
            list[0].audio = await resolveYouTubeAudio(list[0].url)
        } catch (error) {
            console.error('[RICH YOUTUBE FIRST AUDIO]', error?.stack || error)
        }
    }

    return {
        query: String(query || ''),
        apiBase: publicApiBase(),
        results: list
    }
}

async function sendRichYoutube(conn, chat, { query = '', results = null } = {}) {
    const data = await prepareRichYoutubeData(query, results)
    if (!data.results.length) throw new Error('Video YouTube tidak ditemukan')

    let html = readPage(YOUTUBE_PAGE)
    html = html.replace('__XERYUU_YOUTUBE_BOOTSTRAP__', safeJson(data))
    return sendRichHtmlDocument(conn, chat, {
        html,
        title: `Xeryuu YouTube • ${data.query || data.results[0].title}`,
        cooldownKey: 'youtube',
        withVerification: false
    })
}

async function sendRichTourl(conn, chat, { url, openUrl = '', mimetype = '', size = '', filename = '', uploadHost = '' } = {}) {
    const target = String(url || '').trim()
    let parsedUrl
    try { parsedUrl = new URL(target) } catch { throw new Error('URL media tidak valid') }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) {
        throw new Error('URL media harus menggunakan HTTP atau HTTPS yang valid')
    }
    let parsedOpenUrl = parsedUrl
    if (String(openUrl || '').trim()) {
        try { parsedOpenUrl = new URL(String(openUrl).trim()) } catch { throw new Error('URL halaman upload tidak valid') }
        if (!['http:', 'https:'].includes(parsedOpenUrl.protocol) || !parsedOpenUrl.hostname) {
            throw new Error('URL halaman upload harus menggunakan HTTP atau HTTPS yang valid')
        }
    }
    const data = {
        url: parsedUrl.toString(),
        openUrl: parsedOpenUrl.toString(),
        mimetype: String(mimetype || 'application/octet-stream').split(';')[0].trim().toLowerCase(),
        size: String(size || ''),
        filename: String(filename || 'file'),
        uploadHost: String(uploadHost || 'Penyedia upload')
    }
    let html = readPage(TOURL_PAGE)
    html = html.replace('__XERYUU_TOURL_BOOTSTRAP__', safeJson(data))
    return sendRichHtmlDocument(conn, chat, {
        html,
        title: 'Xeryuu Rich URL Preview',
        cooldownKey: 'tourl2',
        withVerification: false
    })
}

module.exports = {
    searchYouTube,
    resolveYouTubeAudio,
    sendRichYoutube,
    sendRichTourl,
    publicApiBase
}
