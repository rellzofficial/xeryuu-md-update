'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { verifyManifestSignature } = require('../library/update-signature')

test('Ed25519 manifest signature accepts exact signed bytes', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const manifest = Buffer.from('{"schemaVersion":1,"files":[]}')
  const signature = crypto.sign(null, manifest, privateKey).toString('base64')
  assert.equal(verifyManifestSignature(manifest, signature, publicKey), true)
})

test('Ed25519 manifest signature rejects modified manifest bytes', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const manifest = Buffer.from('{"schemaVersion":1,"files":[]}')
  const signature = crypto.sign(null, manifest, privateKey).toString('base64')
  assert.equal(verifyManifestSignature(Buffer.from(manifest.toString() + ' '), signature, publicKey), false)
})

test('Ed25519 manifest signature rejects malformed signatures', () => {
  assert.equal(verifyManifestSignature(Buffer.from('hello'), 'not a signature'), false)
  assert.equal(verifyManifestSignature(Buffer.alloc(0), 'AA=='), false)
})
