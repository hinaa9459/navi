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

  // 歩行者向けの言い方（「右折」ではなく「右方向」）
  var DIR_FOOT = {
    'right': { turn: '右方向', side: '右' }, 'slight right': { turn: '斜め右方向', side: '右' }, 'sharp right': { turn: '大きく右方向', side: '右' },
    'left': { turn: '左方向', side: '左' }, 'slight left': { turn: '斜め左方向', side: '左' }, 'sharp left': { turn: '大きく左方向', side: '左' },
    'straight': { turn: '直進', side: '直進' }, 'uturn': { turn: '引き返す方向', side: '引き返す' }
  };

  function dirOf(step) {
    var table = step.foot ? DIR_FOOT : DIR;
    return table[(step.maneuver && step.maneuver.modifier) || 'straight'] || table.straight;
  }

  // 方面（出口・入口の行き先）
  function towards(step) {
    if (!step.destinations) return '';
    var first = String(step.destinations).split(/[,;、]/)[0].replace(/[（(][^）)]*[）)]/g, '').trim();
    if (!first) return '';
    return /(出口|入口|IC|JCT|インター|ジャンクション)$/.test(first) ? first : first + '方面';
  }

  // 出口名：「台場」→「台場出口」、「伊勢西IC」→「伊勢西IC出口」、JCTはそのまま（JCTは出口ではない）
  function exitLabel(step) {
    var n = String(step.exitName).trim();
    if (/(JCT|ジャンクション)$/.test(n)) return n;
    if (/出口$/.test(n)) return n;
    return n + '出口';
  }

  // 「新千歳空港IC出口」「新千歳空港方面」→「新千歳空港」（同じ地名かどうかの比較用）
  function baseName(n) { return String(n || '').replace(/(IC出口|インター出口|出口|方面|IC|JCT|インター)$/, ''); }

  // 道路名（なければ路線番号）
  function roadName(step) { return step.name || refLabel(step.ref); }

  /*
   * 案内文を作る唯一の関数。読み上げ・案内板・「その先」はすべてここから作る。
   * （読み上げと案内板で別々に組み立てると、片方だけ直して食い違うため）
   *   say    : 読み上げ（例「伊勢西IC出口、伊勢市街方面、左方向です」）
   *   action : 案内板の大きい文字（例「左方向」）
   *   sign   : 案内板の標識風の枠（交差点名・IC/JCT/出口名）。表示したものは必ず読み上げにも入る
   *   sub    : 案内板の小さい文字（方面・道路名）
   */
  function describe(step) {
    var m = step.maneuver, t = m.type, d = dirOf(step), to = towards(step), foot = !!step.foot;
    if (foot && (t === 'on ramp' || t === 'off ramp')) t = 'fork'; // 徒歩に高速の入口・出口の言い方は使わない
    var jn = step.junction || '';
    var exit = step.exitName && !foot && (t === 'off ramp' || t === 'fork') ? exitLabel(step) : ''; // 出口名は車のときだけ
    // 出口名と方面が同じ地名なら方面は言わない（「錦橋出口、錦橋方面」→「錦橋出口」）
    if (exit && to && baseName(to) && baseName(exit).indexOf(baseName(to)) === 0) to = '';
    var r = { say: '', action: '', sign: '', sub: '' };
    switch (t) {
      case 'arrive':
        r.action = (m.modifier === 'left' || m.modifier === 'right') ? '目的地は' + d.side + '側' : '目的地';
        r.say = r.action + 'です';
        return r;
      case 'roundabout':
      case 'rotary':
        r.action = 'ロータリー ' + (m.exit || 1) + '番目の出口';
        r.say = 'ロータリーを' + (m.exit || 1) + '番目の出口です';
        r.sub = roadName(step);
        return r;
      case 'roundabout turn':
        r.action = 'ロータリーを' + d.turn; r.say = r.action + 'です'; r.sub = roadName(step);
        return r;
      case 'exit roundabout':
      case 'exit rotary':
        r.action = 'ロータリーを出る'; r.say = 'ロータリーを出ます'; r.sub = roadName(step);
        return r;
      case 'facility': {
        // 徒歩の階段・エスカレーターなど、フェリーの乗り降り
        var F = { 'steps': '階段', 'escalator': 'エスカレーター', 'elevator': 'エレベーター',
          'building enter': '建物に入ります', 'building exit': '建物を出ます', 'ferry enter': 'フェリーに乗ります', 'ferry exit': 'フェリーを降ります' };
        var f = F[step.facility] || '案内地点';
        r.action = f.replace(/ます$/, 'る');
        r.say = /ます$/.test(f) ? f : f + 'です';
        r.sub = roadName(step);
        return r;
      }
      case 'on ramp':
        r.action = d.side + '方向 入口';
        r.sub = step.name || to || refLabel(step.ref);
        r.say = /入口$/.test(to) ? to + '、' + d.side + '方向です' : (to ? to + '、' : '') + d.side + '方向、入口です';
        if (jn) { r.sign = jn; r.say = jn + 'を' + d.side + '方向、入口です'; }
        return r;
      case 'off ramp':
      case 'fork':
        r.action = d.side + '方向';
        r.sign = exit || jn;
        if (exit) r.say = exit + '、' + (to ? to + '、' : '') + d.side + '方向です';
        else if (jn) r.say = jn + 'を' + d.side + '方向です' ;
        else if (t === 'off ramp') r.say = /出口$/.test(to) ? to + '、' + d.side + '方向です' : (to ? to + '、' : '') + d.side + '方向、出口です';
        else if (to) r.say = to + '、' + d.side + '方向です';
        else if (step.name && !foot) r.say = d.side + '方向、' + step.name + 'です';
        else r.say = d.side + '方向です';
        r.sub = to || (r.sign ? '' : roadName(step));
        break;
      case 'merge':
        r.action = '合流';
        r.sub = roadName(step);
        r.say = step.name && !foot ? step.name + 'に合流です' : '合流です';
        break;
      case 'end of road':
        r.action = '突き当たりを' + d.turn;
        r.sign = jn;
        r.say = jn ? '突き当たり、' + jn + 'を' + d.turn + 'です' : r.action + 'です';
        r.sub = to || roadName(step);
        break;
      default:
        r.action = d.turn;
        r.sign = jn;
        r.say = jn ? jn + 'を' + d.turn + 'です' : d.turn + 'です';
        r.sub = to || roadName(step);
    }
    if (r.sign && r.sub === r.sign) r.sub = '';
    return r;
  }

  // 以前からの呼び名（中身はすべて describe）
  function phrase(step) { return describe(step).say; }
  function speechPhrase(step) { return describe(step).say; }
  function bannerParts(step) { var r = describe(step); return { action: r.action, sign: r.sign, sub: r.sub }; }
  function roadLabel(step) { var r = describe(step); return r.sign || r.sub; }

  // いま走っている道路の名前
  function currentRoad(route, along) {
    var st = route.steps, cur = null;
    for (var i = 0; i < st.length; i++) if (st[i].at <= along + 1 && st[i].maneuver.type !== 'arrive') cur = st[i];
    if (!cur) return '';
    return cur.name || refLabel(cur.ref);
  }

  // 路線番号の表示：「20」→「20号」、「E1A」はそのまま
  var EXPRESSWAY = { E1: '東名高速道路', E1A: '新東名高速道路', E2: '山陽自動車道', E2A: '中国自動車道', E4: '東北自動車道', E6: '常磐自動車道',
    E8: '北陸自動車道', E13: '東北中央自動車道', E17: '関越自動車道', E20: '中央自動車道', E52: '中部横断自動車道' };
  function refLabel(ref) {
    if (!ref) return '';
    var r = String(ref).split(';')[0];
    if (/^\d+$/.test(r)) return r + '号';
    return EXPRESSWAY[r] || r;
  }

  // 画面表示用 "320 m" / "1.2 km"
  function formatDistance(m) {
    if (m < 0) m = 0;
    if (m < 100) return Math.max(0, Math.round(m / 10) * 10) + ' m';
    if (m < 1000) return Math.round(m / 50) * 50 + ' m';
    if (m < 10000) return (Math.round(m / 100) / 10).toFixed(1) + ' km';
    return Math.round(m / 1000) + ' km';
  }

  // 読み上げ用 "300メートル" / "1.5キロ"（徒歩は "50メートル" まで細かく）
  function speechDistance(m, foot) {
    if (foot && m < 100) return Math.max(10, Math.round(m / 10) * 10) + 'メートル';
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
    if (t === 'arrive' || t === 'roundabout' || t === 'rotary' || t === 'on ramp' || t === 'off ramp' || t === 'facility') return true;
    if (mod === 'straight' && t !== 'end of road') return false;
    if (t === 'continue' && /^slight/.test(mod) && prev && prev.name && prev.name === step.name) return false;
    return true;
  }

  // OSRMの返答を、走行中に使いやすい形に変換
  function prepareRoute(osrm) {
    var r = osrm.routes[0];
    var foot = !!(osrm.meta && osrm.meta.profile === 'foot');
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
      if (foot) steps[s].foot = true;
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
      total: cum[cum.length - 1], duration: r.duration, distance: r.distance, foot: foot,
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

  // ルート上の今いる地点から、少し先（既定30m）を見た向き。止まっていても「進む方向」が分かる
  function headingAhead(route, along, ahead) {
    var a = pointAt(route, along).p, b = pointAt(route, Math.min(route.total, along + (ahead || 30))).p;
    if (dist(a, b) < 3) return pointAt(route, along).heading;
    return bearing(a, b);
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

    var foot = !!route.foot;
    var arriveDist = foot ? 15 : 30;
    // 到着
    if (remaining < arriveDist || (g.maneuver.type === 'arrive' && toNext < arriveDist)) {
      out.arrived = true;
      return out;
    }

    var said = route.spoken[gi] || (route.spoken[gi] = { tiers: {}, lastAt: null, soon: false });
    var prevAt = gi > 0 ? route.guides[gi - 1].at : 0;
    var legLen = g.at - prevAt;
    var highway = !foot && v > 22; // 約80km/h超
    var tiers = foot ? [100, 40] : highway ? [2000, 1000, 500] : [700, 300];
    var soonDist = foot ? 12 : Math.max(50, Math.min(160, v * 7)); // 車は約7秒手前、徒歩は12m手前で「まもなく」
    var quiet = foot ? 25 : 150;      // 直前の読み上げからこの距離は黙る
    var straightLong = foot ? 400 : 2500;
    var chainGap = foot ? 30 : 120;
    var text = speechPhrase(g);

    // 曲がり角を通過した直後：次が遠ければ「しばらく道なり」
    if (route.lastGuide !== gi) {
      var first = route.lastGuide === -1;
      route.lastGuide = gi;
      if (!first && toNext > straightLong) {
        out.speak = foot ? 'この先、しばらく直進です'
          : toNext >= 10000 ? 'この先、およそ' + Math.round(toNext / 1000) + 'キロ道なりです' : 'この先、しばらく道なりです';
        said.lastAt = along;
        return out;
      }
    }

    // 「まもなく」
    if (!said.soon && toNext <= soonDist) {
      said.soon = true;
      var then = route.guides[gi + 1];
      var chain = then && then.at - g.at < chainGap ? '。その先、' + speechPhrase(then) : '';
      out.speak = 'まもなく、' + text + chain;
      said.lastAt = along;
      return out;
    }

    // 「○○メートル先、右折です」
    for (var i = tiers.length - 1; i >= 0; i--) {
      var T = tiers[i];
      if (said.tiers[T]) continue;
      if (toNext <= T && toNext > soonDist + (foot ? 10 : 60)) {
        for (var k = 0; k < tiers.length; k++) if (tiers[k] >= T) said.tiers[tiers[k]] = true;
        var recent = said.lastAt !== null && along - said.lastAt < quiet;
        if (!recent && legLen > Math.min(T * 0.5, 250)) {
          out.speak = speechDistance(toNext, foot) + '先、' + text;
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
    var head = route.foot ? '徒歩の案内を開始します。約' + formatDuration(route.duration) + 'です。'
      : 'ルート案内を開始します。所要時間は約' + formatDuration(route.duration) + 'です。';
    if (g.maneuver.type === 'arrive') return head;
    if (g.at > (route.foot ? 400 : 2500)) return head + (route.foot ? 'しばらく直進です' : 'しばらく道なりです');
    return head + speechDistance(g.at, route.foot) + '先、' + speechPhrase(g);
  }

  // ---------- ルート外れの判定 ----------
  // 連続して大きく外れたら true
  // foot = true のときは徒歩用（GPSの誤差が相対的に大きいので、ゆっくり判定）
  function makeOffRouteDetector(foot) {
    var count = 0;
    return function (dev, accuracy, speedMs) {
      var limit = foot ? Math.max(30, (accuracy || 0) * 1.5) : Math.max(45, (accuracy || 0) * 1.3);
      if (dev > limit && (speedMs || 0) > (foot ? 0.3 : 1)) count++;
      else count = 0;
      if (count >= (foot ? 4 : 3)) { count = 0; return true; }
      return false;
    };
  }

  // ---------- 渋滞への対応 ----------
  // ① 実際の走行ペースから到着予定を補正する
  // ② のろのろ運転（約8km/h未満）が2分半続いたら「この先を避ける」を提案する
  function makeTrafficWatcher() {
    var pace = [], factor = 1, slowSince = null, offered = false, offeredAt = 0, slowAlong = 0, stopSince = null;
    var w = {
      reset: function () { pace = []; factor = 1; slowSince = null; offered = false; stopSince = null; },
      // u: update() の戻り値, now: 現在時刻[ms]
      tick: function (route, u, speedMs, now) {
        var planned = remainingSeconds(route, u.along);
        // 5分以上止まっていたら休憩とみなし、それまでのペースは到着予定の補正に使わない
        if (speedMs < 0.5) { if (stopSince === null) stopSince = now; }
        else {
          if (stopSince !== null && now - stopSince > 5 * 60 * 1000) { pace = []; factor = 1; }
          stopSince = null;
        }
        var resting = stopSince !== null && now - stopSince > 5 * 60 * 1000;
        if (!resting) pace.push({ t: now, p: planned });
        else pace = [];
        while (pace.length > 1 && now - pace[0].t > 10 * 60 * 1000) pace.shift(); // 直近10分
        var o = pace[0] || { t: now, p: planned }, done = o.p - planned, actual = (now - o.t) / 1000;
        // 予定より遅い・速いの比率（0.85〜3倍に制限）
        if (actual >= 180) factor = Math.max(0.85, Math.min(3, actual / Math.max(done, 30)));
        if (resting) factor = 1;
        // いまのペースが、この先およそ15分ぶん続くと仮定して残り時間を補正
        var base = u.remainingSec;
        var adjusted = base + (factor - 1) * Math.min(base, 15 * 60);

        var res = { adjustedSec: adjusted, lateMin: Math.round((adjusted - base) / 60), offerAvoid: false, cleared: false };
        if (u.remaining < 1000 || u.along < 200) { slowSince = null; return res; }
        if (speedMs < 2.3) { if (slowSince === null) { slowSince = now; slowAlong = u.along; } }
        else if (speedMs > 5.5) {
          if (offered) res.cleared = true;
          slowSince = null; offered = false;
        }
        // 渋滞が続いていれば5分ごとに別ルートを調べ直す
        if (offered && slowSince !== null && now - offeredAt > 5 * 60 * 1000) offered = false;
        // のろのろでも少しずつ進んでいるときだけ渋滞とみなす（駐車場で止まっているだけなら出さない）
        if (slowSince !== null && !offered && now - slowSince > 150000 && u.along - slowAlong > 40) { offered = true; offeredAt = now; res.offerAvoid = true; }
        res.factor = factor;
        return res;
      },
      // 新しいルートに切り替えたとき（ペースの記録だけ捨てる）
      newRoute: function () { pace = []; slowSince = null; offered = false; }
    };
    return w;
  }

  // ---------- 渋滞時の別ルート比較 ----------
  // いまのルートの残り（route の along より先）と、別ルート altCoords が、どれだけ同じ道を通るか（0〜1）
  // 別ルートの最初の15kmだけを比べる（分かれる場所が大事なので）
  function routeOverlap(route, along, altCoords) {
    var cur = [], d;
    for (d = along; d <= route.total; d += 50) cur.push(pointAt(route, d).p);
    var alt = [], acc = 0;
    alt.push(altCoords[0]);
    for (var i = 1; i < altCoords.length && acc < 15000; i++) {
      var seg = dist(altCoords[i - 1], altCoords[i]);
      acc += seg;
      if (dist(alt[alt.length - 1], altCoords[i]) >= 50) alt.push(altCoords[i]);
    }
    if (!cur.length || alt.length < 2) return 1;
    var same = 0;
    alt.forEach(function (p) {
      for (var j = 0; j < cur.length; j++) if (dist(p, cur[j]) < 40) { same++; return; }
    });
    return same / alt.length;
  }

  // 別ルートに替えるべきか。curSec＝いまのルートの残り時間（渋滞の補正込み）、altSec＝別ルートの所要時間
  // 3分以上かつ残り時間の8%以上早く、道もはっきり違うときだけ勧める（わずかな差で振り回さない）
  function compareJam(curSec, altSec, overlap) {
    var save = curSec - altSec, saveMin = Math.round(save / 60);
    if (overlap >= 0.85) return { offer: false, saveMin: saveMin, reason: 'same' };
    if (saveMin >= 3 && save >= curSec * 0.08) return { offer: true, saveMin: saveMin, reason: 'faster' };
    return { offer: false, saveMin: saveMin, reason: 'notFaster' };
  }

  // ---------- 交通情報（事故・規制）の参照先 ----------
  // ルートの高速道路区間がある都道府県（都道府県コード）と道路名から、見るべき高速道路会社を決める
  var EXPRESSWAY_CO = {
    nexcoE: { name: 'NEXCO東日本 ドラとら', note: '東日本の高速道路の事故・規制・渋滞', url: 'https://www.drivetraffic.jp/' },
    nexcoC: { name: 'NEXCO中日本 アイハイウェイ', note: '中央道・東名・新東名・伊勢道などの事故・規制・渋滞', url: 'https://www.c-ihighway.jp/' },
    nexcoW: { name: 'NEXCO西日本 交通情報', note: '西日本の高速道路の事故・規制・渋滞', url: 'https://www.w-nexco.co.jp/traffic_info/' },
    shutoko: { name: '首都高 交通情報', note: '首都高速の事故・規制・渋滞', url: 'https://www.shutoko.jp/' },
    hanshin: { name: '阪神高速 交通情報', note: '阪神高速の事故・規制・渋滞', url: 'https://www.hanshin-exp.co.jp/drivers/' }
  };
  function prefNexco(code) {
    var c = +code, out = [];
    if (c >= 1 && c <= 15 || c === 20) out.push('nexcoE');                       // 北海道・東北・関東・新潟・長野
    if (c === 13 || c === 14 || (c >= 16 && c <= 24)) out.push('nexcoC');         // 東京・神奈川（中央道・東名）、北陸、山梨〜三重
    if (c === 18 || c >= 25) out.push('nexcoW');                                  // 福井（一部）、近畿〜九州・沖縄
    return out;
  }
  // 高速道路の区間か（道路名・路線番号・出口名で判定）
  function isExpresswayStep(st) {
    return /自動車道|高速|首都高|有料道路|阪神高速/.test(st.name || '') || /^E\d/.test(String(st.ref || '')) || !!st.exitName;
  }
  // prefCodes：高速区間の地点の都道府県コード（2桁）一覧、roadNames：ルートの道路名一覧
  function trafficCompanies(prefCodes, roadNames) {
    var keys = [];
    function add(k) { if (keys.indexOf(k) < 0) keys.push(k); }
    var names = roadNames.join(' ');
    if (/首都高/.test(names)) add('shutoko');
    if (/阪神高速/.test(names)) add('hanshin');
    var nexcoRoad = /自動車道|東名|名神|新東名|新名神|道央道|東関東/.test(names);
    if (nexcoRoad || prefCodes.length) prefCodes.forEach(function (p) { prefNexco(p).forEach(add); });
    return keys.map(function (k) { return EXPRESSWAY_CO[k]; });
  }

  var api = {
    trafficCompanies: trafficCompanies, isExpresswayStep: isExpresswayStep, prefNexco: prefNexco,
    makeTrafficWatcher: makeTrafficWatcher, routeOverlap: routeOverlap, compareJam: compareJam, describe: describe, headingAhead: headingAhead, exitLabel: exitLabel, speechPhrase: speechPhrase, currentRoad: currentRoad, bannerParts: bannerParts, refLabel: refLabel,
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
