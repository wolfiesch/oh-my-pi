const CACHE_PREFIX = "omp-collab-app-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const APP_SHELL_URLS = ["/", "/index.html"];
const HASHED_STATIC_ASSET_RE = /^\/[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?|ttf|otf|wasm)$/i;

self.addEventListener("install", event => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then(cache => cache.addAll(APP_SHELL_URLS))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", event => {
	event.waitUntil(
		caches
			.keys()
			.then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", event => {
	const { request } = event;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	if (url.pathname === "/current-room.json") {
		event.respondWith(fetch(new Request(request, { cache: "no-store" })));
		return;
	}

	if (request.mode === "navigate" || url.pathname.endsWith(".json")) {
		event.respondWith(networkFirst(request));
		return;
	}

	if (HASHED_STATIC_ASSET_RE.test(url.pathname)) {
		event.respondWith(cacheFirst(request));
	}
});

async function networkFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	try {
		const response = await fetch(request);
		if (response.ok) {
			cache.put(request, response.clone()).catch(() => {});
		}
		return response;
	} catch (error) {
		const cached = await cache.match(request);
		if (cached) return cached;

		if (request.mode === "navigate") {
			const shell = (await cache.match("/index.html")) || (await cache.match("/"));
			if (shell) return shell;
		}

		throw error;
	}
}

async function cacheFirst(request) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);
	if (cached) return cached;

	const response = await fetch(request);
	if (response.ok) {
		cache.put(request, response.clone()).catch(() => {});
	}
	return response;
}
