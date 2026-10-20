'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')

function runWithDataDir(dataDir, code, timeout = 30000) {
    const result = spawnSync(process.execPath, ['-e', code], {
        cwd: root,
        env: { ...process.env, XERYUU_DATA_DIR: dataDir },
        encoding: 'utf8',
        timeout
    })
    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    return result.stdout
}

test('jadwal dianggap jatuh tempo walau tick terlambat dari menit target', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-schedule-due-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const service = require('./library/scheduled-broadcast.js')
        const now = new Date('2026-10-20T08:00:00.000Z') // 15.00 WIB
        assert.equal(service.scheduleIsDue({ enabled: true, message: 'A', time: '14.59', lastRunDate: '', pendingDate: '' }, now), true)
        assert.equal(service.scheduleIsDue({ enabled: true, message: 'A', time: '15.01', lastRunDate: '', pendingDate: '' }, now), false)
        assert.equal(service.scheduleIsDue({ enabled: true, message: 'A', time: '14.00', lastRunDate: '2026-10-20', pendingDate: '' }, now), false)
    `)
})

test('rate-overlimit dikenali dan memakai backoff meningkat', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-rate-limit-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const service = require('./library/scheduled-broadcast.js')
        assert.equal(service.isRateLimitError(new Error('rate-overlimit')), true)
        assert.equal(service.isRateLimitError({ status: 429, message: 'request rejected' }), true)
        assert.equal(service.isRateLimitError(new Error('random send error')), false)
        assert.deepEqual([0,1,2,3].map(service.rateLimitBackoffMs), [30000,60000,120000,240000])
    `)
})

test('scheduler mengirim jadwal yang sudah lewat pada hari yang sama dan mencatat tanggal selesai', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-schedule-dispatch-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const service = require('./library/scheduled-broadcast.js')
        ;(async () => {
            const expectedDate = '2026-10-20'
            const sends = []
            const socket = {
                isConnected: true,
                ws: { readyState: 1 },
                async groupFetchAllParticipating() {
                    return { '120363123456789@g.us': { subject: 'Grup tes' } }
                },
                async sendMessage(jid, payload) { sends.push({ jid, payload }) }
            }
            global.db = { groups: {}, chats: {} }
            global.__xeryuuBroadcastState = { active: false }
            global.delayJpm = 1
            service.saveSchedule({ time: '14.59', message: 'Pesan jadwal tes', notifyJid: '628123456789@s.whatsapp.net' })
            await service.tick(() => socket, new Date('2026-10-20T08:00:00.000Z'))
            const schedule = service.listSchedules()[0]
            assert.equal(schedule.lastRunDate, expectedDate)
            assert.equal(schedule.pendingDate, '')
            assert.equal(sends.filter(item => item.jid.endsWith('@g.us')).length, 1)
            assert.match(sends.find(item => item.jid.endsWith('@g.us')).payload.text, /Pesan jadwal tes/)
        })().catch(error => { console.error(error); process.exitCode = 1 })
    `)
})


test('perintah retry menjadwalkan ulang slot lama yang ditandai selesai pada hari ini', t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-schedule-retry-'))
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
    runWithDataDir(dataDir, `
        const assert = require('node:assert/strict')
        const fs = require('node:fs')
        const service = require('./library/scheduled-broadcast.js')
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
        service.saveSchedule({ time: '00.01', message: 'Percobaan lama', notifyJid: '628123456789@s.whatsapp.net' })
        const data = JSON.parse(fs.readFileSync(service.DATA_FILE, 'utf8'))
        data.schedules[0].lastRunDate = today
        data.schedules[0].lastStatus = ''
        fs.writeFileSync(service.DATA_FILE, JSON.stringify(data, null, 2))
        const retried = service.retrySchedule('1')
        assert.ok(retried)
        assert.equal(retried.lastRunDate, '')
        assert.equal(retried.pendingDate, '')
        assert.equal(retried.nextAttemptAt, 0)
    `)
})
