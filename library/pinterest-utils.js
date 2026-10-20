'use strict'

function normalizePinterestSearchResults(payload, query = '', baseHost = 'https://www.pinterest.com') {
  const candidates = [
    payload?.resource_response?.data,
    payload?.data?.resource_response?.data,
    payload?.data?.data,
    payload?.data,
    payload?.result?.data,
    payload?.result,
    payload?.results,
    payload
  ]
  let items = []
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) { items = candidate; break }
    if (candidate && typeof candidate === 'object') {
      for (const key of ['results', 'result', 'pins', 'items', 'data']) {
        if (Array.isArray(candidate[key])) { items = candidate[key]; break }
      }
      if (items.length) break
    }
  }

  const normalized = []
  const seen = new Set()
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const id = String(item.id ?? item.pin_id ?? item.pinId ?? '').trim()
    const images = item.images || item.image || {}
    const imageUrl = typeof images === 'string' ? images : (
      images?.orig?.url || images?.['736x']?.url || images?.['474x']?.url ||
      images?.['236x']?.url || images?.url || item.images_url || item.imageUrl ||
      item.image_url || item.thumbnail || item.src || item.url || ''
    )
    if (typeof imageUrl !== 'string' || !/^https:\/\//i.test(imageUrl)) continue

    let parsedImage
    try { parsedImage = new URL(imageUrl) } catch { continue }
    const imageHost = parsedImage.hostname.toLowerCase()
    const trustedPinterestImageHost = /(?:^|\.)pinimg\.com$/.test(imageHost)
    const looksLikeImage = /\.(?:jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(imageUrl)
    if (!trustedPinterestImageHost && !looksLikeImage) continue

    const uniqueKey = imageUrl.split(/[?#]/)[0]
    if (seen.has(uniqueKey)) continue
    seen.add(uniqueKey)

    const source = item.pin || item.pinUrl || item.source || item.link ||
      (id ? `${baseHost.replace(/\/$/, '')}/pin/${encodeURIComponent(id)}/` : '')
    let createdAt = ''
    if (item.created_at) {
      let dateValue = item.created_at
      if (typeof dateValue === 'number' && dateValue > 0 && dateValue < 1e12) dateValue *= 1000
      const date = new Date(dateValue)
      if (!Number.isNaN(date.getTime())) {
        createdAt = date.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })
      }
    }
    normalized.push({
      pin: source,
      link: item.link || source,
      created_at: createdAt,
      id,
      images_url: imageUrl,
      grid_title: String(item.grid_title || item.title || item.name || query || 'Pinterest')
        .replace(/\s+/g, ' ').trim().slice(0, 160)
    })
  }
  return normalized
}

module.exports = { normalizePinterestSearchResults }
