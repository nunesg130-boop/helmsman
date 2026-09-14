// This worker intentionally caches nothing. It preserves the installed-app
// lifecycle while ensuring every shell launch returns to the container origin.
// Broker API, service relay, and private media responses are never intercepted.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});
