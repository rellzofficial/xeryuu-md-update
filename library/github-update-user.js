'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const axios = require('axios')
const { verifyManifestSignature } = require('./update-signature')

// This must point to a PUBLIC, sanitized distribution repository. Never embed a GitHub token here.
// The full developer repository can remain private; publish only approved files to this repository.
const UPDATE_SOURCE = Object.freeze({
    owner: "rellzofficial",
    repository: "xeryuu-md-update",
    branch: "main"
})

const MANIFEST_NAME = '.xeryuu-update.json'
const STATE_NAME = '.xeryuu-update-state.json'
const LEGACY_BASE_DIR_NAMES = ['.xeryuu-update-base', 'xeryuu-update-base']
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
    if (lower.startsWith('update-staging/') || lower.startsWith('update-backups/')) return false
    if (LEGACY_BASE_DIR_NAMES.some(name => lower.startsWith(`${name.toLowerCase()}/`))) return false
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

function assertNoSymlinkInPath(root, relative) {
    const resolvedRoot = path.resolve(root)
    const target = safeJoin(resolvedRoot, relative)
    const parts = normalizeRelativePath(relative).split('/')
    let current = resolvedRoot
    for (let i = 0; i < parts.length; i++) {
        current = path.join(current, parts[i])
        if (!fs.existsSync(current)) continue
        const stat = fs.lstatSync(current)
        if (stat.isSymbolicLink()) {
            throw new Error(`Update ditolak karena path mengandung symbolic link: ${normalizeRelativePath(relative)}`)
        }
        if (i < parts.length - 1 && !stat.isDirectory()) {
            throw new Error(`Path parent bukan direktori: ${normalizeRelativePath(relative)}`)
        }
        if (i === parts.length - 1 && !stat.isFile()) {
            throw new Error(`Tujuan update bukan file biasa: ${normalizeRelativePath(relative)}`)
        }
    }
    return target
}

function writeAtomic(filePath, buffer) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
    try {
        fs.writeFileSync(temporary, buffer, { mode: 0o600 })
        fs.renameSync(temporary, filePath)
    } finally {
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {}
    }
}

function rawUrl(owner, repository, ref, relative) {
    const encodedPath = normalizeRelativePath(relative).split('/').map(encodeURIComponent).join('/')
    return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${encodeURIComponent(ref)}/${encodedPath}`
}

async function downloadRaw(url, maxBytes = MAX_FILE_BYTES) {
    let response
    try {
        response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: DOWNLOAD_TIMEOUT_MS,
            maxContentLength: maxBytes,
            maxBodyLength: maxBytes,
            validateStatus: status => status >= 200 && status < 300,
            headers: { 'User-Agent': 'Xeryuu-MD-Updater/1.1' }
        })
    } catch (error) {
        const status = Number(error?.response?.status || 0)
        if (status === 404 || status === 401 || status === 403) {
            throw new Error('Source update GitHub tidak dapat dibaca. Pastikan repository distribusi bersifat PUBLIC, branch benar, dan manifest/file memang tersedia. Updater pengguna tidak memakai token privat.')
        }
        if (error?.code === 'ECONNABORTED') throw new Error('Koneksi ke GitHub timeout. Tidak ada file yang ditimpa; coba ulangi nanti.')
        throw new Error(`Gagal mengunduh dari GitHub${status ? ` (HTTP ${status})` : ''}: ${error?.message || error}`)
    }
    const data = Buffer.from(response.data)
    if (!data.length) throw new Error('Server mengirim file kosong.')
    if (data.length > maxBytes) throw new Error('Ukuran file melewati batas keamanan updater.')
    return data
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
        return fallback
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

function shouldAutoRestart() {
    const explicitlyEnabled = /^(1|true|yes)$/i.test(String(process.env.XERYUU_AUTO_RESTART || '').trim())
    const pm2 = process.env.pm_id !== undefined || Boolean(process.env.PM2_HOME)
    return explicitlyEnabled || pm2
}

function removeLegacyMergeFolders(root) {
    for (const name of LEGACY_BASE_DIR_NAMES) {
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true }) } catch {}
    }
    // State was only needed for three-way merge. Direct overwrite no longer needs it.
    try { fs.rmSync(path.join(root, STATE_NAME), { force: true }) } catch {}
}

async function update({ projectRoot, reply }) {
    const root = path.resolve(projectRoot || process.cwd())
    const config = UPDATE_SOURCE
    if (!config.owner || !config.repository || !config.branch || /__GITHUB_|YOUR_/i.test(`${config.owner} ${config.repository} ${config.branch}`)) {
        await reply('❌ Repository update belum dikonfigurasi oleh developer.')
        return { changed: 0, restartScheduled: false }
    }
    if (!isSafeDistributionPath('xeryuu.js')) throw new Error('Validasi path updater gagal.')

    await reply('⏳ Memeriksa manifest GitHub dan memvalidasi seluruh file update...')
    const manifestBuffer = await downloadRaw(rawUrl(config.owner, config.repository, config.branch, MANIFEST_NAME), 2 * 1024 * 1024)
    let signatureBuffer
    try {
        signatureBuffer = await downloadRaw(rawUrl(config.owner, config.repository, config.branch, '.xeryuu-update.sig'), 4096)
    } catch {
        throw new Error('Tanda tangan update belum tersedia. Tunggu workflow GitHub "Sign Update Manifest" selesai, lalu jalankan update kembali.')
    }
    if (!verifyManifestSignature(manifestBuffer, signatureBuffer.toString('utf8'))) {
        throw new Error('Tanda tangan manifest GitHub tidak valid. Tidak ada file yang ditimpa; pastikan workflow penandatanganan berhasil dan ulangi setelah memeriksa repository.')
    }
    let manifest
    try {
        manifest = JSON.parse(manifestBuffer.toString('utf8'))
    } catch {
        throw new Error('Manifest GitHub bukan JSON yang valid.')
    }
    validateManifest(manifest)

    // Download and verify every payload before writing anything. A partial download cannot
    // leave the working tree half-updated.
    const plan = []
    let downloadedTotal = 0
    for (const entry of manifest.files) {
        const relative = normalizeRelativePath(entry.path)
        const target = assertNoSymlinkInPath(root, relative)
        const remoteBuffer = await downloadRaw(rawUrl(config.owner, config.repository, config.branch, relative))
        downloadedTotal += remoteBuffer.length
        if (downloadedTotal > MAX_TOTAL_BYTES) throw new Error('Total unduhan melewati batas 70 MB; tidak ada file yang ditimpa.')
        if (sha256(remoteBuffer) !== String(entry.sha256).toLowerCase()) {
            throw new Error(`Hash file ${relative} tidak cocok dengan manifest. Kemungkinan publikasi sedang berlangsung; tidak ada file yang ditimpa, coba ulangi nanti.`)
        }
        if (Number(entry.size) !== remoteBuffer.length) {
            throw new Error(`Ukuran file ${relative} tidak cocok dengan manifest; tidak ada file yang ditimpa.`)
        }
        let localBuffer = null
        if (fs.existsSync(target)) {
            localBuffer = fs.readFileSync(target)
        }
        const changed = !localBuffer || sha256(localBuffer) !== sha256(remoteBuffer)
        plan.push({ relative, target, localBuffer, remoteBuffer, changed })
    }

    const changedPlan = plan.filter(item => item.changed)
    const backupRoot = path.join(root, BACKUP_DIR_NAME, new Date().toISOString().replace(/[:.]/g, '-'))

    if (changedPlan.length) {
        // Refuse backup-directory symlinks so backups cannot unexpectedly write outside the project.
        const backupParent = path.join(root, BACKUP_DIR_NAME)
        if (fs.existsSync(backupParent)) {
            const backupStat = fs.lstatSync(backupParent)
            if (backupStat.isSymbolicLink() || !backupStat.isDirectory()) {
                throw new Error('Direktori update-backups tidak aman (bukan direktori biasa atau merupakan symbolic link). Tidak ada file yang ditimpa.')
            }
        }
        if (fs.existsSync(backupRoot)) {
            const datedBackupStat = fs.lstatSync(backupRoot)
            if (datedBackupStat.isSymbolicLink() || !datedBackupStat.isDirectory()) {
                throw new Error('Direktori backup bertanggal tidak aman. Tidak ada file yang ditimpa.')
            }
        }
        // Back up all old versions before modifying any destination.
        for (const item of changedPlan) {
            if (!item.localBuffer) continue
            const backupPath = safeJoin(backupRoot, item.relative)
            writeAtomic(backupPath, item.localBuffer)
        }

        const applied = []
        try {
            for (const item of changedPlan) {
                applied.push(item)
                writeAtomic(item.target, item.remoteBuffer)
            }
        } catch (error) {
            // Best-effort rollback if the filesystem fails mid-write.
            for (const item of applied.reverse()) {
                try {
                    if (item.localBuffer) writeAtomic(item.target, item.localBuffer)
                    else if (fs.existsSync(item.target)) fs.unlinkSync(item.target)
                } catch (rollbackError) {
                    console.error(`[GITHUB UPDATE ROLLBACK] ${item.relative}:`, rollbackError?.message || rollbackError)
                }
            }
            throw new Error(`Penulisan update gagal dan rollback telah dicoba. File asli ada di ${path.relative(root, backupRoot).replace(/\\/g, '/')}. Detail: ${error?.message || error}`)
        }
    }

    // Remove legacy merge artifacts from prior updater builds. No new base directory is created.
    removeLegacyMergeFolders(root)

    const changed = changedPlan.length
    const unchanged = plan.length - changed
    const autoRestart = changed > 0 && shouldAutoRestart()
    const lines = [
        `✅ Update selesai. Versi repository: ${manifest.version || 'tidak bernomor'}`,
        `File ditimpa: ${changed} | Sudah terbaru: ${unchanged} | Total diperiksa: ${plan.length}`
    ]
    if (changed) {
        lines.push('', 'File yang diperbarui:')
        lines.push(...changedPlan.slice(0, 10).map(item => `• ${item.relative}`))
        if (changedPlan.length > 10) lines.push(`• dan ${changedPlan.length - 10} file lainnya`)
        if (autoRestart) {
            lines.push('', '🔄 Pengelola proses terdeteksi/auto-restart diaktifkan. Bot akan keluar dengan aman dalam 2 detik agar pengelola dapat menjalankannya kembali. Sesi WhatsApp tidak dihapus.')
        } else {
            lines.push('', 'ℹ️ File berhasil ditimpa langsung dan backup lama disimpan. Restart otomatis tidak dijalankan karena panel biasa tidak memberi izin untuk me-restart panel/VPS dari proses bot. Tekan tombol Restart pada panel agar semua modul aktif; sesi WhatsApp tetap disimpan.')
        }
        lines.push('', `Backup file lama: ${path.relative(root, backupRoot).replace(/\\/g, '/')}`)
    } else {
        lines.push('', 'Bot sudah memakai semua file terbaru; tidak perlu restart.')
    }

    try { await reply(lines.join('\n')) } catch (error) {
        console.error('[GITHUB UPDATE REPLY]', error?.message || error)
    }

    if (autoRestart) {
        const timer = setTimeout(() => {
            console.log('[GITHUB UPDATE] Menutup proses untuk restart oleh process manager. Session folder dipertahankan.')
            process.exit(0)
        }, 2000)
    }
    return { changed, unchanged, restartScheduled: autoRestart }
}

module.exports = {
    update,
    isSafeDistributionPath,
    sha256,
    validateManifest
}
