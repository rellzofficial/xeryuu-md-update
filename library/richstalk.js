'use strict'

/*
 * Xeryuu-MD RichStalk V17
 *
 * Prinsip:
 *  - Data hanya ditampilkan bila akun BENAR-BENAR ditemukan dan username-nya cocok.
 *  - Akun tidak ada  -> NOT_FOUND  ("tidak ditemukan")
 *  - Server sumber memblokir / gagal -> BLOCKED / NETWORK (BUKAN "tidak ditemukan")
 *  - Foto profil diunduh oleh bot lalu ditanam sebagai data URI, jadi tidak
 *    bergantung pada akses internet / hotlink dari dalam rich message WhatsApp.
 */

const fs = require('fs')
const path = require('path')
const fetch = require('node-fetch')
const { sendRichHtmlDocument } = require('./richhtml.js')

let yts = null
try { yts = require('yt-search') } catch {}
let sharp = null
try { sharp = require('sharp') } catch {}

const PAGE_FILE = path.join(__dirname, 'richhtml-pages', 'richstalk-v16.html')
const PLACEHOLDER = '__XERYUU_STALK_BOOTSTRAP__'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const NA = 'Tidak tersedia'
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 200
const resultCache = new Map()

class StalkError extends Error {
    constructor(code, message) {
        super(message)
        this.name = 'StalkError'
        this.code = code
    }
}

/* ------------------------------------------------------------------ */
/* Utilitas teks                                                       */
/* ------------------------------------------------------------------ */

function normalizeInput(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g, '')
        .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
        .trim()
}

function firstToken(value) {
    return normalizeInput(value).split(/\s+/)[0] || ''
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safeJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeHtml(value) {
    return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === '#') {
            const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
            if (Number.isFinite(code) && code > 0 && code <= 0x10FFFF) {
                try { return String.fromCodePoint(code) } catch {}
            }
            return match
        }
        const known = NAMED_ENTITIES[entity.toLowerCase()]
        return known === undefined ? match : known
    }).trim()
}

function htmlToText(fragment) {
    const stripped = String(fragment || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
    return decodeHtml(stripped)
        .replace(/[ \t\u00a0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim()
}

// Parser meta yang memahami tanda kutip: apostrof di dalam content="..." tidak memotong teks.
function meta(html, name) {
    const wanted = String(name).toLowerCase()
    const tags = String(html || '').match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || []
    for (const tag of tags) {
        const key = /(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
        if (!key || String(key[1] ?? key[2] ?? '').toLowerCase() !== wanted) continue
        const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
        if (content) return decodeHtml(content[1] ?? content[2] ?? '')
    }
    return ''
}

function fmtInt(value) {
    if (value === undefined || value === null || value === '') return ''
    const n = Number(value)
    return Number.isFinite(n) ? new Intl.NumberFormat('id-ID').format(n) : ''
}

function numOr(value) {
    return fmtInt(value) || (value === undefined || value === null || value === '' ? NA : String(value))
}

function fmtDate(value) {
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' })
}

function hostOf(url) {
    try { return new URL(url).hostname } catch { return 'server sumber' }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function request(url, { timeoutMs = 15000, headers = {}, method = 'GET', body, binary = false } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, {
            method,
            body,
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'user-agent': DESKTOP_UA,
                'accept-language': 'en-US,en;q=0.9,id;q=0.8',
                ...headers
            }
        })
        let payload
        if (binary) {
            payload = typeof res.buffer === 'function' ? await res.buffer() : Buffer.from(await res.arrayBuffer())
        } else {
            payload = await res.text()
        }
        return { status: res.status, ok: res.ok, url: String(res.url || url), headers: res.headers, [binary ? 'buffer' : 'text']: payload }
    } catch (error) {
        if (error instanceof StalkError) throw error
        if (error?.name === 'AbortError') {
            throw new StalkError('NETWORK', `${hostOf(url)} tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik.`)
        }
        throw new StalkError('NETWORK', `Tidak bisa menghubungi ${hostOf(url)} (${error?.code || error?.message || 'network error'}).`)
    } finally {
        clearTimeout(timer)
    }
}

async function requestJson(url, options = {}) {
    const res = await request(url, { ...options, headers: { accept: 'application/json,text/plain,*/*', ...(options.headers || {}) } })
    let json = null
    try { json = JSON.parse(res.text) } catch {}
    return { status: res.status, ok: res.ok, json, text: res.text }
}

/* ------------------------------------------------------------------ */
/* Foto profil -> data URI                                             */
/* ------------------------------------------------------------------ */

function sniffImage(buf) {
    if (!buf || buf.length < 12) return ''
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
    if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png'
    if (buf.toString('latin1', 0, 3) === 'GIF') return 'image/gif'
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
    return ''
}

async function toAvatarDataUri(buffer) {
    const mime = sniffImage(buffer)
    if (!mime) return ''
    if (sharp) {
        try {
            const info = await sharp(buffer, { failOn: 'none' }).metadata()
            const pipeline = sharp(buffer, { failOn: 'none' }).rotate().resize(360, 360, { fit: 'cover' })
            if (info.hasAlpha) {
                const out = await pipeline.png({ compressionLevel: 9 }).toBuffer()
                return `data:image/png;base64,${out.toString('base64')}`
            }
            const out = await pipeline.jpeg({ quality: 84 }).toBuffer()
            return `data:image/jpeg;base64,${out.toString('base64')}`
        } catch {}
    }
    if (buffer.length <= 700 * 1024) return `data:${mime};base64,${buffer.toString('base64')}`
    return ''
}

async function downloadAvatar(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return ''
    try {
        const res = await request(url, {
            binary: true,
            timeoutMs: 12000,
            headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5' }
        })
        if (!res.ok || !res.buffer?.length || res.buffer.length > 8 * 1024 * 1024) return ''
        return await toAvatarDataUri(res.buffer)
    } catch {
        return ''
    }
}

async function attachAvatar(data) {
    const candidates = [...new Set((data.avatarCandidates || []).filter(Boolean))].slice(0, 4)
    delete data.avatarCandidates
    data.avatar = ''
    for (const url of candidates) {
        const uri = await downloadAvatar(url)
        if (uri) { data.avatar = uri; break }
    }
    return data
}

/* ------------------------------------------------------------------ */
/* Parsing input                                                       */
/* ------------------------------------------------------------------ */

function parseLink(raw) {
    let candidate = String(raw || '')
    if (!/^https?:\/\//i.test(candidate) && /^(?:[\w-]+\.)+[a-z]{2,}\//i.test(candidate)) candidate = `https://${candidate}`
    if (!/^https?:\/\//i.test(candidate)) return null
    try {
        const url = new URL(candidate)
        const host = url.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '')
        const parts = url.pathname.split('/').filter(Boolean).map(part => {
            try { return decodeURIComponent(part) } catch { return part }
        })
        return { host, parts }
    } catch {
        throw new StalkError('INVALID', 'Link yang dikirim tidak valid.')
    }
}

function stripToken(value) {
    return firstToken(value).replace(/^[<"'“‘(\[]+|[>"'”’)\],;]+$/g, '')
}

function cleanUsername(value, platform = '') {
    const raw = stripToken(value)
    const link = parseLink(raw)
    if (link) {
        const first = link.parts[0] || ''
        if (platform === 'instagram') {
            if (link.host !== 'instagram.com') throw new StalkError('INVALID', 'Link harus berasal dari instagram.com.')
            if (['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(first.toLowerCase())) {
                throw new StalkError('INVALID', 'Itu link postingan/story. Kirim username atau link profil Instagram.')
            }
            return first.replace(/^@+/, '')
        }
        if (platform === 'tiktok') {
            if (!/(?:^|\.)tiktok\.com$/.test(link.host) || !first.startsWith('@')) {
                throw new StalkError('INVALID', 'Kirim username TikTok atau link profil berformat tiktok.com/@username (link pendek tidak didukung).')
            }
            return first.replace(/^@+/, '')
        }
        if (platform === 'telegram') {
            if (!['t.me', 'telegram.me', 'telegram.dog'].includes(link.host)) throw new StalkError('INVALID', 'Link harus berasal dari t.me.')
            const name = first === 's' ? (link.parts[1] || '') : first
            if (!name || name.startsWith('+') || name.toLowerCase() === 'joinchat') {
                throw new StalkError('INVALID', 'Link undangan privat tidak bisa diperiksa. Kirim username publik.')
            }
            return name.replace(/^@+/, '')
        }
        return first.replace(/^@+/, '')
    }
    return raw.replace(/^@+/, '').split(/[/?#]/)[0]
}

/* ------------------------------------------------------------------ */
/* TikTok                                                              */
/* ------------------------------------------------------------------ */

function extractJsonScript(html, id) {
    const re = new RegExp(`<script[^>]+id=["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)</script>`, 'i')
    const raw = re.exec(html)?.[1]
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
}

function normalizeTikTok(u = {}, s = {}) {
    const pick = (...keys) => { for (const key of keys) if (u[key] !== undefined && u[key] !== null && u[key] !== '') return u[key]; return '' }
    const stat = (...keys) => { for (const key of keys) if (s[key] !== undefined && s[key] !== null && s[key] !== '') return s[key]; return undefined }
    return {
        uniqueId: String(pick('uniqueId', 'unique_id')),
        nickname: String(pick('nickname')),
        signature: String(pick('signature')),
        verified: Boolean(pick('verified')),
        privateAccount: Boolean(pick('privateAccount', 'private_account')),
        createTime: Number(pick('createTime', 'create_time')) || 0,
        region: String(pick('region')),
        avatars: [pick('avatarLarger', 'avatar_larger'), pick('avatarMedium', 'avatar_medium'), pick('avatarThumb', 'avatar_thumb'), pick('avatar')].filter(Boolean).map(String),
        followers: stat('followerCount', 'follower_count'),
        following: stat('followingCount', 'following_count'),
        likes: stat('heartCount', 'heart_count', 'heart', 'diggCount'),
        videos: stat('videoCount', 'video_count', 'aweme_count')
    }
}

async function tiktokFromPage(user) {
    const res = await request(`https://www.tiktok.com/@${encodeURIComponent(user)}`, {
        headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    })
    if (res.status === 404) throw new StalkError('NOT_FOUND', `Akun TikTok @${user} tidak ditemukan.`)
    if (!res.ok) throw new StalkError('BLOCKED', `TikTok membalas HTTP ${res.status}.`)
    const data = extractJsonScript(res.text, '__UNIVERSAL_DATA_FOR_REHYDRATION__')
    const detail = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']
    if (!detail) throw new StalkError('BLOCKED', 'TikTok menampilkan halaman verifikasi ke server bot.')
    const info = detail.userInfo
    if (!info?.user) {
        if ([10221, 10202, 10201].includes(Number(detail.statusCode))) throw new StalkError('NOT_FOUND', `Akun TikTok @${user} tidak ditemukan.`)
        throw new StalkError('BLOCKED', `TikTok tidak mengembalikan data profil (status ${detail.statusCode ?? 'tidak diketahui'}).`)
    }
    return normalizeTikTok(info.user, info.stats || {})
}

async function tiktokFromTikwm(user) {
    const res = await requestJson(`https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(user)}`)
    if (!res.json) throw new StalkError('BLOCKED', 'Provider cadangan TikTok tidak memberi respons yang valid.')
    if (Number(res.json.code) !== 0 || !res.json.data?.user) {
        const message = String(res.json.msg || '')
        if (/not\s+exist|does\s+not\s+exist|not\s+found|unique\s*id/i.test(message)) {
            throw new StalkError('NOT_FOUND', `Akun TikTok @${user} tidak ditemukan.`)
        }
        throw new StalkError('BLOCKED', `Provider cadangan TikTok menolak permintaan${message ? ` (${message})` : ''}.`)
    }
    return normalizeTikTok(res.json.data.user, res.json.data.stats || {})
}

async function stalkTikTok(input) {
    const user = cleanUsername(input, 'tiktok')
    if (!/^[A-Za-z0-9._]{2,24}$/.test(user)) throw new StalkError('INVALID', 'Username TikTok tidak valid (2–24 karakter: huruf, angka, titik, underscore).')

    let profile = null
    const problems = []
    for (const source of [tiktokFromPage, tiktokFromTikwm]) {
        try {
            const result = await source(user)
            if (result.uniqueId && result.uniqueId.toLowerCase() !== user.toLowerCase()) {
                problems.push('username hasil tidak cocok dengan yang dicari')
                continue
            }
            profile = result
            break
        } catch (error) {
            if (error?.code === 'NOT_FOUND') throw error
            problems.push(error?.message || 'gagal')
        }
    }
    if (!profile) throw new StalkError('BLOCKED', `TikTok tidak bisa dibaca dari server bot saat ini (${problems.join('; ')}).`)

    const stats = [
        ['Followers', numOr(profile.followers)],
        ['Following', numOr(profile.following)],
        ['Likes', numOr(profile.likes)],
        ['Videos', numOr(profile.videos)]
    ]
    if (profile.createTime) stats.push(['Akun dibuat', fmtDate(profile.createTime) || NA])
    if (profile.region) stats.push(['Wilayah', profile.region])

    const handle = profile.uniqueId || user
    return {
        platform: 'tiktok', platformName: 'TikTok', username: handle,
        displayName: profile.nickname || handle,
        verified: profile.verified,
        badges: profile.privateAccount ? ['Akun privat'] : [],
        avatarCandidates: profile.avatars,
        bio: profile.signature || 'Tidak ada bio.',
        stats,
        url: `https://www.tiktok.com/@${handle}`,
        note: 'Data diambil dari halaman profil publik TikTok dan sudah dicocokkan dengan username yang dicari.'
    }
}

/* ------------------------------------------------------------------ */
/* Instagram                                                           */
/* ------------------------------------------------------------------ */

function instagramCookie() {
    const raw = String(global.stalkConfig?.instagramCookie || '').trim()
    if (!raw) return ''
    return raw.includes('=') ? raw : `sessionid=${raw}`
}

async function instagramFromApi(user) {
    const cookie = instagramCookie()
    const res = await requestJson(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(user)}`, {
        headers: {
            'x-ig-app-id': '936619743392459',
            'x-requested-with': 'XMLHttpRequest',
            accept: '*/*',
            referer: `https://www.instagram.com/${user}/`,
            ...(cookie ? { cookie } : {})
        }
    })
    if (res.status === 404) throw new StalkError('NOT_FOUND', `Akun Instagram @${user} tidak ditemukan.`)
    if (!res.json) throw new StalkError('BLOCKED', `Instagram meminta login (HTTP ${res.status}).`)
    if (res.ok && res.json?.data && res.json.data.user === null) throw new StalkError('NOT_FOUND', `Akun Instagram @${user} tidak ditemukan.`)
    const u = res.json?.data?.user
    if (!u) throw new StalkError('BLOCKED', `Instagram menolak permintaan dari server bot (HTTP ${res.status}).`)
    if (String(u.username || '').toLowerCase() !== user.toLowerCase()) throw new StalkError('BLOCKED', 'Username hasil Instagram tidak cocok dengan yang dicari.')
    return {
        username: String(u.username),
        fullName: String(u.full_name || ''),
        bio: String(u.biography || ''),
        verified: Boolean(u.is_verified),
        isPrivate: Boolean(u.is_private),
        isBusiness: Boolean(u.is_business_account || u.is_professional_account),
        category: String(u.category_name || ''),
        externalUrl: String(u.external_url || ''),
        avatars: [u.profile_pic_url_hd, u.profile_pic_url].filter(Boolean).map(String),
        followers: u.edge_followed_by?.count,
        following: u.edge_follow?.count,
        posts: u.edge_owner_to_timeline_media?.count,
        exact: true
    }
}

function parseInstagramOgDescription(description) {
    const count = '([\\d.,]+\\s?[KkMmBb]?(?:rb|jt|m)?)'
    const re = new RegExp(`${count}\\s+(?:Followers?|Pengikut),\\s*${count}\\s+(?:Following|Mengikuti),\\s*${count}\\s+(?:Posts?|Postingan)`, 'i')
    const m = re.exec(description)
    const bio = /on Instagram:\s*["“]([\s\S]*)["”]\s*$/i.exec(description)?.[1] || ''
    return { followers: m?.[1], following: m?.[2], posts: m?.[3], bio: decodeHtml(bio) }
}

async function instagramFromHtml(user) {
    const cookie = instagramCookie()
    const res = await request(`https://www.instagram.com/${encodeURIComponent(user)}/`, {
        headers: { accept: 'text/html,application/xhtml+xml', ...(cookie ? { cookie } : {}) }
    })
    if (res.status === 404) throw new StalkError('NOT_FOUND', `Akun Instagram @${user} tidak ditemukan.`)
    if (!res.ok) throw new StalkError('BLOCKED', `Instagram membalas HTTP ${res.status}.`)
    const title = meta(res.text, 'og:title')
    const description = meta(res.text, 'og:description')
    const handle = /\(@([A-Za-z0-9._]+)\)/.exec(title)?.[1]
    if (!handle) throw new StalkError('BLOCKED', 'Instagram menampilkan halaman login, data profil tidak terbaca.')
    if (handle.toLowerCase() !== user.toLowerCase()) throw new StalkError('BLOCKED', 'Username hasil Instagram tidak cocok dengan yang dicari.')
    const counts = parseInstagramOgDescription(description)
    return {
        username: handle,
        fullName: title.replace(/\s*\(@[^)]*\).*$/s, '').trim(),
        bio: counts.bio,
        verified: false,
        isPrivate: false,
        isBusiness: false,
        category: '',
        externalUrl: '',
        avatars: [meta(res.text, 'og:image')].filter(Boolean),
        followers: counts.followers,
        following: counts.following,
        posts: counts.posts,
        exact: false
    }
}

async function stalkInstagram(input) {
    const user = cleanUsername(input, 'instagram')
    if (!/^(?!.*\.\.)[A-Za-z0-9._]{1,30}$/.test(user)) throw new StalkError('INVALID', 'Username Instagram tidak valid (maks 30 karakter: huruf, angka, titik, underscore).')

    let profile = null
    const problems = []
    for (const source of [instagramFromApi, instagramFromHtml]) {
        try {
            profile = await source(user)
            break
        } catch (error) {
            if (error?.code === 'NOT_FOUND') throw error
            problems.push(error?.message || 'gagal')
        }
    }
    if (!profile) {
        throw new StalkError('BLOCKED', `Instagram membatasi akses dari server bot (${problems.join('; ')}). Isi global.stalkConfig.instagramCookie di settings.js bila sering terjadi.`)
    }

    const stats = [
        ['Followers', profile.exact ? numOr(profile.followers) : (profile.followers || NA)],
        ['Following', profile.exact ? numOr(profile.following) : (profile.following || NA)],
        ['Posts', profile.exact ? numOr(profile.posts) : (profile.posts || NA)]
    ]
    if (profile.exact) stats.push(['Tipe akun', profile.isPrivate ? 'Privat' : 'Publik'])
    if (profile.category) stats.push(['Kategori', profile.category])
    if (profile.externalUrl) stats.push(['Link bio', profile.externalUrl.replace(/^https?:\/\//i, '').slice(0, 40)])

    const badges = []
    if (profile.isPrivate) badges.push('Akun privat')
    if (profile.isBusiness) badges.push('Akun bisnis')
    return {
        platform: 'instagram', platformName: 'Instagram', username: profile.username,
        displayName: profile.fullName || profile.username,
        verified: profile.verified,
        badges,
        avatarCandidates: profile.avatars,
        bio: profile.bio || (profile.exact ? 'Tidak ada bio.' : 'Bio tidak tersedia dari sumber ini.'),
        stats,
        url: `https://www.instagram.com/${profile.username}/`,
        note: profile.exact
            ? 'Data diambil dari profil publik Instagram dan sudah dicocokkan dengan username yang dicari.'
            : 'Instagram membatasi detail profil; jumlah di atas berasal dari metadata publik dan dibulatkan (mis. 1,2M).'
    }
}

/* ------------------------------------------------------------------ */
/* Telegram                                                            */
/* ------------------------------------------------------------------ */

function firstNumber(text) {
    const m = /([\d][\d\s\u00a0\u202f.,]*)/.exec(String(text || ''))
    if (!m) return ''
    return m[1].replace(/[^\d]/g, '')
}

async function stalkTelegram(input) {
    const user = cleanUsername(input, 'telegram')
    if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(user)) throw new StalkError('INVALID', 'Username Telegram tidak valid (5–32 karakter, diawali huruf, hanya huruf/angka/underscore).')

    const res = await request(`https://t.me/${encodeURIComponent(user)}`, { headers: { accept: 'text/html,application/xhtml+xml' } })
    if (res.status === 404) throw new StalkError('NOT_FOUND', `Username Telegram @${user} tidak ditemukan.`)
    if (!res.ok) throw new StalkError('BLOCKED', `Telegram membalas HTTP ${res.status}.`)
    const html = res.text
    if (!/tgme_/.test(html)) throw new StalkError('BLOCKED', 'Format halaman Telegram tidak dikenali / diblokir.')

    const title = htmlToText(/<div class="tgme_page_title[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] || '')
    const extra = htmlToText(/<div class="tgme_page_extra[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] || '')
    const description = htmlToText(/<div class="tgme_page_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1] || '')
    const photo = decodeHtml(/<img[^>]+class="tgme_page_photo_image"[^>]+src="([^"]+)"/i.exec(html)?.[1] || /<img[^>]+src="([^"]+)"[^>]+class="tgme_page_photo_image"/i.exec(html)?.[1] || '')
    const button = htmlToText(/<a[^>]+class="tgme_action_button_new[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1] || '')

    const genericTitle = /^Telegram:\s*(Contact|Join|Launch|View)\b/i.test(title)
    const genericDescription = /you can contact\s+@\S+\s+right away/i.test(description)
    if (!title || genericTitle || (!extra && !photo && (!description || genericDescription))) {
        throw new StalkError('NOT_FOUND', `Username Telegram @${user} tidak ditemukan atau bukan profil publik.`)
    }

    let type = 'User / Bot'
    const stats = [['Username', `@${user}`]]
    if (/subscriber/i.test(extra)) {
        type = 'Channel'
        stats.push(['Subscribers', numOr(firstNumber(extra.split(/subscriber/i)[0]))])
    } else if (/member/i.test(extra)) {
        type = 'Grup'
        stats.push(['Members', numOr(firstNumber(extra.split(/member/i)[0]))])
        const online = /([\d][\d\s\u00a0\u202f.,]*)\s*online/i.exec(extra)?.[1]
        if (online) stats.push(['Online', numOr(firstNumber(online))])
    } else if (/start bot|open bot|launch/i.test(button)) {
        type = 'Bot'
    }
    stats.unshift(['Tipe', type])

    return {
        platform: 'telegram', platformName: 'Telegram', username: `@${user}`,
        displayName: title, verified: false,
        badges: [],
        avatarCandidates: [photo],
        bio: genericDescription ? 'Tidak ada deskripsi publik.' : (description || 'Tidak ada deskripsi publik.'),
        stats,
        url: `https://t.me/${user}`,
        note: 'Hanya profil publik Telegram yang bisa diperiksa (nama, bio, foto, jumlah anggota); chat privat tidak diakses.'
    }
}

/* ------------------------------------------------------------------ */
/* YouTube                                                             */
/* ------------------------------------------------------------------ */

function walkJson(root, visitor, limit = 300000) {
    const stack = [root]
    let seen = 0
    while (stack.length && seen < limit) {
        const node = stack.pop()
        seen += 1
        if (node === null || typeof node !== 'object') continue
        if (visitor(node) === true) return node
        if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]) }
        else { for (const value of Object.values(node)) stack.push(value) }
    }
    return null
}

function parseYtInitialData(html) {
    const m = /ytInitialData\s*=\s*(\{[\s\S]*?\})\s*;\s*<\/script>/.exec(html)
    if (!m) return null
    try { return JSON.parse(m[1]) } catch { return null }
}

function parseYouTubeInput(raw) {
    const text = stripToken(raw) === '' ? '' : normalizeInput(raw)
    if (!text) throw new StalkError('INVALID', 'Masukkan @handle, nama channel, atau link channel YouTube.')
    const link = parseLink(stripToken(text))
    if (link) {
        const isYoutube = link.host === 'youtube.com' || link.host === 'music.youtube.com'
        if (link.host === 'youtu.be' || (isYoutube && ['watch', 'shorts', 'live', 'playlist', 'embed'].includes((link.parts[0] || '').toLowerCase()))) {
            throw new StalkError('INVALID', 'Itu link video/playlist. Kirim @handle atau link channel (youtube.com/@nama).')
        }
        if (!isYoutube) throw new StalkError('INVALID', 'Link harus berasal dari youtube.com.')
        const first = link.parts[0] || ''
        if (first.startsWith('@')) return { kind: 'handle', value: first.slice(1) }
        if (first.toLowerCase() === 'channel' && link.parts[1]) return { kind: 'channel', value: link.parts[1] }
        if (['user', 'c'].includes(first.toLowerCase()) && link.parts[1]) return { kind: first.toLowerCase(), value: link.parts[1] }
        throw new StalkError('INVALID', 'Link channel YouTube tidak dikenali. Gunakan format youtube.com/@nama.')
    }
    const single = stripToken(text)
    if (/^UC[A-Za-z0-9_-]{22}$/.test(single)) return { kind: 'channel', value: single }
    if (text.startsWith('@')) return { kind: 'handle', value: single.replace(/^@+/, '') }
    return { kind: 'name', value: text.replace(/^@+/, '') }
}

function youtubeUrlFor(kind, value) {
    if (kind === 'handle') return `https://www.youtube.com/@${encodeURIComponent(value)}`
    if (kind === 'channel') return `https://www.youtube.com/channel/${encodeURIComponent(value)}`
    return `https://www.youtube.com/${kind}/${encodeURIComponent(value)}`
}

async function fetchYouTubeChannel(url) {
    const res = await request(`${url}${url.includes('?') ? '&' : '?'}hl=en`, {
        headers: { cookie: 'CONSENT=PENDING+987; SOCS=CAI', accept: 'text/html,application/xhtml+xml' }
    })
    if (res.status === 404) throw new StalkError('NOT_FOUND', 'Channel YouTube tidak ditemukan.')
    if (!res.ok) throw new StalkError('BLOCKED', `YouTube membalas HTTP ${res.status}.`)
    if (/consent\.youtube\.com/i.test(res.url)) throw new StalkError('BLOCKED', 'YouTube menampilkan halaman persetujuan cookie ke server bot.')

    const html = res.text
    const data = parseYtInitialData(html)
    const ogTitle = meta(html, 'og:title')
    if (!data && !ogTitle) throw new StalkError('BLOCKED', 'Halaman channel YouTube tidak terbaca.')

    const channelMeta = data ? (walkJson(data, node => node.channelMetadataRenderer && typeof node.channelMetadataRenderer === 'object') || {}).channelMetadataRenderer : null
    const texts = []
    if (data) {
        walkJson(data, node => {
            if (Array.isArray(node.metadataParts)) {
                for (const part of node.metadataParts) {
                    const content = part?.text?.content
                    if (typeof content === 'string' && content.trim()) texts.push(content.trim())
                }
            }
            return false
        })
    }

    const name = String(channelMeta?.title || ogTitle || '').trim()
    if (!name || /^(404|not found)/i.test(name)) throw new StalkError('NOT_FOUND', 'Channel YouTube tidak ditemukan.')

    const subscribersText = texts.find(t => /\b(subscribers?|pelanggan)\b/i.test(t)) || ''
    const videosText = texts.find(t => /\bvideos?\b/i.test(t)) || ''
    const legacySubs = /"subscriberCountText"\s*:\s*\{[^}]*?"simpleText"\s*:\s*"([^"]+)"/.exec(html)?.[1] || ''
    const handle = texts.find(t => /^@[\w.-]+$/.test(t)) || (/"canonicalBaseUrl"\s*:\s*"\/(@[^"]+)"/.exec(html)?.[1] || '')
    const channelId = String(channelMeta?.externalId || /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1] || /"channelId"\s*:\s*"(UC[\w-]{22})"/.exec(html)?.[1] || '')
    const thumbs = Array.isArray(channelMeta?.avatar?.thumbnails) ? channelMeta.avatar.thumbnails.map(t => t?.url).filter(Boolean) : []
    const header = data ? (walkJson(data, node => node.pageHeaderViewModel || node.c4TabbedHeaderRenderer) || {}) : {}
    const headerNode = header.pageHeaderViewModel || header.c4TabbedHeaderRenderer
    const verified = headerNode ? /BADGE_STYLE_TYPE_VERIFIED(?!_ARTIST)|CHECK_CIRCLE_THICK|"VERIFIED"/.test(JSON.stringify(headerNode)) : false

    return {
        name,
        handle,
        channelId,
        description: String(channelMeta?.description || meta(html, 'og:description') || '').trim(),
        subscribers: (subscribersText || legacySubs).replace(/\s*(subscribers?|pelanggan)\s*$/i, '').trim(),
        videos: videosText.replace(/\s*videos?\s*$/i, '').trim(),
        avatars: [meta(html, 'og:image'), ...thumbs.reverse()].filter(Boolean),
        verified,
        url: channelId ? `https://www.youtube.com/channel/${channelId}` : url.replace(/\?.*$/, '')
    }
}

const normalizeName = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]/g, '')

async function stalkYouTube(input) {
    const target = parseYouTubeInput(input)
    let channel = null
    let blocked = null
    const tried = []

    const attempt = async url => {
        tried.push(url)
        try { channel = await fetchYouTubeChannel(url) } catch (error) {
            if (error?.code !== 'NOT_FOUND') blocked = error
        }
    }

    if (target.kind !== 'name') {
        await attempt(youtubeUrlFor(target.kind, target.value))
    } else if (/^[A-Za-z0-9._-]{3,30}$/.test(target.value)) {
        await attempt(youtubeUrlFor('handle', target.value))
    }

    let suggestions = []
    if (!channel && target.kind === 'name' && yts) {
        try {
            const search = await yts({ query: target.value, hl: 'id', gl: 'ID' })
            const list = Array.isArray(search?.channels) ? search.channels : []
            suggestions = list.slice(0, 3).map(item => String(item?.name || '').trim()).filter(Boolean)
            const wanted = normalizeName(target.value)
            const hit = list.find(item => normalizeName(item?.name) === wanted)
            if (hit) await attempt(String(hit.url || hit.link || '').replace('://youtube.com', '://www.youtube.com'))
        } catch {}
    }

    if (!channel) {
        if (blocked) throw new StalkError(blocked.code === 'NETWORK' ? 'NETWORK' : 'BLOCKED', blocked.message)
        const hint = suggestions.length ? ` Mungkin maksud Anda: ${suggestions.join(', ')} (kirim sebagai @handle).` : ''
        throw new StalkError('NOT_FOUND', `Channel YouTube "${target.value}" tidak ditemukan.${hint}`)
    }

    const stats = [
        ['Subscribers', channel.subscribers || NA],
        ['Video', channel.videos || NA]
    ]
    if (channel.handle) stats.push(['Handle', channel.handle])
    if (channel.channelId) stats.push(['Channel ID', channel.channelId])

    return {
        platform: 'youtube', platformName: 'YouTube', username: channel.handle || channel.name,
        displayName: channel.name, verified: channel.verified,
        badges: [],
        avatarCandidates: channel.avatars,
        bio: channel.description || 'Channel ini tidak mencantumkan deskripsi.',
        stats,
        url: channel.url,
        note: 'Data diambil dari halaman channel publik YouTube. Jumlah subscriber ditampilkan YouTube dalam bentuk singkat/dibulatkan.'
    }
}

/* ------------------------------------------------------------------ */
/* Roblox                                                              */
/* ------------------------------------------------------------------ */

function robloxHttpError(res) {
    if (res.status === 429) return new StalkError('BLOCKED', 'Roblox membatasi jumlah permintaan (rate limit). Coba lagi sebentar.')
    return new StalkError('BLOCKED', `Roblox membalas HTTP ${res.status}.`)
}

async function robloxCount(userId, kind) {
    try {
        const res = await requestJson(`https://friends.roblox.com/v1/users/${userId}/${kind}/count`, { timeoutMs: 10000 })
        return res.ok && Number.isFinite(Number(res.json?.count)) ? res.json.count : undefined
    } catch {
        return undefined
    }
}

async function robloxAvatar(userId) {
    const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(userId)}&size=420x420&format=Png&isCircular=false`
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await requestJson(url, { timeoutMs: 10000 })
            const item = res.json?.data?.[0]
            if (item?.state === 'Completed' && item.imageUrl) return String(item.imageUrl)
            if (item?.state !== 'Pending') return ''
        } catch {
            return ''
        }
        await new Promise(resolve => setTimeout(resolve, 1200))
    }
    return ''
}

async function stalkRoblox(input) {
    let token = stripToken(input)
    const link = parseLink(token)
    if (link) {
        if (!/(?:^|\.)roblox\.com$/.test(link.host)) throw new StalkError('INVALID', 'Link harus berasal dari roblox.com.')
        token = link.parts[0]?.toLowerCase() === 'users' ? (link.parts[1] || '') : ''
    }
    token = token.replace(/^@+/, '')
    if (!token) throw new StalkError('INVALID', 'Masukkan username, User ID, atau link profil Roblox.')

    let profile = null
    if (/^\d{1,19}$/.test(token)) {
        const res = await requestJson(`https://users.roblox.com/v1/users/${token}`)
        if (res.status === 200 && res.json?.id) profile = res.json
        else if (![400, 404].includes(res.status)) throw robloxHttpError(res)
    }
    if (!profile) {
        if (!/^[A-Za-z0-9_]{3,20}$/.test(token)) throw new StalkError('INVALID', 'Username Roblox tidak valid (3–20 karakter: huruf, angka, underscore).')
        const lookup = await requestJson('https://users.roblox.com/v1/usernames/users', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ usernames: [token], excludeBannedUsers: false })
        })
        if (!lookup.json) throw robloxHttpError(lookup)
        const hit = lookup.json?.data?.[0]
        if (!hit?.id) throw new StalkError('NOT_FOUND', `User Roblox "${token}" tidak ditemukan.`)
        const detail = await requestJson(`https://users.roblox.com/v1/users/${hit.id}`)
        if (!(detail.status === 200 && detail.json?.id)) throw robloxHttpError(detail)
        profile = detail.json
    }

    const userId = String(profile.id)
    const [friends, followers, followings, avatar] = await Promise.all([
        robloxCount(userId, 'friends'),
        robloxCount(userId, 'followers'),
        robloxCount(userId, 'followings'),
        robloxAvatar(userId)
    ])

    return {
        platform: 'roblox', platformName: 'Roblox', username: String(profile.name || token),
        displayName: String(profile.displayName || profile.name || token),
        verified: Boolean(profile.hasVerifiedBadge),
        badges: profile.isBanned ? ['Banned'] : [],
        avatarCandidates: [avatar],
        bio: String(profile.description || '').trim() || 'Tidak ada deskripsi.',
        stats: [
            ['User ID', userId],
            ['Dibuat', fmtDate(profile.created) || NA],
            ['Teman', numOr(friends)],
            ['Followers', numOr(followers)],
            ['Following', numOr(followings)],
            ['Status', profile.isBanned ? 'Banned' : 'Aktif']
        ],
        url: `https://www.roblox.com/users/${userId}/profile`,
        note: 'Data diambil dari API publik Roblox.'
    }
}

/* ------------------------------------------------------------------ */
/* Mobile Legends                                                      */
/* ------------------------------------------------------------------ */

async function stalkMlbb(input) {
    const parts = normalizeInput(input).split(/[|\s:]+/).filter(Boolean)
    const gameId = String(parts[0] || '')
    const zoneId = String(parts[1] || '')
    if (!/^\d+$/.test(gameId) || !/^\d+$/.test(zoneId)) {
        throw new StalkError('INVALID', 'Format MLBB: .stalkml userId|zoneId  (contoh: .stalkml 134972929|2687)')
    }

    const endpoint = String(global.mlbbStalkConfig?.endpoint || 'https://api.zapi.ink/v1/games:mlbb/profile').trim()
    const apiKey = String(global.mlbbStalkConfig?.apiKey || '').trim()
    if (!apiKey) throw new StalkError('CONFIG', 'MLBB stalk belum dikonfigurasi. Isi global.mlbbStalkConfig.apiKey di settings.js (provider default memerlukan API key).')

    const url = new URL(endpoint)
    url.searchParams.set('gameId', gameId)
    url.searchParams.set('zoneId', zoneId)
    const res = await requestJson(url.toString(), { headers: { 'x-api-key': apiKey } })
    if (res.status === 401 || res.status === 403) throw new StalkError('CONFIG', 'API key MLBB ditolak provider. Periksa global.mlbbStalkConfig.apiKey.')
    if (res.status === 404) throw new StalkError('NOT_FOUND', 'Akun MLBB tidak ditemukan.')
    if (!res.json) throw new StalkError('BLOCKED', `Provider MLBB membalas HTTP ${res.status}.`)
    const d = res.json?.data || res.json
    if (!d || (!d.username && !d.gameId)) throw new StalkError('NOT_FOUND', 'Akun MLBB tidak ditemukan atau provider menolak permintaan.')

    const roles = Array.isArray(d.roles) ? d.roles : []
    const avatar = d.avatar || d.avatarUrl || d.avatar_url || d.profile?.avatar || d.profile?.avatarUrl || d.profile?.avatar_url || d.user?.avatar || d.user?.avatarUrl || d.user?.avatar_url || ''
    return {
        platform: 'mlbb', platformName: 'Mobile Legends', username: String(d.username || NA),
        displayName: String(d.username || 'Mobile Legends'), verified: Boolean(d.verified),
        badges: [],
        avatarCandidates: [String(avatar)],
        bio: roles.length ? roles.map(x => String(x?.name || x?.role || x)).join(' • ') : 'Data rank/role tambahan tidak tersedia dari provider.',
        stats: [['User ID', gameId], ['Zone ID', zoneId], ['Status', d.verified ? 'Terverifikasi provider' : 'Terbaca'], ['Game', 'Mobile Legends (MLBB)']],
        url: 'https://www.mobilelegends.com/',
        note: 'Data diperoleh dari provider stalk MLBB yang dikonfigurasi di bot.'
    }
}

/* ------------------------------------------------------------------ */
/* Router, cache, pengiriman                                           */
/* ------------------------------------------------------------------ */

const HANDLERS = Object.freeze({ youtube: stalkYouTube, instagram: stalkInstagram, tiktok: stalkTikTok, mlbb: stalkMlbb, roblox: stalkRoblox, telegram: stalkTelegram })

function cacheGet(key) {
    const hit = resultCache.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > CACHE_TTL_MS) { resultCache.delete(key); return null }
    return hit.data
}

function cacheSet(key, data) {
    if (resultCache.size >= CACHE_MAX) resultCache.delete(resultCache.keys().next().value)
    resultCache.set(key, { at: Date.now(), data })
}

async function stalk(platform, query) {
    const key = String(platform || '').toLowerCase().trim()
    const handler = HANDLERS[key]
    if (!handler) throw new StalkError('INVALID', `Platform stalk tidak dikenal: ${platform}`)

    const cacheKey = `${key}:${normalizeInput(query).toLowerCase()}`
    const cached = cacheGet(cacheKey)
    if (cached) return cached

    const data = await handler(query)
    await attachAvatar(data)
    cacheSet(cacheKey, data)
    return data
}

function formatStalkError(error, label = 'profil') {
    const message = String(error?.message || '').trim()
    switch (error?.code) {
        case 'NOT_FOUND': return `❌ ${message}`
        case 'INVALID': return `⚠️ ${message}`
        case 'CONFIG': return `⚙️ ${message}`
        case 'BLOCKED':
        case 'NETWORK':
            return `⚠️ Data ${label} belum bisa diambil.\n${message}\n\nIni bukan berarti akunnya tidak ada — server sumber sedang membatasi/gagal merespons. Coba lagi beberapa saat lagi.`
        default:
            return `Gagal mengambil data ${label}.\n${message || 'Terjadi kesalahan yang tidak terduga.'}`
    }
}

function renderPage(data) {
    const template = fs.readFileSync(PAGE_FILE, 'utf8')
    if (!template.includes(PLACEHOLDER)) throw new Error('Template richstalk tidak memiliki placeholder bootstrap.')
    // Pakai fungsi agar karakter "$&", "$'" atau "$$" di bio tidak ditafsirkan oleh String.replace.
    return template.replace(PLACEHOLDER, () => safeJson(data))
}

async function sendRichStalk(conn, chat, platform, query) {
    const data = await stalk(platform, query)
    return sendRichHtmlDocument(conn, chat, {
        html: renderPage(data),
        title: `Xeryuu Stalk • ${data.displayName || data.username}`,
        cooldownKey: `stalk:${platform}`,
        withVerification: false
    })
}

module.exports = {
    stalk, sendRichStalk, formatStalkError, renderPage, StalkError,
    stalkYouTube, stalkInstagram, stalkTikTok, stalkMlbb, stalkRoblox, stalkTelegram,
    _internal: { meta, decodeHtml, cleanUsername, normalizeInput, parseInstagramOgDescription, parseYouTubeInput, toAvatarDataUri, clearCache: () => resultCache.clear() }
}
