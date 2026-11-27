/*!
 * Container Loader — 单层/叠放托盘装柜求解器（增强版）
 *
 * 坐标系（与装柜现场一致）：
 *   X = 0 柜底（封闭端，装载起点），X = L 柜门；
 *   Y = 0 左侧内壁，Y = W 右侧内壁；Z = 0 柜底，Z = H 柜顶。
 *   所有 placements 的 x/y 都是毫米级真实几何坐标，不做居中或均分空隙。
 *
 * 本次升级内容：
 *   1. 修复多层混合叠放时的逐层累加承重校验（checkStackLoad），杜绝 3/4 层混叠压溃底层；
 *   2. 扩展 buildMixedStackPlan 支持「N 层大托 + 1 层小托」混叠（如 2 大 + 1 小），释放高柜顶部空间；
 *   3. 评分函数引入重心平衡（CoG）惩罚项，在同等装柜量下优先左右对称、防止重货严重偏载；
 *   4. 独立抽离并导出 SOLVER.analyzePlacements(container, placements, options)，支持手动调整后实时重算重心与间隙报警；
 *   5. 保持原有出口强制几何与数量不变量门禁（checkPlacementIntegrity）。
 */
(function (root) {
  'use strict';

  var NODE_CAP = 50000;
  var ALLOC_LIMIT = 128;
  var PATTERN_CAP = 7000;
  var TIME_BUDGET_MS = 1200;
  var EPS = 1e-6;

  function gcd(a, b) {
    a = Math.abs(Math.round(a) || 0);
    b = Math.abs(Math.round(b) || 0);
    while (b) {
      var t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  function gcdArray(arr) {
    var g = 0;
    for (var i = 0; i < arr.length; i++) {
      var v = Math.abs(Math.round(arr[i]) || 0);
      if (v > 0) g = g ? gcd(g, v) : v;
      if (g === 1) return 1;
    }
    return g || 1;
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
  /* 碰撞、间隙、承重与几何不变量校验                                    */
  /* ------------------------------------------------------------------ */

  function overlapsY(a, b) {
    return a.y < b.y + b.w - EPS && b.y < a.y + a.w - EPS;
  }

  function overlapsX(a, b) {
    return a.x < b.x + b.l - EPS && b.x < a.x + a.l - EPS;
  }

  function pairBlocked(a, ax, ay, al, aw, b, gap) {
    var g = Math.max(gap || 0, a.gap || 0, b.gap || 0);
    return ax < b.x + b.l + g - EPS && b.x < ax + al + g - EPS &&
      ay < b.y + b.w + g - EPS && b.y < ay + aw + g - EPS;
  }

  function rotateLayersInPlace(layers) {
    if (!Array.isArray(layers)) return;
    for (var i = 0; i < layers.length; i++) {
      var ly = layers[i];
      var ol = ly.l, ow = ly.w;
      ly.l = ow;
      ly.w = ol;
      var rx = ly.relX || 0, ry = ly.relY || 0;
      ly.relX = ry;
      ly.relY = rx;
      ly.rotated = !ly.rotated;
    }
  }

  function fitsOn(topL, topW, bottomL, bottomW, allowRotate) {
    if (topL <= bottomL + EPS && topW <= bottomW + EPS) {
      return { l: topL, w: topW, rotated: false };
    }
    if (allowRotate && topW <= bottomL + EPS && topL <= bottomW + EPS) {
      return { l: topW, w: topL, rotated: true };
    }
    return null;
  }

  // 从顶层向下逐层累加重量，校验每一层承受其上方全部货物重量的能力（maxLoad）
  function checkStackLoad(layers) {
    if (!Array.isArray(layers) || layers.length <= 1) return true;
    var aboveW = 0;
    for (var idx = layers.length - 1; idx >= 0; idx--) {
      var ly = layers[idx];
      if (ly.maxLoad > 0 && aboveW > ly.maxLoad + EPS) return false;
      aboveW += (ly.weight || 0);
    }
    return true;
  }

  function checkPlacementIntegrity(placements, packingL, W, H, gap, expectedReqCounts) {
    if (!Array.isArray(placements) || !placements.length) return false;
    var reqCounts = Object.create(null);

    for (var i = 0; i < placements.length; i++) {
      var p = placements[i];
      if (!p || !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.l) || !isFinite(p.w)) return false;
      if (p.x < -0.5 || p.y < -0.5 || p.x + p.l > packingL + 0.5 || p.y + p.w > W + 0.5) return false;
      var layers = p.layers && p.layers.length ? p.layers : null;
      var z = 0;
      if (layers) {
        if (!checkStackLoad(layers)) return false;
        for (var k = 0; k < layers.length; k++) {
          var ly = layers[k];
          z += ly.h || 0;
          if (z > H + 0.5) return false;
          if (k > 0) {
            var lo = layers[k - 1];
            var rx = ly.relX || 0, ry = ly.relY || 0;
            if (rx < -0.5 || ry < -0.5 || rx + ly.l > lo.l + 0.5 || ry + ly.w > lo.w + 0.5) return false;
          }
          if (!ly.fill) reqCounts[ly.typeId] = (reqCounts[ly.typeId] || 0) + 1;
        }
      } else {
        if ((p.h || 0) * (p.count || 1) > H + 0.5) return false;
        if (!p.fill) reqCounts[p.typeId] = (reqCounts[p.typeId] || 0) + (p.count || 1);
      }

      for (var j = i + 1; j < placements.length; j++) {
        var q = placements[j];
        var ovX = p.x < q.x + q.l - 0.5 && q.x < p.x + p.l - 0.5;
        var ovY = p.y < q.y + q.w - 0.5 && q.y < p.y + p.w - 0.5;
        if (ovX && ovY) return false;
        if (gap > 0) {
          if (ovY) {
            var gx = p.x <= q.x ? q.x - (p.x + p.l) : p.x - (q.x + q.l);
            if (gx >= -0.5 && gx < gap - 0.5) return false;
          }
          if (ovX) {
            var gy = p.y <= q.y ? q.y - (p.y + p.w) : p.y - (q.y + q.w);
            if (gy >= -0.5 && gy < gap - 0.5) return false;
          }
        }
      }
    }

    if (expectedReqCounts) {
      var keys = Object.keys(expectedReqCounts);
      for (var ki = 0; ki < keys.length; ki++) {
        var id = keys[ki];
        if ((reqCounts[id] || 0) !== expectedReqCounts[id]) return false;
      }
      var placedKeys = Object.keys(reqCounts);
      for (var pi = 0; pi < placedKeys.length; pi++) {
        if ((expectedReqCounts[placedKeys[pi]] || 0) !== reqCounts[placedKeys[pi]]) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* 独立间隙与重心（CoG）分析接口（供求解器与手动拖拽后实时复核共用）     */
  /* ------------------------------------------------------------------ */

  function analyzePlacements(container, placements, options) {
    var L = Math.round(Number(container.l) || 0);
    var W = Math.round(Number(container.w) || 0);
    var H = Math.round(Number(container.h) || 0);
    var payload = Math.max(0, Number(container.payload) || 0);
    var doorGap = Math.max(0, Math.round(Number(options && options.doorGap) || 0));
    var packingL = Math.max(0, L - doorGap);

    var totalWeight = 0;
    var frontHalfWeight = 0; // 柜底侧 0..L/2
    var backHalfWeight = 0;  // 柜门侧 L/2..L
    var weightKnown = false;
    var cogW = 0, cogX = 0, cogY = 0;
    var usedArea = 0;
    var usedVolume = 0;
    var maxH = 0;
    var minX = Infinity, maxX = 0;

    (placements || []).forEach(function (p) {
      var bl = p.baseL || p.l;
      var bw = p.baseW || p.w;
      usedArea += bl * bw;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + p.l);
      maxH = Math.max(maxH, p.stackHeight || p.h);

      var layers = (p.layers && p.layers.length) ? p.layers : [{
        l: p.l, w: p.w, h: p.h, weight: p.weight, relX: 0, relY: 0
      }];
      layers.forEach(function (layer) {
        usedVolume += (layer.l || p.l) * (layer.w || p.w) * (layer.h || p.h);
        var lw = layer.weight || 0;
        totalWeight += lw;
        if (lw > 0) weightKnown = true;
        var cx = p.x + (layer.relX || 0) + (layer.l || p.l) / 2;
        var cy = p.y + (layer.relY || 0) + (layer.w || p.w) / 2;
        if (cx <= L / 2) frontHalfWeight += lw;
        else backHalfWeight += lw;
        cogW += lw;
        cogX += lw * cx;
        cogY += lw * cy;
      });
    });

    if (!isFinite(minX)) minX = 0;
    var cog = cogW > 0 ? { x: cogX / cogW, y: cogY / cogW } : null;
    var cogOffset = cog ? {
      xPct: L > 0 ? (cog.x - L / 2) / L * 100 : 0,
      yPct: W > 0 ? (cog.y - W / 2) / W * 100 : 0
    } : null;

    // 宽向截面间隙扫描（余量 < 80mm 报警）
    var xEdges = [0, L];
    (placements || []).forEach(function (p) { xEdges.push(p.x, p.x + p.l); });
    xEdges = xEdges.filter(function (v, i, a) { return v >= -EPS && v <= L + EPS && a.indexOf(v) === i; })
      .sort(function (a, b) { return a - b; });
    var widthSegs = [];
    for (var xi = 0; xi < xEdges.length - 1; xi++) {
      var xa = xEdges[xi], xb = xEdges[xi + 1];
      if (xb - xa <= EPS) continue;
      var midX = (xa + xb) / 2;
      var usedW = 0, seqsW = [];
      (placements || []).forEach(function (p) {
        if (p.x < midX && p.x + p.l > midX) { usedW += p.w; seqsW.push(p.seq); }
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
        prev.text = '柜长 ' + Math.round(prev.at) + '–' + Math.round(seg.x1) + 'mm 截面：托盘宽度合计 ' + Math.round(prev.used) + 'mm，柜内宽 ' + W + 'mm，剩余 ' + Math.round(prev.clearance) + 'mm（< 80mm）';
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

    // 长向截面间隙扫描（余量 < 200mm 报警）
    var yEdges = [0, W];
    (placements || []).forEach(function (p) { yEdges.push(p.y, p.y + p.w); });
    yEdges = yEdges.filter(function (v, i, a) { return v >= -EPS && v <= W + EPS && a.indexOf(v) === i; })
      .sort(function (a, b) { return a - b; });
    var lengthSegs = [];
    for (var yi = 0; yi < yEdges.length - 1; yi++) {
      var ya = yEdges[yi], yb = yEdges[yi + 1];
      if (yb - ya <= EPS) continue;
      var midY = (ya + yb) / 2;
      var usedL = 0, seqsL = [];
      (placements || []).forEach(function (p) {
        if (p.y < midY && p.y + p.w > midY) { usedL += p.l; seqsL.push(p.seq); }
      });
      var leftL = L - usedL;
      if (usedL > 0 && leftL < 200) {
        lengthSegs.push({ y0: ya, y1: yb, used: usedL, clearance: leftL, seqs: seqsL });
      }
    }

    for (var li = 0; li < lengthSegs.length; li++) {
      var lseg = lengthSegs[li];
      var lastCW = clearanceWarnings[clearanceWarnings.length - 1];
      if (lastCW && lastCW.axis === 'length' &&
          Math.abs(lastCW.y1 - lseg.y0) < 1 &&
          Math.abs(lastCW.clearance - lseg.clearance) < 1 &&
          lastCW.seqs.join(',') === lseg.seqs.join(',')) {
        lastCW.y1 = lseg.y1;
        lastCW.text = '柜宽 ' + Math.round(lastCW.at) + '–' + Math.round(lseg.y1) + 'mm 截面：托盘长度合计 ' + Math.round(lastCW.used) + 'mm，柜内长 ' + L + 'mm，剩余 ' + Math.round(lastCW.clearance) + 'mm（< 200mm）';
      } else {
        clearanceWarnings.push({
          axis: 'length',
          at: lseg.y0,
          y1: lseg.y1,
          used: lseg.used,
          clearance: lseg.clearance,
          threshold: 200,
          seqs: lseg.seqs,
          text: '柜宽 ' + Math.round(lseg.y0) + '–' + Math.round(lseg.y1) + 'mm 截面：托盘长度合计 ' + Math.round(lseg.used) + 'mm，柜内长 ' + L + 'mm，剩余 ' + Math.round(lseg.clearance) + 'mm（< 200mm）'
        });
      }
    }

    clearanceWarnings.sort(function (a, b) {
      if (a.axis !== b.axis) return a.axis === 'width' ? -1 : 1;
      return a.at - b.at;
    });

    var warnings = [];
    if (weightKnown && payload > 0 && totalWeight > payload) {
      warnings.push('总重 ' + Math.round(totalWeight).toLocaleString('zh-CN') + ' kg，超过箱型载重 ' + payload.toLocaleString('zh-CN') + ' kg，请减少必装货物或分柜。');
    }
    if (weightKnown && cogOffset && (Math.abs(cogOffset.xPct) > 5 || Math.abs(cogOffset.yPct) > 5)) {
      var frontPct = totalWeight > 0 ? (frontHalfWeight / totalWeight * 100).toFixed(0) : '50';
      var backPct = totalWeight > 0 ? (backHalfWeight / totalWeight * 100).toFixed(0) : '50';
      warnings.push('估算重心偏离柜体中心：纵向 ' + cogOffset.xPct.toFixed(1) + '%（前/后半柜承重比 ' + frontPct + '% / ' + backPct + '%），横向 ' + cogOffset.yPct.toFixed(1) + '%；请现场复核偏载。');
    }

    var floorArea = L * W;
    var volume = L * W * H;
    return {
      floorArea: floorArea,
      floorUsed: usedArea,
      floorUtil: floorArea ? usedArea / floorArea : 0,
      volume: volume,
      volumeUsed: usedVolume,
      volumeUtil: volume ? usedVolume / volume : 0,
      totalWeight: totalWeight,
      frontHalfWeight: frontHalfWeight,
      backHalfWeight: backHalfWeight,
      weightKnown: weightKnown,
      cog: cog,
      cogOffset: cogOffset,
      maxHeight: maxH,
      doorClearance: Math.max(0, L - maxX),
      bottomGap: Math.max(0, minX),
      packingLength: packingL,
      clearanceWarnings: clearanceWarnings,
      clearanceOk: clearanceWarnings.length === 0,
      warnings: warnings
    };
  }

  /* ------------------------------------------------------------------ */
  /* 二次紧凑化（X=0 柜底，Y=0 左内壁）                                  */
  /* ------------------------------------------------------------------ */

  function promoteSinglesToDoor(placements, packingL, W, gap) {
    var lows = placements.filter(function (p) { return p.count === 1; });
    var highs = placements.filter(function (p) { return p.count > 1; });
    lows.forEach(function (p) {
      var blockers = highs.filter(function (q) {
        return overlapsY(p, q) && q.x >= p.x + p.l - EPS;
      }).sort(function (a, b) { return b.x - a.x; });
      for (var i = 0; i < blockers.length; i++) {
        var q = blockers[i];
        if (Math.abs(q.l - p.l) > EPS || Math.abs(q.w - p.w) > EPS) continue;
        var px = p.x, py = p.y, qx = q.x, qy = q.y;
        p.x = qx; p.y = qy; q.x = px; q.y = py;
        var hit = false;
        for (var a = 0; a < placements.length && !hit; a++) {
          var A = placements[a];
          if (A.x < -EPS || A.y < -EPS || A.x + A.l > packingL + EPS || A.y + A.w > W + EPS) hit = true;
          for (var b = a + 1; b < placements.length && !hit; b++) {
            var B = placements[b];
            if (pairBlocked(A, A.x, A.y, A.l, A.w, B, gap)) hit = true;
          }
        }
        if (!hit) return;
        p.x = px; p.y = py; q.x = qx; q.y = qy;
      }
    });
  }

  function buildHighFirstPlacements(placements, packingL, W, gap, allowRotate) {
    var highs = placements.filter(function (p) { return p.count > 1; });
    var lows = placements.filter(function (p) { return p.count === 1; });
    if (!highs.length || !lows.length) return null;
    function units(arr) {
      return arr.map(function (p) {
        return {
          t: {
            l: p.l, w: p.w, h: p.h, baseH: p.baseH, color: p.color,
            name: p.name, code: p.code, allowRotate: p.allowRotate !== false
          },
          count: p.count, src: p
        };
      });
    }
    var hp = packUnitsBottomLeft(units(highs), 0, packingL, W, allowRotate, null, gap);
    if (!hp) return null;
    var lowOrders = [
      lows,
      lows.slice().sort(function (a, b) { return b.l * b.w - a.l * a.w || b.w - a.w; }),
      lows.slice().sort(function (a, b) { return a.l * a.w - b.l * b.w || a.w - b.w; }),
      lows.slice().sort(function (a, b) { return String(a.typeId).localeCompare(String(b.typeId)); }),
      lows.slice().sort(function (a, b) { return String(b.typeId).localeCompare(String(a.typeId)); })
    ];
    var lp = null;
    for (var li = 0; li < lowOrders.length; li++) {
      lp = packUnitsBottomLeft(units(lowOrders[li]), 0, packingL, W, allowRotate, hp, gap);
      if (lp) break;
    }
    if (!lp) return null;
    var out = [];
    function copy(src, p) {
      var res = Object.assign({}, src, {
        x: p.x, y: p.y, l: p.l, w: p.w, rotated: p.rotated,
        gap: gap, baseL: p.l, baseW: p.w
      });
      if (src.layers) {
        res.layers = src.layers.map(function (ly) { return Object.assign({}, ly); });
        if (p.l !== src.l || p.w !== src.w) {
          rotateLayersInPlace(res.layers);
        }
      }
      return res;
    }
    hp.forEach(function (p) { out.push(copy(p.src, p)); });
    lp.forEach(function (p) { out.push(copy(p.src, p)); });
    return out;
  }

  function countBlockedSingles(placements) {
    var blocked = 0;
    var highMaxX = 0;
    for (var i = 0; i < placements.length; i++) {
      var p = placements[i];
      if (p.count > 1) highMaxX = Math.max(highMaxX, p.x + p.l);
      if (p.count !== 1) continue;
      for (var j = 0; j < placements.length; j++) {
        var q = placements[j];
        if (q === p || q.count <= 1) continue;
        if (overlapsY(p, q) && q.x >= p.x + p.l - EPS) {
          blocked++;
          break;
        }
      }
    }
    return { blocked: blocked, highMaxX: highMaxX };
  }

  function compactPlacements(placements, packingL, W, preserveSingles, defaultGap) {
    if (!placements.length) return;
    var gDef = defaultGap || 0;

    function canMoveTo(p, nx, ny) {
      if (nx < -EPS || ny < -EPS || nx + p.l > packingL + EPS || ny + p.w > W + EPS) return false;
      for (var i = 0; i < placements.length; i++) {
        var q = placements[i];
        if (q === p) continue;
        var g = Math.max(gDef, p.gap || 0, q.gap || 0);
        if (nx < q.x + q.l + g - EPS && q.x < nx + p.l + g - EPS &&
            ny < q.y + q.w + g - EPS && q.y < ny + p.w + g - EPS) {
          return false;
        }
      }
      return true;
    }

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

      var byX = placements.slice().sort(function (a, b) {
        return a.x - b.x || a.y - b.y;
      });
      byX.forEach(function (p) {
        if (p.noAlign) return;
        if (preserveSingles && p.count === 1) return;
        var target = 0;
        placements.forEach(function (q) {
          if (q === p || !overlapsY(p, q)) return;
          var g = Math.max(gDef, p.gap || 0, q.gap || 0);
          if (q.x < p.x + EPS) target = Math.max(target, q.x + q.l + g);
        });
        if (target < p.x - EPS && canMoveTo(p, target, p.y)) {
          p.x = target;
          moved = true;
        }
      });

      var byY = placements.slice().sort(function (a, b) {
        return a.y - b.y || a.x - b.x;
      });
      byY.forEach(function (p) {
        if (p.noAlign) return;
        if (preserveSingles && p.count === 1) return;
        var target = 0;
        placements.forEach(function (q) {
          if (q === p || !overlapsX(p, q)) return;
          var g = Math.max(gDef, p.gap || 0, q.gap || 0);
          if (q.y < p.y + EPS) target = Math.max(target, q.y + q.w + g);
        });
        if (target < p.y - EPS && canMoveTo(p, p.x, target)) {
          p.y = target;
          moved = true;
        }
      });

      if (!moved) break;
    }

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
    var loadLineH = Math.max(0, Math.round(Number(container.loadLineH) || 0));
    var openTop = !!container.openTop;
    var reefer = !!container.reefer;
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

      var skuAllowRotate = allowRotate && (p.allowRotate !== false);
      var skuAllowStack = (p.fill ? allowFillStack : allowStack) && (p.allowStack !== false);
      var weight = Math.max(0, Number(p.weight) || 0);
      var maxLoad = Math.max(0, Number(p.maxLoad) || 0);
      var maxLayersOpt = Math.max(0, Math.round(Number(p.maxLayers) || 0));

      var layers = skuAllowStack ? Math.max(1, Math.floor(H / h)) : 1;
      if (!isFinite(layers) || layers < 1) layers = 1;
      if (maxLayersOpt >= 1) layers = Math.min(layers, maxLayersOpt);
      if (maxLoad > 0 && weight > 0) {
        layers = Math.min(layers, 1 + Math.floor(maxLoad / weight + EPS));
      }

      var stackQty = Math.ceil(qty / layers);
      var override = options && options.stackUnitCounts && options.stackUnitCounts[String(p.id || ('p' + i))];
      if (override != null && skuAllowStack && !p.fill) {
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
        weight: weight,
        maxLoad: maxLoad,
        maxLayers: maxLayersOpt,
        allowRotate: skuAllowRotate,
        allowStack: skuAllowStack,
        fill: !!p.fill,
        color: Number(p.color) || 0,
        effL: rawL + gap,
        effW: rawW + gap,
        rawArea: rawL * rawW,
        effArea: (rawL + gap) * (rawW + gap)
      });
    }

    return {
      L: L, W: W, H: H, doorW: doorW, doorH: doorH,
      loadLineH: loadLineH, openTop: openTop, reefer: reefer,
      payload: payload, gap: gap, doorGap: doorGap,
      allowRotate: allowRotate, allowStack: allowStack, allowFillStack: allowFillStack,
      noMerge: !!(options && options.noMerge), pallets: normalized
    };
  }

  /* ------------------------------------------------------------------ */
  /* 模式生成：一条长条内，沿宽度并排若干托盘，形成一段“横向条带”      */
  /* ------------------------------------------------------------------ */

  function getPatterns(D, requiredTypes, fillType, allowRotate, cache) {
    var key = D + '|' + (allowRotate ? 1 : 0) + '|' +
      requiredTypes.map(function (t) { return t.id + ':' + (t.allowRotate ? 1 : 0); }).join(',') + '|' +
      (fillType ? (fillType.id + ':' + (fillType.allowRotate ? 1 : 0)) : '-');
    if (cache.has(key)) return cache.get(key);

    var allTypes = requiredTypes.slice();
    if (fillType) allTypes.push(fillType);

    var options = [];
    for (var ti = 0; ti < allTypes.length; ti++) {
      var t = allTypes[ti];
      options.push({ ti: ti, oi: 0, len: t.effL, wid: t.effW, rotated: false });
      if (allowRotate && t.allowRotate !== false && t.effL !== t.effW) {
        options.push({ ti: ti, oi: 1, len: t.effW, wid: t.effL, rotated: true });
      }
    }
    options = options.filter(function (o) { return o.wid <= D; });
    options.sort(function (a, b) { return b.wid - a.wid || a.ti - b.ti; });

    var patterns = [];
    var seen = Object.create(null);
    var maxSlots = 4;
    if (options.length && D / options[options.length - 1].wid > 4) {
      maxSlots = Math.min(8, Math.floor(D / options[options.length - 1].wid));
    }

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
      var usedArea = 0;
      for (var j = 0; j < sorted.length; j++) {
        var s = sorted[j];
        len = Math.max(len, s.len);
        width += s.wid;
        usedArea += s.len * s.wid;
        if (fillType && s.ti === allTypes.length - 1) fillUse++;
        else reqUse[s.ti]++;
      }
      patterns.push({
        slots: sorted,
        reqUse: reqUse,
        fillUse: fillUse,
        len: len,
        width: width,
        waste: len * width - usedArea,
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
      if (!fillType && a.waste !== b.waste) return a.waste - b.waste;
      if (b.reqSum !== a.reqSum) return b.reqSum - a.reqSum;
      return a.len - b.len;
    });

    var minLen = Infinity;
    for (var k = 0; k < patterns.length; k++) minLen = Math.min(minLen, patterns[k].len);
    var stepGcd = patterns.length ? gcdArray(patterns.map(function (p) { return p.len; })) : 1;
    var result = { patterns: patterns, minLen: minLen, stepGcd: stepGcd };
    cache.set(key, result);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /* 一条长条的 DP：必装数量必须放完，最大化补柜数 / 剩余长度           */
  /* ------------------------------------------------------------------ */

  function packStrip(L, D, requiredTypes, fillType, reqCounts, allowRotate, patternCache, nodeBudget, deadline) {
    if (!L || !D) return null;
    var patternData = getPatterns(D, requiredTypes, fillType, allowRotate, patternCache);
    var patterns = patternData.patterns;
    if (!patterns.length) {
      return isZero(reqCounts) ? { placements: [], fillCount: 0 } : null;
    }

    var stepGcd = patternData.stepGcd || 1;
    var reqArea = [];
    for (var i = 0; i < requiredTypes.length; i++) reqArea.push(requiredTypes[i].effArea);
    var fillArea = fillType ? fillType.effArea : 1;
    var memo = new Map();
    var choice = new Map();
    var nodes = 0;
    var aborted = false;
    var startReq = reqCounts.slice();
    var LEN_SCALE = 100000;

    function requiredArea(counts) {
      var total = 0;
      for (var j = 0; j < counts.length; j++) total += counts[j] * reqArea[j];
      return total;
    }

    function upperScore(x, counts) {
      var remA = requiredArea(counts);
      var maxRemX = Math.max(0, x - Math.ceil(remA / D));
      if (!fillType) return maxRemX * 1000;
      var free = x * D - remA;
      var maxFill = free > 0 ? Math.floor(free / fillArea) : 0;
      return maxFill * LEN_SCALE + maxRemX;
    }

    function dp(usedSteps, counts) {
      if (aborted) return -Infinity;
      var x = L - usedSteps * stepGcd;
      nodes++;
      if (nodes > nodeBudget || ((nodes & 511) === 0 && Date.now() > deadline)) {
        aborted = true;
        return -Infinity;
      }

      var key = usedSteps + '|' + counts.join(',');
      if (!fillType && isZero(counts)) {
        var doneScore = x * 1000;
        memo.set(key, doneScore);
        return doneScore;
      }
      if (memo.has(key)) return memo.get(key);

      var remArea = requiredArea(counts);
      if (remArea > x * D + EPS) {
        memo.set(key, -Infinity);
        return -Infinity;
      }
      if (x < patternData.minLen) {
        var ok = isZero(counts);
        var base = ok ? (fillType ? x : x * 1000) : -Infinity;
        memo.set(key, base);
        return base;
      }

      var best = -Infinity;
      var bestIndex = -1;
      var upper = upperScore(x, counts);

      for (var pi = 0; pi < patterns.length; pi++) {
        var p = patterns[pi];
        if (p.len > x) continue;
        if (!fits(p.reqUse, counts)) continue;
        var next = subtract(counts, p.reqUse);
        var sub = dp(usedSteps + Math.round(p.len / stepGcd), next);
        if (sub < 0) continue;
        var wastePenalty = !fillType ? Math.min(999, Math.round(p.waste / 1000)) : 0;
        var val = (fillType ? p.fillUse * LEN_SCALE : 0) + sub - wastePenalty;
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

    var bestScore = dp(0, startReq);
    if (aborted || bestScore < 0) return null;

    var placements = [];
    var usedSteps = 0;
    var counts = startReq.slice();
    var order = 0;
    var rowIdx = 0;

    while (usedSteps * stepGcd < L) {
      var key = usedSteps + '|' + counts.join(',');
      var pi = choice.get(key);
      if (pi == null) break;
      var p = patterns[pi];
      var segStart = usedSteps * stepGcd;
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
          x: segStart,
          y: yOffset,
          l: actualL,
          w: actualW,
          h: t.h,
          baseH: t.baseH,
          weight: t.weight,
          maxLoad: t.maxLoad,
          allowStack: t.allowStack,
          allowRotate: t.allowRotate,
          rotated: !!slot.rotated,
          _effX: segStart,
          _effY: yOffset,
          _effL: p.len,
          _effW: slot.wid,
          _rowIdx: rowIdx,
          gap: t._gap || 0,
          _gap: t._gap || 0,
          order: order++
        });
        yOffset += slot.wid;
      }
      rowIdx++;
      usedSteps += Math.round(p.len / stepGcd);
      counts = subtract(counts, p.reqUse);
      if (isZero(counts) && usedSteps * stepGcd >= L) break;
    }

    var bestFill = fillType ? Math.floor(bestScore / LEN_SCALE) : 0;
    return { placements: placements, fillCount: bestFill, counts: startReq.map(function (n, i) { return n - counts[i]; }) };
  }

  /* ------------------------------------------------------------------ */
  /* 候选切宽 / 必装分配                                                 */
  /* ------------------------------------------------------------------ */

  function buildCuts(effBoxW, types, allowRotate, gap) {
    var set = Object.create(null);
    var minGap = gap || 0;
    function add(v) {
      v = Math.round(v);
      if (v > minGap && v < effBoxW - minGap) set[v] = true;
    }
    var widths = [];
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      widths.push(t.effW);
      if (allowRotate && t.allowRotate !== false && t.effL !== t.effW) widths.push(t.effL);
    }
    widths.forEach(function (w) {
      add(w);
      add(effBoxW - w);
      add(2 * w);
      add(effBoxW - 2 * w);
      widths.forEach(function (w2) {
        add(w + w2);
        add(effBoxW - (w + w2));
      });
    });
    add(effBoxW / 2);
    add(effBoxW / 3);
    add(2 * effBoxW / 3);
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
  /* 多规格“柜门优先”与全局单元级排布                                    */
  /* ------------------------------------------------------------------ */

  function typeOrientations(t, allowRotate) {
    var out = [{ l: t.l, w: t.w, rotated: false }];
    if (allowRotate && t.allowRotate !== false && t.l !== t.w) {
      out.push({ l: t.w, w: t.l, rotated: true });
    }
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
      var weight = 1 + (1 - mid / maxX);
      gap += Math.max(0, W - covered) * (b - a) * weight;
    }
    return gap;
  }

  function packUnitsBottomLeft(units, startX, packingL, W, allowRotate, obstacles, gap) {
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
            if (x + o.l > packingL + EPS || y + o.w > W + EPS) continue;
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
        weight: t.weight, maxLoad: t.maxLoad, allowStack: t.allowStack, allowRotate: t.allowRotate,
        rotated: best.rotated, count: u.count, stackHeight: u.count * t.h,
        strip: 'M', order: placed.length, baseL: best.l, baseW: best.w, gap: g, src: u.src
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

  function buildMixedUnitPlan(P, requiredTypes, fillType, packingL, W) {
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
      var gap = bottomGapMetric(placements, packingL, W);
      var lowDoor = Infinity;
      lows.forEach(function (p) { lowDoor = Math.min(lowDoor, packingL - (p.x + p.l)); });
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
          doorClear: Math.max(0, P.L - Math.max.apply(null, placements.map(function (p) { return p.x + p.l; }))),
          bottomGap: gap,
          singleDoor: lowDoor,
          singleBlocked: blocked,
          score: 4e8,
          stripCount: 1,
          cut: W
        };
      }
    }

    if (lowUnits.length >= 1 && lowUnits.length <= 2) {
      var doorDepth = 0;
      lowUnits.forEach(function (u) {
        typeOrientations(u.t, P.allowRotate).forEach(function (o) { doorDepth = Math.max(doorDepth, o.l); });
      });
      var highLimitX = packingL - doorDepth - (P.gap || 0);
      if (doorDepth > 0 && highLimitX > 1000) {
        var highUnitCounts = {};
        var highPallets = requiredTypes.map(function (t) {
          var hUnits = unitsForType(t, true);
          var qtySum = hUnits.reduce(function (acc, u) { return acc + u.count; }, 0);
          highUnitCounts[t.id] = hUnits.length;
          return {
            id: t.id, name: t.name, code: t.code, l: t.l, w: t.w, h: t.h,
            baseH: t.baseH, qty: qtySum, weight: t.weight, maxLoad: t.maxLoad,
            maxLayers: t.maxLayers, allowStack: t.allowStack, allowRotate: t.allowRotate,
            fill: false, color: t.color
          };
        }).filter(function (t) { return t.qty > 0; });
        if (highPallets.length) {
          var highRes = solveCore(
            { l: highLimitX, w: W, h: P.H, payload: P.payload, openTop: P.openTop, reefer: P.reefer, loadLineH: P.loadLineH },
            highPallets,
            {
              allowRotate: P.allowRotate, gap: P.gap, allowStack: true, preferSingle: false,
              doorGap: 0, noMixed: true, noMerge: true, stackUnitCounts: highUnitCounts
            }
          );
          if (highRes && highRes.ok) {
            var highs2 = highRes.placements;
            var lows2 = packUnitsBottomLeft(lowUnits, highLimitX + (P.gap || 0), packingL, W, P.allowRotate, null, P.gap);
            if (lows2) consider(highs2, lows2);
          }
        }
      }
    }

    orders.forEach(function (order) {
      var highs = packUnitsBottomLeft(order, 0, packingL, W, P.allowRotate, null, P.gap);
      if (!highs) return;
      var highEnd = Math.max.apply(null, highs.map(function (p) { return p.x + p.l; }));
      var lows = packUnitsBottomLeft(lowUnits, highEnd + (P.gap || 0), packingL, W, P.allowRotate, highs, P.gap);
      if (!lows) {
        lows = packUnitsBottomLeft(lowUnits, 0, packingL, W, P.allowRotate, highs, P.gap);
      }
      consider(highs, lows);

      if (lowUnits.length === 2) {
        var pairs = [[lowUnits[0], lowUnits[1]], [lowUnits[1], lowUnits[0]]];
        var offs2 = [0, 100, 200, 300, 400, 600];
        var g = P.gap || 0;
        pairs.forEach(function (pair) {
          typeOrientations(pair[0].t, P.allowRotate).forEach(function (o1) {
            typeOrientations(pair[1].t, P.allowRotate).forEach(function (o2) {
              offs2.forEach(function (of1) {
                offs2.forEach(function (of2) {
                  [[0, o1.w + g], [o2.w + g, 0], [0, W - o2.w], [W - o1.w, 0]].forEach(function (ys3) {
                    var p1 = {
                      typeId: pair[0].t.id, name: pair[0].t.name, code: pair[0].t.code, color: pair[0].t.color, fill: false,
                      x: packingL - o1.l - of1, y: ys3[0], z: 0, l: o1.l, w: o1.w, h: pair[0].t.h, baseH: pair[0].t.baseH,
                      weight: pair[0].t.weight, maxLoad: pair[0].t.maxLoad, allowStack: pair[0].t.allowStack, allowRotate: pair[0].t.allowRotate,
                      rotated: o1.rotated, count: 1, stackHeight: pair[0].t.h,
                      strip: 'M', order: 0, gap: g, baseL: o1.l, baseW: o1.w
                    };
                    var p2 = {
                      typeId: pair[1].t.id, name: pair[1].t.name, code: pair[1].t.code, color: pair[1].t.color, fill: false,
                      x: packingL - o2.l - of2, y: ys3[1], z: 0, l: o2.l, w: o2.w, h: pair[1].t.h, baseH: pair[1].t.baseH,
                      weight: pair[1].t.weight, maxLoad: pair[1].t.maxLoad, allowStack: pair[1].t.allowStack, allowRotate: pair[1].t.allowRotate,
                      rotated: o2.rotated, count: 1, stackHeight: pair[1].t.h,
                      strip: 'M', order: 1, gap: g, baseL: o2.l, baseW: o2.w
                    };
                    if (p1.x < 0 || p2.x < 0 || p1.y < 0 || p2.y < 0) return;
                    if (p1.y + p1.w > W + EPS || p2.y + p2.w > W + EPS) return;
                    if (pairBlocked(p1, p1.x, p1.y, p1.l, p1.w, p2, g)) return;
                    var h2 = packUnitsBottomLeft(order, 0, packingL, W, P.allowRotate, [p1, p2], g);
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
            var lx = packingL - o.l - off;
            if (lx < 0) return;
            var ys2 = [0, W - o.w, (W - o.w) / 2];
            ys2.forEach(function (ly) {
              if (ly < 0 || ly + o.w > W + EPS) return;
              var lp = {
                typeId: lu.t.id, name: lu.t.name, code: lu.t.code, color: lu.t.color, fill: false,
                x: lx, y: ly, z: 0, l: o.l, w: o.w, h: lu.t.h, baseH: lu.t.baseH,
                weight: lu.t.weight, maxLoad: lu.t.maxLoad, allowStack: lu.t.allowStack, allowRotate: lu.t.allowRotate,
                rotated: o.rotated, count: 1, stackHeight: lu.t.h,
                strip: 'M', order: 0, gap: P.gap, baseL: o.l, baseW: o.w
              };
              var h2 = packUnitsBottomLeft(order, 0, packingL, W, P.allowRotate, [lp], P.gap);
              if (h2) consider(h2, [lp]);
            });
          });
        });
      }
    });
    return best;
  }

  function buildDoorPriorityPlan(P, requiredTypes, fillType, packingL, W, maxFillByWeight) {
    if (!requiredTypes.length) return null;
    var placements = [];
    var bandX = 0;
    var g = P.gap || 0;

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
      var grp = groups[gi];
      var gt = grp.t;
      var gc = grp.counts;
      var gu = gc.length;
      var bestO = null;
      typeOrientations(gt, P.allowRotate).forEach(function (o) {
        var cols = Math.floor((W + g) / (o.w + g));
        if (cols < 1) return;
        var rows = Math.ceil(gu / cols);
        var depth = rows * o.l + (rows - 1) * g;
        if (bandX + depth > packingL + EPS) return;
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
          x: bandX + row * (bestO.l + g), y: col * (bestO.w + g), z: 0,
          l: bestO.l, w: bestO.w, h: gt.h, baseH: gt.baseH, weight: gt.weight,
          maxLoad: gt.maxLoad, allowStack: gt.allowStack, allowRotate: gt.allowRotate,
          rotated: bestO.rotated, count: gc[ui], stackHeight: gc[ui] * gt.h,
          strip: 'B', order: placements.length, baseL: bestO.l, baseW: bestO.w, gap: g,
          typeOrder: grp.typeOrder
        });
      }
      bandX += bestO.depth + g;
    }

    var fillCount = 0;
    var fillStacksUsed = 0;
    if (fillType && maxFillByWeight > 0) {
      var remaining = packingL - bandX;
      var bestF = null;
      if (remaining > 0) {
        typeOrientations(fillType, P.allowRotate).forEach(function (o) {
          var cols = Math.floor((W + g) / (o.w + g));
          var rows = Math.floor((remaining + g) / (o.l + g));
          var units = cols * rows;
          if (units < 1) return;
          var total = Math.min(maxFillByWeight, units * fillType.layers);
          var usedUnits = Math.ceil(total / fillType.layers);
          var usedRows = Math.ceil(usedUnits / cols);
          var usedDepth = usedRows * o.l + Math.max(0, usedRows - 1) * g;
          if (!bestF || total > bestF.total || (total === bestF.total && usedDepth < bestF.depth)) {
            bestF = {
              l: o.l, w: o.w, rotated: o.rotated, cols: cols, rows: rows,
              units: usedUnits, total: total, depth: usedDepth
            };
          }
        });
      }
      if (bestF) {
        var remFill = bestF.total;
        for (var fi = 0; fi < bestF.units && remFill > 0; fi++) {
          var frow = Math.floor(fi / bestF.cols);
          var fcol = fi % bestF.cols;
          var cnt = Math.min(fillType.layers, remFill);
          remFill -= cnt;
          placements.push({
            typeId: fillType.id, name: fillType.name, code: fillType.code, color: fillType.color, fill: true,
            x: bandX + frow * (bestF.l + g), y: fcol * (bestF.w + g), z: 0,
            l: bestF.l, w: bestF.w, h: fillType.h, baseH: fillType.baseH, weight: fillType.weight,
            maxLoad: fillType.maxLoad, allowStack: fillType.allowStack, allowRotate: fillType.allowRotate,
            rotated: bestF.rotated, count: cnt, stackHeight: cnt * fillType.h,
            strip: 'B', order: placements.length, baseL: bestF.l, baseW: bestF.w, gap: g,
            typeOrder: requiredTypes.length
          });
          fillStacksUsed++;
        }
        fillCount = bestF.total;
      }
    }

    return {
      placements: placements,
      fillCount: fillCount,
      fillStacks: fillStacksUsed,
      stackCount: placements.length,
      doorClear: Math.max(0, P.L - Math.max.apply(null, placements.map(function (p) { return p.x + p.l; }))),
      score: fillCount * 1e12 + 4e8,
      bottomGap: bottomGapMetric(placements, P.L, W),
      stripCount: 1,
      cut: W
    };
  }

  /* ------------------------------------------------------------------ */
  /* 通用 4-块风车 + 剩余条带搜索                                        */
  /* ------------------------------------------------------------------ */

  function buildPinwheelCandidates(P, targetType, packingL, W, isFillMode, maxFillByWeight, patternCache, nodeBudget, deadline) {
    if (!P.allowRotate || targetType.allowRotate === false || targetType.l === targetType.w) return null;
    var g = P.gap || 0;
    var longS = Math.max(targetType.l, targetType.w);
    var shortS = Math.min(targetType.l, targetType.w);
    var longRot = (targetType.l !== longS);
    var tileSize = longS + shortS + g;
    if (tileSize > W + EPS || tileSize > packingL + EPS) return null;

    var maxTiles = Math.floor((packingL + g) / (tileSize + g));
    if (maxTiles < 1) return null;

    var best = null;
    var targetReqUnits = isFillMode ? 0 : targetType.stackQty;

    for (var k = 1; k <= maxTiles; k++) {
      if (!isFillMode && 4 * k > targetReqUnits) break;
      var pinEnd = k * tileSize + (k - 1) * g;
      var remStart = pinEnd + g;
      var remPhysicalL = packingL - remStart;
      var remUnits = isFillMode ? 0 : (targetReqUnits - 4 * k);

      var tailPlacements = [];
      var tailFillStacks = 0;

      if (isFillMode || remUnits > 0) {
        if (remPhysicalL < Math.min(longS, shortS) - EPS) {
          if (!isFillMode) continue;
        } else {
          var remEffL = remPhysicalL + g;
          var effW = W + g;
          var reqArr = isFillMode ? [] : [targetType];
          var fillArr = isFillMode ? targetType : null;
          var countsArr = isFillMode ? [] : [remUnits];

          var candStrips = [[{ y0: 0, depth: effW }]];
          var cuts = buildCuts(effW, [targetType], true, g);
          cuts.forEach(function (c) {
            candStrips.push([{ y0: 0, depth: c }, { y0: c, depth: effW - c }]);
          });

          var bestTail = null;
          for (var si = 0; si < candStrips.length; si++) {
            var st = candStrips[si];
            if (st.length === 1) {
              var p1 = packStrip(remEffL, st[0].depth, reqArr, fillArr, countsArr, true, patternCache, nodeBudget, deadline);
              if (p1) {
                var cnt1 = isFillMode ? p1.fillCount : 0;
                if (!bestTail || cnt1 > bestTail.cnt) bestTail = { cnt: cnt1, parts: [{ plan: p1, y0: 0 }] };
              }
            } else if (isFillMode) {
              var pA = packStrip(remEffL, st[0].depth, [], targetType, [], true, patternCache, nodeBudget, deadline);
              var pB = packStrip(remEffL, st[1].depth, [], targetType, [], true, patternCache, nodeBudget, deadline);
              if (pA && pB) {
                var cnt2 = pA.fillCount + pB.fillCount;
                if (!bestTail || cnt2 > bestTail.cnt) bestTail = { cnt: cnt2, parts: [{ plan: pA, y0: st[0].y0 }, { plan: pB, y0: st[1].y0 }] };
              }
            } else {
              for (var a = 0; a <= remUnits; a++) {
                var pA2 = packStrip(remEffL, st[0].depth, reqArr, null, [a], true, patternCache, nodeBudget, deadline);
                if (!pA2) continue;
                var pB2 = packStrip(remEffL, st[1].depth, reqArr, null, [remUnits - a], true, patternCache, nodeBudget, deadline);
                if (!pB2) continue;
                if (!bestTail) bestTail = { cnt: 0, parts: [{ plan: pA2, y0: st[0].y0 }, { plan: pB2, y0: st[1].y0 }] };
                break;
              }
            }
          }
          if (!isFillMode && !bestTail) continue;
          if (bestTail) {
            bestTail.parts.forEach(function (pt) {
              pt.plan.placements.forEach(function (pl) {
                tailPlacements.push({
                  x: remStart + pl._effX, y: pt.y0 + pl._effY,
                  l: pl.l, w: pl.w, rotated: pl.rotated
                });
                if (isFillMode) tailFillStacks++;
              });
            });
          }
        }
      }

      var pinPlaces = [];
      for (var ti = 0; ti < k; ti++) {
        var bx = ti * (tileSize + g);
        var blocks = [
          [bx, 0, longS, shortS, longRot],
          [bx + longS + g, 0, shortS, longS, !longRot],
          [bx, shortS + g, shortS, longS, !longRot],
          [bx + shortS + g, longS + g, longS, shortS, longRot]
        ];
        blocks.forEach(function (b) {
          pinPlaces.push({ x: b[0], y: b[1], l: b[2], w: b[3], rotated: b[4] });
        });
      }

      var allRaw = pinPlaces.concat(tailPlacements);
      var placements = [];
      if (isFillMode) {
        var maxStacks = Math.min(allRaw.length, Math.ceil(maxFillByWeight / targetType.layers));
        var remF = Math.min(allRaw.length * targetType.layers, maxFillByWeight);
        for (var fi = 0; fi < maxStacks && remF > 0; fi++) {
          var fp = allRaw[fi];
          var fc = Math.min(targetType.layers, remF);
          remF -= fc;
          placements.push({
            typeId: targetType.id, name: targetType.name, code: targetType.code, color: targetType.color, fill: true,
            x: fp.x, y: fp.y, z: 0, l: fp.l, w: fp.w, h: targetType.h, baseH: targetType.baseH,
            weight: targetType.weight, maxLoad: targetType.maxLoad, allowStack: targetType.allowStack, allowRotate: targetType.allowRotate,
            rotated: fp.rotated, count: fc, stackHeight: fc * targetType.h,
            strip: 'W', order: fi, gap: g, baseL: fp.l, baseW: fp.w
          });
        }
      } else {
        if (allRaw.length !== targetReqUnits) continue;
        var remQ = targetType.qty;
        for (var ri = 0; ri < allRaw.length; ri++) {
          var rp = allRaw[ri];
          var unitsAfter = allRaw.length - ri - 1;
          var rc = Math.max(1, Math.min(targetType.layers, remQ - unitsAfter));
          remQ -= rc;
          placements.push({
            typeId: targetType.id, name: targetType.name, code: targetType.code, color: targetType.color, fill: false,
            x: rp.x, y: rp.y, z: 0, l: rp.l, w: rp.w, h: targetType.h, baseH: targetType.baseH,
            weight: targetType.weight, maxLoad: targetType.maxLoad, allowStack: targetType.allowStack, allowRotate: targetType.allowRotate,
            rotated: rp.rotated, count: rc, stackHeight: rc * targetType.h,
            strip: 'W', order: ri, gap: g, baseL: rp.l, baseW: rp.w
          });
        }
        if (remQ !== 0) continue;
      }

      var fillCount = isFillMode ? placements.reduce(function (s, p) { return s + p.count; }, 0) : 0;
      var maxX = placements.reduce(function (m, p) { return Math.max(m, p.x + p.l); }, 0);
      var doorClear = Math.max(0, P.L - maxX);
      var score = fillCount * 1e12 + doorClear * 1e8 + 5e7;
      if (!best || score > best.score) {
        best = {
          placements: placements,
          fillCount: fillCount,
          fillStacks: isFillMode ? placements.length : 0,
          stackCount: placements.length,
          doorClear: doorClear,
          bottomGap: bottomGapMetric(placements, P.L, W),
          score: score,
          stripCount: 1,
          cut: W
        };
      }
    }
    return best;
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

    var bad = null;
    var doorWarnings = [];
    requiredTypes.concat(fillType ? [fillType] : []).forEach(function (t) {
      if (bad) return;
      var fitNormal = t.l <= packingL && t.w <= W;
      var fitRot = t.allowRotate && t.w <= packingL && t.l <= W;
      if (!fitNormal && !fitRot) {
        bad = '托盘「' + t.name + '」的底面尺寸 ' + t.l + '×' + t.w + 'mm 放不进可用柜底 ' + packingL + '×' + W + 'mm。';
      } else if (t.h > H) {
        bad = '托盘「' + t.name + '」总高 ' + t.h + 'mm，超过柜内净高 ' + H + 'mm。';
      } else if (!P.openTop && P.doorH > 0 && t.h > P.doorH) {
        bad = '托盘「' + t.name + '」总高 ' + t.h + 'mm，超过柜门高 ' + P.doorH + 'mm，无法进柜。';
      } else if (P.openTop && P.doorH > 0 && t.h > P.doorH) {
        doorWarnings.push('托盘「' + t.name + '」总高 ' + t.h + 'mm 超过门高 ' + P.doorH + 'mm，开顶柜需从顶部吊装。');
      }
      if (!bad && !P.openTop && P.doorW > 0 && Math.min(t.l, t.w) > P.doorW) {
        doorWarnings.push('托盘「' + t.name + '」短边 ' + Math.min(t.l, t.w) + 'mm 超过门宽 ' + P.doorW + 'mm，刚性货物可能无法平推入柜。');
      }
      if (!bad && !P.openTop && P.doorH > 0 && t.stackHeight > P.doorH) {
        doorWarnings.push('托盘「' + t.name + '」叠放后垛高 ' + t.stackHeight + 'mm 超过门高 ' + P.doorH + 'mm，整垛不能直接进柜，需在柜内分拆叠放。');
      }
      if (!bad && P.reefer && P.loadLineH > 0 && t.stackHeight > P.loadLineH) {
        doorWarnings.push('托盘「' + t.name + '」垛高 ' + t.stackHeight + 'mm 超过冷柜红色装载线（约 ' + P.loadLineH + 'mm），可能影响顶部回风循环。');
      }
    });
    if (bad) return { ok: false, error: bad };

    var requiredArea = 0;
    var requiredStackArea = 0;
    var requiredCount = 0;
    var requiredStacks = 0;
    var requiredWeight = 0;
    var expectedReqCounts = Object.create(null);
    requiredTypes.forEach(function (t) {
      requiredArea += t.qty * t.rawArea;
      requiredStackArea += t.stackQty * t.effArea;
      requiredCount += t.qty;
      requiredStacks += t.stackQty;
      requiredWeight += t.qty * t.weight;
      expectedReqCounts[t.id] = t.qty;
    });

    var effPackingL = packingL + P.gap;
    var effBoxW = W + P.gap;
    var floorArea = L * W;

    if (requiredStackArea > effPackingL * effBoxW + EPS) {
      return {
        ok: false,
        error: '必装按 ' + requiredStacks + ' 个垛位计算，占地 ' + (requiredStackArea / 1e6).toFixed(2) + ' m²，超过柜内可用柜底 ' + ((packingL * W) / 1e6).toFixed(2) + ' m²（已预留柜门 ' + P.doorGap + 'mm）。',
        requiredArea: requiredArea,
        floorArea: floorArea,
        suggestions: [
          '换更大的柜型，或减少必装数量。',
          P.allowStack ? '当前已启用叠放；可减少必装或更换更高柜型。' : '打开“允许叠放”可以减少所需垛位。',
          P.doorGap > 0 ? '减小“柜门预留”后再计算。' : '检查托盘旋转和间隙设置。'
        ]
      };
    }

    var maxFillByWeight = Infinity;
    if (fillType && P.payload > 0 && fillType.weight > 0) {
      maxFillByWeight = Math.max(0, Math.floor((P.payload - requiredWeight) / fillType.weight + EPS));
    }

    var fillUpperBoundByArea = null;
    var fillUpperBound = null;
    var fillLayers = fillType ? fillType.layers : 1;
    if (fillType) {
      var fillStacksMax = Math.floor((effPackingL * effBoxW - requiredStackArea) / fillType.effArea + EPS);
      fillUpperBoundByArea = Math.max(0, fillStacksMax) * fillLayers;
      fillUpperBound = isFinite(maxFillByWeight) ? Math.min(fillUpperBoundByArea, maxFillByWeight) : fillUpperBoundByArea;
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

    function applyWeightCap(placements) {
      if (!fillType || !isFinite(maxFillByWeight)) return;
      var fillPs = placements.filter(function (p) { return p.fill; })
        .sort(function (a, b) { return b.x - a.x || b.y - a.y; });
      var totalFill = fillPs.reduce(function (s, p) { return s + p.count; }, 0);
      var excess = totalFill - maxFillByWeight;
      if (excess <= 0) return;
      for (var fi = 0; fi < fillPs.length && excess > 0; fi++) {
        var fp = fillPs[fi];
        var drop = Math.min(fp.count, excess);
        fp.count -= drop;
        fp.layers = fp.count;
        fp.stackHeight = fp.count * fp.h;
        excess -= drop;
        if (fp.count <= 0) {
          var idx = placements.indexOf(fp);
          if (idx >= 0) placements.splice(idx, 1);
        }
      }
    }

    // 计算重心平衡惩罚分（横向左右对称 & 纵向不过度偏载）
    function cogPenaltyScore(placements) {
      var cogW = 0, cogX = 0, cogY = 0;
      for (var i = 0; i < placements.length; i++) {
        var p = placements[i];
        var stackW = (p.weight || 0) * (p.count || 1);
        if (stackW <= 0) continue;
        cogW += stackW;
        cogX += stackW * (p.x + p.l / 2);
        cogY += stackW * (p.y + p.w / 2);
      }
      if (cogW <= 0) return 0;
      var latDev = Math.abs(cogY / cogW - W / 2) / Math.max(1, W); // 0..0.5
      var lonDev = Math.abs(cogX / cogW - L / 2) / Math.max(1, L); // 0..0.5
      // 横向偏载优先级高于纵向（海运侧翻/吊装风险），量级控制在 1e5 以内不干扰主目标
      return Math.round(latDev * 80000 + Math.max(0, lonDev - 0.05) * 40000);
    }

    function evaluate(strips, allocation) {
      var plans = [];
      for (var s = 0; s < strips.length; s++) {
        var req = strips.length === 1 ? reqCountsFor(requiredTypes) : allocation[s];
        var plan = stripPlan(effPackingL, strips[s].depth, req);
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
          placements.push({
            typeId: pl.typeId,
            name: pl.name,
            code: pl.code,
            color: pl.color,
            fill: pl.fill,
            x: pl._effX,
            y: y0 + pl._effY,
            z: 0,
            l: pl.l,
            w: pl.w,
            h: pl.h,
            baseH: pl.baseH,
            weight: pl.weight,
            maxLoad: pl.maxLoad,
            allowStack: pl.allowStack,
            allowRotate: pl.allowRotate,
            rotated: pl.rotated,
            gap: P.gap,
            count: 1,
            layers: 1,
            stackHeight: pl.h,
            strip: y0 === 0 ? 'A' : 'B',
            _stripIdx: pi,
            _rowIdx: pl._rowIdx,
            _rowLen: pl._effL,
            order: order++
          });
        }
      }

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

      placements.forEach(function (p) {
        if (p.fill) {
          p.count = fillType.layers;
          p.layers = fillType.layers;
          p.stackHeight = fillType.layers * p.h;
        }
      });

      applyWeightCap(placements);

      var minLayerH = Math.min.apply(null, placements.map(function (p) { return p.h || 1; }));
      for (var spi = 0; spi < plans.length; spi++) {
        var stripItems = placements.filter(function (p) { return p._stripIdx === spi; });
        if (!stripItems.length) continue;
        var rowMap = Object.create(null);
        stripItems.forEach(function (p) {
          var rk = String(p._rowIdx);
          if (!rowMap[rk]) rowMap[rk] = { rowIdx: p._rowIdx, rowLen: p._rowLen, items: [] };
          rowMap[rk].items.push(p);
        });
        var rows = Object.keys(rowMap).map(function (rk) {
          var r = rowMap[rk];
          r.hasHigh = r.items.some(function (it) { return it.count > 1 || it.stackHeight > minLayerH * 1.4; });
          r.maxCount = Math.max.apply(null, r.items.map(function (it) { return Math.max(it.count, it.stackHeight > minLayerH * 1.4 ? 2 : 1); }));
          r.minCount = Math.min.apply(null, r.items.map(function (it) { return Math.max(it.count, it.stackHeight > minLayerH * 1.4 ? 2 : 1); }));
          return r;
        });
        rows.sort(function (a, b) {
          if (a.hasHigh !== b.hasHigh) return a.hasHigh ? -1 : 1;
          if (b.maxCount !== a.maxCount) return b.maxCount - a.maxCount;
          if (b.minCount !== a.minCount) return b.minCount - a.minCount;
          return a.rowIdx - b.rowIdx;
        });
        var curX = 0;
        rows.forEach(function (r) {
          r.items.forEach(function (it) { it.x = curX; });
          curX += r.rowLen;
        });
      }

      if (!checkPlacementIntegrity(placements, packingL, W, H, P.gap, expectedReqCounts)) {
        return null;
      }

      var fillStacks = 0;
      var fillCount = 0;
      placements.forEach(function (p) {
        if (p.fill) { fillStacks++; fillCount += p.count; }
      });

      var fillPlacements = placements.filter(function (p) { return p.fill; });
      var reqPlacements = placements.filter(function (p) { return !p.fill; });
      var fillBox = bbox(fillPlacements);
      var reqBox = bbox(reqPlacements);
      var maxX = 0;
      placements.forEach(function (p) { maxX = Math.max(maxX, p.x + p.l); });
      var doorClear = Math.max(0, L - maxX);
      var fillCompact = fillPlacements.length ? 1 - fillBox.area / floorArea : 0;
      var reqCompact = reqPlacements.length ? 1 - reqBox.area / floorArea : 0;
      var blockStats = countBlockedSingles(placements);
      var cogPenalty = cogPenaltyScore(placements);
      var score = fillCount * 1e12 - blockStats.blocked * 1e10 + doorClear * 1e8 - blockStats.highMaxX * 1e4 + fillCompact * 1e6 + reqCompact * 1e4 - cogPenalty + (placements.length * 1e-3);

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

    var cuts = buildCuts(effBoxW, all, P.allowRotate, P.gap);
    cuts.sort(function (a, b) { return Math.abs(a - effBoxW / 2) - Math.abs(b - effBoxW / 2) || a - b; });
    if (cuts.length > 26) cuts = cuts.slice(0, 26);
    var allocations = buildAllocations(requiredTypes, ALLOC_LIMIT);

    // 1) 不切：整柜一条长条
    var full = evaluate([{ y0: 0, depth: effBoxW }], null);
    if (full) best = full;

    // 2) 上下两条长条
    for (var c = 0; c < cuts.length; c++) {
      if (Date.now() > deadline) { timedOut = true; break; }
      var cut = cuts[c];
      var strips = [{ y0: 0, depth: cut }, { y0: cut, depth: effBoxW - cut }];
      for (var a = 0; a < allocations.length; a++) {
        if (Date.now() > deadline) { timedOut = true; break; }
        var cand = evaluate(strips, allocations[a]);
        if (!cand) continue;
        if (!best || cand.score > best.score) best = cand;
      }
    }

    // 3) 通用 4-块风车 + 剩余条带
    if ((requiredTypes.length === 1 && !fillType) || (!requiredTypes.length && fillType)) {
      var pinTarget = fillType || requiredTypes[0];
      var pinCand = buildPinwheelCandidates(P, pinTarget, packingL, W, !!fillType, maxFillByWeight, patternCache, NODE_CAP, deadline);
      if (pinCand && checkPlacementIntegrity(pinCand.placements, packingL, W, H, P.gap, expectedReqCounts)) {
        if (!best || pinCand.score > best.score) best = pinCand;
      }
    }

    // 4) 多规格：尝试不同的规格先后顺序
    if (requiredTypes.length >= 2 && !(options && options.noMixed)) {
      var orders = permutations(requiredTypes, 24);
      var bestBand = null;
      orders.forEach(function (order) {
        var band = fillType
          ? buildDoorPriorityPlan(P, order, fillType, packingL, W, maxFillByWeight)
          : buildMixedUnitPlan(P, order, fillType, packingL, W);
        if (!band) return;
        if (!checkPlacementIntegrity(band.placements, packingL, W, H, P.gap, expectedReqCounts)) return;
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
      if (bestBand && (!best || bestBand.fillCount > best.fillCount || (bestBand.fillCount === best.fillCount && (!fillType || bestBand.doorClear >= best.doorClear - EPS)))) {
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
          '确认是否允许托盘旋转 90°，并在“装载参数”中减小托盘间隙。',
          '检查是否关闭了单品或全局“允许叠放”。'
        ]
      };
    }

    // 为每个垛位生成逐层记录
    best.placements.forEach(function (p) {
      p.baseL = p.l;
      p.baseW = p.w;
      p.layers = [];
      p.stackHeight = 0;
      for (var li = 0; li < p.count; li++) {
        p.layers.push({
          typeId: p.typeId, name: p.name, code: p.code, color: p.color,
          fill: p.fill, l: p.l, w: p.w, h: p.h, baseH: p.baseH,
          weight: p.weight, maxLoad: p.maxLoad || 0,
          allowStack: p.allowStack !== false, allowRotate: p.allowRotate !== false,
          rotated: p.rotated, relX: 0, relY: 0
        });
        p.stackHeight += p.h;
      }
    });

    // 混合叠放（大底小上 + 旋转对齐 + 承重/单品不可叠放校验）
    function canStackLayers(bottom, top) {
      if (bottom.stackHeight + top.stackHeight > H + EPS) return null;
      for (var i = 0; i < bottom.layers.length; i++) {
        if (bottom.layers[i].allowStack === false) return null;
      }
      for (var j = 0; j < top.layers.length; j++) {
        if (top.layers[j].allowStack === false) return null;
      }
      var mergedLayers = bottom.layers.concat(top.layers);
      if (!checkStackLoad(mergedLayers)) return null;

      var bottomTop = bottom.layers[bottom.layers.length - 1];
      var topCanRotate = P.allowRotate && top.layers.every(function (ly) { return ly.allowRotate !== false; });
      return fitsOn(top.l, top.w, bottomTop.l, bottomTop.w, topCanRotate);
    }

    var mixedStacks = 0;
    var addedFillStacks = 0;
    var mergeGuard = 0;
    var changed = true;
    var currentFillCount = best.placements.reduce(function (s, p) { return s + (p.fill ? p.count : 0); }, 0);

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
          var fit = canStackLayers(bottom, top);
          if (!fit) continue;

          var clonedTopLayers = top.layers.map(function (ly) { return Object.assign({}, ly); });
          if (fit.rotated) {
            rotateLayersInPlace(clonedTopLayers);
          }
          var supportCX = (bottomTop.relX || 0) + bottomTop.l / 2;
          var supportCY = (bottomTop.relY || 0) + bottomTop.w / 2;
          clonedTopLayers.forEach(function (layer) {
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

          if (fillType && (!isFinite(maxFillByWeight) || currentFillCount < maxFillByWeight)) {
            var fillFit = fitsOn(fillType.l, fillType.w, freed.l, freed.w, P.allowRotate && fillType.allowRotate);
            if (fillFit) {
              var remainCap = isFinite(maxFillByWeight) ? (maxFillByWeight - currentFillCount) : fillType.layers;
              var fillCount = Math.min(fillType.layers, remainCap);
              var fillStackH = fillCount * fillType.h;
              if (fillCount > 0 && fillStackH <= H + EPS) {
                var fillLayersArr = [];
                for (var fl = 0; fl < fillCount; fl++) {
                  fillLayersArr.push({
                    typeId: fillType.id, name: fillType.name, code: fillType.code,
                    color: fillType.color, fill: true, l: fillFit.l, w: fillFit.w,
                    h: fillType.h, baseH: fillType.baseH, weight: fillType.weight,
                    maxLoad: fillType.maxLoad || 0, allowStack: fillType.allowStack !== false,
                    allowRotate: fillType.allowRotate !== false,
                    rotated: fillFit.rotated, relX: 0, relY: 0
                  });
                }
                best.placements.push({
                  typeId: fillType.id, name: fillType.name, code: fillType.code,
                  color: fillType.color, fill: true,
                  x: freed.x, y: freed.y, z: 0,
                  l: fillFit.l, w: fillFit.w, h: fillType.h, baseH: fillType.baseH,
                  weight: fillType.weight, maxLoad: fillType.maxLoad || 0,
                  allowStack: fillType.allowStack !== false, allowRotate: fillType.allowRotate !== false,
                  rotated: fillFit.rotated,
                  count: fillCount, stackHeight: fillStackH, layers: fillLayersArr,
                  baseL: fillFit.l, baseW: fillFit.w, gap: P.gap,
                  strip: bottom.strip, order: 9999 + addedFillStacks
                });
                currentFillCount += fillCount;
                addedFillStacks++;
              }
            }
          }
          changed = true;
          break outer;
        }
      }
    }

    // 高层垛优先集中到柜底
    var highFirst = P.allowStack ? buildHighFirstPlacements(best.placements, packingL, W, P.gap, P.allowRotate) : null;
    if (highFirst && checkPlacementIntegrity(highFirst, packingL, W, H, P.gap, expectedReqCounts)) {
      var hfStats = countBlockedSingles(highFirst);
      var oldStats = countBlockedSingles(best.placements);
      var hfMax = 0;
      highFirst.forEach(function (p) { hfMax = Math.max(hfMax, p.x + p.l); });
      if (hfMax <= packingL + EPS &&
          (hfStats.blocked < oldStats.blocked ||
           (hfStats.blocked === oldStats.blocked && hfStats.highMaxX + 100 < oldStats.highMaxX))) {
        best.placements = highFirst;
      }
    }

    // 二次紧凑化：保留副本，若紧缩后未破坏不变量或增加单层遮挡才采用
    var preCompact = best.placements.map(function (p) {
      return Object.assign({}, p, { layers: p.layers.map(function (ly) { return Object.assign({}, ly); }) });
    });
    var preBlockCount = countBlockedSingles(preCompact).blocked;
    var hasHighStack = best.placements.some(function (p) { return p.count > 1; });
    compactPlacements(best.placements, packingL, W, hasHighStack, P.gap);
    if (hasHighStack) {
      promoteSinglesToDoor(best.placements, packingL, W, P.gap);
      compactPlacements(best.placements, packingL, W, false, P.gap);
    }
    var postBlockCount = countBlockedSingles(best.placements).blocked;
    if (!checkPlacementIntegrity(best.placements, packingL, W, H, P.gap, expectedReqCounts) ||
        postBlockCount > preBlockCount) {
      best.placements = preCompact;
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

    if (!checkPlacementIntegrity(best.placements, packingL, W, H, P.gap, expectedReqCounts)) {
      return {
        ok: false,
        error: '内部几何校验未通过，未能生成合法排布方案，请检查托盘尺寸或参数设置。',
        requiredArea: requiredArea,
        floorArea: floorArea,
        suggestions: ['请检查是否存在超大尺寸、过大间隙或柜门预留冲突。']
      };
    }

    best.placements.sort(function (a, b) { return a.order - b.order; });
    best.placements.forEach(function (p, idx) { p.seq = idx + 1; });

    best.placements.forEach(function (p) {
      var ids = Object.create(null);
      p.layers.forEach(function (l) { ids[l.typeId] = true; });
      if (Object.keys(ids).length > 1) mixedStacks++;
    });

    var typeCounts = Object.create(null);
    var stackCounts = Object.create(null);
    var totalCount = 0;
    var actualFillCount = 0;
    var actualRequiredCount = 0;
    best.placements.forEach(function (p) {
      var ids = Object.create(null);
      p.layers.forEach(function (layer) {
        totalCount++;
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

    // 调用独立分析器生成物理统计、重心偏移与截面间隙报警
    var metrics = analyzePlacements(container, best.placements, { doorGap: P.doorGap });

    var warnings = doorWarnings.slice();
    if (fillType && isFinite(maxFillByWeight) && actualFillCount >= maxFillByWeight && (fillUpperBoundByArea == null || maxFillByWeight < fillUpperBoundByArea)) {
      warnings.push('补柜数量受箱型载重 ' + P.payload.toLocaleString('zh-CN') + ' kg 限制，已按最大可装重量截断为 ' + actualFillCount + ' 托。');
    }
    if (P.gap > 0) {
      warnings.push('已按 ' + P.gap + 'mm 相邻托盘间隙计算（靠箱壁侧不额外加间隙）。');
    }
    if (P.allowStack) {
      warnings.push('按叠放计算：上面托盘的长短边均不超过下层，且满足单品叠放与承重限制。');
    }
    warnings = warnings.concat(metrics.warnings);

    var optimalByArea = fillType && mixedStacks === 0 && addedFillStacks === 0 ? actualFillCount >= fillUpperBoundByArea : false;
    var optimalByWeight = fillType && isFinite(maxFillByWeight) ? actualFillCount >= maxFillByWeight : false;

    return {
      ok: true,
      container: {
        id: container.id || 'CUSTOM',
        code: container.code || container.id || 'CUSTOM',
        name: container.name || '自定义柜型',
        l: L, w: W, h: H, payload: P.payload,
        openTop: P.openTop, reefer: P.reefer, loadLineH: P.loadLineH
      },
      placements: best.placements,
      requiredCount: actualRequiredCount,
      requiredStacks: actualRequiredStacks,
      fillCount: actualFillCount,
      fillStacks: actualFillStacks,
      stackCount: best.placements.length,
      totalCount: totalCount,
      fillUpperBound: fillUpperBound,
      fillUpperBoundByArea: fillUpperBoundByArea,
      maxFillByWeight: isFinite(maxFillByWeight) ? maxFillByWeight : null,
      optimalByArea: optimalByArea,
      optimalByWeight: optimalByWeight,
      mixedStacks: mixedStacks,
      addedFillStacks: addedFillStacks,
      floorArea: metrics.floorArea,
      floorUsed: metrics.floorUsed,
      floorUtil: metrics.floorUtil,
      volume: metrics.volume,
      volumeUsed: metrics.volumeUsed,
      volumeUtil: metrics.volumeUtil,
      totalWeight: metrics.totalWeight,
      frontHalfWeight: metrics.frontHalfWeight,
      backHalfWeight: metrics.backHalfWeight,
      weightKnown: metrics.weightKnown,
      cog: metrics.cog,
      cogOffset: metrics.cogOffset,
      payload: P.payload,
      maxHeight: metrics.maxHeight,
      gap: P.gap,
      doorGap: P.doorGap,
      packingLength: metrics.packingLength,
      doorClearance: metrics.doorClearance,
      bottomGap: metrics.bottomGap,
      allowRotate: P.allowRotate,
      allowStack: P.allowStack,
      cutsTried: cuts.length + 1,
      timedOut: timedOut,
      typeCounts: typeCounts,
      stackCounts: stackCounts,
      clearanceWarnings: metrics.clearanceWarnings,
      clearanceOk: metrics.clearanceOk,
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
      solveLabel: optimalByWeight && !optimalByArea ? '达到载重上限' : (optimalByArea ? '达到面积上限' : '条带搜索')
    };
  }

  /*
   * 最小叠放搜索（单规格与多规格统一渐进搜索）
   */
  function solveLeastStacking(container, pallets, options) {
    var P = prepare(container, pallets, Object.assign({}, options || {}, { allowStack: true }));
    var required = P.pallets.filter(function (p) { return !p.fill && p.qty > 0; });
    if (!required.length) return null;

    var starts = {};
    var maxUnits = {};
    var areaMap = {};
    var total = 0;
    required.forEach(function (p) {
      starts[p.id] = p.stackQty;
      maxUnits[p.id] = p.qty;
      areaMap[p.id] = p.effArea;
      total += p.stackQty;
    });

    function evaluateCounts(counts, budgetMs) {
      var opts = Object.assign({}, options, {
        allowStack: true,
        noMerge: true,
        timeBudget: budgetMs || 220,
        stackUnitCounts: counts
      });
      return solveCore(container, pallets, opts);
    }

    var counts = Object.assign({}, starts);
    var best = null;
    var bestTotal = 0;
    var deadline = Date.now() + 900;

    if (required.length === 1) {
      best = evaluateCounts(counts, 240);
      if (!best || !best.ok) return null;
      bestTotal = total;
      var p0 = required[0];
      var lo = starts[p0.id];
      var hi = maxUnits[p0.id];
      while (lo <= hi && Date.now() < deadline) {
        var mid = Math.floor((lo + hi) / 2);
        var cMid = {};
        cMid[p0.id] = mid;
        var resMid = evaluateCounts(cMid, 220);
        if (resMid && resMid.ok) {
          if (mid > bestTotal || (mid === bestTotal && resMid.fillCount > best.fillCount)) {
            best = resMid;
            bestTotal = mid;
          }
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    } else {
      var floorA = Math.max(1, (P.L - P.doorGap + P.gap) * (P.W + P.gap));
      var ratios = [0.92, 0.85, 0.78];
      for (var ri = 0; ri < ratios.length && Date.now() < deadline; ri++) {
        var cTry = {};
        var areas = [];
        var sumA = 0;
        required.forEach(function (p) {
          cTry[p.id] = p.qty;
          areas.push({ id: p.id, a: p.effArea, minU: starts[p.id] });
          sumA += p.effArea * p.qty;
        });
        while (sumA > floorA * ratios[ri]) {
          areas.sort(function (x, y) { return (y.a * cTry[y.id]) - (x.a * cTry[x.id]); });
          var reduced = false;
          for (var ai = 0; ai < areas.length; ai++) {
            var it = areas[ai];
            if (cTry[it.id] > it.minU) {
              cTry[it.id]--;
              sumA -= it.a;
              reduced = true;
              break;
            }
          }
          if (!reduced) break;
        }
        var probe = evaluateCounts(cTry, 280);
        if (probe && probe.ok) {
          best = probe;
          counts = cTry;
          bestTotal = Object.keys(cTry).reduce(function (s, id) { return s + cTry[id]; }, 0);
          break;
        }
      }
      if (!best) {
        counts = Object.assign({}, starts);
        best = evaluateCounts(counts, 320);
        if (!best || !best.ok) return null;
        bestTotal = total;
      }
      for (var iter = 0; iter < 6 && Date.now() < deadline; iter++) {
        var candidateList = [];
        required.forEach(function (p) {
          if (counts[p.id] >= maxUnits[p.id]) return;
          var c = Object.assign({}, counts);
          c[p.id] += 1;
          candidateList.push({ counts: c, area: areaMap[p.id] });
        });
        candidateList.sort(function (a, b) { return a.area - b.area; });
        var chosen = null;
        var chosenCounts = null;
        for (var ci = 0; ci < candidateList.length; ci++) {
          if (Date.now() > deadline) break;
          var r = evaluateCounts(candidateList[ci].counts, 180);
          if (!r || !r.ok) continue;
          if (!chosen || r.fillCount > chosen.fillCount) {
            chosen = r;
            chosenCounts = candidateList[ci].counts;
            if (!r.fillType) break;
          }
        }
        if (chosen) {
          best = chosen;
          counts = chosenCounts;
          bestTotal += 1;
        } else {
          break;
        }
      }
    }

    if (best) {
      best.stackingUsed = best.placements.some(function (p) { return p.count > 1; });
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
          if (!q.fill &&
              q.l === p.l && q.w === p.w && q.h === p.h &&
              (Number(q.weight) || 0) === (Number(p.weight) || 0) &&
              (q.allowStack !== false) === (p.allowStack !== false) &&
              (q.allowRotate !== false) === (p.allowRotate !== false) &&
              (Number(q.maxLayers) || 0) === (Number(p.maxLayers) || 0) &&
              (Number(q.maxLoad) || 0) === (Number(p.maxLoad) || 0)) {
            dup = q;
            break;
          }
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
   * 混合叠放求解器：支持「k 层大托 + 1 层小托」（k >= 1）组合，
   * 并严格逐层校验承重（checkStackLoad）。
   */
  function buildMixedStackPlan(container, pallets, options) {
    var P = prepare(container, pallets, options || {});
    var required = P.pallets.filter(function (p) { return !p.fill && p.qty > 0; });
    var fillPallets = P.pallets.filter(function (p) { return p.fill; });
    if (required.length < 2) return null;

    // 枚举所有可「k 层大托底 + 1 层小托顶」的规格对
    var pairs = [];
    for (var i = 0; i < required.length; i++) {
      for (var j = 0; j < required.length; j++) {
        if (i === j) continue;
        var big = required[i], small = required[j];
        if (!big.allowStack || !small.allowStack) continue;
        var sFit = fitsOn(small.l, small.w, big.l, big.w, P.allowRotate && small.allowRotate);
        if (!sFit) continue;

        var maxBigK = Math.floor((P.H - small.h) / big.h);
        if (big.maxLayers > 0) maxBigK = Math.min(maxBigK, big.maxLayers - 1);
        if (big.maxLoad > 0 && big.weight > 0) {
          maxBigK = Math.min(maxBigK, 1 + Math.floor((big.maxLoad - small.weight) / big.weight + EPS));
        }
        for (var kBig = 1; kBig <= maxBigK; kBig++) {
          if (kBig * big.h + small.h > P.H + EPS) continue;
          // 构造样本层栈检验承重
          var sampleLayers = [];
          for (var bi = 0; bi < kBig; bi++) sampleLayers.push({ weight: big.weight, maxLoad: big.maxLoad });
          sampleLayers.push({ weight: small.weight, maxLoad: small.maxLoad });
          if (!checkStackLoad(sampleLayers)) continue;
          pairs.push({ big: big, small: small, sFit: sFit, kBig: kBig });
        }
      }
    }
    if (!pairs.length) return null;

    pairs.sort(function (x, y) {
      var xRem = ((x.big.qty % x.big.layers) > 0 ? 1 : 0) + ((x.small.qty % x.small.layers) > 0 ? 1 : 0);
      var yRem = ((y.big.qty % y.big.layers) > 0 ? 1 : 0) + ((y.small.qty % y.small.layers) > 0 ? 1 : 0);
      if (yRem !== xRem) return yRem - xRem;
      if (y.kBig !== x.kBig) return y.kBig - x.kBig;
      return (x.big.l * x.big.w - x.small.l * x.small.w) - (y.big.l * y.big.w - y.small.l * y.small.w);
    });

    var candidates = [];
    var seenCand = Object.create(null);
    function addCand(assignList) {
      var key = assignList.map(function (a) { return a.big.id + '*' + a.kBig + '>' + a.small.id + ':' + a.m; }).sort().join('|');
      if (!key || seenCand[key]) return;
      seenCand[key] = true;
      candidates.push(assignList);
    }

    // 1) 多规格余数互补配对
    (function buildRemainderCombo() {
      var remMap = {};
      required.forEach(function (t) { remMap[t.id] = t.qty % t.layers; });
      var list = [];
      pairs.forEach(function (pr) {
        var rb = remMap[pr.big.id] || 0;
        var rs = remMap[pr.small.id] || 0;
        var m = Math.min(Math.floor(rb / pr.kBig), rs);
        if (m > 0) {
          list.push({ big: pr.big, small: pr.small, sFit: pr.sFit, kBig: pr.kBig, m: m });
          remMap[pr.big.id] -= m * pr.kBig;
          remMap[pr.small.id] -= m;
        }
      });
      if (list.length) addCand(list);
    })();

    // 2) 单对混合配对扫描
    pairs.slice(0, 8).forEach(function (pr) {
      var maxM = Math.min(Math.floor(pr.big.qty / pr.kBig), pr.small.qty);
      var ms = [];
      var remB = Math.floor((pr.big.qty % pr.big.layers) / pr.kBig);
      var remS = pr.small.qty % pr.small.layers;
      [1, remB, remS, Math.min(remB || maxM, remS || maxM), 2, 3, 4, 6, 8, 10, maxM].forEach(function (m) {
        m = Math.floor(m);
        if (m > 0 && m <= maxM && ms.indexOf(m) < 0) ms.push(m);
      });
      ms.forEach(function (m) {
        addCand([{ big: pr.big, small: pr.small, sFit: pr.sFit, kBig: pr.kBig, m: m }]);
      });
    });

    var expectedCounts = Object.create(null);
    required.forEach(function (t) { expectedCounts[t.id] = t.qty; });

    var best = null;
    var deadline = Date.now() + 1400;

    for (var ci = 0; ci < candidates.length; ci++) {
      if (Date.now() > deadline) break;
      var assignList = candidates[ci];
      var usedQty = Object.create(null);
      var validAssign = true;
      assignList.forEach(function (a) {
        usedQty[a.big.id] = (usedQty[a.big.id] || 0) + a.m * a.kBig;
        usedQty[a.small.id] = (usedQty[a.small.id] || 0) + a.m;
      });
      required.forEach(function (t) {
        if ((usedQty[t.id] || 0) > t.qty) validAssign = false;
      });
      if (!validAssign) continue;

      var syn = [];
      var mixMeta = Object.create(null);
      required.forEach(function (t) {
        var left = t.qty - (usedQty[t.id] || 0);
        if (left > 0) syn.push(Object.assign({}, t, { qty: left }));
      });
      assignList.forEach(function (a, ai) {
        var mixId = '__mix_' + ai + '_' + a.big.id + '_' + a.small.id;
        mixMeta[mixId] = a;
        var unitH = a.kBig * a.big.h + a.small.h;
        var unitW = a.kBig * (a.big.weight || 0) + (a.small.weight || 0);
        // 混合垛作为整体单元参与平面排布（防止上下再自动叠出超重垛）
        syn.push({
          id: mixId, name: '混合垛 ' + a.kBig + '×' + a.big.name + ' + ' + a.small.name,
          code: 'MIX', l: a.big.l, w: a.big.w, h: unitH, baseH: a.big.baseH,
          qty: a.m, weight: unitW,
          maxLayers: 1, allowStack: false, allowRotate: a.big.allowRotate,
          fill: false, color: a.big.color
        });
      });
      fillPallets.forEach(function (fp) { syn.push(Object.assign({}, fp)); });

      var res = solveCore(container, syn, Object.assign({}, options, {
        allowStack: true, noMerge: true, timeBudget: 400, preferSingle: false
      }));
      if (!res || !res.ok) continue;

      var mixedCount = 0;
      var loadValid = true;
      res.placements.forEach(function (p) {
        var meta = mixMeta[p.typeId];
        if (!meta) return;
        var big = meta.big, small = meta.small, sFit = meta.sFit, kBig = meta.kBig;
        var origStacks = p.count || 1;
        var expanded = [];
        var bl = p.l, bw = p.w;
        var sl = sFit.l, sw = sFit.w, sRot = sFit.rotated;
        if (bl !== big.l || bw !== big.w) {
          var tmp = sl; sl = sw; sw = tmp;
          sRot = !sRot;
        }
        if (sl > bl + EPS || sw > bw + EPS) {
          var tmp2 = sl; sl = sw; sw = tmp2;
          sRot = !sRot;
        }
        for (var k = 0; k < origStacks; k++) {
          for (var kb = 0; kb < kBig; kb++) {
            expanded.push({
              typeId: big.id, name: big.name, code: big.code, color: big.color, fill: false,
              l: bl, w: bw, h: big.h, baseH: big.baseH, weight: big.weight,
              maxLoad: big.maxLoad, allowStack: big.allowStack, allowRotate: big.allowRotate,
              rotated: !!p.rotated, relX: 0, relY: 0
            });
          }
          expanded.push({
            typeId: small.id, name: small.name, code: small.code, color: small.color, fill: false,
            l: sl, w: sw, h: small.h, baseH: small.baseH, weight: small.weight,
            maxLoad: small.maxLoad, allowStack: small.allowStack, allowRotate: small.allowRotate,
            rotated: sRot, relX: (bl - sl) / 2, relY: (bw - sw) / 2
          });
        }
        if (!checkStackLoad(expanded)) loadValid = false;
        p.layers = expanded;
        p.count = expanded.length;
        p.h = big.h;
        p.typeId = big.id;
        p.name = big.name;
        p.code = big.code;
        p.color = big.color;
        p.baseL = bl;
        p.baseW = bw;
        p.stackHeight = origStacks * (kBig * big.h + small.h);
        p.mixed = true;
        mixedCount++;
      });
      if (!mixedCount || !loadValid) continue;

      if (!checkPlacementIntegrity(res.placements, P.L - P.doorGap, P.W, P.H, P.gap, expectedCounts)) {
        continue;
      }

      var typeCounts = {}, stackCounts = {}, requiredCount = 0, totalCount = 0;
      res.placements.forEach(function (p) {
        var ids = {};
        p.layers.forEach(function (ly) {
          typeCounts[ly.typeId] = (typeCounts[ly.typeId] || 0) + 1;
          ids[ly.typeId] = true;
          totalCount++;
          requiredCount += ly.fill ? 0 : 1;
        });
        Object.keys(ids).forEach(function (id) { stackCounts[id] = (stackCounts[id] || 0) + 1; });
      });

      var metrics = analyzePlacements(container, res.placements, { doorGap: P.doorGap });
      res.typeCounts = typeCounts;
      res.stackCounts = stackCounts;
      res.requiredCount = requiredCount;
      res.totalCount = totalCount;
      res.totalWeight = metrics.totalWeight;
      res.frontHalfWeight = metrics.frontHalfWeight;
      res.backHalfWeight = metrics.backHalfWeight;
      res.weightKnown = metrics.weightKnown;
      res.cog = metrics.cog;
      res.cogOffset = metrics.cogOffset;
      res.maxHeight = metrics.maxHeight;
      res.clearanceWarnings = metrics.clearanceWarnings;
      res.clearanceOk = metrics.clearanceOk;
      res.mixedStacks = mixedCount;
      res.stackingUsed = true;
      res.allowStack = true;
      res.strategy = 'mixed-stack';

      var preferLessMix = !options || options.preferSingle !== false;
      var better = false;
      if (!best) better = true;
      else if (res.fillCount !== best.fillCount) better = res.fillCount > best.fillCount;
      else if (res.stackCount !== best.stackCount) better = res.stackCount < best.stackCount;
      else if (preferLessMix) better = res.mixedStacks < best.mixedStacks;
      else better = res.mixedStacks > best.mixedStacks;

      if (better) {
        best = res;
        if (preferLessMix && !fillPallets.length && res.mixedStacks === 1) break;
      }
    }
    return best;
  }

  /*
   * 外层策略：
   * - 关闭叠放：直接按单层算。
   * - 不叠放优先：先全部单层；放不下时，用最小叠放方案。
   * - 叠放优先：先按最大叠放算（无补柜时仅在单层放不下才叠）。
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
    if (base.preferSingle !== false && single && single.ok) {
      single.stackingUsed = false;
      single.strategy = 'single-preferred';
      single.allowStack = true;
      return stamp(single);
    }

    if (base.preferSingle !== false) {
      var least = solveLeastStacking(container, work, base);
      var reqCount = work.filter(function (p) { return !p.fill && p.qty > 0; }).length;
      if (least && least.ok) {
        if (reqCount === 2 && !hasFill) {
          var mixed2 = buildMixedStackPlan(container, work, base);
          if (mixed2 && mixed2.ok && mixed2.stackCount < least.stackCount) return stamp(mixed2);
        }
        return stamp(least);
      }
      var mixedFallback = buildMixedStackPlan(container, work, base);
      if (mixedFallback && mixedFallback.ok) return stamp(mixedFallback);
    }

    var mixedPlan = !hasFill ? buildMixedStackPlan(container, work, base) : null;
    if (base.preferSingle === false && !hasFill && mixedPlan) {
      return stamp(mixedPlan);
    }

    var stacked = solveCore(container, work, base);
    if (stacked && stacked.ok) {
      stacked.stackingUsed = stacked.placements.some(function (p) { return p.count > 1; });
      stacked.strategy = 'stacked-preferred';
      return stamp(stacked);
    }
    if (!mixedPlan) mixedPlan = buildMixedStackPlan(container, work, base);
    if (mixedPlan && mixedPlan.ok) return stamp(mixedPlan);
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
    analyzePlacements: analyzePlacements,
    _internal: {
      buildCuts: buildCuts,
      buildAllocations: buildAllocations,
      getPatterns: getPatterns,
      checkPlacementIntegrity: checkPlacementIntegrity,
      checkStackLoad: checkStackLoad
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.CL_SOLVER = API;
})(typeof window !== 'undefined' ? window : globalThis);
