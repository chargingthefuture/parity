/* Offline OS — service worker registration helper.
 * Each page calls: registerPWA('sw.js')  (path relative to the page). */
function registerPWA(swPath) {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register(swPath).catch(function (e) {
      console.warn('[offline-os] service worker registration failed:', e);
    });
  });
}
