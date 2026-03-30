const CACHE_NAME = 'jra-dispatch-' + self.registration.scope;
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// install: キャッシュに全アセットを格納し、即座にactivate
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// activate: 古いキャッシュを全削除し、即座に制御を取得
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// fetch: network-first戦略
// ネットワーク成功 → レスポンスをキャッシュに更新してから返す
// ネットワーク失敗 → キャッシュから返す（オフライン対応）
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request)
        .then(cached => cached || caches.match('./index.html'))
      )
  );
});
