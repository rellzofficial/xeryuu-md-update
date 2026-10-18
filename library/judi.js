'use strict'

const fs = require('fs')
const path = require('path')

const DB_DIR = path.join(__dirname, 'database')
const DB_FILE = path.join(DB_DIR, 'judi.json')
const ROOM_TTL = 10 * 60 * 1000 // 10 menit

function ensureDb() {
    fs.mkdirSync(DB_DIR, { recursive: true })

    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(
            DB_FILE,
            JSON.stringify({
                version: 1,
                users: {},
                rooms: {}
            }, null, 2)
        )
    }
}

function loadDb() {
    ensureDb()

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
                    : {},

            rooms:
                data.rooms &&
                typeof data.rooms === 'object'
                    ? data.rooms
                    : {}
        }
    } catch (err) {
        console.error('[JUDI DB LOAD]', err)

        return {
            version: 1,
            users: {},
            rooms: {}
        }
    }
}

const db = loadDb()

function saveDb() {
    ensureDb()

    const tempFile = `${DB_FILE}.tmp`

    fs.writeFileSync(
        tempFile,
        JSON.stringify(db, null, 2)
    )

    fs.renameSync(tempFile, DB_FILE)
}

function cleanExpiredRooms() {
    const now = Date.now()
    let changed = false

    for (const [id, room] of Object.entries(db.rooms)) {
        if (
            !room ||
            now - Number(room.createdAt || 0) > ROOM_TTL
        ) {
            delete db.rooms[id]
            changed = true
        }
    }

    if (changed) {
        saveDb()
    }
}

function getUser(jid) {
    if (!global.db)
        global.db = {}

    if (!global.db.users)
        global.db.users = {}

    if (!global.db.users[jid]) {
        global.db.users[jid] = {
            money: 0,
            exp: 0,
            level: 0
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

function getBalance(jid) {
    return Math.max(
        0,
        Number(getUser(jid).money) || 0
    )
}

function addMoney(jid, amount) {
    const user = getUser(jid)

    user.money = Math.max(
        0,
        Math.floor(
            (Number(user.money) || 0) +
            Number(amount || 0)
        )
    )

    return user.money
}

function formatMoney(value) {
    return Number(value || 0)
        .toLocaleString('id-ID')
}

function parseAmount(value, balance) {
    if (!value)
        return null

    const text =
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

    const suffix =
        match[2]

    if (suffix === 'k')
        amount *= 1000

    if (suffix === 'm')
        amount *= 1000000

    if (suffix === 'b')
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

function randomWin(chance = 0.5) {
    return Math.random() < chance
}

function getStats(jid) {
    if (!db.users[jid]) {
        db.users[jid] = {
            played: 0,
            wins: 0,
            losses: 0,
            profit: 0
        }
    }

    return db.users[jid]
}

function record(jid, result, profit) {
    const stats =
        getStats(jid)

    stats.played += 1

    if (result === 'win')
        stats.wins += 1

    if (result === 'loss')
        stats.losses += 1

    stats.profit +=
        Math.floor(profit)
}

function playSolo(jid, bet) {
    const balance =
        getBalance(jid)

    if (balance < bet) {
        return {
            ok: false,
            error: 'BALANCE',
            balance
        }
    }

    // Potong taruhan dulu
    addMoney(jid, -bet)

    const win =
        randomWin(0.5)

    const result = {
        ok: true,
        win,
        bet,
        balance: 0,
        profit: 0
    }

    if (win) {
        // Balik modal + hadiah
        addMoney(
            jid,
            bet * 2
        )

        record(
            jid,
            'win',
            bet
        )

        result.profit = bet
    } else {
        record(
            jid,
            'loss',
            -bet
        )

        result.profit = -bet
    }

    result.balance =
        getBalance(jid)

    saveDb()

    return result
}

function createPvp(
    chat,
    challenger,
    target,
    bet
) {
    cleanExpiredRooms()

    if (
        !chat ||
        !challenger ||
        !target
    ) {
        return {
            ok: false,
            error: 'DATA_INVALID'
        }
    }

    if (challenger === target) {
        return {
            ok: false,
            error: 'SELF'
        }
    }

    const balance =
        getBalance(challenger)

    if (balance < bet) {
        return {
            ok: false,
            error: 'BALANCE',
            balance
        }
    }

    const existing =
        Object.values(db.rooms)
            .find(room =>
                room.chat === chat &&
                room.status === 'pending' &&
                (
                    room.challenger === challenger ||
                    room.target === challenger ||
                    room.challenger === target ||
                    room.target === target
                )
            )

    if (existing) {
        return {
            ok: false,
            error: 'BUSY'
        }
    }

    const id =
        `${chat}:${challenger}:${target}`

    db.rooms[id] = {
        id,
        chat,
        challenger,
        target,
        bet,
        status: 'pending',
        createdAt: Date.now()
    }

    saveDb()

    return {
        ok: true,
        room: db.rooms[id]
    }
}

function acceptPvp(
    chat,
    target
) {
    cleanExpiredRooms()

    const room =
        Object.values(db.rooms)
            .find(item =>
                item.chat === chat &&
                item.target === target &&
                item.status === 'pending'
            )

    if (!room) {
        return {
            ok: false,
            error: 'NOT_FOUND'
        }
    }

    const challengerBalance =
        getBalance(room.challenger)

    const targetBalance =
        getBalance(room.target)

    if (challengerBalance < room.bet) {
        delete db.rooms[room.id]
        saveDb()

        return {
            ok: false,
            error: 'CHALLENGER_FUNDS'
        }
    }

    if (targetBalance < room.bet) {
        return {
            ok: false,
            error: 'TARGET_FUNDS',
            balance: targetBalance,
            bet: room.bet
        }
    }

    // Kedua player membayar taruhan
    addMoney(
        room.challenger,
        -room.bet
    )

    addMoney(
        room.target,
        -room.bet
    )

    const challengerWin =
        randomWin(0.5)

    const winner =
        challengerWin
            ? room.challenger
            : room.target

    const loser =
        challengerWin
            ? room.target
            : room.challenger

    const pot =
        room.bet * 2

    // Pemenang mendapatkan seluruh pot
    addMoney(
        winner,
        pot
    )

    record(
        winner,
        'win',
        room.bet
    )

    record(
        loser,
        'loss',
        -room.bet
    )

    delete db.rooms[room.id]

    saveDb()

    return {
        ok: true,
        winner,
        loser,
        bet: room.bet,
        pot,
        challenger: room.challenger,
        target: room.target,
        challengerBalance:
            getBalance(room.challenger),
        targetBalance:
            getBalance(room.target)
    }
}

function rejectPvp(
    chat,
    sender
) {
    cleanExpiredRooms()

    const room =
        Object.values(db.rooms)
            .find(item =>
                item.chat === chat &&
                item.status === 'pending' &&
                (
                    item.target === sender ||
                    item.challenger === sender
                )
            )

    if (!room) {
        return {
            ok: false,
            error: 'NOT_FOUND'
        }
    }

    delete db.rooms[room.id]

    saveDb()

    return {
        ok: true,
        room
    }
}

function stats(jid) {
    const data =
        getStats(jid)

    return {
        ...data,
        balance:
            getBalance(jid)
    }
}

module.exports = {
    getBalance,
    addMoney,
    formatMoney,
    parseAmount,
    playSolo,
    createPvp,
    acceptPvp,
    rejectPvp,
    stats
}