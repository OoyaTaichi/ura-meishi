const CACHE_NAME = 'sales-samurai-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/gemini.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// インストール: 全アセットをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// フェッチ: キャッシュ優先
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// プッシュ通知受信
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Sales侍';
  const options = {
    body: data.body || '商談の準備をしてください',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'sales-reminder',
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: '攻略メモを見る' },
      { action: 'dismiss', title: '閉じる' }
    ],
    requireInteraction: true
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// 通知クリック
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NAVIGATE', url });
          return;
        }
      }
      clients.openWindow(url);
    })
  );
});

// アラームスケジューラ（setInterval で15分前チェック）
let alarmInterval = null;

self.addEventListener('message', event => {
  if (event.data.type === 'START_ALARM_CHECK') {
    if (alarmInterval) clearInterval(alarmInterval);
    alarmInterval = setInterval(checkAlarms, 60 * 1000); // 1分ごとにチェック
    checkAlarms();
  }
  if (event.data.type === 'STOP_ALARM_CHECK') {
    if (alarmInterval) clearInterval(alarmInterval);
  }
});

async function checkAlarms() {
  const cache = await caches.open(CACHE_NAME);
  const alarmsResponse = await cache.match('/__alarms__');
  if (!alarmsResponse) return;

  const alarms = await alarmsResponse.json();
  const now = Date.now();
  const updated = [];
  let changed = false;

  for (const alarm of alarms) {
    if (alarm.fired) { updated.push(alarm); continue; }
    const diff = alarm.time - now;
    // 15分前（±30秒の余裕）
    if (diff > 0 && diff <= 15 * 60 * 1000 + 30000) {
      self.registration.showNotification('Sales侍 - 商談15分前！', {
        body: alarm.body,
        icon: '/icons/icon-192.png',
        tag: `alarm-${alarm.id}`,
        requireInteraction: true,
        data: { url: `/?contact=${alarm.contactId}` }
      });
      updated.push({ ...alarm, fired: true });
      changed = true;
    } else {
      updated.push(alarm);
    }
  }

  if (changed) {
    await cache.put('/__alarms__', new Response(JSON.stringify(updated)));
  }
}
