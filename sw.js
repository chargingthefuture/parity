/* Parity — service worker.
 *
 * This is what makes the app work with no signal. Every file the app needs,
 * including the stop dataset, is copied onto the phone when the app is
 * installed, so the first launch in airplane mode is a normal launch. There is
 * no "connect to continue" state anywhere in the app, because there is nothing
 * to connect to.
 *
 * Bump VERSION on any change, otherwise phones keep serving the old copy.
 */
var VERSION = 'parity-v1';

var SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/db.js',
  './js/geo.js',
  './js/places.js',
  './js/observations.js',
  './js/planner.js',
  './js/exchange.js',
  './js/location.js',
  './js/ui.js',
  './data/sample-dataset.json',
  './shared/theme.css',
  './shared/fonts.css',
  './shared/pwa.js',
  './shared/fonts/barlow-semi-condensed-500.woff2',
  './shared/fonts/barlow-semi-condensed-600.woff2',
  './shared/fonts/barlow-semi-condensed-700.woff2',
  './shared/fonts/inter-var.woff2',
  './shared/icons/icon.svg',
  './shared/icons/icon-180.png',
  './shared/icons/icon-192.png',
  './shared/icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      /* Added one at a time rather than in a single batch: one missing file
       * would otherwise fail the whole install and leave the app with nothing
       * cached, which is the one outcome that must not happen. */
      return Promise.all(SHELL.map(function (url) {
        return c.add(url).catch(function (err) {
          console.warn('[parity] could not cache', url, err);
        });
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) {
        if (n !== VERSION && n.indexOf('parity') === 0) return caches.delete(n);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* Page loads try the network first so an update lands, and fall straight back
   * to the cached copy when there is no signal — which, in a truck, is most of
   * the time. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) { return hit || caches.match('./index.html'); });
      })
    );
    return;
  }

  /* Everything else comes from the cache first. No round trip, no waiting on a
   * signal that is not there, and no radio wake-up costing battery. */
  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      });
    })
  );
});
