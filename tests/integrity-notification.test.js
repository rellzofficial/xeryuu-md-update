'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { formatTelegramAlert, resolveIntegrityTelegramConfig } = require('../library/integrity-notification.js')

test('notifier uses its dedicated token and never falls back to auto-order token', () => {
  const config = resolveIntegrityTelegramConfig({
    env: { TELEGRAM_BOT_TOKEN: 'AUTO_ORDER_TOKEN', XERYUU_INTEGRITY_TELEGRAM_CHAT_IDS: '123,456' },
    auth: { apiKeys: { telegramBotToken: 'AUTO_ORDER_AUTH', integrityTelegramBotToken: '' }, developerTelegramIds: ['789'] },
    globalConfig: { botToken: 'GLOBAL_AUTO_ORDER', adminIds: ['000'] }
  })
  assert.equal(config.token, '')
  assert.deepEqual(config.recipients, ['123', '456'])
})

test('notifier refuses the same token as auto-order bot', () => {
  const config = resolveIntegrityTelegramConfig({
    env: { TELEGRAM_BOT_TOKEN: 'SAME_TOKEN', XERYUU_INTEGRITY_TELEGRAM_TOKEN: 'SAME_TOKEN' },
    auth: { developerTelegramIds: ['123'] }
  })
  assert.equal(config.token, '')
  assert.equal(config.tokenConflict, true)
})

test('notifier reads separate token and formats Telegram blockquote safely', () => {
  const config = resolveIntegrityTelegramConfig({
    env: { XERYUU_INTEGRITY_TELEGRAM_TOKEN: 'NOTIFIER_TOKEN' },
    auth: { developerTelegramIds: ['123'] }
  })
  assert.equal(config.token, 'NOTIFIER_TOKEN')
  const message = formatTelegramAlert('⚠️ XERYUU-MD — INTEGRITY MONITOR\nFile: <index.js>\nStatus: changed & replaced')
  assert.match(message, /<blockquote>/)
  assert.match(message, /<\/blockquote>/)
  assert.match(message, /&lt;index\.js&gt;/)
  assert.match(message, /changed &amp; replaced/)
})
