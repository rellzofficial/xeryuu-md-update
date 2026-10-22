'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const manifestPath = path.join(root, '.xeryuu-update.json')
const signaturePath = path.join(root, '.xeryuu-update.sig')
const keyText = String(process.env.INTEGRITY_SIGNING_PRIVATE_KEY || '').replace(/\r\n/g, '\n').trim()

// Keep this public key synchronized with library/update-signature.js.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASVvHxDZpLAVcMvfIygek2H64oXXx4I9AbBeu89ghJAM=
-----END PUBLIC KEY-----`

if (!keyText) {
  console.error('Missing GitHub Actions secret INTEGRITY_SIGNING_PRIVATE_KEY.')
  process.exit(1)
}
if (!fs.existsSync(manifestPath)) {
  console.error('Manifest .xeryuu-update.json was not found.')
  process.exit(1)
}

const manifestBytes = fs.readFileSync(manifestPath)
let manifest
try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch {
  console.error('Manifest is not valid JSON.')
  process.exit(1)
}
if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
  console.error('Manifest schemaVersion/files are invalid.')
  process.exit(1)
}
for (const entry of manifest.files) {
  if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || '')) || !Number.isFinite(Number(entry.size))) {
    console.error('Manifest contains an invalid file entry.')
    process.exit(1)
  }
}

let privateKey
try { privateKey = crypto.createPrivateKey(keyText) } catch {
  console.error('INTEGRITY_SIGNING_PRIVATE_KEY is not a valid PEM private key.')
  process.exit(1)
}
if (privateKey.asymmetricKeyType !== 'ed25519') {
  console.error('Signing key must be an Ed25519 private key.')
  process.exit(1)
}

let expectedPublicKey
let derivedPublicKey
try {
  expectedPublicKey = crypto.createPublicKey(PUBLIC_KEY_PEM)
  derivedPublicKey = crypto.createPublicKey(privateKey)
} catch {
  console.error('Could not load the Ed25519 public key.')
  process.exit(1)
}

const expectedDer = expectedPublicKey.export({ type: 'spki', format: 'der' })
const derivedDer = derivedPublicKey.export({ type: 'spki', format: 'der' })
if (!expectedDer.equals(derivedDer)) {
  console.error('Signing key mismatch: private key does not match the updater public key.')
  process.exit(1)
}

const signatureBuffer = crypto.sign(null, manifestBytes, privateKey)
if (!crypto.verify(null, manifestBytes, expectedPublicKey, signatureBuffer)) {
  console.error('Signature self-verification failed.')
  process.exit(1)
}

fs.writeFileSync(signaturePath, signatureBuffer.toString('base64') + '\n', { mode: 0o644 })
console.log(`Signed ${manifest.files.length} manifest entries with Ed25519.`)
console.log('Public key matches updater configuration.')
console.log('Signature self-verification passed.')
