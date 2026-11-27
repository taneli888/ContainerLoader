/* 独立校验器：不依赖 solver 的任何统计字段，从 placements 几何重算并检查约束 */
'use strict';

function v(objects) { return objects; }

function rectsOverlap(a, b, tol) {
  return a.x < b.x + b.w - tol && b.x < a.x + a.w - tol &&
         a.y < b.y + b.h - tol && b.y < a.y + a.h - tol;
}

/* 地面矩形相交面积（用于判断重叠程度） */
function overlapArea(A, B) {
  var x = Math.min(A.x + A.l, B.x + B.l) - Math.max(A.x, B.x);
  var y = Math.min(A.y + A.w, B.y + B.w) - Math.max(A.y, B.y);
  return x > 0 && y > 0 ? x * y : 0;
}

function check(result, container, pallets, options) {
  var L = container.l, W = container.w, H = container.h, payload = container.payload;
  var issues = [];
  var TOL = 1.5; // mm 级误差容忍（坐标取整）

  if (!result || !result.ok) {
    return { ok: false, issues: [{ level: 'info', msg: result && result.error }] };
  }

  var ps = result.placements || [];
  var doorGap = Number(options && options.doorGap) || 0;

  // 1. 边界
  ps.forEach(function (p) {
    if (p.x < -TOL) issues.push({ level: 'fatal', msg: 'P' + p.seq + ' x<0 (' + p.x + ')' });
    if (p.y < -TOL) issues.push({ level: 'fatal', msg: 'P' + p.seq + ' y<0 (' + p.y + ')' });
    if (p.x + p.l > L - doorGap + TOL) issues.push({ level: 'fatal', msg: 'P' + p.seq + ' 侵入柜门预留 (' + Math.round(p.x + p.l) + '>' + (L - doorGap) + ')' });
    if (p.y + p.w > W + TOL) issues.push({ level: 'fatal', msg: 'P' + p.seq + ' 超出柜宽 (' + Math.round(p.y + p.w) + '>' + W + ')' });
  });

  // 2. 地面重叠
  for (var i = 0; i < ps.length; i++) {
    for (var j = i + 1; j < ps.length; j++) {
      var a = { x: ps[i].x, y: ps[i].y, l: ps[i].l, w: ps[i].w };
      var b = { x: ps[j].x, y: ps[j].y, l: ps[j].l, w: ps[j].w };
      var ov = overlapArea(a, b);
      if (ov > TOL * Math.max(a.l, a.w)) {
        issues.push({ level: 'fatal', msg: 'P' + ps[i].seq + ' 与 P' + ps[j].seq + ' 地面重叠 ' + Math.round(ov / 1000) + 'k mm²' });
      }
    }
  }

  // 2.5 间隙：相邻且投影重叠时，原始托盘之间净距必须达到 gap
  var needGap = Number(options && options.gap) || 0;
  if (needGap > 0) {
    for (var gi = 0; gi < ps.length; gi++) {
      for (var gj = gi + 1; gj < ps.length; gj++) {
        var A = ps[gi], B = ps[gj];
        var yOv = A.y < B.y + B.w && B.y < A.y + A.w;
        var xOv = A.x < B.x + B.l && B.x < A.x + A.l;
        if (yOv) {
          var left = A.x <= B.x ? A : B, right = A.x <= B.x ? B : A;
          var gx = right.x - (left.x + left.l);
          if (gx >= -TOL && gx < needGap - TOL) {
            issues.push({ level: 'fatal', msg: 'P' + left.seq + '→P' + right.seq + ' 纵向净距 ' + Math.round(gx) + 'mm < ' + needGap + 'mm' });
          }
        }
        if (xOv) {
          var top = A.y <= B.y ? A : B, bottom = A.y <= B.y ? B : A;
          var gy = bottom.y - (top.y + top.w);
          if (gy >= -TOL && gy < needGap - TOL) {
            issues.push({ level: 'fatal', msg: 'P' + top.seq + '→P' + bottom.seq + ' 横向净距 ' + Math.round(gy) + 'mm < ' + needGap + 'mm' });
          }
        }
      }
    }
  }

  pallets.forEach(function (t) {
    if (container.doorH > 0 && t.h > container.doorH) {
      issues.push({ level: 'fatal', msg: '「' + t.name + '」单托高 ' + t.h + 'mm > 门高 ' + container.doorH + 'mm' });
    }
  });

  // 3. 层高 / 支撑 / 叠压合法性
  ps.forEach(function (p) {
    var layers = p.layers || [];
    if (!layers.length) { issues.push({ level: 'fatal', msg: 'P' + p.seq + ' 无层数据' }); return; }
    var z = 0;
    layers.forEach(function (ly, k) {
      z += ly.h;
      if (z > H + TOL) issues.push({ level: 'fatal', msg: 'P' + p.seq + ' 垛高 ' + z + 'mm 超过柜内净高 ' + H + 'mm' });
      if (k > 0) {
        var lo = layers[k - 1];
        // 上层必须完全落在下层投影内（长宽都不能超，且不能悬空/偏心出界）
        var eps = TOL + 0.5;
        if (ly.relX < -eps || ly.relY < -eps ||
            (ly.relX + ly.l) > lo.l + eps || (ly.relY + ly.w) > lo.w + eps) {
          issues.push({
            level: 'fatal',
            msg: 'P' + p.seq + ' 第' + (k + 1) + '层悬空/超边：上层 ' + ly.l + '×' + ly.w +
                 ' 偏心(' + Math.round(ly.relX) + ',' + Math.round(ly.relY) + ') 下层 ' + lo.l + '×' + lo.w
          });
        }
      }
    });
    // 层数与 count 一致性
    if ((p.count || 0) !== layers.length) {
      issues.push({ level: 'warn', msg: 'P' + p.seq + ' count=' + p.count + ' 但层数=' + layers.length });
    }
  });

  // 4. 数量 / 重量（从层数据重算）
  var cnt = {}, fillCnt = {}, totalW = 0, totalPallets = 0, reqPallets = 0, fillPallets = 0;
  ps.forEach(function (p) {
    (p.layers || []).forEach(function (ly) {
      cnt[ly.typeId] = (cnt[ly.typeId] || 0) + 1;
      totalW += ly.weight || 0;
      totalPallets++;
      if (ly.fill) { fillPallets++; fillCnt[ly.typeId] = (fillCnt[ly.typeId] || 0) + 1; }
      else reqPallets++;
    });
  });

  var expectedReq = {};
  pallets.forEach(function (t) {
    if (t.fill) return;
    var id = (result.mergedMap && result.mergedMap[t.id]) || t.id;
    expectedReq[id] = (expectedReq[id] || 0) + t.qty;
  });
  Object.keys(expectedReq).forEach(function (id) {
    var got = cnt[id] || 0;
    if (got !== expectedReq[id]) {
      issues.push({ level: 'fatal', msg: '「' + id + '」应装 ' + expectedReq[id] + ' 托，实放 ' + got + ' 托' });
    }
  });
  pallets.forEach(function (t) {
    if (!t.fill) return;
    if (result.fillType && t.qty > 0 && t.id === result.fillType.id) {
      var gotFill = cnt[t.id] || 0;
      if (gotFill !== result.fillCount) {
        issues.push({ level: 'warn', msg: '补柜 ' + t.name + ' 实放 ' + gotFill + ' 托，界面报 ' + result.fillCount });
      }
    }
  });

  // 5. 记账字段一致性
  var floorUsed = 0;
  ps.forEach(function (p) { floorUsed += p.l * p.w; });
  if (Math.abs(floorUsed - result.floorUsed) > Math.max(1000, result.floorUsed * 0.001)) {
    issues.push({ level: 'warn', msg: '柜底占用 自算 ' + Math.round(floorUsed / 1e4) / 100 + 'm² ≠ 报 ' + Math.round(result.floorUsed / 1e4) / 100 + 'm²' });
  }
  if (Math.abs(totalW - result.totalWeight) > 1) {
    issues.push({ level: 'warn', msg: '总重 自算 ' + Math.round(totalW) + ' ≠ 报 ' + Math.round(result.totalWeight) });
  }
  if (payload > 0 && totalW > payload) {
    issues.push({ level: 'warn', msg: '超重：' + Math.round(totalW) + 'kg > 载重 ' + payload + 'kg（程序' + (result.warnings || []).some(function (w) { return w.indexOf('超过箱型载重') >= 0; }) + '已提示）' });
  }
  if (result.totalCount !== totalPallets) {
    issues.push({ level: 'warn', msg: '总托数 自算 ' + totalPallets + ' ≠ 报 ' + result.totalCount });
  }
  if (result.requiredCount !== reqPallets) {
    issues.push({ level: 'warn', msg: '必装托数 自算 ' + reqPallets + ' ≠ 报 ' + result.requiredCount });
  }

  // 6. 地板空洞：按 100mm 栅格扫描柜底被占用面积，找"被围住"的空洞
  var STEP = 100;
  var grid = {};
  ps.forEach(function (p) {
    for (var x = p.x; x < p.x + p.l; x += STEP) {
      for (var y = p.y; y < p.y + p.w; y += STEP) {
        grid[Math.floor(x / STEP) + ',' + Math.floor(y / STEP)] = 1;
      }
    }
  });
  var maxX = 0;
  ps.forEach(function (p) { maxX = Math.max(maxX, p.x + p.l); });
  var holes = 0;
  var nx = Math.ceil(L / STEP), ny = Math.ceil(W / STEP);
  var seen = {};
  function flood(sx, sy) {
    // 从 (sx,sy) 泛洪；若触到 maxX 之外则视为"柜门方向开口"，不算洞
    var stack = [[sx, sy]], n = 0, open = false;
    seen[sx + ',' + sy] = 1;
    while (stack.length) {
      var c = stack.pop(); n++;
      var cx = c[0], cy = c[1];
      if (cx * STEP >= maxX - 1) open = true;
      var nb = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
      for (var k = 0; k < 4; k++) {
        var ax = nb[k][0], ay = nb[k][1];
        if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
        var key = ax + ',' + ay;
        if (seen[key] || grid[key]) continue;
        seen[key] = 1;
        stack.push([ax, ay]);
      }
    }
    return { n: n, open: open };
  }
  for (var gx = 0; gx < nx; gx++) {
    for (var gy = 0; gy < ny; gy++) {
      var key = gx + ',' + gy;
      if (grid[key] || seen[key]) continue;
      var r = flood(gx, gy);
      if (!r.open && r.n >= 6) holes++; // 封闭空腔（≥0.06m² 才记）
    }
  }
  if (holes > 0) issues.push({ level: 'warn', msg: '柜底存在 ' + holes + ' 处封闭空洞（被托盘围住、无法再放也不通柜门）' });

  return {
    ok: !issues.some(function (x) { return x.level === 'fatal'; }),
    issues: issues,
    facts: {
      pallets: totalPallets,
      required: reqPallets,
      fill: fillPallets,
      stacks: ps.length,
      weight: Math.round(totalW),
      maxHeight: Math.max.apply(null, ps.map(function (p) { return (p.layers || []).reduce(function (s, l) { return s + l.h; }, 0); }).concat([0])),
      floorUsed: floorUsed,
      floorUtil: floorUsed / (L * W),
      holes: holes,
      maxX: maxX,
      doorClear: L - maxX
    }
  };
}

module.exports = { check: check };
