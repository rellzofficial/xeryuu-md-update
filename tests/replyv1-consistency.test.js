'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const source = fs.readFileSync(path.join(root, 'xeryuu.js'), 'utf8')
const marker = '\n}\n\n// Compatibility helper'
const start = source.indexOf('async function replyV1(teks, options = {}) {')
const end = source.indexOf(marker, start)
assert.ok(start >= 0 && end > start, 'replyV1 definition must exist with its original helper boundary')
const functionSource = source.slice(start, end + 2)

async function makeReplyV1(sendMessage) {
  const env = {
    Buffer,
    console,
    global: { botname: 'Xeryuu-MD', idSaluran: '120363000000000001@newsletter', namaSaluran: 'Xeryuu Channel' },
    botname: 'Xeryuu-MD',
    idSaluran: '120363000000000001@newsletter',
    namaSaluran: 'Xeryuu Channel',
    m: { chat: '628123456789@s.whatsapp.net', sender: '628123456789@s.whatsapp.net', key: { id: 'incoming-id' } },
    qtoko: { key: { id: 'fallback-quote' } },
    conn: { sendMessage },
    styleXeryuuReplyText: value => {
      const raw = String(value ?? '').replace(/\*/g, '')
      if (!raw.trim() || /^\s*```[\s\S]*```\s*$/.test(raw)) return raw
      return `\`\`\`${raw}\`\`\``
    },
    readProjectAsset: () => Buffer.from('thumbnail-bytes')
  }
  return vm.runInNewContext(`(async () => { ${functionSource}; return replyV1; })()`, env)
}

test('replyV1 sends the Xeryuu fake-document payload and keeps mentions/context metadata', async () => {
  let captured
  const replyV1 = await makeReplyV1(async (...args) => { captured = args; return { key: { id: 'sent' } } })
  const result = await replyV1('Halo *Xeryuu*', { mentions: ['628111111111@s.whatsapp.net'] })

  assert.equal(result.key.id, 'sent')
  assert.equal(captured[0], '628123456789@s.whatsapp.net')
  assert.ok(Buffer.isBuffer(captured[1].document), 'replyV1 should send a document, not plain text')
  assert.equal(captured[1].document.toString(), 'Xeryuu | MD✨')
  assert.equal(captured[1].mimetype, 'image/jpg')
  assert.equal(captured[1].caption, '```Halo Xeryuu```')
  assert.deepEqual(Array.from(captured[1].mentions), ['628123456789@s.whatsapp.net', '628111111111@s.whatsapp.net'])
  assert.equal(captured[1].contextInfo.forwardedNewsletterMessageInfo.newsletterName, 'Xeryuu Channel')
  assert.ok(Buffer.isBuffer(captured[1].jpegThumbnail))
  assert.equal(captured[2].quoted.key.id, 'incoming-id')
})

test('replyV1 respects noAdReply and does not inject default newsletter metadata', async () => {
  let captured
  const replyV1 = await makeReplyV1(async (...args) => { captured = args; return true })
  await replyV1('Pesan tanpa metadata channel', { noAdReply: true, contextInfo: { mentionedJid: ['628111111111@s.whatsapp.net'] } })
  assert.equal(captured[1].contextInfo.forwardedNewsletterMessageInfo, undefined)
  assert.deepEqual(Array.from(captured[1].contextInfo.mentionedJid), ['628111111111@s.whatsapp.net'])
  assert.ok(Buffer.isBuffer(captured[1].document))
})

test('replyV1 document fallback remains a fake document when the first send fails', async () => {
  const calls = []
  const replyV1 = await makeReplyV1(async (...args) => {
    calls.push(args)
    if (calls.length === 1) throw new Error('simulated primary send failure')
    return { key: { id: 'fallback-sent' } }
  })
  const result = await replyV1('Pesan fallback')
  assert.equal(result.key.id, 'fallback-sent')
  assert.equal(calls.length, 2)
  assert.ok(Buffer.isBuffer(calls[1][1].document))
  assert.equal(calls[1][1].document.toString(), 'Xeryuu | MD✨')
  assert.equal(calls[1][1].text, undefined, 'fallback must not silently switch to plain text')
})


test('replyV1 can target a timer chat without quoting or mentioning the most recent sender', async () => {
  let captured
  const replyV1 = await makeReplyV1(async (...args) => { captured = args; return true })
  await replyV1('Timer selesai', { chatOverride: '120363000000000009@g.us', includeSenderMention: false, quoted: null, fallbackQuoted: null })
  assert.equal(captured[0], '120363000000000009@g.us')
  assert.deepEqual(Array.from(captured[1].mentions), [])
  assert.equal(Object.keys(captured[2]).length, 0)
  assert.ok(Buffer.isBuffer(captured[1].document))
})

test('reply aliases preserve options when forwarding to replyV1', () => {
  for (const alias of ['replytolak', 'Reply', 'replyXeryuu', 'replyXeryuu1', 'replytolak1', 'reply']) {
    const line = source.split('\n').find(item => item.includes(`const ${alias} =`))
    assert.ok(line, `${alias} declaration must exist`)
    assert.match(line, /options = \{\}/, `${alias} should accept options`)
    assert.match(line, /replyV1\(.*options\)/, `${alias} should pass options through`)
  }
})


test('replyV1 declaration is hoisted so early moderation handlers cannot hit the const temporal dead zone', () => {
  assert.match(source, /async function replyV1\(teks, options = \{\}\)/)
  assert.doesNotMatch(source, /const replyV1\s*=\s*async/)
  const declaration = source.indexOf('async function replyV1(teks, options = {})')
  const earlyCall = source.indexOf('replyV1("🚫 Link grup terdeteksi!")')
  assert.ok(earlyCall >= 0 && earlyCall < declaration, 'a replyV1 call before the declaration should remain safe because the declaration is hoisted')
})

test('text replies from shared game modules are routed through replyV1', () => {
  const gameSource = fs.readFileSync(path.join(root, 'library', 'games.js'), 'utf8')
  const caklontongSource = fs.readFileSync(path.join(root, 'library', 'caklontong.js'), 'utf8')
  assert.match(source, /gameHub\.restoreLegacyTimers\(conn,\s*\(chat, timeoutText, quoteMessage\) => replyV1/)
  assert.match(source, /reply: \(message, options = \{\}\) => replyV1\(message, options\)/)
  assert.match(gameSource, /activeLegacyReplySender\(room\.chat, body, quoteMessage\)/)
  assert.match(gameSource, /if \(typeof ctx\.reply === 'function'\) await ctx\.reply\(message\)/)
  assert.match(caklontongSource, /async function sendTextReply\(ctx, text, options = \{\}\)/)
  assert.match(caklontongSource, /session\.reply\(timeoutText, \{/)
})
