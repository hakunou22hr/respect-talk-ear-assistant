const CACHE = 'respect-talk-ai-v5-gemini-pc';
const ASSETS = ['./', './index.html', './manifest.json', './src/styles.css', './src/app.js', './src/coach.js', './src/conversation.js', './src/local-ai.js', './src/ai-worker.js', './src/session.js', './src/session-ui.js', './src/storage.js', './src/recorder.js', './src/assistance.js', './src/gemini-ai.js', './icons/icon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate' && ['localhost', '127.0.0.1'].includes(new URL(event.request.url).hostname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request))); return;
  }
  if (event.request.method === 'GET') event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
