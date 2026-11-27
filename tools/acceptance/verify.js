'use strict';
/* P0/P1 验收门禁：所有断言通过才允许部署。 */
var path = require('path');
var DATA = require(path.join(__dirname, '..', '..', 'js', 'data.js'));
var SOLVER = require(path.join(__dirname, '..', '..', 'js', 'solver.js'));
var CHECK = require('./lib_check.js');

var failed = 0;
function ok(name, cond, detail) {
  if (cond) console.log('  ok  ' + name);
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function C(id) {
  var c = DATA.getContainer(id);
  return { id: c.id, code: c.code, name: c.name, l: c.l, w: c.w, h: c.h, payload: c.payload, doorW: c.doorW, doorH: c.doorH };
}
function P(id, l, w, qty, fill, h) {
  return { id: id, name: id, code: id, l: l, w: w, h: h || 1100, baseH: 144, qty: qty, weight: 500, fill: !!fill, color: 0 };
}
function run(c, ps, opt) {
  var options = Object.assign({ allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 }, opt || {});
  var r = SOLVER.solve(c, ps, options);
  return { r: r, chk: CHECK.check(r, c, ps, options), options: options };
}
function valid(name, x) {
  ok(name + ' 有方案', x.r.ok, x.r.error);
  ok(name + ' 无 fatal', x.chk.ok, JSON.stringify(x.chk.issues.filter(function (i) { return i.level === 'fatal'; })));
}

console.log('=== P0/P1 验收 ===');
var c20 = C('20GP'), c40 = C('40HQ');

// P0-2 补柜：必装不叠，补柜可叠
var f1 = run(c20, [P('EUR', 1200, 800, 8), P('F1120', 1120, 1120, 1, true)]);
valid('F1 8 EUR + 1120 补柜', f1);
ok('F1 补柜 = 8（4 地面位 × 2 层）', f1.r.ok && f1.r.fillCount === 8, f1.r.ok ? String(f1.r.fillCount) : '');
ok('F1 总托数 = 16', f1.r.ok && f1.r.totalCount === 16, f1.r.ok ? String(f1.r.totalCount) : '');
var f2 = run(c20, [P('EUR', 1200, 800, 4), P('F1120', 1120, 1120, 1, true)]);
ok('F2 4 EUR 补柜 >= 10', f2.r.ok && f2.r.fillCount >= 10, f2.r.ok ? String(f2.r.fillCount) : '');

// P0-3 同尺寸 6+6 合并
var split = run(c20, [P('A', 1200, 800, 6), P('B', 1200, 800, 6)]);
valid('6+6 同尺寸拆分', split);
ok('6+6 地面垛位 <= 11', split.r.ok && split.r.stackCount <= 11, split.r.ok ? String(split.r.stackCount) : '');
ok('6+6 地面利用率 >= 70%', split.r.ok && split.r.floorUtil >= 0.70, split.r.ok ? String(split.r.floorUtil) : '');

// P0-3 多规格最少叠放
var m4 = run(c20, [P('EUR', 1200, 800, 12), P('ASIA', 1100, 1100, 2)]);
valid('M4 12 EUR + 2 ASIA', m4);
ok('M4 地面垛位 >= 10', m4.r.ok && m4.r.stackCount >= 10, m4.r.ok ? String(m4.r.stackCount) : '');
ok('M4 地面利用率 >= 65%', m4.r.ok && m4.r.floorUtil >= 0.65, m4.r.ok ? String(m4.r.floorUtil) : '');
ok('M4 柜门余量 <= 700mm', m4.r.ok && m4.r.doorClearance <= 700, m4.r.ok ? String(m4.r.doorClearance) : '');

var m5 = run(c40, [P('EUR', 1200, 800, 20), P('EUR2', 1200, 1000, 8), P('GMA', 1219, 1016, 2)]);
valid('M5 40HQ 30 托', m5);
ok('M5 地面垛位 >= 20', m5.r.ok && m5.r.stackCount >= 20, m5.r.ok ? String(m5.r.stackCount) : '');
ok('M5 柜门余量 <= 900mm', m5.r.ok && m5.r.doorClearance <= 900, m5.r.ok ? String(m5.r.doorClearance) : '');

// P0-1 间隙
var g50 = run(c20, [P('EUR', 1200, 800, 10)], { gap: 50 });
valid('GAP50 10 EUR', g50);
var gapBad = g50.chk.issues.filter(function (i) { return i.level === 'fatal' && i.msg.indexOf('净距') >= 0; });
ok('GAP50 相邻净距 >= 50mm', gapBad.length === 0, JSON.stringify(gapBad.slice(0, 2)));

// P1-4 柜门预留
var d300 = run(c20, [P('EUR', 1200, 800, 10)], { doorGap: 300 });
valid('DOOR300 10 EUR', d300);
ok('DOOR300 不侵入预留', d300.r.ok && d300.r.placements.every(function (p) { return p.x + p.l <= 5898 - 300 + 1.5; }));

// P1-5 大底小上混合叠放
var mx = run(c20, [P('BIG', 1160, 1150, 9), P('SM', 1120, 1120, 9)]);
valid('MIX 1160×1150 + 1120×1120', mx);
ok('MIX 生成混合垛 >= 1', mx.r.ok && mx.r.mixedStacks >= 1, mx.r.ok ? String(mx.r.mixedStacks) : '');
ok('MIX 上托不悬空', mx.r.ok && mx.r.placements.every(function (p) {
  return (p.layers || []).every(function (ly, i, arr) {
    if (i === 0) return true;
    var lo = arr[i - 1];
    return ly.relX >= -0.01 && ly.relY >= -0.01 && ly.relX + ly.l <= lo.l + 0.01 && ly.relY + ly.w <= lo.w + 0.01;
  });
}));

// P1-6 门高
var tall = run(c20, [P('TALL', 1200, 800, 2, false, 2350)]);
ok('门高 2350 > 2280 被拒绝', !tall.r.ok && /门高/.test(tall.r.error || ''), tall.r.error || '');

console.log('\n结果：' + (failed ? (failed + ' 项失败') : '全部通过'));
process.exit(failed ? 1 : 0);
