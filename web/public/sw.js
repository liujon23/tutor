// Minimal app-shell service worker. API calls always go to the network.
//
// Pages are NETWORK-FIRST. They used to be served from cache (stale-while-
// revalidate), so the first open after a rebuild ran the previous index.html —
// whose hashed /assets/ files the rebuild had just deleted. On the phone that
// meant a blank page (two 404s in the server log) until a second reload, and
// drive mode's reload-on-resume depends on that first load working. The cache
// is now only the offline fallback for pages, after a short timeout so a dead
// connection (a tunnel on the commute) can't hang the load.
//
// Hashed /assets/ files never change under a given name, so they are
// cache-first. Everything else (manifest, icons, archived transcripts) keeps
// stale-while-revalidate.
//
// Bump CACHE when this strategy changes: activate deletes every other cache.
const CACHE = "tutor-shell-v2";
const PAGE_TIMEOUT_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function store(request, res) {
  if (res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
  }
  return res;
}

/** Network first; the cached copy only if the network fails or takes too long. */
function networkFirst(request) {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = () =>
      caches.match(request).then((cached) => cached || caches.match("/"));
    const timer = setTimeout(() => {
      fallback().then((cached) => {
        if (!settled && cached) {
          settled = true;
          resolve(cached);
        }
      });
    }, PAGE_TIMEOUT_MS);
    fetch(request)
      .then((res) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve(store(request, res));
        } else {
          store(request, res); // too late for this load; fresher for the next
        }
      })
      .catch(() => {
        clearTimeout(timer);
        fallback().then((cached) => {
          if (!settled) {
            settled = true;
            resolve(cached || Response.error());
          }
        });
      });
  });
}

function cacheFirst(request) {
  return caches.match(request).then((cached) => cached || fetch(request).then((res) => store(request, res)));
}

function staleWhileRevalidate(request) {
  return caches.match(request).then((cached) => {
    const fresh = fetch(request)
      .then((res) => store(request, res))
      .catch(() => cached);
    return cached || fresh;
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") event.respondWith(networkFirst(request));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(cacheFirst(request));
  else event.respondWith(staleWhileRevalidate(request));
});
