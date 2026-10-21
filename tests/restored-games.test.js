'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const extension = require('../library/xeryuu-extension')
const rpgFun = require('../library/rpg-fun-integration')

function makeExtensionContext(args = []) {
  const sent = []
  let balance = 10000
  const jid = 'restore-games-user@s.whatsapp.net'
  global.db = { erpg: { [jid]: { rpg: true, stamina: 100, darahuser: 100 } } }
  return {
    sent,
    ctx: {
      m: { sender: jid, chat: jid, isGroup: false, pushName: 'Tester' },
      conn: {
        sendMessage: async (chat, payload, options) => {
          sent.push({ chat, payload, options })
          return { key: { id: `restore-${sent.length}` } }
        }
      },
      args,
      text: args.join(' '),
      prefix: '.',
      economy: {
        getBalance: () => balance,
        addMoney: (_jid, delta) => { balance = Math.max(0, balance + Number(delta || 0)) },
        formatMoney: value => Math.round(Number(value || 0)).toLocaleString('id-ID'),
        parseAmount: value => {
          const raw = String(value || '').trim().toLowerCase().replace(/[.\s]/g, '').replace(/rp/g, '')
          if (/k$/.test(raw)) return Number(raw.slice(0, -1)) * 1000
          if (/m$/.test(raw)) return Number(raw.slice(0, -1)) * 1000000
          return /^\d+$/.test(raw) ? Number(raw) : 0
        },
        profile: () => ({ wallet: balance, bank: 0, total: balance }),
        deposit: () => ({ ok: false }),
        withdraw: () => ({ ok: false }),
        crime: () => ({ ok: false, error: 'UNAVAILABLE' }),
        rob: () => ({ ok: false, error: 'UNAVAILABLE' })
      },
      reply: async text => {
        sent.push({ chat: jid, payload: { text } })
        return { key: { id: `reply-${sent.length}` } }
      },
      saveGlobalDb: () => {}
    }
  }
}

test('virtual arcade commands are registered and listed in game/RPG menus', () => {
  const extensionCommands = new Set(extension.getCommandNames())
  for (const cmd of ['bet', 'casino', 'slot', 'blackjack']) assert.ok(extensionCommands.has(cmd), `${cmd} missing from extension command list`)

  const rpgFunCommands = new Set(rpgFun.getCommandNames())
  for (const cmd of ['lotre', 'poker3', 'hilo', 'rr', 'sabung', 'bomb', 'heist', 'begal', 'kiss', 'bite', 'yeet', 'bully', 'bonk', 'slap', 'glomp', 'cuddle', 'handhold', 'tickle', 'kill', 'gaycheck', 'lesbiancheck', 'lesbicheck', 'hornycheck', 'spank', 'lick', 'feed', 'funfeed', 'foxgirl', 'avatar', 'awoo']) {
    assert.ok(rpgFunCommands.has(cmd), `${cmd} missing from RPG/Fun command list`)
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'xeryuu.js'), 'utf8')
  for (const cmd of ['bet', 'casino', 'slot', 'blackjack', 'lotre', 'poker3', 'hilo', 'rr', 'sabung', 'bomb', 'heist', 'begal', 'kiss', 'bite', 'yeet', 'bully', 'bonk', 'slap', 'glomp', 'cuddle', 'handhold', 'tickle', 'kill', 'gaycheck', 'lesbiancheck', 'lesbicheck', 'hornycheck', 'spank', 'lick', 'funfeed', 'foxgirl', 'avatar']) {
    assert.match(source, new RegExp(`\\.${cmd}\\b`), `${cmd} missing from user-facing menu`)
  }
  assert.doesNotMatch(source, /\.blackjack\s*\(dinonaktifkan\)/i)
  const guard = source.match(/const XERYUU_DISABLED_UNSAFE_GAMES = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(guard, 'legacy feature guard must be explicit')
  for (const cmd of ['bet', 'casino', 'slot', 'blackjack', 'lotre', 'poker3', 'hilo', 'rr', 'sabung', 'bomb', 'heist', 'begal']) {
    assert.doesNotMatch(guard[1], new RegExp(`['\"]${cmd}['\"]`), `${cmd} must not be blocked by the legacy feature guard`)
  }
})

test('virtual bet, casino, and slot respond with active usage instructions', async () => {
  for (const cmd of ['bet', 'casino', 'slot']) {
    const env = makeExtensionContext([])
    assert.equal(await extension.handle(cmd, env.ctx), true, `${cmd} was not handled`)
    assert.match(env.sent.at(-1).payload.text, /virtual/i)
    assert.doesNotMatch(env.sent.at(-1).payload.text, /dinonaktifkan|tidak diaktifkan/i)
  }
})

test('blackjack starts normally without disabling its command', async () => {
  const env = makeExtensionContext([])
  assert.equal(await extension.handle('blackjack', env.ctx), true)
  assert.match(env.sent.at(-1).payload.text, /BLACKJACK/i)
  assert.doesNotMatch(env.sent.at(-1).payload.text, /dinonaktifkan|tidak diaktifkan/i)
})
