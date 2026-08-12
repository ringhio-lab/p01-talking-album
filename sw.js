// アプリ本体だけをキャッシュする。写真と音声はIndexedDBにあり、ここには載らない。
const CACHE = 'talking-album-v35';
const ASSETS = ['./', './index.html', './app.js?v=35', './manifest.webmanifest', './icon-180.png', './icon-512.png', './storybook-meadow-v1.jpg', './crayon-title.svg', './HachiMaruPop-Regular.ttf'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// HTML/JSは更新優先、画像やフォントはキャッシュ優先。オフライン時は保存済みデータを使う。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isAppCode = e.request.mode === 'navigate' || /\.(?:html|js)$/.test(url.pathname);
  if (isAppCode) {
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html'))));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
