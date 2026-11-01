/* Service worker: app files network-first (so updates show up), map tiles you've seen cache-first. */
const VERSION = "v8";
const APP = "app-" + VERSION, TILES = "tiles-v1", MAX_TILES = 1500;
const SHELL = ["./", "index.html", "util.js", "sources.js", "schema.js", "builder.js", "nav.js", "app.js", "app.css", "leaflet.js", "leaflet.css", "icon.svg", "icon-180.png", "icon-512.png", "manifest.webmanifest", "cities.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // network first, fall back to cache when offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(APP).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html"))));
    return;
  }
  if (url.hostname === "tile.openstreetmap.org") {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === "cors") {
        c.put(req, res.clone());
        c.keys().then((k) => { if (k.length > MAX_TILES) k.slice(0, k.length - MAX_TILES).forEach((r) => c.delete(r)); });
      }
      return res;
    }));
  }
  // everything else (Overpass, Wikipedia, routing): straight to the network
});
