'use strict';

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 90_000;

function getExtension(mimeType = '') {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/tiff': 'tif',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi', 'video/avi': 'avi',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
    'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/flac': 'flac',
    'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-rar-compressed': 'rar',
    'application/vnd.rar': 'rar', 'application/x-7z-compressed': '7z', 'application/x-tar': 'tar',
    'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.android.package-archive': 'apk',
    'text/plain': 'txt', 'application/json': 'json', 'application/octet-stream': 'bin'
  };
  return map[mime] || 'bin';
}

function isHttpUrl(value, allowedHosts = null) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    if (allowedHosts && !allowedHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function asValidUrl(value, baseUrl = '', allowedHosts = null) {
  let candidate = String(value || '').trim();
  if (!candidate) return '';
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (candidate.startsWith('/') && baseUrl) candidate = `${baseUrl.replace(/\/$/, '')}${candidate}`;
  if (!isHttpUrl(candidate, allowedHosts)) return '';
  return candidate;
}

function getAxios() {
  return require('axios');
}

function getFormData() {
  return require('form-data');
}

function buildForm(buffer, fieldName, filename, mimeType) {
  const FormData = getFormData();
  const form = new FormData();
  form.append(fieldName, buffer, {
    filename,
    contentType: String(mimeType || 'application/octet-stream').split(';')[0]
  });
  return form;
}

async function uploadCatbox(buffer, filename, mimeType) {
  const axios = getAxios();
  const form = buildForm(buffer, 'fileToUpload', filename, mimeType);
  form.append('reqtype', 'fileupload');
  const response = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: { ...form.getHeaders(), 'User-Agent': 'Xeryuu-MD/16.5 (media uploader)' },
    timeout: PROVIDER_TIMEOUT_MS,
    maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
    maxContentLength: 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300
  });
  const url = asValidUrl(response?.data, '', ['catbox.moe']);
  if (!url || !/\.([a-z0-9]{2,8})(?:[?#]|$)/i.test(new URL(url).pathname)) {
    throw new Error(`Respons Catbox tidak berupa URL file yang valid (${String(response?.data || '').slice(0, 80)})`);
  }
  return url;
}

async function uploadQuax(buffer, filename, mimeType) {
  const axios = getAxios();
  const form = buildForm(buffer, 'files[]', filename, mimeType);
  const response = await axios.post('https://qu.ax/upload.php', form, {
    headers: form.getHeaders(),
    timeout: PROVIDER_TIMEOUT_MS,
    maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300
  });
  const body = response?.data || {};
  if (body.success !== true || !Array.isArray(body.files) || !body.files.length) {
    throw new Error(`Respons Qu.ax tidak menyatakan upload berhasil (${String(body?.message || body?.error || 'struktur respons tidak dikenal').slice(0, 100)})`);
  }
  const url = asValidUrl(body.files[0]?.url, 'https://qu.ax', ['qu.ax']);
  if (!url) throw new Error('Respons Qu.ax tidak berisi URL file yang valid.');
  return url;
}

async function uploadYpnk(buffer, filename, mimeType) {
  const axios = getAxios();
  const form = buildForm(buffer, 'files', filename, mimeType);
  const response = await axios.post('https://cdn.ypnk.biz.id/upload', form, {
    headers: { ...form.getHeaders(), 'User-Agent': 'Mozilla/5.0 (compatible; Xeryuu-MD/16.5)' },
    timeout: PROVIDER_TIMEOUT_MS,
    maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300
  });
  const body = response?.data || {};
  const returned = body?.files?.[0]?.url || body?.url || body?.path;
  const url = asValidUrl(returned, 'https://cdn.ypnk.biz.id', ['cdn.ypnk.biz.id']);
  if (!(body.success === true || body.success === 1 || body.status === 'success') || !url) throw new Error('Respons YPNK tidak berisi URL unggahan yang valid.');
  return url;
}

async function uploadTmpFiles(buffer, filename, mimeType) {
  const axios = getAxios();
  const form = buildForm(buffer, 'file', filename, mimeType);
  const response = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
    headers: form.getHeaders(),
    timeout: PROVIDER_TIMEOUT_MS,
    maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300
  });
  const raw = response?.data?.data?.url || response?.data?.url || '';
  let url = asValidUrl(raw, '', ['tmpfiles.org']);
  if (!url) throw new Error('Respons TmpFiles tidak berisi URL unggahan yang valid.');
  // The public landing URL /<id>/<filename> is converted to the direct-download form.
  const match = new URL(url).pathname.match(/^\/(?:dl\/)?(\d+)(?:\/([^/]+))?\/?$/i);
  if (match && !/^\/dl\//i.test(new URL(url).pathname)) {
    const safeName = encodeURIComponent(match[2] || filename);
    url = `https://tmpfiles.org/dl/${match[1]}/${safeName}`;
  }
  return { url, expires: 'sementara; masa aktif mengikuti kebijakan TmpFiles' };
}

async function uploadPutIcu(buffer, filename, mimeType) {
  const axios = getAxios();
  const response = await axios.put('https://put.icu/upload/', buffer, {
    headers: {
      Accept: 'application/json',
      'Content-Type': String(mimeType || 'application/octet-stream').split(';')[0],
      'Content-Length': String(buffer.length),
      'X-Filename': filename
    },
    timeout: PROVIDER_TIMEOUT_MS,
    maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300
  });
  const body = response?.data;
  const raw = typeof body === 'string' ? body : body?.direct_url || body?.url;
  const url = asValidUrl(raw, '', ['put.icu']);
  if (!url) throw new Error('Respons Put.icu tidak berisi URL unggahan yang valid.');
  return url;
}

async function uploadTermai(buffer, filename, mimeType) {
  const apiKey = String(process.env.TERMAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('TERMAI_API_KEY belum dikonfigurasi; provider ini dilewati.');
  const axios = getAxios();
  const form = buildForm(buffer, 'file', filename, mimeType);
  const response = await axios.post(`https://c.termai.cc/api/upload?key=${encodeURIComponent(apiKey)}`, form, {
    headers: form.getHeaders(),
    timeout: PROVIDER_TIMEOUT_MS,
    maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: status => status >= 200 && status < 300
  });
  const body = response?.data || {};
  const url = asValidUrl(body.path || body.url, 'https://c.termai.cc', ['c.termai.cc']);
  if (!body.status || !url || new URL(url).hostname !== 'c.termai.cc') {
    throw new Error('Respons Termai tidak berisi URL unggahan yang valid.');
  }
  return url;
}


const PIXHOST_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const PIXHOST_ALLOWED_HOSTS = ['pixhost.to', 'pixhost.cc', 'pixho.st'];
const PIXHOST_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif'
]);

function normalizePixhostMimeType(mimeType = '') {
  const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function isPixhostImageType(mimeType = '') {
  return PIXHOST_IMAGE_TYPES.has(normalizePixhostMimeType(mimeType));
}

function isPixhostUrl(value) {
  return isHttpUrl(value, PIXHOST_ALLOWED_HOSTS);
}

async function uploadPixhostImage(buffer, filename, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Berkas gambar kosong atau gagal dibaca.');
  }
  const mime = normalizePixhostMimeType(mimeType);
  if (!isPixhostImageType(mime)) {
    throw new Error('Pixhost hanya menerima JPG/JPEG, PNG, GIF, WebP, dan AVIF.');
  }
  if (buffer.length > PIXHOST_MAX_UPLOAD_BYTES) {
    throw new Error('Batas Pixhost adalah 10 MB per gambar. Kompres gambar lalu coba lagi.');
  }

  const safeFilename = String(filename || `xeryuu-${Date.now()}.${getExtension(mime)}`)
    .replace(/[\r\n\\/]/g, '_').slice(0, 120);
  const axios = getAxios();
  const form = buildForm(buffer, 'img', safeFilename, mime);
  form.append('content_type', '0');
  form.append('max_th_size', '420');

  const headers = {
    ...form.getHeaders(),
    Accept: 'application/json',
    'User-Agent': 'Xeryuu-MD/16.5 (Pixhost image upload)'
  };
  try {
    const length = await new Promise(resolve => {
      form.getLength((error, value) => resolve(!error && Number.isFinite(value) ? value : null));
    });
    if (length !== null) headers['Content-Length'] = String(length);
  } catch (_) {}

  let response;
  try {
    response = await axios.post('https://api.pixhost.to/images', form, {
      headers,
      timeout: 90_000,
      maxBodyLength: PIXHOST_MAX_UPLOAD_BYTES + 1024 * 1024,
      maxContentLength: 2 * 1024 * 1024,
      validateStatus: () => true
    });
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    throw new Error(`Koneksi ke Pixhost gagal${status ? ` (HTTP ${status})` : ''}: ${String(error?.message || error).slice(0, 160)}`);
  }

  if (response.status < 200 || response.status >= 300) {
    let detail = response?.data;
    if (typeof detail !== 'string') {
      try { detail = JSON.stringify(detail); } catch (_) { detail = ''; }
    }
    throw new Error(`Pixhost menolak upload (HTTP ${response.status})${detail ? `: ${String(detail).replace(/[\r\n\t]+/g, ' ').slice(0, 180)}` : '.'}`);
  }

  const body = response?.data || {};
  const mediaUrl = asValidUrl(body.th_url, '', PIXHOST_ALLOWED_HOSTS);
  const pageUrl = asValidUrl(body.show_url, '', PIXHOST_ALLOWED_HOSTS);
  if (!mediaUrl || !pageUrl) {
    throw new Error('Respons Pixhost tidak memuat th_url/show_url yang valid; tautan tidak akan dikirim.');
  }
  return { mediaUrl, pageUrl, filename: safeFilename, mimeType: mime, bytes: buffer.length };
}

async function uploadToProviders(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Berkas kosong atau gagal dibaca.');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('Ukuran berkas melewati batas 100 MB.');

  const mimeType = String(options.mimeType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const filename = String(options.filename || `xeryuu_${Date.now()}.${getExtension(mimeType)}`).replace(/[\r\n\\/]/g, '_').slice(0, 120);
  const providers = [
    ['Catbox', () => uploadCatbox(buffer, filename, mimeType)],
    ['Qu.ax', () => uploadQuax(buffer, filename, mimeType)],
    ['YPNK', () => uploadYpnk(buffer, filename, mimeType)],
    ['TmpFiles', () => uploadTmpFiles(buffer, filename, mimeType)],
    ['Put.icu', () => uploadPutIcu(buffer, filename, mimeType)]
  ];
  if (String(process.env.TERMAI_API_KEY || '').trim()) providers.push(['Termai', () => uploadTermai(buffer, filename, mimeType)]);

  const settled = await Promise.allSettled(providers.map(async ([name, work]) => ({ name, value: await work() })));
  const results = [];
  const errors = [];
  for (let index = 0; index < settled.length; index++) {
    const result = settled[index];
    const providerName = providers[index][0];
    if (result.status === 'fulfilled') {
      const record = result.value;
      if (typeof record.value === 'string') results.push({ provider: record.name, url: record.value });
      else results.push({ provider: record.name, ...record.value });
    } else {
      const message = String(result.reason?.message || result.reason || 'Kesalahan tidak diketahui').replace(/https?:\/\/[^\s]+\?key=[^\s]+/gi, '[URL provider disamarkan]').slice(0, 180);
      errors.push({ provider: providerName, error: message });
      console.warn(`[TOURL ${providerName}] ${message}`);
    }
  }
  return { results, errors, filename, mimeType, bytes: buffer.length };
}

module.exports = {
  MAX_UPLOAD_BYTES,
  getExtension,
  isHttpUrl,
  asValidUrl,
  uploadToProviders,
  PIXHOST_MAX_UPLOAD_BYTES,
  normalizePixhostMimeType,
  isPixhostImageType,
  isPixhostUrl,
  uploadPixhostImage
};
