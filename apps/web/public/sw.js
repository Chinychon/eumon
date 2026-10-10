// Retired. Browsers that installed the old offline-shell worker fetch this on their next visit:
// it clears that worker's cache and unregisters itself.
// ponytail: delete this file once old installs have had time to update (a few months).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))).then(() => self.registration.unregister()));
});
