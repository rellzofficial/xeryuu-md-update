'use strict'

const MAX_LINES = 14

function canvasLibrary() {
    try { return require('@napi-rs/canvas') } catch {}
    try { return require('canvas') } catch {}
    return null
}

function money(value) {
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric >= 0 ? `Rp${Math.floor(numeric).toLocaleString('id-ID')}` : '-'
}

function clean(value, max = 240) {
    return String(value ?? '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
}

function fitText(ctx, value, maxWidth, size = 22, minSize = 12, weight = 700) {
    const text = clean(value, 500) || '-'
    for (let current = size; current >= minSize; current--) {
        ctx.font = `${weight} ${current}px Arial, sans-serif`
        if (ctx.measureText(text).width <= maxWidth) return { text, size: current }
    }
    ctx.font = `${weight} ${minSize}px Arial, sans-serif`
    let result = text
    while (result.length > 4 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1)
    return { text: `${result}…`, size: minSize }
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke = null) {
    const r = Math.max(0, Math.min(Number(radius) || 0, width / 2, height / 2))
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + width, y, x + width, y + height, r)
    ctx.arcTo(x + width, y + height, x, y + height, r)
    ctx.arcTo(x, y + height, x, y, r)
    ctx.arcTo(x, y, x + width, y, r)
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    if (stroke) {
        ctx.strokeStyle = stroke
        ctx.lineWidth = 1.25
        ctx.stroke()
    }
}

function splitLines(value, maxChars = 72) {
    const text = clean(value, 1000)
    if (!text) return []
    const words = text.split(/\s+/)
    const lines = []
    let line = ''
    for (const word of words) {
        if (!line) { line = word; continue }
        if (`${line} ${word}`.length <= maxChars) line += ` ${word}`
        else { lines.push(line); line = word }
    }
    if (line) lines.push(line)
    return lines
}

function statusAccent(status) {
    const key = clean(status, 40).toUpperCase()
    if (/SUCCESS|BERHASIL|TERKIRIM/.test(key)) return '#54e6a5'
    if (/FAILED|ERROR|OFFLINE|EXPIRED|GAGAL|BATAL/.test(key)) return '#ff8787'
    if (/REVIEW|PERLU|PERIKSA/.test(key)) return '#ffc56e'
    return '#32ddff'
}

function inferMetrics(lines = [], details = {}) {
    const result = []
    const add = (label, value) => {
        const cleanLabel = clean(label, 24)
        const cleanValue = clean(value, 76)
        if (cleanLabel && cleanValue && cleanValue !== '-') result.push([cleanLabel, cleanValue])
    }
    if (details.operatorName) add('OPERATOR', details.operatorName)
    if (details.amount != null) add('NOMINAL PULSA', money(details.amount))
    if (details.estimatedAmount != null) add('ESTIMASI BERSIH', money(details.estimatedAmount))
    if (details.status) add('STATUS', details.status)
    if (details.ref || details.providerTrxId) add('REFERENSI', details.providerTrxId || details.ref)

    if (!result.length) {
        for (const raw of (Array.isArray(lines) ? lines : [])) {
            const match = clean(raw, 240).match(/^([^:：]{2,30})\s*[:：]\s*(.{1,75})$/)
            if (!match) continue
            const label = match[1].replace(/[│┃]/g, '').trim()
            if (/instruksi|peringatan|jangan|ikuti|provider|nomor tujuan|kode ussd/i.test(label)) continue
            add(label, match[2])
            if (result.length >= 4) break
        }
    }
    const seen = new Set()
    return result.filter(([label]) => {
        const key = label.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
    }).slice(0, 4)
}

function renderConvertPulsaCard(options = {}) {
    const library = canvasLibrary()
    if (!library?.createCanvas) throw new Error('Renderer canvas tidak tersedia. Pasang @napi-rs/canvas atau canvas.')
    const { createCanvas } = library
    const width = 1200
    const height = 675
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    const title = clean(options.title || 'CONVERT PULSA PESANJASA', 48)
    const stage = clean(options.stage || 'CONVERT PULSA', 36).toUpperCase().replace(/[_-]+/g, ' ')
    const subtitle = clean(options.subtitle || 'PESANJASA • LIVE RATE • AUTO ORDER', 88)
    const lines = (Array.isArray(options.lines) ? options.lines : String(options.lines || '').split('\n'))
        .map(line => clean(line, 260))
        .filter(Boolean)
        .filter(line => !/^╭─═⪩|^╰─═─═─═|^[-─═]{5,}$/.test(line))
        .map(line => line.replace(/^[│┃]\s?/, '').trim())
        .filter(Boolean)
    const details = options.details && typeof options.details === 'object' ? options.details : {}
    const accent = statusAccent(details.status || stage)

    const bg = ctx.createLinearGradient(0, 0, width, height)
    bg.addColorStop(0, '#050817')
    bg.addColorStop(0.53, '#071b30')
    bg.addColorStop(1, '#092d3a')
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    ctx.save()
    ctx.globalAlpha = 0.11
    ctx.strokeStyle = '#31dfff'
    ctx.lineWidth = 1
    for (let x = 26; x < width; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke() }
    for (let y = 24; y < height; y += 44) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke() }
    ctx.restore()

    const glow = ctx.createRadialGradient(1060, 62, 5, 1060, 62, 430)
    glow.addColorStop(0, 'rgba(36, 216, 255, 0.24)')
    glow.addColorStop(1, 'rgba(36, 216, 255, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(600, 0, 600, 400)

    roundRect(ctx, 24, 24, width - 48, height - 48, 24, 'rgba(3, 12, 27, 0.74)', 'rgba(49, 217, 255, 0.72)')
    roundRect(ctx, 50, 48, 5, 48, 2, '#35e0ff')
    ctx.fillStyle = '#f3fbff'
    ctx.font = '800 22px Arial, sans-serif'
    ctx.fillText('XNALZ', 68, 66)
    ctx.fillStyle = '#8eb6c8'
    ctx.font = '600 13px Arial, sans-serif'
    ctx.fillText('PESANJASA • CONVERT PULSA', 68, 88)

    ctx.font = '700 13px Arial, sans-serif'
    const badge = fitText(ctx, stage, 330, 13, 11, 700)
    const badgeWidth = Math.max(126, ctx.measureText(badge.text).width + 32)
    roundRect(ctx, width - badgeWidth - 54, 46, badgeWidth, 36, 18, `${accent}20`, `${accent}aa`)
    ctx.fillStyle = accent
    ctx.textAlign = 'center'
    ctx.fillText(badge.text, width - badgeWidth / 2 - 54, 69)
    ctx.textAlign = 'left'

    ctx.fillStyle = '#f4fbff'
    const fittedTitle = fitText(ctx, title, 1070, 38, 24, 800)
    ctx.font = `800 ${fittedTitle.size}px Arial, sans-serif`
    ctx.fillText(fittedTitle.text, 58, 143)
    ctx.fillStyle = '#9ab7c7'
    ctx.font = '500 17px Arial, sans-serif'
    ctx.fillText(fitText(ctx, subtitle, 1060, 17, 13, 500).text, 60, 174)
    roundRect(ctx, 58, 191, 78, 4, 2, '#33ddff')

    roundRect(ctx, 54, 216, 1092, 365, 19, 'rgba(8, 25, 45, 0.94)', 'rgba(53, 191, 222, 0.4)')
    const metrics = inferMetrics(lines, details)
    let bodyStart = 244
    const used = new Set()
    if (metrics.length) {
        metrics.forEach(([label, value], index) => {
            const col = index % 2
            const row = Math.floor(index / 2)
            const x = 76 + col * 535
            const y = 239 + row * 86
            roundRect(ctx, x, y, 512, 72, 12, 'rgba(10, 39, 59, 0.95)', 'rgba(76, 165, 190, 0.34)')
            ctx.fillStyle = '#88b4c7'
            ctx.font = '700 12px Arial, sans-serif'
            ctx.fillText(label.toUpperCase().slice(0, 28), x + 17, y + 24)
            ctx.fillStyle = '#f1fbff'
            const valueFit = fitText(ctx, value, 476, 22, 13, 800)
            ctx.font = `800 ${valueFit.size}px Arial, sans-serif`
            ctx.fillText(valueFit.text, x + 17, y + 52)
            used.add(`${label}: ${value}`)
        })
        bodyStart = metrics.length > 2 ? 428 : 337
    }

    const ignoredMetricLines = new Set()
    for (const line of lines) {
        const match = line.match(/^([^:：]{2,30})\s*[:：]\s*(.{1,75})$/)
        if (match && metrics.some(([label, value]) => label.toLowerCase() === match[1].trim().toLowerCase() && value === match[2].trim())) ignoredMetricLines.add(line)
    }
    let content = lines.filter(line => !ignoredMetricLines.has(line))
    if (!content.length) content = ['Pilih langkah berikutnya melalui tombol di bawah.']
    content = content.slice(0, MAX_LINES)
    let y = bodyStart
    const maxY = 550
    for (const line of content) {
        if (y > maxY) break
        const wrapped = splitLines(line, metrics.length ? 91 : 108)
        for (const part of wrapped.slice(0, 2)) {
            if (y > maxY) break
            ctx.fillStyle = /jangan|⚠|peringatan|belum|gagal|review/i.test(part) ? '#ffd28a' : '#c4dce7'
            ctx.font = '500 16px Arial, sans-serif'
            ctx.fillText(fitText(ctx, part, 1030, 16, 12, 500).text, 82, y)
            y += 23
        }
        y += 3
    }
    if (lines.length > content.length) {
        ctx.fillStyle = '#6f9eb1'
        ctx.font = '500 12px Arial, sans-serif'
        ctx.fillText('Rincian lengkap tersedia pada keterangan pesan dan status transaksi.', 82, 560)
    }

    ctx.fillStyle = '#6f98ab'
    ctx.font = '600 12px Arial, sans-serif'
    ctx.fillText('XERYUU-MD V16 × SENDRICH', 58, 625)
    ctx.textAlign = 'right'
    ctx.fillText('IKUTI DATA RESMI PROVIDER', 1142, 625)
    ctx.textAlign = 'left'
    return canvas.toBuffer('image/png')
}

module.exports = { renderConvertPulsaCard, money }
