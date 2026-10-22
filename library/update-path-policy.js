'use strict'

const path = require('path')

const STATE_NAME = '.xeryuu-update-state.json'
const MANIFEST_NAME = '.xeryuu-update.json'
const LEGACY_BASE_DIR_NAMES = ['.xeryuu-update-base', 'xeryuu-update-base']

function normalizeRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

function isSafeDistributionPath(value) {
  const relative = normalizeRelativePath(value)
  if (!relative || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return false

  const parts = relative.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return false

  const lower = relative.toLowerCase()
  const base = parts[parts.length - 1].toLowerCase()
  if (['index.js', 'settings.js', 'authen.js', 'authen.example.js', 'qris.jpg'].includes(lower)) return false
  // Keep local credentials private regardless of the path someone tries to publish.
  if (['settings.js', 'authen.js', 'authen.example.js'].includes(base)) return false
  if (lower.startsWith('.git/') || lower.startsWith('node_modules/')) return false
  // Test assets, signing/monitoring internals and private runtime state do not belong in buyer releases.
  if (lower.startsWith('tests/')) return false
  if (['library/integrity-monitor-core.js', 'library/integrity-notification.js', 'tests/integrity-monitor.test.js', 'tests/integrity-notification.test.js'].includes(lower)) return false
  if (lower.startsWith('connection/') || lower.startsWith('session/') || lower.startsWith('sessions/')) return false
  if (lower.startsWith('update-staging/') || lower.startsWith('update-backups/')) return false
  if (LEGACY_BASE_DIR_NAMES.some(name => lower.startsWith(`${name.toLowerCase()}/`))) return false
  if (lower === STATE_NAME || lower === MANIFEST_NAME) return false
  if (lower.startsWith('.env') || base.endsWith('.log') || base.endsWith('.pem') || base.endsWith('.key')) return false
  if (lower.startsWith('library/database/')) {
    const staticGameData = /^library\/database\/games\/(?:README\.md|legacy\/[^/]+\.json)$/i.test(relative)
    if (!staticGameData) return false
  }
  if (lower === 'library/savesaluran.json') return false
  if (lower === 'library/github-update-developer.js') return false

  const extension = path.posix.extname(relative).toLowerCase()
  const allowedExtensions = new Set([
    '.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.txt',
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp3', '.ogg', '.svg', '.yml', '.yaml'
  ])
  if (!allowedExtensions.has(extension)) return false

  const first = parts[0].toLowerCase()
  if (first === 'source' || first === 'library' || first === 'media') return true
  if (parts.length === 1) {
    return ['xeryuu.js', 'telegram.js', 'stalk-check.js', 'package.json', 'tqto.md'].includes(lower)
  }
  return false
}

module.exports = { isSafeDistributionPath }
