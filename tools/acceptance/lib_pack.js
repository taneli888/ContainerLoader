/* 独立排布器：作为"对照答案"。只求下界（能做到多少），不追求证明最优。
   1) maxSame：单一规格在 L×W 柜底最多能平放几托（枚举 1~3 段切分 + 随机 BL）
   2) maxMixed：必装全部放入后，补柜规格最多还能加几托（随机 BL 多次重启）
*/
'use strict';

function gridCount(len, wid, l, w) {
  return Math.floor(len / l) * Math.floor(wid / w);
}

function best2Block(L, W, l, w, step) {
  step = step || 5;
  var best = Math.max(gridCount(L, W, l, w), gridCount(L, W, w, l));
  var ors = [[l, w], [w, l]];
  // 沿长度切两段
  for (var t = step; t < L; t += step) {
    for (var o1 = 0; o1 < 2; o1++) {
      for (var o2 = 0; o2 < 2; o2++) {
        var c = gridCount(t, W, ors[o1][0], ors[o1][1]) + gridCount(L - t, W, ors[o2][0], ors[o2][1]);
        if (c > best) best = c;
      }
    }
  }
  // 沿宽度切两段
  for (var s = step; s < W; s += step) {
    for (var p1 = 0; p1 < 2; p1++) {
      for (var p2 = 0; p2 < 2; p2++) {
        var c2 = gridCount(L, s, ors[p1][0], ors[p1][1]) + gridCount(L, W - s, ors[p2][0], ors[p2][1]);
        if (c2 > best) best = c2;
      }
    }
  }
  return best;
}

function best3Block(L, W, l, w, step) {
  step = step || 20;
  var best = 0, ors = [[l, w], [w, l]];
  for (var t1 = step; t1 < L - step; t1 += step) {
    var a1 = Math.max(gridCount(t1, W, l, w), gridCount(t1, W, w, l));
    for (var t2 = t1 + step; t2 < L; t2 += step) {
      var a2 = Math.max(gridCount(t2 - t1, W, l, w), gridCount(t2 - t1, W, w, l));
      var a3 = Math.max(gridCount(L - t2, W, l, w), gridCount(L - t2, W, w, l));
      if (a1 + a2 + a3 > best) best = a1 + a2 + a3;
    }
  }
  return best;
}

/* ---------- 通用 BL（bottom-left）排布，支持多规格与随机重启 ---------- */
function blPack(L, W, items, rotate, rnd) {
  // items: [{l,w,id}] 依次尝试放到 (x,y) 最小处；返回 placements 或 null
  var placed = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var cands = [];
    var ors = [[it.l, it.w, false]];
    if (rotate && it.l !== it.w) ors.push([it.w, it.l, true]);
    var xs = [0], ys = [0];
    placed.forEach(function (q) { xs.push(q.x + q.l); ys.push(q.y + q.w); });
    xs = xs.filter(function (v, k, arr) { return arr.indexOf(v) === k; }).sort(function (a, b) { return a - b; });
    ys = ys.filter(function (v, k, arr) { return arr.indexOf(v) === k; }).sort(function (a, b) { return a - b; });
    var best = null;
    ors.forEach(function (o) {
      xs.forEach(function (x) {
        ys.forEach(function (y) {
          if (x + o[0] > L + 1e-6 || y + o[1] > W + 1e-6) return;
          for (var k = 0; k < placed.length; k++) {
            var q = placed[k];
            if (x < q.x + q.l - 1e-6 && q.x < x + o[0] - 1e-6 &&
                y < q.y + q.w - 1e-6 && q.y < y + o[1] - 1e-6) return;
          }
          if (!best || x < best.x - 1e-6 || (Math.abs(x - best.x) < 1e-6 && y < best.y - 1e-6)) {
            best = { x: x, y: y, l: o[0], w: o[1], rotated: o[2] };
          }
        });
      });
    });
    if (!best) return null;
    placed.push({ x: best.x, y: best.y, l: best.l, w: best.w, id: it.id, rotated: best.rotated, fill: !!it.fill });
  }
  return placed;
}

function shuffle(arr, rnd) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function mulberry(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function maxSame(L, W, l, w, rotate) {
  var best = Math.max(gridCount(L, W, l, w), rotate ? gridCount(L, W, w, l) : 0);
  var b2 = best2Block(L, W, l, w, 5);
  if (b2 > best) best = b2;
  if (rotate) {
    var b3 = best3Block(L, W, l, w, 25);
    if (b3 > best) best = b3;
  }
  // 随机 BL 再确认
  var rnd = mulberry(12345);
  var item = { l: l, w: w, id: 'x' };
  for (var trial = 0; trial < 200; trial++) {
    var arr = [];
    var n = best + 1;
    for (var i = 0; i < n; i++) arr.push(item);
    var r = blPack(L, W, arr, rotate, rnd);
    if (r) { best = n; break; }
  }
  return best;
}

/* 必装全部放入，补柜尽量多；返回最多补柜数（下界） */
function maxMixed(L, W, required, fill, rotate, trials) {
  trials = trials || 400;
  var rnd = mulberry(987654);
  var base = [];
  required.forEach(function (t) {
    for (var i = 0; i < t.qty; i++) base.push({ l: t.l, w: t.w, id: t.id });
  });
  var bestFill = -1;
  var bestPl = null;
  for (var tr = 0; tr < trials; tr++) {
    var seq = shuffle(base, rnd);
    var pl = blPack(L, W, seq, rotate, rnd);
    if (!pl) continue;
    // 用补柜规格反复尝试填空
    var cur = pl.slice();
    var added = 0;
    if (fill) {
      for (var guard = 0; guard < 200; guard++) {
        var probe = cur.concat([{ l: fill.l, w: fill.w, id: fill.id, fill: true }]);
        // 逐个追加：blPack 从空开始会重排，所以单独用贪心追加
        var one = tryAppend(L, W, cur, fill, rotate);
        if (!one) break;
        cur.push(one);
        added++;
      }
    }
    if (added > bestFill) { bestFill = added; bestPl = cur; }
    if (tr === 0 && !fill) { bestPl = pl; bestFill = 0; }
  }
  if (!fill) return { fill: 0, placements: bestPl };
  return { fill: bestFill, placements: bestPl };
}

function tryAppend(L, W, placed, t, rotate) {
  var ors = [[t.l, t.w, false]];
  if (rotate && t.l !== t.w) ors.push([t.w, t.l, true]);
  var xs = [0], ys = [0];
  placed.forEach(function (q) { xs.push(q.x + q.l); ys.push(q.y + q.w); });
  xs = xs.filter(function (v, k, a) { return a.indexOf(v) === k; }).sort(function (a, b) { return a - b; });
  ys = ys.filter(function (v, k, a) { return a.indexOf(v) === k; }).sort(function (a, b) { return a - b; });
  var best = null;
  ors.forEach(function (o) {
    xs.forEach(function (x) {
      ys.forEach(function (y) {
        if (x + o[0] > L + 1e-6 || y + o[1] > W + 1e-6) return;
        for (var k = 0; k < placed.length; k++) {
          var q = placed[k];
          if (x < q.x + q.l - 1e-6 && q.x < x + o[0] - 1e-6 &&
              y < q.y + q.w - 1e-6 && q.y < y + o[1] - 1e-6) return;
        }
        if (!best || x < best.x - 1e-6 || (Math.abs(x - best.x) < 1e-6 && y < best.y - 1e-6)) {
          best = { x: x, y: y, l: o[0], w: o[1], fill: true, id: t.id, rotated: o[2] };
        }
      });
    });
  });
  return best;
}

module.exports = { maxSame: maxSame, maxMixed: maxMixed, blPack: blPack, gridCount: gridCount };

/* 尽量多放（允许放不下就停），返回最多能放几个 + 布局 */
function maxSingleCount(L, W, items, rotate, trials) {
  trials = trials || 600;
  var rnd = mulberry(24680);
  var best = 0, bestPl = null;
  for (var t = 0; t < trials; t++) {
    var arr = shuffle(items, rnd);
    var placed = [];
    for (var i = 0; i < arr.length; i++) {
      var one = tryAppend(L, W, placed, arr[i], rotate);
      if (!one) continue;
      placed.push(one);
    }
    if (placed.length > best) { best = placed.length; bestPl = placed; }
    if (best === items.length) break;
  }
  return { count: best, placements: bestPl };
}
module.exports.maxSingleCount = maxSingleCount;
