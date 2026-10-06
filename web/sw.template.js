"use strict";
const CONFIG = __OFFLINE_CONFIG__;
const ROOT = self.registration.scope;
const PREFIX = `sandbox-offline:${new URL(ROOT).pathname}:`;
const CACHE = PREFIX + CONFIG.version;
const localURL = path => new URL(path, ROOT).href;
const essential = new Set(CONFIG.files.map(file => localURL(file.path)));
const aliases = new Map(Object.entries(CONFIG.aliases).map(([remote, path]) => [remote, localURL(path)]));

async function broadcast(message) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true, type: "window" })) {
    if (client.url.startsWith(ROOT)) client.postMessage(message);
  }
}
async function isComplete(cache) {
  for (const file of CONFIG.files) if (!await cache.match(localURL(file.path))) return false;
  return true;
}
async function precache() {
  const cache = await caches.open(CACHE);
  let done = 0;
  for (const file of CONFIG.files) {
    const url = localURL(file.path);
    if (!await cache.match(url)) {
      // Integrity is checked on every download. No best-effort required assets.
      const response = await fetch(url, { cache: "no-store", integrity: file.integrity });
      if (!response.ok || response.type === "opaque") throw new Error(`Download failed: ${file.path}`);
      await cache.put(url, response);
    }
    await broadcast({ type: "PROGRESS", done: ++done, total: CONFIG.files.length });
  }
}
self.addEventListener("install", event => {
  // A failed first download prevents activation. Failed updates keep the old app.
  event.waitUntil(precache());
});
self.addEventListener("activate", event => {
  // Do not remove old caches while an open tab may still need them. Never touch
  // another Pages application's cache. Browsers can evict unused caches later.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if (!await isComplete(cache)) throw new Error("Incomplete offline cache");
    await self.clients.claim();
    await broadcast({ type: "READY", ready: true });
  })());
});
self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE") { event.waitUntil(self.skipWaiting()); return; }
  if (event.data?.type === "STATUS") event.waitUntil((async () => {
    const ready = await isComplete(await caches.open(CACHE));
    event.source?.postMessage({ type: "READY", ready });
  })());
  if (event.data?.type === "REPAIR") event.waitUntil((async () => {
    try { await precache(); await broadcast({ type: "READY", ready: true }); }
    catch { await broadcast({ type: "READY", ready: false }); }
  })());
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const bare = url.origin + url.pathname;
  const alias = aliases.get(bare);
  const navigation = request.mode === "navigate" && url.origin === new URL(ROOT).origin && url.pathname.startsWith(new URL(ROOT).pathname);
  if (!alias && !essential.has(bare) && !navigation) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const target = navigation ? localURL("index.html") : alias || bare;
    const hit = await cache.match(target);
    if (hit) return hit;
    // A cache entry may have been evicted. Recover only the known local asset;
    // never request a remote CDN or silently cache a different upstream version.
    try {
      const file = CONFIG.files.find(file => localURL(file.path) === target);
      const response = await fetch(target, { cache: "no-store", integrity: file?.integrity });
      if (!response.ok) throw new Error("Unavailable");
      await cache.put(target, response.clone());
      return response;
    } catch {
      return new Response("Offline resource missing. Connect and use Re-download.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
  })());
});
