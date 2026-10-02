const CACHE = 'respect-talk-ai-v3';
const ASSETS = ['./', './index.html', './manifest.json', './src/styles.css', './src/app.js', './src/coach.js', './src/conversation.js', './src/local-ai.js', './icons/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => { if (event.request.method === 'GET') event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request))); });
