/* Pitwall service worker. Hashed build assets and fonts: cache-first (immutable). The page: network-first with an
   offline fallback. Data, the car model and the HDRI are NOT routed through the worker: streaming megabytes through a
   worker that a deploy can replace mid-download made Safari abort them ("Load failed"); the browser cache handles them. */
const CACHE = "pitwall-v2.6";
// no skipWaiting: a new worker takes over on the next visit, never in the middle of a page load
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const put = (req, res) => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then((k) => k.put(req, c)); } return res; };
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (/\/(data|models|hdr)\//.test(url.pathname)) return;
  const immutable = url.pathname.includes("/assets/") || url.host.includes("fonts.g");
  if (url.origin !== location.origin && !immutable) return;
  if (immutable) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => put(req, r))));
  } else {
    e.respondWith(fetch(req).then((r) => put(req, r)).catch(() => caches.match(req).then((hit) => hit || Response.error())));
  }
});
