/*!
 * Container Loader — 单层托盘装柜求解器
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
  /* 箱型 / 托盘预处理                                                   */
  /* ------------------------------------------------------------------ */

  function prepare(container, pallets, options) {
    var L = Math.round(Number(container.l) || 0);
    var W = Math.round(Number(container.w) || 0);
    var H = Math.round(Number(container.h) || 0);
    var payload = Math.max(0, Number(container.payload) || 0);
    var gap = Math.max(0, Math.round(Number(options && options.gap) || 0));
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
        stackQty: Math.ceil(qty / layers),
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
      L: L, W: W, H: H, payload: payload, gap: gap, allowRotate: allowRotate,
      allowStack: allowStack, pallets: normalized
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
  /* 主求解                                                              */
  /* ------------------------------------------------------------------ */

  function solve(container, pallets, options) {
    var P = prepare(container, pallets, options || {});
    var L = P.L, W = P.W, H = P.H;
    var all = P.pallets;
    var requiredTypes = all.filter(function (t) { return !t.fill && t.qty > 0; });
    var fillType = all.filter(function (t) { return t.fill; })[0] || null;

    if (!L || !W || !H) {
      return { ok: false, error: '请填写有效的柜内长、宽、高。' };
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
    if (requiredStackArea > floorArea + EPS) {
      return {
        ok: false,
        error: '必装按 ' + requiredStacks + ' 个垛位计算，占地 ' + (requiredStackArea / 1e6).toFixed(2) + ' m²，超过柜底 ' + (floorArea / 1e6).toFixed(2) + ' m²。',
        requiredArea: requiredArea,
        floorArea: floorArea,
        suggestions: [
          '换更大的柜型，或减少必装数量。',
          P.allowStack ? '当前已启用同规格叠放；可增加每垛层数上限或更换更高柜型。' : '打开“允许同规格叠放”可以减少所需垛位。'
        ]
      };
    }

    var fillUpperBound = null;
    var fillLayers = fillType ? fillType.layers : 1;
    if (fillType) {
      var fillStacksMax = Math.floor((floorArea - requiredStackArea) / fillType.effArea + EPS);
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
        var plan = stripPlan(L, strips[s].depth, req);
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

      // 垛位上的实际托盘数：必装按“满垛优先”分配，补柜尽量满垛。
      var countOk = true;
      requiredTypes.forEach(function (t) {
        var arr = placements.filter(function (p) { return p.typeId === t.id; });
        var remain = t.qty;
        arr.forEach(function (p) {
          var c = Math.min(t.layers, remain);
          p.count = c;
          p.layers = c;
          p.stackHeight = c * t.h;
          remain -= c;
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
      var fillCompact = fillPlacements.length ? 1 - fillBox.area / floorArea : 0;
      var reqCompact = reqPlacements.length ? 1 - reqBox.area / floorArea : 0;
      var score = fillCount * 1e12 + fillCompact * 1e8 + reqCompact * 1e6 + (placements.length * 1e-3);

      return {
        placements: placements,
        fillCount: fillCount,
        fillStacks: fillStacks,
        stackCount: placements.length,
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

    // 结果统计
    var totalWeight = 0;
    var weightKnown = false;
    var typeCounts = Object.create(null);
    var stackCounts = Object.create(null);
    var totalCount = 0;
    best.placements.forEach(function (p) {
      totalCount += p.count;
      totalWeight += (p.weight || 0) * p.count;
      if (p.weight > 0) weightKnown = true;
      typeCounts[p.typeId] = (typeCounts[p.typeId] || 0) + p.count;
      stackCounts[p.typeId] = (stackCounts[p.typeId] || 0) + 1;
    });

    var usedArea = 0;
    var usedVolume = 0;
    var maxH = 0;
    best.placements.forEach(function (p) {
      usedArea += p.l * p.w;
      usedVolume += p.l * p.w * p.h * p.count;
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
      warnings.push('按同规格垂直叠放计算：每垛层数由柜内净高自动确定，不同规格不混叠。');
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
      requiredCount: requiredCount,
      requiredStacks: requiredStacks,
      fillCount: best.fillCount,
      fillStacks: best.fillStacks,
      stackCount: best.stackCount,
      totalCount: totalCount,
      fillUpperBound: fillUpperBound,
      optimalByArea: fillType ? best.fillCount >= fillUpperBound : false,
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
      solveLabel: fillType && best.fillCount >= fillUpperBound ? '达到面积上限' : '条带搜索'
    };
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
