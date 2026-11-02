import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startServer } from '../server/index.js';
import { createAnnouncementStore } from '../server/announcements.js';

async function withServer(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sp-ann-http-'));
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, announcementsDir: dir });
  try { await run(srv); } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
}

function request(srv, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: url, method }, (res) => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
}

test('announcements are public, uncached, metadata-only, and hot published without server restart', async () => {
  await withServer(async (srv) => {
    const empty = await request(srv, '/api/announcements');
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(empty.body), { revision: '', pinnedId: null, items: [] });
    const first = srv.announcements.publish({ id: 'welcome', title: '欢迎博士', markdown: '# 公告\n中文正文', pin: true });
    const list = await request(srv, '/api/announcements?ignored=1');
    assert.equal(list.headers['cache-control'], 'no-store');
    assert.match(list.headers['content-type'], /application\/json.*utf-8/);
    const index = JSON.parse(list.body);
    assert.equal(index.pinnedId, first.id); assert.equal(index.revision, first.revision);
    assert.deepEqual(Object.keys(index.items[0]).sort(), ['id', 'publishedAt', 'revision', 'title']);
    assert.equal(list.body.includes('中文正文'), false);
    const detail = await request(srv, '/api/announcements/welcome');
    assert.equal(detail.status, 200);
    assert.equal(JSON.parse(detail.body).markdown, '# 公告\n中文正文');
    assert.equal(detail.headers['cache-control'], 'no-store');
    const head = await request(srv, '/api/announcements/welcome', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], detail.headers['content-length']);
    const second = srv.announcements.publish({ id: 'new', title: '新公告', markdown: '新正文', publishedAt: '2020-01-01T00:00:00.000Z' });
    const updated = JSON.parse((await request(srv, '/api/announcements')).body);
    assert.equal(updated.items[0].id, second.id, 'publish order beats a backdated timestamp');
    assert.equal(updated.pinnedId, first.id);
    assert.notEqual(updated.revision, first.revision);
    srv.announcements.unpin();
    assert.equal(JSON.parse((await request(srv, '/api/announcements')).body).revision, second.revision);
  });
});

test('announcement HTTP exposes no writer and accepts no paths or private runtime files', async () => {
  await withServer(async (srv) => {
    srv.announcements.publish({ id: 'a', title: '标题', markdown: '正文' });
    for (const url of ['/api/announcements/missing', '/api/announcements/', '/api/announcements/../index.json',
      '/api/announcements/%2e%2e%2findex', '/api/announcements/a%2fb', '/api/announcements/%5c',
      '/api/announcements/a.md', '/api/announcements/con', '/api/announcements/%ZZ']) {
      const res = await request(srv, url);
      assert.equal(res.status, 404, url);
      assert.deepEqual(JSON.parse(res.body), { error: 'ANNOUNCEMENT_NOT_FOUND' });
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await request(srv, '/api/announcements', method);
      assert.equal(res.status, 405); assert.equal(res.headers.allow, 'GET, HEAD');
    }
    assert.equal((await request(srv, '/runtime/announcements/index.json')).status, 404);
    assert.equal((await request(srv, '/healthz')).status, 200);
  });
});

test('external deletion immediately hides cached details over HTTP and retains the last publication revision', async () => {
  await withServer(async (srv) => {
    const first = srv.announcements.publish({ id: 'older', title: '旧公告', markdown: '# 旧公告', pin: true });
    const latest = srv.announcements.publish({ id: 'newest', title: '新公告', markdown: '# 新公告' });
    assert.equal((await request(srv, `/api/announcements/${first.id}`)).status, 200);
    assert.equal((await request(srv, `/api/announcements/${latest.id}`)).status, 200);
    const writer = createAnnouncementStore({ dir: srv.announcements.dir });
    writer.remove(latest.id);
    const list = JSON.parse((await request(srv, '/api/announcements')).body);
    assert.equal(list.revision, latest.revision);
    assert.equal(list.pinnedId, first.id);
    assert.deepEqual(list.items.map((item) => item.id), [first.id]);
    for (const method of ['GET', 'HEAD']) {
      const removed = await request(srv, `/api/announcements/${latest.id}`, method);
      assert.equal(removed.status, 404);
      if (method === 'GET') assert.deepEqual(JSON.parse(removed.body), { error: 'ANNOUNCEMENT_NOT_FOUND' });
      else assert.equal(removed.body, '');
    }
    writer.remove(first.id);
    assert.deepEqual(JSON.parse((await request(srv, '/api/announcements')).body), {
      revision: latest.revision, pinnedId: null, items: [],
    });
    assert.equal((await request(srv, `/api/announcements/${first.id}`)).status, 404);
  });
});
