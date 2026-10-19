'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const core = require('../library/integrity-monitor-core.js')

test('SHA-256 manifest detects changed and missing files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-integrity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'index.js'), 'official')
  fs.writeFileSync(path.join(root, 'settings.js'), 'settings')
  const officialHash = core.sha256File(path.join(root, 'index.js'))
  assert.match(officialHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(core.inspectManifest(root, { 'index.js': officialHash, 'settings.js': core.sha256File(path.join(root, 'settings.js')) }), [])

  fs.writeFileSync(path.join(root, 'index.js'), 'replaced')
  fs.unlinkSync(path.join(root, 'settings.js'))
  const findings = core.inspectManifest(root, { 'index.js': officialHash, 'settings.js': '0'.repeat(64) })
  assert.deepEqual(findings.map(item => [item.file, item.status]), [['index.js', 'changed'], ['settings.js', 'missing']])
})

test('manifest rejects paths escaping the project root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-integrity-path-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const findings = core.inspectManifest(root, { '../outside.js': '0'.repeat(64) })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'invalid-path')
})

test('rename search finds same-content JavaScript without entering excluded folders', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xeryuu-integrity-rename-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'library'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'example'), { recursive: true })
  fs.writeFileSync(path.join(root, 'renamed-entry.js'), 'same-source')
  fs.writeFileSync(path.join(root, 'library', 'copy.js'), 'same-source')
  fs.writeFileSync(path.join(root, 'node_modules', 'example', 'hidden.js'), 'same-source')
  const hash = core.sha256File(path.join(root, 'renamed-entry.js'))
  assert.deepEqual(core.findSameHashFiles(root, hash).sort(), ['library/copy.js', 'renamed-entry.js'])
})
