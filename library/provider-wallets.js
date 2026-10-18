'use strict'

const { saveGlobalDatabase } = require('./global-database.js')

const VALID_WALLETS = new Set(['vipayment', 'ruangotp'])

function normalizeWallet(wallet) {
    const value = String(wallet || '').trim().toLowerCase()
    return VALID_WALLETS.has(value) ? value : ''
}

function ensureRoot() {
    if (!global.db || typeof global.db !== 'object') global.db = {}
    if (!global.db.providerWallets || typeof global.db.providerWallets !== 'object' || Array.isArray(global.db.providerWallets)) {
        global.db.providerWallets = {}
    }
    return global.db.providerWallets
}

function ensureWallets(jid) {
    const key = String(jid || '').trim()
    if (!key) throw new Error('Wallet ID tidak valid.')
    const root = ensureRoot()
    if (!root[key] || typeof root[key] !== 'object' || Array.isArray(root[key])) {
        root[key] = { vipayment: 0, ruangotp: 0, legacyMigratedAt: 0 }
    }

    const wallet = root[key]
    wallet.vipayment = Math.max(0, Number(wallet.vipayment || 0))
    wallet.ruangotp = Math.max(0, Number(wallet.ruangotp || 0))
    wallet.legacyMigratedAt = Number(wallet.legacyMigratedAt || 0)
    wallet.legacyMigrationVersion = Math.max(0, Number(wallet.legacyMigrationVersion || 0))

    // Versi lama pernah memindahkan Saldo Biasa ke wallet RuangOTP dan
    // mengosongkan users[telegram:id].money. Padahal menu Telegram saat ini
    // menggunakan Saldo Biasa untuk deposit, topup, dan nokos. Pulihkan saldo
    // yang sudah dipindahkan oleh migrasi lama tepat satu kali, lalu jangan
    // memindahkan saldo umum lagi pada pemanggilan berikutnya.
    if (/^telegram:-?\d+$/.test(key) && wallet.legacyMigrationVersion < 2) {
        if (wallet.legacyMigratedAt > 0 && wallet.ruangotp > 0) {
            if (!global.db.users || typeof global.db.users !== 'object') global.db.users = {}
            if (!global.db.users[key] || typeof global.db.users[key] !== 'object') global.db.users[key] = { money: 0 }
            const user = global.db.users[key]
            user.money = Math.max(0, Number(user.money || 0)) + wallet.ruangotp
            wallet.ruangotp = 0
        }
        wallet.legacyMigrationVersion = 2
        saveGlobalDatabase()
    }

    return wallet
}

function getBalance(jid, wallet) {
    const key = normalizeWallet(wallet)
    if (!key) throw new Error('Wallet provider tidak valid.')
    return Math.max(0, Number(ensureWallets(jid)[key] || 0))
}

function addBalance(jid, wallet, amount) {
    const key = normalizeWallet(wallet)
    if (!key) throw new Error('Wallet provider tidak valid.')
    const value = Math.floor(Number(amount || 0))
    const data = ensureWallets(jid)
    data[key] = Math.max(0, Number(data[key] || 0) + value)
    saveGlobalDatabase()
    return data[key]
}

function getBalances(jid) {
    const data = ensureWallets(jid)
    return {
        vipayment: Math.max(0, Number(data.vipayment || 0)),
        ruangotp: Math.max(0, Number(data.ruangotp || 0))
    }
}

function formatName(wallet) {
    const key = normalizeWallet(wallet)
    if (key === 'vipayment') return 'VIPayment'
    if (key === 'ruangotp') return 'RuangOTP'
    return 'Provider'
}

module.exports = {
    normalizeWallet,
    getBalance,
    addBalance,
    getBalances,
    formatName
}
