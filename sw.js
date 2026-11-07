// FLOWERED manual: service worker registration only.
// No caching of authenticated pages, Supabase responses or attachments.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
