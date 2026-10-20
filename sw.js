// Windrock Trails service worker: app shell cached on install, map tiles cached as you ride.
const SHELL = 'wt-shell-v4';
const TILES = 'wt-tiles';
const SHELL_FILES = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/images/layers.png', 'https://unpkg.com/leaflet@1.9.4/dist/images/layers-2x.png', 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png'];
const TILE_HOSTS = ['server.arcgisonline.com', 'basemap.nationalmap.gov', 'tile.opentopomap.org', 'tile.openstreetmap.org'];
const MAX_TILES = 40000; // ~700 MB worst case; trimmed oldest-first when exceeded

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('wt-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function isTile(url) { return TILE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h)); }

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(req.url, res.clone()).then(() => trim(cache)).catch(() => {}); }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  if (url.origin === self.location.origin || url.hostname === 'unpkg.com') {
    // app shell: cache first, refresh in background
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return hit || (await net) || new Response('Offline', { status: 503 });
    })());
  }
  // everything else (Overpass trail data) goes straight to the network; the page caches results itself
});

let trimming = false;
async function trim(cache) {
  if (trimming) return; trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      const drop = keys.slice(0, keys.length - MAX_TILES);
      await Promise.all(drop.map(k => cache.delete(k)));
    }
  } catch (e) {} finally { trimming = false; }
}
