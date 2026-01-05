const CACHE_NAME = 'mc-webui-v3';
const ASSETS_TO_CACHE = [
    '/',
    '/static/css/style.css',
    '/static/js/app.js',
    '/static/js/dm.js',
    '/static/js/contacts.js',
    '/static/js/message-utils.js',
    '/static/images/android-chrome-192x192.png',
    '/static/images/android-chrome-512x512.png',
    // Bootstrap 5.3.2 (local)
    '/static/vendor/bootstrap/css/bootstrap.min.css',
    '/static/vendor/bootstrap/js/bootstrap.bundle.min.js',
    // Bootstrap Icons 1.11.2 (local)
    '/static/vendor/bootstrap-icons/bootstrap-icons.css',
    '/static/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
    '/static/vendor/bootstrap-icons/fonts/bootstrap-icons.woff',
    // Emoji Picker Element 1.28.1 (local)
    '/static/vendor/emoji-picker-element/index.js',
    '/static/vendor/emoji-picker-element/picker.js',
    '/static/vendor/emoji-picker-element/database.js',
    '/static/vendor/emoji-picker-element-data/en/emojibase/data.json'
];

// Install event - cache core assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch event - hybrid strategy:
// - Cache-first for vendor libraries (static, unchanging)
// - Network-first for app content (dynamic, needs updates)
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Cache-first for vendor libraries (Bootstrap, Icons)
    if (url.pathname.includes('/static/vendor/')) {
        event.respondWith(
            caches.match(event.request)
                .then((cachedResponse) => {
                    return cachedResponse || fetch(event.request)
                        .then((response) => {
                            // Cache the fetched vendor file for future use
                            return caches.open(CACHE_NAME).then((cache) => {
                                cache.put(event.request, response.clone());
                                return response;
                            });
                        });
                })
        );
    } else {
        // Network-first for everything else (app code, API calls, dynamic content)
        event.respondWith(
            fetch(event.request)
                .catch(() => caches.match(event.request))
        );
    }
});
