'use strict'

const crypto = require('crypto')
const fs = require('fs')

const manifestPath = '.xeryuu-update.json'
const signaturePath = '.xeryuu-update.sig'

function main() {
    const privateKey = process.env.INTEGRITY_SIGNING_PRIVATE_KEY

    if (!privateKey) {
        throw new Error('Secret SIGNING_PRIVATE_KEY belum tersedia.')
    }

    if (!fs.existsSync(manifestPath)) {
        throw new Error('File manifest tidak ditemukan.')
    }

    const manifest = fs.readFileSync(manifestPath)

    if (!manifest.length) {
        throw new Error('File manifest kosong.')
    }

    const signature = crypto.sign(
        null,
        manifest,
        privateKey.replace(/\\n/g, '\n')
    )

    fs.writeFileSync(
        signaturePath,
        signature.toString('base64') + '\n'
    )

    console.log('Manifest berhasil ditandatangani.')
}

try {
    main()
} catch (error) {
    console.error(`Gagal menandatangani manifest: ${error.message}`)
    process.exit(1)
                        }
