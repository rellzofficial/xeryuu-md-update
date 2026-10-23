'use strict'

function normalize(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function plainText(value) {
    return String(value || '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/\s*li\s*>/gi, '\n')
        .replace(/<\s*li\b[^>]*>/gi, '• ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/[\t ]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function isUnsupportedTopupProduct(product = {}) {
    const category = `${product.game || ''} ${product.name || ''}`.toLowerCase()
    const description = plainText(product.description).toLowerCase()

    // VIPayment separates ordinary game top-ups from Joki services. Joki needs
    // extra parameters (and may ask for account credentials) that this flow
    // intentionally does not collect or send.
    if (/\bjoki\b|rank\s*boost|boosting|jual\s*akun|sewa\s*akun/.test(category)) return true
    if (/additional_data|post_additional_data|password\s*akun|kata sandi akun|email\s*dan\s*password|login\s*akun/.test(description)) return true
    if (/(data tambahan|parameter tambahan).{0,35}(wajib|required|harus diisi)|(wajib|required|harus diisi).{0,35}(data tambahan|parameter tambahan)/.test(description)) return true
    return false
}

function getTopupInputProfile(game, product = {}) {
    const gameText = `${game || ''} ${product.game || ''} ${product.name || ''}`.toLowerCase()
    const gameKey = normalize(gameText)

    if (isUnsupportedTopupProduct(product)) {
        return {
            supported: false,
            prompt: 'Produk ini membutuhkan parameter khusus yang belum didukung oleh alur top-up standar. Pilih produk top-up biasa agar tidak salah order.',
            example: ''
        }
    }

    const providerText = plainText(`${product.name || ''} ${product.description || ''}`).toLowerCase()
    const explicitZoneRequirement = /(?:\b(?:zone|server|region)\b.{0,30}\b(?:wajib|required|harus diisi|masukkan|isi)\b)|(?:\b(?:wajib|required|harus diisi)\b.{0,30}\b(?:zone|server|region)\b)/i.test(providerText)

    if (gameKey.includes('mobilelegend') || gameKey === 'ml') {
        return {
            supported: true,
            kind: 'id-zone',
            customerLabel: 'Player ID',
            zoneLabel: 'Zone ID',
            requiredZone: true,
            numericId: true,
            numericZone: true,
            prompt: 'Buka profil Mobile Legends, lalu masukkan Player ID dan Zone ID/Server ID. Pisahkan dengan satu spasi.',
            example: '12345678 1234',
            formatHint: 'PLAYER_ID ZONE_ID'
        }
    }

    if (explicitZoneRequirement) {
        const numericId = /(freefire|garena|genshinimpact|honkaistarrail|zenlesszonezero|wutheringwaves)/.test(gameKey)
        return {
            supported: true,
            kind: 'generic',
            customerLabel: 'ID/UID/username tujuan',
            zoneLabel: 'Zone/Server/Region',
            requiredZone: true,
            numericId,
            numericZone: false,
            prompt: 'Catatan provider menyatakan Zone/Server/Region wajib. Masukkan ID/UID tujuan dan nilai Zone/Server dalam satu baris, dipisahkan satu spasi.',
            example: numericId ? '123456789 ASIA' : 'ID123456 SERVER1',
            formatHint: 'ID ZONE'
        }
    }

    if (gameKey.includes('freefire') || gameKey.includes('garena')) {
        return {
            supported: true,
            kind: 'id-only',
            customerLabel: 'Player UID',
            requiredZone: false,
            numericId: true,
            prompt: 'Masukkan UID/ID pemain Free Fire dari profil game. Untuk produk ini cukup UID saja, tanpa password.',
            example: '123456789',
            formatHint: 'UID'
        }
    }

    if (gameKey.includes('roblox')) {
        return {
            supported: true,
            kind: 'roblox-target',
            customerLabel: 'ID/Username Roblox',
            requiredZone: false,
            prompt: 'Masukkan ID pengguna Roblox atau username penerima sesuai petunjuk produk/provider. Cukup satu nilai; jangan kirim password, cookie, atau kode login.',
            example: '6272636362 atau UsernameRoblox',
            formatHint: 'ROBLOX_USER_ID_OR_USERNAME'
        }
    }

    if (/(genshinimpact|honkaistarrail|zenlesszonezero|wutheringwaves)/.test(gameKey)) {
        return {
            supported: true,
            kind: 'generic',
            customerLabel: 'UID',
            zoneLabel: 'Server/Region',
            requiredZone: false,
            numericId: true,
            numericZone: false,
            prompt: 'Masukkan UID numerik. Tambahkan Server/Region hanya jika catatan produk/provider menyatakannya wajib atau memang meminta kolom tersebut; jika tidak, cukup UID saja.',
            example: '123456789',
            formatHint: 'UID [SERVER_REGION]'
        }
    }

    const requiredZone = false
    return {
        supported: true,
        kind: 'generic',
        customerLabel: 'ID/UID/username tujuan',
        zoneLabel: 'Zone/Server',
        requiredZone,
        numericId: false,
        prompt: requiredZone
            ? 'Masukkan ID/UID dan Zone/Server persis sesuai petunjuk provider, pisahkan dengan satu spasi: ID ZONE. Periksa Catatan Provider sebelum melanjutkan.'
            : 'Masukkan ID/UID/username yang diminta oleh produk dan Catatan Provider. Jika tidak ada instruksi Zone/Server wajib, cukup satu nilai. Bila provider meminta Zone/Server, masukkan dua nilai dipisahkan satu spasi: ID ZONE. Jangan kirim password, cookie, atau kode login.',
        example: requiredZone ? 'ID123456 SERVER1' : 'ID123456 atau ID123456 SERVER1',
        formatHint: requiredZone ? 'ID ZONE' : 'ID [ZONE]'
    }
}

function parseTopupTarget(rawInput, profile) {
    if (!profile || profile.supported === false) {
        return { ok: false, error: profile?.prompt || 'Format input produk ini belum didukung.' }
    }

    const input = String(rawInput || '').trim()
    if (!input || input.startsWith('/')) return { ok: false, error: 'Data tujuan kosong.' }
    if (/[\r\n\t]/.test(input)) return { ok: false, error: 'Kirim data tujuan dalam satu baris.' }

    const parts = input.split(/\s+/)
    const usesZone = profile.kind === 'id-zone' || profile.kind === 'generic'
    if (profile.kind === 'id-zone' && parts.length !== 2) {
        return { ok: false, error: `Format wajib: ${profile.formatHint}. Contoh: ${profile.example}` }
    }
    if (profile.kind === 'id-only' && parts.length !== 1) {
        return { ok: false, error: `Produk ini hanya meminta ${profile.customerLabel}. Jangan tambahkan Zone/Server. Contoh: ${profile.example}` }
    }
    if (profile.kind === 'roblox-target') {
        if (parts.length !== 1 || !/^(?:\d{3,20}|[A-Za-z0-9_]{3,20})$/.test(parts[0])) {
            return { ok: false, error: 'ID/username Roblox tidak valid. Kirim satu ID numerik atau username tanpa spasi; jangan kirim password, cookie, atau kode login.' }
        }
        return { ok: true, customerNo: parts[0], zone: '' }
    }
    if (profile.kind === 'id-zone' && parts.length !== 2) {
        return { ok: false, error: `Format wajib: ${profile.formatHint}. Contoh: ${profile.example}` }
    }
    if (profile.kind === 'generic' && parts.length > 2) {
        return { ok: false, error: 'Terlalu banyak bagian. Kirim satu ID, atau ID dan Zone/Server dipisahkan satu spasi.' }
    }

    const customerNo = parts[0]
    const zone = usesZone && parts.length === 2 ? parts[1] : ''
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(customerNo)) {
        return { ok: false, error: `${profile.customerLabel || 'ID tujuan'} tidak valid. Gunakan 2–64 karakter huruf, angka, titik, garis bawah, atau tanda hubung.` }
    }
    if (profile.numericId && !/^\d{4,24}$/.test(customerNo)) {
        return { ok: false, error: `${profile.customerLabel || 'ID'} harus berupa angka. Periksa kembali ID di profil game.` }
    }
    if (profile.requiredZone && !zone) {
        return { ok: false, error: `Zone/Server wajib diisi. Format: ${profile.formatHint}. Contoh: ${profile.example}` }
    }
    if (profile.numericZone && zone && !/^\d{1,12}$/.test(zone)) {
        return { ok: false, error: `${profile.zoneLabel || 'Zone'} harus berupa angka. Periksa kembali nilai Zone/Server.` }
    }
    if (zone && !/^[A-Za-z0-9._-]{1,32}$/.test(zone)) {
        return { ok: false, error: `${profile.zoneLabel || 'Zone/Server'} tidak valid. Masukkan kode tanpa spasi.` }
    }

    return { ok: true, customerNo, zone }
}

function providerDescription(product) {
    const value = plainText(product?.description || '')
    if (!value || value.toLowerCase() === String(product?.name || '').toLowerCase()) return ''
    return value.length > 220 ? `${value.slice(0, 217).trimEnd()}...` : value
}

module.exports = {
    normalize,
    plainText,
    isUnsupportedTopupProduct,
    getTopupInputProfile,
    parseTopupTarget,
    providerDescription
}
