'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const extras = require('../library/xeryuu-extras.js')

test('school response normalizer handles documented data arrays', () => {
  const rows = extras.extractSchoolRecords({ status: 'success', data: [{ npsn: '12345678', nama: 'SMAN 1 Contoh' }] })
  assert.equal(rows.length, 1)
  const school = extras.normalizeSchoolRecord(rows[0])
  assert.equal(school.npsn, '12345678')
  assert.equal(school.name, 'SMAN 1 Contoh')
})

test('school response normalizer handles common wrapped records without fabricating data', () => {
  assert.equal(extras.extractSchoolRecords({ error: 'not found' }).length, 0)
  const rows = extras.extractSchoolRecords({ data: { satuanPendidikan: { npsn: '87654321', nama: 'SD Contoh' } } })
  assert.equal(rows.length, 1)
  assert.equal(extras.normalizeSchoolRecord(rows[0]).name, 'SD Contoh')
})

test('text normalization strips control characters and limits length', () => {
  assert.equal(extras.compact('  Halo\n dunia\u0000  '), 'Halo dunia')
  assert.equal(extras.compact('a'.repeat(20), 8).length, 8)
})
