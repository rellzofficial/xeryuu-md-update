'use strict'

const fs = require('fs')
const path = require('path')

const DB_DIR = path.join(__dirname, 'database')
const DB_FILE = path.join(DB_DIR, 'games.json')
const DB_TMP = `${DB_FILE}.tmp`
const ROOM_TTL = 24 * 60 * 60 * 1000

const WORDS = [
  'xeryuu', 'whatsapp', 'javascript', 'pixel', 'adventure',
  'monster', 'keyboard', 'komputer', 'developer', 'indonesia',
  'server', 'database', 'challenge', 'strategy', 'fantasy'
]

const OPERATIONS = ['+', '-', '×']

function ensureDbFile() {
  fs.mkdirSync(DB_DIR, { recursive: true })
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ version: 1, players: {}, rooms: {} }, null, 2))
  }
}

function loadDb() {
  ensureDbFile()
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
    return {
      version: 1,
      players: parsed.players && typeof parsed.players === 'object' ? parsed.players : {},
      rooms: parsed.rooms && typeof parsed.rooms === 'object' ? parsed.rooms : {}
    }
  } catch (error) {
    console.error('[GAMES DB] Failed to load:', error.message)
    return { version: 1, players: {}, rooms: {} }
  }
}

const db = loadDb()

function pruneRooms() {
  const now = Date.now()
  let changed = false
  for (const [key, room] of Object.entries(db.rooms)) {
    if (!room || now - (Number(room.updatedAt) || 0) > ROOM_TTL) {
      delete db.rooms[key]
      changed = true
    }
  }
  return changed
}

function saveDb() {
  pruneRooms()
  const payload = JSON.stringify(db, null, 2)
  const fd = fs.openSync(DB_TMP, 'w')
  try {
    fs.writeFileSync(fd, payload, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(DB_TMP, DB_FILE)
}

function now() {
  return Date.now()
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function cleanJid(jid) {
  return String(jid || '').trim()
}

function mention(jid) {
  return `@${cleanJid(jid).split('@')[0]}`
}

function uniquePlayers(players) {
  return [...new Set((players || []).filter(Boolean))]
}

function getPlayer(jid) {
  const id = cleanJid(jid)
  if (!db.players[id]) {
    db.players[id] = {
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      xp: 0,
      coins: 0,
      streak: 0,
      bestStreak: 0,
      byGame: {}
    }
  }
  return db.players[id]
}

function addStat(jid, game, result, reward = 0) {
  const p = getPlayer(jid)
  p.games += 1
  p.byGame[game] = p.byGame[game] || { played: 0, wins: 0, losses: 0, draws: 0 }
  p.byGame[game].played += 1
  if (result === 'win') {
    p.wins += 1
    p.byGame[game].wins += 1
    p.streak += 1
    p.bestStreak = Math.max(p.bestStreak, p.streak)
    p.xp += 100
  } else if (result === 'loss') {
    p.losses += 1
    p.byGame[game].losses += 1
    p.streak = 0
    p.xp += 25
  } else {
    p.draws += 1
    p.byGame[game].draws += 1
    p.xp += 50
  }
  p.coins += Number(reward) || 0
}

function addSoloProgress(jid, game, success, reward = 0, xp = 50) {
  const p = getPlayer(jid)
  p.games += 1
  p.byGame[game] = p.byGame[game] || { played: 0, wins: 0, losses: 0, draws: 0 }
  p.byGame[game].played += 1
  p.xp += success ? xp : Math.floor(xp / 3)
  if (success) {
    p.wins += 1
    p.byGame[game].wins += 1
    p.streak += 1
    p.bestStreak = Math.max(p.bestStreak, p.streak)
    p.coins += Number(reward) || 0
  } else {
    p.losses += 1
    p.byGame[game].losses += 1
    p.streak = 0
  }
}

function boardTtt(board) {
  return [0, 1, 2].map(row => {
    const cells = [0, 1, 2].map(col => {
      const i = row * 3 + col
      return board[i] || String(i + 1)
    })
    return ` ${cells[0]} │ ${cells[1]} │ ${cells[2]} `
  }).join('\n───┼───┼───\n')
}

function checkWinner3(board) {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ]
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a]
  }
  return board.every(Boolean) ? 'draw' : null
}

function renderConnect4(board) {
  const rows = []
  for (let r = 0; r < 6; r++) {
    const row = []
    for (let c = 0; c < 7; c++) {
      const value = board[r * 7 + c]
      row.push(value === 'R' ? '🔴' : value === 'Y' ? '🟡' : '⚪')
    }
    rows.push(row.join(''))
  }
  rows.push('1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣')
  return rows.join('\n')
}

function checkConnect4(board, token) {
  const directions = [[1,0],[0,1],[1,1],[1,-1]]
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 7; c++) {
      if (board[r * 7 + c] !== token) continue
      for (const [dr, dc] of directions) {
        let count = 1
        for (let step = 1; step < 4; step++) {
          const nr = r + dr * step
          const nc = c + dc * step
          if (nr < 0 || nr >= 6 || nc < 0 || nc >= 7) break
          if (board[nr * 7 + nc] !== token) break
          count++
        }
        if (count >= 4) return true
      }
    }
  }
  return false
}

function parseMentionTarget(m, args) {
  const mentioned = Array.isArray(m?.mentionedJid) ? m.mentionedJid.filter(Boolean) : []
  if (mentioned[0]) return mentioned[0]
  const raw = (args || []).find(v => /@?\d{6,}/.test(String(v)))
  if (!raw) return null
  const digits = String(raw).replace(/\D/g, '')
  return digits ? `${digits}@s.whatsapp.net` : null
}

function gameRoom(chat, type) {
  return `${cleanJid(chat)}::${type}`
}

function setRoom(key, data) {
  db.rooms[key] = { ...data, updatedAt: now() }
  return db.rooms[key]
}

function getRoom(key) {
  const room = db.rooms[key]
  if (!room) return null
  if (now() - (Number(room.updatedAt) || 0) > ROOM_TTL) {
    delete db.rooms[key]
    saveDb()
    return null
  }
  return room
}

function deleteRoom(key) {
  delete db.rooms[key]
}

async function send(ctx, text, extra = {}) {
  return ctx.reply(text, extra)
}

async function cmdTtt(ctx) {
  const key = gameRoom(ctx.m.chat, 'ttt')
  let room = getRoom(key)
  const moveArg = String(ctx.args?.[0] || '').trim()
  const target = parseMentionTarget(ctx.m, ctx.args || [])

  if (!room) {
    if (!target || target === ctx.m.sender) {
      return send(ctx, `🎮 *TIC TAC TOE 1v1*\n\nGunakan: ${ctx.prefix}ttt @user\n\nSetelah dibuat, pemain bergiliran memakai:\n${ctx.prefix}ttt 1-9`)
    }
    room = setRoom(key, {
      game: 'ttt',
      chat: ctx.m.chat,
      players: [ctx.m.sender, target],
      marks: { [ctx.m.sender]: 'X', [target]: 'O' },
      board: Array(9).fill(null),
      turn: ctx.m.sender,
      createdAt: now()
    })
    saveDb()
    return send(ctx, `🎮 *TIC TAC TOE*\n\n${mention(ctx.m.sender)} ❌ vs ${mention(target)} ⭕\n\nGiliran: ${mention(ctx.m.sender)}\n\n${boardTtt(room.board)}\n\nKetik *${ctx.prefix}ttt 1* sampai *${ctx.prefix}ttt 9*.`, {
      mentions: [ctx.m.sender, target]
    })
  }

  if (!room.players.includes(ctx.m.sender)) return send(ctx, '❌ Kamu bukan pemain di room Tic Tac Toe ini.')
  if (!moveArg) {
    return send(ctx, `🎮 *TIC TAC TOE*\n\n${boardTtt(room.board)}\n\nGiliran: ${mention(room.turn)}`, { mentions: [room.turn] })
  }
  if (ctx.m.sender !== room.turn) return send(ctx, `⏳ Belum giliranmu. Giliran ${mention(room.turn)}.`, { mentions: [room.turn] })
  const pos = Number(moveArg) - 1
  if (!Number.isInteger(pos) || pos < 0 || pos > 8 || room.board[pos]) return send(ctx, '❌ Posisi tidak valid atau sudah terisi. Gunakan angka 1-9.')

  room.board[pos] = room.marks[ctx.m.sender]
  const winner = checkWinner3(room.board)
  if (winner) {
    const textBoard = boardTtt(room.board)
    const players = room.players.slice()
    if (winner === 'draw') {
      players.forEach(p => addStat(p, 'ttt', 'draw', 75))
      deleteRoom(key)
      saveDb()
      return send(ctx, `🤝 *DRAW!*\n\n${textBoard}\n\nKedua pemain mendapatkan +75 coin dan +50 XP.`)
    }
    const winnerJid = players.find(p => room.marks[p] === winner)
    const loserJid = players.find(p => p !== winnerJid)
    addStat(winnerJid, 'ttt', 'win', 200)
    addStat(loserJid, 'ttt', 'loss', 50)
    deleteRoom(key)
    saveDb()
    return send(ctx, `🏆 *${mention(winnerJid)} MENANG!*\n\n${textBoard}\n\n🎁 Reward pemenang: +200 coin\n🎁 Reward lawan: +50 coin`, {
      mentions: [winnerJid, loserJid]
    })
  }

  room.turn = room.players.find(p => p !== ctx.m.sender)
  room.updatedAt = now()
  saveDb()
  return send(ctx, `🎮 *TIC TAC TOE*\n\n${boardTtt(room.board)}\n\nGiliran: ${mention(room.turn)}`, {
    mentions: [room.turn]
  })
}

function compareSuit(a, b) {
  if (a === b) return 'draw'
  if ((a === 'batu' && b === 'gunting') || (a === 'gunting' && b === 'kertas') || (a === 'kertas' && b === 'batu')) return 'a'
  return 'b'
}

async function cmdSuit(ctx) {
  const key = gameRoom(ctx.m.chat, 'suit')
  let room = getRoom(key)
  const choice = String(ctx.args?.[0] || '').toLowerCase().trim()
  const choices = ['batu', 'gunting', 'kertas']
  const target = parseMentionTarget(ctx.m, ctx.args || [])

  if (!room) {
    if (!target || target === ctx.m.sender) {
      return send(ctx, `✊ *SUIT 1v1*\n\nGunakan: ${ctx.prefix}suit @user\n\nSetelah room dibuat, kedua pemain kirim:\n${ctx.prefix}suit batu\n${ctx.prefix}suit gunting\n${ctx.prefix}suit kertas`)
    }
    room = setRoom(key, {
      game: 'suit',
      chat: ctx.m.chat,
      players: [ctx.m.sender, target],
      choices: {},
      createdAt: now()
    })
    saveDb()
    return send(ctx, `✊ *SUIT DIMULAI*\n\n${mention(ctx.m.sender)} vs ${mention(target)}\n\nKeduanya pilih secara rahasia dengan *${ctx.prefix}suit batu|gunting|kertas*.`, {
      mentions: [ctx.m.sender, target]
    })
  }

  if (!room.players.includes(ctx.m.sender)) return send(ctx, '❌ Kamu bukan pemain di room suit ini.')
  if (!choices.includes(choice)) return send(ctx, `❌ Pilihan tidak valid. Gunakan batu, gunting, atau kertas.`)
  if (room.choices[ctx.m.sender]) return send(ctx, '❌ Kamu sudah memilih. Tunggu lawan.')
  room.choices[ctx.m.sender] = choice
  const ready = room.players.every(p => room.choices[p])
  if (!ready) {
    room.updatedAt = now()
    saveDb()
    return send(ctx, '✅ Pilihanmu tersimpan. Menunggu pilihan lawan...')
  }

  const [a, b] = room.players
  const result = compareSuit(room.choices[a], room.choices[b])
  let text = `✊ *HASIL SUIT*\n\n${mention(a)}: ${room.choices[a]}\n${mention(b)}: ${room.choices[b]}\n\n`
  if (result === 'draw') {
    addStat(a, 'suit', 'draw', 75)
    addStat(b, 'suit', 'draw', 75)
    text += '🤝 *SERI!*\nKeduanya mendapatkan +75 coin.'
  } else {
    const winner = result === 'a' ? a : b
    const loser = result === 'a' ? b : a
    addStat(winner, 'suit', 'win', 150)
    addStat(loser, 'suit', 'loss', 50)
    text += `🏆 ${mention(winner)} menang!\n\n🎁 +150 coin untuk pemenang\n🎁 +50 coin untuk lawan`
  }
  deleteRoom(key)
  saveDb()
  return send(ctx, text, { mentions: [a, b] })
}

async function cmdConnect4(ctx) {
  const key = gameRoom(ctx.m.chat, 'connect4')
  let room = getRoom(key)
  const move = Number(ctx.args?.[0])
  const target = parseMentionTarget(ctx.m, ctx.args || [])

  if (!room) {
    if (!target || target === ctx.m.sender) {
      return send(ctx, `🟡🔴 *CONNECT 4*\n\nGunakan: ${ctx.prefix}connect4 @user\n\nMasuk ke giliranmu dengan:\n${ctx.prefix}connect4 1-7`)
    }
    room = setRoom(key, {
      game: 'connect4',
      players: [ctx.m.sender, target],
      tokens: { [ctx.m.sender]: 'R', [target]: 'Y' },
      board: Array(42).fill(null),
      turn: ctx.m.sender,
      createdAt: now()
    })
    saveDb()
    return send(ctx, `🟡🔴 *CONNECT 4*\n\n🔴 ${mention(ctx.m.sender)} vs 🟡 ${mention(target)}\n\n${renderConnect4(room.board)}\n\nGiliran: ${mention(room.turn)}\nKetik *${ctx.prefix}connect4 1-7*.`, {
      mentions: [ctx.m.sender, target, room.turn]
    })
  }

  if (!room.players.includes(ctx.m.sender)) return send(ctx, '❌ Kamu bukan pemain di room Connect 4 ini.')
  if (ctx.m.sender !== room.turn) return send(ctx, `⏳ Giliran ${mention(room.turn)}.`, { mentions: [room.turn] })
  if (!Number.isInteger(move) || move < 1 || move > 7) return send(ctx, '❌ Kolom harus 1-7.')

  const col = move - 1
  let placedIndex = -1
  for (let row = 5; row >= 0; row--) {
    const idx = row * 7 + col
    if (!room.board[idx]) {
      placedIndex = idx
      break
    }
  }
  if (placedIndex === -1) return send(ctx, '❌ Kolom itu penuh.')

  room.board[placedIndex] = room.tokens[ctx.m.sender]
  const token = room.tokens[ctx.m.sender]
  const board = renderConnect4(room.board)
  if (checkConnect4(room.board, token)) {
    const winner = ctx.m.sender
    const loser = room.players.find(p => p !== winner)
    addStat(winner, 'connect4', 'win', 250)
    addStat(loser, 'connect4', 'loss', 60)
    deleteRoom(key)
    saveDb()
    return send(ctx, `🏆 *${mention(winner)} MENANG CONNECT 4!*\n\n${board}\n\n🎁 Pemenang +250 coin`, { mentions: [winner, loser] })
  }
  if (room.board.every(Boolean)) {
    room.players.forEach(p => addStat(p, 'connect4', 'draw', 100))
    deleteRoom(key)
    saveDb()
    return send(ctx, `🤝 *CONNECT 4 SERI!*\n\n${board}\n\n🎁 Masing-masing +100 coin.`)
  }

  room.turn = room.players.find(p => p !== ctx.m.sender)
  room.updatedAt = now()
  saveDb()
  return send(ctx, `🟡🔴 *CONNECT 4*\n\n${board}\n\nGiliran: ${mention(room.turn)}`, { mentions: [room.turn] })
}

async function cmdGuessNumber(ctx) {
  const key = gameRoom(`${ctx.m.chat}:${ctx.m.sender}`, 'guess')
  let room = getRoom(key)
  const guess = Number(ctx.args?.[0])

  if (!room) {
    room = setRoom(key, {
      game: 'guess',
      player: ctx.m.sender,
      secret: randomInt(1, 100),
      attempts: 0,
      hints: [],
      createdAt: now()
    })
    saveDb()
    return send(ctx, `🔢 *TEBAK ANGKA*\n\nAku sudah memilih angka dari *1-100*.\nKetik *${ctx.prefix}tebakangka 1-100* sampai ketemu.\n\n🎯 Hadiah dasar: 120 coin.`)
  }

  if (!Number.isInteger(guess) || guess < 1 || guess > 100) return send(ctx, '❌ Tebakan harus angka 1-100.')
  room.attempts += 1
  if (guess === room.secret) {
    const reward = Math.max(60, 120 - (room.attempts - 1) * 8)
    addSoloProgress(ctx.m.sender, 'tebakangka', true, reward, 90)
    const attempts = room.attempts
    deleteRoom(key)
    saveDb()
    return send(ctx, `🎉 *BENAR!*\n\nAngkanya adalah *${guess}*.\nPercobaan: ${attempts}\n🎁 Reward: +${reward} coin`)
  }

  const diff = Math.abs(room.secret - guess)
  const hint = guess < room.secret ? '📈 Naik' : '📉 Turun'
  let temperature = diff <= 5 ? '🔥 Panas banget!' : diff <= 15 ? '🌡️ Lumayan dekat.' : '🧊 Masih jauh.'
  room.updatedAt = now()
  saveDb()
  return send(ctx, `❌ Belum tepat. *${hint}*\n${temperature}\nPercobaan ke-${room.attempts}.`)
}

async function cmdDice(ctx) {
  const sides = Math.max(2, Math.min(1000, Number(ctx.args?.[0]) || 6))
  const rolls = Math.max(1, Math.min(6, Number(ctx.args?.[1]) || 1))
  const results = Array.from({ length: rolls }, () => randomInt(1, sides))
  return send(ctx, `🎲 *DADU*\n\nSisi: ${sides}\nRoll: ${rolls}\nHasil: ${results.join(', ')}\nTotal: *${results.reduce((a,b) => a+b, 0)}*`)
}

async function cmdHighLow(ctx) {
  const key = gameRoom(`${ctx.m.chat}:${ctx.m.sender}`, 'highlow')
  let room = getRoom(key)
  const answer = String(ctx.args?.[0] || '').toLowerCase()
  if (!room) {
    room = setRoom(key, {
      game: 'highlow',
      player: ctx.m.sender,
      current: randomInt(1, 13),
      streak: 0,
      createdAt: now()
    })
    saveDb()
    return send(ctx, `🃏 *HIGH / LOW*\n\nKartu sekarang: *${room.current}*\nTebak kartu berikutnya lebih *tinggi* atau lebih *rendah*.\n\nKetik: *${ctx.prefix}highlow high* atau *${ctx.prefix}highlow low*`)
  }
  if (!['high', 'low'].includes(answer)) return send(ctx, `Gunakan *high* atau *low*.`)
  const next = randomInt(1, 13)
  const correct = (answer === 'high' && next > room.current) || (answer === 'low' && next < room.current)
  if (next === room.current) {
    room.updatedAt = now()
    saveDb()
    return send(ctx, `🃏 Kartu berikutnya juga *${next}*. Push! Coba lagi.`)
  }
  if (!correct) {
    addSoloProgress(ctx.m.sender, 'highlow', false, 0, 60)
    const old = room.current
    deleteRoom(key)
    saveDb()
    return send(ctx, `💥 *SALAH!*\n\n${old} → ${next}\nJawabanmu: ${answer}\nStreak berakhir. Coba lagi dengan *${ctx.prefix}highlow*.`)
  }
  room.current = next
  room.streak += 1
  room.updatedAt = now()
  const reward = Math.min(500, 50 + room.streak * 25)
  getPlayer(ctx.m.sender).coins += reward
  getPlayer(ctx.m.sender).xp += 40
  saveDb()
  return send(ctx, `✅ *BENAR!*\n\nKartu: ${next}\n🔥 Streak: *${room.streak}*\n🎁 +${reward} coin\n\nLanjut: *${ctx.prefix}highlow high* / *${ctx.prefix}highlow low*`)
}

async function cmdMemory(ctx) {
  const key = gameRoom(`${ctx.m.chat}:${ctx.m.sender}`, 'memory')
  let room = getRoom(key)
  if (!room) {
    const values = ['🍎','🍎','🍌','🍌','🍇','🍇','🍉','🍉'].sort(() => Math.random() - 0.5)
    room = setRoom(key, {
      game: 'memory',
      player: ctx.m.sender,
      values,
      revealed: [],
      matched: [],
      moves: 0,
      createdAt: now()
    })
    saveDb()
    return send(ctx, `🧠 *MEMORY MATCH*\n\nCari semua pasangan emoji. Pilih dua kartu per giliran.\n\n${room.values.map((_,i)=>`${i+1}️⃣ ❓`).join('  ')}\n\nGunakan: *${ctx.prefix}memory 1 2*`)
  }
  const picks = (ctx.args || []).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= room.values.length)
  if (picks.length !== 2 || picks[0] === picks[1]) return send(ctx, `❌ Pilih dua angka berbeda, contoh *${ctx.prefix}memory 2 7*.`)
  if (room.matched.includes(picks[0]-1) || room.matched.includes(picks[1]-1)) return send(ctx, '❌ Salah satu kartu sudah terbuka.')
  room.moves += 1
  const a = picks[0] - 1
  const b = picks[1] - 1
  const display = room.values.map((v,i) => room.matched.includes(i) || i === a || i === b ? v : '❓')
  if (room.values[a] === room.values[b]) {
    room.matched.push(a, b)
    room.matched = [...new Set(room.matched)]
  }
  room.updatedAt = now()
  if (room.matched.length === room.values.length) {
    const reward = Math.max(150, 350 - room.moves * 20)
    addSoloProgress(ctx.m.sender, 'memory', true, reward, 100)
    const moves = room.moves
    deleteRoom(key)
    saveDb()
    return send(ctx, `🧠 *SELESAI!*\n\nLangkah: ${moves}\n🎁 Reward: +${reward} coin`)
  }
  saveDb()
  return send(ctx, `🧠 ${display.map((v,i)=>`${i+1}️⃣ ${v}`).join('  ')}\n\n${room.values[a] === room.values[b] ? '✅ Pasangan cocok!' : '❌ Belum cocok.'}\nLangkah: ${room.moves}\nPasangan ditemukan: ${room.matched.length/2}/${room.values.length/2}`)
}

async function cmdSpeedType(ctx) {
  const key = gameRoom(`${ctx.m.chat}:${ctx.m.sender}`, 'speedtype')
  let room = getRoom(key)
  const answer = String(ctx.args?.join(' ') || '').trim()
  if (!room) {
    const word = pick(WORDS)
    const startedAt = now()
    room = setRoom(key, {
      game: 'speedtype',
      player: ctx.m.sender,
      phrase: word,
      startedAt,
      createdAt: startedAt
    })
    saveDb()
    return send(ctx, `⚡ *SPEED TYPE*\n\nKetik persis kata ini secepat mungkin:\n\n*${word}*\n\nBatas waktu: 20 detik.\nBalas dengan *${ctx.prefix}speedtype ${word}*`)
  }
  if (now() - room.startedAt > 20000) {
    addSoloProgress(ctx.m.sender, 'speedtype', false, 0, 70)
    deleteRoom(key)
    saveDb()
    return send(ctx, `⏱️ *TIME OUT!*\nKata yang benar: *${room.phrase}*`)
  }
  if (answer.toLowerCase() !== room.phrase.toLowerCase()) return send(ctx, '❌ Masih salah. Perhatikan penulisan dan kirim lagi sebelum waktu habis.')
  const seconds = (now() - room.startedAt) / 1000
  const reward = Math.max(80, Math.round(300 - seconds * 12))
  addSoloProgress(ctx.m.sender, 'speedtype', true, reward, 110)
  deleteRoom(key)
  saveDb()
  return send(ctx, `⚡ *BERHASIL!*\nWaktu: *${seconds.toFixed(2)} detik*\n🎁 Reward: +${reward} coin`)
}

function randomMath() {
  const op = pick(OPERATIONS)
  let a = randomInt(3, 25)
  let b = randomInt(2, 20)
  if (op === '×') return { text: `${a} × ${b}`, answer: a * b }
  if (op === '+') return { text: `${a} + ${b}`, answer: a + b }
  if (b > a) [a, b] = [b, a]
  return { text: `${a} - ${b}`, answer: a - b }
}

async function cmdMathBattle(ctx) {
  const key = gameRoom(`${ctx.m.chat}:${ctx.m.sender}`, 'mathbattle')
  let room = getRoom(key)
  const answer = Number(ctx.args?.[0])
  if (!room) {
    const problem = randomMath()
    room = setRoom(key, {
      game: 'mathbattle',
      player: ctx.m.sender,
      problem,
      startedAt: now(),
      createdAt: now()
    })
    saveDb()
    return send(ctx, `🧮 *MATH BATTLE*\n\nBerapa hasilnya?\n\n*${problem.text}*\n\nJawab dengan *${ctx.prefix}mathbattle angka*\nBatas waktu: 15 detik.`)
  }
  if (now() - room.startedAt > 15000) {
    addSoloProgress(ctx.m.sender, 'mathbattle', false, 0, 60)
    deleteRoom(key)
    saveDb()
    return send(ctx, `⏱️ Waktu habis. Jawaban yang benar: *${room.problem.answer}*`)
  }
  if (!Number.isFinite(answer)) return send(ctx, `❌ Masukkan angka. Contoh *${ctx.prefix}mathbattle 42*.`)
  if (answer !== room.problem.answer) {
    addSoloProgress(ctx.m.sender, 'mathbattle', false, 0, 60)
    deleteRoom(key)
    saveDb()
    return send(ctx, `❌ Salah. Jawaban yang benar: *${room.problem.answer}*`)
  }
  const reward = Math.max(70, Math.round(220 - (now() - room.startedAt) / 50))
  addSoloProgress(ctx.m.sender, 'mathbattle', true, reward, 100)
  deleteRoom(key)
  saveDb()
  return send(ctx, `✅ *BENAR!*\n🎁 +${reward} coin\n⭐ +100 XP`)
}

async function cmdStats(ctx) {
  const p = getPlayer(ctx.m.sender)
  const total = Object.values(db.players).reduce((sum, x) => sum + (Number(x.xp) || 0), 0)
  return send(ctx, `🎮 *GAME PROFILE*\n\n👤 ${mention(ctx.m.sender)}\n🎮 Games: ${p.games}\n🏆 Wins: ${p.wins}\n💔 Losses: ${p.losses}\n🤝 Draws: ${p.draws}\n🔥 Best Streak: ${p.bestStreak}\n⭐ XP: ${p.xp}\n🪙 Coin: ${p.coins}\n\n🌍 Total XP pemain: ${total}`, { mentions: [ctx.m.sender] })
}

async function cmdRank(ctx) {
  const rows = Object.entries(db.players)
    .sort((a,b) => (Number(b[1].xp)||0) - (Number(a[1].xp)||0))
    .slice(0, 10)
  if (!rows.length) return send(ctx, '🏆 Belum ada data ranking game.')
  const text = rows.map(([jid,p],i) => `${i+1}. ${mention(jid)} — ${p.xp} XP • ${p.wins}W/${p.losses}L`).join('\n')
  return send(ctx, `🏆 *GAME RANKING TOP 10*\n\n${text}`, { mentions: rows.map(([jid]) => jid) })
}

async function handle(command, ctx) {
  pruneRooms()
  const cmd = String(command || '').toLowerCase()
  switch (cmd) {
    case 'ttt': return cmdTtt(ctx)
    case 'suit': return cmdSuit(ctx)
    case 'connect4':
    case 'c4': return cmdConnect4(ctx)
    case 'tebakangka': return cmdGuessNumber(ctx)
    case 'dadu': return cmdDice(ctx)
    case 'highlow': return cmdHighLow(ctx)
    case 'memory':
    case 'memorygame': return cmdMemory(ctx)
    case 'speedtype': return cmdSpeedType(ctx)
    case 'mathbattle': return cmdMathBattle(ctx)
    case 'gamestats': return cmdStats(ctx)
    case 'gamerank': return cmdRank(ctx)
    case 'gamehelp':
      return send(ctx, `🎮 *GAME CENTER*\n\n🤝 PvP\n• ${ctx.prefix}ttt @user\n• ${ctx.prefix}suit @user\n• ${ctx.prefix}connect4 @user\n\n🧠 Solo\n• ${ctx.prefix}tebakangka\n• ${ctx.prefix}dadu\n• ${ctx.prefix}highlow\n• ${ctx.prefix}memory\n• ${ctx.prefix}speedtype\n• ${ctx.prefix}mathbattle\n\n📊 Statistik\n• ${ctx.prefix}gamestats\n• ${ctx.prefix}gamerank`)
    default:
      return false
  }
}


// =========================
// LEGACY GROUP GAMES MODULE
// =========================
const LEGACY_GAMES = {
  asahotak: { file: 'asahotak.json', title: 'GAME ASAH OTAK', prompt: 'Soal', hint: true },
  tebakkata: { file: 'tebakkata.json', title: 'GAME TEBAK KATA', prompt: 'Soal', hint: true },
  tebakemoji: { file: 'tebakemoji.json', title: 'GAME TEBAK EMOJI', prompt: 'Tebak arti emoji berikut', hint: true, emoji: true },
  siapaaku: { file: 'siapaaku.json', title: 'GAME SIAPA AKU?', prompt: 'Petunjuk', hint: true },
  cepattepat: { file: 'cepattepat.json', title: 'GAME CEPAT TEPAT', prompt: '❓ Pertanyaan', hint: false },
  susunkata: { file: 'susunkata.json', title: 'GAME SUSUN KATA', prompt: 'Soal', hint: true },
  tebakgambar: { file: 'tebakgambar.json', title: 'GAME TEBAK GAMBAR', image: true, hint: true },
  tebakbendera: { file: 'tebakbendera.json', title: 'GAME TEBAK BENDERA', prompt: 'Soal', hint: true },
  tebakkimia: { file: 'tebakkimia.json', title: 'GAME TEBAK KIMIA', prompt: 'Soal', hint: true },
  family100: { file: 'family100.json', title: 'GAME FAMILY 100', family: true }
}

const legacyTimers = new Map()
let currentConnection = null

function normalizeAnswer(value) {
  return String(value || '').toLowerCase().trim()
}

function maskAnswer(value) {
  return String(value || '').replace(/[bcdfghjklmnpqrstvwxyz]/gi, '-')
}

function gameDataPath(file) {
  return path.join(__dirname, 'database', 'games', 'legacy', file)
}

function loadJsonArray(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(gameDataPath(file), 'utf8'))
    return Array.isArray(raw) ? raw : []
  } catch (error) {
    console.error(`[GAMES DATA] ${file}:`, error.message)
    return []
  }
}

function clearLegacyTimer(key) {
  const timer = legacyTimers.get(key)
  if (timer) clearTimeout(timer)
  legacyTimers.delete(key)
}

function legacyRoomKey(chat) {
  return `${cleanJid(chat)}::legacy`
}

async function legacyTimeout(key) {
  const room = db.rooms[key]
  if (!room || room.kind !== 'legacy') return
  const conn = currentConnection
  clearLegacyTimer(key)
  delete db.rooms[key]
  saveDb()
  if (!conn) return

  let answerText
  if (room.game === 'family100') {
    answerText = (room.answers || []).map((item, i) => `${i + 1}. ${item.display}`).join('\n')
  } else {
    answerText = room.answer
  }
  const body = room.game === 'tebakgambar'
    ? `⏰ *WAKTU HABIS!*\n\nJawabannya adalah: *${answerText}*`
    : `⏰ *WAKTU HABIS!*\n\nPertanyaan:\n${room.question}\n\nJawaban: *${answerText}*`
  const quoteOptions = room.quoteMessage?.key && room.quoteMessage?.message
    ? { quoted: room.quoteMessage }
    : undefined
  await conn.sendMessage(room.chat, { text: body }, quoteOptions).catch(() => {})
}

function scheduleLegacyTimeout(key, room) {
  clearLegacyTimer(key)
  const delay = Math.max(50, Number(room.expiresAt) - now())
  legacyTimers.set(key, setTimeout(() => legacyTimeout(key), delay))
}

function restoreLegacyTimers(conn) {
  if (currentConnection === conn && legacyTimers.size > 0) return
  currentConnection = conn
  const current = now()
  for (const [key, room] of Object.entries(db.rooms)) {
    if (room?.kind !== 'legacy') continue
    if (Number(room.expiresAt) <= current) {
      legacyTimeout(key).catch(() => {})
    } else {
      scheduleLegacyTimeout(key, room)
    }
  }
}

function createLegacyRoom(chat, game, payload, sourceMessage = null) {
  const key = legacyRoomKey(chat)
  if (db.rooms[key]) return { key, room: db.rooms[key], active: true }
  // Hanya simpan key + isi pesan command yang sederhana, bukan seluruh objek m
  // (yang berisi helper/function), agar aman untuk database JSON dan timeout.
  const quoteMessage = sourceMessage?.key && sourceMessage?.message
    ? {
        key: sourceMessage.key,
        message: sourceMessage.message,
        pushName: String(sourceMessage.pushName || '')
      }
    : null
  const room = setRoom(key, {
    kind: 'legacy',
    game,
    chat,
    createdAt: now(),
    expiresAt: now() + 60 * 1000,
    ...payload,
    quoteMessage
  })
  scheduleLegacyTimeout(key, room)
  saveDb()
  return { key, room, active: false }
}

function legacyAnswerText(item) {
  return String(item?.jawaban ?? item?.answer ?? '').trim()
}

async function startLegacyGame(ctx, game) {
  if (!ctx.m.isGroup) {
    await send(ctx, '❌ Game ini hanya bisa dimainkan di grup.')
    return true
  }
  const config = LEGACY_GAMES[game]
  if (!config) return false
  const key = legacyRoomKey(ctx.m.chat)
  const active = getRoom(key)
  if (active?.kind === 'legacy') {
    return send(ctx, `⏳ *${String(active.game).toUpperCase()}* masih aktif di grup ini. Selesaikan dulu sebelum membuat game baru.`)
  }

  const dataset = loadJsonArray(config.file)
  const item = pick(dataset)
  if (!item) return send(ctx, `❌ Data game *${game}* tidak tersedia.`)

  if (config.family) {
    const raw = Array.isArray(item.jawaban) ? item.jawaban : []
    const answers = raw.map(value => {
      const aliases = String(value).split('/').map(v => v.trim()).filter(Boolean)
      return {
        display: aliases[0] || String(value).trim(),
        aliases: aliases.map(normalizeAnswer)
      }
    }).filter(v => v.display && v.aliases.length)
    const created = createLegacyRoom(ctx.m.chat, game, {
      question: String(item.soal || ''),
      answers
    }, ctx.m)
    if (created.active) return send(ctx, '⏳ Masih ada game aktif di grup ini.')
    return send(ctx, `*GAME FAMILY 100*\n\nSoal: ${created.room.question}\nTotal Jawaban: ${answers.length}\n\nWaktu: 60 detik`)
  }

  const answer = legacyAnswerText(item)
  const question = config.image ? String(item.deskripsi || '') : String(item.soal || '')
  const payload = {
    question,
    answer: normalizeAnswer(answer)
  }
  if (config.image) payload.image = String(item.img || '')

  const created = createLegacyRoom(ctx.m.chat, game, payload, ctx.m)
  if (created.active) return send(ctx, '⏳ Masih ada game aktif di grup ini.')

  if (config.image) {
    const caption = `*GAME TEBAK GAMBAR*\n\nPetunjuk: ${maskAnswer(answer)}\nDeskripsi: ${question}\nWaktu: 60 detik`
    if (payload.image) {
      await ctx.conn.sendMessage(ctx.m.chat, { image: { url: payload.image }, caption }, { quoted: ctx.m })
      return true
    }
    return send(ctx, caption)
  }

  const displayQuestion = config.emoji ? `${config.prompt}:\n\n${String(item.soal || '')}` : `${config.prompt}: ${String(item.soal || '')}`
  const hint = config.hint ? `\nPetunjuk: ${maskAnswer(answer)}` : ''
  const reward = game === 'cepattepat' ? '\n🎁 Hadiah: 20 limit' : ''
  return send(ctx, `*${config.title}*\n\n${displayQuestion}${hint}\nWaktu: 60 detik${reward}`)
}

async function processLegacyAnswer(ctx) {
  if (!ctx.m?.isGroup || ctx.m?.key?.fromMe) return false
  const key = legacyRoomKey(ctx.m.chat)
  const room = getRoom(key)
  if (!room || room.kind !== 'legacy') return false
  if (room.expiresAt <= now()) {
    await legacyTimeout(key)
    return true
  }

  const body = normalizeAnswer(ctx.body)
  if (!body || /^\./.test(String(ctx.body || '').trim())) return false

  if (room.game === 'family100') {
    let hitIndex = -1
    for (let i = 0; i < room.answers.length; i++) {
      const item = room.answers[i]
      if (item.aliases.some(alias => alias && body.includes(alias))) {
        hitIndex = i
        break
      }
    }
    if (hitIndex === -1) return false
    const hit = room.answers[hitIndex]
    room.answers.splice(hitIndex, 1)
    room.updatedAt = now()
    if (ctx.rewardLimit) ctx.rewardLimit(ctx.m.sender, 20)
    const remaining = room.answers.length
    if (remaining === 0) {
      addStat(ctx.m.sender, 'family100', 'win', 0)
      clearLegacyTimer(key)
      delete db.rooms[key]
      saveDb()
      await ctx.conn.sendMessage(ctx.m.chat, { text: `🎉 *FAMILY 100 SELESAI!*\n\nJawaban benar: ${hit.display}\n🎁 Kamu mendapatkan +20 limit.` }, { quoted: ctx.m })
      return true
    }
    saveDb()
    await ctx.conn.sendMessage(ctx.m.chat, { text: `✅ *JAWABAN DITEMUKAN!*\n\n${hit.display}\n🎁 +20 limit\n\nSisa jawaban: *${remaining}*` }, { quoted: ctx.m })
    return true
  }

  const answer = normalizeAnswer(room.answer)
  if (!answer || !body.includes(answer)) return false

  addStat(ctx.m.sender, room.game, 'win', 0)
  if (ctx.rewardLimit) ctx.rewardLimit(ctx.m.sender, 20)
  clearLegacyTimer(key)
  delete db.rooms[key]
  saveDb()
  const label = room.game === 'tebakgambar' ? '🎉 *JAWABAN BENAR!*' : '🎉 *JAWABAN KAMU BENAR!*'
  await ctx.conn.sendMessage(ctx.m.chat, {
    text: `${label}\n\n${room.question}\n\nJawaban: *${room.answer}*\n🎁 +20 limit`
  }, { quoted: ctx.m })
  return true
}

const legacyCommands = Object.keys(LEGACY_GAMES).concat(['f100', 'cepat'])

module.exports = {
  handle,
  startLegacyGameForCase: (game, ctx) => startLegacyGame(ctx, game),
  processLegacyAnswer,
  restoreLegacyTimers,
  legacyCommands,
  commands: [
    ...legacyCommands,
    'ttt','suit','connect4','c4','tebakangka','dadu','highlow',
    'memory','memorygame','speedtype','mathbattle','gamestats','gamerank','gamehelp'
  ]
}

