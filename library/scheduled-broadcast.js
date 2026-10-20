'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const persistentGroupSettings = require('./persistent-group-settings.js')

const DATA_DIR = path.resolve(String(process.env.XERYUU_DATA_DIR || path.join(os.homedir(), '.xeryuu')))
const DATA_FILE = path.join(DATA_DIR, 'scheduled-broadcasts.json')
const MAX_SCHEDULES = 5
const TIME_ZONE = 'Asia/Jakarta'
const INTERVAL_MS = 10 * 1000
const MIN_SEND_DELAY_MS = 8000
const GROUP_CACHE_TTL_MS = 15 * 60 * 1000
const RATE_LIMIT_RETRIES = 4
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000]
const RETRY_LATER_MS = 5 * 60 * 1000
let interval = null
let workerRunning = false

function emptyData() {
    return { version: 2, schedules: [], updatedAt: new Date().toISOString() }
}

function emptyProgress() {
    return {
        progressDate: '',
        targetsPrepared: false,
        targetIds: [],
        progressIndex: 0,
        progressSent: 0,
        progressFailed: 0,
        runTotalGroups: 0,
        runSkippedBlacklist: 0,
        nextAttemptAt: 0,
        lastError: ''
    }
}

function normalizeData(value) {
    const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    if (!Array.isArray(data.schedules)) data.schedules = []
    data.schedules = data.schedules
        .filter(item => item && typeof item === 'object' && /^slot-[1-5]$/.test(String(item.id || '')) && /^([01]\d|2[0-3])\.([0-5]\d)$/.test(String(item.time || '')))
        .slice(0, MAX_SCHEDULES)
        .map(item => ({
            id: String(item.id),
            time: String(item.time),
            message: String(item.message || '').trim().slice(0, 12000),
            notifyJid: String(item.notifyJid || ''),
            enabled: item.enabled !== false,
            createdAt: Number(item.createdAt) || Date.now(),
            updatedAt: Number(item.updatedAt) || Date.now(),
            lastRunDate: String(item.lastRunDate || ''),
            pendingDate: String(item.pendingDate || ''),
            progressDate: String(item.progressDate || ''),
            targetsPrepared: item.targetsPrepared === true,
            targetIds: Array.isArray(item.targetIds) ? item.targetIds.filter(jid => typeof jid === 'string' && jid.endsWith('@g.us')).slice(0, 10000) : [],
            progressIndex: Math.max(0, Math.min(10000, Number.parseInt(item.progressIndex, 10) || 0)),
            progressSent: Math.max(0, Number.parseInt(item.progressSent, 10) || 0),
            progressFailed: Math.max(0, Number.parseInt(item.progressFailed, 10) || 0),
            runTotalGroups: Math.max(0, Number.parseInt(item.runTotalGroups, 10) || 0),
            runSkippedBlacklist: Math.max(0, Number.parseInt(item.runSkippedBlacklist, 10) || 0),
            nextAttemptAt: Math.max(0, Number(item.nextAttemptAt) || 0),
            lastError: String(item.lastError || '').slice(0, 500),
            lastStatus: String(item.lastStatus || '')
        }))
        .filter(item => item.message)
    data.version = 2
    return data
}

function readData() {
    try {
        return normalizeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')))
    } catch (error) {
        if (error?.code !== 'ENOENT' && error instanceof SyntaxError) {
            console.error(`[SCHEDULED BROADCAST] JSON rusak (${DATA_FILE}): ${error.message}`)
        } else if (error?.code !== 'ENOENT') {
            console.error(`[SCHEDULED BROADCAST] Gagal membaca ${DATA_FILE}: ${error?.message || error}`)
        }
        return emptyData()
    }
}

function writeData(data) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(DATA_DIR, 0o700) } catch {}
    data.updatedAt = new Date().toISOString()
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`
    fs.writeFileSync(temporaryFile, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(temporaryFile, DATA_FILE)
    try { fs.chmodSync(DATA_FILE, 0o600) } catch {}
    return data
}

function jakartaParts(date = new Date()) {
    const values = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).reduce((out, part) => {
        if (part.type !== 'literal') out[part.type] = part.value
        return out
    }, {})
    return {
        date: `${values.year}-${values.month}-${values.day}`,
        time: `${values.hour}.${values.minute}`,
        hour: values.hour,
        minute: values.minute
    }
}

function normalizeTime(input) {
    const match = String(input || '').trim().match(/^(\d{1,2})[.:](\d{2})$/)
    if (!match) return ''
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return ''
    return `${String(hour).padStart(2, '0')}.${String(minute).padStart(2, '0')}`
}

function listSchedules() {
    return readData().schedules.sort((a, b) => a.id.localeCompare(b.id))
}

function resetProgress(schedule) {
    Object.assign(schedule, emptyProgress())
    schedule.pendingDate = ''
}

function saveSchedule({ time, message, notifyJid }) {
    const normalizedTime = normalizeTime(time)
    const normalizedMessage = String(message || '').trim()
    if (!normalizedTime) throw new Error('Format jam tidak valid. Gunakan HH.MM, contoh 15.00.')
    if (!normalizedMessage) throw new Error('Isi pesan broadcast wajib diisi.')
    if (normalizedMessage.length > 12000) throw new Error('Pesan maksimal 12.000 karakter.')

    const data = readData()
    let schedule = data.schedules.find(item => item.time === normalizedTime)
    if (!schedule) {
        const used = new Set(data.schedules.map(item => item.id))
        const freeSlot = Array.from({ length: MAX_SCHEDULES }, (_, index) => `slot-${index + 1}`).find(id => !used.has(id))
        if (!freeSlot) throw new Error('Maksimal 5 jadwal sudah terisi. Hapus atau ubah jadwal lama terlebih dahulu.')
        schedule = {
            id: freeSlot,
            time: normalizedTime,
            message: normalizedMessage,
            notifyJid: String(notifyJid || ''),
            enabled: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            lastRunDate: '',
            ...emptyProgress(),
            pendingDate: ''
        }
        data.schedules.push(schedule)
    } else {
        const contentChanged = schedule.message !== normalizedMessage
        schedule.message = normalizedMessage
        schedule.notifyJid = String(notifyJid || schedule.notifyJid || '')
        schedule.enabled = true
        schedule.updatedAt = Date.now()
        if (contentChanged) resetProgress(schedule)
        else if (schedule.lastRunDate !== jakartaParts().date) schedule.nextAttemptAt = 0
    }
    writeData(data)
    return schedule
}

function findScheduleIndex(data, selector) {
    const value = String(selector || '').trim().toLowerCase()
    if (/^\d+$/.test(value)) {
        const number = Number(value)
        if (number >= 1 && number <= MAX_SCHEDULES) return data.schedules.findIndex(item => item.id === `slot-${number}`)
        return -1
    }
    const time = normalizeTime(value)
    return time ? data.schedules.findIndex(item => item.time === time) : -1
}

function removeSchedule(selector) {
    const data = readData()
    const index = findScheduleIndex(data, selector)
    if (index < 0) return null
    const [removed] = data.schedules.splice(index, 1)
    writeData(data)
    return removed
}

function retrySchedule(selector) {
    const data = readData()
    const index = findScheduleIndex(data, selector)
    if (index < 0) return null
    const schedule = data.schedules[index]
    const currentDate = jakartaParts().date
    const hasResumableProgress = Boolean(schedule.pendingDate && schedule.progressDate === schedule.pendingDate && schedule.targetsPrepared)
    schedule.lastRunDate = schedule.lastRunDate === currentDate ? '' : schedule.lastRunDate
    schedule.enabled = true
    schedule.nextAttemptAt = 0
    schedule.lastError = ''
    schedule.lastStatus = ''
    if (!hasResumableProgress) resetProgress(schedule)
    writeData(data)
    return schedule
}

function updateStoredSchedule(id, callback) {
    const data = readData()
    const current = data.schedules.find(item => item.id === id)
    if (!current) return null
    callback(current)
    writeData(data)
    return current
}

function isSocketReady(socket) {
    if (!socket || typeof socket.sendMessage !== 'function' || socket.isConnected === false) return false
    const readyState = socket.ws?.readyState
    if (typeof readyState === 'number' && readyState !== 1) return false
    return socket.isConnected === true || readyState === 1 || typeof socket.isConnected === 'undefined'
}

function isConnectionError(error) {
    return /connection\s*closed|connection\s+is\s+closed|websocket[^\n]*closed|socket[^\n]*closed|not connected|connection lost|timed?\s*out|econnreset|econnclosed/i.test(String(error?.message || error || ''))
}

function isRateLimitError(error) {
    const message = String(error?.message || error?.data?.message || error || '')
    const status = Number(error?.status || error?.statusCode || error?.output?.statusCode || error?.data)
    return status === 429 || error?.data === 429 || /rate[-_ ]?overlimit|rate[-_ ]?limit|over[-_ ]?limit|too many requests|retry[- ]?after|\b429\b|slow down/i.test(message)
}

function rateLimitBackoffMs(retryIndex) {
    const index = Math.max(0, Math.min(RATE_LIMIT_BACKOFF_MS.length - 1, Number(retryIndex) || 0))
    return RATE_LIMIT_BACKOFF_MS[index]
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

async function interruptibleSleep(ms, state) {
    let elapsed = 0
    while (elapsed < ms && !state?.stopRequested) {
        const chunk = Math.min(250, ms - elapsed)
        await sleep(chunk)
        elapsed += chunk
    }
    return !state?.stopRequested
}

async function waitForReadySocket(socketProvider, timeoutMs = 10 * 60 * 1000, state) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
        if (state?.stopRequested) return null
        const socket = socketProvider()
        if (isSocketReady(socket)) return socket
        await sleep(1000)
    }
    throw new Error('Koneksi WhatsApp tidak pulih dalam 10 menit.')
}

async function getParticipatingGroups(socketProvider) {
    const cached = global.__xeryuuBroadcastGroupsCache
    if (cached?.groups && Date.now() - Number(cached.fetchedAt || 0) <= GROUP_CACHE_TTL_MS) {
        return cached.groups
    }
    const socket = await waitForReadySocket(socketProvider)
    if (typeof socket.groupFetchAllParticipating !== 'function') throw new Error('Socket tidak dapat memuat daftar grup.')
    try {
        const groups = await socket.groupFetchAllParticipating()
        if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new Error('WhatsApp mengembalikan daftar grup dengan format tidak valid.')
        global.__xeryuuBroadcastGroupsCache = { groups, fetchedAt: Date.now() }
        return groups
    } catch (error) {
        const latestCache = global.__xeryuuBroadcastGroupsCache
        if (isRateLimitError(error) && latestCache?.groups && Date.now() - Number(latestCache.fetchedAt || 0) <= 60 * 60 * 1000) {
            console.warn('[SCHEDULED BROADCAST] groupFetchAllParticipating terkena rate-limit; menggunakan cache grup maksimal 60 menit.')
            return latestCache.groups
        }
        throw error
    }
}

async function sendNotice(socketProvider, jid, text) {
    if (!jid) return false
    try {
        const socket = await waitForReadySocket(socketProvider, 15000)
        await socket.sendMessage(jid, { text })
        return true
    } catch (error) {
        console.warn('[SCHEDULED BROADCAST NOTICE]', error?.message || error)
        return false
    }
}

function prepareRun(schedule, date, groups) {
    const allIds = Object.keys(groups).filter(jid => jid.endsWith('@g.us'))
    const blocked = new Set(allIds.filter(jid => persistentGroupSettings.isGroupBlacklisted(jid, 'blacklistjpm', global.db)))
    const targetIds = allIds.filter(jid => !blocked.has(jid))
    updateStoredSchedule(schedule.id, current => {
        current.progressDate = date
        current.targetsPrepared = true
        current.targetIds = targetIds
        current.progressIndex = 0
        current.progressSent = 0
        current.progressFailed = 0
        current.runTotalGroups = allIds.length
        current.runSkippedBlacklist = blocked.size
        current.nextAttemptAt = 0
        current.lastError = ''
    })
    return { allIds, targetIds, blockedCount: blocked.size }
}

function completeRun(scheduleId, date, status, errorMessage = '') {
    updateStoredSchedule(scheduleId, current => {
        current.lastRunDate = date
        current.pendingDate = ''
        current.nextAttemptAt = 0
        current.lastError = String(errorMessage || '').slice(0, 500)
        current.progressDate = ''
        current.targetsPrepared = false
        current.targetIds = []
        current.progressIndex = 0
        current.progressSent = 0
        current.progressFailed = 0
        current.runTotalGroups = 0
        current.runSkippedBlacklist = 0
        current.lastStatus = status
    })
}

function deferRun(scheduleId, date, errorMessage, delayMs = RETRY_LATER_MS) {
    updateStoredSchedule(scheduleId, current => {
        current.pendingDate = date
        current.nextAttemptAt = Date.now() + delayMs
        current.lastError = String(errorMessage || '').slice(0, 500)
    })
}

async function sendScheduledBroadcast(scheduleSnapshot, date, socketProvider) {
    const state = global.__xeryuuBroadcastState || (global.__xeryuuBroadcastState = {})
    if (state.active) return false

    const dataAtStart = readData()
    let schedule = dataAtStart.schedules.find(item => item.id === scheduleSnapshot.id && item.time === scheduleSnapshot.time)
    if (!schedule || schedule.lastRunDate === date || schedule.pendingDate !== date) return false

    Object.assign(state, {
        active: true,
        stopRequested: false,
        status: 'scheduled-preparing',
        startedAt: Date.now(),
        finishedAt: 0,
        targetCount: Number(schedule.targetIds?.length || 0),
        processed: Number(schedule.progressIndex || 0),
        sent: Number(schedule.progressSent || 0),
        failed: Number(schedule.progressFailed || 0),
        skippedBlacklist: Number(schedule.runSkippedBlacklist || 0),
        limit: null,
        currentJid: '',
        startChat: schedule.notifyJid || '',
        lastError: ''
    })

    let allGroupCount = Number(schedule.runTotalGroups || 0)
    let blockedCount = Number(schedule.runSkippedBlacklist || 0)
    let fatalError = ''
    let deferred = false
    let completed = false
    let stopped = false

    try {
        schedule = readData().schedules.find(item => item.id === scheduleSnapshot.id)
        if (!schedule) throw new Error('Jadwal dihapus saat sedang disiapkan.')

        if (schedule.progressDate !== date || schedule.targetsPrepared !== true) {
            const groups = await getParticipatingGroups(socketProvider)
            const prepared = prepareRun(schedule, date, groups)
            allGroupCount = prepared.allIds.length
            blockedCount = prepared.blockedCount
            schedule = readData().schedules.find(item => item.id === scheduleSnapshot.id)
        } else {
            allGroupCount = Number(schedule.runTotalGroups || 0)
            blockedCount = Number(schedule.runSkippedBlacklist || 0)
        }

        if (!schedule || !Array.isArray(schedule.targetIds)) throw new Error('Data target jadwal tidak valid.')
        const targets = schedule.targetIds
        state.targetCount = targets.length
        state.skippedBlacklist = blockedCount
        state.sent = Number(schedule.progressSent || 0)
        state.failed = Number(schedule.progressFailed || 0)
        state.processed = Number(schedule.progressIndex || 0)

        if (!targets.length) {
            completed = true
            state.status = 'completed'
            fatalError = `Tidak ada grup tujuan yang diizinkan. Total grup: ${allGroupCount}; blacklist: ${blockedCount}.`
        } else {
            state.status = 'scheduled-running'
            const delayMs = Math.max(MIN_SEND_DELAY_MS, Number(global.delayJpm || MIN_SEND_DELAY_MS))
            while (state.processed < targets.length) {
                if (state.stopRequested) {
                    stopped = true
                    break
                }
                const index = state.processed
                const jid = targets[index]
                state.currentJid = jid
                let delivered = false
                let connectionRetries = 0
                let rateLimitRetries = 0

                while (!delivered && !state.stopRequested) {
                    let activeSocket
                    try {
                        activeSocket = await waitForReadySocket(socketProvider, 10 * 60 * 1000, state)
                        if (!activeSocket) break
                        await activeSocket.sendMessage(jid, { text: `📢 INFORMASI OWNER\n\n${schedule.message}` })
                        delivered = true
                        state.sent++
                    } catch (error) {
                        if (state.stopRequested) break
                        if (isRateLimitError(error)) {
                            if (rateLimitRetries >= RATE_LIMIT_RETRIES) {
                                fatalError = `WhatsApp masih mengembalikan rate-overlimit setelah ${RATE_LIMIT_RETRIES} percobaan. Target saat ini (${jid}) dipertahankan dan akan dicoba lagi otomatis setelah 5 menit.`
                                deferred = true
                                state.status = 'rate-limited-wait'
                                state.lastError = fatalError
                                console.warn('[SCHEDULED BROADCAST RATE LIMIT]', fatalError)
                                break
                            }
                            const waitMs = rateLimitBackoffMs(rateLimitRetries)
                            rateLimitRetries++
                            state.status = 'rate-limited-wait'
                            state.lastError = `WhatsApp rate-limit; percobaan ${rateLimitRetries}/${RATE_LIMIT_RETRIES}, menunggu ${Math.ceil(waitMs / 1000)} detik.`
                            console.warn(`[SCHEDULED BROADCAST] rate-limit untuk ${jid}; menunggu ${waitMs}ms (${rateLimitRetries}/${RATE_LIMIT_RETRIES}).`)
                            if (!(await interruptibleSleep(waitMs, state))) break
                            continue
                        }
                        if (isConnectionError(error)) {
                            if (connectionRetries >= 3) {
                                fatalError = `Koneksi terputus berulang kali ketika mengirim ke ${jid}. Target ini akan dicoba lagi otomatis setelah 5 menit.`
                                deferred = true
                                state.lastError = fatalError
                                break
                            }
                            connectionRetries++
                            state.status = 'waiting-connection'
                            console.warn(`[SCHEDULED BROADCAST] koneksi terputus; menunggu socket baru (${connectionRetries}/3).`)
                            await sleep(1000)
                            continue
                        }
                        state.failed++
                        console.error(`[SCHEDULED BROADCAST] ${jid}: ${error?.message || error}`)
                        break
                    }
                }

                if (deferred) break
                if (state.stopRequested && !delivered) {
                    stopped = true
                    break
                }

                // Kegagalan non-rate-limit pada satu grup dicatat lalu lanjut ke target berikutnya.
                if (!delivered && state.failed <= Number(schedule.progressFailed || 0)) state.failed++
                state.processed = index + 1
                schedule = updateStoredSchedule(scheduleSnapshot.id, current => {
                    if (current.progressDate !== date || current.pendingDate !== date) return
                    current.progressIndex = index + 1
                    current.progressSent = state.sent
                    current.progressFailed = state.failed
                    current.nextAttemptAt = 0
                    current.lastError = ''
                }) || schedule
                state.status = 'scheduled-running'

                if (state.processed < targets.length && !state.stopRequested) {
                    if (!(await interruptibleSleep(delayMs, state))) {
                        stopped = true
                        break
                    }
                }
            }
            if (state.stopRequested) stopped = true
            if (state.processed >= targets.length) completed = true
        }
    } catch (error) {
        fatalError = String(error?.message || error)
        deferred = true
        state.status = 'failed'
        state.lastError = fatalError
        console.error('[SCHEDULED BROADCAST ERROR]', error?.stack || error)
    } finally {
        if (completed || stopped) {
            completeRun(scheduleSnapshot.id, date, stopped ? 'stopped' : 'completed', fatalError)
            state.status = stopped ? 'stopped' : 'completed'
        } else if (deferred) {
            deferRun(scheduleSnapshot.id, date, fatalError, RETRY_LATER_MS)
            if (state.status !== 'rate-limited-wait') state.status = 'failed'
        }
        state.active = false
        state.finishedAt = Date.now()
        state.currentJid = ''
        state.stopRequested = false
    }

    const heading = deferred ? '⏳ BROADCAST TERJADWAL DITUNDA OTOMATIS'
        : stopped ? '🛑 BROADCAST TERJADWAL DIHENTIKAN'
            : '✅ BROADCAST TERJADWAL SELESAI'
    const summary = `${heading}\n\n🕒 Jadwal: ${scheduleSnapshot.time} WIB\n📨 Terkirim: ${state.sent || 0}\n❌ Gagal: ${state.failed || 0}\n📍 Diproses: ${state.processed || 0}/${state.targetCount || 0} grup\n🚫 Dilewati blacklist: ${blockedCount}\n📊 Total grup: ${allGroupCount}${fatalError ? `\n\nDetail: ${fatalError}` : ''}${deferred ? '\n\nBot akan melanjutkan otomatis setelah jeda cooldown; jangan buat ulang jadwal yang sama.' : ''}`
    await sendNotice(socketProvider, scheduleSnapshot.notifyJid, summary)
    return true
}

function isPending(schedule) {
    return Boolean(schedule.pendingDate && schedule.pendingDate !== schedule.lastRunDate)
}

function scheduleIsDue(schedule, now = new Date()) {
    const current = jakartaParts(now)
    if (!schedule || !schedule.enabled || !schedule.message || schedule.lastRunDate === current.date) return false
    if (isPending(schedule)) return true
    return schedule.time <= current.time
}

async function tick(socketProvider, nowInput = new Date()) {
    if (workerRunning) return false
    const now = jakartaParts(nowInput)
    const data = readData()
    let changed = false

    // Jangan bergantung pada kecocokan satu menit tertentu. Jadwal yang telat diproses
    // karena event-loop sibuk, broadcast lain, atau reconnect tetap menjadi pending.
    for (const schedule of data.schedules) {
        if (!schedule.enabled || !schedule.message) continue
        if (isPending(schedule)) continue
        if (schedule.lastRunDate === now.date) continue
        if (schedule.time <= now.time) {
            schedule.pendingDate = now.date
            schedule.nextAttemptAt = 0
            if (schedule.progressDate !== now.date) {
                Object.assign(schedule, emptyProgress())
                schedule.pendingDate = now.date
            }
            changed = true
        }
    }
    if (changed) writeData(data)

    const refreshed = readData()
    const due = refreshed.schedules
        .filter(schedule => isPending(schedule) && (!schedule.nextAttemptAt || schedule.nextAttemptAt <= Date.now()))
        .sort((a, b) => String(a.pendingDate).localeCompare(String(b.pendingDate)) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id))
    if (!due.length || global.__xeryuuBroadcastState?.active) return false
    if (!isSocketReady(socketProvider())) return false

    workerRunning = true
    try {
        return await sendScheduledBroadcast(due[0], due[0].pendingDate, socketProvider)
    } catch (error) {
        console.error('[SCHEDULED BROADCAST TICK]', error?.stack || error)
        return false
    } finally {
        workerRunning = false
    }
}

function startScheduler(socketOrProvider) {
    const socketProvider = typeof socketOrProvider === 'function'
        ? socketOrProvider
        : () => global.__xeryuuMainSocket || socketOrProvider || null
    global.__xeryuuScheduledBroadcastSocketProvider = socketProvider
    if (interval) return interval
    if (global.__xeryuuScheduledBroadcastInterval) {
        interval = global.__xeryuuScheduledBroadcastInterval
        return interval
    }
    interval = setInterval(() => {
        const provider = global.__xeryuuScheduledBroadcastSocketProvider || socketProvider
        void tick(provider)
    }, INTERVAL_MS)
    if (typeof interval.unref === 'function') interval.unref()
    global.__xeryuuScheduledBroadcastInterval = interval
    console.log(`[SCHEDULED BROADCAST] Scheduler aktif; penyimpanan: ${DATA_FILE}; zona waktu ${TIME_ZONE}; interval ${INTERVAL_MS / 1000} detik.`)
    void tick(socketProvider)
    return interval
}

module.exports = {
    DATA_DIR,
    DATA_FILE,
    MAX_SCHEDULES,
    TIME_ZONE,
    MIN_SEND_DELAY_MS,
    normalizeTime,
    listSchedules,
    saveSchedule,
    removeSchedule,
    retrySchedule,
    isRateLimitError,
    rateLimitBackoffMs,
    scheduleIsDue,
    tick,
    startScheduler
}
