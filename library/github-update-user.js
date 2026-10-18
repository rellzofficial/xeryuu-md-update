'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const axios = require('axios')

const UPDATE_SOURCE = Object.freeze({
    owner: "rellzofficial",
    repository: "xeryuu-md-update",
    branch: "main"
})

const MANIFEST_NAME = '.xeryuu-update.json'
const STATE_NAME = '.xeryuu-update-state.json'
const BASE_DIR_NAME = '.xeryuu-update-base'
const BACKUP_DIR_NAME = 'update-backups'
const MAX_FILES = 300
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_TOTAL_BYTES = 70 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30000

function normalizeRelativePath(value) {
    return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function isSafeDistributionPath(value) {
    const relative = normalizeRelativePath(value)
    if (!relative || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return false

    const parts = relative.split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) return false

    const lower = relative.toLowerCase()
    const base = parts[parts.length - 1].toLowerCase()
    if (['index.js', 'settings.js', 'authen.js', 'authen.example.js', 'qris.jpg'].includes(lower)) return false
    if (lower.startsWith('.git/') || lower.startsWith('node_modules/')) return false
    if (lower.startsWith('connection/') || lower.startsWith('session/') || lower.startsWith('sessions/')) return false
    if (lower.startsWith('update-staging/') || lower.startsWith('update-backups/') || lower.startsWith('.xeryuu-update-base/')) return false
    if (lower === STATE_NAME || lower === MANIFEST_NAME) return false
    if (lower.startsWith('.env') || base.endsWith('.log') || base.endsWith('.pem') || base.endsWith('.key')) return false
    if (lower.startsWith('library/database/')) {
        const staticGameData = /^library\/database\/games\/(?:README\.md|legacy\/[^/]+\.json)$/i.test(relative)
        if (!staticGameData) return false
    }
    if (lower === 'library/savesaluran.json') return false
    if (lower === 'library/amprem.js') return false
    if (lower === 'library/github-update-developer.js') return false

    const extension = path.posix.extname(relative).toLowerCase()
    const allowedExtensions = new Set([
        '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.txt',
        '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.svg', '.yml', '.yaml'
    ])
    if (!allowedExtensions.has(extension)) return false

    const first = parts[0].toLowerCase()
    if (first === 'source' || first === 'library' || first === 'media' || first === 'tests') return true
    if (parts.length === 1) {
        return ['xeryuu.js', 'telegram.js', 'stalk-check.js', 'package.json', 'tqto.md'].includes(lower)
    }
    return false
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex')
}

function safeJoin(root, relative) {
    const clean = normalizeRelativePath(relative)
    if (!isSafeDistributionPath(clean)) throw new Error(`Path tidak diizinkan: ${clean || '(kosong)'}`)
    const resolvedRoot = path.resolve(root)
    const resolved = path.resolve(resolvedRoot, ...clean.split('/'))
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
        throw new Error(`Path keluar dari folder project ditolak: ${clean}`)
    }
    return resolved
}

function writeAtomic(filePath, buffer) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    fs.writeFileSync(temporary, buffer)
    fs.renameSync(temporary, filePath)
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
        return fallback
    }
}

function rawUrl(owner, repository, ref, relative) {
    const encodedPath = normalizeRelativePath(relative).split('/').map(encodeURIComponent).join('/')
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/${encodedPath}`
}

async function downloadRaw(url, maxBytes = MAX_FILE_BYTES) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        validateStatus: status => status >= 200 && status < 300,
        headers: { 'User-Agent': 'Xeryuu-MD-Updater/1.0' }
    })
    const data = Buffer.from(response.data)
    if (!data.length) throw new Error('Server mengirim file kosong.')
    if (data.length > maxBytes) throw new Error('Ukuran file melewati batas keamanan updater.')
    return data
}

function tryThreeWayMerge(localBuffer, baseBuffer, remoteBuffer) {
    const gitCheck = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 })
    if (gitCheck.error || gitCheck.status !== 0) {
        return { ok: false, reason: 'Git tidak tersedia; file lokal yang berubah dilewati agar modifikasi pengguna tidak hilang.' }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-update-'))
    const localPath = path.join(tempDir, 'local.js')
    const basePath = path.join(tempDir, 'base.js')
    const remotePath = path.join(tempDir, 'remote.js')
    try {
        fs.writeFileSync(localPath, localBuffer)
        fs.writeFileSync(basePath, baseBuffer)
        fs.writeFileSync(remotePath, remoteBuffer)
        const result = spawnSync('git', ['merge-file', '-p', localPath, basePath, remotePath], {
            encoding: null,
            timeout: 15000,
            maxBuffer: 32 * 1024 * 1024
        })
        if (result.error) return { ok: false, reason: 'Proses merge tidak dapat dijalankan; file lokal dilewati.' }
        if (result.status === 0) return { ok: true, buffer: Buffer.from(result.stdout || Buffer.alloc(0)) }
        if (result.status === 1) return { ok: false, reason: 'Ada konflik antara perubahan developer dan modifikasi lokal; file dilewati.' }
        return { ok: false, reason: 'Git gagal melakukan merge; file lokal dilewati.' }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
    }
}

function validateManifest(manifest) {
    if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
        throw new Error('Manifest update tidak valid atau belum dipublikasikan dengan benar.')
    }
    if (manifest.files.length > MAX_FILES) throw new Error(`Manifest berisi terlalu banyak file (maksimal ${MAX_FILES}).`)
    const seen = new Set()
    let total = 0
    for (const entry of manifest.files) {
        const relative = normalizeRelativePath(entry?.path)
        if (!isSafeDistributionPath(relative)) throw new Error(`Manifest memuat path yang dilarang: ${relative || '(kosong)'}`)
        if (seen.has(relative)) throw new Error(`Manifest memiliki path duplikat: ${relative}`)
        seen.add(relative)
        if (!/^[a-f0-9]{64}$/i.test(String(entry?.sha256 || ''))) throw new Error(`Hash SHA-256 tidak valid untuk ${relative}`)
        const size = Number(entry?.size)
        if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error(`Ukuran tidak valid untuk ${relative}`)
        total += size
    }
    if (total > MAX_TOTAL_BYTES) throw new Error('Total ukuran paket update melewati batas 70 MB.')
}

async function getBaseBuffer(config, manifest, relative, expectedHash = '') {
    if (!/^[a-f0-9]{40}$/i.test(String(manifest.previousCommitSha || ''))) return null
    if (expectedHash && !/^[a-f0-9]{64}$/i.test(String(expectedHash))) return null
    try {
        const buffer = await downloadRaw(rawUrl(config.owner, config.repository, manifest.previousCommitSha, relative))
        if (expectedHash && sha256(buffer) !== expectedHash.toLowerCase()) return null
        return buffer
    } catch {
        return null
    }
}

async function update({ projectRoot, reply }) {
    const root = path.resolve(projectRoot || process.cwd())
    const config = UPDATE_SOURCE
    if (!config.owner || config.owner.startsWith('__') || !config.repository || config.repository.startsWith('__')) {
        await reply('❌ Repository update belum dikonfigurasi oleh developer. Coba lagi setelah updater dipublikasikan.')
        return
    }
    if (!isSafeDistributionPath('xeryuu.js')) throw new Error('Validasi path updater gagal.')

    await reply('⏳ Mengecek manifest GitHub dan menyiapkan update...')

    const manifestBuffer = await downloadRaw(rawUrl(config.owner, config.repository, config.branch, MANIFEST_NAME), 2 * 1024 * 1024)
    let manifest
    try {
        manifest = JSON.parse(manifestBuffer.toString('utf8'))
    } catch {
        throw new Error('Manifest GitHub bukan JSON yang valid.')
    }
    validateManifest(manifest)

    const statePath = path.join(root, STATE_NAME)
    const state = readJson(statePath, { schemaVersion: 1, files: {} })
    if (!state.files || typeof state.files !== 'object') state.files = {}

    const backupRoot = path.join(root, BACKUP_DIR_NAME, new Date().toISOString().replace(/[:.]/g, '-'))
    const baseRoot = path.join(root, BASE_DIR_NAME)
    const report = { updated: [], current: [], merged: [], skipped: [], failed: [] }
    let downloadedTotal = 0

    for (const entry of manifest.files) {
        const relative = normalizeRelativePath(entry.path)
        let remoteBuffer
        try {
            remoteBuffer = await downloadRaw(rawUrl(config.owner, config.repository, config.branch, relative))
            downloadedTotal += remoteBuffer.length
            if (downloadedTotal > MAX_TOTAL_BYTES) throw new Error('Total unduhan melewati batas 70 MB.')
            if (sha256(remoteBuffer) !== entry.sha256.toLowerCase()) {
                throw new Error('Hash file tidak cocok dengan manifest; kemungkinan GitHub sedang menerima update. Ulangi beberapa saat lagi.')
            }
        } catch (error) {
            report.failed.push(`${relative}: ${error?.message || error}`)
            continue
        }

        const localPath = safeJoin(root, relative)
        let localBuffer = null
        try {
            if (fs.existsSync(localPath)) localBuffer = fs.readFileSync(localPath)
        } catch (error) {
            report.failed.push(`${relative}: tidak bisa membaca file lokal (${error.message})`)
            continue
        }

        const remoteHash = sha256(remoteBuffer)
        if (localBuffer && sha256(localBuffer) === remoteHash) {
            report.current.push(relative)
            fs.mkdirSync(path.dirname(path.join(baseRoot, relative)), { recursive: true })
            writeAtomic(path.join(baseRoot, relative), remoteBuffer)
            state.files[relative] = { sha256: remoteHash, version: manifest.version || '' }
            continue
        }

        let outputBuffer = remoteBuffer
        let wasMerged = false
        if (localBuffer) {
            const previousState = state.files[relative]
            let baseBuffer = null
            const savedBasePath = path.join(baseRoot, ...relative.split('/'))
            if (fs.existsSync(savedBasePath)) {
                try { baseBuffer = fs.readFileSync(savedBasePath) } catch {}
            }
            if (baseBuffer && previousState?.sha256 && sha256(baseBuffer) !== String(previousState.sha256).toLowerCase()) {
                baseBuffer = null
            }
            if (!baseBuffer) {
                // For a fresh install of the updater, the previous manifest commit is
                // the safest common ancestor available. If a saved state exists, verify
                // it by hash; otherwise use that commit only as a three-way merge base.
                baseBuffer = await getBaseBuffer(config, manifest, relative, previousState?.sha256 || '')
            }

            if (!baseBuffer) {
                // Bootstrap for an already-customized installation: preserve the local
                // file now, but remember the published source as a baseline so a later
                // release can attempt a three-way merge instead of skipping forever.
                fs.mkdirSync(path.dirname(savedBasePath), { recursive: true })
                writeAtomic(savedBasePath, remoteBuffer)
                state.files[relative] = { sha256: remoteHash, version: manifest.version || '' }
                report.skipped.push(`${relative}: versi dasar awal tidak diketahui; file lokal dipertahankan dan baseline disimpan untuk merge berikutnya.`)
                continue
            }
            if (sha256(localBuffer) === sha256(baseBuffer)) {
                outputBuffer = remoteBuffer
            } else {
                const merge = tryThreeWayMerge(localBuffer, baseBuffer, remoteBuffer)
                if (!merge.ok) {
                    report.skipped.push(`${relative}: ${merge.reason}`)
                    continue
                }
                outputBuffer = merge.buffer
                wasMerged = !outputBuffer.equals(remoteBuffer)
            }
        }

        try {
            if (localBuffer) {
                const backupPath = safeJoin(backupRoot, relative)
                fs.mkdirSync(path.dirname(backupPath), { recursive: true })
                fs.writeFileSync(backupPath, localBuffer)
            }
            writeAtomic(localPath, outputBuffer)
            fs.mkdirSync(path.dirname(path.join(baseRoot, relative)), { recursive: true })
            writeAtomic(path.join(baseRoot, relative), remoteBuffer)
            state.files[relative] = { sha256: remoteHash, version: manifest.version || '' }
            if (wasMerged) report.merged.push(relative)
            else report.updated.push(relative)
            if (path.extname(relative).toLowerCase() === '.js' || /\.(?:cjs|mjs)$/i.test(relative)) {
                try {
                    const resolved = require.resolve(localPath)
                    delete require.cache[resolved]
                } catch {}
            }
        } catch (error) {
            report.failed.push(`${relative}: gagal menyimpan file (${error?.message || error})`)
        }
    }

    state.schemaVersion = 1
    state.version = manifest.version || ''
    state.updatedAt = new Date().toISOString()
    writeAtomic(statePath, Buffer.from(JSON.stringify(state, null, 2)))

    const updatedCount = report.updated.length
    const mergedCount = report.merged.length
    const skippedCount = report.skipped.length
    const failedCount = report.failed.length
    const lines = [
        `✅ Pemeriksaan update selesai. Versi repository: ${manifest.version || 'tidak bernomor'}`,
        `Diperbarui: ${updatedCount} | Merge lokal berhasil: ${mergedCount} | Dilewati: ${skippedCount} | Gagal: ${failedCount}`
    ]
    if (skippedCount) {
        lines.push('', 'File lokal yang dipertahankan:')
        lines.push(...report.skipped.slice(0, 8).map(item => `• ${item}`))
        if (skippedCount > 8) lines.push(`• dan ${skippedCount - 8} file lainnya`)
    }
    if (failedCount) {
        lines.push('', 'File yang gagal:')
        lines.push(...report.failed.slice(0, 5).map(item => `• ${item}`))
        if (failedCount > 5) lines.push(`• dan ${failedCount - 5} file lainnya`)
    }
    if (updatedCount || mergedCount) {
        lines.push('', 'File JavaScript yang diperbarui akan dimuat ulang saat dibutuhkan. File yang diinisialisasi sekali saat startup mungkin tetap memerlukan restart untuk menerapkan semua perubahan.')
    }
    lines.push('', `Cadangan file lama: ${path.relative(root, backupRoot).replace(/\\/g, '/')}`)
    await reply(lines.join('\n'))
}

module.exports = {
    update,
    isSafeDistributionPath,
    sha256,
    validateManifest
}
