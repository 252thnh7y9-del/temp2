// Service worker: stores everything the app needs so it works with no internet.
//
// - On install, every file below is downloaded and cached (about 15 MB, once).
// - The OCR engine, model and fonts (vendor/) never change for a given VERSION:
//   served straight from the cache.
// - The page and its own scripts: served from the cache instantly, and refreshed
//   in the background when online, so updates arrive on the next open.
// Bump VERSION when anything in vendor/ changes.
const VERSION = "v1";
const CACHE = `scoreboard-${VERSION}`;

const FILES = [
  "./",
  "index.html",
  "scoreboard-core.js",
  "ocr-worker.js",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/tesseract.min.js",
  "vendor/worker.min.js",
  // tesseract picks one of these by CPU features, so keep all three
  "vendor/core/tesseract-core-lstm.wasm.js",
  "vendor/core/tesseract-core-simd-lstm.wasm.js",
  "vendor/core/tesseract-core-relaxedsimd-lstm.wasm.js",
  "vendor/eng-traineddata-gz.wasm",
  "vendor/fonts/chakra-petch-latin-500-normal.woff2",
  "vendor/fonts/chakra-petch-latin-600-normal.woff2",
  "vendor/fonts/chakra-petch-latin-700-normal.woff2",
  "vendor/fonts/inter-latin-400-normal.woff2",
  "vendor/fonts/inter-latin-500-normal.woff2",
  "vendor/fonts/inter-latin-600-normal.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("scoreboard-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // Opening the app: always answer with the cached page (works offline).
  if (req.mode === "navigate") {
    event.respondWith(staleWhileRevalidate(new Request(new URL("index.html", self.registration.scope))));
    return;
  }
  if (url.pathname.includes("/vendor/")) {
    event.respondWith(caches.match(req).then((hit) => hit || fetchAndCache(req)));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function fetchAndCache(req) {
  const res = await fetch(req);
  if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  const update = fetchAndCache(req).catch(() => null);
  return hit || (await update) || new Response("Offline and not cached yet.", { status: 503 });
}
