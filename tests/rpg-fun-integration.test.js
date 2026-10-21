'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
    handle,
    evaluateMath,
    stableDailyPrice,
    getCommandNames
} = require('../library/rpg-fun-integration.js')

function makeContext(options = {}) {
    const jid = options.jid || 'user@s.whatsapp.net'
    let balance = Number(options.balance || 0)
    let saveCount = 0
    const sent = []
    const existingUser = {
        rpg: options.rpg !== false,
        bank: 250,
        stamina: 100,
        darahuser: 100,
        ...(options.user || {})
    }
    global.db = { erpg: { [jid]: existingUser } }
    const ctx = {
        m: {
            sender: jid,
            chat: options.chat || jid,
            mentionedJid: options.mentionedJid || [],
            quoted: options.quoted || null,
            pushName: 'Test User'
        },
        conn: {
            getName: async jidValue => jidValue.split('@')[0],
            sendMessage: async (chat, payload, sendOptions) => {
                sent.push({ chat, payload, sendOptions })
                return { key: { id: `msg-${sent.length}` } }
            }
        },
        args: options.args || [],
        text: options.text || '',
        prefix: '.',
        economy: {
            getBalance: () => balance,
            addMoney: (_jid, amount) => { balance = Math.max(0, balance + Number(amount || 0)) },
            formatMoney: value => Math.round(Number(value || 0)).toLocaleString('id-ID')
        },
        reply: async (text, sendOptions = {}) => {
            sent.push({ chat: options.chat || jid, payload: { text }, sendOptions })
            return { key: { id: `reply-${sent.length}` } }
        },
        saveGlobalDb: () => { saveCount++ }
    }
    return {
        ctx,
        sent,
        getBalance: () => balance,
        getSaveCount: () => saveCount,
        user: () => global.db.erpg[jid]
    }
}

test('safe math parser evaluates arithmetic but never executes code', () => {
    assert.deepEqual(evaluateMath('(12 + 8) * 3 / 2'), { value: 30 })
    assert.deepEqual(evaluateMath('-5 + 2 * 3'), { value: 1 })
    assert.match(evaluateMath('1 / 0').error, /nol/i)
    assert.ok(evaluateMath('process.exit()').error)
    assert.ok(evaluateMath('9 ** 9 ** 9').error)
})

test('RPG pinjol is virtual, capped, persisted, and blocks duplicate outstanding loans', async () => {
    const env = makeContext({ balance: 1000 })
    env.ctx.args = ['10000']
    assert.equal(await handle('pinjol', env.ctx), true)
    assert.equal(env.getBalance(), 11000)
    assert.equal(env.user().loanRpg.principal, 10000)
    assert.equal(env.user().loanRpg.totalDue, 11000)
    assert.ok(env.getSaveCount() >= 1)

    env.ctx.args = ['5000']
    await handle('pinjol', env.ctx)
    assert.equal(env.user().loanRpg.principal, 10000)
    assert.ok(env.sent.at(-1).payload.text.includes('Lunasi pinjaman sebelumnya'))

    env.ctx.args = ['bayar', 'all']
    await handle('pinjol', env.ctx)
    assert.equal(env.getBalance(), 0)
    assert.equal(env.user().loanRpg.totalDue, 0)
    assert.equal(env.user().loanRpg.principal, 0)
})

test('RPG crypto uses virtual VGA, a cooldown, and virtual-only balances', async () => {
    const env = makeContext({ balance: 100000 })
    env.ctx.args = ['2']
    await handle('belivga', env.ctx)
    assert.equal(env.getBalance(), 70000)
    assert.equal(env.user().vga, 2)

    env.ctx.args = []
    await handle('nambangkripto', env.ctx)
    assert.ok(env.user().crypto >= 2)
    assert.ok(env.user().cryptoMinedAt > Date.now())
    const mined = env.user().crypto

    env.ctx.args = ['all']
    await handle('jualkripto', env.ctx)
    assert.equal(env.user().crypto, 0)
    assert.ok(env.getBalance() > 70000)
    assert.ok(env.sent.some(item => item.payload.text?.includes('bukan harga pasar')))
    assert.ok(mined > 0)
})

test('RPG class can be chosen once and stats report only the virtual profile', async () => {
    const env = makeContext({ balance: 25000 })
    env.ctx.args = ['penambang']
    await handle('pilihclass', env.ctx)
    assert.equal(env.user().classRpg, 'penambang')
    env.ctx.args = ['petani']
    await handle('pilihclass', env.ctx)
    assert.equal(env.user().classRpg, 'penambang')
    env.ctx.args = []
    await handle('mystats', env.ctx)
    assert.ok(env.sent.at(-1).payload.text.toLowerCase().includes('saldo virtual'))
})

test('math/fun commands return a proper handled result', async () => {
    const env = makeContext({ text: '2 + 3 * 4', args: ['2', '+', '3', '*', '4'] })
    assert.equal(await handle('math', env.ctx), true)
    assert.ok(env.sent.at(-1).payload.text.includes('14'))

    env.ctx.text = 'Kopi | Teh'
    env.ctx.args = ['Kopi', '|', 'Teh']
    assert.equal(await handle('pick', env.ctx), true)
    assert.ok(env.sent.at(-1).payload.text.includes('PILIHAN RANDOM'))
})

test('previously disabled arcade games are routed to working virtual-only handlers', async () => {
    const cases = [
        ['rr', [], /RODA ANGKA/i],
        ['sabung', [], /SABUNG SKOR VIRTUAL/i],
        ['bomb', [], /PUZZLE UBIN/i],
        ['lotre', ['status'], /Lotre sedang tidak aktif/i],
        ['poker3', [], /POKER 3 KARTU/i],
        ['hilo', [], /HI-LO/i]
    ]
    for (const [command, args, expected] of cases) {
        const env = makeContext({ balance: 10000, chat: 'test-group@g.us' })
        env.ctx.m.isGroup = true
        env.ctx.args = args
        assert.equal(await handle(command, env.ctx), true, `${command} should be handled`)
        assert.match(env.sent.at(-1).payload.text, expected)
        assert.doesNotMatch(env.sent.at(-1).payload.text, /dinonaktifkan|tidak diaktifkan/i)
    }

    for (const command of ['heist', 'begal']) {
        const env = makeContext({ balance: 10000 })
        assert.equal(await handle(command, env.ctx), true, `${command} should be handled`)
        assert.match(env.sent.at(-1).payload.text, /MISI RPG/i)
        assert.match(env.sent.at(-1).payload.text, /saldo virtual/i)
    }
})

test('lotre virtual raffle opens, accepts tickets, and cancels with refunds', async () => {
    const env = makeContext({ balance: 20000, chat: 'test-group@g.us' })
    env.ctx.m.isGroup = true
    env.ctx.isAdmin = true
    env.ctx.args = ['open', '1000']
    assert.equal(await handle('lotre', env.ctx), true)
    assert.match(env.sent.at(-1).payload.text, /LOTRE DIBUKA/i)
    assert.equal(env.getBalance(), 20000)

    env.ctx.args = ['buy', '2']
    await handle('lotre', env.ctx)
    assert.equal(env.getBalance(), 18000)
    assert.match(env.sent.at(-1).payload.text, /TIKET LOTRE DIBELI/i)

    env.ctx.args = ['cancel']
    await handle('lotre', env.ctx)
    assert.equal(env.getBalance(), 20000)
    assert.match(env.sent.at(-1).payload.text, /dibatalkan/i)
})

test('Hi-Lo can start and safely cash out the virtual stake', async () => {
    const env = makeContext({ balance: 5000, chat: 'hilo-group@g.us' })
    env.ctx.args = ['start', '1000']
    assert.equal(await handle('hilo', env.ctx), true)
    assert.equal(env.getBalance(), 4000)
    assert.match(env.sent.at(-1).payload.text, /HI-LO DIMULAI/i)
    env.ctx.args = ['take']
    await handle('hilo', env.ctx)
    assert.equal(env.getBalance(), 5000)
    assert.match(env.sent.at(-1).payload.text, /HI-LO SELESAI/i)
})

test('Furina-style group percentage checks work for gaycheck and both lesbian aliases', async () => {
    for (const command of ['gaycheck', 'lesbiancheck', 'lesbicheck', 'awesomecheck', 'greatcheck', 'cutecheck', 'prettycheck', 'lovelycheck', 'uglycheck']) {
        const env = makeContext({
            chat: 'fun-group@g.us',
            text: '@123456789',
            mentionedJid: ['123456789@s.whatsapp.net']
        })
        env.ctx.m.isGroup = true
        env.ctx.body = `.${command} @123456789`
        assert.equal(await handle(command, env.ctx), true, `${command} should be handled`)
        const sent = env.sent.at(-1)
        assert.match(sent.payload.text, /Question :/i, `${command} should return Furina-style question output`)
        assert.match(sent.payload.text, /Checker : @123456789/)
        assert.match(sent.payload.text, /Answer : (?:100|[1-9]?\d)%/)
        assert.deepEqual(sent.payload.mentions, ['123456789@s.whatsapp.net'])
        assert.doesNotMatch(sent.payload.text, /tidak bisa diketahui|tanpa skor|dinonaktifkan/i)
    }
})

test('Furina bare checks and handsomecheck return working percentages', async () => {
    for (const command of ['stupidcheck', 'uncleancheck', 'hotcheck', 'smartcheck', 'evilcheck', 'dogcheck', 'coolcheck', 'waifucheck']) {
        const env = makeContext()
        assert.equal(await handle(command, env.ctx), true, `${command} should be handled`)
        assert.match(env.sent.at(-1).payload.text, /^(?:100|[1-9]?\d)$/)
    }

    const env = makeContext({ text: '@222222222', mentionedJid: ['222222222@s.whatsapp.net'] })
    assert.equal(await handle('handsomecheck', env.ctx), true)
    assert.match(env.sent.at(-1).payload.text, /Name : @222222222/)
    assert.match(env.sent.at(-1).payload.text, /Answer : \*(?:100|[1-9]?\d)%\*/)
    assert.deepEqual(env.sent.at(-1).payload.mentions, ['222222222@s.whatsapp.net'])

    const noInput = makeContext()
    assert.equal(await handle('handsomecheck', noInput.ctx), true)
    assert.match(noInput.sent.at(-1).payload.text, /Tag Someone/)
})

test('legacy cekgay and ceklesbi helpers return a percentage instead of a blocker message', () => {
    const funMenu = require('../library/funmenu.js')
    assert.match(funMenu.scoreCheck('cekgay', 'Tester'), /^(?:100|[1-9]?\d)%$/)
    assert.match(funMenu.scoreCheck('ceklesbi', 'Tester'), /^(?:100|[1-9]?\d)%$/)
})

test('anime reaction uses the sticker sender when the WhatsApp connection supports it', async () => {
    const env = makeContext()
    const originalFetch = global.fetch
    const stickers = []
    env.ctx.conn.sendImageAsSticker = async (...args) => { stickers.push(args) }
    global.fetch = async url => {
        assert.match(String(url), /api\.waifu\.pics\/sfw\/hug$/)
        return { ok: true, json: async () => ({ url: 'https://cdn.example.test/hug.gif' }) }
    }
    try {
        assert.equal(await handle('hug', env.ctx), true)
        assert.equal(stickers.length, 1)
        assert.equal(stickers[0][0], env.ctx.m.chat)
        assert.equal(stickers[0][1], 'https://cdn.example.test/hug.gif')
        assert.equal(env.sent.length, 0)
    } finally {
        global.fetch = originalFetch
    }
})

test('previously blocked Furina reaction aliases now route to working SFW media handlers', async () => {
    const env = makeContext()
    const originalFetch = global.fetch
    const urls = []
    global.fetch = async url => {
        const requested = String(url)
        urls.push(requested)
        let data
        if (requested.includes('waifu.im/images')) data = { images: [{ url: 'https://cdn.example.test/foxgirl.jpg' }] }
        else if (requested.endsWith('/feed')) data = { results: [{ url: 'https://cdn.example.test/feed.jpg' }] }
        else if (requested.endsWith('/bonk')) data = { url: 'https://cdn.example.test/bonk.jpg' }
        else if (requested.endsWith('/lick')) data = { url: 'https://cdn.example.test/lick.jpg' }
        else if (requested.endsWith('/neko')) data = { url: 'https://cdn.example.test/neko.jpg' }
        else if (requested.endsWith('/avatar')) data = { url: 'https://cdn.example.test/avatar.jpg' }
        else if (requested.includes('/endpoints')) data = { feed: 'https://nekos.best/api/v2/feed' }
        else throw new Error(`Unexpected test URL: ${requested}`)
        return { ok: true, json: async () => data }
    }
    try {
        for (const [command, expectedUrl] of [
            ['lick', 'https://cdn.example.test/lick.jpg'],
            ['spank', 'https://cdn.example.test/bonk.jpg'],
            ['funfeed', 'https://cdn.example.test/feed.jpg'],
            ['foxgirl', 'https://cdn.example.test/foxgirl.jpg'],
            ['avatar', 'https://cdn.example.test/avatar.jpg']
        ]) {
            assert.equal(await handle(command, env.ctx), true, `${command} should be handled`)
            assert.equal(env.sent.at(-1).payload.image.url, expectedUrl, `${command} should send its fetched image`)
        }
        assert.ok(urls.length >= 5)
    } finally {
        global.fetch = originalFetch
    }
})

test('fitnah preserves Furina V18 three-part format for a manually entered phone number', async () => {
    const env = makeContext({ chat: 'group@g.us', isGroup: true, text: 'pesan target|pesan saya|6281234567890' })
    env.ctx.m.isGroup = true
    assert.equal(await handle('fitnah', env.ctx), true)
    const sent = env.sent.at(-1)
    assert.equal(sent.chat, 'group@g.us')
    assert.equal(sent.payload.text, 'pesan saya')
    assert.equal(sent.sendOptions.quoted.key.fromMe, false)
    assert.equal(sent.sendOptions.quoted.key.participant, '6281234567890@s.whatsapp.net')
    assert.equal(sent.sendOptions.quoted.key.remoteJid, 'group@g.us')
    assert.equal(sent.sendOptions.quoted.message.conversation, 'pesan target')
})

test('fitnah uses the actual tagged JID from message metadata instead of the phone text (LID support)', async () => {
    const env = makeContext({
        chat: 'group@g.us', isGroup: true,
        text: 'pesan target|pesan saya|@156191384666323',
        mentionedJid: ['111111111@s.whatsapp.net', '156191384666323@s.whatsapp.net']
    })
    env.ctx.m.isGroup = true
    env.ctx.m.metadata = {
        participants: [{
            id: '222222222@lid',
            lid: '222222222@lid',
            phoneNumber: '156191384666323@s.whatsapp.net'
        }]
    }
    // The first mention belongs to the preceding text; the final one is the target.
    // Metadata maps that PN to the participant's actual group LID.
    env.ctx.text = '@111111111|pesan saya|@156191384666323'
    assert.equal(await handle('fitnah', env.ctx), true)
    const sent = env.sent.at(-1)
    assert.equal(sent.sendOptions.quoted.key.participant, '222222222@lid')
    assert.equal(sent.sendOptions.quoted.key.participantAlt, '156191384666323@s.whatsapp.net')
    assert.equal(sent.sendOptions.quoted.key.remoteJid, 'group@g.us')
})

test('fitnah shows Furina V18 usage when any of the three fields is missing', async () => {
    const env = makeContext({ text: 'pesan target|pesan saya' })
    assert.equal(await handle('fitnah', env.ctx), true)
    assert.equal(env.sent.at(-1).payload.text, 'Example : .fitnah pesan target|pesan mu|nomor/tag target')
})

test('daily virtual-token rate remains a positive bounded value', () => {
    const rate = stableDailyPrice()
    assert.ok(Number.isInteger(rate) && rate >= 250 && rate <= 2000)
    assert.ok(getCommandNames().includes('nambangkripto'))
    assert.ok(getCommandNames().includes('fitnah'))
    for (const command of ['gaycheck', 'lesbiancheck', 'lesbicheck', 'lick', 'spank', 'feed', 'funfeed', 'avatar', 'foxgirl', 'tickle']) {
        assert.ok(getCommandNames().includes(command), `${command} must be registered`)
    }
})

test('SFW image action validates the category and sends only a safe HTTPS result', async () => {
    const env = makeContext()
    const originalFetch = global.fetch
    let requestCount = 0
    global.fetch = async url => {
        requestCount++
        assert.match(String(url), /api\.waifu\.pics\/sfw\/hug$/)
        return { ok: true, json: async () => ({ url: 'https://cdn.example.test/hug.jpg' }) }
    }
    try {
        assert.equal(await handle('hug', env.ctx), true)
        assert.equal(requestCount, 1)
        assert.equal(env.sent.at(-1).payload.image.url, 'https://cdn.example.test/hug.jpg')
        assert.match(env.sent.at(-1).payload.caption, /PELUKAN PERSAHABATAN/i)
    } finally {
        global.fetch = originalFetch
    }
})
