'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const wa = require('../library/wa-connection.js')

test.beforeEach(() => {
    wa.resetVersionCache()
    global.runtimeConfig = { waVersion: '2,3000,1000000000', waVersionMode: 'auto' }
})

test('versi terbaru dipakai lebih dulu pada mode auto', async () => {
    const result = await wa.resolveWaVersion({
        attempt: 0,
        fetcher: async () => ({ version: [2, 3000, 1099999999], isLatest: true })
    })
    assert.deepEqual(result.version, [2, 3000, 1099999999])
    assert.equal(result.source, 'latest')
})

test('gagal mengambil versi terbaru jatuh ke versi patokan', async () => {
    const result = await wa.resolveWaVersion({
        attempt: 0,
        fetcher: async () => { throw new Error('offline') }
    })
    assert.deepEqual(result.version, [2, 3000, 1000000000])
    assert.match(result.source, /pinned/)
})

test('isLatest=false dari Baileys tidak dianggap versi terbaru dan tidak di-cache', async () => {
    const first = await wa.resolveWaVersion({
        attempt: 0,
        fetcher: async () => ({ version: [2, 3000, 1], isLatest: false, error: new Error('x') })
    })
    assert.deepEqual(first.version, [2, 3000, 1000000000])
    const second = await wa.resolveWaVersion({
        attempt: 0,
        fetcher: async () => ({ version: [2, 3000, 1055555555], isLatest: true })
    })
    assert.deepEqual(second.version, [2, 3000, 1055555555])
})

test('fetch yang menggantung dibatasi timeout dan tidak menahan startup', async () => {
    const started = Date.now()
    const result = await wa.resolveWaVersion({
        attempt: 0,
        timeoutMs: 50,
        fetcher: () => new Promise(() => {})
    })
    assert.ok(Date.now() - started < 1000)
    assert.deepEqual(result.version, [2, 3000, 1000000000])
})

test('tangga percobaan: terbaru -> patokan -> default setelah 405 berulang', async () => {
    const fetcher = async () => ({ version: [2, 3000, 1088888888], isLatest: true })
    const a0 = await wa.resolveWaVersion({ attempt: 0, fetcher })
    const a1 = await wa.resolveWaVersion({ attempt: 1, fetcher })
    const a2 = await wa.resolveWaVersion({ attempt: 2, fetcher })
    const a9 = await wa.resolveWaVersion({ attempt: 9, fetcher })
    assert.deepEqual(a0.version, [2, 3000, 1088888888])
    assert.deepEqual(a1.version, [2, 3000, 1000000000])
    assert.equal(a2.version, undefined)
    assert.equal(a9.version, undefined)
})

test('mode pinned memakai patokan lebih dulu', async () => {
    global.runtimeConfig.waVersionMode = 'pinned'
    const result = await wa.resolveWaVersion({
        attempt: 0,
        fetcher: async () => ({ version: [2, 3000, 1088888888], isLatest: true })
    })
    assert.deepEqual(result.version, [2, 3000, 1000000000])
})

test('nomor pairing dinormalisasi untuk WhatsApp biasa dan Business', () => {
    assert.equal(wa.normalizePairingNumber('0812-3456-7890'), '6281234567890')
    assert.equal(wa.normalizePairingNumber('+62 0812 3456 7890'), '6281234567890')
    assert.equal(wa.normalizePairingNumber('6281234567890'), '6281234567890')
    assert.equal(wa.normalizePairingNumber('0062 812 3456 7890'), '6281234567890')
    assert.equal(wa.normalizePairingNumber('12'), '')
    assert.equal(wa.normalizePairingNumber(''), '')
})

test('kode pairing custom divalidasi terhadap alfabet WhatsApp', () => {
    assert.deepEqual(wa.sanitizeCustomPairingCode('xnalzdev'), { code: 'XNALZDEV', reason: '' })
    assert.equal(wa.sanitizeCustomPairingCode('ABCDEFGO').code, '')
    assert.equal(wa.sanitizeCustomPairingCode('ABC').code, '')
    assert.deepEqual(wa.sanitizeCustomPairingCode(''), { code: '', reason: '' })
})

test('backoff naik bertahap dan dibatasi', () => {
    const d1 = wa.backoffDelay(1, 3000, 30000)
    const d3 = wa.backoffDelay(3, 3000, 30000)
    const d20 = wa.backoffDelay(20, 3000, 30000)
    assert.ok(d1 >= 3000 && d1 <= 3300)
    assert.ok(d3 >= 12000 && d3 <= 13200)
    assert.ok(d20 <= 30000)
})

test('penjelasan kode putus menandai kode yang tidak boleh diulang', () => {
    assert.equal(wa.describeDisconnect(401).retry, false)
    assert.equal(wa.describeDisconnect(440).retry, false)
    assert.equal(wa.describeDisconnect(515).retry, true)
    assert.equal(wa.describeDisconnect(undefined).retry, true)
})
