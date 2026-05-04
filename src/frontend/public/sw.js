const CACHE = "primer-shell-v1";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Pass through. Required for PWA install criteria — Chrome needs to see
  // a fetch handler. We don't actually cache anything here because the
  // app is dynamic and behind Cloudflare Access.
  return;
});
