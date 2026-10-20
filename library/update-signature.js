'use strict'

const crypto = require('crypto')

// Public verification key only. The matching private key belongs in GitHub Actions Secrets.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASVvHxDZpLAVcMvfIygek2H64oXXx4I9AbBeu89ghJAM=
-----END PUBLIC KEY-----
`

function verifyManifestSignature(manifestBuffer, signatureText, publicKey = PUBLIC_KEY_PEM) {
    if (!Buffer.isBuffer(manifestBuffer) || !manifestBuffer.length) return false
    const encoded = String(signatureText || '').trim()
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false
    let signature
    try { signature = Buffer.from(encoded, 'base64') } catch { return false }
    if (signature.length !== 64) return false
    try {
        return crypto.verify(null, manifestBuffer, publicKey, signature)
    } catch {
        return false
    }
}

module.exports = { PUBLIC_KEY_PEM, verifyManifestSignature }
