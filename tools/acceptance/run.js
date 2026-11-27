'use strict';
var path = require('path');
var DATA = require(path.join(__dirname, '..', '..', 'js', 'data.js'));
var SOLVER = require(path.join(__dirname, '..', '..', 'js', 'solver.js'));
var CHECK = require('./lib_check.js');
var PACK = require('./lib_pack.js');

function C(id) {
  var c = DATA.getContainer(id);
  return { id: c.id, code: c.code, name: c.name, l: c.l, w: c.w, h: c.h, payload: c.payload, doorW: c.doorW, doorH: c.doorH };
}
var OPT = { allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 };

function P(id, name, l, w, h, qty, weight, fill) {
  return {
    id: id, name: name, code: id.toUpperCase(), l: l, w: w, h: h,
    baseH: 144, qty: qty, weight: weight == null ? 500 : weight, fill: !!fill, color: 0
  };
}

var scenarios = [
  /* --- 单规格 / 数量梯度 --- */
  { name: 'S1 20GP 欧标1200×800 ×4', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 4)], o: {} },
  { name: 'S2 20GP 欧标1200×800 ×8（示例）', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 8)], o: {} },
  { name: 'S3 20GP 欧标1200×800 ×10', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 10)], o: {} },
  { name: 'S4 20GP 欧标1200×800 ×11', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 11)], o: {} },
  { name: 'S5 20GP 欧标1200×800 ×16（满两层）', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 16)], o: {} },
  { name: 'S6 20GP EUR2 1200×1000 ×10', c: '20GP', p: [P('eur2', '欧标EUR2', 1200, 1000, 1100, 10)], o: {} },
  { name: 'S7 20GP EUR2 1200×1000 ×12', c: '20GP', p: [P('eur2', '欧标EUR2', 1200, 1000, 1100, 12)], o: {} },
  { name: 'S8 20GP 亚洲1100×1100 ×8', c: '20GP', p: [P('asia', '亚洲托盘', 1100, 1100, 1100, 8)], o: {} },
  { name: 'S9 20GP 亚洲1100×1100 ×9', c: '20GP', p: [P('asia', '亚洲托盘', 1100, 1100, 1100, 9)], o: {} },
  { name: 'S10 20GP 方托1120×1120 ×8', c: '20GP', p: [P('1120', '方托1120', 1120, 1120, 1100, 8)], o: {} },
  { name: 'S11 40HQ 欧标1200×800 ×24', c: '40HQ', p: [P('eur', '欧标托盘', 1200, 800, 1100, 24)], o: {} },
  { name: 'S12 40HQ GMA 1219×1016 ×22', c: '40HQ', p: [P('gma', 'GMA美标', 1219, 1016, 1100, 22)], o: {} },

  /* --- 不可叠放（单层）--- */
  { name: 'S13 20GP 欧标 高1900（不可叠）×8', c: '20GP', p: [P('eurh', '欧标高托', 1200, 800, 1900, 8)], o: {} },
  { name: 'S14 20GP 欧标 高1900 ×9', c: '20GP', p: [P('eurh', '欧标高托', 1200, 800, 1900, 9)], o: {} },

  /* --- 混合托盘组合（核心）--- */
  { name: 'M1 20GP 欧标×6 + 亚洲×4', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 6), P('asia', '亚洲托盘', 1100, 1100, 1100, 4, 500)], o: {} },
  { name: 'M2 20GP 欧标×4 + EUR2×4', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 4), P('eur2', '欧标EUR2', 1200, 1000, 1100, 4)], o: {} },
  { name: 'M3 20GP 欧标×6 + EUR2×3 + 亚洲×2', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 6), P('eur2', '欧标EUR2', 1200, 1000, 1100, 3), P('asia', '亚洲托盘', 1100, 1100, 1100, 2)], o: {} },
  { name: 'M4 20GP 欧标×12 + 亚洲×2', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 12), P('asia', '亚洲托盘', 1100, 1100, 1100, 2)], o: {} },
  { name: 'M5 40HQ 欧标×20 + EUR2×8 + GMA×2', c: '40HQ', p: [P('eur', '欧标托盘', 1200, 800, 1100, 20), P('eur2', '欧标EUR2', 1200, 1000, 1100, 8), P('gma', 'GMA美标', 1219, 1016, 1100, 2)], o: {} },
  { name: 'M6 20GP 半托800×600 ×10 + 欧标×6', c: '20GP', p: [P('half', '半托', 800, 600, 1100, 10), P('eur', '欧标托盘', 1200, 800, 1100, 6)], o: {} },

  /* --- 补柜模式 --- */
  { name: 'F1 20GP 欧标×8 + 补柜1120', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 8), P('1120', '补柜1120', 1120, 1120, 1100, 1, 500, true)], o: {} },
  { name: 'F2 20GP 欧标×4 + 补柜1120', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 4), P('1120', '补柜1120', 1120, 1120, 1100, 1, 500, true)], o: {} },
  { name: 'F3 20GP 欧标×6+亚洲×2 + 补柜1100', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 6), P('asia', '亚洲托盘', 1100, 1100, 1100, 2), P('asia2', '补柜1100', 1100, 1100, 1100, 1, 500, true)], o: {} },

  /* --- 参数影响 --- */
  { name: 'O1 20GP 欧标×10 间隙50mm', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 10)], o: { gap: 50 } },
  { name: 'O2 20GP 欧标×10 禁旋转', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 10)], o: { allowRotate: false } },
  { name: 'O3 20GP 欧标×10 柜门预留300', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 10)], o: { doorGap: 300 } },
  { name: 'O4 20GP 欧标×10 禁止叠放', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 10)], o: { allowStack: false } },
  { name: 'O5 20GP 欧标×8 超重测试(单托2000kg)', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 8, 2000)], o: {} },
  { name: 'O6 20GP 欧标×8 叠放优先', c: '20GP', p: [P('eur', '欧标托盘', 1200, 800, 1100, 8)], o: { preferSingle: false } }
];

function run(sc) {
  var c = C(sc.c);
  var opts = Object.assign({}, OPT, sc.o || {});
  var t0 = Date.now();
  var res = SOLVER.solve(c, JSON.parse(JSON.stringify(sc.p)), opts);
  var ms = Date.now() - t0;
  var chk = CHECK.check(res, c, sc.p, opts);
  return { name: sc.name, container: sc.c, opts: opts, ms: ms, result: res, chk: chk, pallets: sc.p };
}

var report = [];
scenarios.forEach(function (sc) {
  var r = run(sc);
  report.push(r);
});

/* ---------------- 容量边界扫描（单层，不叠放）---------------- */
function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

console.log('\n=== A. 方案合法性 / 数量 / 几何校验 ===\n');
console.log(pad('场景', 42) + pad('托数', 6) + pad('垛位', 6) + pad('地面%', 8) + pad('体积%', 8) + pad('重kg', 8) + pad('耗时ms', 8) + '问题');
report.forEach(function (r) {
  var f = r.chk.facts || {};
  var bad = (r.chk.issues || []).filter(function (x) { return x.level === 'fatal'; });
  var warn = (r.chk.issues || []).filter(function (x) { return x.level === 'warn' });
  console.log(pad(r.name, 42) + pad(f.pallets || 0, 6) + pad(f.stacks || 0, 6) +
    pad(f.floorUtil ? (f.floorUtil * 100).toFixed(1) : 0, 8) +
    pad(r.result.ok ? (r.result.volumeUtil * 100).toFixed(1) : '-', 8) +
    pad(f.weight || 0, 8) + pad(r.ms, 8) +
    (bad.length ? 'FATAL×' + bad.length : '') + (warn.length ? ' WARN×' + warn.length : ''));
});

console.log('\n=== B. 问题明细 ===\n');
report.forEach(function (r) {
  var list = (r.chk.issues || []);
  if (!list.length) return;
  console.log('[' + r.name + ']');
  list.forEach(function (x) { console.log('   ' + x.level + ': ' + x.msg); });
});

console.log('\n=== C. 单层容量边界 vs 独立排布器 ===\n');
var types = [
  { name: '欧标1200×800', l: 1200, w: 800 },
  { name: 'EUR2 1200×1000', l: 1200, w: 1000 },
  { name: '亚洲1100×1100', l: 1100, w: 1100 },
  { name: '方托1120×1120', l: 1120, w: 1120 },
  { name: 'GMA 1219×1016', l: 1219, w: 1016 },
  { name: '半托800×600', l: 800, w: 600 }
];
['20GP', '40HQ'].forEach(function (cid) {
  var c = C(cid);
  console.log('--- ' + cid + ' (' + c.l + '×' + c.w + ') ---');
  types.forEach(function (t) {
    var mine = PACK.maxSame(c.l, c.w, t.l, t.w, true);
    // 找出程序的最大可行数量（allowStack=false 扫描）
    var appMax = 0;
    for (var q = 1; q <= mine + 3; q++) {
      var rr = SOLVER.solve(c, [{ id: 'x', name: t.name, code: 'X', l: t.l, w: t.w, h: 1100, baseH: 144, qty: q, weight: 500, fill: false, color: 0 }],
        { allowRotate: true, gap: 0, allowStack: false, preferSingle: true, doorGap: 0 });
      if (rr && rr.ok) appMax = q; else break;
    }
    // 程序单层实际用几个垛位
    var stacks = null;
    var rr2 = SOLVER.solve(c, [{ id: 'x', name: t.name, code: 'X', l: t.l, w: t.w, h: 1100, baseH: 144, qty: appMax, weight: 500, fill: false, color: 0 }],
      { allowRotate: true, gap: 0, allowStack: false, preferSingle: true, doorGap: 0 });
    if (rr2 && rr2.ok) stacks = rr2.stackCount;
    console.log(pad('  ' + t.name, 24) + pad('程序最大=' + appMax, 14) + pad('独立排布=' + mine, 14) +
      (appMax < mine ? '⚠ 少装 ' + (mine - appMax) : (appMax > mine ? '（程序更优，我的下界偏低）' : '✓ 一致')) +
      '  面积上限=' + Math.floor(c.l * c.w / (t.l * t.w)));
  });
});

console.log('\n=== D. 补柜数量 vs 独立排布器 ===\n');
var fillCases = [
  { name: '20GP 欧标6+亚洲4 补1120', c: '20GP', req: [{ l: 1200, w: 800, qty: 6 }, { l: 1100, w: 1100, qty: 4 }], fill: { l: 1120, w: 1120 } },
  { name: '20GP 欧标4 补1120', c: '20GP', req: [{ l: 1200, w: 800, qty: 4 }], fill: { l: 1120, w: 1120 } },
  { name: '20GP 欧标8 补1120', c: '20GP', req: [{ l: 1200, w: 800, qty: 8 }], fill: { l: 1120, w: 1120 } },
  { name: '20GP 欧标6+亚洲2 补1100', c: '20GP', req: [{ l: 1200, w: 800, qty: 6 }, { l: 1100, w: 1100, qty: 2 }], fill: { l: 1100, w: 1100 } },
  { name: '40HQ 欧标10 补1120', c: '40HQ', req: [{ l: 1200, w: 800, qty: 10 }], fill: { l: 1120, w: 1120 } }
];
fillCases.forEach(function (fc) {
  var c = C(fc.c);
  var pallets = fc.req.map(function (r, i) {
    return { id: 'r' + i, name: 'R' + i, code: 'R' + i, l: r.l, w: r.w, h: 1100, baseH: 144, qty: r.qty, weight: 500, fill: false, color: i };
  });
  pallets.push({ id: 'f', name: '补柜', code: 'F', l: fc.fill.l, w: fc.fill.w, h: 1100, baseH: 144, qty: 1, weight: 500, fill: true, color: 4 });
  var res = SOLVER.solve(c, JSON.parse(JSON.stringify(pallets)), OPT);
  var req = fc.req.map(function (r, i) { return { id: 'r' + i, l: r.l, w: r.w, qty: r.qty }; });
  var mine = PACK.maxMixed(c.l, c.w, req, { l: fc.fill.l, w: fc.fill.w, id: 'f' }, true, 120);
  console.log(pad(fc.name, 32) + pad('程序补柜=' + (res.ok ? res.fillCount : 'X'), 18) + pad('独立排布=' + mine.fill, 14) +
    (res.ok && res.fillCount >= mine.fill ? '✓ 程序不差于对照' : '⚠ 程序少装 ' + ((res.ok ? res.fillCount : 0) - mine.fill)));
});

console.log('\n=== E. 混合组合下的分层分布 ===\n');
report.filter(function (r) { return /^M/.test(r.name); }).forEach(function (r) {
  if (!r.result.ok) return;
  var byType = {};
  r.result.placements.forEach(function (p) {
    (p.layers || []).forEach(function (l) { byType[l.name] = (byType[l.name] || 0) + 1; });
  });
  var stackDesc = r.result.placements.map(function (p) {
    return 'P' + p.seq + ':' + (p.layers[0] ? p.layers[0].code : '?') + '×' + p.count + '@x' + Math.round(p.x) + ',y' + Math.round(p.y);
  }).join(' | ');
  console.log('[' + r.name + '] 垛位 ' + r.result.stackCount);
  console.log('   ' + stackDesc);
});

/* 导出 JSON 供后续使用 */
var fs = require('fs');
fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(report.map(function (r) {
  return {
    name: r.name, container: r.container, opts: r.opts, ms: r.ms,
    ok: r.result.ok, err: r.result.error || null,
    totalCount: r.result.totalCount, requiredCount: r.result.requiredCount,
    fillCount: r.result.fillCount, stackCount: r.result.stackCount,
    floorUtil: r.result.floorUtil, volumeUtil: r.result.volumeUtil,
    maxHeight: r.result.maxHeight, totalWeight: r.result.totalWeight,
    mixedStacks: r.result.mixedStacks, strategy: r.result.strategy,
    stackingUsed: r.result.stackingUsed, optimalByArea: r.result.optimalByArea,
    clearance: (r.result.clearanceWarnings || []).map(function (w) { return w.text; }),
    placements: (r.result.placements || []).map(function (p) {
      return {
        seq: p.seq, type: p.typeId, x: Math.round(p.x), y: Math.round(p.y),
        l: p.l, w: p.w, count: p.count, rotated: p.rotated, fill: p.fill,
        layers: (p.layers || []).map(function (l) {
          return { t: l.typeId, l: l.l, w: l.w, h: l.h, rx: Math.round(l.relX), ry: Math.round(l.relY), fill: l.fill };
        })
      };
    }),
    issues: r.chk.issues, facts: r.chk.facts
  };
}), null, 1));
console.log('\n已写出 result.json');

