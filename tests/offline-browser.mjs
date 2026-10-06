import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import assert from 'node:assert/strict';

const base = (process.env.PAGES_BASE || '/Babylon.js-PWA').replace(/\/$/, '') + '/';
const dist = resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(base)) { response.writeHead(404).end(); return; }
    const path = resolve(dist, pathname.slice(base.length) || 'index.html');
    if (!path.startsWith(dist + sep)) { response.writeHead(403).end(); return; }
    await stat(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(await readFile(path));
  } catch { console.error('Missing asset:', request.url); response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = origin + base;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ serviceWorkers: 'allow' });
const page = await context.newPage();
const remote = [];
page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) remote.push(request.url()); });
page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
page.on('pageerror', error => console.error('Page error:', error.message));

function triangleGLB() {
  const positions = new Float32Array([-1,0,0, 1,0,0, 0,1,0]);
  const binary = Buffer.from(positions.buffer);
  const gltf = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'OfflineTriangle', mesh: 0 }], meshes: [{ name: 'OfflineTriangle', primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1,0,0], max: [1,1,0] }] };
  let json = Buffer.from(JSON.stringify(gltf));
  json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67,0); header.writeUInt32LE(2,4);
  header.writeUInt32LE(20 + json.length + 8 + binary.length,8);
  header.writeUInt32LE(json.length,12); header.writeUInt32LE(0x4e4f534a,16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length,0); binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,json,binHeader,binary]);
}
try {
  await page.goto(url);
  await page.waitForFunction(() => ['可離線使用','離線模式'].includes(document.getElementById('offline-status').textContent), null, { timeout: 240000 });
  await page.waitForFunction(() => globalThis.BABYLON?.EngineStore?.Instances?.length > 0 && document.querySelector("canvas") && !document.getElementById('boot-message'), null, { timeout: 120000 });
  assert.equal(remote.length, 0, `Startup contacted external servers: ${remote.join(', ')}`);
  const cache = await page.evaluate(async () => {
    const config = await (await fetch('offline-config.json')).json();
    const names = await caches.keys();
    return { count: config.files.length, names };
  });
  assert.ok(cache.count > 35);
  assert.ok(cache.names.some(name => name.includes('sandbox-offline:')));

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => ['離線模式', '可離線使用'].includes(document.getElementById('offline-status').textContent) && globalThis.BABYLON?.EngineStore?.Instances?.length > 0 && document.querySelector('canvas'), null, { timeout: 120000 });
  // Network emulation does not consistently update navigator.onLine in every
  // Chromium target. Prove disconnection using an uncached same-origin request.
  assert.ok(await page.evaluate(() => fetch('offline-proof-test').then(() => false).catch(() => true)), 'Browser network must actually be offline');
  // Use the application's actual FilesInput drag/drop path, rather than a
  // separate hand-written model loader, to verify offline local file viewing.
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const file = new File([bytes], 'OfflineTriangle.glb', { type: 'model/gltf-binary' });
    const transfer = new DataTransfer(); transfer.items.add(file);
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('Sandbox canvas missing');
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, triangleGLB().toString('base64'));
  await page.waitForFunction(() => globalThis.BABYLON?.EngineStore?.LastCreatedScene?.meshes?.some(mesh => mesh.getTotalVertices() >= 3 && mesh.name.includes('OfflineTriangle')), null, { timeout: 120000 });
  await page.waitForFunction(() => globalThis.BABYLON?.EngineStore?.LastCreatedScene?.isReady(), null, { timeout: 120000 });
  assert.equal(remote.length, 0, 'Offline model path attempted an external request');
  await page.getByRole('button', { name: '安裝與離線說明', exact: true }).click();
  await page.getByRole('heading', { name: '安裝與離線使用' }).waitFor();
  await page.getByRole('button', { name: '關閉', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  // The Babylon loading overlay and render canvas resize on the next frames.
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth, null, { timeout: 10000 });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/offline-mobile.png' });
  console.log(`PASS: ${cache.count} files cached; offline restart and local glb load succeeded; no external startup requests.`);
} catch (error) {
  console.error('Browser state:', await page.evaluate(() => ({ status: document.getElementById('offline-status')?.textContent, width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll('body *')].map(el => ({tag: el.tagName, id: el.id, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right})).filter(el => el.right > window.innerWidth), text: document.body.innerText.slice(0,2000) })).catch(() => ({})));
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/failure.png' }).catch(() => {});
  throw error;
} finally {
  await context.close(); await browser.close();
  await new Promise(resolve => server.close(resolve));
}
