'use strict'

const fs = require('fs')
const path = require('path')

const GROUP_STATUS_STORE = path.join(__dirname, 'database', 'group-status.json')
const MAX_RECORDS = 100

function loadGroupStatusRecords(filePath = GROUP_STATUS_STORE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : []
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('[GROUP STATUS STORE READ]', error?.message || error)
    return []
  }
}

function saveGroupStatusRecords(records, filePath = GROUP_STATUS_STORE) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const normalized = Array.isArray(records) ? records.slice(-MAX_RECORDS) : []
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2))
  return normalized
}

function recordGroupStatus(groupJid, key, source = 'groupStatusMessage', filePath = GROUP_STATUS_STORE, details = {}) {
  const group = String(groupJid || '').trim()
  const id = String(key?.id || '').trim()
  if (!group.endsWith('@g.us') || !id) return false

  try {
    const records = loadGroupStatusRecords(filePath)
    const duplicateIndex = records.findIndex(item => item.groupJid === group && item.id === id)
    const record = {
      groupJid: group,
      remoteJid: String(key?.remoteJid || group),
      id,
      fromMe: typeof key?.fromMe === 'boolean' ? key.fromMe : true,
      participant: String(key?.participant || details.participant || ''),
      authorJid: String(details.authorJid || key?.participant || ''),
      source: String(source || 'groupStatusMessage'),
      createdAt: Number(details.createdAt) || Date.now()
    }
    if (duplicateIndex >= 0) records.splice(duplicateIndex, 1)
    records.push(record)
    saveGroupStatusRecords(records, filePath)
    return true
  } catch (error) {
    console.error('[GROUP STATUS STORE WRITE]', error?.message || error)
    return false
  }
}

function unwrapMessageContent(message) {
  let current = message
  for (let depth = 0; depth < 12 && current && typeof current === 'object'; depth++) {
    if (current.groupStatusMessageV2 || current.groupStatusMessage) return current
    const wrapperKeys = [
      'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2',
      'viewOnceMessageV2Extension', 'documentWithCaptionMessage',
      'editedMessage', 'deviceSentMessage'
    ]
    let next = null
    for (const key of wrapperKeys) {
      const candidate = current[key]?.message
      if (candidate && typeof candidate === 'object') {
        next = candidate
        break
      }
    }
    if (!next) break
    current = next
  }
  return null
}

function getStatusAuthorJid(message) {
  const root = unwrapMessageContent(message?.message)
  const status = root?.groupStatusMessageV2 || root?.groupStatusMessage
  const payload = status?.message || {}
  const queue = [payload]
  const seen = new Set()
  while (queue.length) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const context = current.contextInfo
    const attributions = context?.statusAttributions
    if (Array.isArray(attributions)) {
      for (const attribution of attributions) {
        const authorJid = attribution?.groupStatus?.authorJid || attribution?.authorJid
        if (typeof authorJid === 'string' && authorJid.includes('@')) return authorJid
      }
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return String(message?.key?.participant || '')
}

function recordIncomingGroupStatusMessage(message, filePath = GROUP_STATUS_STORE) {
  const key = message?.key
  const groupJid = String(key?.remoteJid || '')
  if (!groupJid.endsWith('@g.us') || !key?.id) return false
  const content = unwrapMessageContent(message?.message)
  if (!content) return false

  const authorJid = getStatusAuthorJid(message)
  const participant = String(key.participant || authorJid || '')
  return recordGroupStatus(
    groupJid,
    { ...key, remoteJid: groupJid, participant, fromMe: Boolean(key.fromMe) },
    key.fromMe ? 'incoming-group-status-own' : 'incoming-group-status-other',
    filePath,
    { participant, authorJid }
  )
}

function findLatestGroupStatusRecord(records, groupJid) {
  const group = String(groupJid || '')
  for (let index = (Array.isArray(records) ? records.length : 0) - 1; index >= 0; index--) {
    const record = records[index]
    if (record?.groupJid === group && record?.id) return { record, index }
  }
  return { record: null, index: -1 }
}

module.exports = {
  GROUP_STATUS_STORE,
  loadGroupStatusRecords,
  saveGroupStatusRecords,
  recordGroupStatus,
  recordIncomingGroupStatusMessage,
  findLatestGroupStatusRecord,
  unwrapMessageContent
}
