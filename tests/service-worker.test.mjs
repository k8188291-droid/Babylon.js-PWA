import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const template = await readFile(new URL('../web/sw.template.js', import.meta.url), 'utf8');
const root = 'https://example.github.io/Babylon.js-PWA/';
function worker({ offline = false, failPath, sharedCaches = new Map() } = {}) {
  const listeners = new Map();
  const requests = [];
  const messages = [];
  const state = { offline, failPath };
  const config = {
    version: 'test1',
    files: ['index.html', 'boot.js', 'vendor/cdn/decoder.wasm'].map(path => ({ path, integrity: 'sha256-fixture' })),
    aliases: { 'https://cdn.babylonjs.com/decoder.wasm': 'vendor/cdn/decoder.wasm' }
  };
  const caches = {
    async open(name) {
      if (!sharedCaches.has(name)) sharedCaches.set(name, new Map());
      const entries = sharedCaches.get(name);
      return { async match(url) { return entries.get(url)?.clone(); }, async put(url, response) { entries.set(url, response.clone()); } };
    }
  };
  const self = {
    registration: { scope: root },
    clients: { async matchAll() { return [{ url: root, postMessage: value => messages.push(value) }, { url: 'https://example.github.io/music/', postMessage() { throw Error('unrelated app'); } }]; }, async claim() {} },
    async skipWaiting() {},
    addEventListener: (type, listener) => listeners.set(type, listener)
  };
  vm.runInNewContext(template.replace('__OFFLINE_CONFIG__', JSON.stringify(config)), {
    self, caches, URL, Response, console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (state.offline || url.endsWith(state.failPath ?? 'UNMATCHED')) throw Error('Network failed');
      return new Response(`fixture:${url}`);
    }
  });
  async function event(type, extra = {}) {
    const pending = [];
    let response;
    listeners.get(type)({ ...extra, waitUntil: promise => pending.push(promise), respondWith: promise => { response = promise; } });
    await Promise.all(pending);
    return response ? await response : undefined;
  }
  return { event, requests, messages, sharedCaches, state };
}

test('full precache is required before readiness and every download has integrity', async () => {
  const w = worker();
  await w.event('install');
  await w.event('activate');
  assert.equal(w.requests.length, 3);
  assert.ok(w.requests.every(request => request.options.integrity && request.options.cache === 'no-store'));
  assert.equal(w.messages.at(-1).ready, true);
});

test('failed required decoder download rejects installation and reports incomplete', async () => {
  const w = worker({ failPath: 'decoder.wasm' });
  await assert.rejects(w.event('install'), /Network failed/);
  let status;
  await w.event('message', { data: { type: 'STATUS' }, source: { postMessage: value => { status = value; } } });
  assert.equal(status.ready, false);
  await assert.rejects(w.event('activate'), /Incomplete/);
});

test('offline navigation, cache-busting URLs, and remote decoder aliases use local cache', async () => {
  const w = worker();
  await w.event('install');
  const calls = w.requests.length;
  w.state.offline = true;
  const navigation = await w.event('fetch', { request: { url: root + '?file=model', method: 'GET', mode: 'navigate' } });
  assert.equal(await navigation.text(), 'fixture:' + root + 'index.html');
  const decoder = await w.event('fetch', { request: { url: 'https://cdn.babylonjs.com/decoder.wasm?t=123', method: 'GET', mode: 'cors' } });
  assert.equal(await decoder.text(), 'fixture:' + root + 'vendor/cdn/decoder.wasm');
  const script = await w.event('fetch', { request: { url: root + 'boot.js?version=123', method: 'GET', mode: 'cors' } });
  assert.equal(script.status, 200);
  assert.equal(w.requests.length, calls, 'offline restart must not attempt network');
});

test('worker ignores unrelated Pages routes, user remote models, and non-GET requests', async () => {
  const w = worker();
  for (const request of [
    { url: 'https://example.github.io/music/', method: 'GET', mode: 'navigate' },
    { url: 'https://models.example/model.glb', method: 'GET', mode: 'cors' },
    { url: root, method: 'POST', mode: 'cors' }
  ]) assert.equal(await w.event('fetch', { request }), undefined);
  assert.equal(w.requests.length, 0);
});

test('repair completes partial cache without deleting another application cache', async () => {
  const sharedCaches = new Map([['music-offline', new Map([['song', new Response('song')]])]]);
  const w = worker({ failPath: 'decoder.wasm', sharedCaches });
  await assert.rejects(w.event('install'));
  w.state.failPath = null;
  await w.event('message', { data: { type: 'REPAIR' } });
  assert.equal(w.messages.at(-1).ready, true);
  assert.ok(sharedCaches.has('music-offline'));
});
