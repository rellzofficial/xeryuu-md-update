'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { attachChannelMonitor, normalizeOwnerJid, parseSubscriberCount } = require('../library/channel-monitor');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeSocket({ channelJid, count = 10, contactStore = {} } = {}) {
  const sent = [];
  const sock = {
    ev: new EventEmitter(),
    user: { id: '6281000000000@s.whatsapp.net' },
    isConnected: true,
    contacts: contactStore,
    newsletterMetadata: async (...args) => ({ id: channelJid, name: 'Test channel', subscribers: count }),
    sendMessage: async (jid, payload) => {
      sent.push({ jid, payload });
      return { key: { id: `test-${sent.length}`, remoteJid: jid } };
    }
  };
  return { sock, sent };
}

test('normalizes owner JIDs and understands nested subscriber counts', () => {
  assert.equal(normalizeOwnerJid('628123456789'), '628123456789@s.whatsapp.net');
  assert.equal(normalizeOwnerJid('628123456789@s.whatsapp.net'), '628123456789@s.whatsapp.net');
  assert.equal(parseSubscriberCount({ data: { subscribers: { total: 25 } } }), 25);
  assert.equal(parseSubscriberCount({ data: { followersCount: 14 } }), 14);
});

test('unfollow event sends owner private detail and anonymized channel notification once', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-channel-monitor-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const channelJid = '120363400000000001@newsletter';
  const ownerJid = '6281111111111@s.whatsapp.net';
  const userJid = '6282222222222@s.whatsapp.net';
  const { sock, sent } = makeSocket({
    channelJid,
    contactStore: { [userJid]: { name: 'Unfollow Tester' } }
  });
  const monitor = attachChannelMonitor(sock, {
    channelJid,
    ownerJid,
    channelName: '¡xnalz',
    stateFile: path.join(tempDir, 'state.json'),
    pollIntervalMs: 60000
  });
  t.after(() => monitor.stop());

  await monitor.initialize();
  assert.equal(monitor.getChannelJid(), channelJid);
  sent.length = 0;

  const event = {
    id: channelJid,
    author: '6289999999999@s.whatsapp.net',
    user: userJid,
    new_role: '',
    action: 'remove'
  };
  sock.ev.emit('newsletter-participants.update', event);
  await delay(350);

  assert.equal(sent.length, 2, 'should notify owner privately and post to channel');
  const ownerNotice = sent.find(item => item.jid === ownerJid)?.payload?.text || '';
  const channelNotice = sent.find(item => item.jid === channelJid)?.payload?.text || '';
  assert.match(ownerNotice, /Peserta berhenti mengikuti/);
  assert.match(ownerNotice, /Unfollow Tester/);
  assert.match(ownerNotice, /\+6282222222222/);
  assert.match(channelNotice, /berhenti mengikuti saluran/);
  assert.doesNotMatch(channelNotice, /6282222222222/, 'phone number should not be exposed in channel');

  // Replayed protocol notifications should not duplicate alerts within the dedupe window.
  sock.ev.emit('newsletter-participants.update', event);
  await delay(30);
  assert.equal(sent.length, 2);
});

test('subscriber-count polling detects decrease when event payload has no identity', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-channel-poll-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const channelJid = '120363400000000002@newsletter';
  const ownerJid = '6281111111111@s.whatsapp.net';
  const sent = [];
  let count = 20;
  const sock = {
    ev: new EventEmitter(),
    user: { id: '6281000000000@s.whatsapp.net' },
    isConnected: true,
    newsletterMetadata: async () => ({ id: channelJid, subscribers: count }),
    sendMessage: async (jid, payload) => { sent.push({ jid, payload }); return { key: { id: String(sent.length) } }; }
  };
  const monitor = attachChannelMonitor(sock, {
    channelJid,
    ownerJid,
    channelName: 'Test channel',
    stateFile: path.join(tempDir, 'state.json'),
    pollIntervalMs: 60000
  });
  t.after(() => monitor.stop());
  await monitor.initialize();
  sent.length = 0;

  count = 17;
  await monitor.pollSubscribers('test-decrease');
  assert.equal(sent.length, 2);
  const ownerNotice = sent.find(item => item.jid === ownerJid)?.payload?.text || '';
  const channelNotice = sent.find(item => item.jid === channelJid)?.payload?.text || '';
  assert.match(ownerNotice, /20 → 17/);
  assert.match(ownerNotice, /Perkiraan peserta keluar: 3/);
  assert.match(channelNotice, /20 → 17/);
  assert.match(ownerNotice, /identitas peserta/);
});
