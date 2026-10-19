'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function sha256File(filePath) {
  try {
    return sha256Buffer(fs.readFileSync(filePath))
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    throw error
  }
}

function inspectManifest(rootDir, manifest) {
  const root = path.resolve(rootDir)
  const findings = []
  for (const [relativePath, expectedHash] of Object.entries(manifest || {})) {
    const absolutePath = path.resolve(root, relativePath)
    if (!absolutePath.startsWith(root + path.sep)) {
      findings.push({ file: String(relativePath), status: 'invalid-path' })
      continue
    }
    const actualHash = sha256File(absolutePath)
    if (!actualHash) {
      findings.push({ file: String(relativePath), status: 'missing', expectedHash, actualHash: null })
    } else if (actualHash.toLowerCase() !== String(expectedHash).toLowerCase()) {
      findings.push({ file: String(relativePath), status: 'changed', expectedHash, actualHash })
    }
  }
  return findings
}

function findSameHashFiles(rootDir, targetHash, options = {}) {
  const root = path.resolve(rootDir)
  const scanDirs = Array.isArray(options.scanDirs) && options.scanDirs.length
    ? options.scanDirs
    : ['.', 'library', 'source']
  const excluded = new Set(options.exclude || ['node_modules', 'connection', 'sessions', 'database', '.git'])
  const hits = []
  const seen = new Set()
  for (const relDir of scanDirs) {
    const dir = path.resolve(root, relDir)
    if (!dir.startsWith(root) || !fs.existsSync(dir)) continue
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      if (relDir === '.' && entry.name === 'integrity-monitor.js') continue
      if (excluded.has(entry.name)) continue
      const file = path.join(dir, entry.name)
      if (seen.has(file)) continue
      seen.add(file)
      if (sha256File(file) === targetHash) hits.push(path.relative(root, file).replace(/\\/g, '/'))
    }
  }
  return hits
}

module.exports = { sha256Buffer, sha256File, inspectManifest, findSameHashFiles }
