'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_TEXT_LENGTH = 500;
const MAX_VIDEO_WORDS = 14;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const HANDWRITTEN_FONT_PATH = path.join(__dirname, 'database', 'assets', 'Caveat-Bold.ttf');
let handwrittenFontRegistered = false;

const NAMED_COLORS = new Set([
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'gray', 'grey',
  'navy', 'orange', 'pink', 'gold', 'purple', 'teal', 'lime', 'maroon', 'olive', 'silver',
  'rebeccapurple', 'coral', 'salmon', 'tomato', 'violet', 'indigo', 'brown', 'beige', 'transparent'
]);

function normalizeColor(value, fallback) {
  const candidate = String(value || '').trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(candidate)) return candidate;
  return NAMED_COLORS.has(candidate) ? candidate : fallback;
}

function getCanvas() {
  return require('@napi-rs/canvas');
}

function wrapLines(ctx, text, maxWidth) {
  const output = [];
  const paragraphs = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      output.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (ctx.measureText(word).width > maxWidth) {
        if (line) output.push(line), line = '';
        let piece = '';
        for (const char of word) {
          if (piece && ctx.measureText(piece + char).width > maxWidth) {
            output.push(piece);
            piece = char;
          } else {
            piece += char;
          }
        }
        line = piece;
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        if (line) output.push(line);
        line = word;
      }
    }
    if (line) output.push(line);
  }
  return output;
}

function createBratImage(text, options = {}) {
  const content = String(text || '').trim();
  if (!content) throw new Error('Teks BRAT belum diisi.');
  if (content.length > MAX_TEXT_LENGTH) throw new Error(`Teks maksimal ${MAX_TEXT_LENGTH} karakter.`);

  const { createCanvas } = getCanvas();
  const size = 512;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const background = normalizeColor(options.backgroundColor, '#ffffff');
  const foreground = normalizeColor(options.fontColor, '#000000');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);

  const marginX = 36;
  const marginY = 40;
  const maxWidth = size - marginX * 2;
  let fontSize = 64;
  let lines = [];
  while (fontSize >= 14) {
    ctx.font = `700 ${fontSize}px Arial, sans-serif`;
    lines = wrapLines(ctx, content, maxWidth);
    const lineHeight = fontSize * 1.12;
    const widest = Math.max(0, ...lines.map(line => ctx.measureText(line).width));
    if (widest <= maxWidth && lines.length * lineHeight <= size - marginY * 2) break;
    fontSize -= 2;
  }
  ctx.font = `700 ${fontSize}px Arial, sans-serif`;
  ctx.fillStyle = foreground;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineHeight = fontSize * 1.12;
  const startY = Math.max(marginY, (size - lines.length * lineHeight) / 2 + lineHeight / 2);
  lines.forEach((line, index) => ctx.fillText(line, size / 2, startY + index * lineHeight, maxWidth));
  return canvas.toBuffer('image/png');
}

function fetchAxios() {
  return require('axios');
}

async function ensureHandwrittenFont(canvasLib) {
  if (handwrittenFontRegistered) return true;
  const fonts = canvasLib?.GlobalFonts;
  if (!fonts || typeof fonts.registerFromPath !== 'function') return false;
  try {
    if (!fs.existsSync(HANDWRITTEN_FONT_PATH)) {
      const axios = fetchAxios();
      const response = await axios.get(
        'https://raw.githubusercontent.com/googlefonts/caveat/main/fonts/ttf/Caveat-Bold.ttf',
        {
          responseType: 'arraybuffer',
          timeout: 18000,
          maxContentLength: 1024 * 1024,
          validateStatus: status => status >= 200 && status < 300
        }
      );
      const fontBuffer = Buffer.from(response.data || []);
      const validSignature = fontBuffer.length > 4096 && (
        fontBuffer.toString('hex', 0, 4) === '00010000' || fontBuffer.toString('ascii', 0, 4) === 'OTTO'
      );
      if (!validSignature || fontBuffer.length > 1024 * 1024) throw new Error('Respons font tidak valid.');
      fs.mkdirSync(path.dirname(HANDWRITTEN_FONT_PATH), { recursive: true });
      const tempPath = `${HANDWRITTEN_FONT_PATH}.tmp`;
      fs.writeFileSync(tempPath, fontBuffer);
      fs.renameSync(tempPath, HANDWRITTEN_FONT_PATH);
    }
    handwrittenFontRegistered = fonts.registerFromPath(HANDWRITTEN_FONT_PATH, 'CasualHandwritten') !== false;
    return handwrittenFontRegistered;
  } catch (error) {
    console.warn('[BRAT FONT] Font Caveat tidak tersedia; memakai font pengganti:', error?.message || error);
    return false;
  }
}

async function downloadImageBuffer(url) {
  const axios = fetchAxios();
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 18000,
    maxContentLength: MAX_IMAGE_BYTES,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Xeryuu-MD/16.5)' },
    validateStatus: status => status >= 200 && status < 300
  });
  const buffer = Buffer.from(response.data || []);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || !isImageBuffer(buffer)) {
    throw new Error('Provider tidak mengembalikan data gambar yang valid.');
  }
  return buffer;
}

function isImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  return (
    (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') ||
    (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ||
    buffer.toString('ascii', 0, 3) === 'GIF'
  );
}


function createLocalClassicBratImage(text) {
  const content = String(text || '').trim();
  if (!content) throw new Error('Teks BRAT belum diisi.');
  if (content.length > MAX_TEXT_LENGTH) throw new Error(`Teks maksimal ${MAX_TEXT_LENGTH} karakter.`);

  const { createCanvas } = getCanvas();
  const size = 512;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8ACE00';
  ctx.fillRect(0, 0, size, size);

  const marginX = 34;
  const marginY = 42;
  const maxWidth = size - marginX * 2;
  let fontSize = 42;
  let lines = [];
  let lineHeight = 0;
  while (fontSize >= 16) {
    ctx.font = `400 ${fontSize}px Arial, sans-serif`;
    lines = wrapLines(ctx, content, maxWidth);
    lineHeight = fontSize * 1.13;
    const widest = Math.max(0, ...lines.map(line => ctx.measureText(line).width));
    if (widest <= maxWidth && lines.length * lineHeight <= size - marginY * 2) break;
    fontSize -= 2;
  }
  ctx.font = `400 ${fontSize}px Arial, sans-serif`;
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const contentHeight = lines.length * lineHeight;
  const startY = Math.max(marginY, (size - contentHeight) / 2);
  lines.forEach((line, index) => ctx.fillText(line, marginX, startY + index * lineHeight, maxWidth));
  return canvas.toBuffer('image/png');
}

async function createFurinaStyleBrat(text) {
  const content = String(text || '').replace(/\0/g, '').trim();
  if (!content) throw new Error('Teks BRAT belum diisi.');
  if (content.length > 180) throw new Error('Teks BRAT maksimal 180 karakter agar hasil stiker tetap terbaca.');

  const axios = fetchAxios();
  const encodedText = encodeURIComponent(content);
  const providers = [
    `https://api-faa.my.id/faa/brat?text=${encodedText}`,
    `https://api.nexray.eu.cc/maker/brat?text=${encodedText}`,
    `https://aqul-brat.hf.space/?text=${encodedText}`
  ];
  for (const url of providers) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 18_000,
        maxContentLength: MAX_IMAGE_BYTES,
        headers: {
          Accept: 'image/png,image/webp,image/jpeg,image/*;q=0.8',
          'User-Agent': 'Mozilla/5.0 (compatible; Xeryuu-MD/16.5 BRAT)'
        },
        validateStatus: status => status >= 200 && status < 300
      });
      const imageBuffer = Buffer.from(response.data || []);
      if (imageBuffer.length > 0 && imageBuffer.length <= MAX_IMAGE_BYTES && isImageBuffer(imageBuffer)) {
        return imageBuffer;
      }
      console.warn('[BRAT PROVIDER] Respons bukan gambar valid:', new URL(url).hostname);
    } catch (error) {
      console.warn('[BRAT PROVIDER] Gagal:', new URL(url).hostname, String(error?.message || error).slice(0, 160));
    }
  }

  console.warn('[BRAT] Seluruh API gambar gagal; memakai renderer BRAT lokal.');
  return createLocalClassicBratImage(content);
}

async function createTemplateBrat(text, variant) {
  const content = String(text || '').trim();
  if (!content) throw new Error('Teks BRAT belum diisi.');
  if (content.length > 180) throw new Error('Teks untuk template maksimal 180 karakter.');

  const templates = {
    handwritten: {
      url: 'https://files.catbox.moe/5zv26f.jpg',
      area: { x: 0.21, y: 0.60, w: 0.58, h: 0.17 },
      color: '#322828',
      font: 'italic',
      align: 'center'
    },
    bahlil: {
      url: 'https://i.ibb.co/JwT2QFvY/Furina-md.jpg',
      area: { x: 0.18, y: 0.55, w: 0.64, h: 0.30 },
      color: '#ffffff',
      font: 'bold',
      align: 'center'
    }
  };
  const template = templates[variant];
  if (!template) throw new Error('Template BRAT tidak dikenal.');
  const canvasLib = getCanvas();
  const { createCanvas, loadImage } = canvasLib;
  const hasHandwrittenFont = variant === 'handwritten' ? await ensureHandwrittenFont(canvasLib) : false;
  const fontFamily = hasHandwrittenFont ? 'CasualHandwritten' : 'Arial, sans-serif';
  const backgroundBuffer = await downloadImageBuffer(template.url);
  const image = await loadImage(backgroundBuffer);
  if (!image.width || !image.height) throw new Error('Resolusi gambar template tidak valid.');

  const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);

  const box = {
    x: Math.round(width * template.area.x),
    y: Math.round(height * template.area.y),
    w: Math.round(width * template.area.w),
    h: Math.round(height * template.area.h)
  };
  const padding = Math.max(8, Math.round(box.w * 0.06));
  let fontSize = Math.min(96, Math.max(18, Math.round(box.h * 0.45)));
  let lines = [];
  let lineHeight = 0;
  while (fontSize >= 14) {
    ctx.font = `${template.font} ${fontSize}px ${fontFamily}`;
    lines = wrapLines(ctx, content, box.w - padding * 2);
    lineHeight = fontSize * 1.12;
    if (lines.length * lineHeight <= box.h - padding && Math.max(0, ...lines.map(line => ctx.measureText(line).width)) <= box.w - padding * 2) break;
    fontSize -= 2;
  }
  ctx.font = `${template.font} ${fontSize}px ${fontFamily}`;
  ctx.textAlign = template.align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = template.color;
  if (variant === 'bahlil') {
    ctx.lineWidth = Math.max(2, fontSize * 0.08);
    ctx.strokeStyle = 'rgba(0,0,0,0.82)';
  }
  lineHeight = fontSize * 1.12;
  const centerX = box.x + box.w / 2;
  const startY = box.y + box.h / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    const y = startY + index * lineHeight;
    if (variant === 'bahlil') ctx.strokeText(line, centerX, y, box.w - padding * 2);
    ctx.fillText(line, centerX, y, box.w - padding * 2);
  });
  return canvas.toBuffer('image/png');
}

function pickFfmpeg() {
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (_) {}
  return String(process.env.FFMPEG_PATH || 'ffmpeg');
}

function runFfmpeg(executable, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let child;
    let stderr = '';
    let finished = false;
    const settle = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch (_) {}
      settle(new Error('Pembuatan BRAT video melewati batas waktu.'));
    }, timeoutMs);
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      settle(error);
      return;
    }
    child.stderr.on('data', chunk => {
      if (stderr.length < 6000) stderr += chunk.toString().slice(0, 6000 - stderr.length);
    });
    child.once('error', error => settle(new Error(`FFmpeg tidak dapat dijalankan: ${error.message}`)));
    child.once('close', code => code === 0 ? settle() : settle(new Error(`FFmpeg gagal (exit ${code}): ${stderr.trim().slice(-900)}`)));
  });
}

async function fetchBratFrame(text) {
  const endpoints = [
    `https://brat.siputzx.my.id/brat?text=${encodeURIComponent(text)}`,
    `https://aqul-brat.hf.space/?text=${encodeURIComponent(text)}`
  ];
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const response = await fetchAxios().get(endpoint, {
        responseType: 'arraybuffer', timeout: 16000, maxContentLength: MAX_IMAGE_BYTES,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Xeryuu-MD/16.5)', Accept: 'image/*' },
        validateStatus: status => status >= 200 && status < 300
      });
      const imageBuffer = Buffer.from(response.data || []);
      if (!isImageBuffer(imageBuffer)) throw new Error('Endpoint BRAT tidak mengembalikan gambar.');
      return imageBuffer;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Semua endpoint BRAT tidak merespons.');
}

async function createBratVideoSticker(text) {
  const content = String(text || '').replace(/\s+/g, ' ').trim();
  if (!content) throw new Error('Teks BRAT video belum diisi.');
  if (content.length > 180) throw new Error('Teks BRAT video maksimal 180 karakter.');
  const words = content.split(' ');
  if (words.length > MAX_VIDEO_WORDS) throw new Error(`BRAT video dibatasi ${MAX_VIDEO_WORDS} kata agar tidak membebani VPS.`);

  const { createCanvas, loadImage } = getCanvas();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `xeryuu-brat-${crypto.randomBytes(3).toString('hex')}-`));
  const ffmpeg = pickFfmpeg();
  try {
    for (let index = 0; index < words.length; index++) {
      const progressiveText = words.slice(0, index + 1).join(' ');
      const frameBuffer = await fetchBratFrame(progressiveText);
      const image = await loadImage(frameBuffer);
      if (!image.width || !image.height) throw new Error(`Frame BRAT ke-${index + 1} tidak valid.`);
      const canvas = createCanvas(512, 512);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#b7ffb7';
      ctx.fillRect(0, 0, 512, 512);
      const scale = Math.min(1, 456 / image.width, 456 / image.height);
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      ctx.drawImage(image, (512 - width) / 2, (512 - height) / 2, width, height);
      fs.writeFileSync(path.join(workDir, `frame${String(index).padStart(3, '0')}.png`), canvas.toBuffer('image/png'));
    }

    const mp4Path = path.join(workDir, 'brat-video.mp4');
    const webpPath = path.join(workDir, 'brat-video.webp');
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
      '-framerate', '2', '-start_number', '0', '-i', path.join(workDir, 'frame%03d.png'),
      '-vf', 'fps=12,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-an', '-movflags', '+faststart', mp4Path
    ]);
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', mp4Path,
      '-vf', 'fps=8,scale=384:384:force_original_aspect_ratio=decrease,pad=384:384:(ow-iw)/2:(oh-ih)/2:color=white',
      '-loop', '0', '-an', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '48', '-preset', 'picture', '-vsync', '0', webpPath
    ]);

    let output = fs.readFileSync(webpPath);
    if (output.length > 950 * 1024) {
      await runFfmpeg(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', mp4Path,
        '-vf', 'fps=6,scale=320:320:force_original_aspect_ratio=decrease,pad=320:320:(ow-iw)/2:(oh-ih)/2:color=white',
        '-loop', '0', '-an', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '35', '-preset', 'picture', '-vsync', '0', webpPath
      ]);
      output = fs.readFileSync(webpPath);
    }
    if (!output.length || output.length > 1024 * 1024) throw new Error('Ukuran animasi masih melebihi 1 MB setelah kompresi. Coba teks yang lebih pendek.');
    if (output.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Hasil FFmpeg bukan berkas WebP yang valid.');
    return output;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}


async function createScrollingBratSticker(text) {
  const content = String(text || '').replace(/\0/g, '').trim();
  if (!content) throw new Error('Teks BRAT berjalan belum diisi.');
  if (content.length > MAX_TEXT_LENGTH) throw new Error(`Teks maksimal ${MAX_TEXT_LENGTH} karakter.`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `xeryuu-brat-scroll-${crypto.randomBytes(3).toString('hex')}-`));
  const textPath = path.join(workDir, 'caption.txt');
  const mp4Path = path.join(workDir, 'scrolling-brat.mp4');
  const webpPath = path.join(workDir, 'scrolling-brat.webp');
  const ffmpeg = pickFfmpeg();
  try {
    // Drawtext membaca teks dari file; tidak menyusun input pengguna ke perintah shell.
    fs.writeFileSync(textPath, content.replace(/\r\n?/g, '\n'), { encoding: 'utf8', mode: 0o600 });
    const filterPath = textPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const drawTextFilter = `drawtext=textfile='${filterPath}':fontcolor=white:fontsize=45:line_spacing=10:x=(w-text_w)/2:y=h-mod(t*100\\,h+text_h):expansion=none`;

    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2',
      '-f', 'lavfi', '-i', 'color=c=black:s=512x512:d=4',
      '-vf', drawTextFilter, '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4Path
    ], 45_000);
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', mp4Path,
      '-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black',
      '-loop', '0', '-an', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '48', '-preset', 'picture', '-vsync', '0', webpPath
    ], 45_000);

    let output = fs.readFileSync(webpPath);
    if (output.length > 950 * 1024) {
      await runFfmpeg(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', mp4Path,
        '-vf', 'fps=10,scale=360:360:force_original_aspect_ratio=decrease,pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black',
        '-loop', '0', '-an', '-c:v', 'libwebp', '-lossless', '0', '-q:v', '35', '-preset', 'picture', '-vsync', '0', webpPath
      ], 45_000);
      output = fs.readFileSync(webpPath);
    }
    if (!output.length || output.length > 1024 * 1024 || output.toString('ascii', 8, 12) !== 'WEBP') {
      throw new Error('Hasil BRAT berjalan tidak valid atau masih melebihi 1 MB. Coba teks lebih pendek.');
    }
    return output;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function createAnimeBratImage(text) {
  const value = String(text || '').trim()
  if (!value) throw new Error('Teks animebrat tidak boleh kosong.')
  if (value.length > 240) throw new Error('Teks animebrat maksimal 240 karakter.')
  const { createCanvas } = require('@napi-rs/canvas')
  const width = 512
  const height = 512
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const bg = ctx.createLinearGradient(0, 0, width, height)
  bg.addColorStop(0, '#251044')
  bg.addColorStop(0.48, '#a33ee8')
  bg.addColorStop(1, '#ff82bd')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)

  // Decorative anime-inspired sparkles; no third-party character artwork is used.
  for (let i = 0; i < 34; i++) {
    const x = (i * 137 + 41) % width
    const y = (i * 83 + 19) % height
    const r = 2 + (i % 4)
    ctx.fillStyle = i % 3 === 0 ? 'rgba(255,255,255,.85)' : 'rgba(255,220,250,.42)'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    if (i % 3 === 0) {
      ctx.strokeStyle = 'rgba(255,255,255,.6)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x - r * 2.2, y)
      ctx.lineTo(x + r * 2.2, y)
      ctx.moveTo(x, y - r * 2.2)
      ctx.lineTo(x, y + r * 2.2)
      ctx.stroke()
    }
  }

  ctx.fillStyle = 'rgba(18, 8, 35, .38)'
  ctx.beginPath()
  ctx.roundRect(28, 28, width - 56, height - 56, 34)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,.82)'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.roundRect(28, 28, width - 56, height - 56, 34)
  ctx.stroke()

  const words = value.split(/\s+/)
  let fontSize = 64
  let lines = []
  const maxWidth = 408
  while (fontSize >= 28) {
    ctx.font = `900 ${fontSize}px Arial, sans-serif`
    lines = []
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width <= maxWidth || !line) line = next
      else { lines.push(line); line = word }
    }
    if (line) lines.push(line)
    if (lines.every(item => ctx.measureText(item).width <= maxWidth) && lines.length <= 6 && lines.length * fontSize * 1.12 <= 352) break
    fontSize -= 2
  }
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lineHeight = fontSize * 1.12
  const firstY = height / 2 - (lines.length - 1) * lineHeight / 2
  lines.forEach((line, index) => {
    const y = firstY + index * lineHeight
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(5, fontSize * 0.12)
    ctx.strokeStyle = '#301047'
    ctx.strokeText(line, width / 2, y, maxWidth)
    ctx.fillStyle = '#fff7ff'
    ctx.fillText(line, width / 2, y, maxWidth)
  })
  ctx.font = 'bold 13px Arial, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,.78)'
  ctx.textAlign = 'right'
  ctx.fillText('XERYUU • ANIME BRAT STYLE', width - 42, height - 43)
  return canvas.toBuffer('image/png')
}

module.exports = {
  MAX_TEXT_LENGTH,
  MAX_VIDEO_WORDS,
  normalizeColor,
  createBratImage,
  createLocalClassicBratImage,
  createFurinaStyleBrat,
  createTemplateBrat,
  createAnimeBratImage,
  createBratVideoSticker,
  createScrollingBratSticker
};
