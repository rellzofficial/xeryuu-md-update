'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const os = require('os');

const DATA_DIR = path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'furina-randompics');
const TIKTOK_PHOTO_DIR = path.join(DATA_DIR, 'furina-tiktokpics');
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const requestCache = new Map();

const PHOTO_DATASETS = Object.freeze({
  aesthetic: ['furina-randompics', 'aesthetic.json'],
  antiwork: ['furina-randompics', 'antiwork.json'],
  bike: ['furina-randompics', 'bike.json'],
  blackpink: ['furina-randompics', 'blackpink.json'],
  boneka: ['furina-randompics', 'boneka.json'],
  cat: ['furina-randompics', 'cat.json'],
  justina: ['furina-randompics', 'justina.json'],
  couplepic: ['furina-randompics', 'ppcouple.json'],
  profilepic: ['furina-randompics', 'profile.json'],
  pubg: ['furina-randompics', 'pubg.json'],
  randomboy: ['furina-tiktokpics', 'random2.json'],
  randomgirl: ['furina-tiktokpics', 'random.json'],
  rose: ['furina-randompics', 'rose.json'],
  ryujin: ['furina-randompics', 'ryujin.json'],
  ulzzangboy: ['furina-randompics', 'ulzzangboy.json'],
  ulzzanggirl: ['furina-randompics', 'ulzzanggirl.json'],
  wallml: ['furina-randompics', 'wallml.json'],
  wallphone: ['furina-randompics', 'wallhp.json']
});

const WIKIMEDIA_QUERIES = Object.freeze({
  '8ballpool': '8 ball pool game artwork',
  cat: 'domestic cat photograph',
  kpop: 'K-pop performance photography',
  hacking: 'cybersecurity coding illustration',
  squirrel: 'squirrel animal photograph',
  art: 'digital art illustration',
  bts: 'BTS music group',
  exo: 'EXO music group',
  jennie: 'Jennie singer Blackpink',
  jiso: 'Jisoo singer Blackpink',
  lisa: 'Lisa singer Blackpink',
  mountain: 'mountain landscape',
  programming: 'computer programming code',
  satanic: 'gothic occult symbol artwork',
  islamic: 'Islamic geometric art',
  space: 'outer space nebula',
  squirrel: 'squirrel animal',
  technology: 'technology computer hardware',
  wallpaper: '',
  wikimedia: ''
});

function clean(value, max = 180) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function getAxios() {
  try {
    return require('axios');
  } catch (error) {
    const wrapped = new Error('Dependensi axios belum terpasang. Jalankan npm install dari folder Xeryuu-Md.');
    wrapped.cause = error;
    throw wrapped;
  }
}

function validPublicUrl(value, options = {}) {
  const raw = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error('URL tidak valid. Gunakan alamat http:// atau https:// yang benar.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('URL harus memakai HTTP/HTTPS tanpa kredensial.');
  }
  const host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') {
    throw new Error('Alamat lokal/privat tidak didukung.');
  }
  if (net.isIP(host)) {
    if (host.includes(':')) {
      const ip = host.toLowerCase();
      if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
        throw new Error('Alamat IP lokal/privat tidak didukung.');
      }
    } else {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
        throw new Error('Alamat IP lokal/privat tidak didukung.');
      }
    }
  }
  parsed.hash = '';
  if (options.hosts) {
    const allowed = options.hosts.some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!allowed) throw new Error(`URL harus berasal dari: ${options.hosts.join(', ')}.`);
  }
  return parsed;
}

function bufferLooksLikeImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return false;
  return (
    (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    buffer.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/) !== null ||
    (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') ||
    buffer.subarray(4, 12).toString('ascii') === 'ftypavif'
  );
}

async function fetchImage(url) {
  const axios = getAxios();
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: { 'User-Agent': 'Xeryuu-Md/17.0 (+https://github.com/)' }
  });
  const bytes = Buffer.from(response.data || []);
  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Gambar dari penyedia melebihi batas 10 MB.');
  if (!contentType.startsWith('image/') && !bufferLooksLikeImage(bytes)) {
    throw new Error('Penyedia tidak mengirim file gambar yang valid.');
  }
  if (!bufferLooksLikeImage(bytes)) throw new Error('Data gambar rusak atau formatnya tidak didukung.');
  return bytes;
}

async function sendImage(ctx, url, caption) {
  const image = await fetchImage(url);
  await ctx.conn.sendMessage(ctx.m.chat, { image, caption }, { quoted: ctx.m });
}

function resolveDatasetPath(command) {
  const record = PHOTO_DATASETS[command];
  if (!record) return null;
  const base = record[0] === 'furina-randompics' ? PHOTO_DIR : TIKTOK_PHOTO_DIR;
  const file = path.resolve(base, record[1]);
  const expectedBase = path.resolve(base) + path.sep;
  if (!file.startsWith(expectedBase)) return null;
  return file;
}

function readPhotoUrls(command) {
  const file = resolveDatasetPath(command);
  if (!file || !fs.existsSync(file)) return [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item?.url || '').trim())
    .filter((url) => /^https:\/\//i.test(url))
    .slice(0, 500);
}

async function randomCommonsUrl(query) {
  const axios = getAxios();
  const { data } = await axios.get('https://commons.wikimedia.org/w/api.php', {
    params: {
      action: 'query', format: 'json', formatversion: 2,
      generator: 'search', gsrsearch: `filetype:bitmap ${clean(query, 160)}`,
      gsrnamespace: 6, gsrlimit: 20,
      prop: 'imageinfo', iiprop: 'url|mime|size', iiurlwidth: 1280
    },
    timeout: 15000,
    maxContentLength: 2 * 1024 * 1024,
    headers: { 'User-Agent': 'Xeryuu-Md/17.0 (image-search command)' }
  });
  const pages = Array.isArray(data?.query?.pages) ? data.query.pages : Object.values(data?.query?.pages || {});
  const matches = pages.map((page) => ({
    title: clean(page?.title || 'Wikimedia Commons', 120),
    url: String(page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url || '').trim(),
    mime: String(page?.imageinfo?.[0]?.mime || '').toLowerCase()
  })).filter((item) => /^https:\/\//i.test(item.url) && (!item.mime || item.mime.startsWith('image/')) && !item.url.toLowerCase().endsWith('.svg'));
  if (!matches.length) throw new Error('Tidak ditemukan gambar publik yang cocok di Wikimedia Commons.');
  return matches[Math.floor(Math.random() * matches.length)];
}

async function handlePhoto(command, ctx) {
  const title = command.replace(/([a-z])([A-Z])/g, '$1 $2');
  const urls = readPhotoUrls(command);
  if (urls.length) {
    // Retry a few entries because older public image links may have expired.
    const shuffled = urls.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(4, urls.length));
    let lastError;
    for (const url of shuffled) {
      try {
        await sendImage(ctx, url, `🖼️ ${title}\nSumber: koleksi gambar lokal Xeryuu-Md.`);
        return true;
      } catch (error) { lastError = error; }
    }
    if (!WIKIMEDIA_QUERIES[command] && !ctx.text) {
      throw new Error(`Tautan gambar untuk ${command} tidak tersedia saat ini${lastError?.message ? ` (${lastError.message})` : ''}.`);
    }
  }

  let query = WIKIMEDIA_QUERIES[command];
  if (command === 'wallpaper' || command === 'wikimedia') {
    query = clean(ctx.text, 160);
    if (!query) throw new Error(`Masukkan kata kunci. Contoh: ${ctx.prefix}${command} pemandangan gunung.`);
  }
  if (!query && command === 'coffee') query = 'coffee cup coffee beans';
  if (!query && command === 'catmeow') query = 'domestic cat';
  if (!query && command === 'lizardpic') query = 'lizard';
  if (!query && (command === 'goose' || command === 'goosebird')) query = 'goose bird';
  if (!query && command === '8ballpool') query = '8 ball pool game';
  if (!query && command === 'dogwoof') query = 'dog';
  if (!query && command === 'squirrel') query = 'squirrel';
  if (!query) query = command.replace(/([a-z])([A-Z])/g, '$1 $2');

  if (command === 'coffee') {
    try {
      await sendImage(ctx, 'https://coffee.alexflipnote.dev/random', '☕ Random coffee');
      return true;
    } catch {}
  }
  if (command === 'dogwoof') {
    try {
      const axios = getAxios();
      const { data } = await axios.get('https://dog.ceo/api/breeds/image/random', { timeout: 12000, maxContentLength: 1024 * 1024 });
      if (data?.status === 'success' && /^https:\/\//i.test(String(data.message || ''))) {
        await sendImage(ctx, data.message, '🐶 Random dog');
        return true;
      }
    } catch {}
  }
  if (command === 'catmeow') {
    try {
      const axios = getAxios();
      const { data } = await axios.get('https://api.thecatapi.com/v1/images/search', { timeout: 12000, maxContentLength: 1024 * 1024 });
      const url = Array.isArray(data) ? String(data[0]?.url || '') : '';
      if (/^https:\/\//i.test(url)) {
        await sendImage(ctx, url, '🐱 Random cat');
        return true;
      }
    } catch {}
  }

  const match = await randomCommonsUrl(query);
  await sendImage(ctx, match.url, `🖼️ ${match.title}\nSumber: Wikimedia Commons`);
  return true;
}

async function handleAnime(ctx) {
  const query = clean(ctx.text, 120);
  if (!query) throw new Error(`Gunakan: ${ctx.prefix}anime <judul anime>. Contoh: ${ctx.prefix}anime Naruto`);
  const axios = getAxios();
  const { data } = await axios.get('https://api.jikan.moe/v4/anime', {
    params: { q: query, limit: 8, sfw: true },
    timeout: 15000,
    maxContentLength: 3 * 1024 * 1024
  });
  const results = Array.isArray(data?.data) ? data.data : [];
  if (!results.length) throw new Error(`Anime dengan kata kunci "${query}" tidak ditemukan.`);
  const lines = [`🔎 HASIL PENCARIAN ANIME: ${query}`, ''];
  results.slice(0, 8).forEach((anime, index) => {
    const score = Number.isFinite(Number(anime?.score)) ? Number(anime.score).toFixed(1) : '-';
    const year = anime?.year || anime?.aired?.prop?.from?.year || '-';
    lines.push(`${index + 1}. *${clean(anime?.title || 'Tanpa judul', 140)}*`);
    lines.push(`⭐ Skor: ${score} | Tahun: ${year} | Episode: ${anime?.episodes ?? '-'}`);
    if (anime?.url && /^https:\/\//i.test(anime.url)) lines.push(`🔗 ${anime.url}`);
    const synopsis = clean(anime?.synopsis || '', 180);
    if (synopsis) lines.push(`📝 ${synopsis}${String(anime?.synopsis || '').length > 180 ? '…' : ''}`);
    lines.push('');
  });
  await ctx.reply(lines.join('\n').slice(0, 3800));
  return true;
}

async function handleLoker(ctx) {
  const raw = clean(ctx.text, 120);
  if (!raw) throw new Error(`Gunakan: ${ctx.prefix}loker <pekerjaan> <kota>. Contoh: ${ctx.prefix}loker kasir Lampung`);
  let job, city;
  if (raw.includes('|')) {
    const parts = raw.split('|');
    job = clean(parts.shift(), 60);
    city = clean(parts.join('|'), 60);
  } else {
    const parts = raw.split(/\s+/);
    job = clean(parts.shift(), 60);
    city = clean(parts.join(' '), 60);
  }
  if (!job || !city) throw new Error(`Pekerjaan dan kota wajib diisi. Contoh: ${ctx.prefix}loker kasir Lampung atau ${ctx.prefix}loker customer service|Jakarta`);
  const axios = getAxios();
  const { data } = await axios.get('https://api.nekolabs.web.id/discovery/jobstreet/search', {
    params: { job, city }, timeout: 18000, maxContentLength: 4 * 1024 * 1024
  });
  const jobs = Array.isArray(data?.result) ? data.result.slice(0, 10) : [];
  if (data?.success !== true || !jobs.length) throw new Error(`Tidak ditemukan lowongan untuk "${job}" di "${city}" atau penyedia sedang tidak tersedia.`);
  const lines = [`🔎 LOWONGAN KERJA: ${job.toUpperCase()} (${city})`, `Menampilkan ${jobs.length} hasil teratas`, ''];
  for (const item of jobs) {
    const id = String(item?.id || '').replace(/[^a-zA-Z0-9-]/g, '');
    lines.push(`📌 *${clean(item?.title || 'Tanpa judul', 140)}*`);
    lines.push(`🏢 ${clean(item?.companyName || '-', 100)}`);
    lines.push(`📍 ${clean(item?.locations?.[0]?.label || '-', 100)}`);
    lines.push(`💰 ${clean(item?.salaryLabel || 'Tidak dicantumkan', 80)}`);
    lines.push(`🕒 ${clean(item?.listingDateDisplay || '-', 60)}`);
    if (id) lines.push(`🔗 https://id.jobstreet.com/job/${id}`);
    lines.push('');
  }
  await ctx.reply(lines.join('\n').slice(0, 3900));
  return true;
}

async function handleYouTubeSearch(ctx) {
  const query = clean(ctx.text, 160);
  if (!query) throw new Error(`Gunakan: ${ctx.prefix}ytsearch <judul video>. Contoh: ${ctx.prefix}ytsearch lofi chill`);
  let yts;
  try { yts = require('yt-search'); } catch (error) {
    throw new Error('Dependensi yt-search belum terpasang. Jalankan npm install dari folder bot.');
  }
  const result = await yts(query);
  const videos = Array.isArray(result?.videos) ? result.videos.slice(0, 8) : [];
  if (!videos.length) throw new Error('Tidak ada video yang cocok dengan pencarian tersebut.');
  const lines = [`🔎 HASIL YOUTUBE: ${query}`, ''];
  videos.forEach((video, index) => {
    lines.push(`${index + 1}. *${clean(video?.title || 'Tanpa judul', 130)}*`);
    lines.push(`👤 ${clean(video?.author?.name || 'Channel tidak diketahui', 90)} | ⏱️ ${clean(video?.timestamp || '-', 20)}`);
    lines.push(`🔗 ${/^https:\/\//i.test(String(video?.url || '')) ? video.url : 'URL tidak tersedia'}`);
    lines.push('');
  });
  await ctx.reply(lines.join('\n').slice(0, 3900));
  return true;
}

async function handleHappyMod(ctx) {
  const query = clean(ctx.text, 100);
  if (!query) throw new Error(`Gunakan: ${ctx.prefix}happymod <nama aplikasi>. Contoh: ${ctx.prefix}happymod Minecraft`);
  const axios = getAxios();
  let cheerio;
  try { cheerio = require('cheerio'); } catch { throw new Error('Dependensi cheerio belum terpasang.'); }
  const { data } = await axios.get('https://happymod.com/search.html', {
    params: { q: query }, timeout: 15000, maxContentLength: 4 * 1024 * 1024,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Xeryuu-Md/17.0)' }
  });
  const $ = cheerio.load(String(data || ''));
  const results = [];
  $('.pdt-app-box').each((_, element) => {
    if (results.length >= 8) return;
    const title = clean($(element).find('h3').text(), 120);
    const href = String($(element).find('a').attr('href') || '').trim();
    const rating = clean($(element).find('span.a-search-num').text(), 30);
    if (!title || !href.startsWith('/')) return;
    results.push({ title, url: `https://happymod.com${href}`, rating });
  });
  if (!results.length) throw new Error('Hasil tidak ditemukan; halaman HappyMod mungkin mengubah struktur atau sedang membatasi akses.');
  const lines = [`📦 HASIL HAPPymod: ${query}`, '', 'Periksa izin, reputasi, dan keamanan aplikasi sebelum memasang file dari luar toko resmi.', ''];
  results.forEach((item, index) => lines.push(`${index + 1}. *${item.title}*\n⭐ ${item.rating || '-'}\n🔗 ${item.url}\n`));
  await ctx.reply(lines.join('\n').slice(0, 3500));
  return true;
}

async function handleScreenshot(ctx) {
  const input = clean(ctx.text, 500);
  if (!input) throw new Error(`Gunakan: ${ctx.prefix}ssweb <URL>. Contoh: ${ctx.prefix}ssweb https://example.com`);
  const target = validPublicUrl(input);
  if (target.hostname.toLowerCase().endsWith('.onion')) throw new Error('Alamat onion tidak didukung.');
  const screenshotUrl = `https://image.thum.io/get/png/fullpage/viewportWidth/1600/${target.toString()}`;
  const axios = getAxios();
  const response = await axios.get(screenshotUrl, {
    responseType: 'arraybuffer', timeout: 35000, maxContentLength: MAX_IMAGE_BYTES,
    headers: { 'User-Agent': 'Xeryuu-Md/17.0' }
  });
  const image = Buffer.from(response.data || []);
  if (!bufferLooksLikeImage(image)) throw new Error('Layanan screenshot tidak menghasilkan gambar. Periksa alamat atau coba lagi.');
  await ctx.conn.sendMessage(ctx.m.chat, {
    image,
    caption: `📸 Screenshot halaman: ${target.toString().slice(0, 700)}`
  }, { quoted: ctx.m });
  return true;
}

async function handleTagAdmin(ctx) {
  const m = ctx.m;
  if (!m?.isGroup) throw new Error('Perintah ini hanya bisa digunakan di grup.');
  const metadata = await ctx.conn.groupMetadata(m.chat);
  const admins = (metadata?.participants || []).filter((member) => ['admin', 'superadmin'].includes(String(member?.admin || '').toLowerCase()));
  if (!admins.length) throw new Error('Daftar admin grup tidak tersedia.');
  const ids = admins.map((member) => String(member.id || member.jid || '')).filter((id) => /@/.test(id));
  const mentions = ids.map((id) => `@${id.split('@')[0].split(':')[0]}`);
  const text = `👑 ADMIN GRUP\n\nGrup: ${clean(metadata?.subject || 'Grup', 100)}\nJumlah admin: ${ids.length}\n\n${mentions.join('\n')}`;
  await ctx.conn.sendMessage(m.chat, { text, mentions: ids }, { quoted: m });
  return true;
}

async function handleGetBio(ctx) {
  const m = ctx.m;
  const who = m?.mentionedJid?.[0] || m?.quoted?.sender || (!m?.isGroup ? m?.sender : null);
  if (!who) throw new Error(`Balas pesan atau tag pengguna. Contoh: ${ctx.prefix}getbio @pengguna`);
  if (typeof ctx.conn.fetchStatus !== 'function') throw new Error('Fitur fetchStatus tidak tersedia pada versi koneksi ini.');
  const status = await ctx.conn.fetchStatus(who);
  const value = clean(status?.status || '', 700);
  await ctx.reply(value || 'Status/bio tidak tersedia atau bersifat privat.');
  return true;
}

function unicodeStyle(text, upperBase, lowerBase, digitBase) {
  let output = '';
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0);
    if (code >= 65 && code <= 90 && upperBase != null) output += String.fromCodePoint(upperBase + code - 65);
    else if (code >= 97 && code <= 122 && lowerBase != null) output += String.fromCodePoint(lowerBase + code - 97);
    else if (code >= 48 && code <= 57 && digitBase != null) output += String.fromCodePoint(digitBase + code - 48);
    else output += char;
  }
  return output;
}

function flipText(text) {
  return Array.from(text).reverse().join('');
}

function styleText(text) {
  return {
    bold: unicodeStyle(text, 0x1d400, 0x1d41a, 0x1d7ce),
    italic: unicodeStyle(text, 0x1d434, 0x1d44e, null),
    fullwidth: Array.from(text).map((char) => {
      const code = char.codePointAt(0);
      if (code === 32) return '\u3000';
      if (code >= 33 && code <= 126) return String.fromCodePoint(code + 0xfee0);
      return char;
    }).join('')
  };
}

async function handleTinyUrl(ctx) {
  const input = clean(ctx.text, 1800);
  if (!input) throw new Error(`Gunakan: ${ctx.prefix}tinyurl <URL>`);
  const target = validPublicUrl(input);
  const axios = getAxios();
  const { data } = await axios.get('https://tinyurl.com/api-create.php', {
    params: { url: target.toString() }, timeout: 12000, maxContentLength: 1024 * 1024,
    responseType: 'text'
  });
  const short = String(data || '').trim();
  if (!/^https:\/\/tinyurl\.com\/[A-Za-z0-9]+$/i.test(short)) throw new Error('TinyURL tidak mengembalikan tautan pendek yang valid.');
  await ctx.reply(`🔗 Tautan pendek berhasil dibuat:\n${short}`);
  return true;
}

async function handleGitClone(ctx) {
  const input = String(ctx.args?.[0] || ctx.text || '').trim();
  if (!input) throw new Error(`Gunakan: ${ctx.prefix}gitclone https://github.com/owner/repository`);
  const target = validPublicUrl(input, { hosts: ['github.com'] });
  const parts = target.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[0]) || !/^[A-Za-z0-9_.-]{1,100}$/.test(parts[1])) {
    throw new Error('URL harus menunjuk ke repository GitHub dengan format owner/repository.');
  }
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, '');
  const axios = getAxios();
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zipball`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 45000,
    maxContentLength: 30 * 1024 * 1024, maxBodyLength: 30 * 1024 * 1024,
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'Xeryuu-Md/17.0' }
  });
  const archive = Buffer.from(response.data || []);
  if (archive.length < 4 || archive.subarray(0, 2).toString('hex') !== '504b') {
    throw new Error('GitHub tidak mengembalikan berkas ZIP repository yang valid.');
  }
  await ctx.conn.sendMessage(ctx.m.chat, {
    document: archive,
    mimetype: 'application/zip',
    fileName: `${owner}-${repository}.zip`,
    caption: `📦 Source ZIP GitHub: ${owner}/${repository}`
  }, { quoted: ctx.m });
  return true;
}

async function handleWeather(ctx) {
  const location = clean(ctx.text, 100);
  if (!location) throw new Error(`Gunakan: ${ctx.prefix}weather <kota>. Contoh: ${ctx.prefix}weather Jakarta`);
  const axios = getAxios();
  const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
    timeout: 15000, maxContentLength: 2 * 1024 * 1024,
    headers: { 'User-Agent': 'curl/8.0 (Xeryuu-Md weather command)' }
  });
  const current = data?.current_condition?.[0];
  const area = data?.nearest_area?.[0];
  if (!current) throw new Error('Penyedia cuaca tidak mengembalikan data untuk lokasi tersebut.');
  const areaName = clean(area?.areaName?.[0]?.value || location, 100);
  const country = clean(area?.country?.[0]?.value || '', 80);
  const description = clean(current?.lang_id?.[0]?.value || current?.weatherDesc?.[0]?.value || 'Tidak diketahui', 100);
  await ctx.reply(
    `🌦️ CUACA SAAT INI — ${areaName}${country ? `, ${country}` : ''}\n\n` +
    `Kondisi: ${description}\n` +
    `Suhu: ${current.temp_C ?? '-'}°C (terasa ${current.FeelsLikeC ?? '-'}°C)\n` +
    `Kelembapan: ${current.humidity ?? '-'}%\n` +
    `Angin: ${current.windspeedKmph ?? '-'} km/jam\n` +
    `Jarak pandang: ${current.visibility ?? '-'} km\n\n` +
    `Sumber: wttr.in. Kondisi dapat berbeda dari pengamatan setempat.`
  );
  return true;
}

async function handlePaustad(ctx) {
  const quote = clean(ctx.text, 180);
  if (!quote) throw new Error(`Gunakan: ${ctx.prefix}paustad <teks>. Contoh: ${ctx.prefix}paustad makan sambil rebahan`);
  const axios = getAxios();
  const url = `https://api.taka.my.id/pak-ustadv2?text=${encodeURIComponent(quote)}`;
  const response = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 25000, maxContentLength: MAX_IMAGE_BYTES,
    headers: { 'User-Agent': 'Xeryuu-Md/17.0' }
  });
  const image = Buffer.from(response.data || []);
  if (!bufferLooksLikeImage(image)) throw new Error('Layanan Pak Ustad tidak mengembalikan gambar.');
  await ctx.conn.sendMessage(ctx.m.chat, { image, caption: `🕌 Pak Ustad berkata: ${quote}` }, { quoted: ctx.m });
  return true;
}

async function handleCekNik(ctx) {
  const input = clean(ctx.text, 40).replace(/[\s-]/g, '');
  if (!input) throw new Error(`Gunakan: ${ctx.prefix}ceknik <16 digit NIK>`);
  if (!/^\d{16}$/.test(input)) {
    await ctx.reply('❌ Format tidak sesuai: NIK Indonesia terdiri dari 16 digit angka. Pemeriksaan ini hanya validasi format, bukan pengecekan pemilik atau data Dukcapil.');
    return true;
  }
  await ctx.reply('✅ Format NIK berisi 16 digit angka. Pemilik dan keaslian NIK tidak diverifikasi; tidak ada pencarian nama/alamat/tanggal lahir yang dilakukan.');
  return true;
}

async function handleBinary(ctx, command) {
  const input = String(ctx.text || '').trim();
  if (!input) throw new Error(`Gunakan: ${ctx.prefix}${command} <teks/biner>`);
  if (command === 'ebinary') {
    const bytes = Buffer.from(input, 'utf8');
    const result = [...bytes].map((byte) => byte.toString(2).padStart(8, '0')).join(' ');
    await ctx.reply(result.slice(0, 3500));
    return true;
  }
  const tokens = input.split(/\s+/);
  if (!tokens.every((token) => /^[01]{8}$/.test(token))) {
    throw new Error('Masukkan biner per byte 8-bit, dipisahkan spasi. Contoh: 01001000 01101001');
  }
  const output = Buffer.from(tokens.map((token) => Number.parseInt(token, 2))).toString('utf8');
  await ctx.reply(output.slice(0, 3500));
  return true;
}

async function handleToQr(ctx) {
  const text = clean(ctx.text, 1600);
  if (!text) throw new Error(`Gunakan: ${ctx.prefix}toqr <teks/URL>`);
  let QRCode;
  try { QRCode = require('qrcode'); } catch (error) {
    throw new Error('Dependensi qrcode belum terpasang. Jalankan npm install dari folder bot.');
  }
  const image = await QRCode.toBuffer(text, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 700 });
  await ctx.conn.sendMessage(ctx.m.chat, { image, caption: '🔳 QR Code dibuat dari teks yang kamu masukkan.' }, { quoted: ctx.m });
  return true;
}

async function handleReact(ctx) {
  const m = ctx.m;
  const target = m?.quoted?.key || m?.key;
  const emoji = String(ctx.text || '').trim() || '❤️';
  const points = Array.from(emoji);
  const pictographs = emoji.match(/[\p{Extended_Pictographic}]/gu) || [];
  if (points.length > 8 || pictographs.length !== 1 || !/^[\p{Extended_Pictographic}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]+$/u.test(emoji)) {
    throw new Error(`Masukkan satu emoji reaksi yang valid. Contoh: ${ctx.prefix}react 😂`);
  }
  if (!target?.remoteJid && !target?.id && !m?.key?.id) {
    throw new Error('Pesan target tidak tersedia. Balas pesan yang ingin diberi reaksi.');
  }
  await ctx.conn.sendMessage(m.chat, { react: { text: emoji, key: target } });
  return true;
}

async function handleReactChannel(ctx) {
  const parts = String(ctx.text || '').trim().split(/\s+/).filter(Boolean);
  if (!parts[0]) throw new Error(`Gunakan: ${ctx.prefix}reactch <URL_channel_post> <emoji[,emoji]>\nContoh: ${ctx.prefix}reactch https://whatsapp.com/channel/xxx/123 😂,❤️`);
  if (typeof ctx.reactChannel !== 'function') throw new Error('Helper react channel tidak tersedia di build ini.');
  const target = validPublicUrl(parts[0], { hosts: ['whatsapp.com'] });
  if (!/^\/channel\/[A-Za-z0-9_-]+(?:\/\d+)?\/?$/i.test(target.pathname)) {
    throw new Error('URL harus berupa tautan channel/post WhatsApp yang valid.');
  }
  const emojiList = (parts[1] || '😂').split(',').map((emoji) => emoji.trim()).filter(Boolean).slice(0, 5);
  if (!emojiList.length || emojiList.some((emoji) => emoji.length > 16)) throw new Error('Emoji tidak valid. Pisahkan beberapa emoji dengan koma.');
  const sender = String(ctx.m?.sender || 'unknown');
  const cooldownKey = `reactch:${sender}`;
  const last = Number(requestCache.get(cooldownKey) || 0);
  const remain = 60000 - (Date.now() - last);
  if (remain > 0) throw new Error(`Tunggu ${Math.ceil(remain / 1000)} detik sebelum memakai reactch lagi.`);
  requestCache.set(cooldownKey, Date.now());
  if (requestCache.size > 1000) {
    for (const [key, timestamp] of requestCache) if (Date.now() - timestamp > 10 * 60 * 1000) requestCache.delete(key);
  }
  await ctx.reply('⏳ Memproses reaksi channel…');
  try {
    const result = await ctx.reactChannel(target.toString(), emojiList);
    await ctx.reply(`✅ Permintaan reaksi diproses untuk ${target.toString()}\nEmoji: ${emojiList.join(' ')}`);
    return true;
  } catch (error) {
    requestCache.delete(cooldownKey);
    throw new Error(`Layanan reaksi channel gagal: ${clean(error?.message || error, 220)}`);
  }
}

async function handleLive3dEdit(ctx, mode) {
  const m = ctx.m;
  const q = m?.quoted || m;
  const quotedContent = q?.msg || q || {};
  const mime = String(quotedContent?.mimetype || q?.mimetype || '').toLowerCase();
  if (!/^image\//.test(mime)) throw new Error(`Balas foto dengan perintah ${ctx.prefix}${mode === 'maid' ? 'tomaid' : 'edit'}.`);

  const user = global.db?.users?.[m.sender];
  if (!user || typeof user !== 'object') throw new Error('Data pengguna belum tersedia di database. Kirim pesan lagi setelah bot selesai memuat database.');
  const cost = 10;
  const balance = Number(user.limit || 0);
  if (!Number.isFinite(balance) || balance < cost) throw new Error(`Limit tidak cukup. Dibutuhkan ${cost}, saldo sekarang ${Number.isFinite(balance) ? balance : 0}.`);

  const prompt = mode === 'maid'
    ? 'buat karakter ini memakai baju maid lengkap dengan bando dan lainnya'
    : clean(ctx.text, 500);
  if (!prompt) throw new Error(`Balas foto dan sertakan prompt. Contoh: ${ctx.prefix}edit ubah latar menjadi taman.`);

  const axios = getAxios();
  let FormData;
  try { FormData = require('form-data'); } catch { throw new Error('Dependensi form-data belum terpasang.'); }
  const fsPromises = require('fs/promises');
  const tempPath = path.join(os.tmpdir(), `xeryuu-live3d-${process.pid}-${crypto.randomBytes(8).toString('hex')}.img`);
  const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCwlO+boC6cwRo3UfXVBadaYwcX
0zKS2fuVNY2qZ0dgwb1NJ+/Q9FeAosL4ONiosD71on3PVYqRUlL5045mvH2K9i8b
AFVMEip7E6RMK6tKAAif7xzZrXnP1GZ5Rijtqdgwh+YmzTo39cuBCsZqK9oEoeQ3
r/myG9S+9cR5huTuFQIDAQAB
-----END PUBLIC KEY-----`;
  const randomString = (length) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let output = '';
    for (let i = 0; i < length; i++) output += chars[crypto.randomInt(chars.length)];
    return output;
  };
  const aesenc = (data, key) => {
    const keyBuffer = Buffer.from(key, 'utf8');
    const cipher = crypto.createCipheriv('aes-128-cbc', keyBuffer, keyBuffer);
    return Buffer.concat([cipher.update(String(data), 'utf8'), cipher.final()]).toString('base64');
  };
  const rsaenc = (data) => crypto.publicEncrypt({
    key: PUBLIC_KEY,
    padding: crypto.constants.RSA_PKCS1_PADDING
  }, Buffer.from(data, 'utf8')).toString('base64');
  const genHeaders = (fp = null) => {
    const key = randomString(16);
    const guide = rsaenc(key);
    return {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'id,en-US;q=0.9,en;q=0.8',
      'origin': 'https://live3d.io',
      'referer': 'https://live3d.io/',
      'theme-version': '83EmcUoQTUv50LhNx0VrdcK8rcGexcP35FcZDcpgWsAXEyO4xqL5shCY6sFIWB2Q',
      'fp': fp,
      'fp1': aesenc(`aifaceswap:${fp}`, key),
      'x-guide': guide,
      'x-sign': aesenc(`aifaceswap:1H5tRtzsBkqXcaJ:${Date.now()}:${randomString(8)}:${guide}`, key),
      'x-code': Date.now().toString()
    };
  };
  const checkPayload = (response, label) => {
    const data = response?.data;
    if (response?.status < 200 || response?.status >= 300 || !data || data.code === 0 && data.success === false) {
      throw new Error(`${label}: respons penyedia tidak valid.`);
    }
    if (data.success === false || data.status === false || (data.code && Number(data.code) >= 400)) {
      throw new Error(`${label}: ${clean(data.message || data.msg || 'Penyedia menolak permintaan.', 180)}`);
    }
    return data.data || data.result || data;
  };

  let tempBuffer;
  try {
    if (typeof q?.download === 'function') tempBuffer = await q.download();
    if (!Buffer.isBuffer(tempBuffer) || !tempBuffer.length) {
      if (typeof ctx.conn.downloadMediaMessage === 'function') tempBuffer = await ctx.conn.downloadMediaMessage(q);
    }
    if (!Buffer.isBuffer(tempBuffer) || !tempBuffer.length) throw new Error('Foto gagal diunduh dari pesan.');
    if (tempBuffer.length > 15 * 1024 * 1024) throw new Error('Foto maksimal 15 MB.');
    await fsPromises.writeFile(tempPath, tempBuffer, { mode: 0o600, flag: 'wx' });

    const fp = crypto.randomBytes(16).toString('hex');
    const form = new FormData();
    form.append('file', fs.createReadStream(tempPath));
    form.append('fn_name', 'demo-image-editor');
    form.append('request_from', '9');
    form.append('origin_from', '8f3f0c7387123ae0');
    const uploadResponse = await axios.post('https://app-v1.live3d.io/aitools/upload-img', form, {
      headers: { ...genHeaders(fp), ...form.getHeaders() },
      timeout: 30000, maxContentLength: 4 * 1024 * 1024
    });
    const uploaded = checkPayload(uploadResponse, 'Upload foto');
    const remotePath = String(uploaded?.path || '').trim();
    if (!remotePath || remotePath.length > 1000 || /[\r\n]/.test(remotePath)) throw new Error('Provider upload tidak mengembalikan path foto yang valid.');

    const createResponse = await axios.post('https://app-v1.live3d.io/aitools/of/create', {
      fn_name: 'demo-image-editor',
      call_type: 3,
      input: { model: 'nano_banana_2', source_images: [remotePath], prompt, aspect_radio: 'auto', request_from: 9 },
      request_from: 9,
      origin_from: '8f3f0c7387123ae0'
    }, { headers: { ...genHeaders(fp), 'Content-Type': 'application/json' }, timeout: 30000, maxContentLength: 4 * 1024 * 1024 });
    const created = checkPayload(createResponse, 'Pembuatan job');
    const taskId = String(created?.task_id || created?.taskId || '').trim();
    if (!taskId || taskId.length > 200) throw new Error('Provider tidak mengembalikan task ID yang valid.');

    const deadline = Date.now() + 120000;
    let result = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      const statusResponse = await axios.post('https://app-v1.live3d.io/aitools/of/check-status', {
        task_id: taskId,
        fn_name: 'demo-image-editor',
        call_type: 3,
        request_from: 9,
        origin_from: '8f3f0c7387123ae0'
      }, { headers: { ...genHeaders(fp), 'Content-Type': 'application/json' }, timeout: 20000, maxContentLength: 4 * 1024 * 1024 });
      result = checkPayload(statusResponse, 'Pemeriksaan status job');
      const status = Number(result?.status);
      if (status === 2) break;
      if ([3, 4, -1].includes(status) || result?.error) {
        throw new Error(clean(result?.message || result?.error || 'Pemrosesan gambar ditolak/gagal.', 180));
      }
      result = null;
    }
    if (!result || Number(result.status) !== 2) throw new Error('Pemrosesan gambar melewati batas waktu 120 detik. Coba lagi nanti.');

    const rawResult = String(result.result_image || result.image_url || result.url || '').trim();
    if (!rawResult) throw new Error('Provider menyatakan selesai tetapi tidak memberikan hasil gambar.');
    const resultUrl = rawResult.startsWith('https://') ? validPublicUrl(rawResult, { hosts: ['temp.live3d.io'] }) : new URL(rawResult.replace(/^\/+/, ''), 'https://temp.live3d.io/');
    if (resultUrl.hostname !== 'temp.live3d.io' || resultUrl.protocol !== 'https:') throw new Error('URL hasil dari provider tidak valid.');
    const imageResponse = await axios.get(resultUrl.toString(), {
      responseType: 'arraybuffer', timeout: 25000, maxContentLength: MAX_IMAGE_BYTES,
      headers: { 'User-Agent': 'Xeryuu-Md/17.0' }
    });
    const image = Buffer.from(imageResponse.data || []);
    if (!bufferLooksLikeImage(image)) throw new Error('Hasil provider bukan gambar yang valid.');

    user.limit = balance - cost;
    if (typeof ctx.saveGlobalDb === 'function') await ctx.saveGlobalDb();
    await ctx.conn.sendMessage(m.chat, { image, caption: `✅ *IMAGE EDITOR SUCCESS*\n\nMode: ${mode === 'maid' ? 'Menjadi maid' : 'Edit sesuai prompt'}\nBiaya: ${cost} Limit\nSisa: ${user.limit} Limit\n\nPrompt: ${prompt}` }, { quoted: m });
    return true;
  } finally {
    try { await fsPromises.unlink(tempPath); } catch {}
  }
}

async function handle(command, ctx) {
  const cmd = String(command || '').toLowerCase();
  try {
    switch (cmd) {
      case 'anime': return await handleAnime(ctx);
      case 'loker': return await handleLoker(ctx);
      case 'ytsearch': return await handleYouTubeSearch(ctx);
      case 'happymod': return await handleHappyMod(ctx);
      case 'ssweb': return await handleScreenshot(ctx);
      case 'tagadmin': return await handleTagAdmin(ctx);
      case 'getbio': return await handleGetBio(ctx);
      case 'fliptext': {
        const input = clean(ctx.text, 600);
        if (!input) throw new Error(`Gunakan: ${ctx.prefix}fliptext <teks>`);
        await ctx.reply(`「 FLIP TEXT 」\n\nNormal: ${input}\nFlip: ${flipText(input)}`);
        return true;
      }
      case 'styletext': {
        const input = clean(ctx.text, 180);
        if (!input) throw new Error(`Gunakan: ${ctx.prefix}styletext <teks>`);
        const styles = styleText(input);
        await ctx.reply(`✨ STYLE TEXT\n\n𝐁𝐨𝐥𝐝\n${styles.bold}\n\n𝘐𝘵𝘢𝘭𝘪𝘤\n${styles.italic}\n\nＦｕｌｌｗｉｄｔｈ\n${styles.fullwidth}`.slice(0, 3500));
        return true;
      }
      case 'tinyurl': return await handleTinyUrl(ctx);
      case 'gitclone': return await handleGitClone(ctx);
      case 'weather': return await handleWeather(ctx);
      case 'paustad': return await handlePaustad(ctx);
      case 'tomaid': return await handleLive3dEdit(ctx, 'maid');
      case 'ceknik': return await handleCekNik(ctx);
      case 'ebinary':
      case 'dbinary': return await handleBinary(ctx, cmd);
      case 'toqr': return await handleToQr(ctx);
      case 'react': return await handleReact(ctx);
      case 'reactch': return await handleReactChannel(ctx);
      case 'coffee':
      case 'wallpaper':
      case 'wikimedia':
      case '8ballpool':
      case 'goose':
      case 'goosebird':
      case 'dogwoof':
      case 'cat':
      case 'kpop':
      case 'hacking':
      case 'squirrel':
      case 'catmeow':
      case 'lizardpic':
      case 'aesthetic':
      case 'antiwork':
      case 'bike':
      case 'blackpink':
      case 'boneka':
      case 'couplepic':
      case 'profilepic':
      case 'pubg':
      case 'randomboy':
      case 'randomgirl':
      case 'ryujin':
      case 'ulzzangboy':
      case 'ulzzanggirl':
      case 'wallml':
      case 'wallphone': return await handlePhoto(cmd, ctx);
      default: return false;
    }
  } catch (error) {
    const message = clean(error?.message || error || 'Kesalahan tidak diketahui.', 280);
    console.error(`[XERYUU V18 ADDON:${cmd}]`, message);
    await ctx.reply(`❌ ${cmd} gagal: ${message}`);
    return true;
  }
}

module.exports = {
  handle,
  flipText,
  styleText,
  readPhotoUrls,
  resolveDatasetPath,
  bufferLooksLikeImage,
  validPublicUrl
};
