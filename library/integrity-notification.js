'use strict'

function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
}

function formatTelegramAlert(text) {
  const clean = String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim()
  const lines = clean.slice(0, 3300).split(/\r?\n/)
  const title = escapeTelegramHtml(lines.shift() || 'XERYUU-MD | INTEGRITY MONITOR')
  const details = lines.map(line => {
    const idx = line.indexOf(':')
    if (idx > 0 && idx <= 58) {
      return `<b>${escapeTelegramHtml(line.slice(0, idx))}:</b> ${escapeTelegramHtml(line.slice(idx + 1).trim())}`
    }
    return escapeTelegramHtml(line)
  }).join('\n')
  return `<b>${title}</b>\n<blockquote>${details || 'Tidak ada detail tambahan.'}</blockquote>\n<i>Notifikasi otomatis Xeryuu-MD • Bot khusus monitoring</i>`
}

function resolveIntegrityTelegramConfig(options = {}) {
  const env = options.env || process.env
  const auth = options.auth || {}
  const globalConfig = options.globalConfig || {}

  // Deliberately do not fall back to TELEGRAM_BOT_TOKEN / global.telegramConfig.botToken:
  // that token belongs to Xeryuu's auto-order bot and must remain isolated.
  const token = String(
    env.XERYUU_INTEGRITY_TELEGRAM_TOKEN ||
    auth.apiKeys?.integrityTelegramBotToken ||
    ''
  ).trim()
  const autoOrderToken = String(
    env.TELEGRAM_BOT_TOKEN ||
    auth.apiKeys?.telegramBotToken ||
    globalConfig.botToken ||
    ''
  ).trim()
  const tokenConflict = Boolean(token && autoOrderToken && token === autoOrderToken)

  const envRecipients = String(env.XERYUU_INTEGRITY_TELEGRAM_CHAT_IDS || '')
    .split(',').map(value => value.trim()).filter(Boolean)
  const configuredRecipients = Array.isArray(auth.developerTelegramIds) && auth.developerTelegramIds.length
    ? auth.developerTelegramIds.map(String)
    : (Array.isArray(globalConfig.adminIds) ? globalConfig.adminIds.map(String) : [])
  const recipients = [...new Set((envRecipients.length ? envRecipients : configuredRecipients)
    .map(value => String(value).trim()).filter(Boolean))]

  return { token: tokenConflict ? '' : token, recipients, tokenConflict }
}

module.exports = { escapeTelegramHtml, formatTelegramAlert, resolveIntegrityTelegramConfig }
