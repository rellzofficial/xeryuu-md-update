'use strict'

// Xeryuu integration adapter for @coflyn/scrapr.
// Spotify and MediaFire deliberately remain on Xeryuu's pre-existing handlers.
const net = require('net')

const PLATFORM_METHODS = {
  tiktok: [
    ['tiktok', 'snaptik'], ['tiktok', 'tiktokio'], ['tiktok', 'ssstik'],
    ['tiktok', 'tikdownloader'], ['tiktok', 'savetik']
  ],
  instagram: [
    ['instagram', 'direct'], ['instagram', 'indown'],
    ['instagram', 'snapsave'], ['instagram', 'snapinsta']
  ],
  facebook: [['facebook', 'snapsave'], ['facebook', 'fdown']],
  youtube: [['youtube', 'ytmp3'], ['youtube', 'ytmp3gg'], ['youtube', 'playlist']],
  twitter: [['twitter', 'direct'], ['twitter', 'tvd'], ['twitter', 'tweeload'], ['twitter', 'savetwt']],
  soundcloud: [['soundcloud', 'klickaud']],
  pinterest: [['pinterest', 'direct'], ['pinterest', 'pindown']],
  applemusic: [['applemusic', 'aplmate']],
  bilibili: [['bilibili', 'direct']],
  douyin: [['douyin', 'direct']],
  bandcamp: [['bandcamp', 'direct'], ['bandcamp', 'bandcampdownloader']],
  pixiv: [['pixiv', 'ajax']],
  rednote: [['rednote', 'direct']],
  threads: [['threads', 'threadster']],
  reddit: [['reddit', 'rapidsave']],
  terabox: [['terabox', 'sechno']],
  sfile: [['resolver', 'sfile']],
  safelinku: [['resolver', 'safelinku']],
  sub2unlock: [['resolver', 'sub2unlock']],
  rekonise: [['resolver', 'rekonise']],
  unshorten: [['resolver', 'unshorten']]
}

const COMMAND_PLATFORM = {
  tiktok: 'tiktok', tt: 'tiktok',
  instagram: 'instagram', ig: 'instagram',
  facebook: 'facebook', fb: 'facebook',
  youtube: 'youtube', yt: 'youtube', ytmp3: 'youtube',
  twitter: 'twitter',
  soundcloud: 'soundcloud',
  pinterest: 'pinterest',
  applemusic: 'applemusic', apple: 'applemusic',
  bilibili: 'bilibili',
  douyin: 'douyin',
  bandcamp: 'bandcamp',
  pixiv: 'pixiv',
  rednote: 'rednote', xiaohongshu: 'rednote',
  threads: 'threads',
  reddit: 'reddit',
  terabox: 'terabox',
  sfile: 'sfile', sf: 'sfile',
  safelinku: 'safelinku', safelink: 'safelinku',
  sub2unlock: 'sub2unlock',
  rekonise: 'rekonise',
  unshorten: 'unshorten'
}

const RESOLVER_PLATFORMS = new Set(['sfile', 'safelinku', 'sub2unlock', 'rekonise', 'unshorten'])

function defaultScraprMethodCount(platform, methodEntries = PLATFORM_METHODS[platform] || []) {
  const name = String(platform || '').toLowerCase()
  if (name === 'tiktok') return Math.min(3, methodEntries.length || 1)
  if (name === 'unshorten') return 1
  return methodEntries.length || 1
}
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|opus|wav|flac|jpg|jpeg|png|gif|webp|pdf|zip|rar|7z|apk|txt|mp3)(?:$|\?)/i

function cleanString(value, max = 180) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function assertPublicHttpUrl(raw) {
  let parsed
  try { parsed = new URL(String(raw || '').trim()) } catch { throw new Error('URL tidak valid. Sertakan tautan lengkap yang diawali http:// atau https://.') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Protokol URL tidak didukung.')
  const hostname = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname === 'metadata.google.internal' || parsed.username || parsed.password) {
    throw new Error('URL tujuan privat/lokal atau URL dengan kredensial tidak diizinkan.')
  }
  if (net.isIP(hostname)) {
    if (hostname.includes(':')) {
      const normalized = hostname.toLowerCase()
      if (normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
        throw new Error('URL IP privat/lokal tidak diizinkan.')
      }
    } else {
      const parts = hostname.split('.').map(Number)
      const [a, b] = parts
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
        throw new Error('URL IP privat/lokal tidak diizinkan.')
      }
    }
  }
  parsed.hash = ''
  return parsed.toString()
}

function isHost(host, patterns) {
  return patterns.some(pattern => host === pattern || host.endsWith(`.${pattern}`))
}

function normalizeInstagramPostUrl(rawInput) {
  const input = String(rawInput || '').trim().split(/\s+/)[0] || ''
  if (!input) throw new Error('Masukkan URL Instagram terlebih dahulu.')
  let parsed
  try {
    parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    throw new Error('URL Instagram tidak valid. Contoh: https://www.instagram.com/reel/xxxxx/')
  }
  const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '')
  const validHost = host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am' || host.endsWith('.instagr.am')
  if (!['http:', 'https:'].includes(parsed.protocol) || !validHost) {
    throw new Error('Link tidak valid. Gunakan tautan Instagram yang bisa diakses publik.')
  }
  if (!/(?:^|\/)(?:p|reel|reels|tv|stories)\//i.test(parsed.pathname)) {
    throw new Error('Kirim link postingan, reel, atau story Instagram. Link profil biasa belum tentu berisi media yang bisa diunduh.')
  }
  parsed.hash = ''
  return parsed.toString()
}

function detectScraprPlatform(rawUrl) {
  let parsed
  try { parsed = new URL(String(rawUrl || '').trim()) } catch { return null }
  const host = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '')
  if (isHost(host, ['open.spotify.com', 'spotify.com', 'spoti.fi'])) return 'spotify'
  if (isHost(host, ['mediafire.com', 'mfi.re'])) return 'mediafire'
  if (isHost(host, ['tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com', 'tiktokcdn.com'])) return 'tiktok'
  if (isHost(host, ['instagram.com', 'instagr.am'])) return 'instagram'
  if (isHost(host, ['facebook.com', 'fb.watch', 'fb.com', 'm.facebook.com'])) return 'facebook'
  if (isHost(host, ['youtube.com', 'youtu.be', 'youtube-nocookie.com'])) return 'youtube'
  if (isHost(host, ['x.com', 'twitter.com', 't.co'])) return 'twitter'
  if (isHost(host, ['soundcloud.com', 'on.soundcloud.com'])) return 'soundcloud'
  if (isHost(host, ['pinterest.com', 'pinterest.co.uk', 'pin.it'])) return 'pinterest'
  if (isHost(host, ['music.apple.com', 'itunes.apple.com'])) return 'applemusic'
  if (isHost(host, ['bilibili.com', 'b23.tv', 'bili2233.cn'])) return 'bilibili'
  if (isHost(host, ['douyin.com', 'iesdouyin.com'])) return 'douyin'
  if (isHost(host, ['bandcamp.com'])) return 'bandcamp'
  if (isHost(host, ['pixiv.net', 'pixiv.re'])) return 'pixiv'
  if (isHost(host, ['xiaohongshu.com', 'xhslink.com', 'rednote.com'])) return 'rednote'
  if (isHost(host, ['threads.net'])) return 'threads'
  if (isHost(host, ['reddit.com', 'redd.it', 'v.redd.it'])) return 'reddit'
  if (isHost(host, ['terabox.com', '1024terabox.com', 'teraboxapp.com', 'terabox.app'])) return 'terabox'
  if (isHost(host, ['sfile.co', 'sfile.mobi'])) return 'sfile'
  if (isHost(host, ['sfl.gl', 'safelinku.com', 'safelinku.net'])) return 'safelinku'
  if (isHost(host, ['sub2unlock.com', 'sub2unlock.io', 'sub4unlock.com'])) return 'sub2unlock'
  if (isHost(host, ['rekonise.com'])) return 'rekonise'
  return null
}

function resolveScraprPlatform(command, inputUrl) {
  const cmd = String(command || '').toLowerCase().replace(/^\//, '').trim()
  if (['scrapr', 'scrapeurl', 'resolver', 'download', 'aio'].includes(cmd)) return detectScraprPlatform(inputUrl)
  return COMMAND_PLATFORM[cmd] || detectScraprPlatform(inputUrl)
}

function validatePlatformUrl(platform, url) {
  const detected = detectScraprPlatform(url)
  if (platform === 'spotify') throw new Error('Spotify tetap memakai downloader Xeryuu yang sudah ada. Gunakan .spotify atau .spdl.')
  if (platform === 'mediafire') throw new Error('MediaFire tetap memakai downloader Xeryuu yang sudah ada. Gunakan .mediafire.')
  if (!platform || !PLATFORM_METHODS[platform]) throw new Error('Platform belum didukung Scrapr. Gunakan URL dari platform yang didukung atau .unshorten untuk shortlink publik.')
  if (platform === 'unshorten') return
  if (detected !== platform) {
    throw new Error(`URL tidak cocok dengan platform ${platform}. Pastikan tautan berasal dari platform yang benar.`)
  }
}

function getScraprPackage() {
  try { return require('@coflyn/scrapr') }
  catch (error) {
    const wrapped = new Error('Dependensi @coflyn/scrapr belum terpasang. Jalankan npm install setelah mengambil script terbaru.')
    wrapped.cause = error
    throw wrapped
  }
}

function extractCandidateUrls(value, out = [], depth = 0) {
  if (!value || depth > 4 || out.length > 20) return out
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && MEDIA_EXT.test(value)) out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) extractCandidateUrls(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const key of ['url', 'downloadUrl', 'download_url', 'mediaUrl', 'media_url', 'src', 'file', 'download', 'downloads', 'media', 'video', 'audio', 'image', 'images']) {
      if (value[key] != null) extractCandidateUrls(value[key], out, depth + 1)
    }
  }
  return out
}

function normalizeScraprResponse(response, platform, sourceUrl, methodName) {
  if (!response || response.status !== true || !response.result) {
    throw new Error(cleanString(response?.message || 'Extractor tidak menghasilkan media.', 240))
  }
  const raw = response.result
  const title = cleanString(raw.title || raw.name || raw.filename || raw.fileName || platform, 180) || platform
  const thumbnail = typeof raw.thumbnail === 'string' ? raw.thumbnail : ''
  const type = cleanString(raw.type || raw.mediaType || '', 32).toLowerCase()
  let downloads = Array.isArray(raw.downloads) ? raw.downloads.filter(item => item && (typeof item.url === 'string' || typeof item.downloadUrl === 'string')).map(item => ({
    url: String(item.url || item.downloadUrl || '').trim(),
    type: cleanString(item.type || type || 'file', 32).toLowerCase(),
    quality: cleanString(item.quality || '', 32),
    filename: cleanString(item.filename || item.fileName || '', 120)
  })).filter(item => /^https?:\/\//i.test(item.url)) : []
  if (!downloads.length) {
    const direct = raw.url || raw.downloadUrl || raw.download_url || raw.directUrl || raw.direct_url
    if (typeof direct === 'string' && /^https?:\/\//i.test(direct) && platform !== 'unshorten') {
      downloads = [{ url: direct, type: type || 'file', quality: '', filename: cleanString(raw.filename || raw.fileName || '', 120) }]
    }
  }
  if (!downloads.length) {
    const urls = [...new Set(extractCandidateUrls(raw))]
    downloads = urls.map(url => ({ url, type: type || 'file', quality: '', filename: '' }))
  }
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 20).map(item => ({
    title: cleanString(item?.title || item?.name || 'Item', 100),
    author: cleanString(item?.author || item?.artist || '', 80),
    url: typeof item?.url === 'string' ? item.url : '',
    thumbnail: typeof item?.thumbnail === 'string' ? item.thumbnail : '',
    type: cleanString(item?.type || item?.mediaType || type || '', 32).toLowerCase()
  })) : []
  const resultUrl = typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url) ? raw.url : ''
  if (!downloads.length && !items.length && !resultUrl) throw new Error('Scrapr merespons sukses, tetapi tautan media tidak ditemukan.')
  return {
    platform,
    title,
    thumbnail,
    type,
    downloads,
    items,
    resultUrl,
    sourceUrl,
    method: methodName,
    isResolver: RESOLVER_PLATFORMS.has(platform),
    raw
  }
}

async function withTimeout(promiseFactory, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(promiseFactory),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Extractor melewati batas waktu ${Math.round(timeoutMs / 1000)} detik.`)), timeoutMs) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function extractScrapr(url, platform = 'auto', options = {}) {
  const safeUrl = assertPublicHttpUrl(url)
  const resolvedPlatform = platform === 'auto' ? detectScraprPlatform(safeUrl) : String(platform || '').toLowerCase()
  if (!resolvedPlatform) throw new Error('Domain URL tidak dikenali oleh Scrapr. Gunakan .unshorten <url> untuk membuka shortlink publik yang didukung.')
  validatePlatformUrl(resolvedPlatform, safeUrl)

  const scrapr = getScraprPackage()
  const methodEntries = PLATFORM_METHODS[resolvedPlatform] || []
  // Keep TikTok's existing 3-provider path unchanged; other supported platforms
  // should reach their complete fallback chain (e.g. Instagram's snapinsta and
  // Twitter's savetwt were previously never attempted).
  const defaultMaxMethods = defaultScraprMethodCount(resolvedPlatform, methodEntries)
  const maxMethods = Math.max(1, Math.min(Number(options.maxMethods || defaultMaxMethods), methodEntries.length || 1))
  const timeoutMs = Math.max(3000, Math.min(Number(options.timeoutMs || 14000), 30000))
  const errors = []

  for (const [namespace, methodName] of methodEntries.slice(0, maxMethods)) {
    const fn = scrapr?.[namespace]?.[methodName]
    if (typeof fn !== 'function') {
      errors.push(`${namespace}.${methodName}: metode tidak tersedia di package ini`)
      continue
    }
    try {
      const response = await withTimeout(() => fn(safeUrl), timeoutMs)
      return normalizeScraprResponse(response, resolvedPlatform, safeUrl, `${namespace}.${methodName}`)
    } catch (error) {
      errors.push(`${namespace}.${methodName}: ${cleanString(error?.message || error, 160)}`)
    }
  }
  throw new Error(`Semua extractor Scrapr untuk ${resolvedPlatform} gagal. ${errors.slice(0, 3).join(' | ')}`)
}

function guessExtension(url, mime = '') {
  try {
    const pathname = new URL(url).pathname
    const ext = pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]
    if (ext) return ext.toLowerCase()
  } catch {}
  const fromMime = ({
    'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/ogg': 'ogg', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'application/pdf': 'pdf', 'application/zip': 'zip'
  })[String(mime || '').split(';')[0].toLowerCase()]
  return fromMime || 'bin'
}

function inferKind(download, result, mime = '') {
  const hint = `${download?.type || ''} ${result?.type || ''} ${mime || ''} ${download?.url || ''}`.toLowerCase()
  if (/image\/|\bimage\b|\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.webp(?:\?|$)|\.gif(?:\?|$)/.test(hint)) return 'image'
  if (/audio\/|\baudio\b|\.mp3(?:\?|$)|\.m4a(?:\?|$)|\.aac(?:\?|$)|\.ogg(?:\?|$)|\.opus(?:\?|$)|\.wav(?:\?|$)/.test(hint)) return 'audio'
  if (/video\/|\bvideo\b|\.mp4(?:\?|$)|\.webm(?:\?|$)|\.mov(?:\?|$)|\.mkv(?:\?|$)|\.m3u8(?:\?|$)/.test(hint)) return 'video'
  return 'document'
}

function chooseDownload(result) {
  const downloads = Array.isArray(result?.downloads) ? [...result.downloads] : []
  if (!downloads.length && result?.resultUrl) return { url: result.resultUrl, type: result.type || 'file', quality: '', filename: '' }
  downloads.sort((a, b) => {
    const qa = Number(String(a.quality || '').match(/\d+/)?.[0] || 0)
    const qb = Number(String(b.quality || '').match(/\d+/)?.[0] || 0)
    return qb - qa
  })
  return downloads[0] || null
}

async function fetchScraprBuffer(url, maxBytes = 48 * 1024 * 1024) {
  const axios = require('axios')
  let safeUrl = assertPublicHttpUrl(url)
  let response = null
  // Follow redirects manually so every destination is revalidated (prevents
  // a provider-supplied redirect from reaching private/local network addresses).
  for (let hop = 0; hop <= 5; hop++) {
    response = await axios.get(safeUrl, {
      responseType: 'stream', timeout: 45000, maxRedirects: 0,
      maxContentLength: maxBytes, maxBodyLength: maxBytes,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Xeryuu-MD/16.0)', 'Accept': '*/*' },
      validateStatus: status => status >= 200 && status < 400
    })
    if (response.status >= 300 && response.status < 400) {
      response.data?.destroy?.()
      const location = response.headers?.location
      if (!location || hop === 5) throw new Error('Tautan media terlalu banyak redirect atau tujuan redirect tidak tersedia.')
      safeUrl = assertPublicHttpUrl(new URL(location, safeUrl).toString())
      continue
    }
    break
  }
  if (!response || response.status < 200 || response.status >= 300) throw new Error('Server media mengembalikan status HTTP yang tidak didukung.')
  const declaredSize = Number(response.headers?.['content-length'] || 0)
  if (declaredSize > maxBytes) {
    response.data?.destroy?.()
    return { tooLarge: true, size: declaredSize, mime: String(response.headers?.['content-type'] || '') }
  }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of response.data) {
      size += chunk.length
      if (size > maxBytes) {
        response.data.destroy?.()
        return { tooLarge: true, size, mime: String(response.headers?.['content-type'] || '') }
      }
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    if (size > maxBytes) return { tooLarge: true, size, mime: String(response.headers?.['content-type'] || '') }
    throw error
  }
  const buffer = Buffer.concat(chunks)
  if (!buffer.length) throw new Error('URL media mengembalikan file kosong.')
  let mime = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase()
  try {
    const fileType = require('file-type')
    const detected = typeof fileType.fromBuffer === 'function' ? await fileType.fromBuffer(buffer) : null
    if (detected?.mime) mime = detected.mime
  } catch {}
  if (!mime || mime === 'application/octet-stream') mime = 'application/octet-stream'
  return { buffer, mime, size, headers: response.headers || {} }
}

function makeCaption(result, quality = '') {
  const lines = [`✅ ${String(result?.platform || 'MEDIA').toUpperCase()} DOWNLOADER`, '', `📌 Judul: ${cleanString(result?.title || 'Media', 150)}`]
  if (quality) lines.push(`🎞️ Kualitas: ${cleanString(quality, 40)}`)
  lines.push('', '> Created by XnalzNotDev')
  return lines.join('\n').slice(0, 1000)
}

function summarizeItems(result) {
  const items = Array.isArray(result?.items) ? result.items : []
  if (!items.length) return ''
  let text = `✅ *${String(result.platform || 'MEDIA').toUpperCase()}*\n${cleanString(result.title || 'Daftar media', 160)}\n\n`
  text += items.slice(0, 10).map((item, index) => `${index + 1}. ${cleanString(item.title || 'Item', 90)}${item.author ? ` — ${cleanString(item.author, 60)}` : ''}${item.url ? `\n${item.url}` : ''}`).join('\n\n')
  if (items.length > 10) text += `\n\n… dan ${items.length - 10} item lainnya.`
  return text.slice(0, 3800)
}

async function sendScraprToWhatsApp(conn, m, result) {
  // Instagram carousels can contain several distinct media items. They are
  // opted into explicitly by the Instagram handler so normal multi-quality
  // choices on other platforms still send only the best matching download.
  if (result?.sendAllDownloads && Array.isArray(result?.downloads) && result.downloads.length > 1) {
    const downloads = result.downloads.slice(0, 10)
    let sent = 0
    for (const download of downloads) {
      try {
        await sendScraprToWhatsApp(conn, m, {
          ...result,
          items: [],
          sendAllDownloads: false,
          resultUrl: '',
          downloads: [download]
        })
        sent++
      } catch (error) {
        console.warn('[SCRAPR MULTI-MEDIA SEND]', cleanString(error?.message || error, 180))
      }
    }
    if (!sent) throw new Error('Media ditemukan, tetapi tidak ada item yang berhasil dikirim.')
    return { sent: true, type: 'collection', count: sent }
  }
  if (result?.platform === 'unshorten' && result?.resultUrl) {
    await conn.sendMessage(m.chat, { text: `✅ Tautan berhasil dibuka.\n\n🔗 ${result.resultUrl}` }, { quoted: m })
    return { sent: true, type: 'resolved-link' }
  }
  const itemSummary = summarizeItems(result)
  if (itemSummary) {
    await conn.sendMessage(m.chat, { text: itemSummary }, { quoted: m })
    return { sent: true, type: 'list' }
  }
  const download = chooseDownload(result)
  const targetUrl = download?.url || result?.resultUrl
  if (!targetUrl) throw new Error('Scrapr tidak memberikan tautan media yang dapat dikirim.')

  if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(targetUrl)) {
    await conn.sendMessage(m.chat, { text: `✅ Tautan streaming berhasil ditemukan, tetapi bukan file media langsung.\n\n🔗 ${targetUrl}` }, { quoted: m })
    return { sent: true, type: 'link', streamingManifest: true }
  }
  let file
  try { file = await fetchScraprBuffer(targetUrl, 48 * 1024 * 1024) }
  catch (error) {
    await conn.sendMessage(m.chat, { text: `✅ Tautan ${String(result.platform || 'media')} berhasil diproses, tetapi file tidak dapat dikirim langsung.\n\n🔗 ${targetUrl}\n\nDetail: ${cleanString(error?.message || error, 250)}` }, { quoted: m })
    return { sent: true, type: 'link' }
  }
  if (file.tooLarge) {
    await conn.sendMessage(m.chat, { text: `✅ Media berhasil ditemukan, tetapi ukurannya terlalu besar untuk dikirim langsung.\n\n🔗 ${targetUrl}` }, { quoted: m })
    return { sent: true, type: 'link', tooLarge: true }
  }
  if (result?.isResolver && /text\/html|application\/xhtml\+xml/i.test(file.mime || '')) {
    await conn.sendMessage(m.chat, { text: `✅ Tautan tujuan berhasil ditemukan, tetapi hasilnya masih berupa halaman web, bukan file langsung.\n\n🔗 ${targetUrl}` }, { quoted: m })
    return { sent: true, type: 'resolved-link' }
  }

  const kind = inferKind(download, result, file.mime)
  const ext = guessExtension(targetUrl, file.mime)
  const safeTitle = cleanString(result.title || result.platform || 'xeryuu-media', 80).replace(/[\\/:*?"<>|]/g, '_') || 'xeryuu-media'
  const filename = cleanString(download.filename, 100) || `${safeTitle}.${ext}`
  const caption = makeCaption(result, download.quality)
  if (kind === 'image') {
    await conn.sendMessage(m.chat, { image: file.buffer, caption }, { quoted: m })
  } else if (kind === 'video') {
    await conn.sendMessage(m.chat, { video: file.buffer, mimetype: file.mime.startsWith('video/') ? file.mime : 'video/mp4', fileName: filename, caption }, { quoted: m })
  } else if (kind === 'audio') {
    await conn.sendMessage(m.chat, { audio: file.buffer, mimetype: file.mime.startsWith('audio/') ? file.mime : 'audio/mpeg', fileName: filename, ptt: false }, { quoted: m })
    await conn.sendMessage(m.chat, { text: caption }, { quoted: m })
  } else {
    await conn.sendMessage(m.chat, { document: file.buffer, fileName: filename, mimetype: file.mime || 'application/octet-stream', caption }, { quoted: m })
  }
  return { sent: true, type: kind, bytes: file.size }
}

async function sendScraprToTelegram(ctx, result) {
  if (result?.platform === 'unshorten' && result?.resultUrl) {
    await ctx.reply(`✅ Tautan berhasil dibuka.\n\n🔗 ${result.resultUrl}`)
    return { sent: true, type: 'resolved-link' }
  }
  const itemSummary = summarizeItems(result)
  if (itemSummary) {
    await ctx.reply(itemSummary)
    return { sent: true, type: 'list' }
  }
  const download = chooseDownload(result)
  const targetUrl = download?.url || result?.resultUrl
  if (!targetUrl) throw new Error('Scrapr tidak memberikan tautan media yang dapat dikirim.')
  if (/\.(?:m3u8|mpd)(?:$|[?#])/i.test(targetUrl)) {
    await ctx.reply(`✅ Tautan streaming berhasil ditemukan, tetapi bukan file media langsung.\n\n🔗 ${targetUrl}`)
    return { sent: true, type: 'link', streamingManifest: true }
  }
  let file
  try { file = await fetchScraprBuffer(targetUrl, 48 * 1024 * 1024) }
  catch (error) {
    await ctx.reply(`✅ Tautan ${String(result.platform || 'media')} berhasil diproses, tetapi file tidak dapat dikirim langsung.\n\n🔗 ${targetUrl}\n\nDetail: ${cleanString(error?.message || error, 220)}`)
    return { sent: true, type: 'link' }
  }
  if (file.tooLarge) {
    await ctx.reply(`✅ Media berhasil ditemukan, tetapi ukurannya terlalu besar untuk dikirim langsung.\n\n🔗 ${targetUrl}`)
    return { sent: true, type: 'link', tooLarge: true }
  }
  if (result?.isResolver && /text\/html|application\/xhtml\+xml/i.test(file.mime || '')) {
    await ctx.reply(`✅ Tautan tujuan berhasil ditemukan, tetapi hasilnya masih berupa halaman web, bukan file langsung.\n\n🔗 ${targetUrl}`)
    return { sent: true, type: 'resolved-link' }
  }
  const kind = inferKind(download, result, file.mime)
  const ext = guessExtension(targetUrl, file.mime)
  const safeTitle = cleanString(result.title || result.platform || 'xeryuu-media', 80).replace(/[\\/:*?"<>|]/g, '_') || 'xeryuu-media'
  const filename = cleanString(download.filename, 100) || `${safeTitle}.${ext}`
  const caption = makeCaption(result, download.quality)
  if (kind === 'image') await ctx.replyWithPhoto({ source: file.buffer, filename }, { caption })
  else if (kind === 'video') await ctx.replyWithVideo({ source: file.buffer, filename }, { caption, supports_streaming: true })
  else if (kind === 'audio') await ctx.replyWithAudio({ source: file.buffer, filename }, { caption, title: safeTitle, performer: 'Xeryuu-MD' })
  else await ctx.replyWithDocument({ source: file.buffer, filename }, { caption })
  return { sent: true, type: kind, bytes: file.size }
}

module.exports = {
  PLATFORM_METHODS,
  COMMAND_PLATFORM,
  defaultScraprMethodCount,
  normalizeInstagramPostUrl,
  detectScraprPlatform,
  resolveScraprPlatform,
  extractScrapr,
  sendScraprToWhatsApp,
  sendScraprToTelegram,
  assertPublicHttpUrl
}
