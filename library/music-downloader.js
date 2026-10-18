'use strict'

const axios = require('axios')
const yts = require('yt-search')
const cheerio = require('cheerio')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Xeryuu-MD/16'
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024
const MAX_SEND_BYTES = 25 * 1024 * 1024
const MAX_VIDEO_DOWNLOAD_BYTES = 60 * 1024 * 1024
const REQUEST_TIMEOUT = 25000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, label = 'Request') {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout (${Math.ceil(ms / 1000)} detik)`)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isYouTubeUrl(value) {
  try {
    const u = new URL(String(value || '').trim())
    return /(^|\.)((youtube\.com)|(youtu\.be))$/i.test(u.hostname.replace(/^www\./i, '')) ||
      /(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)
  } catch {
    return false
  }
}

function normalizeYouTubeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^[\w-]{11}$/.test(raw)) return `https://www.youtube.com/watch?v=${raw}`
  if (!isYouTubeUrl(raw)) return ''
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    let id = ''
    if (host === 'youtu.be') id = u.pathname.split('/').filter(Boolean)[0] || ''
    else {
      id = u.searchParams.get('v') || ''
      if (!id) {
        const parts = u.pathname.split('/').filter(Boolean)
        const marker = parts.findIndex(part => ['shorts', 'embed', 'live', 'v'].includes(part.toLowerCase()))
        if (marker >= 0) id = parts[marker + 1] || ''
      }
    }
    if (!/^[\w-]{11}$/.test(id)) return ''
    return `https://www.youtube.com/watch?v=${id}`
  } catch {
    return ''
  }
}

function normalizeYouTubeResult(item = {}) {
  const url = normalizeYouTubeUrl(item.url || item.link || '')
  if (!url) return null
  const id = new URL(url).searchParams.get('v')
  return {
    title: String(item.title || 'Audio YouTube').replace(/[\r\n\t]+/g, ' ').trim(),
    url,
    videoId: id,
    thumbnail: String(item.thumbnail || item.image || item.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
    timestamp: String(item.timestamp || item.duration?.timestamp || item.duration || ''),
    seconds: Number(item.seconds || item.duration?.seconds || 0) || 0,
    author: item.author || item.channel || { name: 'YouTube' },
    views: Number(item.views || 0) || 0,
    description: String(item.description || '')
  }
}

async function searchYouTubeMusic(query, limit = 10) {
  const q = String(query || '').trim()
  if (!q) throw new Error('Judul lagu belum diisi.')
  const direct = normalizeYouTubeUrl(q)
  if (direct) {
    const result = await yts(direct).catch(() => null)
    const picked = (result?.videos || result?.all || []).map(normalizeYouTubeResult).find(Boolean)
    if (picked) return [picked]
    const id = new URL(direct).searchParams.get('v')
    return [{ title: `YouTube Audio ${id}`, url: direct, videoId: id, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, timestamp: '', seconds: 0, author: { name: 'YouTube' }, views: 0 }]
  }
  const result = await withTimeout(yts(q), 18000, 'Pencarian YouTube')
  const items = Array.isArray(result?.videos) ? result.videos : (Array.isArray(result?.all) ? result.all : [])
  return items
    .map(normalizeYouTubeResult)
    .filter(Boolean)
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, 10)))
}

function findMediaUrl(value, depth = 0, seen = new Set()) {
  if (depth > 7 || value == null) return ''
  if (typeof value === 'string') {
    const candidate = value.trim()
    if (!isHttpUrl(candidate)) return ''
    try {
      const parsed = new URL(candidate)
      const hostname = parsed.hostname.toLowerCase()
      // Jangan salah mengambil kembali tautan video sumber atau halaman hasil.
      if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)open\.spotify\.com$/.test(hostname)) return ''
      if (/\.(?:jpg|jpeg|png|webp|gif|svg)(?:$|\?)/i.test(candidate)) return ''
    } catch { return '' }
    return candidate
  }
  if (typeof value !== 'object' || seen.has(value)) return ''
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMediaUrl(item, depth + 1, seen)
      if (found) return found
    }
    return ''
  }
  const priority = [
    'downloadUrl', 'download_url', 'download', 'audioUrl', 'audio_url', 'audio',
    'dlink', 'fileUrl', 'file_url', 'file', 'mediaUrl', 'media_url', 'link', 'url',
    'result', 'data', 'response', 'formats', 'items'
  ]
  for (const key of priority) {
    if (!(key in value)) continue
    const found = findMediaUrl(value[key], depth + 1, seen)
    if (found) return found
  }
  for (const [key, item] of Object.entries(value)) {
    if (priority.includes(key)) continue
    const found = findMediaUrl(item, depth + 1, seen)
    if (found) return found
  }
  return ''
}

async function fetchJson(url, options = {}) {
  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    maxContentLength: 5 * 1024 * 1024,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...options.headers },
    ...options
  })
  return response.data
}

async function resolveViaVreden(url) {
  const scraper = require('@vreden/youtube_scraper')
  if (typeof scraper?.ytmp3 !== 'function') throw new Error('ytmp3() dari @vreden/youtube_scraper tidak tersedia')
  const result = await withTimeout(scraper.ytmp3(url), 14000, 'Resolver Vreden')
  const direct = findMediaUrl(result)
  if (!direct) throw new Error(result?.message || result?.error || 'Respons Vreden tidak berisi URL audio')
  return { url: direct, title: result?.title || result?.result?.title || '' }
}

async function resolveViaSanka(url) {
  const data = await fetchJson(`https://www.sankavollerei.com/download/ytmp3?apikey=planaai&url=${encodeURIComponent(url)}`, { timeout: 12000 })
  const direct = findMediaUrl(data)
  if (!direct) throw new Error(data?.message || data?.msg || 'Respons Sanka tidak berisi URL audio')
  return { url: direct, title: data?.result?.title || data?.data?.title || data?.title || '' }
}

async function resolveViaSkyzopedia(url) {
  const data = await fetchJson(`https://api.skyzopedia.web.id/download/ytdl-mp3?apikey=skyy&url=${encodeURIComponent(url)}`, { timeout: 12000 })
  const direct = findMediaUrl(data)
  if (!direct) throw new Error(data?.message || data?.msg || 'Respons Skyzopedia tidak berisi URL audio')
  return { url: direct, title: data?.result?.title || data?.data?.title || data?.title || '' }
}

async function resolveViaYtConvert(url) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Referer: 'https://ytmp3.gg/'
  }
  let lastError
  for (const host of ['hub.ytconvert.org', 'api.ytconvert.org']) {
    try {
      const { data } = await axios.post(`https://${host}/api/download`, {
        url,
        os: 'android',
        output: { type: 'audio', format: 'mp3' },
        audio: { bitrate: '128k' }
      }, { headers, timeout: 15000, maxContentLength: 3 * 1024 * 1024 })

      let direct = findMediaUrl(data?.downloadUrl || data?.download_url || data?.download || data?.result?.download || data?.result?.url)
      if (direct && !data?.statusUrl && !data?.status_url) return { url: direct, title: data?.title || data?.result?.title || '' }

      const statusUrl = data?.statusUrl || data?.status_url || data?.status_url_v2 || data?.result?.statusUrl || data?.data?.statusUrl
      if (!statusUrl || !isHttpUrl(statusUrl)) throw new Error(data?.message || 'URL status konversi tidak ditemukan')

      const started = Date.now()
      for (let i = 0; i < 24 && Date.now() - started < 36000; i++) {
        await sleep(1500)
        const poll = await axios.get(statusUrl, { headers, timeout: 10000, maxContentLength: 3 * 1024 * 1024 })
        const state = String(poll.data?.status || poll.data?.state || '').toLowerCase()
        direct = findMediaUrl(poll.data?.downloadUrl || poll.data?.download_url || poll.data?.download || poll.data?.result || poll.data?.data)
        if (direct && (['completed', 'complete', 'success', 'finished', 'done'].includes(state) || !state)) {
          return { url: direct, title: poll.data?.title || data?.title || '' }
        }
        if (['failed', 'error', 'cancelled', 'canceled'].includes(state)) throw new Error(poll.data?.message || 'Konversi YouTube gagal')
      }
      throw new Error('Timeout menunggu konversi YtConvert')
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('YtConvert tidak tersedia')
}

async function resolveViaSaveTube(url) {
  const id = new URL(normalizeYouTubeUrl(url)).searchParams.get('v')
  if (!id) throw new Error('ID YouTube tidak valid')
  const headers = {
    'Content-Type': 'application/json',
    Origin: 'https://yt.savetube.me',
    'User-Agent': USER_AGENT
  }
  const signalTimeout = ms => AbortSignal.timeout(ms)
  const cdnResponse = await fetch('https://media.savetube.vip/api/random-cdn', { headers, signal: signalTimeout(9000) })
  if (!cdnResponse.ok) throw new Error(`SaveTube CDN HTTP ${cdnResponse.status}`)
  const cdnData = await cdnResponse.json()
  if (!cdnData?.cdn) throw new Error('SaveTube CDN tidak tersedia')
  const cdn = String(cdnData.cdn).replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!/^[a-z0-9.-]+$/i.test(cdn)) throw new Error('Host CDN SaveTube tidak valid')

  const infoResponse = await fetch(`https://${cdn}/v2/info`, {
    method: 'POST', headers, signal: signalTimeout(12000),
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` })
  })
  if (!infoResponse.ok) throw new Error(`SaveTube info HTTP ${infoResponse.status}`)
  const info = await infoResponse.json()
  if (!info?.data) throw new Error('Metadata SaveTube kosong')

  const encrypted = Buffer.from(info.data, 'base64')
  if (encrypted.length < 17) throw new Error('Metadata SaveTube tidak valid')
  const key = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, encrypted.subarray(0, 16))
  const decrypted = Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()])
  const metadata = JSON.parse(decrypted.toString('utf8'))
  if (!metadata?.key) throw new Error('Kunci audio SaveTube tidak ditemukan')

  const dlResponse = await fetch(`https://${cdn}/download`, {
    method: 'POST', headers, signal: signalTimeout(12000),
    body: JSON.stringify({ id, downloadType: 'audio', quality: '128kbps', key: metadata.key })
  })
  if (!dlResponse.ok) throw new Error(`SaveTube download HTTP ${dlResponse.status}`)
  const dl = await dlResponse.json()
  const direct = findMediaUrl(dl?.data?.downloadUrl || dl?.data?.url || dl)
  if (!direct) throw new Error(dl?.message || 'URL audio SaveTube tidak ditemukan')
  return { url: direct, title: metadata.title || '' }
}

async function resolveViaYtmp3Mobi(url) {
  const id = new URL(normalizeYouTubeUrl(url)).searchParams.get('v')
  if (!id) throw new Error('ID YouTube tidak valid')
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://id.ytmp3.mobi',
    Referer: 'https://id.ytmp3.mobi/'
  }
  const initRes = await fetch(`https://a.ymcdn.org/api/v1/init?p=y&23=1llum1n471&_=${Date.now()}`, { headers, signal: AbortSignal.timeout(10000) })
  if (!initRes.ok) throw new Error(`YTMP3 init HTTP ${initRes.status}`)
  const init = await initRes.json()
  if (Number(init?.error) > 0 || !init?.convertURL) throw new Error(`YTMP3 init gagal (${init?.error ?? 'respons kosong'})`)
  let convertUrl = `${init.convertURL}&v=${encodeURIComponent(id)}&f=mp3&_=${Date.now()}`
  let converted = null
  for (let i = 0; i < 4; i++) {
    const response = await fetch(convertUrl, { headers, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`YTMP3 convert HTTP ${response.status}`)
    converted = await response.json()
    if (Number(converted?.error) > 0) throw new Error(`YTMP3 convert gagal (${converted.error})`)
    if (Number(converted?.redirect) > 0 && converted?.redirectURL) {
      convertUrl = `${converted.redirectURL}&v=${encodeURIComponent(id)}&f=mp3&_=${Date.now()}`
      continue
    }
    break
  }
  const progressUrl = converted?.progressURL
  if (!progressUrl || !isHttpUrl(progressUrl)) throw new Error('URL progres YTMP3 tidak ditemukan')
  let progress = 0
  let title = converted?.title || ''
  for (let i = 0; i < 25; i++) {
    await sleep(1000)
    const response = await fetch(progressUrl, { headers, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`YTMP3 status HTTP ${response.status}`)
    const status = await response.json()
    if (Number(status?.error) > 0) throw new Error(`YTMP3 proses gagal (${status.error})`)
    progress = Number(status?.progress || 0)
    if (status?.title) title = status.title
    if (progress >= 3) break
  }
  if (progress < 3) throw new Error('YTMP3 proses konversi timeout')
  const direct = findMediaUrl(converted?.downloadURL || converted?.downloadUrl)
  if (!direct) throw new Error('URL audio hasil YTMP3 tidak ditemukan')
  return { url: direct, title }
}

async function resolveViaYtbRip(url) {
  // Adaptasi dari scrape/ytdl.js milik Furina: jalur ytb.rip hanya dipakai
  // untuk opsi audio langsung. Opsi converter/SSE dihindari agar polling
  // tidak menggantung dan provider berikutnya masih bisa dicoba.
  const configTimestamp = '1771534846328'
  const hashSecret = 'c7d6fe8b7a87fd4129f36353253e4696b7ca4768d84a5cf5a3432775758ad5d2'
  const ts = String(Date.now())
  const signature = crypto.createHash('sha256').update(url + ts + hashSecret).digest('hex')
  const form = new URLSearchParams({ sf_url: url, ts, _ts: configTimestamp, _tsc: '0', _s: signature })
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id,en-US;q=0.9,en;q=0.8',
    Origin: 'https://ytb.rip',
    Referer: 'https://ytb.rip/',
    'Content-Type': 'application/x-www-form-urlencoded'
  }
  const { data } = await axios.post('https://ytb.rip/api/convert', form.toString(), {
    headers,
    timeout: 15000,
    maxContentLength: 4 * 1024 * 1024
  })
  const options = Array.isArray(data?.url) ? data.url : []
  const candidates = options.filter(option =>
    option && option.audio && !option.isConverterUI && isHttpUrl(option.url)
  ).sort((a, b) => {
    const score = item => Number(item.qualityNumber || item.bitrate || item.subname || 0) || 0
    return score(b) - score(a)
  })
  const selected = candidates.find(option => option.downloadable !== false) || candidates[0]
  const direct = selected && findMediaUrl(selected.url)
  if (!direct) throw new Error(data?.message || 'ytb.rip tidak menyediakan audio langsung')
  return {
    url: direct,
    title: data?.meta?.title || data?.title || '',
    ext: selected.ext || selected.type?.split(' ')[0] || 'm4a'
  }
}

// Provider adapters ported from Furina V18/fitur/youtubedl.js.
// Each provider is bounded by its own request timeouts and a short polling window
// so one unavailable third-party server cannot block all fallbacks.
async function resolveViaFurinaLbServer(url) {
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' }
  const { data } = await axios.get('https://p.lbserver.xyz/ajax/download.php', {
    params: { format: 'mp3', audio_quality: '128', url },
    headers,
    timeout: 9000,
    maxContentLength: 3 * 1024 * 1024
  })
  const progressUrl = data?.progress_url
  if (!progressUrl || !isHttpUrl(new URL(progressUrl, 'https://p.lbserver.xyz').toString())) {
    throw new Error(data?.message || 'LBServer tidak mengembalikan progress_url')
  }
  const pollUrl = new URL(progressUrl, 'https://p.lbserver.xyz').toString()
  for (let i = 0; i < 10; i++) {
    await sleep(900)
    const { data: progress } = await axios.get(pollUrl, {
      headers,
      timeout: 7000,
      maxContentLength: 3 * 1024 * 1024
    })
    const progressValue = Number(progress?.progress || 0)
    const direct = findMediaUrl(progress?.download_url || progress?.downloadUrl || progress?.url || progress)
    if (direct && (progressValue >= 1000 || progress?.status === 'completed' || progress?.success === true)) {
      return { url: direct, title: data?.title || data?.info?.title || '' }
    }
    if (/^(failed|error|cancelled)$/i.test(String(progress?.status || ''))) {
      throw new Error(progress?.message || 'LBServer gagal mengonversi audio')
    }
  }
  throw new Error('Timeout menunggu proses LBServer')
}

async function resolveViaFurinaSaveNow(url) {
  const apiKey = String(process.env.SAVENOW_API_KEY || 'dfcb6d76f2f6a9894gjkege8a4ab232222').trim()
  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' }
  const { data: init } = await axios.get('https://p.savenow.to/ajax/download.php', {
    params: { copyright: 0, format: 'mp3', url, api: apiKey },
    headers,
    timeout: 9000,
    maxContentLength: 3 * 1024 * 1024
  })
  const progressUrlRaw = init?.progress_url
  if (!progressUrlRaw) throw new Error(init?.message || 'SaveNow tidak mengembalikan progress_url')
  const progressUrl = new URL(progressUrlRaw, 'https://p.savenow.to').toString()
  for (let i = 0; i < 10; i++) {
    if (i) await sleep(900)
    const { data } = await axios.get(progressUrl, {
      headers,
      timeout: 7000,
      maxContentLength: 3 * 1024 * 1024
    })
    const direct = findMediaUrl(data?.download_url || data?.downloadUrl || data?.url || data)
    if ((data?.success === 1 || data?.success === true || data?.status === 'completed' || direct) && direct) {
      return { url: direct, title: init?.info?.title || init?.title || '' }
    }
    if (/^(failed|error|cancelled)$/i.test(String(data?.status || ''))) {
      throw new Error(data?.message || 'SaveNow gagal mengonversi audio')
    }
  }
  throw new Error('Timeout menunggu proses SaveNow')
}

async function resolveViaFurinaSSYoutube(url) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://ssyoutube.online',
    Referer: 'https://ssyoutube.online/en12/'
  }
  const detailResponse = await fetch('https://ssyoutube.online/yt-video-detail/', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ videoURL: url }),
    signal: AbortSignal.timeout(9000)
  })
  if (!detailResponse.ok) throw new Error(`SSYoutube detail HTTP ${detailResponse.status}`)
  const html = await detailResponse.text()
  const title = (html.match(/videoTitle[^>]*>(.*?)</i) || [])[1]?.replace(/&amp;/g, '&').trim() || ''
  const downloadResponse = await fetch('https://ssyoutube.online/wp-admin/admin-ajax.php', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ action: 'get_mp3_conversion_url', videoUrl: url }),
    signal: AbortSignal.timeout(9000)
  })
  if (!downloadResponse.ok) throw new Error(`SSYoutube MP3 HTTP ${downloadResponse.status}`)
  const payload = await downloadResponse.json()
  const direct = findMediaUrl(payload?.data?.url || payload?.data?.downloadUrl || payload)
  if (!direct) throw new Error(payload?.message || payload?.data?.message || 'SSYoutube tidak menyediakan URL audio')
  return { url: direct, title }
}

async function resolveViaFurinaYtdlpOnline(url) {
  const command = encodeURIComponent(`-x --audio-format mp3 ${url}`)
  const { data } = await axios.get(`https://ytdlp.online/stream?command=${command}`, {
    responseType: 'text',
    timeout: 10000,
    maxContentLength: 3 * 1024 * 1024,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain,*/*' }
  })
  const html = String(data || '')
  const match = html.match(/href=["']([^"']+\.(?:mp3|m4a|webm)(?:\?[^"']*)?)["']/i)
  if (!match?.[1]) throw new Error('YtDlp.online tidak memberikan tautan audio')
  const direct = new URL(match[1].replace(/&amp;/g, '&'), 'https://ytdlp.online').toString()
  if (!isHttpUrl(direct)) throw new Error('URL audio YtDlp.online tidak valid')
  return { url: direct, title: '' }
}

async function resolveViaDistube(url) {
  const ytdlCore = require('@distube/ytdl-core')
  const info = await withTimeout(ytdlCore.getInfo(url), 14000, 'Resolver ytdl-core')
  const formats = (info?.formats || []).filter(f => f?.url && f.hasAudio && !f.hasVideo)
    .sort((a, b) => {
      const score = f => (/audio\/mp4/i.test(f.mimeType || '') ? 100000 : 0) + Number(f.audioBitrate || 0)
      return score(b) - score(a)
    })
  const direct = formats.map(f => f.url).find(isHttpUrl)
  if (!direct) throw new Error('Format audio langsung tidak ditemukan')
  return { url: direct, title: info?.videoDetails?.title || '' }
}

function sniffAudio(buffer, contentType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null
  const type = String(contentType || '').split(';')[0].toLowerCase()
  if (buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return { mimetype: 'audio/mpeg', ext: 'mp3', isMp3: true }
  if (buffer.subarray(0, 4).toString() === 'OggS') return { mimetype: 'audio/ogg', ext: 'ogg', isMp3: false }
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return { mimetype: 'audio/wav', ext: 'wav', isMp3: false }
  if (buffer.subarray(4, 8).toString() === 'ftyp') return { mimetype: 'audio/mp4', ext: 'm4a', isMp3: false }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimetype: 'audio/webm', ext: 'webm', isMp3: false }
  if (buffer.subarray(0, 4).toString() === 'fLaC') return { mimetype: 'audio/flac', ext: 'flac', isMp3: false }
  if (type.startsWith('audio/')) return { mimetype: type, ext: type.split('/')[1].split('+')[0] || 'audio', isMp3: false }
  return null
}

async function transcodeToMp3(input) {
  let ffmpegPath
  try { ffmpegPath = require('ffmpeg-static') } catch { return null }
  if (!ffmpegPath) return null
  return new Promise(resolve => {
    let process
    try {
      process = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch { return resolve(null) }
    const chunks = []
    let length = 0
    let stderr = ''
    let done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value) }
    const timer = setTimeout(() => { try { process.kill('SIGKILL') } catch {}; finish(null) }, 30000)
    process.stdout.on('data', chunk => {
      length += chunk.length
      if (length > MAX_SEND_BYTES) { try { process.kill('SIGKILL') } catch {}; finish(null); return }
      chunks.push(chunk)
    })
    process.stderr.on('data', chunk => { if (stderr.length < 2000) stderr += chunk.toString() })
    process.on('error', () => finish(null))
    process.on('close', code => {
      if (code === 0 && length > 1000) finish(Buffer.concat(chunks))
      else finish(null)
    })
    process.stdin.on('error', () => {})
    process.stdin.end(input)
  })
}

async function normalizeAudioBuffer(inputBuffer, contentType = '') {
  let buffer = Buffer.isBuffer(inputBuffer) ? inputBuffer : Buffer.from(inputBuffer || [])
  if (!buffer.length) throw new Error('File audio kosong')
  if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('Ukuran audio melewati batas 30 MB')
  const leading = buffer.subarray(0, 300).toString('utf8').trimStart()
  if (/^(?:<!doctype\s+html|<html|<head|\{\s*"(?:error|message|status)")/i.test(leading)) {
    throw new Error('Provider mengembalikan halaman error, bukan file audio')
  }
  let detected = sniffAudio(buffer, contentType)
  if (!detected) {
    const converted = await transcodeToMp3(buffer)
    if (converted) return { buffer: converted, mimetype: 'audio/mpeg', ext: 'mp3' }
    throw new Error(`Respons bukan file audio yang dikenali (${contentType || 'MIME tidak diketahui'})`)
  }
  if (!detected.isMp3 || buffer.length > MAX_SEND_BYTES) {
    const converted = await transcodeToMp3(buffer)
    if (converted) return { buffer: converted, mimetype: 'audio/mpeg', ext: 'mp3' }
  }
  if (buffer.length > MAX_SEND_BYTES) throw new Error('Ukuran audio setelah diproses melebihi batas kirim 25 MB')
  return { buffer, mimetype: detected.mimetype, ext: detected.ext }
}

async function downloadMediaBuffer(url) {
  if (!isHttpUrl(url)) throw new Error('URL audio yang dikembalikan provider tidak valid')
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: REQUEST_TIMEOUT,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    maxBodyLength: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': USER_AGENT, Accept: 'audio/*,application/octet-stream,*/*', Referer: new URL(url).origin },
    validateStatus: status => status >= 200 && status < 300
  })
  return normalizeAudioBuffer(Buffer.from(response.data || []), response.headers?.['content-type'] || '')
}

// Fallback lokal menggunakan yt-dlp resmi. Bila tidak ada executable pada PATH,
// unduh binary Linux resmi sekali saja; kegagalan unduhan tidak mematikan fitur lain.
let ytDlpBootstrapBlockedUntil = 0
async function ensureLocalYtDlpBinary() {
  if (process.platform !== 'linux') return null
  const asset = process.arch === 'x64' ? 'yt-dlp_linux'
    : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64'
    : ''
  if (!asset) return null

  const binDir = path.join(__dirname, 'bin')
  const binaryPath = path.join(binDir, asset)
  try {
    if (fs.existsSync(binaryPath) && fs.statSync(binaryPath).size > 5 * 1024 * 1024) {
      try { fs.chmodSync(binaryPath, 0o755) } catch {}
      return binaryPath
    }
  } catch {}
  if (Date.now() < ytDlpBootstrapBlockedUntil) return null

  try {
    fs.mkdirSync(binDir, { recursive: true })
    const downloadUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 45 * 1024 * 1024,
      maxBodyLength: 45 * 1024 * 1024,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' }
    })
    const buffer = Buffer.from(response.data || [])
    if (buffer.length < 5 * 1024 * 1024 || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error('Respons unduhan yt-dlp bukan binary Linux ELF yang valid')
    }
    const tempPath = `${binaryPath}.${process.pid}.tmp`
    fs.writeFileSync(tempPath, buffer, { mode: 0o755 })
    fs.chmodSync(tempPath, 0o755)
    fs.renameSync(tempPath, binaryPath)
    console.log('[YTDLP BOOTSTRAP] Binary yt-dlp resmi berhasil disiapkan.')
    return binaryPath
  } catch (error) {
    ytDlpBootstrapBlockedUntil = Date.now() + 60 * 60 * 1000
    console.warn('[YTDLP BOOTSTRAP] Tidak dapat menyiapkan binary lokal; fallback API akan digunakan:', error?.message || error)
    return null
  }
}

async function resolveViaLocalYtDlp(sourceUrl, allowBootstrap = true, binaryOverride = '') {
  const asset = process.arch === 'x64' ? 'yt-dlp_linux' : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : ''
  const cachedBinary = asset ? path.join(__dirname, 'bin', asset) : ''
  const binary = String(process.env.YTDLP_PATH || binaryOverride || (cachedBinary && fs.existsSync(cachedBinary) ? cachedBinary : 'yt-dlp')).trim() || 'yt-dlp'
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-audio-'))
  const outputTemplate = path.join(tempDir, '%(id)s.%(ext)s')
  let stdout = ''
  let stderr = ''

  try {
    await new Promise((resolve, reject) => {
      let child
      let settled = false
      let timer
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn(value)
      }

      try {
        child = spawn(binary, [
          '--no-playlist',
          '--no-warnings',
          '--no-progress',
          '--format', 'bestaudio/best',
          '--max-filesize', '30M',
          '--output', outputTemplate,
          '--print', '%(title)s',
          '--print', 'after_move:filepath',
          sourceUrl
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        finish(reject, error)
        return
      }

      child.stdout?.on('data', chunk => {
        if (stdout.length < 10000) stdout += chunk.toString()
      })
      child.stderr?.on('data', chunk => {
        if (stderr.length < 3000) stderr += chunk.toString()
      })
      child.once('error', error => finish(reject, error))
      child.once('close', code => {
        if (code === 0) finish(resolve)
        else finish(reject, new Error(`yt-dlp exit code ${code}: ${stderr.trim().slice(-1200) || 'tidak ada detail error'}`))
      })
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        finish(reject, new Error('yt-dlp lokal timeout (45 detik)'))
      }, 45000)
    })

    // Utamakan path dari yt-dlp, lalu fallback ke file hasil di direktori sementara.
    const outputLines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    let filePath = outputLines.slice().reverse().find(line => {
      try { return path.isAbsolute(line) && fs.existsSync(line) && fs.statSync(line).isFile() } catch { return false }
    })
    const printedTitle = outputLines.find(line => line !== filePath && !path.isAbsolute(line)) || ''
    if (!filePath) {
      const files = fs.readdirSync(tempDir)
        .filter(name => !name.endsWith('.part') && !name.endsWith('.ytdl') && !name.endsWith('.json'))
        .map(name => path.join(tempDir, name))
        .filter(file => { try { return fs.statSync(file).isFile() } catch { return false } })
      filePath = files[0] || ''
    }
    if (!filePath) throw new Error('yt-dlp berhasil tetapi file audio tidak ditemukan')

    const ext = path.extname(filePath).slice(1).toLowerCase()
    const contentType = ext === 'mp3' ? 'audio/mpeg'
      : ['m4a', 'mp4'].includes(ext) ? 'audio/mp4'
      : ext === 'webm' ? 'audio/webm'
      : ext === 'ogg' ? 'audio/ogg'
      : ext === 'wav' ? 'audio/wav'
      : 'application/octet-stream'
    const media = await normalizeAudioBuffer(fs.readFileSync(filePath), contentType)
    return { ...media, title: printedTitle || path.basename(filePath, path.extname(filePath)) }
  } catch (error) {
    // ENOENT pada executable mencoba binary resmi sekali; jika jaringan gagal,
    // fallback ke provider lama tetap dilanjutkan dan percobaan bootstrap ditahan 1 jam.
    if (error?.code === 'ENOENT') {
      if (allowBootstrap && !process.env.YTDLP_PATH) {
        const downloadedBinary = await ensureLocalYtDlpBinary()
        if (downloadedBinary) return await resolveViaLocalYtDlp(sourceUrl, false, downloadedBinary)
      }
      return null
    }
    throw error
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
}

async function downloadYouTubeAudio(inputUrl) {
  const sourceUrl = normalizeYouTubeUrl(inputUrl)
  if (!sourceUrl) throw new Error('URL YouTube tidak valid')
  const failures = []

  try {
    const local = await resolveViaLocalYtDlp(sourceUrl)
    if (local?.buffer && Buffer.isBuffer(local.buffer) && local.buffer.length >= 1024) {
      return { ...local, provider: 'yt-dlp lokal', sourceUrl }
    }
  } catch (error) {
    failures.push(`yt-dlp lokal: ${error?.code || error?.message || 'gagal'}`)
    console.warn(`[MUSIC DOWNLOAD] yt-dlp lokal: ${error?.message || error}`)
  }

  const providers = [
    ['SaveTube', () => resolveViaSaveTube(sourceUrl), 10000],
    ['Vreden', () => resolveViaVreden(sourceUrl), 13000],
    ['Sanka', () => resolveViaSanka(sourceUrl), 10000],
    ['Skyzopedia', () => resolveViaSkyzopedia(sourceUrl), 10000],
    // Furina's ytmp3.gg / YtConvert adapter; keep a bounded wait for its poll API.
    ['YtConvert', () => resolveViaYtConvert(sourceUrl), 25000],
    ['Furina-LBServer', () => resolveViaFurinaLbServer(sourceUrl), 15000],
    ['Furina-SaveNow', () => resolveViaFurinaSaveNow(sourceUrl), 15000],
    ['Furina-SSYoutube', () => resolveViaFurinaSSYoutube(sourceUrl), 11000],
    ['Furina-YtDlp.online', () => resolveViaFurinaYtdlpOnline(sourceUrl), 12000],
    ['YTMP3.mobi', () => resolveViaYtmp3Mobi(sourceUrl), 25000],
    ['ytb.rip', () => resolveViaYtbRip(sourceUrl), 13000],
    ['Distube', () => resolveViaDistube(sourceUrl), 14000]
  ]
  const startedAt = Date.now()
  // Batas keseluruhan mencegah .play menggantung terlalu lama jika banyak API mati.
  const providerBudgetMs = Math.max(30000, Math.min(Number(process.env.MUSIC_PROVIDER_TIMEOUT_MS) || 90000, 120000))
  for (const [name, resolver, timeout] of providers) {
    const elapsed = Date.now() - startedAt
    const remaining = providerBudgetMs - elapsed
    if (remaining <= 0) break
    try {
      const resolved = await withTimeout(resolver(), Math.max(1000, Math.min(timeout, remaining)), `${name} resolver`)
      const directUrl = resolved?.url
      if (!isHttpUrl(directUrl) || isYouTubeUrl(directUrl)) throw new Error('URL audio tidak valid')
      const media = await withTimeout(downloadMediaBuffer(directUrl), Math.max(1000, Math.min(18000, providerBudgetMs - (Date.now() - startedAt))), `${name} download audio`)
      return {
        ...media,
        title: String(resolved?.title || '').trim(),
        provider: name,
        sourceUrl
      }
    } catch (error) {
      failures.push(`${name}: ${error?.response?.status || error?.code || error?.message || 'gagal'}`)
      console.warn(`[MUSIC DOWNLOAD] ${name}: ${error?.message || error}`)
    }
  }
  console.error('[MUSIC DOWNLOAD PROVIDERS FAILED]', failures.join(' | '))
  throw new Error('Semua penyedia audio gagal memberikan file yang valid. Coba lagi beberapa saat nanti.')
}


function isMp4Buffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
}

async function downloadDirectVideoBuffer(url) {
  if (!isHttpUrl(url)) throw new Error('URL video dari provider tidak valid')
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
    maxContentLength: MAX_VIDEO_DOWNLOAD_BYTES,
    maxBodyLength: MAX_VIDEO_DOWNLOAD_BYTES,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'video/mp4,video/*,application/octet-stream,*/*',
      Referer: new URL(url).origin
    },
    validateStatus: status => status >= 200 && status < 300
  })
  const buffer = Buffer.from(response.data || [])
  if (!buffer.length || buffer.length < 1024) throw new Error('File video kosong atau terlalu kecil')
  if (buffer.length > MAX_VIDEO_DOWNLOAD_BYTES) throw new Error('Ukuran video melebihi batas kirim 60 MB')
  const leading = buffer.subarray(0, 300).toString('utf8').trimStart()
  if (/^(?:<!doctype\s+html|<html|<head|\{\s*"(?:error|message|status)")/i.test(leading)) {
    throw new Error('Provider mengembalikan halaman error, bukan file video')
  }
  if (!isMp4Buffer(buffer)) throw new Error(`Respons provider bukan file MP4 yang valid (${response.headers?.['content-type'] || 'MIME tidak diketahui'})`)
  return { buffer, mimetype: 'video/mp4', ext: 'mp4', quality: '' }
}

async function resolveViaLocalYtDlpVideo(sourceUrl, allowBootstrap = true, binaryOverride = '') {
  const asset = process.arch === 'x64' ? 'yt-dlp_linux' : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : ''
  const cachedBinary = asset ? path.join(__dirname, 'bin', asset) : ''
  const binary = String(process.env.YTDLP_PATH || binaryOverride || (cachedBinary && fs.existsSync(cachedBinary) ? cachedBinary : 'yt-dlp')).trim() || 'yt-dlp'
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-video-'))
  const outputTemplate = path.join(tempDir, '%(id)s.%(ext)s')
  let stdout = ''
  let stderr = ''
  let ffmpegPath = ''
  try { ffmpegPath = require('ffmpeg-static') || '' } catch {}

  try {
    await new Promise((resolve, reject) => {
      let child
      let settled = false
      let timer
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        fn(value)
      }
      const args = [
        '--no-playlist', '--no-warnings', '--no-progress',
        '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2',
        '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best[ext=mp4][height<=720]',
        '--merge-output-format', 'mp4',
        '--max-filesize', '60M',
        '--output', outputTemplate,
        '--print', '%(title)s',
        '--print', '%(height)sp',
        '--print', 'after_move:filepath'
      ]
      if (ffmpegPath && fs.existsSync(ffmpegPath)) args.push('--ffmpeg-location', ffmpegPath)
      args.push(sourceUrl)

      try {
        child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        finish(reject, error)
        return
      }
      child.stdout?.on('data', chunk => { if (stdout.length < 10000) stdout += chunk.toString() })
      child.stderr?.on('data', chunk => { if (stderr.length < 5000) stderr += chunk.toString() })
      child.once('error', error => finish(reject, error))
      child.once('close', code => {
        if (code === 0) finish(resolve)
        else finish(reject, new Error(`yt-dlp MP4 exit code ${code}: ${stderr.trim().slice(-1200) || 'tidak ada detail error'}`))
      })
      timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        finish(reject, new Error('Download video timeout (120 detik)'))
      }, 120000)
    })

    const outputLines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    let filePath = outputLines.slice().reverse().find(line => {
      try { return path.isAbsolute(line) && fs.existsSync(line) && fs.statSync(line).isFile() } catch { return false }
    })
    if (!filePath) {
      const files = fs.readdirSync(tempDir)
        .filter(name => /\.mp4$/i.test(name) && !/\.(?:part|ytdl|json)$/i.test(name))
        .map(name => path.join(tempDir, name))
        .filter(file => { try { return fs.statSync(file).isFile() } catch { return false } })
      filePath = files[0] || ''
    }
    if (!filePath) throw new Error('yt-dlp selesai tetapi file MP4 tidak ditemukan')
    const stat = fs.statSync(filePath)
    if (stat.size < 1024) throw new Error('File MP4 hasil download kosong')
    if (stat.size > MAX_VIDEO_DOWNLOAD_BYTES) throw new Error('Ukuran video melebihi batas kirim 60 MB')
    const buffer = fs.readFileSync(filePath)
    if (!isMp4Buffer(buffer)) throw new Error('File hasil yt-dlp bukan MP4 valid atau audio/video belum tergabung')

    const title = outputLines.find(line => line && line !== filePath && !path.isAbsolute(line) && !/^\d+p$/i.test(line)) || path.basename(filePath, path.extname(filePath))
    const quality = outputLines.find(line => /^\d+p$/i.test(line)) || ''
    return { buffer, title, mimetype: 'video/mp4', ext: 'mp4', quality, provider: 'yt-dlp lokal', sourceUrl }
  } catch (error) {
    if (error?.code === 'ENOENT' && allowBootstrap && !process.env.YTDLP_PATH) {
      const downloadedBinary = await ensureLocalYtDlpBinary()
      if (downloadedBinary) return await resolveViaLocalYtDlpVideo(sourceUrl, false, downloadedBinary)
      return null
    }
    throw error
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
}

async function resolveViaVredenVideo(sourceUrl) {
  const scraper = require('@vreden/youtube_scraper')
  if (typeof scraper?.ytmp4 !== 'function') throw new Error('ytmp4() dari @vreden/youtube_scraper tidak tersedia')
  const result = await withTimeout(scraper.ytmp4(sourceUrl, '720'), 18000, 'Resolver video Vreden')
  const direct = findMediaUrl(result)
  if (!direct) throw new Error(result?.message || result?.error || 'Respons Vreden tidak berisi URL video')
  return { url: direct, title: result?.title || result?.result?.title || result?.data?.title || '', quality: result?.quality || result?.resolution || '' }
}

async function resolveViaRuhendVideo(sourceUrl) {
  const scraper = require('ruhend-scraper')
  if (typeof scraper?.ytmp4 !== 'function') throw new Error('ytmp4() dari ruhend-scraper tidak tersedia')
  const result = await withTimeout(scraper.ytmp4(sourceUrl), 18000, 'Resolver video Ruhend')
  const direct = findMediaUrl(result)
  if (!direct) throw new Error(result?.message || result?.error || 'Respons Ruhend tidak berisi URL video')
  return { url: direct, title: result?.title || result?.result?.title || result?.data?.title || '', quality: result?.quality || result?.resolution || '' }
}

async function resolveViaDistubeVideo(sourceUrl) {
  const ytdlCore = require('@distube/ytdl-core')
  const info = await withTimeout(ytdlCore.getInfo(sourceUrl), 18000, 'Resolver ytdl-core video')
  const formats = (info?.formats || []).filter(format => {
    if (!format?.url || !format.hasAudio || !format.hasVideo || String(format.container || '').toLowerCase() !== 'mp4') return false
    const height = Number(format.height || 0)
    const length = Number(format.contentLength || 0)
    return height > 0 && height <= 1080 && (!length || length <= MAX_VIDEO_DOWNLOAD_BYTES)
  }).sort((a, b) => Number(b.height || 0) - Number(a.height || 0))
  const picked = formats[0]
  if (!picked) throw new Error('Format MP4 dengan audio gabungan tidak ditemukan dari ytdl-core')
  return { url: picked.url, title: info?.videoDetails?.title || '', quality: picked.qualityLabel || (picked.height ? `${picked.height}p` : '') }
}

// Normalize every downloaded video to a WhatsApp-friendly MP4.
// Some providers return MP4 containers carrying VP9/AV1 video or non-standard
// audio tracks. The file can upload successfully but fail when WhatsApp plays it.
async function transcodeToWhatsAppMp4(inputBuffer) {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.length < 1024) {
    throw new Error('Buffer video tidak valid untuk konversi MP4')
  }
  if (inputBuffer.length > MAX_VIDEO_DOWNLOAD_BYTES) {
    throw new Error('Ukuran video sumber melebihi batas 60 MB')
  }

  let ffmpegBinary = ''
  try {
    const staticBinary = require('ffmpeg-static')
    if (typeof staticBinary === 'string' && staticBinary.trim() && fs.existsSync(staticBinary)) {
      ffmpegBinary = staticBinary
    }
  } catch {}
  if (!ffmpegBinary) ffmpegBinary = String(process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg'

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-play-mp4-'))
  const inputPath = path.join(tempDir, 'source.mp4')
  const outputPath = path.join(tempDir, 'whatsapp-ready.mp4')
  fs.writeFileSync(inputPath, inputBuffer)

  const encode = (crf, maxRateKbps) => new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0',
      '-sn', '-dn',
      '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '3.1',
      '-pix_fmt', 'yuv420p', '-crf', String(crf),
      '-maxrate', `${maxRateKbps}k`, '-bufsize', `${maxRateKbps * 2}k`,
      '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '44100',
      '-movflags', '+faststart', '-max_muxing_queue_size', '1024',
      outputPath
    ]
    let child
    let stderr = ''
    let settled = false
    let timer
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(value)
    }
    try {
      child = spawn(ffmpegBinary, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    } catch (error) {
      finish(reject, error)
      return
    }
    child.stderr?.on('data', chunk => {
      if (stderr.length < 6000) stderr += chunk.toString()
    })
    child.once('error', error => finish(reject, error))
    child.once('close', code => {
      if (code === 0) finish(resolve)
      else finish(reject, new Error(`FFmpeg gagal menyiapkan video (exit ${code}): ${stderr.trim().slice(-1000) || 'codec tidak didukung atau FFmpeg tidak tersedia'}`))
    })
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish(reject, new Error('Konversi MP4 melewati batas waktu 150 detik'))
    }, 150000)
  })

  try {
    // First encode aims for a good balance between quality and WhatsApp size.
    // If a long video is still too large, use a smaller bitrate once more.
    for (const profile of [{ crf: 27, rate: 1600 }, { crf: 31, rate: 900 }]) {
      try { fs.rmSync(outputPath, { force: true }) } catch {}
      await encode(profile.crf, profile.rate)
      const stat = fs.statSync(outputPath)
      if (stat.size < 1024) throw new Error('FFmpeg menghasilkan file kosong')
      if (stat.size > 58 * 1024 * 1024) continue
      const buffer = fs.readFileSync(outputPath)
      if (!isMp4Buffer(buffer)) throw new Error('Hasil konversi bukan kontainer MP4 yang valid')
      return { buffer, mimetype: 'video/mp4', ext: 'mp4', codec: 'H.264/AAC', quality: 'MP4 kompatibel • maks. 720p' }
    }
    throw new Error('Ukuran hasil MP4 tetap melebihi batas kirim WhatsApp setelah kompresi')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('FFmpeg tidak ditemukan. Pastikan dependensi ffmpeg-static terpasang atau FFMPEG_PATH diatur dengan benar.')
    }
    throw error
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
}

async function downloadYouTubeVideo(inputUrl) {
  const sourceUrl = normalizeYouTubeUrl(inputUrl)
  if (!sourceUrl) throw new Error('URL YouTube tidak valid')
  const failures = []
  const attempts = [
    ['yt-dlp lokal', async () => {
      const media = await resolveViaLocalYtDlpVideo(sourceUrl)
      if (!media?.buffer || !Buffer.isBuffer(media.buffer)) throw new Error('yt-dlp tidak tersedia atau tidak menghasilkan file video')
      return media
    }],
    ['Vreden', async () => {
      const resolved = await resolveViaVredenVideo(sourceUrl)
      const media = await downloadDirectVideoBuffer(resolved.url)
      return { ...media, title: resolved.title || '', quality: resolved.quality || media.quality, provider: 'Vreden', sourceUrl }
    }],
    ['Ruhend', async () => {
      const resolved = await resolveViaRuhendVideo(sourceUrl)
      const media = await downloadDirectVideoBuffer(resolved.url)
      return { ...media, title: resolved.title || '', quality: resolved.quality || media.quality, provider: 'Ruhend', sourceUrl }
    }],
    ['Distube', async () => {
      const resolved = await resolveViaDistubeVideo(sourceUrl)
      const media = await downloadDirectVideoBuffer(resolved.url)
      return { ...media, title: resolved.title || '', quality: resolved.quality || media.quality, provider: 'Distube', sourceUrl }
    }]
  ]
  for (const [name, resolver] of attempts) {
    try {
      const media = await resolver()
      if (!Buffer.isBuffer(media?.buffer) || media.buffer.length < 1024 || !isMp4Buffer(media.buffer)) {
        throw new Error('Buffer MP4 hasil provider tidak valid')
      }
      if (media.buffer.length > MAX_VIDEO_DOWNLOAD_BYTES) throw new Error('Ukuran video melebihi batas kirim 60 MB')
      const compatible = await transcodeToWhatsAppMp4(media.buffer)
      if (!Buffer.isBuffer(compatible?.buffer) || compatible.buffer.length < 1024 || !isMp4Buffer(compatible.buffer)) {
        throw new Error('Hasil konversi MP4 tidak valid')
      }
      if (compatible.buffer.length > 58 * 1024 * 1024) throw new Error('Ukuran hasil MP4 melebihi batas aman WhatsApp')
      return {
        ...media,
        ...compatible,
        title: String(media.title || '').trim(),
        mimetype: 'video/mp4',
        ext: 'mp4',
        sourceUrl
      }
    } catch (error) {
      failures.push(`${name}: ${error?.response?.status || error?.code || error?.message || 'gagal'}`)
      console.warn(`[PLAY MP4 DOWNLOAD] ${name}: ${error?.message || error}`)
    }
  }
  console.error('[PLAY MP4 PROVIDERS FAILED]', failures.join(' | '))
  throw new Error('Semua penyedia video gagal atau tidak mengembalikan MP4 valid. Video juga harus berukuran maksimal 60 MB agar dapat dikirim lewat WhatsApp.')
}

let spotifyTokenCache = { token: '', expiresAt: 0 }
async function getSpotifyToken() {
  const cfg = global.spotifyConfig || {}
  const clientId = String(process.env.SPOTIFY_CLIENT_ID || cfg.clientId || '').trim()
  const clientSecret = String(process.env.SPOTIFY_CLIENT_SECRET || cfg.clientSecret || '').trim()
  if (!clientId || !clientSecret) throw new Error('Kredensial Spotify belum diatur')
  if (spotifyTokenCache.token && spotifyTokenCache.expiresAt > Date.now() + 30000) return spotifyTokenCache.token
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const { data } = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000
  })
  if (!data?.access_token) throw new Error('Spotify tidak memberikan access token')
  spotifyTokenCache = { token: data.access_token, expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 60) * 1000 }
  return spotifyTokenCache.token
}

async function searchSpotifyTracks(query, limit = 8) {
  const q = String(query || '').trim()
  if (!q) throw new Error('Masukkan judul atau artis lagu Spotify')
  const max = Math.max(1, Math.min(Number(limit) || 8, 10))
  try {
    const token = await getSpotifyToken()
    const { data } = await axios.get('https://api.spotify.com/v1/search', {
      params: { q, type: 'track', limit: max, market: global.spotifyConfig?.market || 'ID' },
      headers: { Authorization: `Bearer ${token}` }, timeout: 18000
    })
    const items = data?.tracks?.items || []
    if (items.length) return items.map(item => ({
      title: item.name || 'Spotify Track',
      artist: (item.artists || []).map(a => a.name).filter(Boolean).join(', ') || 'Unknown Artist',
      album: item.album?.name || '',
      duration: Math.floor(Number(item.duration_ms || 0) / 60000) + ':' + String(Math.floor((Number(item.duration_ms || 0) % 60000) / 1000)).padStart(2, '0'),
      thumbnail: item.album?.images?.[0]?.url || '',
      url: item.external_urls?.spotify || ''
    })).filter(x => x.url)
  } catch (error) {
    console.warn('[SPOTIFY SEARCH OFFICIAL FALLBACK]', error?.response?.status || error?.message || error)
  }
  try {
    const data = await fetchJson(`https://api.nexray.web.id/search/spotify?q=${encodeURIComponent(q)}`, { timeout: 15000 })
    const items = Array.isArray(data?.result) ? data.result : (Array.isArray(data?.data) ? data.data : [])
    const normalized = items.map(item => ({
      title: String(item.title || item.name || 'Spotify Track'),
      artist: String(item.artist || item.artists || 'Unknown Artist'),
      album: String(item.album || item.album_name || ''),
      duration: String(item.duration || '-'),
      thumbnail: String(item.thumbnail || item.image || ''),
      url: String(item.url || item.link || item.external_urls?.spotify || '')
    })).filter(item => /^https?:\/\/(open\.)?spotify\.com\//i.test(item.url)).slice(0, max)
    if (normalized.length) return normalized
  } catch (error) {
    console.warn('[SPOTIFY SEARCH FALLBACK FAILED]', error?.message || error)
  }
  throw new Error('Pencarian Spotify sedang tidak tersedia. Periksa kredensial Spotify atau coba lagi nanti.')
}

function validSpotifyTrackUrl(input) {
  try {
    const url = new URL(String(input || '').trim())
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    if (!['open.spotify.com', 'spotify.link'].includes(host)) return ''
    const match = url.pathname.match(/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})/i)
    if (match) return `https://open.spotify.com/track/${match[1]}`
    return ''
  } catch { return '' }
}

async function resolveSpotmate(trackUrl) {
  const home = await axios.get('https://spotmate.online/', {
    timeout: 15000,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }
  })
  const cookieParts = (home.headers?.['set-cookie'] || []).map(value => String(value).split(';')[0]).filter(Boolean)
  const $ = cheerio.load(home.data || '')
  let csrf = $('meta[name="csrf-token"]').attr('content') || $('meta[name="_token"]').attr('content') || ''
  if (!csrf) csrf = String(home.data || '').match(/csrf-token["']?\s*content=["']([^"']+)/i)?.[1] || ''
  const cookieFromHeader = cookieParts.join('; ')
  if (!csrf) {
    const xsrf = cookieFromHeader.match(/XSRF-TOKEN=([^;]+)/)?.[1]
    if (xsrf) csrf = decodeURIComponent(xsrf)
  }
  const headers = {
    'User-Agent': USER_AGENT,
    Origin: 'https://spotmate.online',
    Referer: 'https://spotmate.online/',
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(csrf ? { 'X-CSRF-TOKEN': csrf, 'X-XSRF-TOKEN': csrf } : {}),
    ...(cookieFromHeader ? { Cookie: cookieFromHeader } : {})
  }
  const [trackResponse, convertResponse] = await Promise.all([
    axios.post('https://spotmate.online/getTrackData', { spotify_url: trackUrl }, { headers, timeout: 20000 }),
    axios.post('https://spotmate.online/convert', { urls: trackUrl }, { headers, timeout: 25000 })
  ])
  const metadata = trackResponse.data || {}
  const direct = findMediaUrl(convertResponse.data?.file || convertResponse.data?.url || convertResponse.data?.link || convertResponse.data)
  if (!direct) throw new Error(convertResponse.data?.message || 'Spotmate tidak mengembalikan tautan audio')
  return {
    url: direct,
    title: metadata.name || metadata.title || 'Spotify Audio',
    artist: (metadata.artists || []).map(a => typeof a === 'string' ? a : a.name).filter(Boolean).join(', ') || metadata.artist || 'Unknown Artist',
    thumbnail: metadata.album?.images?.[0]?.url || metadata.thumbnail || ''
  }
}

async function resolveNexraySpotify(trackUrl) {
  const candidates = [
    `https://api.nexray.eu.cc/downloader/spotify?url=${encodeURIComponent(trackUrl)}`,
    `https://api.nexray.web.id/download/spotify?url=${encodeURIComponent(trackUrl)}`
  ]
  let lastError
  for (const endpoint of candidates) {
    try {
      const data = await fetchJson(endpoint, { timeout: 18000 })
      const direct = findMediaUrl(data)
      if (!direct) throw new Error(data?.message || data?.msg || 'Respons NexRay tidak berisi URL audio')
      const result = data?.result || data?.data || data
      return {
        url: direct,
        title: result?.title || result?.name || 'Spotify Audio',
        artist: result?.artist || result?.artists || 'Unknown Artist',
        thumbnail: result?.thumbnail || result?.cover || ''
      }
    } catch (error) { lastError = error }
  }
  throw lastError || new Error('NexRay Spotify tidak tersedia')
}

async function downloadSpotifyAudio(input) {
  const trackUrl = validSpotifyTrackUrl(input)
  if (!trackUrl) throw new Error('Link Spotify harus berupa tautan track Spotify yang valid')
  const attempts = [
    ['Furina multi-scraper', async () => {
      const scraper = require('./spotify-scraper.js')
      const result = await withTimeout(scraper.spotifyScrape(trackUrl), 110000, 'Scraper Spotify Furina')
      const media = await normalizeAudioBuffer(result.audioBuffer, result?.song?.mimetype || '')
      return {
        ...media,
        title: result?.song?.title || 'Spotify Audio',
        artist: result?.song?.artist || 'Unknown Artist',
        thumbnail: result?.song?.thumbnail || '',
        sourceUrl: trackUrl
      }
    }],
    ['Spotmate', async () => {
      const result = await resolveSpotmate(trackUrl)
      const media = await downloadMediaBuffer(result.url)
      return { ...media, title: result.title, artist: result.artist, thumbnail: result.thumbnail, sourceUrl: trackUrl }
    }],
    ['NexRay', async () => {
      const result = await resolveNexraySpotify(trackUrl)
      const media = await downloadMediaBuffer(result.url)
      return { ...media, title: result.title, artist: result.artist, thumbnail: result.thumbnail, sourceUrl: trackUrl }
    }]
  ]
  const failures = []
  for (const [name, resolver] of attempts) {
    try {
      const result = await resolver()
      if (!Buffer.isBuffer(result?.buffer) || !result.buffer.length) throw new Error('Buffer audio tidak valid')
      return {
        ...result,
        title: result.title || 'Spotify Audio',
        artist: result.artist || 'Unknown Artist',
        thumbnail: result.thumbnail || '',
        sourceUrl: trackUrl,
        provider: name
      }
    } catch (error) {
      failures.push(`${name}: ${error?.response?.status || error?.code || error?.message || 'gagal'}`)
      console.warn(`[SPOTIFY DOWNLOAD] ${name}: ${error?.message || error}`)
    }
  }
  console.error('[SPOTIFY DOWNLOAD PROVIDERS FAILED]', failures.join(' | '))
  throw new Error('Semua penyedia download Spotify gagal. Coba lagi beberapa saat nanti.')
}

module.exports = {
  searchYouTubeMusic,
  normalizeYouTubeUrl,
  normalizeYouTubeResult,
  downloadYouTubeAudio,
  downloadYouTubeVideo,
  searchSpotifyTracks,
  validSpotifyTrackUrl,
  normalizeAudioBuffer,
  downloadSpotifyAudio
}
