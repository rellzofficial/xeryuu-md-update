'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
    timestampToSeconds,
    getMessageTimestampSeconds,
    isDirectChatJid,
    isCommandCandidate,
    shouldProcessLiveAppendMessage,
    shouldAllowAppendFallback
} = require('../source/upsert-policy')

test('normalizes common Baileys timestamp representations', () => {
    assert.equal(timestampToSeconds(1_800_000_000), 1_800_000_000)
    assert.equal(timestampToSeconds(1_800_000_000_000), 1_800_000_000)
    assert.equal(timestampToSeconds({ low: 1_800_000_000, high: 0 }), 1_800_000_000)
    assert.equal(getMessageTimestampSeconds({ messageTimestamp: { toNumber: () => 1_800_000_000 } }), 1_800_000_000)
    assert.equal(getMessageTimestampSeconds({}), 0)
})

test('recognizes WhatsApp regular, Business, PN, LID and future direct-user chat JIDs', () => {
    for (const jid of [
        '628123456789@s.whatsapp.net',
        '628123456789@c.us',
        'abc123@lid',
        'abc123@hosted.lid',
        'abc123@hosted',
        'future-user@new-direct-domain'
    ]) {
        assert.equal(isDirectChatJid(jid), true, `${jid} should be a direct chat`)
    }
    for (const jid of ['120363000000@g.us', 'status@broadcast', '123@newsletter', '0@broadcast', '']) {
        assert.equal(isDirectChatJid(jid), false, `${jid} should not be a direct chat`)
    }
})

test('recognizes private aliases and configured group prefixes', () => {
    assert.equal(isCommandCandidate('menu', '628123456789@s.whatsapp.net'), true)
    assert.equal(isCommandCandidate('help', 'abc123@lid'), true)
    assert.equal(isCommandCandidate('help', 'abc123@hosted'), true)
    assert.equal(isCommandCandidate('halo', '628123456789@s.whatsapp.net'), false)
    assert.equal(isCommandCandidate('!store', '120363000000@g.us', '!'), true)
    assert.equal(isCommandCandidate('x!store', '120363000000@g.us', 'x!'), true)
    assert.equal(isCommandCandidate('menu', '120363000000@g.us'), false)
    assert.equal(isCommandCandidate('menu', '123@newsletter'), false)
})

test('permits only recent command append events created after socket open', () => {
    const now = Math.floor(Date.now() / 1000)
    const socketOpenedAt = now - 5
    const liveMessage = {
        key: { remoteJid: '628123456789@s.whatsapp.net', id: 'live-1' },
        messageTimestamp: now - 2
    }
    assert.equal(shouldProcessLiveAppendMessage(liveMessage, socketOpenedAt, '.menu'), true)
    assert.equal(shouldProcessLiveAppendMessage(liveMessage, 0, '.menu'), false)
    assert.equal(shouldProcessLiveAppendMessage({ ...liveMessage, messageTimestamp: socketOpenedAt - 1 }, socketOpenedAt, '.menu'), false)
    assert.equal(shouldProcessLiveAppendMessage({ key: liveMessage.key }, socketOpenedAt, '.menu'), false)
    assert.equal(shouldProcessLiveAppendMessage(liveMessage, socketOpenedAt, 'just chatting'), false)
})

test('accepts a same-ID append fallback only when the first event was not a command', () => {
    assert.equal(shouldAllowAppendFallback({ upsertType: 'notify', isCommand: false }, 'append', true), true)
    assert.equal(shouldAllowAppendFallback({ upsertType: 'notify', isCommand: true }, 'append', true), false)
    assert.equal(shouldAllowAppendFallback({ upsertType: 'append', isCommand: false }, 'append', true), false)
    assert.equal(shouldAllowAppendFallback({ upsertType: 'notify', isCommand: false }, 'notify', true), false)
    assert.equal(shouldAllowAppendFallback({ upsertType: 'notify', isCommand: false }, 'append', false), false)
})
