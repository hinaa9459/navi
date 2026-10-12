/*
 * mapstyle.js — カーナビ風の地図の見た目
 * OpenStreetMapのベクトル地図（OpenFreeMap・無料・登録不要）を、次の方針で描きます。
 *   - 建物は薄く、道路をはっきり（道路の種類で色分け：高速=緑、国道=オレンジ、県道=黄、その他=白）
 *   - 道路名・施設名・信号機（交差点）名を控えめに表示
 *   - 昼／夜の2つの配色（夜は暗い地図）
 * 地図が読めないときは、国土地理院の淡色地図に切り替えます。
 */
(function (root) {
  'use strict';

  var PALETTE = {
    day: {
      bg: '#f3f2ee', park: '#dcebd2', water: '#aed0ec', building: '#e7e4df', buildingLine: '#dbd7d0', rail: '#b9b6b0',
      minor: '#ffffff', minorCase: '#d6d1c9', tertiary: '#ffffff', tertiaryCase: '#b9b3a9',
      secondary: '#fbe08a', secondaryCase: '#d1af4c', primary: '#f6ad6a', primaryCase: '#d0803e',
      motorway: '#5dbb7c', motorwayCase: '#2f8550',
      route: '#2465f0', routeCase: '#ffffff',
      roadText: '#2f343a', poiText: '#6a6f77', poiDot: '#9aa0a8', signalText: '#123d8f', place: '#4a4f57', halo: '#ffffff'
    },
    night: {
      bg: '#151a21', park: '#1b2620', water: '#1c3448', building: '#1f252d', buildingLine: '#262d36', rail: '#3a404a',
      minor: '#363d48', minorCase: '#22272f', tertiary: '#48505c', tertiaryCase: '#282d35',
      secondary: '#857235', secondaryCase: '#4f4420', primary: '#a5672f', primaryCase: '#5f3c1d',
      motorway: '#2e7a4e', motorwayCase: '#1a4a2f',
      route: '#45b8ff', routeCase: '#0c2333',
      roadText: '#d7dde5', poiText: '#97a1ad', poiDot: '#5c6570', signalText: '#a8c8ff', place: '#b3bcc7', halo: '#151a21'
    }
  };

  var FONT = ['Noto Sans Regular'];
  var FONT_BOLD = ['Noto Sans Bold'];
  var GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  var EMPTY = { type: 'FeatureCollection', features: [] };

  // 道路の種類ごとの設定（下に描くものから順に）
  var ROADS = [
    { id: 'minor', classes: ['minor', 'service'], minzoom: 12.5, w: [[13, 0.6], [15, 3], [18, 13]] },
    { id: 'tertiary', classes: ['tertiary'], minzoom: 11, w: [[11, 0.6], [14, 3], [18, 16]] },
    { id: 'secondary', classes: ['secondary'], minzoom: 9, w: [[9, 0.8], [13, 2.5], [18, 18]] },
    { id: 'primary', classes: ['primary', 'trunk'], minzoom: 7, w: [[7, 0.8], [12, 2.6], [18, 21]] },
    { id: 'motorway', classes: ['motorway'], minzoom: 5, w: [[5, 0.8], [11, 2.6], [18, 23]] }
  ];

  function widthExpr(stops, add) {
    var e = ['interpolate', ['exponential', 1.5], ['zoom']];
    stops.forEach(function (s) { e.push(s[0], s[1] + (add || 0) * Math.min(1, Math.max(0, (s[0] - 11) / 4))); });
    return e;
  }

  // 色を切り替える対象の一覧 [レイヤー, 項目, 色の名前]
  var BIND = [];
  function bind(layer, prop, key) { BIND.push([layer, prop, key]); return key; }

  function layers(p) {
    var L = [];
    BIND = [];
    L.push({ id: 'bg', type: 'background', paint: { 'background-color': p[bind('bg', 'background-color', 'bg')] } });
    L.push({ id: 'landcover', type: 'fill', source: 'omt', 'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['grass', 'wood', 'wetland'], true, false],
      paint: { 'fill-color': p[bind('landcover', 'fill-color', 'park')], 'fill-opacity': 0.55 } });
    L.push({ id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park',
      paint: { 'fill-color': p[bind('park', 'fill-color', 'park')], 'fill-opacity': 0.8 } });
    L.push({ id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water',
      paint: { 'fill-color': p[bind('water', 'fill-color', 'water')] } });
    L.push({ id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', minzoom: 12,
      paint: { 'line-color': p[bind('waterway', 'line-color', 'water')], 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.8, 18, 4] } });
    // 建物：薄く、ズームしたときだけ見える
    L.push({ id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-color': p[bind('building', 'fill-color', 'building')],
        'fill-outline-color': p[bind('building', 'fill-outline-color', 'buildingLine')],
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 0.6, 17, 0.9]
      } });
    L.push({ id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11,
      filter: ['all', ['==', ['get', 'class'], 'rail'], ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'line-color': p[bind('rail', 'line-color', 'rail')], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 18, 3], 'line-dasharray': [3, 2] } });

    // 道路：ふち → 中身 の順に描く
    var tunnelOpacity = ['case', ['==', ['get', 'brunnel'], 'tunnel'], 0.45, 1];
    ROADS.forEach(function (r) {
      L.push({ id: 'road-' + r.id + '-case', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: r.minzoom,
        filter: ['match', ['get', 'class'], r.classes, true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p[bind('road-' + r.id + '-case', 'line-color', r.id + 'Case')], 'line-width': widthExpr(r.w, 2.5), 'line-opacity': tunnelOpacity } });
    });
    ROADS.forEach(function (r) {
      L.push({ id: 'road-' + r.id, type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: r.minzoom,
        filter: ['match', ['get', 'class'], r.classes, true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': p[bind('road-' + r.id, 'line-color', r.id)], 'line-width': widthExpr(r.w, 0), 'line-opacity': tunnelOpacity } });
    });
    return L.concat(overlayLayers(p));
  }

  // ルート線・文字など（どの地図でも共通で上に重ねるもの）
  function overlayLayers(p) {
    var L = [];
    var routeW = ['interpolate', ['exponential', 1.5], ['zoom'], 10, 5, 14, 9, 18, 20];
    var routeCaseW = ['interpolate', ['exponential', 1.5], ['zoom'], 10, 8, 14, 13, 18, 26];
    L.push({ id: 'route-case', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p[bind('route-case', 'line-color', 'routeCase')], 'line-width': routeCaseW } });
    L.push({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': p[bind('route-line', 'line-color', 'route')], 'line-width': routeW } });

    if (p.vector) {
      // 道路名
      L.push({ id: 'road-label', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13,
        filter: ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor'], true, false],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 350, 'text-max-angle': 30,
          'text-field': ['coalesce', ['get', 'name:ja'], ['get', 'name'], ['get', 'ref']],
          'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 11, 18, 14],
          'text-padding': 8
        },
        paint: { 'text-color': p[bind('road-label', 'text-color', 'roadText')], 'text-halo-color': p[bind('road-label', 'text-halo-color', 'halo')], 'text-halo-width': 2 } });
      // 施設名（大きい施設は15以上、小さい施設は17以上で表示）
      var poiClass = ['match', ['get', 'class'], ['hospital', 'school', 'college', 'railway', 'town_hall', 'police', 'post', 'shop', 'grocery',
        'fast_food', 'restaurant', 'cafe', 'fuel', 'bank', 'library', 'stadium', 'attraction', 'castle', 'museum', 'lodging', 'fire_station'], true, false];
      [['poi-major', ['<=', ['get', 'rank'], 4], 15], ['poi-minor', ['>', ['get', 'rank'], 4], 17]].forEach(function (d) {
        L.push({ id: d[0], type: 'symbol', source: 'omt', 'source-layer': 'poi', minzoom: d[2],
          filter: ['all', ['has', 'name'], poiClass, d[1]],
          layout: {
            'text-field': ['coalesce', ['get', 'name:ja'], ['get', 'name']], 'text-font': FONT, 'text-size': 11.5,
            'text-max-width': 8, 'text-variable-anchor': ['top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.4, 'text-padding': 4
          },
          paint: { 'text-color': p[bind(d[0], 'text-color', 'poiText')], 'text-halo-color': p[bind(d[0], 'text-halo-color', 'halo')], 'text-halo-width': 1.5 } });
      });
      // 地名（市町村は太字、町名・丁目は小さく薄く）
      L.push({ id: 'place-minor', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 12, maxzoom: 15.5,
        filter: ['match', ['get', 'class'], ['suburb', 'quarter', 'neighbourhood'], true, false],
        layout: { 'text-field': ['coalesce', ['get', 'name:ja'], ['get', 'name']], 'text-font': FONT, 'text-size': 11.5, 'text-padding': 10 },
        paint: { 'text-color': p[bind('place-minor', 'text-color', 'poiText')], 'text-halo-color': p[bind('place-minor', 'text-halo-color', 'halo')], 'text-halo-width': 1.5 } });
      L.push({ id: 'place-label', type: 'symbol', source: 'omt', 'source-layer': 'place', maxzoom: 15,
        filter: ['match', ['get', 'class'], ['city', 'town', 'village'], true, false],
        layout: {
          'text-field': ['coalesce', ['get', 'name:ja'], ['get', 'name']], 'text-font': FONT_BOLD,
          'text-size': ['match', ['get', 'class'], 'city', 17, 15], 'text-padding': 6
        },
        paint: { 'text-color': p[bind('place-label', 'text-color', 'place')], 'text-halo-color': p[bind('place-label', 'text-halo-color', 'halo')], 'text-halo-width': 2 } });
    }
    // 信号機（交差点）名：横型信号のアイコン＋交差点名標識の青文字
    L.push({ id: 'signal-label', type: 'symbol', source: 'signals', minzoom: 14.5,
      layout: {
        'icon-image': 'signal', 'icon-size': 0.5, 'icon-allow-overlap': true,
        'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-size': 12.5,
        'text-anchor': 'top', 'text-offset': [0, 0.9], 'text-optional': true, 'text-padding': 4
      },
      paint: { 'text-color': p[bind('signal-label', 'text-color', 'signalText')], 'text-halo-color': p[bind('signal-label', 'text-halo-color', 'halo')], 'text-halo-width': 2.2 } });
    return L;
  }

  function sources(vector) {
    var s = {
      route: { type: 'geojson', data: EMPTY, attribution: 'ルート: Valhalla・OSRM' },
      signals: { type: 'geojson', data: EMPTY }
    };
    if (vector) s.omt = { type: 'vector', url: 'https://tiles.openfreemap.org/planet',
      attribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' };
    else s.gsi = { type: 'raster', tileSize: 256, minzoom: 2, maxzoom: 18,
      tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>' };
    return s;
  }

  // 標準：OpenStreetMapのベクトル地図
  function build(night) {
    var p = Object.assign({ vector: true }, night ? PALETTE.night : PALETTE.day);
    return { version: 8, glyphs: GLYPHS, sources: sources(true), layers: layers(p) };
  }

  // 予備：国土地理院の淡色地図（夜は暗く加工）
  function buildFallback(night) {
    var p = Object.assign({ vector: false }, night ? PALETTE.night : PALETTE.day);
    BIND = [];
    var L = [{ id: 'gsi', type: 'raster', source: 'gsi', paint: rasterPaint(night) }].concat(overlayLayers(p));
    return { version: 8, glyphs: GLYPHS, sources: sources(false), layers: L };
  }

  function rasterPaint(night) {
    return night ? { 'raster-brightness-min': 0.85, 'raster-brightness-max': 0.12, 'raster-saturation': -0.6, 'raster-hue-rotate': 180 }
      : { 'raster-brightness-min': 0, 'raster-brightness-max': 1, 'raster-saturation': 0, 'raster-hue-rotate': 0 };
  }

  // 昼夜の切り替え（地図を作り直さずに色だけ変える）
  function applyTheme(map, night) {
    var p = night ? PALETTE.night : PALETTE.day;
    BIND.forEach(function (b) { if (map.getLayer(b[0])) map.setPaintProperty(b[0], b[1], p[b[2]]); });
    if (map.getLayer('gsi')) {
      var rp = rasterPaint(night);
      Object.keys(rp).forEach(function (k) { map.setPaintProperty('gsi', k, rp[k]); });
    }
  }

  // 横型信号機のアイコン（青・黄・赤）
  function signalImage() {
    var w = 64, h = 30, c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.fillStyle = '#2b2f36';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    var r = 8;
    g.beginPath();
    g.moveTo(r + 2, 2); g.lineTo(w - r - 2, 2); g.arcTo(w - 2, 2, w - 2, r + 2, r); g.lineTo(w - 2, h - r - 2);
    g.arcTo(w - 2, h - 2, w - r - 2, h - 2, r); g.lineTo(r + 2, h - 2); g.arcTo(2, h - 2, 2, h - r - 2, r);
    g.lineTo(2, r + 2); g.arcTo(2, 2, r + 2, 2, r); g.closePath();
    g.fill(); g.stroke();
    ['#22c38e', '#f5c242', '#ef4b4b'].forEach(function (col, i) {
      g.fillStyle = col;
      g.beginPath(); g.arc(14 + i * 18, h / 2, 7, 0, Math.PI * 2); g.fill();
    });
    return { width: w, height: h, data: new Uint8Array(g.getImageData(0, 0, w, h).data.buffer) };
  }

  root.MapStyle = { build: build, buildFallback: buildFallback, applyTheme: applyTheme, signalImage: signalImage, EMPTY: EMPTY };
})(this);
