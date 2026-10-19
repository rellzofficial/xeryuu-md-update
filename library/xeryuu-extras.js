'use strict'

function getAxios() { return require('axios') }

const MAX_TEXT = 2400

function compact(value, max = 180) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function extractSchoolRecords(body) {
  if (Array.isArray(body)) return body
  if (!body || typeof body !== 'object') return []
  const candidates = [body.data, body.results, body.result, body.records, body.items, body.sekolah]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate
    if (candidate && typeof candidate === 'object') {
      if (candidate.satuanPendidikan && typeof candidate.satuanPendidikan === 'object') return [candidate.satuanPendidikan]
      if (Array.isArray(candidate.items)) return candidate.items
      if (Array.isArray(candidate.results)) return candidate.results
      if (Array.isArray(candidate.data)) return candidate.data
    }
  }
  if (body.satuanPendidikan && typeof body.satuanPendidikan === 'object') return [body.satuanPendidikan]
  return []
}

function normalizeSchoolRecord(row = {}) {
  const location = row.lokasi || row.location || {}
  const coords = Array.isArray(location.koordinat) ? location.koordinat : []
  const latitude = row.latitude ?? row.lintang ?? location.lintang ?? coords[0] ?? null
  const longitude = row.longitude ?? row.bujur ?? location.bujur ?? coords[1] ?? null
  return {
    name: compact(row.nama || row.nama_sekolah || row.namaSatuanPendidikan || row.satuanPendidikan || row.name || row.nama_satuan_pendidikan || row.sekolah, 180),
    npsn: compact(row.npsn || row.NPSN || row.id_npsn, 24),
    shape: compact(row.bentuk_pendidikan || row.bentukPendidikan || row.bentuk || row.jenjang_pendidikan || row.jenjangPendidikan || row.type, 80),
    status: compact(row.status_satuan_pendidikan || row.statusSatuanPendidikan || row.status_sekolah || row.status || row.statusSatuanPendidikan, 80),
    address: compact(row.alamat_jalan || row.alamat || row.alamatJalan || row.address, 220),
    district: compact(row.nama_kecamatan || row.kecamatan || row.kec || row.namaKecamatan, 100),
    city: compact(row.nama_kabupaten || row.kabupaten || row.kabupaten_kota || row.kabupatenKota || row.kab || row.namaKabupaten, 100),
    province: compact(row.nama_provinsi || row.provinsi || row.propinsi || row.prov || row.namaProvinsi, 100),
    phone: compact(row.nomor_telepon || row.telepon || row.no_telp || row.phone, 80),
    email: compact(row.email || row.email_sekolah, 120),
    website: compact(row.website || row.situs || row.laman, 180),
    accreditation: compact(row.akreditasi, 24),
    latitude: latitude == null || latitude === '' ? null : Number(latitude),
    longitude: longitude == null || longitude === '' ? null : Number(longitude),
    updatedAt: compact(row.last_updated || row.lastUpdated || row.updated_at || row.waktu_update_data_terakhir || '', 80)
  }
}

function normalizeForSearch(value) {
  return compact(value, 500).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(sma|smp|sd|smk)\s*(negeri|swasta)?\s*/g, '$1 $2 ')
    .replace(/[^a-z0-9]+/g, ' ').trim()
}

function scoreSchool(row, query, region) {
  const queryNorm = normalizeForSearch(query)
  const regionNorm = normalizeForSearch(region)
  const name = normalizeForSearch(row.name)
  const place = normalizeForSearch([row.district, row.city, row.province, row.address].join(' '))
  let score = 0
  if (name === queryNorm) score += 100
  else if (name.includes(queryNorm)) score += 55
  const tokens = queryNorm.split(' ').filter(Boolean)
  if (tokens.length > 1) score += tokens.filter(token => name.includes(token)).length * 6
  if (regionNorm) {
    if (place.includes(regionNorm)) score += 40
    else {
      const regionTokens = regionNorm.split(' ').filter(Boolean)
      score += regionTokens.filter(token => place.includes(token)).length * 3
    }
  }
  return score
}

async function searchSchools(query, region = '') {
  const keyword = compact(query, 120)
  const place = compact(region, 100)
  if (keyword.length < 2) throw new Error('Nama sekolah atau NPSN minimal 2 karakter.')

  const candidates = []
  const failures = []
  const npsnQuery = /^\d{8}$/.test(keyword)
  const regionText = normalizeForSearch(place)
  const provinceAliases = [
    [/^(dki|jakarta|dki jakarta)$/, 'PROV. DKI JAKARTA'],
    [/^(jabar|jawa barat|west java)$/, 'PROV. JAWA BARAT'],
    [/^(jateng|jawa tengah|central java)$/, 'PROV. JAWA TENGAH'],
    [/^(jatim|jawa timur|east java)$/, 'PROV. JAWA TIMUR'],
    [/^(banten)$/, 'PROV. BANTEN'],
    [/^(diy|yogyakarta|daerah istimewa yogyakarta)$/, 'PROV. DI YOGYAKARTA'],
    [/^(bali)$/, 'PROV. BALI'],
    [/^(sumatera utara|sumut)$/, 'PROV. SUMATERA UTARA'],
    [/^(sumatera barat|sumbar)$/, 'PROV. SUMATERA BARAT'],
    [/^(sumatera selatan|sumsel)$/, 'PROV. SUMATERA SELATAN'],
    [/^(sulawesi selatan|sulsel)$/, 'PROV. SULAWESI SELATAN'],
    [/^(kalimantan timur|kaltim)$/, 'PROV. KALIMANTAN TIMUR'],
    [/^(lampung)$/, 'PROV. LAMPUNG'],
    [/^(ntb|nusa tenggara barat)$/, 'PROV. NUSA TENGGARA BARAT'],
    [/^(ntt|nusa tenggara timur)$/, 'PROV. NUSA TENGGARA TIMUR']
  ]
  const province = /^prov\./i.test(place) ? place.toUpperCase() : (provinceAliases.find(([pattern]) => pattern.test(regionText))?.[1] || '')
  const endpoints = [
    {
      name: 'EduAPI Indonesia',
      url: 'https://api-sekolah-kita.pages.dev/api/sekolah',
      params: { keyword, ...(province ? { provinsi: province } : {}), limit: 50, offset: 0 }
    },
    {
      name: 'Sekolah.devapi.id',
      url: 'https://sekolah.devapi.id/sekolah',
      params: npsnQuery ? { npsn: keyword, limit: 20 } : { nama: keyword, limit: 20 }
    },
  ]

  for (const endpoint of endpoints) {
    try {
      const axios = getAxios()
      const response = await axios.get(endpoint.url, {
        params: endpoint.params,
        timeout: 12000,
        maxContentLength: 3 * 1024 * 1024,
        headers: { 'Accept': 'application/json', 'User-Agent': 'Xeryuu-MD-School-Search/1.0 (+school lookup)' },
        validateStatus: status => status >= 200 && status < 300
      })
      const records = extractSchoolRecords(response.data).map(normalizeSchoolRecord).filter(row => row.name)
      for (const row of records) {
        if (npsnQuery && row.npsn !== keyword) continue
        candidates.push({ ...row, source: endpoint.name })
      }
      if (candidates.length) {
        const seen = new Set()
        const deduped = candidates.filter(row => {
          const key = row.npsn || `${row.name}|${row.city}|${row.province}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        const filtered = deduped
          .map(row => ({ ...row, _score: scoreSchool(row, keyword, place) }))
          .filter(row => npsnQuery || !place || row._score >= 6)
          .sort((a, b) => b._score - a._score)
        if (filtered.length) return filtered.slice(0, 8).map(({ _score, ...row }) => row)
      }
    } catch (error) {
      failures.push(`${endpoint.name}: ${String(error?.response?.status || error?.message || 'gagal').slice(0, 100)}`)
    }
  }

  throw new Error(failures.length
    ? `Sumber data sekolah tidak mengembalikan hasil yang dapat dipakai. ${failures.slice(0, 2).join(' | ')}`
    : 'Sekolah tidak ditemukan. Coba nama yang lebih singkat atau gunakan NPSN 8 digit.')
}

async function searchPlace(query) {
  const keyword = compact(query, 180)
  if (keyword.length < 3) throw new Error('Nama tempat minimal 3 karakter.')
  const axios = getAxios()
  const response = await axios.get('https://nominatim.openstreetmap.org/search', {
    params: { q: keyword, format: 'jsonv2', addressdetails: 1, limit: 3 },
    timeout: 12000,
    maxContentLength: 2 * 1024 * 1024,
    headers: { 'User-Agent': 'Xeryuu-MD-Maps/1.0 (public place lookup)', Accept: 'application/json' },
    validateStatus: status => status >= 200 && status < 300
  })
  const rows = Array.isArray(response.data) ? response.data : []
  return rows.map(row => ({
    name: compact(row.name || row.display_name?.split(',')[0], 140),
    address: compact(row.display_name, 300),
    latitude: Number(row.lat),
    longitude: Number(row.lon),
    category: compact(`${row.category || ''} ${row.type || ''}`, 90),
    source: 'OpenStreetMap Nominatim'
  })).filter(row => Number.isFinite(row.latitude) && Number.isFinite(row.longitude))
}

function wrapCanvasText(ctx, value, maxWidth) {
  const lines = []
  for (const paragraph of String(value || '').split(/\r?\n/)) {
    if (!paragraph.trim()) { lines.push(''); continue }
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate
      else {
        if (line) lines.push(line)
        if (ctx.measureText(word).width <= maxWidth) line = word
        else {
          let part = ''
          for (const char of word) {
            if (part && ctx.measureText(part + char).width > maxWidth) { lines.push(part); part = char }
            else part += char
          }
          line = part
        }
      }
    }
    if (line) lines.push(line)
  }
  return lines
}

function createMockupCard({ title = 'XERYUU MOCKUP', subtitle = '', lines = [], watermark = 'SIMULASI • BUKAN DOKUMEN ASLI', accent = '#7c3aed' } = {}) {
  const { createCanvas } = require('@napi-rs/canvas')
  const width = 1000
  const height = 620
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, '#0b1220')
  gradient.addColorStop(1, '#18253d')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, 18, height)
  ctx.fillStyle = 'rgba(255,255,255,0.06)'
  ctx.beginPath(); ctx.arc(900, 60, 210, 0, Math.PI * 2); ctx.fill()
  ctx.beginPath(); ctx.arc(110, 620, 210, 0, Math.PI * 2); ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 46px Arial'
  ctx.fillText(compact(title, 64), 58, 88, 880)
  ctx.fillStyle = '#cbd5e1'
  ctx.font = '25px Arial'
  if (subtitle) ctx.fillText(compact(subtitle, 100), 62, 133, 870)
  let y = subtitle ? 195 : 168
  ctx.font = '27px Arial'
  for (const line of (Array.isArray(lines) ? lines : [lines]).slice(0, 9)) {
    const wrapped = wrapCanvasText(ctx, compact(line, 240), 840)
    for (const textLine of wrapped) {
      if (y > 485) break
      ctx.fillStyle = '#f8fafc'
      ctx.fillText(textLine, 65, y, 850)
      y += 42
    }
    y += 6
  }
  ctx.save()
  ctx.translate(width / 2, height / 2)
  ctx.rotate(-0.24)
  ctx.fillStyle = 'rgba(255,255,255,0.23)'
  ctx.font = 'bold 48px Arial'
  ctx.textAlign = 'center'
  const label = compact(watermark, 100)
  for (let yy = -height; yy < height; yy += 155) ctx.fillText(label, 0, yy, 1200)
  ctx.restore()
  ctx.fillStyle = '#cbd5e1'
  ctx.font = 'bold 19px Arial'
  ctx.fillText('XERYUU-MD • FAN-MADE / MOCKUP', 62, 578)
  return canvas.toBuffer('image/png')
}

function createNulisImage(input) {
  const text = compact(input, MAX_TEXT)
  if (!text) throw new Error('Teks untuk ditulis belum diisi.')
  if (String(input).length > MAX_TEXT) throw new Error(`Teks maksimal ${MAX_TEXT} karakter.`)
  const { createCanvas } = require('@napi-rs/canvas')
  const width = 900
  const height = 1200
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fffdf5'; ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = '#b8d8f2'; ctx.lineWidth = 2
  for (let y = 100; y < height - 50; y += 48) { ctx.beginPath(); ctx.moveTo(50, y); ctx.lineTo(width - 50, y); ctx.stroke() }
  ctx.strokeStyle = '#ef7777'; ctx.lineWidth = 3
  ctx.beginPath(); ctx.moveTo(125, 45); ctx.lineTo(125, height - 45); ctx.stroke()
  ctx.fillStyle = '#263b6b'
  let fontSize = 35
  let lines = []
  const maxWidth = width - 180
  do {
    ctx.font = `italic ${fontSize}px Arial, sans-serif`
    lines = wrapCanvasText(ctx, text, maxWidth)
    if (lines.length <= Math.floor((height - 180) / 48) && Math.max(0, ...lines.map(line => ctx.measureText(line).width)) <= maxWidth) break
    fontSize -= 2
  } while (fontSize >= 18)
  ctx.font = `italic ${Math.max(18, fontSize)}px Arial, sans-serif`
  let y = 125
  for (const line of lines) {
    if (y >= height - 70) break
    ctx.fillText(line, 155, y, maxWidth)
    y += 48
  }
  ctx.fillStyle = 'rgba(80,80,80,0.48)'; ctx.font = 'bold 18px Arial'; ctx.textAlign = 'right'
  ctx.fillText('SIMULASI • XERYUU-MD', width - 45, height - 30)
  return canvas.toBuffer('image/png')
}

function createQuoteCardImage({ name = 'User', text = '' } = {}) {
  const value = compact(text, 650)
  if (!value) throw new Error('Teks quote tidak boleh kosong.')
  const { createCanvas } = require('@napi-rs/canvas')
  const canvas = createCanvas(512, 512)
  const ctx = canvas.getContext('2d')
  const bg = ctx.createLinearGradient(0, 0, 512, 512)
  bg.addColorStop(0, '#191a2b')
  bg.addColorStop(0.55, '#273d5b')
  bg.addColorStop(1, '#6b4f8a')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, 512, 512)
  ctx.fillStyle = 'rgba(255,255,255,.06)'
  for (let y = 20; y < 512; y += 36) for (let x = 20; x < 512; x += 36) {
    ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill()
  }
  ctx.fillStyle = '#ffffff'
  ctx.globalAlpha = 0.9
  ctx.font = 'bold 64px Georgia, serif'
  ctx.textAlign = 'left'
  ctx.fillText('“', 34, 97)
  ctx.globalAlpha = 1
  const displayName = compact(name || 'User', 50) || 'User'
  ctx.font = 'bold 20px Arial, sans-serif'
  ctx.fillStyle = '#f5d0fe'
  ctx.fillText(displayName, 42, 139, 425)

  const words = value.split(/\s+/)
  let fontSize = 31
  let lines = []
  while (fontSize >= 18) {
    ctx.font = `600 ${fontSize}px Arial, sans-serif`
    lines = []
    let line = ''
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word
      if (ctx.measureText(candidate).width <= 418 || !line) line = candidate
      else { lines.push(line); line = word }
    }
    if (line) lines.push(line)
    if (lines.every(item => ctx.measureText(item).width <= 418) && lines.length <= 8 && lines.length * fontSize * 1.25 <= 280) break
    fontSize -= 1
  }
  ctx.font = `600 ${fontSize}px Arial, sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'left'
  let y = 190
  for (const line of lines) {
    if (y > 440) break
    ctx.fillText(line, 44, y, 418)
    y += fontSize * 1.25
  }
  ctx.font = 'bold 12px Arial, sans-serif'
  ctx.fillStyle = 'rgba(255,255,255,.72)'
  ctx.textAlign = 'right'
  ctx.fillText('XERYUU-MD • QUICK QUOTE', 470, 479)
  return canvas.toBuffer('image/png')
}

module.exports = {
  compact,
  extractSchoolRecords,
  normalizeSchoolRecord,
  searchSchools,
  searchPlace,
  createMockupCard,
  createNulisImage,
  createQuoteCardImage
}
