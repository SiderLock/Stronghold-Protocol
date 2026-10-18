import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server/index.js';
import { ANNOUNCEMENT_ASSET_MAX_BYTES, ANNOUNCEMENT_ASSET_URL_PREFIX } from '../shared/announcementAssets.js';

const TEMP_PREFIX = 'sp-ann-assets-http-';
const PREFIX = ANNOUNCEMENT_ASSET_URL_PREFIX;
const IMAGE_BYTES = Buffer.from([0, 31, 126, 127, 128, 255]);

async function withServer(run) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  const dir = path.join(temp, 'custom-announcements');
  const assets = path.join(dir, 'assets');
  const publicDir = path.join(temp, 'website');
  let srv;
  try {
    fs.mkdirSync(assets, { recursive: true });
    fs.mkdirSync(publicDir);
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementsDir: dir, publicDir });
    await run(srv, { temp, dir, assets, publicDir });
  } finally {
    try { await srv?.close(); }
    finally {
      const resolved = path.resolve(temp);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()), 'cleanup stays in the temporary directory');
      assert.ok(path.basename(resolved).startsWith(TEMP_PREFIX), 'cleanup only removes this test fixture');
      fs.rmSync(resolved, { recursive: true, force: true });
      assert.equal(fs.existsSync(resolved), false, 'the temporary fixture was removed');
    }
  }
}

// node:http preserves ../ and encoded separators; URL/fetch would normalize some attack paths first.
function request(srv, rawPath, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: rawPath, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('announcement asset request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function assertNotFound(response, url) {
  assert.equal(response.status, 404, url);
  assert.equal(response.headers['cache-control'], 'no-store', url);
  assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: 'ANNOUNCEMENT_ASSET_NOT_FOUND' }, url);
}

function createLink(t, target, link, kind) {
  try {
    fs.symlinkSync(target, link, kind === 'dir' && process.platform === 'win32' ? 'junction' : kind);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    return true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip(`symlink creation unavailable (${error.code}): this environment does not grant the required permission`);
    return false;
  }
}

test('announcement assets serve only the raster MIME allowlist with identical GET/HEAD metadata', async () => {
  await withServer(async (srv, { assets }) => {
    const types = {
      PNG: 'image/png', JpG: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    };
    for (const [ext, mime] of Object.entries(types)) {
      const file = `banner.${ext}`;
      fs.writeFileSync(path.join(assets, file), IMAGE_BYTES);
      const get = await request(srv, PREFIX + file, { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(get.status, 200, file);
      assert.deepEqual(get.body, IMAGE_BYTES, 'extension validation does not attempt image signature parsing');
      assert.equal(get.headers['content-type'], mime, file);
      assert.equal(get.headers['content-length'], String(IMAGE_BYTES.length));
      assert.equal(get.headers['cache-control'], 'no-cache');
      assert.equal(get.headers['x-content-type-options'], 'nosniff');
      assert.equal(get.headers['accept-ranges'], 'bytes');
      assert.equal(get.headers['content-encoding'], undefined, 'raster files are not gzip-compressed');
      assert.match(get.headers.etag, /^".+"$/);
      assert.ok(Number.isFinite(Date.parse(get.headers['last-modified'])));
      const head = await request(srv, PREFIX + file, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.body.length, 0);
      for (const key of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified', 'accept-ranges']) {
        assert.equal(head.headers[key], get.headers[key], `${file}: ${key}`);
      }
    }
  });
});

test('announcement asset cache validators revalidate query URLs and notice same-name replacements without restart', async () => {
  await withServer(async (srv, { assets }) => {
    const file = path.join(assets, 'banner.png');
    fs.writeFileSync(file, IMAGE_BYTES);
    fs.utimesSync(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const first = await request(srv, PREFIX + 'banner.png');
    const query = await request(srv, PREFIX + 'banner.png?v=content-hash&ignored=1');
    assert.equal(query.status, 200);
    assert.equal(query.headers['cache-control'], 'no-cache', '?v must not make a mutable image immutable');
    assert.equal(query.headers.etag, first.headers.etag);
    assert.deepEqual(query.body, IMAGE_BYTES);
    for (const headers of [{ 'if-none-match': first.headers.etag }, { 'if-modified-since': first.headers['last-modified'] }]) {
      const cached = await request(srv, PREFIX + 'banner.png?v=1', { headers });
      assert.equal(cached.status, 304);
      assert.equal(cached.body.length, 0);
      assert.equal(cached.headers['cache-control'], 'no-cache');
      assert.equal(cached.headers.etag, first.headers.etag);
    }
    const cachedHead = await request(srv, PREFIX + 'banner.png', { method: 'HEAD', headers: { 'if-none-match': first.headers.etag } });
    assert.equal(cachedHead.status, 304);
    assert.equal(cachedHead.body.length, 0);
    const precedence = await request(srv, PREFIX + 'banner.png', {
      headers: { 'if-none-match': '"different-version"', 'if-modified-since': first.headers['last-modified'] },
    });
    assert.equal(precedence.status, 200, 'If-None-Match takes precedence over If-Modified-Since');
    const replacement = Buffer.from([255, 128, 127, 126, 31, 0]);
    fs.writeFileSync(file, replacement);
    fs.utimesSync(file, new Date('2020-01-01T00:00:02Z'), new Date('2020-01-01T00:00:02Z'));
    const updated = await request(srv, PREFIX + 'banner.png?v=1', {
      headers: { 'if-none-match': first.headers.etag, 'if-modified-since': first.headers['last-modified'] },
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.body, replacement);
    assert.notEqual(updated.headers.etag, first.headers.etag);
    assert.notEqual(updated.headers['last-modified'], first.headers['last-modified']);
    assert.equal(updated.headers['cache-control'], 'no-cache');
    const cachedUpdated = await request(srv, PREFIX + 'banner.png', { headers: { 'if-none-match': updated.headers.etag } });
    assert.equal(cachedUpdated.status, 304);
  });
});

test('announcement assets retain byte ranges, HEAD ranges, If-Range, and unsatisfiable range responses', async () => {
  await withServer(async (srv, { assets }) => {
    fs.writeFileSync(path.join(assets, 'banner.png'), IMAGE_BYTES);
    const full = await request(srv, PREFIX + 'banner.png');
    const partial = await request(srv, PREFIX + 'banner.png?v=1', { headers: { range: 'bytes=1-3', 'if-range': full.headers.etag } });
    assert.equal(partial.status, 206);
    assert.deepEqual(partial.body, IMAGE_BYTES.subarray(1, 4));
    assert.equal(partial.headers['content-range'], `bytes 1-3/${IMAGE_BYTES.length}`);
    assert.equal(partial.headers['content-length'], '3');
    assert.equal(partial.headers['content-type'], 'image/png');
    assert.equal(partial.headers['cache-control'], 'no-cache');
    // RFC 9110: Range is GET-only; HEAD ignores it and reports the full representation.
    const head = await request(srv, PREFIX + 'banner.png', { method: 'HEAD', headers: { range: 'bytes=1-3' } });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(IMAGE_BYTES.length));
    assert.equal(head.headers['accept-ranges'], 'bytes');
    const stale = await request(srv, PREFIX + 'banner.png', { headers: { range: 'bytes=1-3', 'if-range': '"old-version"' } });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body, IMAGE_BYTES);
    const invalid = await request(srv, PREFIX + 'banner.png', { headers: { range: 'bytes=100-' } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], `bytes */${IMAGE_BYTES.length}`);
    assert.equal(invalid.body.length, 0);
  });
});

test('announcement assets use the configured storage directory and support nested Chinese names and spaces', async () => {
  await withServer(async (srv, { dir, assets, publicDir }) => {
    assert.equal(srv.announcements.dir, dir);
    fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'assets', 'banner.png'), 'public decoy', 'utf8');
    fs.writeFileSync(path.join(dir, 'banner.png'), 'storage-root decoy', 'utf8');
    fs.writeFileSync(path.join(assets, 'banner.png'), IMAGE_BYTES);
    assert.deepEqual((await request(srv, PREFIX + 'banner.png')).body, IMAGE_BYTES);
    const segments = ['2026.10', '通知 素材', '图片 #1+2.PNG'];
    fs.mkdirSync(path.join(assets, ...segments.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(assets, ...segments), IMAGE_BYTES);
    const nested = await request(srv, PREFIX + segments.map(encodeURIComponent).join('/') + '?v=anything');
    assert.equal(nested.status, 200);
    assert.deepEqual(nested.body, IMAGE_BYTES);
    assert.equal(nested.headers['content-type'], 'image/png');
    assert.equal(nested.headers['cache-control'], 'no-cache');
    assertNotFound(await request(srv, PREFIX + 'missing.png'), 'missing image');
    fs.writeFileSync(path.join(assets, 'missing.png'), IMAGE_BYTES);
    assert.deepEqual((await request(srv, PREFIX + 'missing.png')).body, IMAGE_BYTES, 'new assets are visible without restarting');
  });
});

test('announcement assets reject non-files and files above 16 MiB while accepting the exact size limit', async () => {
  await withServer(async (srv, { assets }) => {
    assert.equal(ANNOUNCEMENT_ASSET_MAX_BYTES, 16 * 1024 * 1024);
    fs.rmdirSync(assets);
    assertNotFound(await request(srv, PREFIX + 'missing.png'), 'missing assets directory');
    fs.mkdirSync(assets);
    fs.mkdirSync(path.join(assets, 'directory.png'));
    assertNotFound(await request(srv, PREFIX + 'directory.png'), 'a directory is not an image file');
    for (const [name, size, status] of [['limit.png', ANNOUNCEMENT_ASSET_MAX_BYTES, 200], ['oversized.png', ANNOUNCEMENT_ASSET_MAX_BYTES + 1, 404]]) {
      const fd = fs.openSync(path.join(assets, name), 'wx');
      try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
      const head = await request(srv, PREFIX + name, { method: 'HEAD' });
      assert.equal(head.status, status, name);
      assert.equal(head.body.length, 0);
      if (status === 200) assert.equal(head.headers['content-length'], String(size));
      else {
        assertNotFound(await request(srv, PREFIX + name), name);
        assertNotFound(await request(srv, PREFIX + name, { headers: { range: 'bytes=0-0' } }), 'a range cannot bypass the size limit');
      }
    }
  });
});

test('announcement asset HTTP is read-only and never exposes unsupported files, announcement bodies, indexes, or commands', async () => {
  await withServer(async (srv, { dir, assets }) => {
    srv.announcements.publish({ id: 'private', title: 'Private title', markdown: 'Private Markdown body' });
    fs.mkdirSync(path.join(dir, 'commands'));
    fs.writeFileSync(path.join(dir, 'commands', 'private.png'), 'Private command bytes', 'utf8');
    fs.writeFileSync(path.join(dir, 'private.png'), 'Private storage-root bytes', 'utf8');
    for (const name of ['index.json', 'private.md', 'script.js', 'markup.html', 'vector.svg', 'icon.ico', 'document.pdf', 'unknown.bin', '.hidden.png']) {
      fs.writeFileSync(path.join(assets, name), 'Private unsupported bytes', 'utf8');
      assertNotFound(await request(srv, PREFIX + name), name);
    }
    for (const suffix of ['commands/private.png', '../index.json', '../private.md', '../commands/private.png', '../private.png']) {
      assertNotFound(await request(srv, PREFIX + suffix), suffix);
    }
    assert.equal((await request(srv, '/runtime/announcements/index.json')).status, 404);
    assert.equal((await request(srv, '/runtime/announcements/private.md')).status, 404);
    const absent = await request(srv, PREFIX + 'absent.png');
    const head = await request(srv, PREFIX + 'absent.png', { method: 'HEAD' });
    assert.equal(head.status, 404);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], absent.headers['content-length']);
    fs.writeFileSync(path.join(assets, 'banner.png'), IMAGE_BYTES);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await request(srv, PREFIX + 'banner.png', { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, 'GET, HEAD', method);
    }
    assert.deepEqual(fs.readFileSync(path.join(assets, 'banner.png')), IMAGE_BYTES, 'rejected methods cannot change files');
  });
});

test('announcement asset raw paths reject traversal, encoded separators, double encoding, hidden names, and Windows aliases', async () => {
  await withServer(async (srv, { dir, assets }) => {
    fs.writeFileSync(path.join(dir, 'private.png'), 'Private outside-assets bytes', 'utf8');
    fs.mkdirSync(path.join(assets, 'safe'));
    fs.writeFileSync(path.join(assets, 'safe', 'image.png'), IMAGE_BYTES);
    fs.writeFileSync(path.join(assets, 'image.png'), IMAGE_BYTES);
    fs.writeFileSync(path.join(assets, '100%.png'), IMAGE_BYTES);
    fs.writeFileSync(path.join(assets, 'safe%2fimage.png'), IMAGE_BYTES);
    fs.mkdirSync(path.join(assets, '.hidden'));
    fs.writeFileSync(path.join(assets, '.hidden', 'image.png'), IMAGE_BYTES);
    fs.mkdirSync(path.join(assets, 'dir'));
    fs.writeFileSync(path.join(assets, 'dir', 'image.png'), IMAGE_BYTES);
    const suffixes = [
      '', '/', 'safe//image.png', './image.png', 'safe/./image.png', '../private.png', 'safe/../../private.png',
      '%2e%2e/private.png', 'safe/%2E%2E/image.png', '%2e%2e%2fprivate.png', '%2e%2e%5cprivate.png',
      'safe%2fimage.png', 'safe%5cimage.png', 'safe\\image.png', '%252e%252e/private.png', 'safe%252fimage.png',
      '100%25.png', '%2', '%ZZ.png', '%C0%AF.png', '%ED%A0%80.png', '%00.png', '%1F.png', '%7F.png', '%C2%80.png', '%C2%9F.png',
      '.hidden.png', '.hidden/image.png', 'CON.png', 'con%20.png', 'com1.png', 'lPt9.jpeg', 'NUL/image.png', 'COM%C2%B9.png', 'CONIN%24.png',
      'image.png%20', 'image.png.', 'dir%20/image.png', 'dir./image.png', 'image%3A.png', 'C:%5cprivate.png',
      'a%3C.png', 'a%3E.png', 'a%22.png', 'a%7C.png', 'a%3F.png', 'a%2A.png',
    ];
    for (const suffix of suffixes) assertNotFound(await request(srv, PREFIX + suffix), suffix || 'empty suffix');
    assertNotFound(await request(srv, PREFIX.slice(0, -1)), 'bare asset endpoint');
    assert.deepEqual((await request(srv, PREFIX + 'safe/image.png')).body, IMAGE_BYTES, 'valid nested images remain reachable');
  });
});

for (const outside of [false, true]) {
  const boundary = outside ? 'outside' : 'inside';
  test(`announcement assets reject a file symlink even when its target is ${boundary} the asset root`, async (t) => {
    await withServer(async (srv, { temp, assets }) => {
      const target = path.join(outside ? temp : assets, 'target.png');
      fs.writeFileSync(target, IMAGE_BYTES);
      if (!createLink(t, target, path.join(assets, 'linked.png'), 'file')) return;
      assertNotFound(await request(srv, PREFIX + 'linked.png'), `${boundary} file symlink`);
    });
  });

  test(`announcement assets reject a directory link even when its target is ${boundary} the asset root`, async (t) => {
    await withServer(async (srv, { temp, assets }) => {
      const target = path.join(outside ? temp : assets, 'target-directory');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'image.png'), IMAGE_BYTES);
      if (!createLink(t, target, path.join(assets, 'linked-directory'), 'dir')) return;
      assertNotFound(await request(srv, PREFIX + 'linked-directory/image.png'), `${boundary} directory link`);
    });
  });

  test(`announcement assets reject a linked assets root even when its target is ${outside ? 'outside' : 'inside'} the configured storage`, async (t) => {
    await withServer(async (srv, { temp, dir, assets }) => {
      const target = path.join(outside ? temp : dir, 'target-assets');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'image.png'), IMAGE_BYTES);
      fs.rmdirSync(assets);
      if (!createLink(t, target, assets, 'dir')) return;
      assertNotFound(await request(srv, PREFIX + 'image.png'), `${boundary} linked assets root`);
    });
  });
}
