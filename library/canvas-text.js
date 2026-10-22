'use strict'

// Canvas text fallback for minimal Node/Pterodactyl containers. Some images ship
// without system fonts, which makes Skia draw tofu squares for every character.
// Use an installed sans font when possible; otherwise render a small built-in
// vector bitmap alphabet so cards remain readable without bundling font files.
const fs = require('fs')

const FONT_NAME = 'XeryuuCanvasSans'
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
  '/usr/local/share/fonts/DejaVuSans.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf'
]

const GLYPHS = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01110'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  J: ['00111','00010','00010','00010','10010','10010','01100'],
  K: ['10001','10010','10100','11000','10100','10010','10001'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  W: ['10001','10001','10001','10101','10101','10101','01010'],
  X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
  Z: ['11111','00001','00010','00100','01000','10000','11111'],
  0: ['01110','10001','10011','10101','11001','10001','01110'],
  1: ['00100','01100','00100','00100','00100','00100','01110'],
  2: ['01110','10001','00001','00010','00100','01000','11111'],
  3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['00010','00110','01010','10010','11111','00010','00010'],
  5: ['11111','10000','10000','11110','00001','00001','11110'],
  6: ['01110','10000','10000','11110','10001','10001','01110'],
  7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'],
  9: ['01110','10001','10001','01111','00001','00001','01110'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'],
  '_': ['00000','00000','00000','00000','00000','00000','11111'],
  '.': ['00000','00000','00000','00000','00000','01100','01100'],
  ',': ['00000','00000','00000','00000','00110','00110','00100'],
  ':': ['00000','00110','00110','00000','00110','00110','00000'],
  ';': ['00000','00110','00110','00000','00110','00110','00100'],
  '!': ['00100','00100','00100','00100','00100','00000','00100'],
  '?': ['01110','10001','00001','00010','00100','00000','00100'],
  '/': ['00001','00010','00010','00100','01000','01000','10000'],
  '\\': ['10000','01000','01000','00100','00010','00010','00001'],
  '|': ['00100','00100','00100','00100','00100','00100','00100'],
  '+': ['00000','00100','00100','11111','00100','00100','00000'],
  '=': ['00000','11111','00000','11111','00000','00000','00000'],
  '%': ['11001','11010','00100','01000','10110','00110','00000'],
  '@': ['01110','10001','10111','10101','10111','10000','01110'],
  '#': ['01010','11111','01010','01010','11111','01010','00000'],
  '$': ['00100','01111','10100','01110','00101','11110','00100'],
  '&': ['01100','10010','10100','01000','10101','10010','01101'],
  '*': ['00000','10101','01110','11111','01110','10101','00000'],
  '(': ['00010','00100','01000','01000','01000','00100','00010'],
  ')': ['01000','00100','00010','00010','00010','00100','01000'],
  '[': ['01110','01000','01000','01000','01000','01000','01110'],
  ']': ['01110','00010','00010','00010','00010','00010','01110'],
  '<': ['00010','00100','01000','10000','01000','00100','00010'],
  '>': ['01000','00100','00010','00001','00010','00100','01000'],
  "'": ['00100','00100','00010','00000','00000','00000','00000'],
  '"': ['01010','01010','00100','00000','00000','00000','00000'],
  '^': ['00100','01010','10001','00000','00000','00000','00000'],
  '~': ['00000','00000','01001','10110','00000','00000','00000']
}

let cachedFontState = null

function registerRuntimeFont(canvasApi) {
  if (cachedFontState !== null) return cachedFontState
  cachedFontState = false
  const registry = canvasApi?.GlobalFonts
  if (!registry || typeof registry.registerFromPath !== 'function') return false
  for (const fontPath of FONT_CANDIDATES) {
    if (!fs.existsSync(fontPath)) continue
    try {
      const result = registry.registerFromPath(fontPath, FONT_NAME)
      if (result !== false) {
        cachedFontState = true
        break
      }
    } catch {}
  }
  return cachedFontState
}

function normalizeBitmapText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[→➜➝]/g, '->')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[•·]/g, '-')
    .replace(/[^\x20-\x7E]/g, ' ')
    .toUpperCase()
}

function getFontSize(ctx) {
  const match = String(ctx?.font || '').match(/(\d+(?:\.\d+)?)px/i)
  return Math.max(6, Number(match?.[1] || 18))
}

function bitmapTextWidth(value, scale) {
  const text = normalizeBitmapText(value)
  let width = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    width += (character === ' ' ? 4 : 6) * scale
  }
  return Math.max(0, width - (text.length ? scale : 0))
}

function createCanvasText(canvasApi) {
  const hasSystemFont = registerRuntimeFont(canvasApi)
  const family = hasSystemFont ? FONT_NAME : 'sans-serif'

  function measureText(ctx, value) {
    return hasSystemFont
      ? ctx.measureText(String(value ?? '')).width
      : bitmapTextWidth(value, getFontSize(ctx) / 10)
  }

  function fillText(ctx, value, x, y, maxWidth) {
    const text = String(value ?? '')
    if (hasSystemFont) {
      return Number.isFinite(maxWidth)
        ? ctx.fillText(text, x, y, maxWidth)
        : ctx.fillText(text, x, y)
    }

    const safeText = normalizeBitmapText(text)
    let scale = getFontSize(ctx) / 10
    let width = bitmapTextWidth(safeText, scale)
    if (Number.isFinite(maxWidth) && maxWidth > 0 && width > maxWidth) {
      scale *= maxWidth / width
      width = maxWidth
    }
    const align = String(ctx.textAlign || 'left').toLowerCase()
    let startX = Number(x) || 0
    if (align === 'center') startX -= width / 2
    else if (align === 'right' || align === 'end') startX -= width

    const baseline = String(ctx.textBaseline || 'alphabetic').toLowerCase()
    const topY = baseline === 'top' ? y : baseline === 'middle' ? y - (3.5 * scale) : y - (7 * scale)
    let cursorX = startX
    const size = Math.max(1, scale * 0.9)
    for (const character of safeText) {
      if (character === ' ') {
        cursorX += 4 * scale
        continue
      }
      const glyph = GLYPHS[character]
      if (!glyph) {
        cursorX += 6 * scale
        continue
      }
      for (let row = 0; row < glyph.length; row++) {
        for (let column = 0; column < glyph[row].length; column++) {
          if (glyph[row][column] !== '1') continue
          ctx.fillRect(cursorX + column * scale, topY + row * scale, size, size)
        }
      }
      cursorX += 6 * scale
    }
    return undefined
  }

  return { family, hasSystemFont, measureText, fillText }
}

module.exports = { createCanvasText, normalizeBitmapText }
