/*
 * sw.js — オフライン対応（Service Worker）
 * ・アプリ本体（index.html など）：まずネットから最新版を取りに行き、つながらなければ保存版を使う
 * ・地図・文字・ライブラリ：一度読んだものは保存しておき、次からは保存版を使う（圏外でも表示できる）
 * ・ルート検索・住所検索：保存しない（つながらないときは画面側で案内する）
 * VERSION を変えると古いアプリ本体の保存版が消え、新しい版に入れ替わります。
 */
var VERSION = '1.7.0';
var APP_CACHE = 'michi-app-' + VERSION;
var TILE_CACHE = 'michi-tiles-v1';
var LIB_CACHE = 'michi-libs-v1';
var TILE_LIMIT = 8000; // 保存する地図の数の上限（古いものから消す）

var APP_FILES = ['./', './index.html', './navcore.js', './routing.js', './mapstyle.js', './manifest.webmanifest',
  './icon-180.png', './icon-192.png', './icon-512.png'];
var LIB_FILES = ['https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js', 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css'];

self.addEventListener('install', function (e) {
  e.waitUntil(Promise.all([
    caches.open(APP_CACHE).then(function (c) {
      return c.addAll(APP_FILES.map(function (u) { return new Request(u, { cache: 'no-cache' }); }));
    }),
    caches.open(LIB_CACHE).then(function (c) {
      return Promise.all(LIB_FILES.map(function (u) {
        return fetch(u, { mode: 'cors' }).then(function (r) { if (r.ok) return c.put(u, r); }).catch(function () {});
      }));
    })
  ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('michi-app-') === 0 && k !== APP_CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 待ち時間つきの通信（電波が弱いときに、いつまでも待たない）
function fetchWithTimeout(req, ms, opts) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
    fetch(req, opts).then(function (r) { if (!done) { done = true; clearTimeout(t); resolve(r); } },
      function (err) { if (!done) { done = true; clearTimeout(t); reject(err); } });
  });
}

// アプリ本体：ネット優先（更新がすぐ届く）→ だめなら保存版
function appFirstNetwork(req) {
  return fetchWithTimeout(req, 5000, { cache: 'no-cache' }).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(APP_CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error());
    });
  });
}

// 地図など：保存版優先 → なければネットから取って保存
var putCount = 0;
function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (c) {
    return c.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res.ok) {
          c.put(req, res.clone());
          if (cacheName === TILE_CACHE && ++putCount % 100 === 0) trimTiles(c);
        }
        return res;
      });
    });
  });
}

// ネット優先 → だめなら保存版（地図の目録や信号機名など、たまに変わるもの）
function networkThenCache(req, cacheName) {
  return fetchWithTimeout(req, 8000).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(cacheName).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) { return hit || Response.error(); });
  });
}

function trimTiles(c) {
  c.keys().then(function (keys) {
    var extra = keys.length - TILE_LIMIT;
    for (var i = 0; i < extra; i++) c.delete(keys[i]);
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  if (url.origin === self.location.origin) { e.respondWith(appFirstNetwork(req)); return; }

  var h = url.hostname;
  if (h === 'tiles.openfreemap.org') {
    // 地図タイルと文字は保存版優先、地図の目録（どの版のタイルを使うか）はネット優先
    e.respondWith(/\.pbf$/.test(url.pathname) ? cacheFirst(req, TILE_CACHE) : networkThenCache(req, TILE_CACHE));
    return;
  }
  if (h === 'cyberjapandata.gsi.go.jp') { e.respondWith(cacheFirst(req, TILE_CACHE)); return; }
  if (h === 'unpkg.com' || h === 'fonts.googleapis.com' || h === 'fonts.gstatic.com' || h === 'maps.gsi.go.jp') { e.respondWith(cacheFirst(req, LIB_CACHE)); return; }
  if (/overpass/.test(h)) { e.respondWith(networkThenCache(req, TILE_CACHE)); return; }
  // ルート検索・住所検索などはそのまま（保存しない）
});
