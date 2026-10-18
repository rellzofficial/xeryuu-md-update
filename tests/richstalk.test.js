'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const path = require('path')

// ---- Stub dependensi eksternal supaya test tidak butuh internet / baileys ----
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
let routes = {}
let calls = []
const sent = []

function mockFetch(url, options = {}) {
    calls.push(String(url))
    const key = Object.keys(routes).find(k => String(url).toLowerCase().startsWith(k.toLowerCase()))
    const spec = key ? routes[key] : { status: 599, body: 'no route' }
    const res = typeof spec === 'function' ? spec(url, options) : spec
    const body = res.body ?? ''
    return Promise.resolve({
        status: res.status ?? 200,
        ok: (res.status ?? 200) >= 200 && (res.status ?? 200) < 300,
        url: res.url || String(url),
        headers: { get: name => (res.headers || {})[String(name).toLowerCase()] || null },
        text: async () => (Buffer.isBuffer(body) ? body.toString('utf8') : String(body)),
        buffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    })
}

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (request === 'node-fetch') return mockFetch
    if (request === 'yt-search') return async () => ({ channels: [{ name: 'Lofi Girl', url: 'https://youtube.com/@LofiGirl' }, { name: 'Lofi Beats', url: 'https://youtube.com/@LofiBeats' }] })
    if (request === './richhtml.js' && String(parent?.filename || '').endsWith('richstalk.js')) {
        return { sendRichHtmlDocument: async (conn, chat, options) => { sent.push({ chat, options }); return options.title } }
    }
    return originalLoad.apply(this, arguments)
}

const rs = require('../library/richstalk.js')
test.after(() => { Module._load = originalLoad })

function setup(r) { routes = r; calls = []; sent.length = 0; rs._internal.clearCache() }
const AVATAR = { status: 200, body: TINY_PNG, headers: { 'content-type': 'image/png' } }

/* ---------------- util ---------------- */

test('meta() tidak terpotong oleh apostrof & decode entitas numerik', () => {
    const html = `<meta property="og:title" content="O'Brien &#064;home &amp; co"><meta name='og:description' content="it's fine">`
    assert.equal(rs._internal.meta(html, 'og:title'), "O'Brien @home & co")
    assert.equal(rs._internal.meta(html, 'og:description'), "it's fine")
})

test('cleanUsername membersihkan karakter tak terlihat, @, dan link', () => {
    const { cleanUsername } = rs._internal
    assert.equal(cleanUsername('\u200b@Khaby.Lame\u00a0', 'tiktok'), 'Khaby.Lame')
    assert.equal(cleanUsername('https://www.tiktok.com/@khaby.lame/video/123', 'tiktok'), 'khaby.lame')
    assert.equal(cleanUsername('instagram.com/ryzz2.009/?hl=id', 'instagram'), 'ryzz2.009')
    assert.equal(cleanUsername('https://t.me/s/telegram', 'telegram'), 'telegram')
    assert.throws(() => cleanUsername('https://www.instagram.com/p/ABC123/', 'instagram'), /postingan/)
    assert.throws(() => cleanUsername('https://vm.tiktok.com/ZMabc/', 'tiktok'), /tidak didukung/)
})

test('renderPage aman dari pola $& $\' di bio', () => {
    const bio = "Cashapp $& $' $$ </script><b>"
    const html = rs.renderPage({ platform: 'telegram', displayName: 'X', username: '@x', bio, stats: [] })
    const json = /const BOOT=(.*?);\nconst \$=/s.exec(html)[1]
    assert.equal(JSON.parse(json).bio, bio)
    assert.ok(!html.includes('__XERYUU_STALK_BOOTSTRAP__'))
})

/* ---------------- Telegram ---------------- */

const TG_USER = `<html><head><meta property="og:title" content="Pavel Durov"><meta property="og:description" content="Founder of Telegram."></head><body>
<div class="tgme_page_photo"><a href="tg://resolve?domain=durov"><img class="tgme_page_photo_image" src="https://cdn4.cdn-telegram.org/file/x.jpg"></a></div>
<div class="tgme_page_title" dir="auto"><span dir="auto">Pavel Durov</span></div>
<div class="tgme_page_extra">@durov</div>
<div class="tgme_page_description" dir="auto">Founder of Telegram.<br>I'm here &amp; there</div>
<div class="tgme_page_action"><a class="tgme_action_button_new" href="tg://resolve?domain=durov">Send Message</a></div></body></html>`

const TG_MISSING = `<html><head><meta property="og:title" content="Telegram: Contact @nosuchuser123"><meta property="og:description" content="You can contact @nosuchuser123 right away."></head><body>
<div class="tgme_page_icon"><img src="/img/t_logo.png"></div>
<div class="tgme_page_title" dir="auto"><span dir="auto">Telegram: Contact @nosuchuser123</span></div>
<div class="tgme_page_description">If you have <strong>Telegram</strong>, you can contact <a class="tgme_username_link" href="tg://resolve?domain=nosuchuser123">@nosuchuser123</a> right away.</div></body></html>`

const TG_CHANNEL = `<html><body><div class="tgme_page_photo"><img class="tgme_page_photo_image" src="https://cdn4.cdn-telegram.org/file/c.jpg"></div>
<div class="tgme_page_title" dir="auto"><span dir="auto">Telegram</span></div>
<div class="tgme_page_extra">12 345 678 subscribers</div>
<div class="tgme_page_description">The official Telegram on Telegram.</div></body></html>`

test('Telegram: profil valid -> nama, bio, foto (data URI)', async () => {
    setup({ 'https://t.me/durov': { body: TG_USER }, 'https://cdn4.cdn-telegram.org/': AVATAR })
    const d = await rs.stalk('telegram', ' @durov ')
    assert.equal(d.displayName, 'Pavel Durov')
    assert.equal(d.username, '@durov')
    assert.equal(d.bio, "Founder of Telegram.\nI'm here & there")
    assert.match(d.avatar, /^data:image\/(?:jpeg|png);base64,/)
    assert.equal(d.avatarCandidates, undefined)
})

test('Telegram: username tidak ada -> NOT_FOUND (bukan kartu palsu)', async () => {
    setup({ 'https://t.me/nosuchuser123': { body: TG_MISSING } })
    await assert.rejects(() => rs.stalk('telegram', 'nosuchuser123'), err => err.code === 'NOT_FOUND')
})

test('Telegram: channel membaca jumlah subscriber', async () => {
    setup({ 'https://t.me/telegram': { body: TG_CHANNEL }, 'https://cdn4.cdn-telegram.org/': AVATAR })
    const d = await rs.stalk('telegram', 'telegram')
    assert.equal(d.displayName, 'Telegram')
    assert.deepEqual(d.stats.find(s => s[0] === 'Subscribers'), ['Subscribers', '12.345.678'])
    assert.deepEqual(d.stats.find(s => s[0] === 'Tipe'), ['Tipe', 'Channel'])
})

/* ---------------- TikTok ---------------- */

function tiktokPage(detail) {
    return `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.user-detail': detail } })}</script></html>`
}
const TT_OK = tiktokPage({ statusCode: 0, userInfo: { user: { uniqueId: 'khaby.lame', nickname: 'Khabane lame', signature: "Se vuoi ridere\nit's me", verified: true, privateAccount: false, createTime: 1569787651, avatarLarger: 'https://p16.tiktokcdn.com/a.jpeg' }, stats: { followerCount: 160000000, followingCount: 83, heartCount: 2500000000, videoCount: 1300 } } })

test('TikTok: profil valid dari halaman web', async () => {
    setup({ 'https://www.tiktok.com/@khaby.lame': { body: TT_OK }, 'https://p16.tiktokcdn.com/': AVATAR })
    const d = await rs.stalk('tiktok', '@Khaby.Lame')
    assert.equal(d.displayName, 'Khabane lame')
    assert.equal(d.username, 'khaby.lame')
    assert.equal(d.verified, true)
    assert.deepEqual(d.stats[0], ['Followers', '160.000.000'])
    assert.match(d.avatar, /^data:image\//)
})

test('TikTok: statusCode 10221 -> NOT_FOUND', async () => {
    setup({ 'https://www.tiktok.com/@zzznobody': { body: tiktokPage({ statusCode: 10221 }) } })
    await assert.rejects(() => rs.stalk('tiktok', 'zzznobody'), err => err.code === 'NOT_FOUND')
})

test('TikTok: halaman captcha -> fallback tikwm (field camelCase & snake_case)', async () => {
    setup({
        'https://www.tiktok.com/@abc12': { body: '<html>captcha</html>' },
        'https://www.tikwm.com/api/user/info': { body: JSON.stringify({ code: 0, data: { user: { unique_id: 'abc12', nickname: 'Abc', avatar_larger: 'https://p16.tiktokcdn.com/b.jpeg', signature: 'hai' }, stats: { follower_count: 10, following_count: 2, heart_count: 5, video_count: 1 } } }) },
        'https://p16.tiktokcdn.com/': AVATAR
    })
    const d = await rs.stalk('tiktok', 'abc12')
    assert.equal(d.displayName, 'Abc')
    assert.deepEqual(d.stats[0], ['Followers', '10'])
})

test('TikTok: semua sumber diblokir -> BLOCKED (bukan "tidak ditemukan")', async () => {
    setup({ 'https://www.tiktok.com/@blocked1': { body: '<html>captcha</html>' }, 'https://www.tikwm.com/': { status: 429, body: 'slow down' } })
    await assert.rejects(() => rs.stalk('tiktok', 'blocked1'), err => err.code === 'BLOCKED')
})

/* ---------------- Instagram ---------------- */

const IG_API = { body: JSON.stringify({ status: 'ok', data: { user: { username: 'ryzz2.009', full_name: "Ryzz O'Neil", biography: "bio it's here", is_verified: false, is_private: false, edge_followed_by: { count: 1234 }, edge_follow: { count: 56 }, edge_owner_to_timeline_media: { count: 78 }, profile_pic_url_hd: 'https://scontent.cdninstagram.com/hd.jpg' } } }) }

test('Instagram: profil valid dari API (angka persis)', async () => {
    setup({ 'https://www.instagram.com/api/v1/users/web_profile_info/': IG_API, 'https://scontent.cdninstagram.com/': AVATAR })
    const d = await rs.stalk('instagram', 'ryzz2.009')
    assert.equal(d.displayName, "Ryzz O'Neil")
    assert.deepEqual(d.stats[0], ['Followers', '1.234'])
    assert.match(d.avatar, /^data:image\//)
})

test('Instagram: API diblokir -> fallback meta og, nama tetap terbaca', async () => {
    const html = `<meta property="og:title" content="Ryzz O'Neil (@ryzz2.009) &#xB7; Instagram photos and videos"><meta property="og:description" content="1.2M Followers, 56 Following, 78 Posts - Ryzz O'Neil (@ryzz2.009) on Instagram: &quot;hello it's me&quot;"><meta property="og:image" content="https://scontent.cdninstagram.com/og.jpg">`
    setup({
        'https://www.instagram.com/api/v1/users/web_profile_info/': { status: 401, body: '{"message":"login_required"}' },
        'https://www.instagram.com/ryzz2.009/': { body: html },
        'https://scontent.cdninstagram.com/': AVATAR
    })
    const d = await rs.stalk('instagram', 'ryzz2.009')
    assert.equal(d.displayName, "Ryzz O'Neil")
    assert.equal(d.bio, "hello it's me")
    assert.deepEqual(d.stats[0], ['Followers', '1.2M'])
})

test('Instagram: halaman login (title "Instagram") -> BLOCKED, bukan nama "Instagram"', async () => {
    setup({
        'https://www.instagram.com/api/v1/users/web_profile_info/': { status: 429, body: 'x' },
        'https://www.instagram.com/someone/': { body: '<meta property="og:title" content="Instagram"><meta property="og:description" content="Create an account or log in to Instagram">' }
    })
    await assert.rejects(() => rs.stalk('instagram', 'someone'), err => err.code === 'BLOCKED')
})

test('Instagram: 404 -> NOT_FOUND', async () => {
    setup({ 'https://www.instagram.com/api/v1/users/web_profile_info/': { status: 404, body: '{"message":"not found"}' } })
    await assert.rejects(() => rs.stalk('instagram', 'tidakadaaa'), err => err.code === 'NOT_FOUND')
})

/* ---------------- YouTube ---------------- */

function ytPage(name, handle) {
    const data = { metadata: { channelMetadataRenderer: { title: name, description: 'deskripsi lengkap', externalId: 'UCX6OQ3DkcsbYNE6H8uQQuVA', avatar: { thumbnails: [{ url: 'https://yt3.googleusercontent.com/av=s88' }] } } }, header: { pageHeaderViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: handle } }] }, { metadataParts: [{ text: { content: '405M subscribers' } }, { text: { content: '896 videos' } }] }] } } } } }
    return `<html><head><meta property="og:title" content="${name}"><meta property="og:image" content="https://yt3.googleusercontent.com/og=s900"></head><script>var ytInitialData = ${JSON.stringify(data)};</script></html>`
}

test('YouTube: @handle valid -> nama, subscriber, video', async () => {
    setup({ 'https://www.youtube.com/@MrBeast': { body: ytPage('MrBeast', '@MrBeast') }, 'https://yt3.googleusercontent.com/': AVATAR })
    const d = await rs.stalk('youtube', '@MrBeast')
    assert.equal(d.displayName, 'MrBeast')
    assert.deepEqual(d.stats[0], ['Subscribers', '405M'])
    assert.deepEqual(d.stats[1], ['Video', '896'])
    assert.match(d.avatar, /^data:image\//)
})

test('YouTube: handle tidak ada -> NOT_FOUND (tidak lagi menebak channel lain)', async () => {
    setup({ 'https://www.youtube.com/@zzzzqqqq': { status: 404, body: 'nf' } })
    await assert.rejects(() => rs.stalk('youtube', '@zzzzqqqq'), err => err.code === 'NOT_FOUND')
})

test('YouTube: nama channel hanya cocok bila nama persis sama', async () => {
    setup({ 'https://www.youtube.com/@LofiGirl': { body: ytPage('Lofi Girl', '@LofiGirl') }, 'https://yt3.googleusercontent.com/': AVATAR })
    const ok = await rs.stalk('youtube', 'Lofi Girl')
    assert.equal(ok.displayName, 'Lofi Girl')
    setup({ 'https://www.youtube.com/@Lofi': { status: 404, body: 'nf' } })
    await assert.rejects(() => rs.stalkYouTube('Lofi'), err => err.code === 'NOT_FOUND' && /Mungkin maksud/.test(err.message))
})

/* ---------------- Roblox ---------------- */

test('Roblox: username -> profil, teman/follower, avatar', async () => {
    setup({
        'https://users.roblox.com/v1/usernames/users': { body: JSON.stringify({ data: [{ id: 156, name: 'builderman' }] }) },
        'https://users.roblox.com/v1/users/156': { body: JSON.stringify({ id: 156, name: 'builderman', displayName: 'builderman', description: 'Hi', created: '2006-02-27T21:06:40.3Z', isBanned: false, hasVerifiedBadge: true }) },
        'https://friends.roblox.com/v1/users/156/friends/count': { body: '{"count":50}' },
        'https://friends.roblox.com/v1/users/156/followers/count': { body: '{"count":4000000}' },
        'https://friends.roblox.com/v1/users/156/followings/count': { body: '{"count":3}' },
        'https://thumbnails.roblox.com/': { body: JSON.stringify({ data: [{ state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/h.png' }] }) },
        'https://tr.rbxcdn.com/': AVATAR
    })
    const d = await rs.stalk('roblox', 'Builderman')
    assert.equal(d.username, 'builderman')
    assert.deepEqual(d.stats.find(s => s[0] === 'Followers'), ['Followers', '4.000.000'])
    assert.match(d.avatar, /^data:image\//)
})

test('Roblox: username tidak ada -> NOT_FOUND', async () => {
    setup({ 'https://users.roblox.com/v1/usernames/users': { body: '{"data":[]}' } })
    await assert.rejects(() => rs.stalk('roblox', 'zzzznobodyzzzz'), err => err.code === 'NOT_FOUND')
})

/* ---------------- Pengiriman & pesan error ---------------- */

test('sendRichStalk menanam foto profil & data ke HTML, tanpa trustedSources eksternal', async () => {
    setup({ 'https://t.me/durov': { body: TG_USER }, 'https://cdn4.cdn-telegram.org/': AVATAR })
    await rs.sendRichStalk({}, '123@s.whatsapp.net', 'telegram', 'durov')
    const html = sent[0].options.html
    assert.match(html, /"avatar":"data:image\/(?:jpeg|png);base64,/)
    assert.match(sent[0].options.title, /Pavel Durov/)
})

test('hasil di-cache: permintaan kedua tidak menembak server lagi', async () => {
    setup({ 'https://t.me/telegram': { body: TG_CHANNEL }, 'https://cdn4.cdn-telegram.org/': AVATAR })
    await rs.stalk('telegram', 'telegram')
    const before = calls.length
    await rs.stalk('telegram', 'Telegram')
    assert.equal(calls.length, before)
})

test('formatStalkError membedakan tidak ditemukan vs server memblokir', () => {
    assert.match(rs.formatStalkError(new rs.StalkError('NOT_FOUND', 'Akun X tidak ditemukan.'), 'TikTok'), /^❌/)
    assert.match(rs.formatStalkError(new rs.StalkError('BLOCKED', 'captcha'), 'TikTok'), /bukan berarti akunnya tidak ada/)
})
