'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { UploadFileUgu } = require('./uploader.js');

const FREE_FIRE_TEMPLATES = {
  1: 'https://cloud-fukushima.vercel.app/uploader/8fjhd6ftps.jpg',
  2: 'https://cloud-fukushima.vercel.app/uploader/oz8hb4ow75.jpg',
  3: 'https://cloud-fukushima.vercel.app/uploader/tvz1cie8df.jpg',
  4: 'https://cloud-fukushima.vercel.app/uploader/yo9sg4vmo3.jpg',
  5: 'https://i.ibb.co/twtSvQXv/image.jpg',
  6: 'https://i.ibb.co/n80Bc1wV/image.jpg',
  7: 'https://i.ibb.co/mCwmt019/image.jpg',
  8: 'https://i.ibb.co/JwG60TwF/image.jpg',
  9: 'https://i.ibb.co/zWNLw6bV/image.jpg',
  10: 'https://i.ibb.co/d4DvnHw6/image.jpg',
  11: 'https://i.ibb.co/hxMGbx9v/image.jpg',
  12: 'https://i.ibb.co/jvd5xfvK/image.jpg',
  13: 'https://i.ibb.co/KxTQ0r0x/image.jpg',
  14: 'https://i.ibb.co/rRyxvrJW/image.jpg',
  15: 'https://i.ibb.co/PG5jwG6S/image.jpg',
  16: 'https://i.ibb.co/MDdH7kjG/image.jpg',
  17: 'https://i.ibb.co/6cnHvL31/image.jpg',
  18: 'https://i.ibb.co/dwg4CGdf/image.jpg',
  19: 'https://i.ibb.co/pvx1PZyW/image.jpg',
  20: 'https://i.ibb.co/kVkbxhwg/image.jpg',
  21: 'https://i.ibb.co/rK8ZTPbt/image.jpg',
  22: 'https://i.ibb.co/vC3p8NjP/image.jpg'
};

function getCanvas() {
  try {
    return require('@napi-rs/canvas');
  } catch (error) {
    throw new Error('Modul @napi-rs/canvas belum terpasang. Jalankan npm install sesuai package.json.');
  }
}

function mediaTypeInfo(m) {
  const content = m?.msg || {};
  const type = String(m?.mtype || '');
  const mime = String(content.mimetype || m?.mimetype || '').toLowerCase();
  const isSticker = /stickerMessage/i.test(type) || mime === 'image/webp';
  const isVideo = /videoMessage/i.test(type) || mime.startsWith('video/');
  const isImage = /imageMessage/i.test(type) || mime.startsWith('image/');
  const isDocumentMedia = /documentMessage/i.test(type) && (/^image\//i.test(mime) || /^video\//i.test(mime) || /webp/i.test(mime));
  return {
    type,
    mime,
    isSticker,
    isVideo: isVideo || (isDocumentMedia && /^video\//i.test(mime)),
    isImage: isImage || (isDocumentMedia && (/^image\//i.test(mime) || /webp/i.test(mime))),
    isMedia: isSticker || isVideo || isImage || isDocumentMedia,
    seconds: Number(content.seconds || content.fileLengthSeconds || 0)
  };
}

async function downloadMediaBuffer(m) {
  if (typeof m?.download === 'function') {
    const downloaded = await m.download();
    if (Buffer.isBuffer(downloaded) && downloaded.length) return downloaded;
  }

  const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
  let message = m?.message || {};
  for (let n = 0; n < 4; n++) {
    if (message?.ephemeralMessage?.message) message = message.ephemeralMessage.message;
    else if (message?.viewOnceMessage?.message) message = message.viewOnceMessage.message;
    else if (message?.viewOnceMessageV2?.message) message = message.viewOnceMessageV2.message;
    else if (message?.documentWithCaptionMessage?.message) message = message.documentWithCaptionMessage.message;
    else break;
  }
  const entry = Object.entries(message || {}).find(([key, value]) =>
    value && /^(image|video|sticker|document)Message$/i.test(key)
  );
  if (!entry) throw new Error('Isi pesan bukan media yang dapat diunduh.');
  const [key, payload] = entry;
  const stream = await downloadContentFromMessage(payload, key.replace(/Message$/i, '').toLowerCase());
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw new Error('Media kosong setelah diunduh.');
  return buffer;
}

async function handleGroupMediaAutomation(conn, m, isBotAdmins, isCommand) {
  if (!m?.isGroup || m?.key?.fromMe || isCommand) return false;
  const group = global.db?.groups?.[m.chat];
  if (!group || (group.antinsfw !== true && group.autostickergc !== true)) return false;

  const info = mediaTypeInfo(m);
  if (!info.isMedia) return false;
  // Sticker automation must never re-sticker a sticker or process long videos.
  const shouldSticker = group.autostickergc === true && !info.isSticker && (info.isImage || info.isVideo);
  const shouldScan = group.antinsfw === true;
  if (!shouldScan && !shouldSticker) return false;
  if (info.isVideo && info.seconds > 10 && shouldSticker && !shouldScan) return false;

  const dedupeKey = String(m?.key?.id || '');
  conn.__xeryuuGroupMediaProcessed ||= new Set();
  if (dedupeKey && conn.__xeryuuGroupMediaProcessed.has(dedupeKey)) return false;
  if (dedupeKey) {
    conn.__xeryuuGroupMediaProcessed.add(dedupeKey);
    if (conn.__xeryuuGroupMediaProcessed.size > 800) {
      const oldest = conn.__xeryuuGroupMediaProcessed.values().next().value;
      if (oldest) conn.__xeryuuGroupMediaProcessed.delete(oldest);
    }
  }

  let buffer;
  try {
    buffer = await downloadMediaBuffer(m);
    if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
    if (buffer.length > 20 * 1024 * 1024) {
      console.warn(`[GROUP MEDIA] Lewati media >20MB di ${m.chat}.`);
      return false;
    }
  } catch (error) {
    console.error('[GROUP MEDIA DOWNLOAD ERROR]', error?.message || error);
    return false;
  }

  let detectedNsfw = false;
  let nsfwScanUnknown = false;
  if (shouldScan) {
    const apiKey = String(process.env.NSFW_CHECK_API_KEY || '').trim();
    if (!apiKey) {
      nsfwScanUnknown = true;
      if (!global.__xeryuuNsfwKeyWarningLogged) {
        global.__xeryuuNsfwKeyWarningLogged = true;
        console.warn('[ANTI-NSFW] Grup mengaktifkan antinsfw tetapi NSFW_CHECK_API_KEY belum diatur. Pemindaian dilewati.');
      }
    } else {
      let tempDir = '';
      let filePath = '';
      try {
        let uploadBuffer = buffer;
        let extension = info.isVideo ? 'mp4' : (info.isSticker ? 'jpg' : (info.mime.includes('png') ? 'png' : 'jpg'));
        if (!info.isVideo) {
          try {
            const sharp = require('sharp');
            uploadBuffer = await sharp(buffer).jpeg({ quality: 88 }).toBuffer();
            extension = 'jpg';
          } catch (convertError) {
            console.warn('[ANTI-NSFW] Normalisasi gambar dilewati:', convertError?.message || convertError);
          }
        }
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-nsfw-'));
        filePath = path.join(tempDir, `media.${extension}`);
        fs.writeFileSync(filePath, uploadBuffer);

        const uploaded = await UploadFileUgu(filePath);
        const mediaUrl = typeof uploaded === 'string'
          ? uploaded.trim()
          : String(uploaded?.url || uploaded?.url_full || uploaded?.files?.[0]?.url || uploaded?.files?.url || uploaded?.file || '').trim();
        if (!/^https?:\/\//i.test(mediaUrl)) throw new Error('Penyedia upload tidak mengembalikan URL media publik.');

        const response = await axios.get('https://api.xrizal.my.id/api/tools/nsfw-checker-v2', {
          headers: { 'x-api-key': apiKey },
          params: { url: mediaUrl },
          timeout: 60000,
          maxContentLength: 2 * 1024 * 1024
        });
        const result = response?.data?.result || {};
        if (response?.data?.status && result.is_nsfw === true) {
          detectedNsfw = true;
          const sender = String(m.sender || '').split('@')[0];
          let deleted = false;
          if (isBotAdmins) {
            try {
              await conn.sendMessage(m.chat, { delete: m.key });
              deleted = true;
            } catch (deleteError) {
              console.error(`[ANTI-NSFW DELETE ERROR] ${m.chat}:`, deleteError?.message || deleteError);
            }
          }
          const categories = Array.isArray(result.kategori_pelanggaran) ? result.kategori_pelanggaran.join(', ') : '-';
          const confidence = result.keyakinan_ai ?? '-';
          const message = `🛡️ *ANTI-NSFW XERYUU*\n\nKonten berisiko terdeteksi oleh pemeriksaan otomatis.\n👤 Pengirim: @${sender}\n🎯 Keyakinan: ${confidence}\n📂 Kategori: ${categories}\n🗑️ Pesan: ${deleted ? 'berhasil dihapus' : 'tidak dapat dihapus (bot perlu admin)'}\n\n_Pemeriksaan AI dapat keliru; tinjau hasil dengan bijak._`;
          await conn.sendMessage(m.chat, { text: message, mentions: m.sender ? [m.sender] : [] }, { quoted: m });
        } else if (!response?.data?.status) {
          nsfwScanUnknown = true;
          console.warn('[ANTI-NSFW] API tidak memberi hasil valid; media tidak dihapus.');
        }
      } catch (error) {
        nsfwScanUnknown = true;
        console.error('[ANTI-NSFW SCAN ERROR]', error?.response?.data || error?.message || error);
      } finally {
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        } else if (filePath) {
          try { fs.unlinkSync(filePath); } catch {}
        }
      }
    }
  }

  // A detected NSFW message is never converted into a sticker. If the scan
  // could not run, fail closed rather than turning unchecked media into a sticker.
  if (detectedNsfw) return true;
  if (shouldScan && nsfwScanUnknown && shouldSticker) {
    console.warn(`[AUTO-STICKER-GC] Dilewati karena hasil Anti-NSFW tidak tersedia di ${m.chat}.`);
    return false;
  }

  if (shouldSticker) {
    if (info.isVideo && info.seconds > 10) return false;
    try {
      if (typeof conn.sendAsSticker !== 'function') throw new Error('Helper sendAsSticker tidak tersedia.');
      await conn.sendAsSticker(m.chat, buffer, m, {
        packname: global.packname || 'Xeryuu-Md',
        author: global.author || 'XnalzNotDev'
      });
      console.log(`[AUTO-STICKER-GC] Sticker otomatis dikirim ke ${m.chat}.`);
      return true;
    } catch (error) {
      console.error(`[AUTO-STICKER-GC ERROR] ${m.chat}:`, error?.message || error);
    }
  }
  return false;
}

async function createFakeStory(imageBuffer, username, caption) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('Gambar tidak ditemukan.');
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', imageBuffer, { filename: 'xeryuu-fakestory.jpg', contentType: 'image/jpeg' });
  const upload = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: form.getHeaders(), timeout: 45000, maxContentLength: 2 * 1024 * 1024
  });
  const avatarUrl = String(upload?.data || '').trim();
  if (!/^https?:\/\/catbox\.moe\//i.test(avatarUrl) && !/^https?:\/\/files\.catbox\.moe\//i.test(avatarUrl)) {
    throw new Error('Upload gambar gagal atau URL yang diterima tidak valid.');
  }
  const apiUrl = 'https://api.elrayyxml.web.id/api/maker/fakestory?' + new URLSearchParams({
    username: String(username || 'Anonymous').slice(0, 32),
    caption: String(caption || '-').slice(0, 300),
    avatar: avatarUrl
  }).toString();
  const response = await axios.get(apiUrl, {
    responseType: 'arraybuffer', timeout: 60000, maxContentLength: 12 * 1024 * 1024
  });
  const contentType = String(response?.headers?.['content-type'] || '').toLowerCase();
  const output = Buffer.from(response.data || []);
  if (!output.length || (contentType && !contentType.startsWith('image/'))) {
    throw new Error('API FakeStory tidak mengembalikan gambar.');
  }
  // Watermark ditempel ke gambar agar label simulasi tetap terlihat jika file diteruskan tanpa caption.
  const { createCanvas, loadImage } = getCanvas();
  const source = await loadImage(output);
  if (!source.width || !source.height) throw new Error('Hasil FakeStory tidak dapat dibaca sebagai gambar.');
  const scale = Math.min(1, 1800 / source.width, 1800 / source.height);
  const canvas = createCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(15,23,42,0.75)';
  ctx.lineWidth = Math.max(2, Math.round(canvas.width / 500));
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.max(28, Math.round(canvas.width * 0.07))}px Arial`;
  ctx.strokeText('SIMULASI • FAKE STORY', 0, 0);
  ctx.fillText('SIMULASI • FAKE STORY', 0, 0);
  ctx.restore();
  const ribbonHeight = Math.max(42, Math.round(canvas.height * 0.07));
  ctx.fillStyle = 'rgba(8,15,30,0.84)';
  ctx.fillRect(0, canvas.height - ribbonHeight, canvas.width, ribbonHeight);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = `700 ${Math.max(18, Math.round(ribbonHeight * 0.37))}px Arial`;
  ctx.fillText('MOCKUP • BUKAN UNGGAHAN ASLI', canvas.width / 2, canvas.height - Math.round(ribbonHeight * 0.35));
  return canvas.toBuffer('image/png');
}

async function createFakeFF(templateInput, playerName) {
  const raw = String(templateInput || '').trim().toLowerCase();
  const name = String(playerName || '').trim().slice(0, 24);
  if (!name) throw new Error('Nama pemain belum diisi.');
  const selected = raw === 'random' ? Math.floor(Math.random() * 22) + 1 : Number(raw);
  if (!Number.isInteger(selected) || selected < 1 || selected > 22) throw new Error('Template harus 1–22 atau random.');
  const response = await axios.get(FREE_FIRE_TEMPLATES[selected], {
    responseType: 'arraybuffer', timeout: 45000, maxContentLength: 18 * 1024 * 1024
  });
  const sourceBuffer = Buffer.from(response.data || []);
  if (!sourceBuffer.length) throw new Error('Template Free Fire kosong.');
  const { createCanvas, loadImage } = getCanvas();
  const background = await loadImage(sourceBuffer);
  if (!background.width || !background.height) throw new Error('Template Free Fire tidak valid.');
  const scale = Math.min(1, 1800 / background.width, 1800 / background.height);
  const canvas = createCanvas(Math.max(1, Math.round(background.width * scale)), Math.max(1, Math.round(background.height * scale)));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(background, 0, 0, canvas.width, canvas.height);

  let fontSize = Math.max(24, Math.min(74, Math.round(canvas.width * (name.length <= 6 ? 0.055 : name.length <= 10 ? 0.045 : name.length <= 15 ? 0.038 : 0.03))));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${fontSize}px Arial`;
  while (ctx.measureText(name.toUpperCase()).width > canvas.width * 0.86 && fontSize > 18) {
    fontSize -= 2;
    ctx.font = `900 ${fontSize}px Arial`;
  }
  ctx.lineWidth = Math.max(3, Math.round(fontSize / 10));
  ctx.strokeStyle = 'rgba(0,0,0,0.92)';
  ctx.fillStyle = '#ffe84a';
  ctx.shadowColor = '#000000';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetX = 3;
  ctx.shadowOffsetY = 3;
  ctx.strokeText(name.toUpperCase(), canvas.width / 2, canvas.height * 0.80);
  ctx.fillText(name.toUpperCase(), canvas.width / 2, canvas.height * 0.80);
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.globalAlpha = 0.24;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = `900 ${Math.max(30, Math.round(canvas.width * 0.065))}px Arial`;
  ctx.fillText('SIMULASI • FAN-MADE', 0, 0);
  ctx.restore();
  return { buffer: canvas.toBuffer('image/png'), template: selected, name };
}

async function createFakeML(imageBuffer, nickname) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('Gambar tidak ditemukan. Reply gambar terlebih dahulu.');
  const { createCanvas, loadImage } = getCanvas();
  const userImage = await loadImage(imageBuffer).catch(() => null);
  if (!userImage) throw new Error('Gambar yang dikirim tidak dapat dibaca.');
  const loadRemoteImage = async (url) => {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 45000, maxContentLength: 12 * 1024 * 1024 });
    const data = Buffer.from(response.data || []);
    if (!data.length) throw new Error('Gambar template kosong.');
    return loadImage(data);
  };
  const [bg, frame] = await Promise.all([
    loadRemoteImage('https://files.catbox.moe/liplnf.jpg').catch(() => null),
    loadRemoteImage('https://files.catbox.moe/2vm2lt.png').catch(() => null)
  ]);
  if (!bg || !frame) throw new Error('Background atau frame ML tidak dapat diakses.');
  if (bg.width > 2200 || bg.height > 2200) throw new Error('Ukuran template terlalu besar.');
  const canvas = createCanvas(bg.width, bg.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
  const avatarSize = Math.round(Math.min(205, canvas.width * 0.16));
  const frameSize = Math.round(Math.min(293, canvas.width * 0.23));
  const centerX = (canvas.width - frameSize) / 2;
  const centerY = Math.max(0, (canvas.height - frameSize) / 2 - Math.round(canvas.height * 0.26));
  const avatarX = centerX + (frameSize - avatarSize) / 2;
  const avatarY = centerY + (frameSize - avatarSize) / 2 - 3;
  const side = Math.min(userImage.width, userImage.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(userImage, (userImage.width - side) / 2, (userImage.height - side) / 2, side, side, avatarX, avatarY, avatarSize, avatarSize);
  ctx.restore();
  ctx.drawImage(frame, centerX, centerY, frameSize, frameSize);
  const name = String(nickname || 'Xeryuu').trim().slice(0, 20);
  let fontSize = Math.max(20, Math.min(42, Math.round(canvas.width * 0.032)));
  ctx.textAlign = 'center';
  ctx.font = `900 ${fontSize}px Arial`;
  while (ctx.measureText(name).width > canvas.width * 0.62 && fontSize > 18) {
    fontSize -= 2;
    ctx.font = `900 ${fontSize}px Arial`;
  }
  ctx.lineWidth = 4; ctx.strokeStyle = '#1b1230'; ctx.fillStyle = '#ffffff';
  ctx.strokeText(name, canvas.width / 2, Math.min(canvas.height - 26, centerY + frameSize + 24));
  ctx.fillText(name, canvas.width / 2, Math.min(canvas.height - 26, centerY + frameSize + 24));
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(-Math.PI / 7);
  ctx.globalAlpha = 0.30; ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center';
  ctx.font = `900 ${Math.max(28, Math.round(canvas.width * 0.06))}px Arial`;
  ctx.fillText('SIMULASI • FAN-MADE', 0, 0); ctx.restore();
  return { buffer: canvas.toBuffer('image/png'), name };
}

async function createFakeDana(amountInput) {
  const digits = String(amountInput || '').replace(/[^0-9]/g, '');
  if (!digits || !Number.isSafeInteger(Number(digits)) || Number(digits) <= 0) throw new Error('Nominal tidak valid. Contoh: fakedana 150000');
  const amount = Number(digits).toLocaleString('id-ID');
  const { createCanvas } = getCanvas();
  const width = 900, height = 1400;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#071d48'); bg.addColorStop(0.55, '#0d63a7'); bg.addColorStop(1, '#08234a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let y = -200; y < height + 200; y += 150) { ctx.save(); ctx.translate(width / 2, y); ctx.rotate(-0.25); ctx.fillRect(-width, 0, width * 2, 40); ctx.restore(); }
  const rounded = (x, y, w, h, r, fill) => {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  rounded(42, 42, width - 84, height - 84, 34, '#ffffff');
  rounded(42, 42, width - 84, 210, 34, '#0876d1');
  ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.font = '900 62px Arial'; ctx.fillText('DANA • MOCKUP', 82, 133);
  ctx.font = '600 25px Arial'; ctx.fillText('CONTOH TAMPILAN • TANPA TRANSAKSI', 84, 185);
  ctx.textAlign = 'center'; ctx.fillStyle = '#0d3974'; ctx.font = '700 32px Arial'; ctx.fillText('SIMULASI NOMINAL', width / 2, 360);
  ctx.fillStyle = '#092956'; ctx.font = '900 74px Arial';
  let amountText = `Rp ${amount}`;
  while (ctx.measureText(amountText).width > width - 130 && ctx.measureText(amountText).width > 100) { ctx.font = `900 ${parseInt(ctx.font.match(/(\d+)px/)[1], 10) - 3}px Arial`; }
  ctx.fillText(amountText, width / 2, 475);
  ctx.strokeStyle = '#d6e3f5'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(92, 540); ctx.lineTo(width - 92, 540); ctx.stroke();
  ctx.textAlign = 'left'; ctx.fillStyle = '#60718c'; ctx.font = '600 25px Arial'; ctx.fillText('STATUS', 95, 625);
  ctx.fillStyle = '#ad2b20'; ctx.font = '900 34px Arial'; ctx.fillText('TIDAK ADA TRANSAKSI', 95, 676);
  ctx.fillStyle = '#60718c'; ctx.font = '600 25px Arial'; ctx.fillText('TANGGAL PEMBUATAN MOCKUP', 95, 765);
  ctx.fillStyle = '#0b2a51'; ctx.font = '700 30px Arial'; ctx.fillText(new Date().toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' }), 95, 816);
  rounded(92, 905, width - 184, 145, 20, '#edf4fb');
  ctx.fillStyle = '#405a78'; ctx.font = '600 24px Arial'; ctx.fillText('Gambar ini hanya contoh desain.', 123, 962);
  ctx.fillText('Bukan bukti pembayaran atau transfer.', 123, 1006);
  ctx.save(); ctx.translate(width / 2, height / 2); ctx.rotate(-Math.PI / 5);
  ctx.globalAlpha = 0.20; ctx.fillStyle = '#e11d48'; ctx.textAlign = 'center'; ctx.font = '900 96px Arial'; ctx.fillText('SIMULASI', 0, 0);
  ctx.restore();
  ctx.textAlign = 'center'; ctx.fillStyle = '#6e8098'; ctx.font = '600 22px Arial'; ctx.fillText('GENERATED BY XERYUU-MD • NOT A RECEIPT', width / 2, 1285);
  return { buffer: canvas.toBuffer('image/png'), amount };
}

module.exports = {
  handleGroupMediaAutomation,
  createFakeStory,
  createFakeFF,
  createFakeML,
  createFakeDana
};
