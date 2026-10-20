 'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizePinterestSearchResults } = require('../library/pinterest-utils.js')

test('normalizes Pinterest native resource response and chooses original image', () => {
  const out = normalizePinterestSearchResults({
    resource_response: { data: { results: [
      { id: '12345', grid_title: 'Anime wallpaper', images: { orig: { url: 'https://i.pinimg.com/originals/a/b/c/picture.jpg' }, '736x': { url: 'https://i.pinimg.com/736x/a/b/c/picture.jpg' } }, created_at: 1700000000 },
      { id: 'duplicate', grid_title: 'duplicate', images: { orig: { url: 'https://i.pinimg.com/originals/a/b/c/picture.jpg' } } },
      { id: 'bad', grid_title: 'not an image', images: { orig: { url: 'https://www.pinterest.com/pin/999/' } } }
    ] } }
  }, 'anime wallpaper')
  assert.equal(out.length, 1)
  assert.equal(out[0].id, '12345')
  assert.equal(out[0].images_url, 'https://i.pinimg.com/originals/a/b/c/picture.jpg')
  assert.equal(out[0].pin, 'https://www.pinterest.com/pin/12345/')
  assert.equal(out[0].grid_title, 'Anime wallpaper')
})

test('normalizes common fallback provider payload variants', () => {
  const out = normalizePinterestSearchResults({ data: [
    { image: 'https://cdn.example.org/pic.webp', title: 'Cat image', link: 'https://www.pinterest.com/pin/1/' },
    { images_url: 'https://i.pinimg.com/736x/x/y/a.jpg', grid_title: 'Wallpaper', pin: 'https://www.pinterest.com/pin/2/' },
    { url: 'https://example.org/not-an-image' }
  ] }, 'cat')
  assert.equal(out.length, 2)
  assert.equal(out[0].grid_title, 'Cat image')
  assert.equal(out[1].images_url, 'https://i.pinimg.com/736x/x/y/a.jpg')
})

test('empty query/payload normalize safely', () => {
  assert.deepEqual(normalizePinterestSearchResults(null, ''), [])
  assert.deepEqual(normalizePinterestSearchResults({ resource_response: { data: { results: [] } } }), [])
})
