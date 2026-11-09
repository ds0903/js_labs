// Minimal service worker: it makes the game installable and keeps the page shell
// available offline. The game itself needs the server, so only GET requests for
// the page and its static files are cached, and the network always wins when it
// is there. /api, /ws and the health endpoints are never touched.
const CACHE = "arena-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const isApi = /^\/(api|ws|health|ready|metrics)/.test(url.pathname);
  if (request.method !== "GET" || url.origin !== location.origin || isApi) return;

  // network first; the cache answers only when the network does not
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit ?? caches.match("/"))),
  );
});
