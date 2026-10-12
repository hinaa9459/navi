/*
 * routing.js — ルート計算の窓口
 * 2つの無料ルートサービスを順番に試し、答えた方を使います。
 *   1. Valhalla（無料・登録不要）… 有料道路の回避・指定地点の回避（渋滞よけ）に対応
 *   2. OSRM（無料・登録不要）… 予備
 * どのサービスの答えも、navcore.js が読める同じ形（OSRM形式）にそろえて返します。
 */
(function (root) {
  'use strict';

  var TIMEOUT_MS = 12000;

  function RouteError(message, provider, kind) {
    var e = new Error(message);
    e.provider = provider;
    e.kind = kind || 'error'; // 'noroute' | 'auth' | 'network' | 'error'
    return e;
  }

  // タイムアウト付きの通信
  function request(url, opts, provider) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, TIMEOUT_MS);
    var o = opts || {};
    if (ctl) o.signal = ctl.signal;
    return fetch(url, o).then(function (res) {
      return res.text().then(function (txt) {
        var j = null;
        try { j = JSON.parse(txt); } catch (e) {}
        return { ok: res.ok, status: res.status, json: j };
      });
    }, function (e) {
      throw RouteError(e && e.name === 'AbortError' ? '応答がありません' : '接続できません', provider, 'network');
    }).finally(function () { clearTimeout(timer); });
  }

  function osrmShape(coords, distance, duration, steps, meta) {
    return {
      code: 'Ok',
      routes: [{ geometry: { type: 'LineString', coordinates: coords }, distance: distance, duration: duration, legs: [{ steps: steps }] }],
      meta: meta
    };
  }

  // ---------- 1. Valhalla ----------
  // 道路形状（精度6のエンコード文字列）を座標に戻す
  function decodePolyline(str, precision) {
    var f = Math.pow(10, precision || 6), idx = 0, lat = 0, lon = 0, out = [];
    while (idx < str.length) {
      var res = [0, 0];
      for (var k = 0; k < 2; k++) {
        var shift = 0, result = 0, b;
        do { b = str.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        res[k] = (result & 1) ? ~(result >> 1) : (result >> 1);
      }
      lat += res[0]; lon += res[1];
      out.push([lon / f, lat / f]);
    }
    return out;
  }

  // Valhallaの曲がり方の番号 → [種類, 方向]
  var VALHALLA_TYPE = {
    1: ['depart'], 2: ['depart'], 3: ['depart'],
    4: ['arrive'], 5: ['arrive', 'right'], 6: ['arrive', 'left'],
    7: ['new name', 'straight'], 8: ['continue', 'straight'],
    9: ['turn', 'slight right'], 10: ['turn', 'right'], 11: ['turn', 'sharp right'],
    12: ['turn', 'uturn'], 13: ['turn', 'uturn'],
    14: ['turn', 'sharp left'], 15: ['turn', 'left'], 16: ['turn', 'slight left'],
    17: ['on ramp', 'straight'], 18: ['on ramp', 'slight right'], 19: ['on ramp', 'slight left'],
    20: ['off ramp', 'slight right'], 21: ['off ramp', 'slight left'],
    22: ['fork', 'straight'], 23: ['fork', 'slight right'], 24: ['fork', 'slight left'],
    25: ['merge', 'straight'], 26: ['roundabout'], 27: ['exit roundabout'],
    28: ['notification'], 29: ['notification'],
    37: ['merge', 'straight'], 38: ['merge', 'straight']
  };

  function valhalla(from, to, o) {
    var start = { lat: from[1], lon: from[0] };
    if (o.heading != null) { start.heading = Math.round(o.heading) % 360; start.heading_tolerance = 60; }
    var req = {
      locations: [start, { lat: to[1], lon: to[0] }],
      costing: 'auto',
      costing_options: { auto: { use_tolls: o.avoidTolls ? 0 : 0.5 } },
      language: 'ja-JP', units: 'kilometers'
    };
    // 渋滞している区間など、通りたくない地点（その付近の道路を避ける）
    if (o.avoidPoints && o.avoidPoints.length) {
      req.exclude_locations = o.avoidPoints.map(function (p) { return { lat: p[1], lon: p[0] }; });
    }
    return request('https://valhalla1.openstreetmap.de/route?json=' + encodeURIComponent(JSON.stringify(req)), {}, 'valhalla')
      .then(function (r) {
        var j = r.json;
        if (!r.ok || !j || !j.trip) {
          var noroute = j && (j.error_code === 442 || j.error_code === 171 || /No path|No suitable/i.test(j.error || ''));
          throw RouteError(noroute ? '車で行けるルートが見つかりません' : '無料サーバー（Valhalla）が混雑しています', 'valhalla', noroute ? 'noroute' : 'error');
        }
        return fromValhalla(j, o);
      });
  }

  function isAscii(s) { return /^[\x00-\x7F]*$/.test(s); }

  // 交差点名：Valhallaは「甲府警察署前/Kofu Police Sta.を左方向です。」のように案内文に入れてくる
  function junctionName(m) {
    var els = m.sign && m.sign.junction_name_elements;
    if (els && els.length) {
      var t = els.map(function (e) { return e.text; }).filter(function (x) { return x && !isAscii(x); })[0];
      if (t) return t;
    }
    if (!('sign' in m) || !m.instruction) return '';
    var r = m.instruction.match(/^(.+?)を(左|右|斜め|大きく|Uターン|直進)/);
    if (!r) return '';
    var name = r[1].split('/')[0].trim();
    if (!name || isAscii(name) || /方向|です/.test(name)) return '';
    var streets = (m.street_names || []).concat(m.begin_street_names || []);
    return streets.indexOf(name) >= 0 ? '' : name;
  }

  function fromValhalla(j, o) {
    var leg = j.trip.legs[0];
    var coords = decodePolyline(leg.shape, 6);
    var steps = (leg.maneuvers || []).map(function (m) {
      var mm = VALHALLA_TYPE[m.type] || ['new name', 'straight'];
      var names = m.street_names || m.begin_street_names || [];
      var name = names.filter(function (n) { return !isAscii(n); })[0] || '';
      var ref = names.filter(function (n) { return /^\d+$/.test(n); })[0];
      var dest = '';
      if (m.sign) {
        var els = (m.sign.exit_toward_elements || []).concat(m.sign.exit_branch_elements || []);
        dest = els.map(function (e) { return e.text; }).filter(function (t) { return t && !isAscii(t); }).join(',');
      }
      var st = {
        maneuver: { type: mm[0], modifier: mm[1], location: coords[Math.min(m.begin_shape_index, coords.length - 1)] },
        name: name, distance: (m.length || 0) * 1000, duration: m.time || 0, instruction: m.instruction || ''
      };
      if (ref) st.ref = ref;
      if (dest) st.destinations = dest;
      var jn = junctionName(m);
      if (jn) st.junction = jn;
      if (mm[0] === 'roundabout') st.maneuver.exit = m.roundabout_exit_count || 1;
      return st;
    });
    var sum = j.trip.summary;
    return osrmShape(coords, sum.length * 1000, sum.time, steps, {
      provider: 'valhalla', label: '無料サーバー（Valhalla）', traffic: false,
      staticDuration: sum.time, hasToll: !!sum.has_toll, avoidTolls: !!o.avoidTolls
    });
  }

  // ---------- 2. OSRM（予備） ----------
  function osrm(from, to, o) {
    var url = 'https://router.project-osrm.org/route/v1/driving/' +
      from[0].toFixed(6) + ',' + from[1].toFixed(6) + ';' + to[0].toFixed(6) + ',' + to[1].toFixed(6) +
      '?overview=full&geometries=geojson&steps=true';
    if (o.heading != null) url += '&bearings=' + (Math.round(o.heading) % 360) + ',60;&radiuses=60;unlimited';
    return request(url, {}, 'osrm').then(function (r) {
      var j = r.json;
      if (j && j.code === 'Ok' && j.routes && j.routes.length) {
        j.meta = { provider: 'osrm', label: '予備サーバー（OSRM）', traffic: false, staticDuration: j.routes[0].duration, hasToll: null, avoidTolls: false };
        return j;
      }
      if (o.heading != null) { var o2 = {}; for (var k in o) o2[k] = o[k]; o2.heading = null; return osrm(from, to, o2); }
      throw RouteError(j && j.code === 'NoRoute' ? '車で行けるルートが見つかりません' : '予備サーバー（OSRM）でもルートを計算できません',
        'osrm', j && j.code === 'NoRoute' ? 'noroute' : 'error');
    });
  }

  // ---------- 窓口 ----------
  // o = { avoidTolls, heading, avoidPoints }
  function compute(from, to, o) {
    o = o || {};
    var chain = [valhalla, osrm];
    var errors = [];
    var i = 0;
    function next() {
      if (i >= chain.length) {
        var nr = errors.filter(function (e) { return e.kind === 'noroute'; }).length;
        var e = RouteError(nr >= 2 ? '車で行けるルートが見つかりませんでした' :
          errors.every(function (x) { return x.kind === 'network'; }) ? 'インターネットに接続できません' :
          'どのルートサーバーも応答しませんでした', 'all', nr >= 2 ? 'noroute' : 'error');
        e.errors = errors;
        return Promise.reject(e);
      }
      var fn = chain[i++];
      return fn(from, to, o).then(function (res) {
        var warn = [];
        if (o.avoidPoints && o.avoidPoints.length && res.meta.provider === 'osrm') warn.push('予備サーバーは区間の回避に対応していません');
        if (o.avoidTolls && res.meta.provider === 'osrm') warn.push('予備サーバーは有料道路の回避に対応していません');
        if (o.avoidTolls && res.meta.hasToll) warn.push('有料道路を通らないルートが見つからず、一部で有料道路を使います');
        res.meta.warnings = warn;
        res.meta.failed = errors.map(function (e) { return e.provider; });
        return res;
      }, function (e) {
        errors.push(e);
        return next();
      });
    }
    return next();
  }

  var api = { compute: compute, valhalla: valhalla, osrm: osrm, fromValhalla: fromValhalla, decodePolyline: decodePolyline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Routing = api;
})(this);
