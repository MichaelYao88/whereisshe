/* WhereIsShe service worker.
   Shell (HTML, CSS, JS, icons) is cached so a reload works offline.
   HTML and the daily puzzle files are network-first, so a new day is picked up
   whenever the network is up; the cache is only the offline fallback.
   Photos and videos under sources/ and mark/media are never cached.
   These requests are not intercepted at all (no respondWith, no cache):
   non-GET, /ads.txt, Supabase, PostHog, and Google ad hosts. */
const CACHE = "wis-shell-v1";

const PRECACHE = [
  "/",
  "/index.html",
  "/about.html",
  "/how-to-play.html",
  "/terms.html",
  "/privacy.html",
  "/refund.html",
  "/loadingzone.html",
  "/schedule.html",
  "/mark.html",
  "/styles.css",
  "/app.js",
  "/tiles.js",
  "/puzzles-data.js",
  "/schedule.json",
  "/mark-data.js",
  "/pwa.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/leaflet.js",
  "/vendor/leaflet/images/marker-icon.png",
  "/vendor/leaflet/images/marker-icon-2x.png",
  "/vendor/leaflet/images/marker-shadow.png",
  "/vendor/leaflet/images/layers.png",
  "/vendor/leaflet/images/layers-2x.png",
  "/vendor/maplibre/maplibre-gl.css",
  "/vendor/maplibre/maplibre-gl.js",
  "/vendor/maplibre/leaflet-maplibre-gl.js",
  "/vendor/supabase/supabase.js",
  "/vendor/xlsx.full.min.js"
];

function hostIs(host, suffix) {
  return host === suffix || host.endsWith("." + suffix);
}

/* True means: do not call respondWith. The browser handles the request itself. */
function leaveUntouched(request) {
  if (request.method !== "GET") return true;
  let url;
  try { url = new URL(request.url); } catch (e) { return true; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (path === "/ads.txt" || path.endsWith("/ads.txt")) return true;
  if (hostIs(host, "supabase.co")) return true;
  if (hostIs(host, "posthog.com")) return true;
  if (host === "adtrafficquality.google" || hostIs(host, "adtrafficquality.google")) return true;
  if (host === "fundingchoicesmessages.google.com" || hostIs(host, "fundingchoicesmessages.google.com")) return true;
  if (hostIs(host, "googlesyndication.com")) return true;
  if (hostIs(host, "doubleclick.net")) return true;
  if (hostIs(host, "googleadservices.com")) return true;
  if (hostIs(host, "googletagservices.com")) return true;
  if (hostIs(host, "google-analytics.com")) return true;
  if (hostIs(host, "googletagmanager.com")) return true;
  if (host === "google.com" || hostIs(host, "google.com")) {
    if (/adsense|pagead|\/ads|gampad|aclk/i.test(path + url.search)) return true;
  }
  if (hostIs(host, "gstatic.com") && /pagead|ads|fundingchoices/i.test(path + url.search)) return true;
  if (url.origin !== self.location.origin) return true;
  if (request.headers.has("range")) return true;
  if (path === "/sw.js") return true;
  return false;
}

function isHeavyMedia(url) {
  const path = url.pathname;
  if (path.indexOf("/sources/") !== -1 && /\/(videos|images)\//.test(path)) return true;
  if (path.indexOf("/mark/media/") === 0) return true;
  if (/\.(?:mp4|webm|mov|m4v|m3u8)$/i.test(path)) return true;
  return false;
}

function isShell(url, request) {
  if (isHeavyMedia(url)) return false;
  const path = url.pathname;
  if (request.mode === "navigate") return true;
  if (path === "/" || path.endsWith("/")) return true;
  if (path.indexOf("/sources/") === 0) return false;
  if (path === "/puzzles-data.js" || path === "/schedule.json" || path === "/mark-data.js") return true;
  if (path.indexOf("/icons/") === 0) return true;
  if (path.indexOf("/vendor/") === 0 && /\.(?:css|js|png|svg)$/i.test(path)) return true;
  if (/^\/[^/]+\.(?:html?|css|js|webmanifest)$/i.test(path)) return true;
  return false;
}

function shellPaths(pathname) {
  if (pathname === "/" || pathname === "/index.html") return ["/", "/index.html"];
  return [pathname];
}

/* A fresh Response, so a redirected GitHub Pages reply can still be stored. */
async function putBody(cache, paths, response) {
  const buf = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  // fetch() already decoded the body. Keeping these makes the cached reply undecodable on GitHub Pages.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("set-cookie");
  await Promise.all(paths.map((p) => cache.put(p, new Response(buf.slice(0), {
    status: response.status,
    statusText: response.statusText,
    headers: headers
  }))));
}

async function store(cache, request, response) {
  const path = new URL(request.url).pathname || "/";
  await putBody(cache, shellPaths(path), response);
}

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(PRECACHE.map(async (path) => {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error("precache " + path + " failed: " + res.status);
    await putBody(cache, [path], res);
  }));
}

async function matchShell(cache, request) {
  const path = new URL(request.url).pathname;
  return (await cache.match(path))
    || (await cache.match(request, { ignoreSearch: true }))
    || (path === "/" ? cache.match("/index.html") : null);
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok && fresh.type === "basic") {
      await store(cache, request, fresh.clone()).catch(function () {});
    }
    return fresh;
  } catch (err) {
    const cached = await matchShell(cache, request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = (await cache.match("/index.html")) || (await cache.match("/"));
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  if (leaveUntouched(event.request)) return;
  const url = new URL(event.request.url);
  if (!isShell(url, event.request)) return;
  event.respondWith(networkFirst(event.request));
});
