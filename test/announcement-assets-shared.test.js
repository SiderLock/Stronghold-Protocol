// Shared browser/server path rules: UTF-8 filenames, exactly one URL decode and Windows-safe containment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOUNCEMENT_ASSET_URL_PREFIX, ANNOUNCEMENT_ASSET_DIR, ANNOUNCEMENT_ASSET_MAX_BYTES,
  announcementAssetSegments, announcementAssetMime,
} from '../shared/announcementAssets.js';

test('announcement image suffixes allow nested Chinese and spaces with one decoding pass', () => {
  assert.equal(ANNOUNCEMENT_ASSET_URL_PREFIX, '/api/announcement-assets/');
  assert.equal(ANNOUNCEMENT_ASSET_DIR, 'assets');
  assert.equal(ANNOUNCEMENT_ASSET_MAX_BYTES, 16 * 1024 * 1024);
  assert.deepEqual(announcementAssetSegments('nested/banner.png'), ['nested', 'banner.png']);
  assert.deepEqual(announcementAssetSegments(`${encodeURIComponent('活动公告')}/${encodeURIComponent('作战说明 1.PNG')}`), ['活动公告', '作战说明 1.PNG']);
  assert.deepEqual(announcementAssetSegments('活动公告/作战说明 1.PNG'), ['活动公告', '作战说明 1.PNG']);
  assert.deepEqual(announcementAssetSegments('emoji-%F0%9F%98%80/banner.png'), ['emoji-😀', 'banner.png']);
  assert.deepEqual(announcementAssetSegments('com0.png'), ['com0.png']);
  assert.ok(announcementAssetSegments(`${'中'.repeat(100)}/${'文'.repeat(100)}.png`));
  assert.equal(announcementAssetSegments(`${'中'.repeat(240)}/${'文'.repeat(240)}.png`), null, 'encoded Chinese expands beyond the complete HTTP URL budget');
});

test('unsafe suffixes cannot become hidden, absolute, device or differently decoded file paths', () => {
  for (const suffix of [
    '', '/', '/banner.png', 'banner.png/', 'folder//banner.png', '.', '..', './banner.png', '../banner.png',
    'folder/../banner.png', '.hidden/banner.png', 'folder/.hidden.png', '%2e%2e/banner.png', '%2Ehidden/banner.png',
    'folder%2fbanner.png', 'folder%5cbanner.png', 'folder\\banner.png', 'a%252fbanner.png', '%252e%252e/banner.png',
    'a%25.png', '%ZZ.png', '%E4.png', 'C:/banner.png', '//remote/banner.png', 'https://remote/banner.png',
    'banner.png:private', 'banner?.png', 'banner*.png', 'ban"ner.png', 'ban<ner.png', 'ban>ner.png', 'ban|ner.png',
    'folder./banner.png', 'folder /banner.png', 'banner.png.', 'banner.png ', 'banner.png%20',
    'con.png', 'PRN.PNG', 'aux.jpg', 'nul.gif', 'COM1.webp', 'lpt9.avif', 'con.foo.png', 'con .png', 'conin$.bmp', 'COM¹.png',
    'banner%00.png', 'banner%1f.png', 'banner%7f.png', 'banner%C2%85.png', 'ban\nner.png', 'bad-\ud800.png',
    `${'a'.repeat(256)}.png`, `${'dir/'.repeat(32)}banner.png`,
  ]) assert.equal(announcementAssetSegments(suffix), null, JSON.stringify(suffix));
  assert.equal(announcementAssetSegments(null), null);
  assert.equal(announcementAssetSegments(undefined), null);
});

test('announcement raster MIME allowlist excludes executable/text formats and unknown extensions', () => {
  for (const [file, mime] of [
    ['banner.png', 'image/png'], ['banner.JPG', 'image/jpeg'], ['banner.jpeg', 'image/jpeg'], ['banner.gif', 'image/gif'],
    ['banner.webp', 'image/webp'], ['banner.avif', 'image/avif'], ['banner.bmp', 'image/bmp'],
  ]) assert.equal(announcementAssetMime(file), mime);
  for (const file of ['banner.svg', 'banner.html', 'index.json', 'notice.md', 'command.json', 'banner.ico', '.png', 'banner', 'banner.png.md']) {
    assert.equal(announcementAssetMime(file), null, file);
  }
  assert.equal(announcementAssetMime(null), null);
});
