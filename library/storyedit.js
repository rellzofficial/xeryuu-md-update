'use strict';

/**
 * Story Edit Generator for Xeryuu-Md V16 × Sendrich.
 * Images are searched through the Wikimedia Commons MediaWiki API and are
 * attributed in the result message. Video rendering is performed locally via
 * ffmpeg-static (or a system ffmpeg fallback); no third-party video API key is
 * required. Optional soundtrack: reply to an audio message with .storyedit.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { spawn } = require('child_process');

const IMAGE_COUNT = 3;
const MIN_IMAGE_COUNT = 3;
const WIDTH = 720;
const HEIGHT = 1280;
const MAX_AUDIO_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const busyChats = new Set();
const busySenders = new Set();
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = 2;

function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripHtml(value, maxLength = 180) {
  return cleanText(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>'), maxLength);
}

function wrapText(value, maxChars, maxLines) {
  const words = cleanText(value, 600).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
      if (lines.length >= maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length > maxChars - 1
      ? `${last.slice(0, maxChars - 1).trimEnd()}…`
      : `${last.replace(/[.,;:!?…]?$/, '')}…`;
  }
  return lines;
}

function xmlLines(lines, x, firstY, lineHeight, fontSize, attributes = '') {
  return lines.map((line, index) =>
    `<text x="${x}" y="${firstY + index * lineHeight}" font-size="${fontSize}" ${attributes}>${escapeXml(line)}</text>`
  ).join('');
}

function userAgent() {
  return 'Xeryuu-MD-StoryEdit/1.0 (Wikimedia Commons MediaWiki API client)';
}

async function searchCommons(query) {
  const response = await axios.get('https://commons.wikimedia.org/w/api.php', {
    params: {
      action: 'query',
      format: 'json',
      formatversion: 2,
      generator: 'search',
      gsrsearch: query,
      gsrnamespace: 6,
      gsrlimit: 18,
      prop: 'imageinfo',
      iiprop: 'url|mime|extmetadata',
      iiurlwidth: 1000,
      iiextmetadatalanguage: 'en',
      iiextmetadatafilter: 'Artist|Credit|LicenseShortName|LicenseUrl|Attribution',
      inprop: 'url'
    },
    timeout: 18000,
    responseType: 'json',
    maxContentLength: 4 * 1024 * 1024,
    headers: { 'User-Agent': userAgent(), 'Accept': 'application/json' }
  });

  const pages = response?.data?.query?.pages;
  if (!Array.isArray(pages) || !pages.length) return [];
  const results = [];
  const seen = new Set();

  for (const page of pages) {
    const image = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
    if (!image || !/^image\/(jpeg|png|webp)$/i.test(String(image.mime || ''))) continue;
    const url = image.thumburl || image.url;
    if (!url || !/^https:\/\//i.test(url) || seen.has(url)) continue;
    if (/\.(svg|gif|tif|tiff|pdf)(?:[?#]|$)/i.test(url)) continue;
    seen.add(url);
    const metadata = image.extmetadata || {};
    const rawLicenseUrl = String(metadata.LicenseUrl?.value || '');
    const licenseHref = rawLicenseUrl.match(/href=["'](https?:\/\/[^"']+)["']/i)?.[1] || stripHtml(rawLicenseUrl, 300);
    results.push({
      title: cleanText(String(page.title || 'Wikimedia Commons image').replace(/^File:/, ''), 140),
      url,
      pageUrl: /^https:\/\//i.test(String(page.fullurl || ''))
        ? page.fullurl
        : `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || '').replace(/ /g, '_'))}`,
      artist: stripHtml(metadata.Artist?.value || metadata.Attribution?.value || metadata.Credit?.value || '', 110),
      license: stripHtml(metadata.LicenseShortName?.value || '', 40),
      licenseUrl: /^https:\/\//i.test(licenseHref) ? licenseHref : ''
    });
  }
  return results;
}

async function downloadImage(item) {
  const response = await axios.get(item.url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: { 'User-Agent': userAgent(), 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
    validateStatus: status => status >= 200 && status < 300
  });
  const buffer = Buffer.from(response.data || []);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('Ukuran gambar kosong atau terlalu besar.');
  const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!metadata.width || !metadata.height || !metadata.format || !['jpeg', 'png', 'webp', 'tiff', 'gif'].includes(metadata.format)) {
    throw new Error('Format gambar tidak didukung.');
  }
  if (metadata.width < 240 || metadata.height < 240) throw new Error('Resolusi gambar terlalu kecil.');
  return { ...item, buffer };
}

async function chooseImages(query) {
  const searchVariants = [query, `${query} landscape nature`].filter((value, index, all) => all.indexOf(value) === index);
  const searchResults = await Promise.allSettled(searchVariants.map(searchQuery => searchCommons(searchQuery)));
  const candidates = [];
  for (let index = 0; index < searchResults.length; index++) {
    const result = searchResults[index];
    if (result.status === 'fulfilled') candidates.push(...result.value);
    else console.error(`[STORYEDIT SEARCH] ${searchVariants[index]}: ${result.reason?.message || result.reason}`);
  }

  const unique = [];
  const seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.pageUrl) || seen.has(item.url)) continue;
    seen.add(item.pageUrl);
    seen.add(item.url);
    unique.push(item);
    if (unique.length >= 12) break;
  }
  if (!unique.length) {
    throw new Error('Gambar tidak ditemukan atau layanan Wikimedia Commons sedang tidak dapat diakses. Coba kata kunci yang lebih spesifik atau coba lagi nanti.');
  }

  // Download in small batches. A single broken thumbnail must not fail the whole job.
  const loaded = [];
  for (let offset = 0; offset < unique.length && loaded.length < IMAGE_COUNT; offset += 4) {
    const batch = await Promise.allSettled(unique.slice(offset, offset + 4).map(downloadImage));
    for (let index = 0; index < batch.length; index++) {
      const result = batch[index];
      if (result.status === 'fulfilled') loaded.push(result.value);
      else console.error(`[STORYEDIT IMAGE] ${unique[offset + index].title}: ${result.reason?.message || result.reason}`);
      if (loaded.length >= IMAGE_COUNT) break;
    }
  }
  if (loaded.length < MIN_IMAGE_COUNT) {
    throw new Error(`Hanya ${loaded.length} gambar yang berhasil diunduh. Minimal ${MIN_IMAGE_COUNT} gambar diperlukan; coba kata kunci lain atau ulangi beberapa saat lagi.`);
  }
  return loaded.slice(0, IMAGE_COUNT);
}

async function makeSlide(image, title, description, index, count, outPath, options = {}) {
  const titleLines = wrapText(title, 23, 2);
  const descriptionLines = wrapText(description, 43, 3);
  const titleY = 932 - Math.max(0, titleLines.length - 1) * 56;
  const descriptionY = titleY + titleLines.length * 59 + 28;
  const lyricLines = wrapText(options.lyric || '', 45, 1);
  const lyricY = Math.min(1180, descriptionY + descriptionLines.length * 38 + 24);
  const fontFamily = getFontFamily(options.typography);
  const locationText = cleanText(options.location || '', 70);
  const overlay = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#05070c" stop-opacity="0.30"/>
          <stop offset="42%" stop-color="#05070c" stop-opacity="0.02"/>
          <stop offset="65%" stop-color="#05070c" stop-opacity="0.08"/>
          <stop offset="100%" stop-color="#05070c" stop-opacity="0.91"/>
        </linearGradient>
        <filter id="shadow"><feGaussianBlur stdDeviation="2"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#shade)"/>
      <text x="52" y="82" fill="#ffffff" opacity="0.94" font-size="19" letter-spacing="5" font-family="Arial, sans-serif">X E R Y U U</text>
      <text x="52" y="116" fill="#ffffff" opacity="0.78" font-size="14" letter-spacing="2" font-family="Arial, sans-serif">${escapeXml((locationText ? `LOCATION / ${locationText}` : 'STORY FILM').slice(0, 42))}  ·  ${String(index + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}</text>
      <path d="M52 148 H180" stroke="#ffffff" stroke-opacity="0.82" stroke-width="2"/>
      ${xmlLines(titleLines, 52, titleY, 59, 46, `fill="#ffffff" font-weight="700" font-family="${escapeXml(fontFamily)}"`)}
      ${xmlLines(descriptionLines, 54, descriptionY, 38, 24, 'fill="#ffffff" fill-opacity="0.92" font-family="Arial, sans-serif"')}
      ${lyricLines.length ? xmlLines(lyricLines, 54, lyricY, 25, 17, 'fill="#ffffff" fill-opacity="0.78" font-style="italic" font-family="Georgia, serif"') : ''}
      <text x="52" y="1214" fill="#ffffff" opacity="0.75" font-size="15" letter-spacing="2" font-family="Arial, sans-serif">${escapeXml((options.song ? `♪ ${options.song}` : options.play || 'A MOMENT TO REMEMBER').slice(0, 60))}</text>
      <text x="668" y="1214" text-anchor="end" fill="#ffffff" opacity="0.75" font-size="15" font-family="Arial, sans-serif">XERYUU • V16</text>
    </svg>
  `);

  await sharp(image.buffer, { failOn: 'none' })
    .rotate()
    .normalise()
    .modulate({ brightness: 1.02, saturation: 1.10 })
    .sharpen({ sigma: 0.75, m1: 0.55, m2: 1.10 })
    .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
    .composite([{ input: overlay, blend: 'over' }])
    .jpeg({ quality: 91, mozjpeg: true })
    .toFile(outPath);
}

async function makeCover(images, title, description, options = {}) {
  const coverImages = Array.from({ length: IMAGE_COUNT }, (_, index) => images[index % images.length]);
  const positions = [
    { left: 8, top: 8, width: 532, height: 1072 },
    { left: 548, top: 8, width: 532, height: 532 },
    { left: 548, top: 548, width: 532, height: 532 }
  ];
  const tiles = [];
  for (let i = 0; i < IMAGE_COUNT; i++) {
    const position = positions[i];
    const tile = await sharp(coverImages[i].buffer, { failOn: 'none' })
      .rotate()
      .normalise()
      .modulate({ brightness: 1.02, saturation: 1.10 })
      .sharpen({ sigma: 0.75, m1: 0.55, m2: 1.10 })
      .resize(position.width, position.height, { fit: 'cover', position: 'attention', kernel: 'lanczos3' })
      .jpeg({ quality: 89, mozjpeg: true })
      .toBuffer();
    tiles.push({ input: tile, left: position.left, top: position.top });
  }

  const titleLines = wrapText(title, 35, 2);
  const descriptionLines = wrapText(description, 75, 2);
  const fontFamily = getFontFamily(options.typography);
  const metadataLine = [options.location ? `LOCATION: ${options.location}` : '', options.typography ? `TYPE: ${options.typography}` : '', options.device ? `DEVICE: ${options.device}` : '', options.song ? `MUSIC: ${options.song}` : 'ORIGINAL AMBIENT MUSIC'].filter(Boolean).join('  ·  ').slice(0, 130);
  const footerSvg = Buffer.from(`
    <svg width="1088" height="262" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#101522"/><stop offset="100%" stop-color="#080a10"/></linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#f)"/>
      <text x="28" y="35" fill="#c5d2ef" font-size="14" letter-spacing="4" font-family="Arial, sans-serif">XERYUU  /  STORY EDIT</text>
      ${xmlLines(titleLines, 28, 83, 43, 34, `fill="#ffffff" font-weight="700" font-family="${escapeXml(fontFamily)}"`)}
      ${xmlLines(descriptionLines, 28, 171, 27, 18, 'fill="#d7ddeb" font-family="Arial, sans-serif"')}
      <text x="28" y="241" fill="#aebbd5" font-size="13" letter-spacing="1" font-family="Arial, sans-serif">${escapeXml(metadataLine)}</text>
    </svg>
  `);
  return sharp({ create: { width: 1088, height: 1350, channels: 3, background: { r: 8, g: 10, b: 16 } } })
    .composite([
      ...tiles,
      { input: footerSvg, left: 0, top: 1088 }
    ])
    .jpeg({ quality: 87, mozjpeg: true })
    .toBuffer();
}

function runFfmpeg(args, timeoutMs = 150000) {
  return new Promise((resolve, reject) => {
    let executable = 'ffmpeg';
    try {
      const staticPath = require('ffmpeg-static');
      if (typeof staticPath === 'string' && staticPath.trim()) executable = staticPath;
    } catch (_) {
      // Use the system ffmpeg fallback.
    }
    if (process.env.FFMPEG_PATH && String(process.env.FFMPEG_PATH).trim()) executable = String(process.env.FFMPEG_PATH).trim();

    let stderr = '';
    let settled = false;
    let child;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch (_) {}
      finish(new Error('Proses rendering melewati batas waktu. Coba ulangi dengan durasi yang lebih pendek.'));
    }, timeoutMs);

    try {
      child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      finish(new Error(`FFmpeg tidak bisa dijalankan: ${error?.message || error}`));
      return;
    }
    child.stderr.on('data', chunk => {
      if (stderr.length < 12000) stderr += chunk.toString().slice(0, 12000 - stderr.length);
    });
    child.on('error', error => finish(new Error(`FFmpeg gagal dijalankan: ${error?.message || error}. Pastikan ffmpeg-static sudah terpasang atau FFmpeg tersedia di VPS.`)));
    child.on('close', code => {
      if (code === 0) return finish();
      finish(new Error(`FFmpeg gagal membuat video (kode ${code}). ${cleanText(stderr, 900)}`));
    });
  });
}

function videoFilterGraph(slotSeconds, imageCount = IMAGE_COUNT) {
  const branches = [];
  for (let index = 0; index < imageCount; index++) {
    // Direct-cut montage: each edited photo fills its own timed slot. No fade-in/fade-out filters.
    branches.push(`[${index}:v]scale=${WIDTH}:${HEIGHT}:flags=lanczos,eq=contrast=1.045:saturation=1.08:brightness=0.003,unsharp=5:5:0.40:3:3:0.08,zoompan=z='min(zoom+0.00035,1.055)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=30,trim=duration=${slotSeconds.toFixed(3)},setpts=PTS-STARTPTS,setsar=1,settb=AVTB[v${index}]`);
  }
  branches.push(`${Array.from({ length: imageCount }, (_, index) => `[v${index}]`).join('')}concat=n=${imageCount}:v=1:a=0,format=yuv420p[outv]`);
  return branches.join(';');
}

async function renderVideo(slidePaths, audioBuffer, requestedDuration, workDir) {
  const imageCount = slidePaths.length;
  if (imageCount < MIN_IMAGE_COUNT) throw new Error(`Minimal ${MIN_IMAGE_COUNT} gambar dibutuhkan untuk merender video.`);
  const slotSeconds = requestedDuration / imageCount;
  const duration = requestedDuration;
  const outputPath = path.join(workDir, 'storyedit.mp4');
  const argsBase = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2'];
  for (const slidePath of slidePaths) {
    argsBase.push('-loop', '1', '-framerate', '30', '-t', slotSeconds.toFixed(3), '-i', slidePath);
  }

  let audioIndex = -1;
  if (audioBuffer && audioBuffer.length) {
    if (audioBuffer.length > MAX_AUDIO_BYTES) throw new Error('Audio terlalu besar. Maksimal 18 MB.');
    const audioPath = path.join(workDir, 'soundtrack.bin');
    fs.writeFileSync(audioPath, audioBuffer);
    audioIndex = imageCount;
    argsBase.push('-stream_loop', '-1', '-i', audioPath);
  } else {
    const defaultTrack = path.join(__dirname, '..', 'media', 'storyedit-music.mp3');
    const configuredTrack = process.env.STORYEDIT_MUSIC_PATH ? path.resolve(process.env.STORYEDIT_MUSIC_PATH) : '';
    const selectedTrack = [configuredTrack, defaultTrack].filter(Boolean).find(candidate => {
      try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch (_) { return false; }
    });
    if (selectedTrack) {
      audioIndex = imageCount;
      argsBase.push('-stream_loop', '-1', '-i', selectedTrack);
    }
  }

  const runRender = async withAudio => {
    const args = argsBase.slice();
    const graph = videoFilterGraph(slotSeconds, imageCount);
    if (withAudio && audioIndex >= 0) {
      args.push('-filter_complex', `${graph};[${audioIndex}:a:0]atrim=duration=${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.82[aout]`);
      args.push('-map', '[outv]', '-map', '[aout]', '-t', duration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '1400k', '-bufsize', '2800k', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '112k', '-movflags', '+faststart', outputPath);
    } else {
      args.push('-filter_complex', graph, '-map', '[outv]', '-t', duration.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', '1400k', '-bufsize', '2800k', '-pix_fmt', 'yuv420p', '-r', '30', '-an', '-movflags', '+faststart', outputPath);
    }
    await runFfmpeg(args);
    const stat = fs.statSync(outputPath);
    if (!stat.size || stat.size > 15 * 1024 * 1024) throw new Error('Ukuran video hasil render melebihi batas aman 15 MB.');
  };

  let audioIncluded = audioIndex >= 0;
  let rendered = false;
  const failures = [];
  const attempts = audioIncluded ? [true, false] : [false];

  for (const withAudio of attempts) {
    try {
      try { fs.rmSync(outputPath, { force: true }); } catch (_) {}
      await runRender(withAudio);
      audioIncluded = withAudio && audioIndex >= 0;
      rendered = true;
      break;
    } catch (error) {
      failures.push(error?.message || String(error));
      console.error(`[STORYEDIT RENDER ${withAudio ? 'AUDIO' : 'SILENT'}]`, error?.message || error);
    }
  }
  if (!rendered) {
    throw new Error(`FFmpeg tidak berhasil membuat video. Pastikan ffmpeg-static terpasang atau FFmpeg tersedia di VPS. Detail: ${cleanText(failures[failures.length - 1] || 'proses render gagal', 700)}`);
  }
  return { buffer: fs.readFileSync(outputPath), audioIncluded };
}

function normalizeRequestedDuration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 5;
  return Math.max(5, Math.min(20, Math.round(numeric)));
}

function suggestHeadline(query) {
  const value = cleanText(query, 100);
  if (/(gunung|hutan|alam|bukit|lembah|air terjun|mountain|forest|nature|green)/i.test(value)) return 'ENDLESS GREEN';
  if (/(laut|pantai|samudra|ocean|sea|beach|danau)/i.test(value)) return 'BLUE HORIZON';
  if (/(kota|malam|city|neon|street|urban)/i.test(value)) return 'AFTER DARK';
  return value.toLocaleUpperCase('en-US');
}

function parseStoryEditInput(input) {
  const aliases = {
    play: 'play', vibe: 'play', mood: 'play',
    lagu: 'song', song: 'song', music: 'song', musik: 'song',
    lirik: 'lyric', lyric: 'lyric', lyrics: 'lyric',
    hp: 'device', device: 'device', phone: 'device',
    typography: 'typography', font: 'typography', style: 'typography',
    lokasi: 'location', location: 'location', tempat: 'location',
    durasi: 'duration', duration: 'duration', dur: 'duration',
    judul: 'headline', title: 'headline', headline: 'headline',
    deskripsi: 'description', description: 'description'
  };
  const options = {};
  const plainSegments = [];
  const rawLines = String(input || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const pieces = rawLines.length ? rawLines.flatMap(line => line.split('|').map(part => part.trim()).filter(Boolean)) : [];

  for (const piece of pieces) {
    const match = piece.match(/^([a-zA-Z\u00C0-\u024F _-]{2,20})\s*:\s*(.*)$/);
    if (match) {
      const label = match[1].toLowerCase().replace(/[ _-]+/g, '');
      const key = aliases[label];
      if (key) {
        options[key] = cleanText(match[2], key === 'lyric' ? 150 : key === 'description' ? 220 : key === 'headline' ? 65 : 120);
        continue;
      }
    }
    plainSegments.push(piece);
  }

  const query = cleanText(plainSegments.shift() || '', 100);
  if (plainSegments.length && !options.duration && /^\d{1,2}$/.test(plainSegments[plainSegments.length - 1])) {
    options.duration = plainSegments.pop();
  }
  if (!options.description && plainSegments.length) options.description = cleanText(plainSegments.join(' | '), 220);
  if (options.duration !== undefined && options.duration !== '') {
    const parsedDuration = Number(options.duration);
    if (!Number.isInteger(parsedDuration) || parsedDuration < 5 || parsedDuration > 20) {
      throw new Error('Durasi harus berupa angka 5 sampai 20 detik.');
    }
    options.duration = parsedDuration;
  } else {
    options.duration = 5;
  }
  options.location = cleanText(options.location || query, 100);
  options.typography = cleanText(options.typography || 'satz', 40);
  options.headline = cleanText(options.headline || suggestHeadline(query), 65);
  options.description = cleanText(options.description || `Potret visual ${query} dalam sebuah perjalanan singkat yang penuh suasana.`, 220);
  options.song = cleanText(options.song || '', 120);
  options.lyric = cleanText(options.lyric || '', 150);
  options.device = cleanText(options.device || '', 60);
  options.play = cleanText(options.play || '', 80);
  return { query, ...options };
}

function getFontFamily(typography) {
  const style = cleanText(typography, 40).toLowerCase();
  if (/(serif|classic|editorial|scrip)/.test(style)) return 'Georgia, serif';
  if (/(mono|terminal|tech)/.test(style)) return 'monospace';
  if (/(satz|impact|bold|poster|condensed)/.test(style)) return 'DejaVu Sans, Arial, sans-serif';
  return 'Arial, sans-serif';
}

async function generateStoryEdit(options = {}) {
  const chatKey = cleanText(options.chatKey || '', 180);
  const senderKey = cleanText(options.senderKey || '', 180);
  if (activeJobs >= MAX_CONCURRENT_JOBS) throw new Error('Story Edit sedang diproses oleh pengguna lain. Tunggu sebentar lalu coba kembali.');
  if (chatKey && busyChats.has(chatKey)) throw new Error('Story Edit di chat ini masih diproses. Tunggu hasilnya sebelum membuat edit baru.');
  if (senderKey && busySenders.has(senderKey)) throw new Error('Kamu masih memiliki proses Story Edit yang berjalan. Tunggu sampai selesai.');

  const query = cleanText(options.query, 100);
  const title = cleanText(options.title || suggestHeadline(query), 65);
  const description = cleanText(options.description || `Potret visual ${title} dalam sebuah perjalanan singkat yang penuh suasana.`, 220);
  const duration = normalizeRequestedDuration(options.duration);
  if (!query) throw new Error('Masukkan objek atau kata kunci yang ingin dibuatkan Story Edit.');

  if (chatKey) busyChats.add(chatKey);
  if (senderKey) busySenders.add(senderKey);
  activeJobs++;
  let workDir = null;

  try {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-storyedit-'));
    const visualOptions = {
      location: cleanText(options.location || query, 100),
      typography: cleanText(options.typography || 'satz', 40),
      device: cleanText(options.device || '', 60),
      song: cleanText(options.song || '', 120),
      lyric: cleanText(options.lyric || '', 150),
      play: cleanText(options.play || '', 80)
    };
    const images = await chooseImages(query);
    const slidePaths = [];
    for (let index = 0; index < images.length; index++) {
      const slidePath = path.join(workDir, `slide-${index + 1}.jpg`);
      await makeSlide(images[index], title, description, index, images.length, slidePath, visualOptions);
      slidePaths.push(slidePath);
    }
    const [cover, videoResult] = await Promise.all([
      makeCover(images, title, description, visualOptions),
      renderVideo(slidePaths, Buffer.isBuffer(options.audioBuffer) ? options.audioBuffer : null, duration, workDir)
    ]);
    const sources = images.map((image, index) => ({
      index: index + 1,
      title: image.title,
      pageUrl: image.pageUrl,
      artist: image.artist || 'Kontributor Wikimedia Commons (cek halaman sumber)',
      license: image.license || 'Lisensi tercantum pada halaman sumber',
      licenseUrl: image.licenseUrl || ''
    }));
    return { cover, video: videoResult.buffer, sources, title, description, duration, audioIncluded: videoResult.audioIncluded };
  } finally {
    if (workDir) { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (error) { console.error('[STORYEDIT TEMP CLEANUP]', error?.message || error); } }
    if (chatKey) busyChats.delete(chatKey);
    if (senderKey) busySenders.delete(senderKey);
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

function formatAttribution(sources = []) {
  const entries = sources.map(source => {
    const author = cleanText(source.artist || '', 100) || 'Kontributor Wikimedia Commons';
    const license = cleanText(source.license || '', 40) || 'lihat halaman sumber';
    return `${source.index}. ${cleanText(source.title, 110)} — ${author} (${license})\n${source.pageUrl}${source.licenseUrl ? `\nLisensi: ${source.licenseUrl}` : ''}`;
  });
  return `🖼️ *SUMBER FOTO & ATRIBUSI*\nFoto dipilih dari Wikimedia Commons. Periksa detail lisensi di halaman masing-masing.\n\n${entries.join('\n\n')}`.slice(0, 3900);
}

module.exports = {
  generateStoryEdit,
  formatAttribution,
  normalizeRequestedDuration,
  parseStoryEditInput,
  suggestHeadline
};
