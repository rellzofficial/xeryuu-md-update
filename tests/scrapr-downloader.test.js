'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  detectScraprPlatform,
  resolveScraprPlatform,
  PLATFORM_METHODS,
  defaultScraprMethodCount,
  normalizeInstagramPostUrl,
  assertPublicHttpUrl,
  extractScrapr
} = require('../library/scrapr-downloader.js')

test('detects Scrapr platforms while keeping Spotify and MediaFire recognizable', () => {
  const cases = [
    ['https://www.tiktok.com/@user/video/123', 'tiktok'],
    ['https://www.instagram.com/p/ABC123/', 'instagram'],
    ['https://m.facebook.com/watch/?v=123', 'facebook'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube'],
    ['https://x.com/user/status/123', 'twitter'],
    ['https://soundcloud.com/artist/track', 'soundcloud'],
    ['https://pin.it/abc123', 'pinterest'],
    ['https://music.apple.com/us/album/name/123', 'applemusic'],
    ['https://www.bilibili.com/video/BV123', 'bilibili'],
    ['https://v.douyin.com/abc/', 'douyin'],
    ['https://artist.bandcamp.com/track/song', 'bandcamp'],
    ['https://www.pixiv.net/artworks/123', 'pixiv'],
    ['https://www.xiaohongshu.com/explore/123', 'rednote'],
    ['https://www.threads.net/@user/post/123', 'threads'],
    ['https://www.reddit.com/r/test/comments/123/post', 'reddit'],
    ['https://www.terabox.com/sharing/link?surl=abc', 'terabox'],
    ['https://sfile.mobi/abc', 'sfile'],
    ['https://sfl.gl/abc', 'safelinku'],
    ['https://sub2unlock.io/abc', 'sub2unlock'],
    ['https://rekonise.com/some-link-abc', 'rekonise'],
    ['https://open.spotify.com/track/abc', 'spotify'],
    ['https://www.mediafire.com/file/abc/file.zip', 'mediafire'],
    ['https://unsupported.example/file', null]
  ]
  for (const [url, expected] of cases) assert.equal(detectScraprPlatform(url), expected, url)
})



test('normalizes public Instagram post URLs and rejects unrelated/profile URLs', () => {
  assert.equal(
    normalizeInstagramPostUrl('www.instagram.com/reel/ABC123/?igsh=abc#section caption'),
    'https://www.instagram.com/reel/ABC123/?igsh=abc'
  )
  assert.equal(normalizeInstagramPostUrl('https://instagr.am/p/ABC123/'), 'https://instagr.am/p/ABC123/')
  assert.throws(() => normalizeInstagramPostUrl('https://instagram.com/xnalz/'), /postingan, reel, atau story/i)
  assert.throws(() => normalizeInstagramPostUrl('https://instagram.com.evil.example/reel/ABC123/'), /Link tidak valid/i)
  assert.throws(() => normalizeInstagramPostUrl('https://example.com/reel/ABC123/'), /Link tidak valid/i)
})

test('uses complete fallback chains for non-TikTok platforms without changing TikTok provider count', () => {
  assert.equal(defaultScraprMethodCount('instagram'), 4)
  assert.equal(defaultScraprMethodCount('twitter'), 4)
  assert.equal(defaultScraprMethodCount('facebook'), 2)
  assert.equal(defaultScraprMethodCount('unshorten'), 1)
  assert.equal(defaultScraprMethodCount('tiktok'), 3)
  assert.deepEqual(PLATFORM_METHODS.tiktok, [
    ['tiktok', 'snaptik'], ['tiktok', 'tiktokio'], ['tiktok', 'ssstik'],
    ['tiktok', 'tikdownloader'], ['tiktok', 'savetik']
  ])
})

test('routes explicit platform commands and generic auto-detection', () => {
  assert.equal(resolveScraprPlatform('applemusic', 'https://music.apple.com/us/album/a/123'), 'applemusic')
  assert.equal(resolveScraprPlatform('scrapr', 'https://www.reddit.com/r/test/comments/123'), 'reddit')
  assert.equal(resolveScraprPlatform('download', 'https://www.instagram.com/p/abc'), 'instagram')
  assert.equal(resolveScraprPlatform('unshorten', 'https://bit.ly/abc'), 'unshorten')
  assert.equal(resolveScraprPlatform('resolver', 'https://unsupported.example/abc'), null)
})

test('rejects local/private targets and credential-bearing URLs', () => {
  for (const url of [
    'http://127.0.0.1/admin',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'https://user:pass@example.com/file'
  ]) assert.throws(() => assertPublicHttpUrl(url), url)
  assert.equal(assertPublicHttpUrl('https://example.com/path#fragment'), 'https://example.com/path')
})

test('does not run Spotify or MediaFire through Scrapr', async () => {
  await assert.rejects(() => extractScrapr('https://open.spotify.com/track/123', 'spotify'), /Spotify tetap memakai downloader Xeryuu/i)
  await assert.rejects(() => extractScrapr('https://www.mediafire.com/file/abc/file.zip', 'mediafire'), /MediaFire tetap memakai downloader Xeryuu/i)
})
