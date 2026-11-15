// Cybertrace Check-in service worker.
// v1 is online-only: no caching, every request goes to the network (so a
// check-in is never served from a stale cache). It exists so the app is
// installable; the v2 offline queue will live here.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
