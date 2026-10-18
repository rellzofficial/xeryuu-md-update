'use strict'

const fs = require('fs')
const path = require('path')
const fetch = require('node-fetch')
const { sendRichHtmlDocument } = require('./richhtml.js')

const PAGE_FILE = path.join(__dirname, 'richhtml-pages', 'richspotify-v16.html')
let tokenCache = { token: '', expiresAt: 0 }

function config() {
    return global.spotifyConfig || {}
}

function safeJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\\u2028/g, '\\u2028')
        .replace(/\\u2029/g, '\\u2029')
}

function readPage() {
    const html = fs.readFileSync(PAGE_FILE, 'utf8')
    if (!html.trim()) throw new Error('Rich Spotify page kosong')
    return html
}

function toSpotifyWebUrl(value) {
    const raw = String(value || '').trim()
    if (/^spotify:(track|album|playlist|artist|show|episode):[A-Za-z0-9]{10,}$/i.test(raw)) {
        const [, type, id] = raw.match(/^spotify:(track|album|playlist|artist|show|episode):([A-Za-z0-9]{10,})$/i)
        return `https://open.spotify.com/${type.toLowerCase()}/${id}`
    }
    return raw
}

async function normalizeSpotifyUrl(value) {
    const raw = toSpotifyWebUrl(value)
    if (!/^https?:\/\//i.test(raw)) throw new Error('URL Spotify tidak valid')

    const initial = new URL(raw)
    const host = initial.hostname.toLowerCase()
    if (!['open.spotify.com', 'www.open.spotify.com', 'spotify.link', 'www.spotify.link'].includes(host)) {
        throw new Error('URL harus berasal dari Spotify')
    }

    if (host.includes('spotify.link')) {
        const response = await fetch(raw, { redirect: 'follow', headers: { 'User-Agent': 'Xeryuu-Rich/1.0' } })
        const finalUrl = String(response.url || raw)
        if (response.body) response.body.destroy?.()
        return normalizeSpotifyUrl(finalUrl)
    }

    const parts = initial.pathname.split('/').filter(Boolean)
    const localePattern = /^(?:[a-z]{2}(?:-[A-Za-z]{2})?|intl-[a-z]{2})$/i
    if (parts[0] && localePattern.test(parts[0])) parts.shift()
    const type = String(parts[0] || '').toLowerCase()
    const id = String(parts[1] || '').trim()
    const allowedTypes = new Set(['track', 'album', 'playlist', 'artist', 'show', 'episode'])
    if (!allowedTypes.has(type) || !/^[A-Za-z0-9]{10,}$/.test(id)) {
        throw new Error('URL Spotify harus berupa track, album, playlist, artist, show, atau episode yang valid')
    }
    return `https://open.spotify.com/${type}/${id}`
}

async function resolveSpotify(url) {
    const normalized = await normalizeSpotifyUrl(url)
    const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(normalized)}`
    const response = await fetch(endpoint, {
        headers: { Accept: 'application/json', 'User-Agent': 'Xeryuu-Rich/1.0' },
        redirect: 'follow'
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error?.message || `Spotify oEmbed HTTP ${response.status}`)

    const parsed = new URL(normalized)
    const parts = parsed.pathname.split('/').filter(Boolean)
    const type = parts[0]
    const id = parts[1]
    const iframe = `https://open.spotify.com/embed/${type}/${id}?utm_source=xeryuu_rich`

    return {
        url: normalized,
        type,
        id,
        title: String(data?.title || 'Spotify'),
        author: String(data?.author_name || 'Spotify'),
        thumbnail: String(data?.thumbnail_url || ''),
        provider: 'Spotify',
        iframe
    }
}

async function getAccessToken() {
    const cfg = config()
    const clientId = String(cfg.clientId || global.spotifyConfig?.clientId || '').trim()
    const clientSecret = String(cfg.clientSecret || global.spotifyConfig?.clientSecret || '').trim()
    if (!clientId || !clientSecret) throw new Error('SPOTIFY_CLIENT_ID dan SPOTIFY_CLIENT_SECRET belum diatur')

    if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            Authorization: `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data?.access_token) {
        throw new Error(data?.error_description || data?.error || `Spotify token HTTP ${response.status}`)
    }

    tokenCache = {
        token: String(data.access_token),
        expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000
    }
    return tokenCache.token
}

async function spotifyApi(pathname, params = {}) {
    const token = await getAccessToken()
    const url = new URL(`https://api.spotify.com/v1${pathname}`)
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value))
    }

    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
        if (response.status === 401) tokenCache = { token: '', expiresAt: 0 }
        throw new Error(data?.error?.message || `Spotify API HTTP ${response.status}`)
    }
    return data
}

function normalizeSearchResult(item) {
    if (!item) return null
    const type = String(item.type || '').toLowerCase()
    let url = item.external_urls?.spotify || ''
    if (!url && type && item.id) url = `https://open.spotify.com/${type}/${item.id}`
    return {
        type,
        id: String(item.id || ''),
        title: String(item.name || item.show?.name || 'Spotify'),
        subtitle: type === 'track'
            ? (Array.isArray(item.artists) ? item.artists.map(x => x?.name).filter(Boolean).join(', ') : '')
            : type === 'album'
                ? (Array.isArray(item.artists) ? item.artists.map(x => x?.name).filter(Boolean).join(', ') : '')
                : type === 'artist'
                    ? 'Artist'
                    : type === 'playlist'
                        ? String(item.owner?.display_name || 'Playlist')
                        : type,
        thumbnail: String(
            item.album?.images?.[1]?.url ||
            item.images?.[1]?.url ||
            item.images?.[0]?.url ||
            item.album?.images?.[0]?.url ||
            ''
        ),
        url
    }
}

async function searchSpotify(query, limit = 8) {
    const q = String(query || '').trim()
    if (!q) throw new Error('Query Spotify kosong')
    const cfg = config()
    const data = await spotifyApi('/search', {
        q,
        type: 'track,album,artist,playlist',
        limit: Math.min(Math.max(Number(limit) || 8, 1), 10),
        market: String(cfg.market || global.spotifyConfig?.market || 'ID')
    })

    const buckets = ['tracks', 'albums', 'artists', 'playlists']
    return buckets.flatMap(key => Array.isArray(data?.[key]?.items) ? data[key].items.map(normalizeSearchResult) : []).filter(Boolean)
}

async function sendRichSpotify(conn, chat, { url = '', query = '', results = null } = {}) {
    let initial = null
    let list = Array.isArray(results) ? results.filter(Boolean) : []

    if (url) initial = await resolveSpotify(url)
    else if (query) {
        list = await searchSpotify(query, 8)
        if (!list.length) throw new Error('Spotify tidak menemukan hasil')
        initial = await resolveSpotify(list[0].url)
    } else {
        throw new Error('Masukkan link Spotify atau kata pencarian')
    }

    const data = {
        query: String(query || ''),
        apiBase: String(global.richApiConfig?.publicUrl || global.richApiUrl || '').trim().replace(/\/$/, ''),
        item: initial,
        results: list
    }

    let html = readPage().replace('__XERYUU_SPOTIFY_BOOTSTRAP__', safeJson(data))
    return sendRichHtmlDocument(conn, chat, {
        html,
        title: `Xeryuu Spotify • ${initial.title}`,
        cooldownKey: 'spotify',
        withVerification: false
    })
}

module.exports = {
    normalizeSpotifyUrl,
    resolveSpotify,
    searchSpotify,
    sendRichSpotify,
    spotifyApi
}
