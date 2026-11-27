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
  function promoteSinglesToDoor(placements, L, W) {
    var lows = placements.filter(function (p) { return p.count === 1; });
    var highs = placements.filter(function (p) { return p.count > 1; });
    lows.forEach(function (p) {
      var yHit = function (q) { return p.y < q.y + q.w - EPS && q.y < p.y + p.w - EPS; };
      var blockers = highs.filter(function (q) {
        return yHit(q) && q.x >= p.x + p.l - EPS;
      }).sort(function (a, b) { return b.x - a.x; });
      for (var i = 0; i < blockers.length; i++) {
        var q = blockers[i];
        if (q.l !== p.l || q.w !== p.w) continue;
        var px = p.x, py = p.y, qx = q.x, qy = q.y;
        p.x = qx; p.y = qy; q.x = px; q.y = py;
        var hit = false;
        for (var a = 0; a < placements.length && !hit; a++) {
          var A = placements[a];
          if (A.x < -EPS || A.y < -EPS || A.x + A.l > L + EPS || A.y + A.w > W + EPS) hit = true;
          for (var b = a + 1; b < placements.length; b++) {
            var B = placements[b];
            if (A.x < B.x + B.l - EPS && B.x < A.x + A.l - EPS &&
                A.y < B.y + B.w - EPS && B.y < A.y + A.w - EPS) { hit = true; break; }
          }
        }
        if (!hit) return;
        p.x = px; p.y = py; q.x = qx; q.y = qy;
      }
    });
  }

  // 每个托盘都尝试向 X=0（柜底）和 Y=0 顶到不能顶为止。
  // 这是几何紧凑化，不改变层数/数量，也不做任何居中或均分。
  function compactPlacements(placements, L, W, preserveSingles) {
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
        if (preserveSingles && p.count === 1) return;
        var target = 0;
        placements.forEach(function (q) {
          if (q === p || !overlapsY(p, q)) return;
          if (q.x + q.l + (q.gap || 0) <= p.x + EPS) target = Math.max(target, q.x + q.l + (q.gap || 0));
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
        if (preserveSingles && p.count === 1) return;
        var target = 0;
        placements.forEach(function (q) {
          if (q === p || !overlapsX(p, q)) return;
          if (q.y + q.w + (q.gap || 0) <= p.y + EPS) target = Math.max(target, q.y + q.w + (q.gap || 0));
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
    var doorW = Math.max(0, Math.round(Number(container.doorW) || 0));
    var doorH = Math.max(0, Math.round(Number(container.doorH) || 0));
    var payload = Math.max(0, Number(container.payload) || 0);
    var gap = Math.max(0, Math.round(Number(options && options.gap) || 0));
    var doorGap = Math.max(0, Math.round(Number(options && options.doorGap) || 0));
    var allowRotate = !options || options.allowRotate !== false;
    var allowStack = !options || options.allowStack !== false;
    var allowFillStack = !options || options.allowFillStack !== false;

    var normalized = [];
    for (var i = 0; i < pallets.length; i++) {
      var p = pallets[i];
      var rawL = Math.round(Number(p.l) || 0);
      var rawW = Math.round(Number(p.w) || 0);
      var h = Math.round(Number(p.h) || 0);
      var baseH = Math.max(0, Math.round(Number(p.baseH) || 0));
      var qty = Math.max(0, Math.round(Number(p.qty) || 0));
      if (!rawL || !rawW || !h) continue;
      var layers = (p.fill ? allowFillStack : allowStack) ? Math.max(1, Math.floor(H / h)) : 1;
      if (!isFinite(layers) || layers < 1) layers = 1;
      var stackQty = Math.ceil(qty / layers);
      var override = options && options.stackUnitCounts && options.stackUnitCounts[String(p.id || ('p' + i))];
      if (override != null && allowStack && !p.fill) {
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
      L: L, W: W, H: H, doorW: doorW, doorH: doorH, payload: payload, gap: gap, doorGap: doorGap, allowRotate: allowRotate,
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
          gap: t._gap || 0,
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

  function packUnitsBottomLeft(units, startX, L, W, allowRotate, obstacles, gap) {
    var placed = [];
    var g = gap || 0;
    var fixed = obstacles || [];
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var t = u.t;
      var best = null;
      var orients = typeOrientations(t, allowRotate);
      var xs = [startX];
      var ys = [0];
      fixed.forEach(function (q) { xs.push(q.x, q.x + q.l + g); ys.push(q.y, q.y + q.w + g); });
      placed.forEach(function (q) { xs.push(q.x + q.l + g); ys.push(q.y + q.w + g); });
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
              if (x < f.x + f.l + g - EPS && f.x < x + o.l + g - EPS &&
                  y < f.y + f.w + g - EPS && f.y < y + o.w + g - EPS) { hit = true; break; }
            }
            if (hit) continue;
            for (var qi = 0; qi < placed.length; qi++) {
              var q = placed[qi];
              if (x < q.x + q.l + g - EPS && q.x < x + o.l + g - EPS &&
                  y < q.y + q.w + g - EPS && q.y < y + o.w + g - EPS) { hit = true; break; }
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
        strip: 'M', order: placed.length, baseL: best.l, baseW: best.w, gap: g
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
    // 单元级顺序对 Bottom-Left 很敏感：加一批确定性打乱顺序，帮助在柜门预留单层位。
    if (lowUnits.length <= 2) {
      for (var seed = 1; seed <= 40; seed++) {
        var arr = highUnits.slice();
        var s = seed * 9301 + 49297;
        for (var k = arr.length - 1; k > 0; k--) {
          s = (s * 9301 + 49297) % 233280;
          var j = Math.floor((s / 233280) * (k + 1));
          var tmp = arr[k]; arr[k] = arr[j]; arr[j] = tmp;
        }
        orders.push(arr);
      }
    }

    var best = null;
    function consider(highs, lows) {
      if (!highs || !lows) return;
      var placements = highs.concat(lows);
      var gap = bottomGapMetric(placements, L, W);
      var lowDoor = Infinity;
      lows.forEach(function (p) { lowDoor = Math.min(lowDoor, L - (p.x + p.l)); });
      if (!isFinite(lowDoor)) lowDoor = 0;
      var blocked = 0;
      lows.forEach(function (l) {
        highs.some(function (h) {
          var yHit = l.y < h.y + h.w - EPS && h.y < l.y + l.w - EPS;
          if (yHit && h.x >= l.x + l.l - EPS) { blocked++; return true; }
          return false;
        });
      });
      if (!best ||
          blocked < best.singleBlocked ||
          (blocked === best.singleBlocked && lowDoor < best.singleDoor - EPS) ||
          (blocked === best.singleBlocked && Math.abs(lowDoor - best.singleDoor) < EPS && gap < best.bottomGap - EPS)) {
        best = {
          placements: placements,
          fillCount: 0,
          fillStacks: 0,
          stackCount: placements.length,
          doorClear: Math.max(0, L - Math.max.apply(null, placements.map(function (p) { return p.x + p.l; }))),
          bottomGap: gap,
          singleDoor: lowDoor,
          singleBlocked: blocked,
          score: 4e8,
          stripCount: 1,
          cut: W
        };
      }
    }

    // 预留柜门条带：把单层托盘放进条带，高层垛在剩余长度内重新全局排。
    if (lowUnits.length >= 1 && lowUnits.length <= 2) {
      var doorDepth = 0;
      lowUnits.forEach(function (u) {
        typeOrientations(u.t, P.allowRotate).forEach(function (o) { doorDepth = Math.max(doorDepth, o.l); });
      });
      if (doorDepth > 0 && L - doorDepth > 1000) {
        var highPallets = requiredTypes.map(function (t) {
          var n = unitsForType(t, true).length;
          return {
            id: t.id, name: t.name, code: t.code, l: t.l, w: t.w, h: t.h,
            baseH: t.baseH, qty: n * 2, weight: t.weight, fill: false, color: t.color
          };
        }).filter(function (t) { return t.qty > 0; });
        if (highPallets.length) {
          var highRes = solveCore(
            { l: L - doorDepth, w: W, h: P.H, payload: P.payload },
            highPallets,
            { allowRotate: P.allowRotate, gap: P.gap, allowStack: true, preferSingle: false, doorGap: 0, noMixed: true, noMerge: true }
          );
          if (highRes && highRes.ok) {
            var highs2 = highRes.placements;
            var lows2 = packUnitsBottomLeft(lowUnits, L - doorDepth, L, W, P.allowRotate, null, P.gap);
            if (lows2) consider(highs2, lows2);
          }
        }
      }
    }

    orders.forEach(function (order) {
      var highs = packUnitsBottomLeft(order, 0, L, W, P.allowRotate, null, P.gap);
      if (!highs) return;
      var highEnd = Math.max.apply(null, highs.map(function (p) { return p.x + p.l; }));
      var lows = packUnitsBottomLeft(lowUnits, highEnd, L, W, P.allowRotate, highs, P.gap);
      consider(highs, lows);

      // 单层只有 1 托时，优先把它固定在柜门边，再把高层垛绕开它排。
      if (lowUnits.length === 2) {
        var pairs = [[lowUnits[0], lowUnits[1]], [lowUnits[1], lowUnits[0]]];
        var offs2 = [0, 100, 200, 300, 400, 600];
        pairs.forEach(function (pair) {
          typeOrientations(pair[0].t, P.allowRotate).forEach(function (o1) {
            typeOrientations(pair[1].t, P.allowRotate).forEach(function (o2) {
              offs2.forEach(function (of1) {
                offs2.forEach(function (of2) {
                  [[0, o1.w], [o2.w, 0], [0, W - o2.w], [W - o1.w, 0]].forEach(function (ys3) {
                    var p1 = {
                      typeId: pair[0].t.id, name: pair[0].t.name, code: pair[0].t.code, color: pair[0].t.color, fill: false,
                      x: L - o1.l - of1, y: ys3[0], z: 0, l: o1.l, w: o1.w, h: pair[0].t.h, baseH: pair[0].t.baseH,
                      weight: pair[0].t.weight, rotated: o1.rotated, count: 1, stackHeight: pair[0].t.h,
                      strip: 'M', order: 0, gap: P.gap, baseL: o1.l, baseW: o1.w
                    };
                    var p2 = {
                      typeId: pair[1].t.id, name: pair[1].t.name, code: pair[1].t.code, color: pair[1].t.color, fill: false,
                      x: L - o2.l - of2, y: ys3[1], z: 0, l: o2.l, w: o2.w, h: pair[1].t.h, baseH: pair[1].t.baseH,
                      weight: pair[1].t.weight, rotated: o2.rotated, count: 1, stackHeight: pair[1].t.h,
                      strip: 'M', order: 1, gap: P.gap, baseL: o2.l, baseW: o2.w
                    };
                    if (p1.x < 0 || p2.x < 0) return;
                    if (p1.y + p1.w > W + EPS || p2.y + p2.w > W + EPS) return;
                    if (p1.x < p2.x + p2.l - EPS && p2.x < p1.x + p1.l - EPS &&
                        p1.y < p2.y + p2.w - EPS && p2.y < p1.y + p1.w - EPS) return;
                    var h2 = packUnitsBottomLeft(order, 0, L, W, P.allowRotate, [p1, p2], P.gap);
                    if (h2) consider(h2, [p1, p2]);
                  });
                });
              });
            });
          });
        });
      }

      if (lowUnits.length === 1) {
        var lu = lowUnits[0];
        var offsets = [0, 100, 200, 300, 400, 500, 600, 800, 1000, 1200];
        typeOrientations(lu.t, P.allowRotate).forEach(function (o) {
          offsets.forEach(function (off) {
            var lx = L - o.l - off;
            if (lx < 0) return;
            var ys2 = [0, W - o.w, (W - o.w) / 2];
            ys2.forEach(function (ly) {
              var lp = {
                typeId: lu.t.id, name: lu.t.name, code: lu.t.code, color: lu.t.color, fill: false,
                x: lx, y: ly, z: 0, l: o.l, w: o.w, h: lu.t.h, baseH: lu.t.baseH,
                weight: lu.t.weight, rotated: o.rotated, count: 1, stackHeight: lu.t.h,
                strip: 'M', order: 0, gap: P.gap, baseL: o.l, baseW: o.w
              };
              var h2 = packUnitsBottomLeft(order, 0, L, W, P.allowRotate, [lp], P.gap);
              if (h2) consider(h2, [lp]);
            });
          });
        });
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
          strip: 'B', order: placements.length, baseL: bestO.l, baseW: bestO.w, gap: P.gap,
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
            strip: 'B', order: placements.length, baseL: bestF.l, baseW: bestF.w, gap: P.gap, typeOrder: requiredTypes.length
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
    var doorWarnings = [];
    requiredTypes.concat(fillType ? [fillType] : []).forEach(function (t) {
      if (bad) return;
      var canOrient = P.allowRotate;
      var fitNormal = t.effL <= L && t.effW <= W;
      var fitRot = canOrient && t.effW <= L && t.effL <= W;
      if (!fitNormal && !fitRot) {
        bad = '托盘「' + t.name + '」的底面尺寸 ' + t.l + '×' + t.w + 'mm 放不进柜底 ' + L + '×' + W + 'mm。';
      } else if (t.h > H) {
        bad = '托盘「' + t.name + '」总高 ' + t.h + 'mm，超过柜内净高 ' + H + 'mm。';
      } else if (P.doorH > 0 && t.h > P.doorH) {
        bad = '托盘「' + t.name + '」总高 ' + t.h + 'mm，超过柜门高 ' + P.doorH + 'mm，无法进柜。';
      } else if (P.doorW > 0 && Math.min(t.l, t.w) > P.doorW) {
        doorWarnings.push('托盘「' + t.name + '」短边 ' + Math.min(t.l, t.w) + 'mm 超过门宽 ' + P.doorW + 'mm，请现场复核。');
      }
      if (P.doorH > 0 && t.stackHeight > P.doorH) {
        doorWarnings.push('托盘「' + t.name + '」叠放后垛高 ' + t.stackHeight + 'mm 超过门高 ' + P.doorH + 'mm，整垛不能直接进柜，需在柜内分拆叠放。');
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
    var budget = options && Number(options.timeBudget) > 0 ? Number(options.timeBudget) : TIME_BUDGET_MS;
    var deadline = Date.now() + budget;
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
          var actualX = pl._effX;
          var actualY = y0 + pl._effY;
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
            gap: P.gap,
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
            count: wc, stackHeight: wc * wt.h, strip: 'W', order: wi, gap: P.gap,
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
    if (requiredTypes.length >= 2 && !(options && options.noMixed)) {
      var orders = permutations(requiredTypes, 24);
      var bestBand = null;
      orders.forEach(function (order) {
        var band = fillType
          ? buildDoorPriorityPlan(P, order, fillType, L, W)
          : buildMixedUnitPlan(P, order, fillType, L, W);
        if (!band) return;
        if (!bestBand ||
            band.fillCount > bestBand.fillCount ||
            (band.fillCount === bestBand.fillCount &&
              (band.singleBlocked < (bestBand.singleBlocked || 0) ||
               (band.singleBlocked === (bestBand.singleBlocked || 0) &&
                (band.singleDoor < (bestBand.singleDoor == null ? Infinity : bestBand.singleDoor) - EPS ||
                 (Math.abs(band.singleDoor - (bestBand.singleDoor == null ? Infinity : bestBand.singleDoor)) < EPS &&
                  band.bottomGap < bestBand.bottomGap - EPS)))))) {
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
    // 有叠放垛时，单层垛不再被拉回柜底——单层要留在柜门侧。
    var hasHighStack = best.placements.some(function (p) { return p.count > 1; });
    compactPlacements(best.placements, packingL, W, hasHighStack);
    if (hasHighStack) {
      promoteSinglesToDoor(best.placements, L, W);
      // 换位后再次全量紧凑化：把换位产生的中间缝隙压掉，单层仍保持在高层之后。
      compactPlacements(best.placements, packingL, W, false);
    }
    var maxX = 0, minX = Infinity;
    best.placements.forEach(function (p) {
      maxX = Math.max(maxX, p.x + p.l);
      minX = Math.min(minX, p.x);
    });
    if (!isFinite(minX)) minX = 0;
    var overflow = maxX - packingL;
    if (overflow > EPS) {
      var shiftLeft = Math.min(minX, overflow);
      if (shiftLeft > 0) {
        best.placements.forEach(function (p) { p.x -= shiftLeft; });
        maxX -= shiftLeft;
        minX -= shiftLeft;
      }
    }
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
    var cogW = 0, cogX = 0, cogY = 0;
    best.placements.forEach(function (p) {
      usedArea += p.baseL * p.baseW;
      p.layers.forEach(function (layer) {
        usedVolume += layer.l * layer.w * layer.h;
        var lw = layer.weight || 0;
        cogW += lw;
        cogX += lw * (p.x + (layer.relX || 0) + layer.l / 2);
        cogY += lw * (p.y + (layer.relY || 0) + layer.w / 2);
      });
      maxH = Math.max(maxH, p.stackHeight || p.h);
    });
    var cog = cogW > 0 ? { x: cogX / cogW, y: cogY / cogW } : null;
    var cogOffset = cog ? {
      xPct: (cog.x - L / 2) / L * 100,
      yPct: (cog.y - W / 2) / W * 100
    } : null;

    var warnings = doorWarnings.slice();
    if (weightKnown && P.payload > 0 && totalWeight > P.payload) {
      warnings.push('总重 ' + Math.round(totalWeight).toLocaleString('zh-CN') + ' kg，超过箱型载重 ' + P.payload.toLocaleString('zh-CN') + ' kg，请减少货物或分柜。');
    }
    if (P.gap > 0) {
      warnings.push('已按 ' + P.gap + 'mm 托盘间隙计算，实际装柜请预留叉车操作空间。');
    }
    if (P.allowStack) {
      warnings.push('按叠放计算：上面托盘的长短边都不超过下方托盘时才允许叠放。');
    }
    if (weightKnown && cogOffset && (Math.abs(cogOffset.xPct) > 5 || Math.abs(cogOffset.yPct) > 5)) {
      warnings.push('估算重心偏离柜体中心：纵向 ' + cogOffset.xPct.toFixed(1) + '%，横向 ' + cogOffset.yPct.toFixed(1) + '%；请现场复核偏载。');
    }

    best.placements.sort(function (a, b) { return a.order - b.order; });
    best.placements.forEach(function (p, idx) { p.seq = idx + 1; });

    // 装柜间隙复核：
    // 同一排（相同柜长起点）的托盘宽度之和 vs 柜内宽，剩余 < 80mm 报警；
    // 同一列（相同柜宽起点）的托盘长度之和 vs 柜内长，剩余 < 200mm 报警。
    // 宽度间隙：按柜长方向做真实截面扫描，避免交错排布漏报。
    var xEdges = [0, L];
    best.placements.forEach(function (p) { xEdges.push(p.x, p.x + p.l); });
    xEdges = xEdges.filter(function (v, i, a) { return v >= -EPS && v <= L + EPS && a.indexOf(v) === i; })
      .sort(function (a, b) { return a - b; });
    var widthSegs = [];
    for (var xi = 0; xi < xEdges.length - 1; xi++) {
      var xa = xEdges[xi], xb = xEdges[xi + 1];
      if (xb - xa <= EPS) continue;
      var mid = (xa + xb) / 2;
      var usedW = 0, seqsW = [];
      best.placements.forEach(function (p) {
        if (p.x < mid && p.x + p.l > mid) { usedW += p.w; seqsW.push(p.seq); }
      });
      var leftW = W - usedW;
      if (usedW > 0 && leftW < 80) {
        widthSegs.push({ x0: xa, x1: xb, used: usedW, clearance: leftW, seqs: seqsW });
      }
    }
    var clearanceWarnings = [];
    for (var wi = 0; wi < widthSegs.length; wi++) {
      var seg = widthSegs[wi];
      if (wi > 0 && Math.abs(widthSegs[wi - 1].x1 - seg.x0) < 1 &&
          Math.abs(widthSegs[wi - 1].clearance - seg.clearance) < 1) {
        var prev = clearanceWarnings[clearanceWarnings.length - 1];
        prev.x1 = seg.x1;
        prev.seqs = prev.seqs.concat(seg.seqs).filter(function (v, i, a) { return a.indexOf(v) === i; });
      } else {
        clearanceWarnings.push({
          axis: 'width',
          at: seg.x0,
          x1: seg.x1,
          used: seg.used,
          clearance: seg.clearance,
          threshold: 80,
          seqs: seg.seqs,
          text: '柜长 ' + Math.round(seg.x0) + '–' + Math.round(seg.x1) + 'mm 截面：托盘宽度合计 ' + Math.round(seg.used) + 'mm，柜内宽 ' + W + 'mm，剩余 ' + Math.round(seg.clearance) + 'mm（< 80mm）'
        });
      }
    }
    var lengthGroups = Object.create(null);
    best.placements.forEach(function (p) {
      var yKey = Math.round(p.y);
      (lengthGroups[yKey] = lengthGroups[yKey] || []).push(p);
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
      cog: cog,
      cogOffset: cogOffset,
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
    if (!required.length) return null;
    var H = Math.round(Number(container.h) || 0);

    // 多规格：用面积预算给一个“高地面垛位”目标，避免在 40HQ 上反复跑 DP。
    if (required.length > 1) {
      var floorA = (Math.round(Number(container.l) || 0) * Math.round(Number(container.w) || 0));
      var counts2 = {};
      var areas = [];
      var sumArea = 0;
      required.forEach(function (p) {
        var id = String(p.id);
        counts2[id] = Math.max(0, Math.round(Number(p.qty) || 0));
        var a = Math.round(Number(p.l) || 0) * Math.round(Number(p.w) || 0);
        areas.push({ id: id, a: a, t: p });
        sumArea += a * counts2[id];
      });
      while (sumArea > floorA * 0.92) {
        areas.sort(function (x, y) {
          return (y.a * counts2[y.id]) - (x.a * counts2[x.id]);
        });
        var reduced = false;
        for (var ri = 0; ri < areas.length; ri++) {
          var it = areas[ri];
          var minU = Math.ceil(Number(it.t.qty) / Math.max(1, Math.floor(H / Math.max(1, Number(it.t.h) || 1))));
          if (counts2[it.id] > minU) {
            counts2[it.id]--;
            sumArea -= it.a;
            reduced = true;
            break;
          }
        }
        if (!reduced) break;
      }
      var r2 = solveCore(container, pallets, Object.assign({}, options, {
        allowStack: true, noMerge: true, timeBudget: 700, stackUnitCounts: counts2
      }));
      if (r2 && r2.ok) {
        r2.stackingUsed = true;
        r2.strategy = 'min-stack';
        r2.allowStack = true;
        return r2;
      }
      return null;
    }

    var starts = {};
    var maxUnits = {};
    var total = 0;
    required.forEach(function (p) {
      var qty = Math.round(Number(p.qty) || 0);
      var layers = Math.max(1, Math.floor(H / Math.max(1, Math.round(Number(p.h) || 1))));
      var min = Math.ceil(qty / layers);
      starts[String(p.id)] = min;
      maxUnits[String(p.id)] = qty;
      total += min;
    });
    if (!required.length) return null;

    function evaluateCounts(counts) {
      var opts = Object.assign({}, options, {
        allowStack: true,
        noMerge: true,
        timeBudget: 180,
        stackUnitCounts: counts
      });
      return solveCore(container, pallets, opts);
    }

    var counts = Object.assign({}, starts);
    var best = evaluateCounts(counts);
    if (!best || !best.ok) return null;
    var bestTotal = total;
    var deadline = Date.now() + 1800;

    // 多规格：从“最大叠放”开始逐规格增加地面垛位，取可行的最大地面垛位数。
    for (var iter = 0; iter < 40 && Date.now() < deadline; iter++) {
      var improved = false;
      var candidateList = [];
      required.forEach(function (p) {
        var id = String(p.id);
        if (counts[id] >= maxUnits[id]) return;
        var c = Object.assign({}, counts);
        c[id] += 1;
        candidateList.push(c);
      });
      var chosen = null;
      var chosenTotal = bestTotal;
      var chosenCounts = null;
      for (var ci = 0; ci < candidateList.length; ci++) {
        if (Date.now() > deadline) break;
        var r = evaluateCounts(candidateList[ci]);
        if (!r || !r.ok) continue;
        var sumUnits = 0;
        Object.keys(candidateList[ci]).forEach(function (id) { sumUnits += candidateList[ci][id]; });
        if (sumUnits > chosenTotal ||
            (sumUnits === chosenTotal && r.fillCount > (chosen ? chosen.fillCount : -1))) {
          chosen = r;
          chosenTotal = sumUnits;
          chosenCounts = candidateList[ci];
        }
      }
      if (chosen) {
        best = chosen;
        counts = chosenCounts;
        bestTotal = chosenTotal;
        improved = true;
      }
      if (!improved) break;
    }

    if (best) {
      best.stackingUsed = true;
      best.strategy = 'min-stack';
      best.allowStack = true;
    }
    return best;
  }

  function mergeSameSize(pallets) {
    var out = [];
    var map = {};
    var groups = [];
    pallets.forEach(function (p) {
      var dup = null;
      if (!p.fill) {
        for (var i = 0; i < out.length; i++) {
          var q = out[i];
          if (!q.fill && q.l === p.l && q.w === p.w && q.h === p.h) { dup = q; break; }
        }
      }
      if (dup) {
        dup.qty = (Number(dup.qty) || 0) + (Number(p.qty) || 0);
        map[String(p.id)] = String(dup.id);
        var g = groups.filter(function (x) { return x.into === String(dup.id); })[0];
        if (!g) { g = { into: String(dup.id), from: [String(dup.id)] }; groups.push(g); }
        g.from.push(String(p.id));
      } else {
        out.push(Object.assign({}, p));
      }
    });
    return { pallets: out, map: map, groups: groups };
  }

  /*
   * 外层策略：
   * - 关闭叠放：直接按单层算。
   * - 不叠放优先：先全部单层；放不下时，用最小叠放方案（优先多地面垛位）。
   * - 叠放优先：先按最大叠放算。
   */
  function solve(container, pallets, options) {
    var base = Object.assign({}, options || {});
    var singleOpts = Object.assign({}, base, { allowStack: false, allowFillStack: base.allowStack !== false });
    var merged = mergeSameSize(pallets);
    var work = merged.pallets;
    function stamp(res) {
      if (res) {
        res.mergedMap = merged.map;
        res.mergedGroups = merged.groups;
      }
      return res;
    }

    if (base.allowStack === false) {
      var onlySingle = solveCore(container, work, singleOpts);
      if (onlySingle) { onlySingle.stackingUsed = false; onlySingle.strategy = 'single'; }
      return stamp(onlySingle);
    }

    var single = solveCore(container, work, singleOpts);
    var hasFill = work.some(function (p) { return p.fill; });
    if (base.preferSingle === false && !hasFill && single && single.ok) {
      single.stackingUsed = false;
      single.strategy = 'single-no-fill';
      single.allowStack = true;
      return stamp(single);
    }
    if (base.preferSingle !== false) {
      if (single && single.ok) {
        single.stackingUsed = false;
        single.strategy = 'single-preferred';
        single.allowStack = true;
        return stamp(single);
      }
      var least = solveLeastStacking(container, work, base);
      if (least && least.ok) return stamp(least);
    }

    // 叠放优先：先尝试最大叠放；叠放放不下再退回单层。
    var stacked = solveCore(container, work, base);
    if (stacked && stacked.ok) {
      stacked.stackingUsed = true;
      stacked.strategy = 'stacked-preferred';
      return stamp(stacked);
    }
    if (single && single.ok) {
      single.stackingUsed = false;
      single.strategy = 'single-fallback';
      single.allowStack = true;
      return stamp(single);
    }
    return stamp(stacked || single);
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








