'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tourl = require('../library/tourl')
const brat = require('../library/brat')
const caklontong = require('../library/caklontong')
const tools = require('../library/indonesia-tools')

test('TOURL validates URLs and restricts provider hosts', () => {
  assert.equal(tourl.isHttpUrl('https://files.catbox.moe/a1.png', ['catbox.moe']), true)
  assert.equal(tourl.isHttpUrl('https://evil.example/a1.png', ['catbox.moe']), false)
  assert.equal(tourl.isHttpUrl('javascript:alert(1)'), false)
  assert.equal(tourl.getExtension('image/jpeg; charset=binary'), 'jpg')
})

test('BRAT color parser accepts supported names and HEX but rejects invalid input', () => {
  assert.equal(brat.normalizeColor('#Ff00Aa', '#fff'), '#ff00aa')
  assert.equal(brat.normalizeColor('navy', '#fff'), 'navy')
  assert.equal(brat.normalizeColor('definitely-not-a-color', '#fff'), '#fff')
})

test('TOURL2 Pixhost path accepts supported image formats and rejects non-image hosts/formats', () => {
  assert.equal(tourl.isPixhostImageType('image/jpeg'), true)
  assert.equal(tourl.isPixhostImageType('image/webp'), true)
  assert.equal(tourl.isPixhostImageType('image/avif'), true)
  assert.equal(tourl.isPixhostImageType('application/pdf'), false)
  assert.equal(tourl.isPixhostUrl('https://t1.pixhost.to/thumbs/1/a.png'), true)
  assert.equal(tourl.isPixhostUrl('https://evil.example/a.png'), false)
})

test('stock formatter clearly flags cached prices when upstream is unavailable', () => {
  const output = tools.formatStockQuote({
    name: 'PT Contoh Tbk', symbol: 'CONTOH.JK', price: 1000, change: null, changePercent: null,
    volume: null, updatedAt: '18 Okt 2026 10.00 WIB', delayedByMinutes: null, marketState: 'CLOSED',
    source: 'Yahoo Finance Chart API', note: 'Kutipan dapat tertunda.', isStale: true, cacheFetchedAt: Date.now() - 3600000
  })
  assert.match(output, /CACHE LOKAL/)
  assert.match(output, /bukan konfirmasi harga terkini/)
})

test('Indonesian plate check validates common formats without claiming owner data', () => {
  const plate = tools.parseIndonesianPlate('b-1234-xyz')
  assert.equal(plate.validFormat, true)
  assert.equal(plate.prefix, 'B')
  assert.match(plate.region, /Jakarta/)
  assert.equal(tools.parseIndonesianPlate('NOT A PLATE').validFormat, false)
})

test('stock symbol parser supports Indonesian, international and IHSG tickers', () => {
  assert.equal(tools.normalizeStockSymbol('bbca'), 'BBCA.JK')
  assert.equal(tools.normalizeStockSymbol('TLKM.JK'), 'TLKM.JK')
  assert.equal(tools.normalizeStockSymbol('AAPL'), 'AAPL')
  assert.equal(tools.normalizeStockSymbol('MSFT'), 'MSFT')
  assert.equal(tools.normalizeStockSymbol('IHSG'), '^JKSE')
  assert.equal(tools.normalizeStockSymbol('^JKSE'), '^JKSE')
  assert.throws(() => tools.normalizeStockSymbol('BBCA;rm'), /Kode saham tidak valid/)
})

test('Cak Lontong dataset validation ignores incomplete records and normalizes answers', () => {
  const questions = caklontong.validateQuestions([
    { soal: 'Soal?', jawaban: '  Kuda  ', deskripsi: 'Penjelasan.' },
    { soal: 'Tidak lengkap', jawaban: 'x' },
    null
  ])
  assert.equal(questions.length, 1)
  assert.equal(questions[0].jawaban, 'Kuda')
  assert.equal(caklontong.normalizeAnswer(' Kuda! '), 'kuda')
})

test('script diagnostics finds syntax, missing local require and invalid static JSON in a fixture', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-diagnostic-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'index.js'), 'require(' + "'./missing-module'" + ')\n')
  fs.writeFileSync(path.join(root, 'bad.js'), 'const invalid = ;\n')
  fs.writeFileSync(path.join(root, 'settings.json'), '{ invalid json')
  fs.writeFileSync(path.join(root, 'optional-auth.js'), "try { require('./authen.js') } catch {}\n")
  const report = await tools.diagnoseProject(root)
  assert.ok(report.issueCount >= 3)
  assert.equal(report.issues.some(issue => issue.file.endsWith('optional-auth.js') && issue.detail === './authen.js'), false)
  assert.ok(report.issues.some(issue => issue.type === 'Syntax JavaScript'))
  assert.ok(report.issues.some(issue => issue.type === 'Require lokal tidak ditemukan'))
  assert.ok(report.issues.some(issue => issue.type === 'JSON tidak valid'))
  assert.match(tools.formatDiagnostics(report), /DIAGNOSTIK SCRIPT XERYUU/)
})
