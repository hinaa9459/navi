/*
 * navcore.js — ミチシルベの「ナビの頭脳」部分
 * 画面（DOM）には触らない純粋な計算だけを置いています。
 *   - 距離・方位の計算
 *   - ルート上のどこを走っているか（マップマッチング）
 *   - 次の曲がり角と案内文（日本語）の生成
 *   - 音声案内を「いつ」「何と」言うかの判定
 *   - ルート外れ（リルート）の判定、残り距離・到着予定の計算
 * ブラウザでは window.NavCore、Node.js では require() で使えます。
 */
(function (root) {
  'use strict';

  // ---------- 地理計算 ----------
  var R = 6371008.8;
  function rad(d) { return d * Math.PI / 180; }

  // 2点間の距離[m]（点は [経度, 緯度]）
  function dist(a, b) {
    var dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
    var h = Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.pow(Math.sin(dLon / 2), 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // a→b の方位[度] 北=0, 東=90
  function bearing(a, b) {
    var la = rad(a[1]), lb = rad(b[1]), dl = rad(b[0] - a[0]);
    var y = Math.sin(dl) * Math.cos(lb);
    var x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  // 方位の差（0〜180度）
  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  // 点pから線分abへの最短距離と、線分上の位置t(0〜1)
  function projectOnSegment(p, a, b) {
    var kx = Math.cos(rad(p[1])) * 111320, ky = 110574;
    var ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
    var bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    var t = L2 ? -(ax * dx + ay * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { t: t, d: Math.hypot(ax + t * dx, ay + t * dy) };
  }

  // ---------- 表示・読み上げ用の文字 ----------
  var DIR = {
    'right':        { turn: '右折',     side: '右' },
    'slight right': { turn: '斜め右',   side: '右' },
    'sharp right':  { turn: '大きく右', side: '右' },
    'left':         { turn: '左折',     side: '左' },
    'slight left':  { turn: '斜め左',   side: '左' },
    'sharp left':   { turn: '大きく左', side: '左' },
    'straight':     { turn: '直進',     side: '直進' },
    'uturn':        { turn: 'Uターン',  side: 'Uターン' }
  };

  function dirOf(step) {
    return DIR[(step.maneuver && step.maneuver.modifier) || 'straight'] || DIR.straight;
  }

  // 方面（出口・入口の行き先）
  function towards(step) {
    if (!step.destinations) return '';
    var first = String(step.destinations).split(/[,;、]/)[0].trim();
    if (!first) return '';
    return /(出口|入口|IC|JCT|インター|ジャンクション)$/.test(first) ? first : first + '方面';
  }

  // 「右折です」「左方向、出口です」などの案内文
  function phrase(step) {
    var m = step.maneuver, d = dirOf(step), t = m.type, to = towards(step);
    switch (t) {
      case 'arrive':
        return (m.modifier === 'left' || m.modifier === 'right') ? '目的地は' + d.side + '側です' : '目的地です';
      case 'roundabout':
      case 'rotary': return 'ロータリーを' + (m.exit || 1) + '番目の出口です';
      case 'roundabout turn': return 'ロータリーを' + d.turn + 'です';
      case 'exit roundabout':
      case 'exit rotary': return 'ロータリーを出ます';
      case 'on ramp':
        if (/入口$/.test(to)) return to + '、' + d.side + '方向です';
        return (to ? to + '、' : '') + d.side + '方向、入口です';
      case 'off ramp':
        if (/出口$/.test(to)) return to + '、' + d.side + '方向です';
        return (to ? to + '、' : '') + d.side + '方向、出口です';
      case 'fork': return (to ? to + '、' : '') + d.side + '方向です';
      case 'merge': return '合流です';
      case 'end of road': return '突き当たりを' + d.turn + 'です';
      default: return d.turn + 'です';
    }
  }

  // 曲がった先の道路名（バナーの小さい文字）
  function roadLabel(step) {
    if (step.maneuver.type === 'arrive') return '';
    var to = towards(step);
    if (to) return to;
    if (step.name) return step.name;
    if (step.ref) return String(step.ref).split(';')[0] + '号';
    return '';
  }

  // 画面表示用 "320 m" / "1.2 km"
  function formatDistance(m) {
    if (m < 0) m = 0;
    if (m < 100) return Math.max(0, Math.round(m / 10) * 10) + ' m';
    if (m < 1000) return Math.round(m / 50) * 50 + ' m';
    if (m < 10000) return (Math.round(m / 100) / 10).toFixed(1) + ' km';
    return Math.round(m / 1000) + ' km';
  }

  // 読み上げ用 "300メートル" / "1.5キロ"
  function speechDistance(m) {
    if (m < 300) return Math.max(100, Math.round(m / 50) * 50) + 'メートル';
    if (m < 950) return Math.round(m / 100) * 100 + 'メートル';
    var km = Math.round(m / 500) / 2;
    return (km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)) + 'キロ';
  }

  function formatDuration(sec) {
    var min = Math.max(1, Math.round(sec / 60));
    if (min < 60) return min + '分';
    return Math.floor(min / 60) + '時間' + (min % 60 ? (min % 60) + '分' : '');
  }

  // ---------- ルートの準備 ----------
  // 案内する必要がある曲がり角か？（道路名が変わるだけ等は案内しない）
  function isGuidance(step, prev) {
    var t = step.maneuver.type, mod = step.maneuver.modifier || 'straight';
    if (t === 'depart' || t === 'notification' || t === 'new name') return false;
    if (t === 'arrive' || t === 'roundabout' || t === 'rotary' || t === 'on ramp' || t === 'off ramp') return true;
    if (mod === 'straight' && t !== 'end of road') return false;
    if (t === 'continue' && /^slight/.test(mod) && prev && prev.name && prev.name === step.name) return false;
    return true;
  }

  // OSRMの返答を、走行中に使いやすい形に変換
  function prepareRoute(osrm) {
    var r = osrm.routes[0];
    var coords = r.geometry.coordinates;
    var cum = [0];
    for (var i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + dist(coords[i - 1], coords[i]);

    var steps = r.legs[0].steps;
    var k = 0;
    for (var s = 0; s < steps.length; s++) {
      var loc = steps[s].maneuver.location, best = k, bd = Infinity;
      for (var j = k; j < coords.length; j++) {
        var d = dist(loc, coords[j]);
        if (d < bd) { bd = d; best = j; }
        if (bd < 1 && d > 300) break;
      }
      k = best;
      steps[s].at = cum[best];          // ルート始点からこの曲がり角までの距離
      steps[s].index = s;
    }
    // 高速の入口に名前が無いときは、入った先の道路名を表示する
    for (s = 0; s + 1 < steps.length; s++) {
      var st = steps[s];
      if (st.maneuver.type === 'on ramp' && !st.name && !st.destinations && !st.ref) st.name = steps[s + 1].name || '';
    }
    var guides = [];
    for (s = 0; s < steps.length; s++) {
      if (isGuidance(steps[s], steps[s - 1])) guides.push(steps[s]);
    }
    return {
      coords: coords, cum: cum, steps: steps, guides: guides,
      total: cum[cum.length - 1], duration: r.duration, distance: r.distance,
      seg: 0, spoken: {}, lastGuide: -1
    };
  }

  // ---------- 走行中の位置合わせ ----------
  // 現在地 p をルートに当てはめ、{dev: ルートからのずれ[m], along: 始点からの走行距離[m]}
  function snap(route, p) {
    var c = route.coords;
    var best = { d: Infinity, i: 0, t: 0 };
    function scan(lo, hi) {
      for (var i = lo; i <= hi; i++) {
        var pr = projectOnSegment(p, c[i], c[i + 1]);
        if (pr.d < best.d) best = { d: pr.d, i: i, t: pr.t };
      }
    }
    var last = c.length - 2;
    if (last < 0) return { dev: dist(p, c[0]), along: 0, seg: 0 };
    scan(Math.max(0, route.seg - 5), Math.min(last, route.seg + 400));
    if (best.d > 60) scan(0, last); // 見失ったら全区間を探し直す
    route.seg = best.i;
    var segLen = route.cum[best.i + 1] - route.cum[best.i];
    return { dev: best.d, along: route.cum[best.i] + best.t * segLen, seg: best.i };
  }

  // ルート上の距離 along の地点座標と道の向き
  function pointAt(route, along) {
    var c = route.coords, cum = route.cum;
    if (along <= 0) return { p: c[0], heading: bearing(c[0], c[1] || c[0]) };
    if (along >= route.total) {
      var n = c.length;
      return { p: c[n - 1], heading: bearing(c[Math.max(0, n - 2)], c[n - 1]) };
    }
    var lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= along) lo = mid; else hi = mid; }
    var t = (along - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
    return {
      p: [c[lo][0] + (c[hi][0] - c[lo][0]) * t, c[lo][1] + (c[hi][1] - c[lo][1]) * t],
      heading: bearing(c[lo], c[hi])
    };
  }

  // 次に案内する曲がり角（通過直後の数mは通過済み扱い）
  function nextGuide(route, along) {
    for (var i = 0; i < route.guides.length; i++) {
      if (route.guides[i].at > along + 8) return { guide: route.guides[i], gi: i };
    }
    var g = route.guides[route.guides.length - 1];
    return { guide: g, gi: route.guides.length - 1 };
  }

  // 残り時間[秒]：OSRMの各区間の所要時間を、走った割合で按分
  function remainingSeconds(route, along) {
    var st = route.steps, sec = 0;
    for (var i = 0; i < st.length; i++) {
      var start = st[i].at, end = i + 1 < st.length ? st[i + 1].at : route.total;
      if (end <= along) continue;
      var len = end - start;
      if (start >= along || len <= 0) sec += st[i].duration;
      else sec += st[i].duration * (end - along) / len;
    }
    return sec;
  }

  // ---------- 音声案内の判定 ----------
  // 1回の位置更新ごとに呼ぶ。戻り値: { speak: 読み上げ文 or null, arrived: bool, ...表示用 }
  function update(route, p, speedMs) {
    var sn = snap(route, p);
    var along = sn.along;
    var ng = nextGuide(route, along);
    var g = ng.guide, gi = ng.gi;
    var toNext = Math.max(0, g.at - along);
    var remaining = Math.max(0, route.total - along);
    var v = speedMs || 0;
    var out = {
      along: along, dev: sn.dev, guide: g, guideIndex: gi, toNext: toNext,
      // etaScale: 案内中に渋滞を再確認して得た補正（1 = 補正なし）
      remaining: remaining, remainingSec: remainingSeconds(route, along) * (route.etaScale || 1),
      speak: null, arrived: false
    };

    // 到着
    if (remaining < 30 || (g.maneuver.type === 'arrive' && toNext < 30)) {
      out.arrived = true;
      return out;
    }

    var said = route.spoken[gi] || (route.spoken[gi] = { tiers: {}, lastAt: null, soon: false });
    var prevAt = gi > 0 ? route.guides[gi - 1].at : 0;
    var legLen = g.at - prevAt;
    var highway = v > 22; // 約80km/h超
    var tiers = highway ? [2000, 1000, 500] : [700, 300];
    var soonDist = Math.max(50, Math.min(160, v * 7)); // 約7秒手前で「まもなく」
    var text = phrase(g);

    // 曲がり角を通過した直後：次が遠ければ「しばらく道なり」
    if (route.lastGuide !== gi) {
      var first = route.lastGuide === -1;
      route.lastGuide = gi;
      if (!first && toNext > 2500) {
        out.speak = 'この先、しばらく道なりです';
        said.lastAt = along;
        return out;
      }
    }

    // 「まもなく」
    if (!said.soon && toNext <= soonDist) {
      said.soon = true;
      var then = route.guides[gi + 1];
      var chain = then && then.at - g.at < 120 ? '。その先、' + phrase(then) : '';
      out.speak = 'まもなく、' + text + chain;
      said.lastAt = along;
      return out;
    }

    // 「○○メートル先、右折です」
    for (var i = tiers.length - 1; i >= 0; i--) {
      var T = tiers[i];
      if (said.tiers[T]) continue;
      if (toNext <= T && toNext > soonDist + 60) {
        for (var k = 0; k < tiers.length; k++) if (tiers[k] >= T) said.tiers[tiers[k]] = true;
        var recent = said.lastAt !== null && along - said.lastAt < 150;
        if (!recent && legLen > Math.min(T * 0.5, 250)) {
          out.speak = speechDistance(toNext) + '先、' + text;
          said.lastAt = along;
        }
        break;
      }
    }
    return out;
  }

  // 案内開始時のひとこと
  function startMessage(route) {
    var ng = nextGuide(route, 0), g = ng.guide;
    var head = 'ルート案内を開始します。所要時間は約' + formatDuration(route.duration) + 'です。';
    if (g.maneuver.type === 'arrive') return head;
    if (g.at > 2500) return head + 'しばらく道なりです';
    return head + speechDistance(g.at) + '先、' + phrase(g);
  }

  // ---------- ルート外れの判定 ----------
  // 連続して大きく外れたら true
  function makeOffRouteDetector() {
    var count = 0;
    return function (dev, accuracy, speedMs) {
      var limit = Math.max(45, (accuracy || 0) * 1.3);
      if (dev > limit && (speedMs || 0) > 1) count++;
      else count = 0;
      if (count >= 3) { count = 0; return true; }
      return false;
    };
  }

  // ---------- 渋滞への対応 ----------
  // ① 実際の走行ペースから到着予定を補正する
  // ② のろのろ運転（約8km/h未満）が2分半続いたら「この先を避ける」を提案する
  function makeTrafficWatcher() {
    var pace = [], factor = 1, slowSince = null, offered = false;
    var w = {
      reset: function () { pace = []; factor = 1; slowSince = null; offered = false; },
      // u: update() の戻り値, now: 現在時刻[ms]
      tick: function (route, u, speedMs, now) {
        var planned = remainingSeconds(route, u.along);
        pace.push({ t: now, p: planned });
        while (pace.length > 1 && now - pace[0].t > 10 * 60 * 1000) pace.shift(); // 直近10分
        var o = pace[0], done = o.p - planned, actual = (now - o.t) / 1000;
        // 予定より遅い・速いの比率（0.85〜3倍に制限）
        if (actual >= 180) factor = Math.max(0.85, Math.min(3, actual / Math.max(done, 30)));
        // いまのペースが、この先およそ15分ぶん続くと仮定して残り時間を補正
        var base = u.remainingSec;
        var adjusted = base + (factor - 1) * Math.min(base, 15 * 60);

        var res = { adjustedSec: adjusted, lateMin: Math.round((adjusted - base) / 60), offerAvoid: false, cleared: false };
        if (u.remaining < 1000 || u.along < 200) { slowSince = null; return res; }
        if (speedMs < 2.3) { if (slowSince === null) slowSince = now; }
        else if (speedMs > 5.5) {
          if (offered) res.cleared = true;
          slowSince = null; offered = false;
        }
        if (slowSince !== null && !offered && now - slowSince > 150000) { offered = true; res.offerAvoid = true; }
        return res;
      },
      // 新しいルートに切り替えたとき（ペースの記録だけ捨てる）
      newRoute: function () { pace = []; slowSince = null; offered = false; }
    };
    return w;
  }

  var api = {
    makeTrafficWatcher: makeTrafficWatcher,
    dist: dist, bearing: bearing, angleDiff: angleDiff, projectOnSegment: projectOnSegment,
    phrase: phrase, roadLabel: roadLabel, formatDistance: formatDistance,
    speechDistance: speechDistance, formatDuration: formatDuration,
    isGuidance: isGuidance, prepareRoute: prepareRoute, snap: snap, pointAt: pointAt,
    nextGuide: nextGuide, remainingSeconds: remainingSeconds, update: update,
    startMessage: startMessage, makeOffRouteDetector: makeOffRouteDetector
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NavCore = api;
})(this);
