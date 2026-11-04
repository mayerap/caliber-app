// Web companion service worker (template; build-companion.mjs fills in VERSION and FILES).
// Network first, so a deploy shows up on the next open; the cached copy after 4 seconds or offline,
// so the app still opens in a gym with no signal. Supabase and other sites are never touched.
const VERSION = "f0b09bc214e4";
const CACHE = 'caliber-' + VERSION;
const FILES = ["./","admin.html","approve.html","docs/help/images/exercise-list.png","docs/help/images/exercise-notes-open.png","docs/help/images/exercise-notes.png","docs/help/images/exercise-page.png","docs/help/images/exercise-pullup.png","docs/help/images/exercise-records.png","docs/help/images/heavier-next-time.png","docs/help/images/lift-focus-heavy.png","docs/help/images/lift-focus-light.png","docs/help/images/lift-focus-setting.png","docs/help/images/pound-for-pound.png","docs/help/images/pr-finish.png","docs/help/images/pr-history.png","fonts/BarlowSemiCondensed-500-latin-ext.woff2","fonts/BarlowSemiCondensed-500-latin.woff2","fonts/BarlowSemiCondensed-600-latin-ext.woff2","fonts/BarlowSemiCondensed-600-latin.woff2","fonts/BarlowSemiCondensed-700-latin-ext.woff2","fonts/BarlowSemiCondensed-700-latin.woff2","fonts/BigShouldersDisplay-700-latin-ext.woff2","fonts/BigShouldersDisplay-700-latin.woff2","fonts/BigShouldersDisplay-800-latin-ext.woff2","fonts/BigShouldersDisplay-800-latin.woff2","fonts/InterTight-400-800-latin-ext.woff2","fonts/InterTight-400-800-latin.woff2","fonts/fonts.css","icon-180.png","icon-192.png","icon-32.png","icon-512.png","icon.svg","manifest.webmanifest","privacy.html","shell/ai.js","shell/auth.css","shell/auth.js","shell/board.js","shell/friends.js","shell/logger.js","shell/requests.js","shell/sync.js","vendor/capacitor.js","vendor/htm.umd.js","vendor/react-dom.production.min.js","vendor/react.production.min.js","vendor/supabase.js","vendor/xlsx.full.min.js"];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('caliber-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  // exercise clips stream with range requests, which a cache can't answer well; leave them to the network
  if (url.pathname.includes('/clips/')) return;
  // the app page is kept once, whatever query it was opened with (sign-in links add ?code=…)
  const key = req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req;
  e.respondWith(networkFirst(req, key));
});

async function networkFirst(req, key) {
  const cache = await caches.open(CACHE);
  // no-cache: ask the server every time (a quick 304 when nothing changed), since GitHub Pages lets
  // browsers keep files 10 minutes and a deploy would otherwise reach people late, or half of it would
  const net = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
    if (res.status === 200) cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  net.catch(() => {});   // offline is handled below
  try {
    const res = await Promise.race([net, new Promise(r => setTimeout(r, 4000))]);
    if (res) return res;
  } catch (e) { /* offline: use the copy */ }
  return (await cache.match(key, { ignoreSearch: true })) || net;
}
