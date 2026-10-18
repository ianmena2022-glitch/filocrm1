// FILO CRM — Service Worker para Web Push
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch(_) { payload = { title: event.data?.text() || 'FILO', body: '' }; }

  const title = payload.title || 'FILO';
  const options = {
    body:    payload.body || '',
    icon:    payload.icon || '/favicon.ico',
    badge:   payload.badge || '/favicon.ico',
    tag:     payload.tag || payload.data?.type || 'filo-notif',
    renotify: true,
    data:    payload.data || {},
    requireInteraction: false,
    silent:  false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/app';
  const targetUrl = new URL(url, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Si ya hay una ventana abierta en el app, enfocarla
      for (const client of clientList) {
        if (client.url.includes('/app') && 'focus' in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
