'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

function runWithDataDir(dataDir, code) {
    const result = spawnSync(process.execPath, ['-e', code], {
        cwd: root,
        env: { ...process.env, XERYUU_DATA_DIR: dataDir },
        encoding: 'utf8'
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return result.stdout
}

test('blacklist grup disimpan di luar project dan bertahan antar proses', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-group-settings-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    const jid = '120363123456789@g.us'
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const service = require('./library/persistent-group-settings.js')
        const jid = ${JSON.stringify(jid)}
        const legacyDb = { groups: { [jid]: { blacklistadzan: true, blacklistjpm: true, subject: 'Grup Uji' } }, chats: {} }
        assert.equal(service.isGroupBlacklisted(jid, 'blacklistadzan', legacyDb), true)
        service.setGroupBlacklist(jid, 'blacklistadzan', false, { db: legacyDb, subject: 'Grup Uji' })
        assert.equal(service.isGroupBlacklisted(jid, 'blacklistadzan', legacyDb), false)
        console.log(service.DATA_FILE)
    `)
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const service = require('./library/persistent-group-settings.js')
        const jid = ${JSON.stringify(jid)}
        assert.equal(service.isGroupBlacklisted(jid, 'blacklistadzan', {}), false)
        assert.equal(service.isGroupBlacklisted(jid, 'blacklistjpm', {}), true)
    `)
    assert.ok(fs.existsSync(path.join(dataDir, 'persistent-group-settings.json')))
})

test('jadwal broadcast membatasi lima slot dan mempertahankan jadwal antar proses', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-schedules-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const service = require('./library/scheduled-broadcast.js')
        for (let i = 1; i <= 5; i++) service.saveSchedule({ time: String(i + 9).padStart(2, '0') + '.10', message: 'Pesan ' + i, notifyJid: '628123456789@s.whatsapp.net' })
        assert.equal(service.listSchedules().length, 5)
        assert.throws(() => service.saveSchedule({ time: '17.10', message: 'Slot keenam' }), /Maksimal 5 jadwal/)
        assert.ok(service.removeSchedule('3'))
        assert.equal(service.listSchedules().length, 4)
    `)
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const service = require('./library/scheduled-broadcast.js')
        assert.equal(service.listSchedules().length, 4)
        assert.equal(service.normalizeTime('5:07'), '05.07')
        assert.equal(service.normalizeTime('25.00'), '')
    `)
    assert.ok(fs.existsSync(path.join(dataDir, 'scheduled-broadcasts.json')))
})
