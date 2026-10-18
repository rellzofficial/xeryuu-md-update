'use strict'

const fs = require('fs')
const path = require('path')
const { saveGlobalDatabase } = require('./global-database.js')

const DB_DIR = path.join(__dirname, 'database')
const DB_FILE = path.join(DB_DIR, 'economy.json')

const MAX_ENERGY = 100
const ENERGY_REGEN_MS = 2 * 60 * 1000

const BANK_INTEREST = 0.01
const MAX_INTEREST_DAYS = 7

const DAILY_REWARD = 5000
const WEEKLY_REWARD = 25000
const MONTHLY_REWARD = 100000

const SHOP = {
    bread: {
        name: 'Roti',
        price: 500,
        sell: 200,
        type: 'food',
        energy: 15
    },

    coffee: {
        name: 'Kopi',
        price: 1000,
        sell: 400,
        type: 'food',
        energy: 25
    },

    energydrink: {
        name: 'Energy Drink',
        price: 2500,
        sell: 1000,
        type: 'food',
        energy: 50
    },

    seed: {
        name: 'Bibit',
        price: 500,
        sell: 150,
        type: 'farm'
    },

    pickaxe: {
        name: 'Pickaxe',
        price: 5000,
        sell: 2000,
        type: 'tool',
        uses: 10
    },

    fishingrod: {
        name: 'Fishing Rod',
        price: 4000,
        sell: 1500,
        type: 'tool',
        uses: 10
    },

    axe: {
        name: 'Axe',
        price: 3500,
        sell: 1200,
        type: 'tool',
        uses: 10
    }
}

const SELLABLE = {
    fish: {
        name: 'Ikan',
        price: 1200
    },

    wood: {
        name: 'Kayu',
        price: 700
    },

    stone: {
        name: 'Batu',
        price: 500
    },

    iron: {
        name: 'Besi',
        price: 1800
    },

    gold: {
        name: 'Emas',
        price: 7000
    },

    coal: {
        name: 'Batu Bara',
        price: 1000
    },

    meat: {
        name: 'Daging',
        price: 1600
    },

    wheat: {
        name: 'Gandum',
        price: 1000
    },

    trash: {
        name: 'Sampah',
        price: 100
    },

    rareore: {
        name: 'Rare Ore',
        price: 15000
    }
}

const BUSINESSES = {
    warung: {
        name: 'Warung',
        price: 50000,
        min: 5000,
        max: 10000
    },

    toko: {
        name: 'Toko',
        price: 150000,
        min: 15000,
        max: 30000
    },

    tambang: {
        name: 'Perusahaan Tambang',
        price: 400000,
        min: 40000,
        max: 80000
    },

    perusahaan: {
        name: 'Perusahaan Besar',
        price: 1000000,
        min: 100000,
        max: 200000
    }
}

const ACHIEVEMENTS = {
    firstwork: {
        name: 'Pekerja Pemula',
        description: 'Bekerja 1 kali',
        reward: 1000,
        check: s => s.work >= 1
    },

    worker10: {
        name: 'Pekerja Rajin',
        description: 'Bekerja 10 kali',
        reward: 5000,
        check: s => s.work >= 10
    },

    worker100: {
        name: 'Budak Korporat',
        description: 'Bekerja 100 kali',
        reward: 50000,
        check: s => s.work >= 100
    },

    fisher10: {
        name: 'Nelayan',
        description: 'Memancing 10 kali',
        reward: 10000,
        check: s => s.fish >= 10
    },

    miner10: {
        name: 'Penambang',
        description: 'Mining 10 kali',
        reward: 15000,
        check: s => s.mine >= 10
    },

    farmer10: {
        name: 'Petani',
        description: 'Memanen 10 kali',
        reward: 10000,
        check: s => s.harvest >= 10
    },

    criminal10: {
        name: 'Kriminal',
        description: 'Crime 10 kali',
        reward: 10000,
        check: s => s.crime >= 10
    },

    rich100k: {
        name: 'Kaya',
        description: 'Memiliki 100.000',
        reward: 10000,
        check: (s, u) =>
            Number(u.money || 0) >= 100000
    },

    millionaire: {
        name: 'Jutawan',
        description: 'Memiliki 1.000.000',
        reward: 100000,
        check: (s, u) =>
            Number(u.money || 0) >= 1000000
    },

    businessowner: {
        name: 'Pengusaha',
        description: 'Memiliki bisnis',
        reward: 25000,
        check: s => Boolean(s.businessOwned)
    },

    trader: {
        name: 'Pedagang',
        description: 'Menjual 20 item',
        reward: 10000,
        check: s => s.sell >= 20
    }
}

function ensureDatabase() {
    fs.mkdirSync(DB_DIR, { recursive: true })

    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(
            DB_FILE,
            JSON.stringify({
                version: 1,
                users: {}
            }, null, 2)
        )
    }
}

function loadDatabase() {
    ensureDatabase()

    try {
        const data = JSON.parse(
            fs.readFileSync(DB_FILE, 'utf8')
        )

        return {
            version: 1,
            users:
                data.users &&
                typeof data.users === 'object'
                    ? data.users
                    : {}
        }
    } catch (error) {
        console.error('[ECONOMY LOAD]', error)

        return {
            version: 1,
            users: {}
        }
    }
}

const db = loadDatabase()

function saveDatabase() {
    ensureDatabase()

    const temp =
        `${DB_FILE}.tmp`

    fs.writeFileSync(
        temp,
        JSON.stringify(db, null, 2)
    )

    fs.renameSync(
        temp,
        DB_FILE
    )
}

function ensureGlobalDB() {
    if (!global.db)
        global.db = {}

    if (!global.db.users)
        global.db.users = {}
}

function getWalletUser(jid) {
    ensureGlobalDB()

    if (!global.db.users[jid]) {
        global.db.users[jid] = {
            money: 0
        }
    }

    if (
        typeof global.db.users[jid].money !==
        'number'
    ) {
        global.db.users[jid].money =
            Number(global.db.users[jid].money) || 0
    }

    return global.db.users[jid]
}

function getUser(jid) {
    getWalletUser(jid)

    if (!db.users[jid]) {
        db.users[jid] = {
            bank: 0,

            xp: 0,
            level: 1,

            energy: MAX_ENERGY,
            lastEnergy: Date.now(),

            streak: {
                daily: 0,
                weekly: 0,
                monthly: 0
            },

            claims: {
                daily: 0,
                weekly: 0,
                monthly: 0
            },

            lastBankInterest: Date.now(),

            inventory: {},

            toolUses: {
                pickaxe: 0,
                fishingrod: 0,
                axe: 0
            },

            farm: {
                plots: 3,
                planted: []
            },

            business: null,

            loan: {
                amount: 0,
                due: 0
            },

            dailyStats: {
                date: '',
                work: 0,
                fish: 0,
                mine: 0,
                chop: 0,
                scavenge: 0,
                hunt: 0,
                sell: 0,
                transfer: 0,
                harvest: 0
            },

            mission: {
                date: '',
                type: '',
                target: 0,
                reward: 0,
                claimed: false
            },

            achievements: [],

            stats: {
                work: 0,
                crime: 0,
                rob: 0,
                fish: 0,
                mine: 0,
                chop: 0,
                scavenge: 0,
                hunt: 0,
                sell: 0,
                transfer: 0,
                harvest: 0,
                businessOwned: false,
                earned: 0,
                spent: 0
            }
        }

        saveDatabase()
    }

    refreshEnergy(
        db.users[jid]
    )

    applyBankInterest(
        jid,
        db.users[jid]
    )

    return db.users[jid]
}

function refreshEnergy(user) {
    const now = Date.now()

    if (!user.lastEnergy) {
        user.lastEnergy = now
        return
    }

    const elapsed =
        now - user.lastEnergy

    const regen =
        Math.floor(
            elapsed /
            ENERGY_REGEN_MS
        )

    if (regen <= 0)
        return

    user.energy =
        Math.min(
            MAX_ENERGY,
            Number(user.energy || 0) + regen
        )

    user.lastEnergy =
        now -
        (
            elapsed %
            ENERGY_REGEN_MS
        )
}

function applyBankInterest(jid, user) {
    if (!user.lastBankInterest) {
        user.lastBankInterest =
            Date.now()

        return
    }

    const days =
        Math.floor(
            (
                Date.now() -
                user.lastBankInterest
            ) /
            86400000
        )

    if (days <= 0)
        return

    const interestDays =
        Math.min(
            days,
            MAX_INTEREST_DAYS
        )

    if (user.bank > 0) {
        const interest =
            Math.floor(
                user.bank *
                BANK_INTEREST *
                interestDays
            )

        if (interest > 0) {
            getWalletUser(jid)

            user.bank +=
                interest
        }
    }

    user.lastBankInterest =
        Date.now()

    saveDatabase()
}

function now() {
    return Date.now()
}

function dayKey() {
    return new Intl.DateTimeFormat(
        'en-CA',
        {
            timeZone: 'Asia/Jakarta'
        }
    ).format(new Date())
}

function monthKey() {
    return dayKey().slice(0, 7)
}

function weekKey() {
    const d =
        new Date(
            `${dayKey()}T00:00:00+07:00`
        )

    const day =
        d.getDay()

    const diff =
        day === 0
            ? -6
            : 1 - day

    d.setDate(
        d.getDate() + diff
    )

    return d
        .toISOString()
        .slice(0, 10)
}

function formatMoney(value) {
    return Number(value || 0)
        .toLocaleString('id-ID')
}

function parseAmount(value, balance) {
    if (!value)
        return null

    let text =
        String(value)
            .trim()
            .toLowerCase()

    if (
        text === 'all' ||
        text === 'semua'
    ) {
        const amount =
            Math.floor(balance)

        return amount > 0
            ? amount
            : null
    }

    const match =
        text.match(
            /^(\d+(?:\.\d+)?)(k|m|b)?$/i
        )

    if (!match)
        return null

    let amount =
        Number(match[1])

    const unit =
        match[2]

    if (unit === 'k')
        amount *= 1000

    if (unit === 'm')
        amount *= 1000000

    if (unit === 'b')
        amount *= 1000000000

    amount =
        Math.floor(amount)

    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0
    ) {
        return null
    }

    if (amount > balance)
        return null

    return amount
}

function getBalance(jid) {
    return Math.max(
        0,
        Number(
            getWalletUser(jid).money
        ) || 0
    )
}

function addMoney(jid, amount) {
    const user =
        getWalletUser(jid)

    const value =
        Math.floor(
            Number(amount || 0)
        )

    user.money =
        Math.max(
            0,
            Number(user.money || 0) +
            value
        )

    // Saldo Telegram/WhatsApp berada di global.db.users, bukan economy.json.
    // Simpan langsung agar saldo/debit/refund tidak bergantung pada autosave 3,5 detik.
    saveGlobalDatabase()
    return user.money
}


// Idempotent balance mutation for orders/refunds. The ledger and balance are
// persisted together in the canonical global database so retrying the same
// transaction key cannot charge/refund the same user twice after a restart.
function applyMoneyTransaction(jid, amount, key, reason = '') {
    const userJid = String(jid || '').trim()
    const txKey = String(key || '').trim()
    const delta = Number(amount)
    if (!userJid || !txKey || !Number.isSafeInteger(delta) || delta === 0) {
        throw new Error('Transaksi saldo tidak valid (JID, nominal, atau kunci transaksi).')
    }
    ensureGlobalDB()
    if (!global.db.moneyTransactions || typeof global.db.moneyTransactions !== 'object' || Array.isArray(global.db.moneyTransactions)) {
        global.db.moneyTransactions = {}
    }
    const existing = global.db.moneyTransactions[txKey]
    if (existing) {
        return { applied: false, duplicate: true, balance: getBalance(userJid), transaction: existing }
    }
    const user = getWalletUser(userJid)
    const before = Math.max(0, Number(user.money || 0))
    if (delta < 0 && before < Math.abs(delta)) {
        return { applied: false, insufficient: true, balance: before }
    }
    const after = before + delta
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Hasil perubahan saldo tidak valid.')

    user.money = after
    const record = { key: txKey, jid: userJid, amount: delta, before, after, reason: String(reason || ''), createdAt: Date.now() }
    global.db.moneyTransactions[txKey] = record
    const saved = saveGlobalDatabase()
    if (!saved) {
        user.money = before
        delete global.db.moneyTransactions[txKey]
        throw new Error('Gagal menyimpan perubahan saldo secara persisten; transaksi dibatalkan.')
    }
    return { applied: true, duplicate: false, balance: after, transaction: record }
}

function addXP(jid, amount) {
    const user =
        getUser(jid)

    user.xp +=
        Math.max(
            0,
            Math.floor(amount || 0)
        )

    let levelUps = 0

    while (
        user.xp >=
        xpRequired(user.level)
    ) {
        user.xp -=
            xpRequired(user.level)

        user.level += 1

        levelUps++

        user.energy =
            MAX_ENERGY
    }

    if (levelUps > 0) {
        addMoney(
            jid,
            levelUps * 500
        )
    }

    saveDatabase()

    return {
        level:
            user.level,

        levelUps,
        xp:
            user.xp,

        next:
            xpRequired(user.level)
    }
}

function xpRequired(level) {
    return (
        100 +
        ((level - 1) * 75)
    )
}

function consumeEnergy(jid, amount) {
    const user =
        getUser(jid)

    if (
        user.energy <
        amount
    ) {
        return false
    }

    user.energy -=
        amount

    saveDatabase()

    return true
}

function cooldownRemaining(
    user,
    key,
    duration
) {
    if (!user.cooldowns)
        user.cooldowns = {}

    const last =
        Number(
            user.cooldowns[key] || 0
        )

    const remaining =
        duration -
        (
            Date.now() -
            last
        )

    return Math.max(
        0,
        remaining
    )
}

function setCooldown(
    user,
    key
) {
    if (!user.cooldowns)
        user.cooldowns = {}

    user.cooldowns[key] =
        Date.now()
}

function random(min, max) {
    return Math.floor(
        Math.random() *
        (max - min + 1)
    ) + min
}

function chance(percent) {
    return (
        Math.random() * 100
    ) < percent
}

function addInventory(
    user,
    item,
    amount
) {
    if (!user.inventory[item])
        user.inventory[item] = 0

    user.inventory[item] +=
        amount

    if (
        user.inventory[item] <= 0
    ) {
        delete user.inventory[item]
    }
}

function hasItem(
    user,
    item,
    amount = 1
) {
    return (
        Number(
            user.inventory[item] || 0
        ) >= amount
    )
}

function consumeItem(
    user,
    item,
    amount = 1
) {
    if (
        !hasItem(
            user,
            item,
            amount
        )
    ) {
        return false
    }

    user.inventory[item] -=
        amount

    if (
        user.inventory[item] <= 0
    ) {
        delete user.inventory[item]
    }

    return true
}

function consumeTool(
    user,
    tool
) {
    if (
        Number(
            user.toolUses[tool] || 0
        ) <= 0
    ) {
        return false
    }

    user.toolUses[tool]--

    return true
}

function markActivity(
    user,
    key
) {
    if (!user.stats[key])
        user.stats[key] = 0

    user.stats[key]++

    const current =
        dayKey()

    if (
        user.dailyStats.date !==
        current
    ) {
        user.dailyStats = {
            date: current,
            work: 0,
            fish: 0,
            mine: 0,
            chop: 0,
            scavenge: 0,
            hunt: 0,
            sell: 0,
            transfer: 0,
            harvest: 0
        }
    }

    if (
        typeof user.dailyStats[key] ===
        'number'
    ) {
        user.dailyStats[key]++
    }
}

function ensureMission(user) {
    const today =
        dayKey()

    if (
        user.mission.date ===
        today
    ) {
        return user.mission
    }

    const missions = [
        {
            type: 'work',
            target: 3,
            reward: 5000
        },

        {
            type: 'fish',
            target: 3,
            reward: 7000
        },

        {
            type: 'mine',
            target: 3,
            reward: 8000
        },

        {
            type: 'chop',
            target: 3,
            reward: 6000
        },

        {
            type: 'sell',
            target: 5,
            reward: 7500
        },

        {
            type: 'harvest',
            target: 2,
            reward: 9000
        }
    ]

    const index =
        Math.floor(
            Math.random() *
            missions.length
        )

    const mission =
        missions[index]

    user.mission = {
        date: today,
        type: mission.type,
        target: mission.target,
        reward: mission.reward,
        claimed: false
    }

    saveDatabase()

    return user.mission
}

function missionProgress(user) {
    const mission =
        ensureMission(user)

    return Math.min(
        mission.target,
        Number(
            user.dailyStats[
                mission.type
            ] || 0
        )
    )
}

function checkAchievements(jid) {
    const user =
        getUser(jid)

    const wallet =
        getWalletUser(jid)

    const unlocked = []

    for (
        const [id, achievement]
        of Object.entries(ACHIEVEMENTS)
    ) {
        if (
            user.achievements
                .includes(id)
        ) {
            continue
        }

        if (
            achievement.check(
                user.stats,
                wallet
            )
        ) {
            user.achievements.push(id)

            addMoney(
                jid,
                achievement.reward
            )

            unlocked.push(
                achievement
            )
        }
    }

    if (unlocked.length > 0)
        saveDatabase()

    return unlocked
}

function profile(jid) {
    const user =
        getUser(jid)

    const wallet =
        getBalance(jid)

    return {
        wallet,
        bank:
            Number(user.bank || 0),

        total:
            wallet +
            Number(user.bank || 0),

        level:
            user.level,

        xp:
            user.xp,

        nextXp:
            xpRequired(
                user.level
            ),

        energy:
            user.energy,

        maxEnergy:
            MAX_ENERGY,

        streak:
            user.streak,

        business:
            user.business,

        loan:
            user.loan,

        achievements:
            user.achievements.length
    }
}

function daily(jid) {
    const user =
        getUser(jid)

    const today =
        dayKey()

    const last =
        Number(
            user.claims.daily || 0
        )

    const lastDate =
        last
            ? new Date(last)
                .toLocaleDateString(
                    'en-CA',
                    {
                        timeZone:
                            'Asia/Jakarta'
                    }
                )
            : null

    if (
        lastDate ===
        today
    ) {
        return {
            ok: false,
            error: 'CLAIMED'
        }
    }

    const yesterday =
        new Date()

    yesterday.setDate(
        yesterday.getDate() - 1
    )

    const yesterdayKey =
        yesterday
            .toLocaleDateString(
                'en-CA',
                {
                    timeZone:
                        'Asia/Jakarta'
                }
            )

    if (
        lastDate ===
        yesterdayKey
    ) {
        user.streak.daily++
    } else {
        user.streak.daily = 1
    }

    const bonus =
        Math.min(
            user.streak.daily * 500,
            10000
        )

    const reward =
        DAILY_REWARD +
        bonus

    user.claims.daily =
        Date.now()

    addMoney(
        jid,
        reward
    )

    addXP(
        jid,
        25
    )

    saveDatabase()

    return {
        ok: true,
        reward,
        streak:
            user.streak.daily
    }
}

function weekly(jid) {
    const user =
        getUser(jid)

    const key =
        weekKey()

    const stored =
        user.claims.weeklyKey

    if (stored === key) {
        return {
            ok: false,
            error: 'CLAIMED'
        }
    }

    user.claims.weeklyKey =
        key

    user.streak.weekly++

    addMoney(
        jid,
        WEEKLY_REWARD
    )

    addXP(
        jid,
        100
    )

    saveDatabase()

    return {
        ok: true,
        reward:
            WEEKLY_REWARD,
        streak:
            user.streak.weekly
    }
}

function monthly(jid) {
    const user =
        getUser(jid)

    const key =
        monthKey()

    if (
        user.claims.monthlyKey ===
        key
    ) {
        return {
            ok: false,
            error: 'CLAIMED'
        }
    }

    user.claims.monthlyKey =
        key

    user.streak.monthly++

    addMoney(
        jid,
        MONTHLY_REWARD
    )

    addXP(
        jid,
        300
    )

    saveDatabase()

    return {
        ok: true,
        reward:
            MONTHLY_REWARD,
        streak:
            user.streak.monthly
    }
}

function work(jid) {
    const user =
        getUser(jid)

    const cd =
        cooldownRemaining(
            user,
            'work',
            5 * 60 * 1000
        )

    if (cd > 0) {
        return {
            ok: false,
            error: 'COOLDOWN',
            remaining: cd
        }
    }

    if (
        !consumeEnergy(
            jid,
            10
        )
    ) {
        return {
            ok: false,
            error: 'ENERGY'
        }
    }

    const jobs = [
        'mengantar paket',
        'menjadi programmer',
        'berjualan makanan',
        'menjadi teknisi',
        'menjadi driver',
        'bekerja di kantor',
        'menjadi freelancer'
    ]

    const job =
        jobs[
            random(
                0,
                jobs.length - 1
            )
        ]

    const reward =
        random(
            2500,
            7000
        )

    setCooldown(
        user,
        'work'
    )

    addMoney(
        jid,
        reward
    )

    addXP(
        jid,
        35
    )

    user.stats.earned +=
        reward

    markActivity(
        user,
        'work'
    )

    const achievements =
        checkAchievements(jid)

    saveDatabase()

    return {
        ok: true,
        job,
        reward,
        level:
            user.level,
        achievements
    }
}

function crime(jid) {
    const user =
        getUser(jid)

    const cd =
        cooldownRemaining(
            user,
            'crime',
            10 * 60 * 1000
        )

    if (cd > 0) {
        return {
            ok: false,
            error: 'COOLDOWN',
            remaining: cd
        }
    }

    if (
        !consumeEnergy(
            jid,
            20
        )
    ) {
        return {
            ok: false,
            error: 'ENERGY'
        }
    }

    setCooldown(
        user,
        'crime'
    )

    markActivity(
        user,
        'crime'
    )

    const success =
        chance(55)

    if (success) {
        const reward =
            random(
                5000,
                20000
            )

        addMoney(
            jid,
            reward
        )

        user.stats.earned +=
            reward

        addXP(
            jid,
            50
        )

        checkAchievements(jid)

        saveDatabase()

        return {
            ok: true,
            success: true,
            reward
        }
    }

    const fine =
        Math.min(
            random(
                1000,
                5000
            ),
            getBalance(jid)
        )

    addMoney(
        jid,
        -fine
    )

    addXP(
        jid,
        15
    )

    saveDatabase()

    return {
        ok: true,
        success: false,
        fine
    }
}

function rob(
    jid,
    target
) {
    const user =
        getUser(jid)

    const cd =
        cooldownRemaining(
            user,
            'rob',
            20 * 60 * 1000
        )

    if (cd > 0) {
        return {
            ok: false,
            error: 'COOLDOWN',
            remaining: cd
        }
    }

    if (jid === target) {
        return {
            ok: false,
            error: 'SELF'
        }
    }

    const targetWallet =
        getWalletUser(target)

    const targetMoney =
        Number(
            targetWallet.money || 0
        )

    if (targetMoney < 1000) {
        return {
            ok: false,
            error: 'POOR'
        }
    }

    if (
        !consumeEnergy(
            jid,
            25
        )
    ) {
        return {
            ok: false,
            error: 'ENERGY'
        }
    }

    setCooldown(
        user,
        'rob'
    )

    markActivity(
        user,
        'rob'
    )

    if (chance(45)) {
        const amount =
            Math.min(
                targetMoney,
                random(
                    1000,
                    Math.max(
                        1000,
                        Math.floor(
                            targetMoney *
                            0.25
                        )
                    )
                )
            )

        targetWallet.money -=
            amount

        addMoney(
            jid,
            amount
        )

        user.stats.earned +=
            amount

        addXP(
            jid,
            60
        )

        checkAchievements(jid)

        saveDatabase()

        return {
            ok: true,
            success: true,
            amount
        }
    }

    const fine =
        Math.min(
            random(
                1000,
                5000
            ),
            getBalance(jid)
        )

    addMoney(
        jid,
        -fine
    )

    saveDatabase()

    return {
        ok: true,
        success: false,
        fine
    }
}

function transfer(
    from,
    to,
    amount
) {
    if (from === to) {
        return {
            ok: false,
            error: 'SELF'
        }
    }

    if (
        !Number.isSafeInteger(amount) ||
        amount <= 0
    ) {
        return {
            ok: false,
            error: 'AMOUNT'
        }
    }

    const balance =
        getBalance(from)

    if (balance < amount) {
        return {
            ok: false,
            error: 'BALANCE',
            balance
        }
    }

    const sender =
        getUser(from)

    addMoney(
        from,
        -amount
    )

    addMoney(
        to,
        amount
    )

    sender.stats.transfer++

    markActivity(
        sender,
        'transfer'
    )

    saveDatabase()

    return {
        ok: true,
        amount,
        balance:
            getBalance(from)
    }
}

function deposit(
    jid,
    amount
) {
    const user =
        getUser(jid)

    const balance =
        getBalance(jid)

    if (balance < amount) {
        return {
            ok: false,
            error: 'BALANCE',
            balance
        }
    }

    addMoney(
        jid,
        -amount
    )

    user.bank +=
        amount

    saveDatabase()

    return {
        ok: true,
        amount,
        bank:
            user.bank,
        balance:
            getBalance(jid)
    }
}

function withdraw(
    jid,
    amount
) {
    const user =
        getUser(jid)

    if (
        user.bank <
        amount
    ) {
        return {
            ok: false,
            error: 'BANK_BALANCE',
            bank:
                user.bank
        }
    }

    user.bank -=
        amount

    addMoney(
        jid,
        amount
    )

    saveDatabase()

    return {
        ok: true,
        amount,
        bank:
            user.bank,
        balance:
            getBalance(jid)
    }
}

function shop() {
    return SHOP
}

function buy(
    jid,
    item,
    amount
) {
    const user =
        getUser(jid)

    item =
        String(item || '')
            .toLowerCase()

    const product =
        SHOP[item]

    if (!product) {
        return {
            ok: false,
            error: 'ITEM'
        }
    }

    const total =
        product.price *
        amount

    if (
        !Number.isSafeInteger(total) ||
        amount <= 0
    ) {
        return {
            ok: false,
            error: 'AMOUNT'
        }
    }

    const balance =
        getBalance(jid)

    if (
        balance <
        total
    ) {
        return {
            ok: false,
            error: 'BALANCE',
            balance
        }
    }

    addMoney(
        jid,
        -total
    )

    user.stats.spent +=
        total

    if (
        product.type ===
        'tool'
    ) {
        user.toolUses[item] =
            Number(
                user.toolUses[item] || 0
            ) +
            (
                product.uses *
                amount
            )
    } else {
        addInventory(
            user,
            item,
            amount
        )
    }

    saveDatabase()

    return {
        ok: true,
        item,
        amount,
        total,
        balance:
            getBalance(jid)
    }
}

function sell(
    jid,
    item,
    amount
) {
    const user =
        getUser(jid)

    item =
        String(item || '')
            .toLowerCase()

    const product =
        SELLABLE[item]

    if (!product) {
        return {
            ok: false,
            error: 'ITEM'
        }
    }

    if (
        !hasItem(
            user,
            item,
            amount
        )
    ) {
        return {
            ok: false,
            error: 'INVENTORY'
        }
    }

    consumeItem(
        user,
        item,
        amount
    )

    const total =
        product.price *
        amount

    addMoney(
        jid,
        total
    )

    user.stats.earned +=
        total

    markActivity(
        user,
        'sell'
    )

    addXP(
        jid,
        20
    )

    const achievements =
        checkAchievements(jid)

    saveDatabase()

    return {
        ok: true,
        item,
        amount,
        total,
        achievements
    }
}

function useItem(
    jid,
    item,
    amount = 1
) {
    const user =
        getUser(jid)
  }

// Export public economy API for other modules (topup, nokos, commands).
module.exports = {
    SHOP,
    SELLABLE,
    getUser,
    getBalance,
    addMoney,
    applyMoneyTransaction,
    formatMoney,
    parseAmount,
    profile,
    daily,
    weekly,
    monthly,
    work,
    crime,
    rob,
    transfer,
    deposit,
    withdraw,
    shop,
    buy,
    sell,
    useItem,
    saveDatabase
}
