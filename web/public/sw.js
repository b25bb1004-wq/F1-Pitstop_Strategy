/* Pitwall service worker. Hashed build assets and fonts: cache-first (immutable).
   Page, data and models: network-first with offline fallback, so updates always land. */
const CACHE = "pitwall-v2.4";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const put = (req, res) => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then((k) => k.put(req, c)); } return res; };
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const immutable = url.pathname.includes("/assets/") || url.host.includes("fonts.g");
  if (url.origin !== location.origin && !immutable) return;
  if (immutable) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => put(req, r))));
  } else {
    e.respondWith(fetch(req).then((r) => put(req, r)).catch(() => caches.match(req)));
  }
});
