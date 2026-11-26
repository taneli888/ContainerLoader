/*!
 * Container Loader — 单层托盘装柜求解器
 *
 * 坐标系（与装柜现场一致）：
 *   X = 0 柜底（封闭端，装载起点），X = L 柜门；
 *   Y = 0 左侧内壁，Y = W 右侧内壁；Z = 0 柜底，Z = H 柜顶。
 *   所有 placements 的 x/y 都是毫米级真实几何坐标，不做居中或均分空隙。
 *
 * 问题：给定柜内长宽、若干必装托盘、一个“补柜”规格（数量不限），
 * 在柜底做 2D 矩形排布，先保证必装全部放入，再最大化补柜数量。
 *
 * 做法：
 *   1. 沿柜宽方向尝试切成上下两条长条（也会尝试不切）；
 *   2. 每条长条用“横向条带 + 宽度方向并排”的模式 DP 排布；
 *   3. 枚举必装托盘在两条长条中的分配；
 *   4. 用面积上限、必装面积、剩余长度做剪枝。
 *
 * 这是启发式搜索，不是 MILP/CP-SAT 的数学证明。若补柜数量达到面积上限，
 * 可以认为在该单层模型下已经最优；否则界面会标为“启发式方案”。
 */
(function (root) {
  'use strict';

  var NODE_CAP = 45000;
  var ALLOC_LIMIT = 128;
  var PATTERN_CAP = 7000;
  var TIME_BUDGET_MS = 1200;
  var EPS = 1e-6;

  function clampInt(v, min, max) {
    v = Math.round(Number(v) || 0);
    return Math.max(min, Math.min(max, v));
  }

  function sum(arr) {
    var total = 0;
    for (var i = 0; i < arr.length; i++) total += arr[i];
    return total;
  }

  function isZero(arr) {
    for (var i = 0; i < arr.length; i++) if (arr[i] !== 0) return false;
    return true;
  }

  function fits(use, remain) {
    for (var i = 0; i < use.length; i++) if (use[i] > remain[i]) return false;
    return true;
  }

  function subtract(remain, use) {
    var out = new Array(remain.length);
    for (var i = 0; i < remain.length; i++) out[i] = remain[i] - use[i];
    return out;
  }

  function cloneCounts(arr) { return arr.slice(); }

  function bbox(placements) {
    if (!placements.length) return { x0: 0, y0: 0, x1: 0, y1: 0, area: 0 };
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < placements.length; i++) {
      var p = placements[i];
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + p.l);
      y1 = Math.max(y1, p.y + p.w);
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1, area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) };
  }

  /* ------------------------------------------------------------------ */
  /* 真实矩形碰撞 + 二次紧凑化                                          */
  /* X=0 柜底，X=L 柜门；Y=0 左侧内壁，Y=W 右侧内壁。                  */
  /* ------------------------------------------------------------------ */

  function rectsOverlap(a, b) {
    return a.x < b.x + b.l - EPS && b.x < a.x + a.l - EPS &&
      a.y < b.y + b.w - EPS && b.y < a.y + a.w - EPS;
  }

  function overlapsY(a, b) {
    return a.y < b.y + b.w - EPS && b.y < a.y + a.w - EPS;
  }

  function overlapsX(a, b) {
    return a.x < b.x + b.l - EPS && b.x < a.x + a.l - EPS;
  }

  // 每个托盘都尝试向 X=0（柜底）和 Y=0 顶到不能顶为止。
  // 这是几何紧凑化，不改变层数/数量，也不做任何居中或均分。
  function compactPlacements(placements, L, W) {
    if (!placements.length) return;
    var minX = Infinity, minY = Infinity;
    placements.forEach(function (p) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
    });
    if (minX > EPS || minY > EPS) {
      placements.forEach(function (p) { p.x -= minX; p.y -= minY; });
    }

    for (var pass = 0; pass < 8; pass++) {
      var moved = false;

      // X：按当前 x 从柜底向柜门处理，顶到已经固定的托盘或柜底。
      var byX = placements.slice().sort(function (a, b) {
        return a.x - b.x || a.y - b.y;
      });
      byX.forEach(function (p) {
        if (p.noAlign) return;
        var target = 0;
        placements.forEach(function (q) {
          if (q === p || !overlapsY(p, q)) return;
          if (q.x + q.l <= p.x + EPS) target = Math.max(target, q.x + q.l);
        });
        if (target < p.x - EPS) {
          p.x = target;
          moved = true;
        }
      });

      // Y：向左侧内壁靠，顶到已经固定的托盘或内壁。
      var byY = placements.slice().sort(function (a, b) {
        return a.y - b.y || a.x - b.x;
      });
      byY.forEach(function (p) {
        if (p.noAlign) return;
        var target = 0;
        placements.forEach(function (q) {
          if (q === p || !overlapsX(p, q)) return;
          if (q.y + q.w <= p.y + EPS) target = Math.max(target, q.y + q.w);
        });
        if (target < p.y - EPS) {
          p.y = target;
          moved = true;
        }
      });

      if (!moved) break;
    }

    // 兜底：紧凑化后重新贴到 0，禁止负坐标。
    var lowX = Infinity, lowY = Infinity;
    placements.forEach(function (p) {
      lowX = Math.min(lowX, p.x);
      lowY = Math.min(lowY, p.y);
    });
    if (lowX > EPS || lowY > EPS) {
      placements.forEach(function (p) { p.x -= lowX; p.y -= lowY; });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 箱型 / 托盘预处理                                                   */
  /* ------------------------------------------------------------------ */

  function prepare(container, pallets, options) {
    var L = Math.round(Number(container.l) || 0);
    var W = Math.round(Number(container.w) || 0);
    var H = Math.round(Number(container.h) || 0);
    var payload = Math.max(0, Number(container.payload) || 0);
    var gap = Math.max(0, Math.round(Number(options && options.gap) || 0));
    var doorGap = Math.max(0, Math.round(Number(options && options.doorGap) || 0));
    var allowRotate = !options || options.allowRotate !== false;
    var allowStack = !options || options.allowStack !== false;

    var normalized = [];
    for (var i = 0; i < pallets.length; i++) {
      var p = pallets[i];
      var rawL = Math.round(Number(p.l) || 0);
      var rawW = Math.round(Number(p.w) || 0);
      var h = Math.round(Number(p.h) || 0);
      var baseH = Math.max(0, Math.round(Number(p.baseH) || 0));
      var qty = Math.max(0, Math.round(Number(p.qty) || 0));
      if (!rawL || !rawW || !h) continue;
      var layers = allowStack ? Math.max(1, Math.floor(H / h)) : 1;
      if (!isFinite(layers) || layers < 1) layers = 1;
      var stackQty = Math.ceil(qty / layers);
      var override = options && options.stackUnitCounts && options.stackUnitCounts[String(p.id || ('p' + i))];
      if (override != null && allowStack) {
        stackQty = Math.max(Math.ceil(qty / layers), Math.min(qty, Math.round(Number(override) || 0)));
      }
      normalized.push({
        id: String(p.id || ('p' + i)),
        name: String(p.name || ('托盘 ' + rawL + '×' + rawW)),
        code: String(p.code || (rawL + '×' + rawW)),
        l: rawL,
        w: rawW,
        h: h,
        baseH: Math.min(baseH, h),
        qty: qty,
        actualQty: qty,
        layers: layers,
        stackQty: stackQty,
        stackHeight: layers * h,
        weight: Math.max(0, Number(p.weight) || 0),
        fill: !!p.fill,
        color: Number(p.color) || 0,
        effL: rawL + gap,
        effW: rawW + gap,
        rawArea: rawL * rawW,
        effArea: (rawL + gap) * (rawW + gap)
      });
    }

    return {
      L: L, W: W, H: H, payload: payload, gap: gap, doorGap: doorGap, allowRotate: allowRotate,
      allowStack: allowStack, noMerge: !!(options && options.noMerge), pallets: normalized
    };
  }

  /* ------------------------------------------------------------------ */
  /* 模式生成：一条长条内，沿宽度并排若干托盘，形成一段“横向条带”      */
  /* ------------------------------------------------------------------ */

  function getPatterns(D, requiredTypes, fillType, allowRotate, cache) {
    var key = D + '|' + (allowRotate ? 1 : 0) + '|' +
      requiredTypes.map(function (t) { return t.id; }).join(',') + '|' +
      (fillType ? fillType.id : '-');
    if (cache.has(key)) return cache.get(key);

    var allTypes = requiredTypes.slice();
    if (fillType) allTypes.push(fillType);

    var options = [];
    for (var ti = 0; ti < allTypes.length; ti++) {
      var t = allTypes[ti];
      options.push({ ti: ti, oi: 0, len: t.effL, wid: t.effW, rotated: false });
      if (allowRotate && t.effL !== t.effW) {
        options.push({ ti: ti, oi: 1, len: t.effW, wid: t.effL, rotated: true });
      }
    }
    options = options.filter(function (o) { return o.wid <= D; });
    options.sort(function (a, b) { return b.wid - a.wid || a.ti - b.ti; });

    var patterns = [];
    var seen = Object.create(null);
    var maxSlots = 4;
    if (options.length && D / options[options.length - 1].wid > 4) maxSlots = 5;

    function add(slots) {
      if (!slots.length) return;
      var sig = slots.map(function (s) { return s.ti + ':' + s.oi; }).sort().join('|');
      if (seen[sig]) return;
      seen[sig] = true;
      var sorted = slots.slice().sort(function (a, b) { return b.wid - a.wid || a.ti - b.ti; });
      var reqUse = new Array(requiredTypes.length);
      for (var i = 0; i < reqUse.length; i++) reqUse[i] = 0;
      var fillUse = 0;
      var len = 0;
      var width = 0;
      for (var j = 0; j < sorted.length; j++) {
        var s = sorted[j];
        len = Math.max(len, s.len);
        width += s.wid;
        if (fillType && s.ti === allTypes.length - 1) fillUse++;
        else reqUse[s.ti]++;
      }
      patterns.push({
        slots: sorted,
        reqUse: reqUse,
        fillUse: fillUse,
        len: len,
        width: width,
        reqSum: sum(reqUse)
      });
    }

    function rec(start, usedWidth, slots) {
      if (patterns.length >= PATTERN_CAP) return;
      if (slots.length) add(slots);
      if (slots.length >= maxSlots) return;
      for (var i = start; i < options.length; i++) {
        var o = options[i];
        if (usedWidth + o.wid > D) continue;
        slots.push(o);
        rec(i, usedWidth + o.wid, slots);
        slots.pop();
        if (patterns.length >= PATTERN_CAP) break;
      }
    }
    rec(0, 0, []);

    patterns.sort(function (a, b) {
      var da = a.len ? a.fillUse / a.len : 0;
      var db = b.len ? b.fillUse / b.len : 0;
      if (db !== da) return db - da;
      if (b.reqSum !== a.reqSum) return b.reqSum - a.reqSum;
      return a.len - b.len;
    });

    var result = { patterns: patterns, minLen: patterns.length ? patterns[patterns.length - 1].len : Infinity };
    // minLen 与排序无关，单独再取一次，避免排序后误用。
    result.minLen = Infinity;
    for (var k = 0; k < patterns.length; k++) result.minLen = Math.min(result.minLen, patterns[k].len);
    cache.set(key, result);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 一条长条的 DP：必装数量必须放完，最大化补柜数量                    */
  /* ------------------------------------------------------------------ */

  function packStrip(L, D, requiredTypes, fillType, reqCounts, allowRotate, patternCache, nodeBudget, deadline) {
    if (!L || !D) return null;
    var patternData = getPatterns(D, requiredTypes, fillType, allowRotate, patternCache);
    var patterns = patternData.patterns;
    if (!patterns.length) {
      return isZero(reqCounts) ? { placements: [], fillCount: 0 } : null;
    }

    var reqArea = [];
    for (var i = 0; i < requiredTypes.length; i++) reqArea.push(requiredTypes[i].effArea);
    var fillArea = fillType ? fillType.effArea : 1;
    var memo = new Map();
    var choice = new Map();
    var nodes = 0;
    var aborted = false;
    var startReq = reqCounts.slice();

    function requiredArea(counts) {
      var total = 0;
      for (var i = 0; i < counts.length; i++) total += counts[i] * reqArea[i];
      return total;
    }

    function fillUpperBound(x, counts) {
      if (!fillType) return 0;
      var free = x * D - requiredArea(counts);
      return free > 0 ? Math.floor(free / fillArea) : 0;
    }

    function dp(x, counts) {
      if (aborted) return -Infinity;
      nodes++;
      if (nodes > nodeBudget || ((nodes & 511) === 0 && Date.now() > deadline)) {
        aborted = true;
        return -Infinity;
      }

      if (!fillType && isZero(counts)) { memo.set(x + '|' + counts.join(','), 0); return 0; }
      var key = x + '|' + counts.join(',');
      if (memo.has(key)) return memo.get(key);

      var remArea = requiredArea(counts);
      if (remArea > x * D + EPS) {
        memo.set(key, -Infinity);
        return -Infinity;
      }
      if (x < patternData.minLen) {
        var ok = isZero(counts);
        memo.set(key, ok ? 0 : -Infinity);
        return ok ? 0 : -Infinity;
      }

      var best = -Infinity;
      var bestIndex = -1;
      var upper = fillUpperBound(x, counts);

      for (var pi = 0; pi < patterns.length; pi++) {
        var p = patterns[pi];
        if (p.len > x) continue;
        if (!fits(p.reqUse, counts)) continue;
        var next = subtract(counts, p.reqUse);
        var sub = dp(x - p.len, next);
        if (sub < 0) continue;
        var val = p.fillUse + sub;
        if (val > best) {
          best = val;
          bestIndex = pi;
          if (best >= upper) break;
        }
      }

      memo.set(key, best);
      if (bestIndex >= 0) choice.set(key, bestIndex);
      return best;
    }

    var bestFill = dp(L, startReq);
    if (aborted || bestFill < 0) return null;

    var placements = [];
    var x = L;
    var counts = startReq.slice();
    var order = 0;

    while (x > 0) {
      var key = x + '|' + counts.join(',');
      var pi = choice.get(key);
      if (pi == null) break;
      var p = patterns[pi];
      var segStart = L - x;
      var yOffset = 0;
      for (var s = 0; s < p.slots.length; s++) {
        var slot = p.slots[s];
        var t = (fillType && slot.ti === requiredTypes.length) ? fillType : requiredTypes[slot.ti];
        var actualL = slot.rotated ? t.w : t.l;
        var actualW = slot.rotated ? t.l : t.w;
        var isFill = !!(fillType && slot.ti === requiredTypes.length);
        placements.push({
          typeId: t.id,
          name: t.name,
          code: t.code,
          color: t.color,
          fill: isFill,
          x: segStart + (t.rawL !== undefined ? 0 : 0), // 下面统一加 gap/2
          y: yOffset,
          l: actualL,
          w: actualW,
          h: t.h,
          baseH: t.baseH,
          weight: t.weight,
          rotated: !!slot.rotated,
          _effX: segStart,
          _effY: yOffset,
          _effL: slot.len,
          _effW: slot.wid,
          _gap: t._gap || 0,
          order: order++
        });
        yOffset += slot.wid;
      }
      x -= p.len;
      counts = subtract(counts, p.reqUse);
      if (isZero(counts) && x <= 0) break;
    }

    return { placements: placements, fillCount: bestFill, counts: startReq.map(function (n, i) { return n - counts[i]; }) };
  }

  /* ------------------------------------------------------------------ */
  /* 候选切宽 / 必装分配                                                 */
  /* ------------------------------------------------------------------ */

  function buildCuts(W, types, allowRotate) {
    var set = Object.create(null);
    function add(v) {
      v = Math.round(v);
      if (v > 0 && v < W) set[v] = true;
    }
    var widths = [];
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      widths.push(t.effW);
      if (allowRotate && t.effL !== t.effW) widths.push(t.effL);
    }
    widths.forEach(function (w) {
      add(w);
      add(W - w);
      add(2 * w);
      add(W - 2 * w);
      widths.forEach(function (w2) {
        add(w + w2);
        add(W - (w + w2));
      });
    });
    add(W / 2);
    add(W / 3);
    add(2 * W / 3);
    var cuts = Object.keys(set).map(Number);
    cuts.sort(function (a, b) { return a - b; });
    return cuts;
  }

  function buildAllocations(reqTypes, limit) {
    var qty = reqTypes.map(function (t) { return t.stackQty; });
    if (!qty.length) return [[[], []]];
    var total = 1;
    for (var i = 0; i < qty.length; i++) total *= (qty[i] + 1);
    var out = [];
    var seen = Object.create(null);

    function push(bottom) {
      var key = bottom.join(',');
      if (seen[key]) return;
      seen[key] = true;
      var top = bottom.map(function (n, idx) { return qty[idx] - n; });
      out.push([bottom, top]);
    }

    if (total <= limit) {
      var current = new Array(qty.length).fill(0);
      function rec(idx) {
        if (idx === qty.length) { push(current.slice()); return; }
        for (var n = 0; n <= qty[idx]; n++) {
          current[idx] = n;
          rec(idx + 1);
        }
      }
      rec(0);
      return out;
    }

    push(qty.slice());
    push(new Array(qty.length).fill(0));
    push(qty.map(function (n) { return Math.round(n / 2); }));
    for (var t = 0; t < qty.length; t++) {
      var one = new Array(qty.length).fill(0);
      one[t] = qty[t];
      push(one);
    }
    var seed = 20261126;
    function rnd() {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    }
    for (var k = 0; k < limit * 3 && out.length < limit; k++) {
      var bottom = qty.map(function (n) { return Math.floor(rnd() * (n + 1)); });
      push(bottom);
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 多规格“柜门优先”候选：按装柜顺序分带                                */
  /* 先装规格在柜底，后装规格在其前方，最后装柜的规格最靠近柜门。          */
  /* ------------------------------------------------------------------ */

  function typeOrientations(t, allowRotate) {
    var out = [{ l: t.l, w: t.w, rotated: false }];
    if (allowRotate && t.l !== t.w) out.push({ l: t.w, w: t.l, rotated: true });
    return out;
  }

  function distributeCounts(qty, units, layers) {
    var out = [];
    var remain = qty;
    for (var i = 0; i < units; i++) {
      var after = units - i - 1;
      var c = Math.max(1, Math.min(layers, remain - after));
      out.push(c);
      remain -= c;
    }
    return remain === 0 ? out : null;
  }

  // 柜底侧空缝评分：越低越好；靠柜底的空缝权重更高，柜门侧允许留空。
  function permutations(items, limit) {
    limit = limit || 24;
    var out = [];
    function walk(rest, acc) {
      if (out.length >= limit) return;
      if (!rest.length) { out.push(acc.slice()); return; }
      for (var i = 0; i < rest.length && out.length < limit; i++) {
        var next = rest.slice();
        var pick = next.splice(i, 1)[0];
        acc.push(pick);
        walk(next, acc);
        acc.pop();
      }
    }
    walk(items, []);
    return out;
  }

  function bottomGapMetric(placements, L, W) {
    if (!placements.length) return 0;
    var maxX = 0;
    placements.forEach(function (p) { maxX = Math.max(maxX, p.x + p.l); });
    if (maxX <= 0) return 0;
    var xs = [0, maxX];
    placements.forEach(function (p) { xs.push(p.x, p.x + p.l); });
    xs = xs.filter(function (v) { return v >= -EPS && v <= maxX + EPS; })
      .sort(function (a, b) { return a - b; });
    var unique = [];
    xs.forEach(function (v) { if (!unique.length || Math.abs(v - unique[unique.length - 1]) > EPS) unique.push(v); });
    var gap = 0;
    for (var i = 0; i < unique.length - 1; i++) {
      var a = unique[i], b = unique[i + 1];
      if (b - a <= EPS) continue;
      var mid = (a + b) / 2;
      var spans = [];
      placements.forEach(function (p) {
        if (p.x < mid && p.x + p.l > mid) spans.push([p.y, p.y + p.w]);
      });
      spans.sort(function (x, y) { return x[0] - y[0]; });
      var covered = 0, curS = -1, curE = -1;
      spans.forEach(function (s) {
        if (curS < 0) { curS = s[0]; curE = s[1]; }
        else if (s[0] <= curE + EPS) curE = Math.max(curE, s[1]);
        else { covered += curE - curS; curS = s[0]; curE = s[1]; }
      });
      if (curS >= 0) covered += curE - curS;
      var weight = 1 + (1 - mid / maxX); // 柜底侧权重 2，柜门侧权重 1
      gap += Math.max(0, W - covered) * (b - a) * weight;
    }
    return gap;
  }

  function packUnitsBottomLeft(units, startX, L, W, allowRotate, obstacles) {
    var placed = [];
    var fixed = obstacles || [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var t = u.t;
      var best = null;
      var orients = typeOrientations(t, allowRotate);
      var xs = [startX];
      var ys = [0];
      fixed.forEach(function (q) { xs.push(q.x, q.x + q.l); ys.push(q.y, q.y + q.w); });
      placed.forEach(function (q) { xs.push(q.x + q.l); ys.push(q.y + q.w); });
      xs = xs.filter(function (v, idx, arr) { return v >= startX - EPS && arr.indexOf(v) === idx; });
      ys = ys.filter(function (v, idx, arr) { return v >= -EPS && arr.indexOf(v) === idx; });
      for (var oi = 0; oi < orients.length; oi++) {
        var o = orients[oi];
        for (var xi = 0; xi < xs.length; xi++) {
          for (var yi = 0; yi < ys.length; yi++) {
            var x = xs[xi], y = ys[yi];
            if (x + o.l > L + EPS || y + o.w > W + EPS) continue;
            var hit = false;
            for (var fi = 0; fi < fixed.length; fi++) {
              var f = fixed[fi];
              if (x < f.x + f.l - EPS && f.x < x + o.l - EPS &&
                  y < f.y + f.w - EPS && f.y < y + o.w - EPS) { hit = true; break; }
            }
            if (hit) continue;
            for (var qi = 0; qi < placed.length; qi++) {
              var q = placed[qi];
              if (x < q.x + q.l - EPS && q.x < x + o.l - EPS &&
                  y < q.y + q.w - EPS && q.y < y + o.w - EPS) { hit = true; break; }
            }
            if (hit) continue;
            if (!best || x < best.x - EPS || (Math.abs(x - best.x) < EPS && y < best.y - EPS)) {
              best = { x: x, y: y, l: o.l, w: o.w, rotated: o.rotated };
            }
          }
        }
      }
      if (!best) return null;
      placed.push({
        typeId: t.id, name: t.name, code: t.code, color: t.color, fill: !!t.fill,
        x: best.x, y: best.y, z: 0, l: best.l, w: best.w, h: t.h, baseH: t.baseH,
        weight: t.weight, rotated: best.rotated, count: u.count, stackHeight: u.count * t.h,
        strip: 'M', order: placed.length, baseL: best.l, baseW: best.w
      });
    }
    return placed;
  }

  function unitsForType(t, high) {
    var counts = distributeCounts(t.qty, t.stackQty, t.layers) || [];
    var out = [];
    counts.forEach(function (c) {
      if ((c > 1) === !!high) out.push({ t: t, count: c });
    });
    return out;
  }

  function interleaveUnits(types, high) {
    var queues = types.map(function (t) { return unitsForType(t, high); });
    var out = [];
    var more = true;
    while (more) {
      more = false;
      queues.forEach(function (q) {
        if (q.length) { out.push(q.shift()); more = true; }
      });
    }
    return out;
  }

  // 不按规格分块：把同类垛位拆开，按柜底利用率与真实碰撞做单元级 Bottom-Left。
  function buildMixedUnitPlan(P, requiredTypes, fillType, L, W) {
    if (!requiredTypes.length) return null;
    var highUnits = [];
    var lowUnits = [];
    requiredTypes.forEach(function (t) {
      highUnits = highUnits.concat(unitsForType(t, true));
      lowUnits = lowUnits.concat(unitsForType(t, false));
    });
    if (!highUnits.length) return null;

    var orders = [];
    var typeOrders = permutations(requiredTypes, 12);
    typeOrders.forEach(function (order) {
      orders.push(interleaveUnits(order, true));
      orders.push(order.reduce(function (acc, t) { return acc.concat(unitsForType(t, true)); }, []));
    });
    orders.push(highUnits.slice().sort(function (a, b) { return b.t.l * b.t.w - a.t.l * a.t.w; }));
    orders.push(highUnits.slice().sort(function (a, b) { return a.t.l * a.t.w - b.t.l * b.t.w; }));

    var best = null;
    orders.forEach(function (order) {
      var highs = packUnitsBottomLeft(order, 0, L, W, P.allowRotate);
      if (!highs) return;
      var lows = packUnitsBottomLeft(lowUnits, 0, L, W, P.allowRotate, highs);
      if (!lows) return;
      var placements = highs.concat(lows);
      var gap = bottomGapMetric(placements, L, W);
      if (!best || gap < best.bottomGap - EPS) {
        best = {
          placements: placements,
          fillCount: 0,
          fillStacks: 0,
          stackCount: placements.length,
          doorClear: Math.max(0, L - Math.max.apply(null, placements.map(function (p) { return p.x + p.l; }))),
          bottomGap: gap,
          score: 4e8,
          stripCount: 1,
          cut: W
        };
      }
    });
    return best;
  }
  function buildDoorPriorityPlan(P, requiredTypes, fillType, L, W) {
    if (!requiredTypes.length) return null;
    var placements = [];
    var bandX = 0;

    // 安全约束：先放所有双层/多层垛，再放单层垛；单层不会夹在叠放垛中间。
    var highGroups = [];
    var lowGroups = [];
    for (var ti = 0; ti < requiredTypes.length; ti++) {
      var t = requiredTypes[ti];
      var units = t.stackQty;
      var counts = distributeCounts(t.qty, units, t.layers);
      if (!counts) return null;
      var hi = [], lo = [];
      counts.forEach(function (c) { (c > 1 ? hi : lo).push(c); });
      if (hi.length) highGroups.push({ t: t, counts: hi, typeOrder: ti });
      if (lo.length) lowGroups.push({ t: t, counts: lo, typeOrder: ti });
    }

    var groups = highGroups.concat(lowGroups);
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      var gt = g.t;
      var gc = g.counts;
      var gu = gc.length;
      var bestO = null;
      typeOrientations(gt, P.allowRotate).forEach(function (o) {
        var cols = Math.floor(W / o.w);
        if (cols < 1) return;
        var rows = Math.ceil(gu / cols);
        var depth = rows * o.l;
        if (bandX + depth > L + EPS) return;
        if (!bestO || depth < bestO.depth || (depth === bestO.depth && cols > bestO.cols)) {
          bestO = { l: o.l, w: o.w, rotated: o.rotated, cols: cols, rows: rows, depth: depth };
        }
      });
      if (!bestO) return null;
      for (var ui = 0; ui < gu; ui++) {
        var row = Math.floor(ui / bestO.cols);
        var col = ui % bestO.cols;
        placements.push({
          typeId: gt.id, name: gt.name, code: gt.code, color: gt.color, fill: false,
          x: bandX + row * bestO.l, y: col * bestO.w, z: 0,
          l: bestO.l, w: bestO.w, h: gt.h, baseH: gt.baseH, weight: gt.weight,
          rotated: bestO.rotated, count: gc[ui], stackHeight: gc[ui] * gt.h,
          strip: 'B', order: placements.length, baseL: bestO.l, baseW: bestO.w,
          typeOrder: g.typeOrder
        });
      }
      bandX += bestO.depth;
    }

    var fillCount = 0;
    if (fillType) {
      var remaining = L - bandX;
      var bestF = null;
      typeOrientations(fillType, P.allowRotate).forEach(function (o) {
        var cols = Math.floor(W / o.w);
        var rows = Math.floor(remaining / o.l);
        var units = cols * rows;
        if (units < 1) return;
        var total = units * fillType.layers;
        if (!bestF || total > bestF.total || (total === bestF.total && rows * o.l < bestF.depth)) {
          bestF = { l: o.l, w: o.w, rotated: o.rotated, cols: cols, rows: rows, units: units, total: total, depth: rows * o.l };
        }
      });
      if (bestF) {
        for (var fi = 0; fi < bestF.units; fi++) {
          var frow = Math.floor(fi / bestF.cols);
          var fcol = fi % bestF.cols;
          placements.push({
            typeId: fillType.id, name: fillType.name, code: fillType.code, color: fillType.color, fill: true,
            x: bandX + frow * bestF.l, y: fcol * bestF.w, z: 0,
            l: bestF.l, w: bestF.w, h: fillType.h, baseH: fillType.baseH, weight: fillType.weight,
            rotated: bestF.rotated, count: fillType.layers, stackHeight: fillType.layers * fillType.h,
            strip: 'B', order: placements.length, baseL: bestF.l, baseW: bestF.w, typeOrder: requiredTypes.length
          });
        }
        fillCount = bestF.total;
      }
    }

    return {
      placements: placements,
      fillCount: fillCount,
      fillStacks: fillType ? fillCount / fillType.layers : 0,
      stackCount: placements.length,
      doorClear: Math.max(0, L - Math.max.apply(null, placements.map(function (p) { return p.x + p.l; }))),
      score: fillCount * 1e12 + 4e8,
      bottomGap: bottomGapMetric(placements, L, W),
      stripCount: 1,
      cut: W
    };
  }

  /* ------------------------------------------------------------------ */
  /* 主求解                                                              */
  /* ------------------------------------------------------------------ */

  function solveCore(container, pallets, options) {
    var P = prepare(container, pallets, options || {});
    var L = P.L, W = P.W, H = P.H;
    var all = P.pallets;
    var requiredTypes = all.filter(function (t) { return !t.fill && t.qty > 0; });
    var fillType = all.filter(function (t) { return t.fill; })[0] || null;
    var packingL = L - P.doorGap;

    if (!L || !W || !H) {
      return { ok: false, error: '请填写有效的柜内长、宽、高。' };
    }
    if (packingL < 300) {
      return { ok: false, error: '柜门预留 ' + P.doorGap + 'mm 过大，柜内可用长度只剩 ' + Math.max(0, packingL) + 'mm。' };
    }
    if (!requiredTypes.length && !fillType) {
      return { ok: false, error: '请至少添加一种托盘规格。' };
    }

    for (var i = 0; i < requiredTypes.length; i++) {
      requiredTypes[i]._gap = P.gap;
    }
    if (fillType) fillType._gap = P.gap;

    // 尺寸合法性
    var bad = null;
    requiredTypes.concat(fillType ? [fillType] : []).forEach(function (t) {
      if (bad) return;
      var canOrient = P.allowRotate;
      var fitNormal = t.effL <= L && t.effW <= W;
      var fitRot = canOrient && t.effW <= L && t.effL <= W;
      if (!fitNormal && !fitRot) {
        bad = '托盘「' + t.name + '」的底面尺寸 ' + t.l + '×' + t.w + 'mm 放不进柜底 ' + L + '×' + W + 'mm。';
      } else if (t.h > H) {
        bad = '托盘「' + t.name + '」总高 ' + t.h + 'mm，超过柜内净高 ' + H + 'mm。';
      }
    });
    if (bad) return { ok: false, error: bad };

    var requiredArea = 0;
    var requiredStackArea = 0;
    var requiredCount = 0;
    var requiredStacks = 0;
    requiredTypes.forEach(function (t) {
      requiredArea += t.qty * t.rawArea;
      requiredStackArea += t.stackQty * t.effArea;
      requiredCount += t.qty;
      requiredStacks += t.stackQty;
    });
    var floorArea = L * W;
    if (requiredStackArea > packingL * W + EPS) {
      return {
        ok: false,
        error: '必装按 ' + requiredStacks + ' 个垛位计算，占地 ' + (requiredStackArea / 1e6).toFixed(2) + ' m²，超过柜内可用柜底 ' + ((packingL * W) / 1e6).toFixed(2) + ' m²（已预留柜门 ' + P.doorGap + 'mm）。',
        requiredArea: requiredArea,
        floorArea: floorArea,
        suggestions: [
          '换更大的柜型，或减少必装数量。',
          P.allowStack ? '当前已启用同规格叠放；可增加每垛层数上限或更换更高柜型。' : '打开“允许同规格叠放”可以减少所需垛位。',
          P.doorGap > 0 ? '减小“柜门预留”后再计算。' : '检查托盘旋转和柜门预留设置。'
        ]
      };
    }

    var fillUpperBound = null;
    var fillLayers = fillType ? fillType.layers : 1;
    if (fillType) {
      var fillStacksMax = Math.floor((packingL * W - requiredStackArea) / fillType.effArea + EPS);
      fillUpperBound = Math.max(0, fillStacksMax) * fillLayers;
      if (fillUpperBound < 0) fillUpperBound = 0;
    }

    var patternCache = new Map();
    var stripCache = new Map();
    var best = null;
    var deadline = Date.now() + TIME_BUDGET_MS;
    var timedOut = false;

    function stripPlan(stripL, stripD, reqCounts) {
      var key = stripL + '|' + stripD + '|' + reqCounts.join(',');
      if (stripCache.has(key)) return stripCache.get(key);
      var res = packStrip(stripL, stripD, requiredTypes, fillType, reqCounts, P.allowRotate, patternCache, NODE_CAP, deadline);
      stripCache.set(key, res);
      return res;
    }

    function evaluate(strips, allocation) {
      var plans = [];
      for (var s = 0; s < strips.length; s++) {
        var req = strips.length === 1 ? reqCountsFor(requiredTypes) : allocation[s];
        var plan = stripPlan(packingL, strips[s].depth, req);
        if (!plan) return null;
        plans.push({ plan: plan, y0: strips[s].y0 });
      }

      var placements = [];
      var order = 0;
      for (var pi = 0; pi < plans.length; pi++) {
        var plan = plans[pi].plan;
        var y0 = plans[pi].y0;
        for (var k = 0; k < plan.placements.length; k++) {
          var pl = plan.placements[k];
          var actualX = pl._effX + (P.gap ? P.gap / 2 : 0);
          var actualY = y0 + pl._effY + (P.gap ? P.gap / 2 : 0);
          placements.push({
            typeId: pl.typeId,
            name: pl.name,
            code: pl.code,
            color: pl.color,
            fill: pl.fill,
            x: actualX,
            y: actualY,
            z: 0,
            l: pl.l,
            w: pl.w,
            h: pl.h,
            baseH: pl.baseH,
            weight: pl.weight,
            rotated: pl.rotated,
            count: 1,
            layers: 1,
            stackHeight: pl.h,
            strip: y0 === 0 ? 'A' : 'B',
            order: order++
          });
        }
      }

      // 垛位上的实际托盘数：每个垛位至少 1 托，多余托盘优先叠到前面的垛位。
      var countOk = true;
      requiredTypes.forEach(function (t) {
        var arr = placements.filter(function (p) { return p.typeId === t.id; });
        var remain = t.qty;
        arr.forEach(function (p, ai) {
          var unitsAfter = arr.length - ai - 1;
          var c = Math.max(1, Math.min(t.layers, remain - unitsAfter));
          if (!isFinite(c) || c < 1 || c > t.layers) countOk = false;
          p.count = Math.max(0, c);
          p.layers = Math.max(0, c);
          p.stackHeight = Math.max(0, c) * t.h;
          remain -= Math.max(0, c);
        });
        if (remain !== 0) countOk = false;
      });
      if (!countOk) return null;

      var fillStacks = 0;
      placements.forEach(function (p) {
        if (p.fill) {
          fillStacks++;
          p.count = fillType.layers;
          p.layers = fillType.layers;
          p.stackHeight = fillType.layers * p.h;
        }
      });
      var fillCount = fillStacks * fillLayers;

      var fillPlacements = placements.filter(function (p) { return p.fill; });
      var reqPlacements = placements.filter(function (p) { return !p.fill; });
      var fillBox = bbox(fillPlacements);
      var reqBox = bbox(reqPlacements);
      var maxX = 0;
      placements.forEach(function (p) { maxX = Math.max(maxX, p.x + p.l); });
      var doorClear = Math.max(0, L - maxX);
      var fillCompact = fillPlacements.length ? 1 - fillBox.area / floorArea : 0;
      var reqCompact = reqPlacements.length ? 1 - reqBox.area / floorArea : 0;
      var score = fillCount * 1e12 + doorClear * 1e8 + fillCompact * 1e6 + reqCompact * 1e4 + (placements.length * 1e-3);

      return {
        placements: placements,
        fillCount: fillCount,
        fillStacks: fillStacks,
        stackCount: placements.length,
        doorClear: doorClear,
        bottomGap: bottomGapMetric(placements, L, W),
        score: score,
        stripCount: strips.length,
        cut: strips.length === 1 ? W : strips[1].y0
      };
    }

    function reqCountsFor(types) {
      return types.map(function (t) { return t.stackQty; });
    }

    var cuts = buildCuts(W, all, P.allowRotate);
    // 优先尝试靠中间的切分，通常能更早得到高质量方案，也便于在时间预算内收敛。
    cuts.sort(function (a, b) { return Math.abs(a - W / 2) - Math.abs(b - W / 2) || a - b; });
    if (cuts.length > 26) cuts = cuts.slice(0, 26);
    var allocations = buildAllocations(requiredTypes, ALLOC_LIMIT);

    // 1) 不切：整柜一条长条
    var full = evaluate([{ y0: 0, depth: W }], null);
    if (full) best = full;

    // 2) 上下两条长条
    for (var c = 0; c < cuts.length; c++) {
      if (Date.now() > deadline) { timedOut = true; break; }
      var cut = cuts[c];
      var strips = [{ y0: 0, depth: cut }, { y0: cut, depth: W - cut }];
      for (var a = 0; a < allocations.length; a++) {
        if (Date.now() > deadline) { timedOut = true; break; }
        var cand = evaluate(strips, allocations[a]);
        if (!cand) continue;
        if (!best || cand.score > best.score) best = cand;
      }
    }

    // 3) 1200×1000 两排风车（20GP 专用候选，最多 10 个地面垛位）。
    //    普通横竖排法在 5898 长度下会差一点，风车能放下 10 个。
    if (requiredTypes.length === 1 && !fillType && L >= 5898 && W >= 2352 && P.allowRotate) {
      var wt = requiredTypes[0];
      var targetUnits = wt.stackQty;
      if (wt.l === 1200 && wt.w === 1000 && targetUnits <= 10 && targetUnits >= 1 && wt.qty <= 20) {
        var windTpl = [
          [0, 0, 1200, 1000], [1200, 0, 1000, 1200], [1000, 1208, 1200, 1000],
          [0, 1002, 1000, 1200], [2201, 0, 1000, 1200], [3201, 2, 1000, 1200],
          [2200, 1203, 1200, 1000], [3418, 1202, 1200, 1000], [4698, 1200, 1200, 1000],
          [4898, 0, 1000, 1200]
        ];
        var windPlaces = [];
        var remainW = wt.qty;
        for (var wi = 0; wi < targetUnits; wi++) {
          var leftUnits = targetUnits - wi - 1;
          var wc = Math.max(1, Math.min(wt.layers, remainW - leftUnits));
          windPlaces.push({
            typeId: wt.id, name: wt.name, code: wt.code, color: wt.color, fill: false,
            x: windTpl[wi][0] + (L - 5898), y: windTpl[wi][1] + (W - 2352) / 2,
            z: 0, l: windTpl[wi][2], w: windTpl[wi][3], h: wt.h, baseH: wt.baseH,
            weight: wt.weight, rotated: windTpl[wi][2] === wt.w,
            count: wc, stackHeight: wc * wt.h, strip: 'W', order: wi,
            baseL: windTpl[wi][2], baseW: windTpl[wi][3]
          });
          remainW -= wc;
        }
        if (remainW === 0) {
          var windCand = {
            placements: windPlaces,
            fillCount: 0,
            fillStacks: 0,
            stackCount: windPlaces.length,
            doorClear: 0,
            bottomGap: bottomGapMetric(windPlaces, L, W),
            score: 5e7,
            stripCount: 1,
            cut: W
          };
          if (!best || windCand.score > best.score) best = windCand;
        }
      }
    }

    // 4) 多规格：尝试不同的规格先后顺序，选择“柜底侧空缝最小”的方案。
    if (requiredTypes.length >= 2) {
      var orders = permutations(requiredTypes, 24);
      var bestBand = null;
      orders.forEach(function (order) {
        var band = fillType
          ? buildDoorPriorityPlan(P, order, fillType, L, W)
          : buildMixedUnitPlan(P, order, fillType, L, W);
        if (!band) return;
        if (!bestBand ||
            band.fillCount > bestBand.fillCount ||
            (band.fillCount === bestBand.fillCount && band.bottomGap < bestBand.bottomGap - EPS)) {
          bestBand = band;
        }
      });
      if (bestBand && (!best || bestBand.fillCount >= best.fillCount)) {
        best = bestBand;
      }
    }

    if (!best) {
      return {
        ok: false,
        error: '在当前柜型和尺寸下，必装托盘无法全部排入柜底。',
        requiredArea: requiredArea,
        floorArea: floorArea,
        suggestions: [
          '尝试换 40HQ / 45HQ，或减少必装数量。',
          '确认是否允许托盘旋转 90°，并在“装载参数”中把托盘间隙设为 0。',
          '如果货物可以叠放，可把两层托盘作为一个“堆垛单元”重新录入。'
        ]
      };
    }

    // 先为每个垛位生成逐层记录。
    best.placements.forEach(function (p) {
      p.baseL = p.l;
      p.baseW = p.w;
      p.layers = [];
      p.stackHeight = 0;
      for (var i = 0; i < p.count; i++) {
        p.layers.push({
          typeId: p.typeId, name: p.name, code: p.code, color: p.color,
          fill: p.fill, l: p.l, w: p.w, h: p.h, baseH: p.baseH,
          weight: p.weight, rotated: p.rotated, relX: 0, relY: 0
        });
        p.stackHeight += p.h;
      }
    });

    // 混合叠放：上面托盘的长短边都不超过下面托盘时，才能叠。
    // 支持“大托底 + 小托上”，但 1120 底 + 1160 上这种反过来不允许。
    function fitsOn(topL, topW, bottomL, bottomW) {
      var a = topL >= topW ? [topL, topW] : [topW, topL];
      var b = bottomL >= bottomW ? [bottomL, bottomW] : [bottomW, bottomL];
      return a[0] <= b[0] + EPS && a[1] <= b[1] + EPS;
    }

    var mixedStacks = 0;
    var addedFillStacks = 0;
    var mergeGuard = 0;
    var changed = true;
    while (P.allowStack && !P.noMerge && changed && mergeGuard++ < 120) {
      changed = false;
      var byArea = best.placements.slice().sort(function (a, b) { return b.l * b.w - a.l * a.w; });
      outer:
      for (var bi = 0; bi < byArea.length; bi++) {
        var bottom = byArea[bi];
        if (best.placements.indexOf(bottom) < 0) continue;
        var bottomTop = bottom.layers[bottom.layers.length - 1];
        for (var ti = 0; ti < best.placements.length; ti++) {
          var top = best.placements[ti];
          if (top === bottom) continue;
          if (bottom.stackHeight + top.stackHeight > H + EPS) continue;
          if (!fitsOn(top.l, top.w, bottomTop.l, bottomTop.w)) continue;
          // 把 top 的层整体叠到 bottom 的最后一层上，中心对齐被支撑面。
          var supportCX = (bottomTop.relX || 0) + bottomTop.l / 2;
          var supportCY = (bottomTop.relY || 0) + bottomTop.w / 2;
          top.layers.forEach(function (layer) {
            bottom.layers.push(Object.assign({}, layer, {
              relX: supportCX - layer.l / 2,
              relY: supportCY - layer.w / 2
            }));
            bottom.stackHeight += layer.h;
            bottom.count += 1;
          });
          bottom.fill = bottom.fill || top.fill;
          var freed = { x: top.x, y: top.y, l: top.l, w: top.w };
          best.placements.splice(ti, 1);
          // 让出的地面优先补一个满垛补柜，保持柜底利用率。
          if (fillType) {
            var orients = [{ l: fillType.l, w: fillType.w, rotated: false }];
            if (P.allowRotate && fillType.l !== fillType.w) orients.push({ l: fillType.w, w: fillType.l, rotated: true });
            var chosen = null;
            for (var oi = 0; oi < orients.length; oi++) {
              if (fitsOn(orients[oi].l, orients[oi].w, freed.l, freed.w)) { chosen = orients[oi]; break; }
            }
            if (chosen) {
              var fillCount = fillType.layers;
              var fillStackH = fillCount * fillType.h;
              if (fillStackH <= H + EPS) {
                var fillLayers = [];
                for (var fl = 0; fl < fillCount; fl++) {
                  fillLayers.push({
                    typeId: fillType.id, name: fillType.name, code: fillType.code,
                    color: fillType.color, fill: true, l: chosen.l, w: chosen.w,
                    h: fillType.h, baseH: fillType.baseH, weight: fillType.weight,
                    rotated: chosen.rotated, relX: 0, relY: 0
                  });
                }
                best.placements.push({
                  typeId: fillType.id, name: fillType.name, code: fillType.code,
                  color: fillType.color, fill: true,
                  x: freed.x, y: freed.y, z: 0,
                  l: chosen.l, w: chosen.w, h: fillType.h, baseH: fillType.baseH,
                  weight: fillType.weight, rotated: chosen.rotated,
                  count: fillCount, stackHeight: fillStackH, layers: fillLayers,
                  baseL: chosen.l, baseW: chosen.w,
                  strip: bottom.strip, order: 9999 + addedFillStacks
                });
                addedFillStacks++;
              }
            }
          }
          changed = true;
          break outer;
        }
      }
    }

    // 二次紧凑化：X 向柜底、Y 向左侧内壁，真实矩形碰撞检测。
    compactPlacements(best.placements, L, W);
    var maxX = 0, minX = Infinity;
    best.placements.forEach(function (p) {
      maxX = Math.max(maxX, p.x + p.l);
      minX = Math.min(minX, p.x);
    });
    if (!isFinite(minX)) minX = 0;
    var doorClearance = Math.max(0, L - maxX);
    var bottomGap = Math.max(0, minX);
    best.placements.forEach(function (p) {
      var ids = Object.create(null);
      p.layers.forEach(function (l) { ids[l.typeId] = true; });
      if (Object.keys(ids).length > 1) mixedStacks++;
    });

    // 结果统计（按逐层实际托盘统计）
    var totalWeight = 0;
    var weightKnown = false;
    var typeCounts = Object.create(null);
    var stackCounts = Object.create(null);
    var totalCount = 0;
    var actualFillCount = 0;
    var actualRequiredCount = 0;
    best.placements.forEach(function (p) {
      var ids = Object.create(null);
      p.layers.forEach(function (layer) {
        totalCount++;
        totalWeight += layer.weight || 0;
        if (layer.weight > 0) weightKnown = true;
        typeCounts[layer.typeId] = (typeCounts[layer.typeId] || 0) + 1;
        ids[layer.typeId] = true;
        if (layer.fill) actualFillCount++;
        else actualRequiredCount++;
      });
      Object.keys(ids).forEach(function (id) { stackCounts[id] = (stackCounts[id] || 0) + 1; });
    });
    var actualRequiredStacks = 0;
    var actualFillStacks = 0;
    best.placements.forEach(function (p) {
      var hasReq = p.layers.some(function (l) { return !l.fill; });
      var hasFill = p.layers.some(function (l) { return l.fill; });
      if (hasReq) actualRequiredStacks++;
      if (hasFill && !hasReq) actualFillStacks++;
    });

    var usedArea = 0;
    var usedVolume = 0;
    var maxH = 0;
    best.placements.forEach(function (p) {
      usedArea += p.baseL * p.baseW;
      p.layers.forEach(function (layer) { usedVolume += layer.l * layer.w * layer.h; });
      maxH = Math.max(maxH, p.stackHeight || p.h);
    });

    var warnings = [];
    if (weightKnown && P.payload > 0 && totalWeight > P.payload) {
      warnings.push('总重 ' + Math.round(totalWeight).toLocaleString('zh-CN') + ' kg，超过箱型载重 ' + P.payload.toLocaleString('zh-CN') + ' kg，请减少货物或分柜。');
    }
    if (P.gap > 0) {
      warnings.push('已按 ' + P.gap + 'mm 托盘间隙计算，实际装柜请预留叉车操作空间。');
    }
    if (P.allowStack) {
      warnings.push('按叠放计算：上面托盘的长短边都不超过下方托盘时才允许叠放。');
    }

    best.placements.sort(function (a, b) { return a.order - b.order; });
    best.placements.forEach(function (p, idx) { p.seq = idx + 1; });

    // 装柜间隙复核：
    // 同一排（相同柜长起点）的托盘宽度之和 vs 柜内宽，剩余 < 80mm 报警；
    // 同一列（相同柜宽起点）的托盘长度之和 vs 柜内长，剩余 < 200mm 报警。
    var widthGroups = Object.create(null);
    var lengthGroups = Object.create(null);
    best.placements.forEach(function (p) {
      var xKey = Math.round(p.x);
      var yKey = Math.round(p.y);
      (widthGroups[xKey] = widthGroups[xKey] || []).push(p);
      (lengthGroups[yKey] = lengthGroups[yKey] || []).push(p);
    });
    var clearanceWarnings = [];
    Object.keys(widthGroups).forEach(function (key) {
      var arr = widthGroups[key];
      var used = 0;
      arr.forEach(function (p) { used += p.w; });
      var left = W - used;
      if (left < 80) {
        clearanceWarnings.push({
          axis: 'width',
          at: Number(key),
          used: used,
          clearance: left,
          threshold: 80,
          seqs: arr.map(function (p) { return p.seq; }),
          text: '同一排（柜长起点 ' + key + 'mm）托盘宽度合计 ' + Math.round(used) + 'mm，柜内宽 ' + W + 'mm，剩余 ' + Math.round(left) + 'mm（< 80mm）'
        });
      }
    });
    Object.keys(lengthGroups).forEach(function (key) {
      var arr = lengthGroups[key];
      var used = 0;
      arr.forEach(function (p) { used += p.l; });
      var left = L - used;
      if (left < 200) {
        clearanceWarnings.push({
          axis: 'length',
          at: Number(key),
          used: used,
          clearance: left,
          threshold: 200,
          seqs: arr.map(function (p) { return p.seq; }),
          text: '同一列（柜宽起点 ' + key + 'mm）托盘长度合计 ' + Math.round(used) + 'mm，柜内长 ' + L + 'mm，剩余 ' + Math.round(left) + 'mm（< 200mm）'
        });
      }
    });
    clearanceWarnings.sort(function (a, b) {
      if (a.axis !== b.axis) return a.axis === 'width' ? -1 : 1;
      return a.at - b.at;
    });

    return {
      ok: true,
      container: {
        id: container.id || 'CUSTOM',
        code: container.code || container.id || 'CUSTOM',
        name: container.name || '自定义柜型',
        l: L, w: W, h: H, payload: P.payload
      },
      placements: best.placements,
      requiredCount: actualRequiredCount,
      requiredStacks: actualRequiredStacks,
      fillCount: actualFillCount,
      fillStacks: actualFillStacks,
      stackCount: best.placements.length,
      totalCount: totalCount,
      fillUpperBound: fillUpperBound,
      optimalByArea: fillType && mixedStacks === 0 && addedFillStacks === 0 ? actualFillCount >= fillUpperBound : false,
      mixedStacks: mixedStacks,
      addedFillStacks: addedFillStacks,
      floorArea: floorArea,
      floorUsed: usedArea,
      floorUtil: floorArea ? usedArea / floorArea : 0,
      volume: L * W * H,
      volumeUsed: usedVolume,
      volumeUtil: L * W * H ? usedVolume / (L * W * H) : 0,
      totalWeight: totalWeight,
      weightKnown: weightKnown,
      payload: P.payload,
      maxHeight: maxH,
      gap: P.gap,
      doorGap: P.doorGap,
      packingLength: packingL,
      doorClearance: doorClearance,
      bottomGap: bottomGap,
      allowRotate: P.allowRotate,
      allowStack: P.allowStack,
      cutsTried: cuts.length + 1,
      timedOut: timedOut,
      typeCounts: typeCounts,
      stackCounts: stackCounts,
      clearanceWarnings: clearanceWarnings,
      clearanceOk: clearanceWarnings.length === 0,
      clearanceThresholds: { width: 80, length: 200 },
      stripCount: best.stripCount,
      cut: best.cut,
      warnings: warnings,
      requiredArea: requiredArea,
      requiredStackArea: requiredStackArea,
      fillType: fillType ? {
        id: fillType.id, name: fillType.name, code: fillType.code,
        l: fillType.l, w: fillType.w, h: fillType.h, color: fillType.color,
        layers: fillType.layers
      } : null,
      solveLabel: fillType && mixedStacks === 0 && addedFillStacks === 0 && actualFillCount >= fillUpperBound ? '达到面积上限' : '条带搜索'
    };
  }

  /*
   * 最小叠放搜索（单规格必装）：
   * 不叠放优先时，优先让地面垛位尽量多——即尽量少叠。
   * stackUnitCounts 控制“地面垛位数 U”，数量仍是 qty；
   * U 越大，单层越多，叠放越少。二分查找最大的可行 U。
   */
  function solveLeastStacking(container, pallets, options) {
    var required = pallets.filter(function (p) { return !p.fill && Number(p.qty) > 0; });
    if (required.length !== 1) return null;
    var p = required[0];
    var H = Math.round(Number(container.h) || 0);
    var layers = options.allowStack === false ? 1 : Math.max(1, Math.floor(H / Math.round(Number(p.h) || 1)));
    var qty = Math.round(Number(p.qty) || 0);
    var minUnits = Math.ceil(qty / layers);
    if (qty <= minUnits) return null;

    var lo = minUnits + 1, hi = qty - 1, best = null, tries = 0;
    while (lo <= hi && tries++ < 14) {
      var mid = Math.floor((lo + hi) / 2);
      var counts = {};
      counts[String(p.id)] = mid;
      var opts = Object.assign({}, options, {
        allowStack: true,
        noMerge: true,
        stackUnitCounts: counts
      });
      var r = solveCore(container, pallets, opts);
      if (r && r.ok) {
        best = r;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) {
      best.stackingUsed = true;
      best.strategy = 'min-stack';
      best.allowStack = true;
    }
    return best;
  }

  /*
   * 外层策略：
   * - 关闭叠放：直接按单层算。
   * - 不叠放优先：先全部单层；放不下时，用最小叠放方案（优先多地面垛位）。
   * - 叠放优先：先按最大叠放算。
   */
  function solve(container, pallets, options) {
    var base = Object.assign({}, options || {});
    var singleOpts = Object.assign({}, base, { allowStack: false });

    if (base.allowStack === false) {
      var onlySingle = solveCore(container, pallets, singleOpts);
      if (onlySingle) { onlySingle.stackingUsed = false; onlySingle.strategy = 'single'; }
      return onlySingle;
    }

    var single = solveCore(container, pallets, singleOpts);
    if (base.preferSingle !== false) {
      if (single && single.ok) {
        single.stackingUsed = false;
        single.strategy = 'single-preferred';
        single.allowStack = true;
        return single;
      }
      var least = solveLeastStacking(container, pallets, base);
      if (least && least.ok) return least;
    }

    // 叠放优先：先尝试最大叠放；叠放放不下再退回单层。
    var stacked = solveCore(container, pallets, base);
    if (stacked && stacked.ok) {
      stacked.stackingUsed = true;
      stacked.strategy = 'stacked-preferred';
      return stacked;
    }
    if (single && single.ok) {
      single.stackingUsed = false;
      single.strategy = 'single-fallback';
      single.allowStack = true;
      return single;
    }
    return stacked || single;
  }

  var API = {
    solve: solve,
    prepare: prepare,
    _internal: {
      buildCuts: buildCuts,
      buildAllocations: buildAllocations,
      getPatterns: getPatterns
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.CL_SOLVER = API;
})(typeof window !== 'undefined' ? window : globalThis);




