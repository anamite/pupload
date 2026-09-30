/* pupload service worker: makes the app installable and opens instantly.
   The API is never cached — files and links always come live from the Pi. */
const CACHE = "pupload-shell-v2";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  // Pages: network first so updates show up, cached shell when the Pi is unreachable.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }

  // Hashed build assets never change: serve from cache.
  // Icons, fonts and the manifest: serve cached, refresh in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit && url.pathname.startsWith("/assets/")) return hit;
      const net = fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
      if (!hit) return net;
      net.catch(() => undefined);
      return hit;
    }),
  );
});

// A reminder from the private space: open (or focus) the app where it belongs.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const href = (event.notification.data && event.notification.data.href) || "#/calendar";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === location.origin) {
          client.navigate(new URL(href, location.origin).href).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow("/" + href);
    }),
  );
});
