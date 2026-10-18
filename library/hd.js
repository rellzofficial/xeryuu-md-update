'use strict';

/**
 * HD helpers for Xeryuu-MD.
 * Image priority: optional local Real-ESRGAN binary -> ImgLarger AI endpoint ->
 * local Sharp fallback. Video enhancement uses FFmpeg locally to avoid relying
 * on the old hard-coded third-party HTTP endpoint.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const { spawn, spawnSync } = require('child_process');

const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_OUTPUT_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_PROCESS_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES = 42 * 1024 * 1024;
const MAX_VIDEO_OUTPUT_BYTES = 64 * 1024 * 1024;
const REMOTE_UPLOAD_URL = 'https://get1.imglarger.com/api/UpscalerNew/UploadNew';
const REMOTE_STATUS_URL = 'https://get1.imglarger.com/api/UpscalerNew/CheckStatusNew';
const REMOTE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Mobile Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'origin': 'https://imgupscaler.com',
  'referer': 'https://imgupscaler.com/'
};

function pickFfmpeg() {
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (_) {}
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function pickFfprobe() {
  return process.env.FFPROBE_PATH || 'ffprobe';
}

function getVideo2xBinary() {
  // Pakai binary yang dikonfigurasi dahulu, lalu coba jalur standar. Bila tidak
  // ada, kembalikan null dan gunakan pipeline FFmpeg yang tersedia.
  const candidates = [
    process.env.VIDEO2X_BIN,
    path.join(__dirname, 'bin', 'video2x'),
    path.join(__dirname, '..', 'bin', 'video2x'),
    '/usr/local/bin/video2x',
    '/usr/bin/video2x',
    'video2x'
  ].map(value => String(value || '').trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch (_) {}
      continue;
    }
    const found = spawnSync('which', [candidate], { encoding: 'utf8', timeout: 3000 });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return null;
}

function probeVideoDimensions(inputPath) {
  const probe = spawnSync(pickFfprobe(), [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', inputPath
  ], { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 });
  if (probe.error || probe.status !== 0) return null;
  try {
    const stream = JSON.parse(probe.stdout || '{}')?.streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    return width > 0 && height > 0 ? { width, height } : null;
  } catch (_) { return null; }
}

function getRealEsrganBinary() {
  const candidates = [
    process.env.HD_REALESRGAN_BIN,
    path.join(__dirname, 'bin', 'realesrgan-ncnn-vulkan'),
    path.join(__dirname, '..', 'bin', 'realesrgan-ncnn-vulkan'),
    '/usr/local/bin/realesrgan-ncnn-vulkan',
    '/usr/bin/realesrgan-ncnn-vulkan'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
    } else {
      const found = spawnSync('which', [candidate], { encoding: 'utf8', timeout: 3000 });
      if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
    }
  }
  return null;
}

function runProcess(executable, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let child;
    let stderr = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch (_) {}
      finish(new Error('Proses enhancement melewati batas waktu. Coba video lebih pendek atau resolusi lebih rendah.'));
    }, timeoutMs);
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (error) {
      finish(error);
      return;
    }
    child.stderr.on('data', chunk => {
      if (stderr.length < 12000) stderr += chunk.toString().slice(0, 12000 - stderr.length);
    });
    child.on('error', error => finish(new Error(`Gagal menjalankan tool HD: ${error.message}`)));
    child.on('close', code => code === 0
      ? finish()
      : finish(new Error(`Tool HD gagal (kode ${code}). ${stderr.trim().slice(-1200)}`)));
  });
}

async function validateImage(buffer, maxBytes = MAX_IMAGE_BYTES) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Gambar kosong atau tidak bisa dibaca.');
  if (buffer.length > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    throw new Error(`Ukuran gambar terlalu besar. Maksimal ${maxMb} MB.`);
  }
  const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!metadata.width || !metadata.height || !['jpeg', 'png', 'webp', 'tiff', 'gif', 'avif'].includes(metadata.format)) {
    throw new Error('Format gambar tidak didukung. Gunakan JPG, PNG, atau WebP.');
  }
  return metadata;
}

async function encodeJpegWithinLimit(buffer) {
  const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Ukuran hasil gambar tidak valid.');
  if (metadata.format === 'jpeg' && buffer.length <= MAX_IMAGE_OUTPUT_BYTES) {
    return { buffer, scaleFactor: 1 };
  }

  // Pertahankan resolusi penuh selama ukuran file masih masuk batas kirim foto
  // WhatsApp. Kecilkan kualitas terlebih dahulu; baru turunkan dimensi jika perlu.
  const scales = [1, 0.92, 0.84, 0.76, 0.68, 0.60, 0.52];
  const qualities = [92, 88, 84, 80, 76];
  for (const scaleFactor of scales) {
    for (const quality of qualities) {
      let image = sharp(buffer, { failOn: 'none' }).rotate();
      if (scaleFactor < 1) {
        image = image.resize({
          width: Math.max(1, Math.round(metadata.width * scaleFactor)),
          height: Math.max(1, Math.round(metadata.height * scaleFactor)),
          fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3'
        });
      }
      const encoded = await image.jpeg({ quality, mozjpeg: true }).toBuffer();
      if (encoded.length <= MAX_IMAGE_OUTPUT_BYTES) return { buffer: encoded, scaleFactor };
    }
  }
  throw new Error('Hasil foto HD terlalu besar untuk dikirim dengan aman. Coba foto sumber yang lebih kecil.');
}

async function enhanceWithRealEsrgan(buffer, scale) {
  const executable = getRealEsrganBinary();
  if (!executable) return null;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-realesrgan-'));
  try {
    const inputPath = path.join(workDir, 'input.png');
    const outputPath = path.join(workDir, 'output.png');
    await sharp(buffer, { failOn: 'none' }).rotate().png().toFile(inputPath);
    await runProcess(executable, ['-i', inputPath, '-o', outputPath, '-s', String(scale), '-n', 'realesrgan-x4plus'], 120000);
    if (!fs.existsSync(outputPath)) throw new Error('Real-ESRGAN tidak menghasilkan file gambar.');
    const result = fs.readFileSync(outputPath);
    await validateImage(result, MAX_IMAGE_PROCESS_BYTES);
    const jpeg = await encodeJpegWithinLimit(result);
    return { buffer: jpeg.buffer, provider: 'Real-ESRGAN lokal', scale: Number((scale * jpeg.scaleFactor).toFixed(2)) };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function enhanceWithRemoteAi(buffer, scale) {
  const normalizedResult = await encodeJpegWithinLimit(buffer);
  const normalized = normalizedResult.buffer;
  const form = new FormData();
  form.append('myfile', normalized, { filename: 'xeryuu-hd.jpg', contentType: 'image/jpeg' });
  form.append('scaleRadio', String(scale));

  const uploadResponse = await axios.post(REMOTE_UPLOAD_URL, form, {
    headers: { ...REMOTE_HEADERS, ...form.getHeaders() },
    timeout: 45000,
    maxBodyLength: MAX_IMAGE_BYTES + 1024 * 1024,
    maxContentLength: 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300
  });
  const upload = uploadResponse?.data || {};
  const jobCode = upload?.data?.code || upload?.data?.taskId || upload?.code;
  if (Number(upload.code) !== 200 || !jobCode) throw new Error(`AI upscaler menolak gambar: ${upload.msg || 'respons upload tidak valid'}`);

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const statusResponse = await axios.post(REMOTE_STATUS_URL, { code: jobCode, scaleRadio: Number(scale) }, {
      headers: { ...REMOTE_HEADERS, 'Content-Type': 'application/json' },
      timeout: 20000,
      maxContentLength: 1024 * 1024,
      validateStatus: status => status >= 200 && status < 300
    });
    const statusBody = statusResponse?.data || {};
    const data = statusBody.data || {};
    const state = String(data.status || statusBody.status || '').toLowerCase();
    const urls = data.downloadUrls || data.downloadUrl || data.url || statusBody.downloadUrls || statusBody.url;
    const url = Array.isArray(urls) ? urls[0] : urls;
    if ((state === 'success' || Number(statusBody.code) === 200) && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      const download = await axios.get(url, {
        responseType: 'arraybuffer', timeout: 45000, maxContentLength: MAX_IMAGE_PROCESS_BYTES,
        validateStatus: status => status >= 200 && status < 300
      });
      const result = Buffer.from(download.data || []);
      await validateImage(result, MAX_IMAGE_PROCESS_BYTES);
      const jpeg = await encodeJpegWithinLimit(result);
      return { buffer: jpeg.buffer, provider: 'AI ImgLarger', scale: Number((scale * jpeg.scaleFactor).toFixed(2)) };
    }
    if (['error', 'failed', 'failure'].includes(state)) throw new Error(data.message || statusBody.msg || 'AI upscaler gagal memproses gambar.');
  }
  throw new Error('AI upscaler terlalu lama merespons.');
}

async function enhanceImage(buffer, scale = 2) {
  const parsedScale = Number(scale);
  if (![2, 4].includes(parsedScale)) throw new Error('Skala gambar harus 2x atau 4x.');
  await validateImage(buffer);

  try {
    const local = await enhanceWithRealEsrgan(buffer, parsedScale);
    if (local) return local;
  } catch (error) {
    console.error('[HD REAL-ESRGAN]', error?.message || error);
  }

  try {
    return await enhanceWithRemoteAi(buffer, parsedScale);
  } catch (error) {
    console.error('[HD AI UPSCALER]', error?.message || error);
  }

  // Local fallback improves sharpness and detail while keeping the feature usable
  // if the external AI service is offline. It is clearly labelled in the result.
  const metadata = await validateImage(buffer);
  const maxSide = Math.max(metadata.width, metadata.height);
  const safeScale = Math.min(parsedScale, Math.max(1, Math.floor(4096 / Math.max(1, maxSide))));
  const output = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({ width: Math.max(1, Math.round(metadata.width * safeScale)), height: Math.max(1, Math.round(metadata.height * safeScale)), fit: 'fill', kernel: 'lanczos3' })
    .normalise()
    .modulate({ brightness: 1.015, saturation: 1.08 })
    .sharpen({ sigma: 0.85, m1: 0.65, m2: 1.15 })
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
  const encoded = await encodeJpegWithinLimit(output);
  return {
    buffer: encoded.buffer,
    provider: encoded.scaleFactor < 1 ? 'Sharp lokal (fallback; kompresi aman)' : 'Sharp lokal (fallback)',
    scale: Number((safeScale * encoded.scaleFactor).toFixed(2))
  };
}

async function remini(buffer, mode = 'enhance') {
  // Keep the old function signature intact while routing enhancement through the safer HD pipeline.
  const result = await enhanceImage(buffer, 2);
  return result.buffer;
}

async function enhanceVideo(buffer, resolution = '1080') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Video kosong atau gagal diunduh.');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('Ukuran video terlalu besar. Maksimal 42 MB.');
  const resolutionMap = { '720': 720, '1080': 1080, '2k': 1440, '1440': 1440, '4k': 2160, '2160': 2160 };
  const target = resolutionMap[String(resolution).toLowerCase()] || 1080;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-hdvideo-'));
  const inputPath = path.join(workDir, 'input.mp4');
  const outputPath = path.join(workDir, 'hd-output.mp4');
  try {
    fs.writeFileSync(inputPath, buffer);
    const executable = pickFfmpeg();

    // Optional genuine AI video upscaling with the open-source Video2X CLI.
    // Configure VIDEO2X_BIN to explicitly enable it; if it fails, the safe FFmpeg path below is used.
    const video2x = getVideo2xBinary();
    const dimensions = video2x ? probeVideoDimensions(inputPath) : null;
    if (video2x && dimensions) {
      const sourceAxis = dimensions.width >= dimensions.height ? dimensions.height : dimensions.width;
      const neededScale = target / Math.max(1, sourceAxis);
      const aiScale = neededScale >= 3.25 ? 4 : 2;
      const aiPath = path.join(workDir, 'video2x-ai.mp4');
      try {
        await runProcess(video2x, [
          '-i', inputPath, '-o', aiPath,
          '-p', 'realesrgan', '-s', String(aiScale), '--realesrgan-model', 'realesrgan-plus',
          '-e', 'crf=18', '-e', 'preset=veryfast'
        ], 240000);
        const aiStat = fs.statSync(aiPath);
        if (!aiStat.size || aiStat.size > 160 * 1024 * 1024) {
          throw new Error('File sementara Video2X kosong atau terlalu besar.');
        }
        const aiScaleFilter = `scale=w='if(gte(iw\\,ih)\\,-2\\,${target})':h='if(gte(iw\\,ih)\\,${target}\\,-2)':flags=lanczos`;
        const aiFilter = `${aiScaleFilter},hqdn3d=0.45:0.45:1.2:1.2,eq=contrast=1.035:saturation=1.06:brightness=0.002,unsharp=5:5:0.30:3:3:0.05,format=yuv420p`;
        await runProcess(executable, [
          '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', aiPath,
          '-map', '0:v:0', '-map', '0:a?', '-vf', aiFilter,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '19',
          '-maxrate', target >= 1440 ? '12M' : '8M', '-bufsize', target >= 1440 ? '24M' : '16M',
          '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputPath
        ], 180000);
        const aiFinalStat = fs.statSync(outputPath);
        if (!aiFinalStat.size) throw new Error('FFmpeg gagal merapikan hasil Video2X.');
        if (aiFinalStat.size > MAX_VIDEO_OUTPUT_BYTES) throw new Error('Ukuran hasil AI melebihi 64 MB.');
        return { buffer: fs.readFileSync(outputPath), provider: 'Video2X + Real-ESRGAN AI (lokal)', resolution: target };
      } catch (aiError) {
        console.error('[HD VIDEO2X AI]', aiError?.message || aiError);
        try { fs.rmSync(aiPath, { force: true }); } catch (_) {}
        try { fs.rmSync(outputPath, { force: true }); } catch (_) {}
      }
    }

    // Portable baseline for VPS instances without a local Video2X/Vulkan setup.
    // For landscape video, set the output height; for portrait video, set the output width.
    const scaleFilter = `scale=w='if(gte(iw\\,ih)\\,-2\\,${target})':h='if(gte(iw\\,ih)\\,${target}\\,-2)':flags=lanczos`;
    const filter = `${scaleFilter},hqdn3d=1.2:1.2:3:3,eq=contrast=1.055:saturation=1.08:brightness=0.003,unsharp=5:5:0.55:3:3:0.10,format=yuv420p`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a?', '-vf', filter,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '19',
      '-maxrate', target >= 1440 ? '12M' : '8M', '-bufsize', target >= 1440 ? '24M' : '16M',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputPath
    ];
    await runProcess(executable, args, 180000);
    const stat = fs.statSync(outputPath);
    if (!stat.size) throw new Error('FFmpeg menghasilkan file kosong.');
    if (stat.size > MAX_VIDEO_OUTPUT_BYTES) throw new Error('Ukuran video hasil melebihi 64 MB. Coba resolusi 720 atau video yang lebih pendek.');
    return { buffer: fs.readFileSync(outputPath), provider: 'FFmpeg lokal (denoise + sharpen + upscale)', resolution: target };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { enhanceImage, enhanceVideo, remini };
