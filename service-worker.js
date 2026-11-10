const SHELL_CACHE = "local-ai-shell-v2";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./app.webmanifest",
  "./app-icon.svg",
  "./app-icon-192.png",
  "./app-icon-512.png",
  "./vendor/webllm/web-llm.js",
  "./vendor/webllm/Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((name) => name.startsWith("local-ai-shell-") && name !== SHELL_CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== self.location.origin) return;

  const isAppShellAsset = APP_SHELL.some(
    (asset) => new URL(asset, self.registration.scope).href === requestUrl.href
  );
  if (request.mode !== "navigate" && !isAppShellAsset) return;

  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cachedResponse = await cache.match(request) ||
      (request.mode === "navigate" ? await cache.match("./index.html") : null);
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      if (cachedResponse) return cachedResponse;
      throw error;
    }
  })());
});
