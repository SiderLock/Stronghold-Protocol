// Serve only the test harness through Puppeteer; no preview page is published by the app server.
import { readFile } from 'node:fs/promises';
import { buildSiteCsp } from '../../server/http/csp.js';

export async function installSkinPreviewFixture(page) {
  const files = new Map(await Promise.all(['html', 'js'].map(async ext => [
    `/dev/skin-preview.${ext}`,
    { status: 200, contentType: ext === 'html' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      headers: ext === 'html' ? { 'Content-Security-Policy': buildSiteCsp([]) } : {},
      body: await readFile(new URL(`../fixtures/skin-preview.${ext}`, import.meta.url)) },
  ])));
  await page.setRequestInterception(true);
  page.on('request', req => {
    const response = files.get(new URL(req.url()).pathname);
    void (response ? req.respond(response) : req.continue());
  });
}
