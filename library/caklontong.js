'use strict';

const fs = require('fs');
const path = require('path');

const QUESTION_URL = 'https://raw.githubusercontent.com/BochilTeam/database/master/games/caklontong.json';
const CACHE_FILE = path.join(__dirname, 'database', 'caklontong-questions.json');
const SESSION_TIMEOUT_MS = 60_000;
const MAX_ACTIVE_SESSIONS = 100;
const sessions = new Map();
let cachedQuestions = null;
let cachedAt = 0;
const MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function normalizeAnswer(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLocaleLowerCase('id-ID')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateQuestions(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return null;
    const soal = String(item.soal || '').trim();
    const jawaban = String(item.jawaban || '').trim();
    const deskripsi = String(item.deskripsi || '').trim();
    if (!soal || !jawaban || !deskripsi || soal.length > 1000 || jawaban.length > 250 || deskripsi.length > 2000) return null;
    return { soal, jawaban, deskripsi };
  }).filter(Boolean);
}

function readQuestionCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    const questions = validateQuestions(parsed);
    return questions.length ? questions : null;
  } catch (_) {
    return null;
  }
}

function writeQuestionCache(questions) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const temporaryFile = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(questions, null, 2));
    fs.renameSync(temporaryFile, CACHE_FILE);
    return true;
  } catch (error) {
    console.warn('[CAKLONTONG] Tidak dapat menyimpan cache soal:', error?.message || error);
    return false;
  }
}

async function getQuestions(options = {}) {
  const now = Date.now();
  if (!options.forceRefresh && cachedQuestions && now - cachedAt < MEMORY_CACHE_TTL_MS) return cachedQuestions;

  const diskCache = !options.forceRefresh ? readQuestionCache() : null;
  if (diskCache?.length) {
    cachedQuestions = diskCache;
    cachedAt = now;
    return cachedQuestions;
  }

  let lastError = null;
  try {
    const axios = require('axios');
    const response = await axios.get(QUESTION_URL, {
      timeout: 12000,
      maxContentLength: 5 * 1024 * 1024,
      headers: { 'User-Agent': 'Xeryuu-MD/16.5 CakLontong game' },
      validateStatus: status => status >= 200 && status < 300
    });
    const questions = validateQuestions(response?.data);
    if (questions.length < 10) throw new Error('Dataset Cak Lontong tidak berisi cukup soal yang valid.');
    writeQuestionCache(questions);
    cachedQuestions = questions;
    cachedAt = Date.now();
    return cachedQuestions;
  } catch (error) {
    lastError = error;
  }

  const fallbackCache = readQuestionCache();
  if (fallbackCache?.length) {
    cachedQuestions = fallbackCache;
    cachedAt = Date.now();
    return cachedQuestions;
  }
  throw new Error(`Dataset soal Cak Lontong tidak dapat diakses dan cache lokal belum tersedia${lastError?.message ? `: ${String(lastError.message).slice(0, 180)}` : '.'}`);
}

function sessionKey(chat, sender) {
  return `${String(chat || '')}|${String(sender || '')}`;
}

function clearSession(key) {
  const session = sessions.get(key);
  if (session?.timer) clearTimeout(session.timer);
  sessions.delete(key);
}

async function start(ctx) {
  const { conn, m } = ctx || {};
  if (!conn || !m) throw new Error('Konteks pesan tidak lengkap.');
  if (!m.isGroup) {
    await ctx.reply('Game Cak Lontong hanya dapat dimainkan di grup, sesuai alur Furina V18.');
    return false;
  }

  const key = sessionKey(m.chat, m.sender);
  if (sessions.has(key)) {
    await ctx.reply('Kamu masih memiliki sesi Cak Lontong yang belum selesai. Jawab soal sebelumnya terlebih dahulu.');
    return true;
  }
  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    await ctx.reply('Sesi Cak Lontong sedang penuh. Coba lagi setelah beberapa sesi selesai.');
    return true;
  }

  const questions = await getQuestions();
  const question = questions[Math.floor(Math.random() * questions.length)];
  const session = {
    key,
    chat: m.chat,
    sender: m.sender,
    question: question.soal,
    answer: question.jawaban,
    normalizedAnswer: normalizeAnswer(question.jawaban),
    description: question.deskripsi,
    startMessage: m,
    expiresAt: Date.now() + SESSION_TIMEOUT_MS,
    timer: null
  };
  if (!session.normalizedAnswer) throw new Error('Dataset memberikan jawaban kosong setelah dinormalisasi.');

  sessions.set(key, session);
  try {
    await conn.sendMessage(m.chat, {
      text: `🧠 *CAK LONTONG*\n\n❓ Soal:\n${session.question}\n\n⏳ Waktu: 60 detik\n\nBalas dengan jawaban langsung di grup.`
    }, { quoted: m });
  } catch (error) {
    clearSession(key);
    throw error;
  }

  session.timer = setTimeout(async () => {
    if (sessions.get(key) !== session) return;
    sessions.delete(key);
    try {
      await conn.sendMessage(session.chat, {
        text: `⏰ *WAKTU HABIS*\n\nJawaban: *${session.answer}*\n\nPenjelasan: ${session.description}`
      }, { quoted: session.startMessage });
    } catch (error) {
      console.error('[CAKLONTONG TIMEOUT SEND]', error?.message || error);
    }
  }, SESSION_TIMEOUT_MS);
  if (typeof session.timer.unref === 'function') session.timer.unref();
  return true;
}

async function processAnswer(ctx) {
  const { conn, m, body, isCmd } = ctx || {};
  if (!conn || !m || !m.isGroup || m.key?.fromMe || isCmd) return false;
  const key = sessionKey(m.chat, m.sender);
  const session = sessions.get(key);
  if (!session) return false;
  if (Date.now() >= session.expiresAt) {
    clearSession(key);
    await conn.sendMessage(m.chat, {
      text: `⏰ *WAKTU HABIS*\n\nJawaban: *${session.answer}*\n\nPenjelasan: ${session.description}`
    }, { quoted: m });
    return true;
  }
  const normalized = normalizeAnswer(body);
  if (!normalized || normalized !== session.normalizedAnswer) return false;

  clearSession(key);
  await conn.sendMessage(m.chat, {
    text: `✅ *JAWABAN BENAR!*\n\n❓ Soal: ${session.question}\n💡 Jawaban: *${session.answer}*\n📖 Penjelasan: ${session.description}`
  }, { quoted: m });
  return true;
}

function getActiveSessionCount() {
  return sessions.size;
}

module.exports = {
  QUESTION_URL,
  SESSION_TIMEOUT_MS,
  normalizeAnswer,
  validateQuestions,
  getQuestions,
  start,
  processAnswer,
  getActiveSessionCount
};
