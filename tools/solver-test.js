/* Container Loader 求解器回归测试 */
const path = require('path');
const DATA = require(path.join(__dirname, '..', 'js', 'data.js'));
const SOLVER = require(path.join(__dirname, '..', 'js', 'solver.js'));

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok  ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

function validatePlan(name, result, container) {
  check(name + ' 有方案', result && result.ok, result && result.error);
  if (!result || !result.ok) return;
  const ps = result.placements;
  let bad = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.x < -0.01 || p.y < -0.01 || p.x + p.l > container.l + 0.01 || p.y + p.w > container.w + 0.01) bad++;
    if (p.z < 0 || p.z + p.h * p.count > container.h + 0.01) bad++;
    for (let j = i + 1; j < ps.length; j++) {
      const q = ps[j];
      if (p.x < q.x + q.l - 0.01 && q.x < p.x + p.l - 0.01 &&
          p.y < q.y + q.w - 0.01 && q.y < p.y + p.w - 0.01) bad++;
    }
  }
  check(name + ' 无越界 / 无重叠', bad === 0, '问题数 ' + bad);
  const req = ps.filter((p) => !p.fill).reduce((s, p) => s + p.count, 0);
  check(name + ' 必装数量一致', req === result.requiredCount, req + ' != ' + result.requiredCount);
  const total = ps.reduce((s, p) => s + p.count, 0);
  check(name + ' 总托数一致', total === result.totalCount, total + ' != ' + result.totalCount);
  check(name + ' 垛位数一致', ps.length === result.stackCount, ps.length + ' != ' + result.stackCount);
}

function scenario(name, container, pallets, options) {
  const t0 = Date.now();
  const r = SOLVER.solve(container, pallets, options || { allowRotate: true, gap: 0, allowStack: true });
  const ms = Date.now() - t0;
  console.log('\n[' + name + '] ' + ms + 'ms');
  return r;
}

const c20 = DATA.getContainer('20GP');
const c40 = DATA.getContainer('40HQ');
const eur = { id: 'eur', name: 'EUR', code: 'EUR', l: 1200, w: 800, h: 1100, baseH: 144, qty: 8, weight: 650, fill: false, color: 0 };
const sq = { id: 'sq', name: '1120', code: '1120', l: 1120, w: 1120, h: 1100, baseH: 140, qty: 0, weight: 700, fill: true, color: 1 };

const example = scenario('20GP 8 EUR + 1120 fill（默认优先不叠放）', c20, [eur, sq]);
validatePlan('示例', example, c20);
check('示例补柜 = 4', example.ok && example.fillCount === 4, example.ok ? String(example.fillCount) : example.error);
check('示例总托数 = 12', example.ok && example.totalCount === 12, example.ok ? String(example.totalCount) : '');
check('示例 12 个单层垛位', example.ok && example.stackCount === 12, example.ok ? String(example.stackCount) : '');
check('示例最高 1100（未叠放）', example.ok && example.maxHeight === 1100, example.ok ? String(example.maxHeight) : '');
check('示例优先不叠放', example.ok && example.stackingUsed === false);
check('示例达到单层面积上限', example.ok && example.optimalByArea === true);
check('示例地面利用率约 91.5%', example.ok && Math.abs(example.floorUtil - 0.915) < 0.004, example.ok ? String(example.floorUtil) : '');
check('示例柜门余量 > 0', example.ok && example.doorClearance > 0, example.ok ? String(example.doorClearance) : '');
check('示例贴紧柜底（X=0）', example.ok && Math.min(...example.placements.map((p) => p.x)) === 0, example.ok ? String(Math.min(...example.placements.map((p) => p.x))) : '');
check('示例剩余空间在柜门侧', example.ok && Math.max(...example.placements.map((p) => p.x + p.baseL)) + example.doorClearance === 5898, example.ok ? String(Math.max(...example.placements.map((p) => p.x + p.baseL)) + '+' + example.doorClearance) : '');

const stackedExample = scenario('20GP 8 EUR + 1120 fill（关闭优先不叠放）', c20, [eur, sq], { allowRotate: true, gap: 0, allowStack: true, preferSingle: false, doorGap: 0 });
validatePlan('叠放示例', stackedExample, c20);
check('关闭优先后补柜 = 14', stackedExample.ok && stackedExample.fillCount === 14, stackedExample.ok ? String(stackedExample.fillCount) : '');
check('关闭优先后总托数 = 22', stackedExample.ok && stackedExample.totalCount === 22);
check('关闭优先后 11 个垛位', stackedExample.ok && stackedExample.stackCount === 11);
check('关闭优先后最高 2200', stackedExample.ok && stackedExample.maxHeight === 2200);

const single = scenario('20GP 8 EUR + 1120 fill（关闭叠放）', c20, [eur, sq], { allowRotate: true, gap: 0, allowStack: false });
validatePlan('单层', single, c20);
check('单层补柜 = 4', single.ok && single.fillCount === 4, single.ok ? String(single.fillCount) : '');
check('单层总托数 = 12', single.ok && single.totalCount === 12);
check('单层最高 1100', single.ok && single.maxHeight === 1100);

const eur8 = scenario('20GP 8 EUR 单规格（优先不叠）', c20, [Object.assign({}, eur, { qty: 8 })]);
validatePlan('EUR8', eur8, c20);
check('8 EUR 单层可放时 8 垛', eur8.ok && eur8.stackCount === 8 && eur8.maxHeight === 1100, eur8.ok ? (eur8.stackCount + '垛/' + eur8.maxHeight) : '');

const gapDoor = scenario('20GP 柜门预留 200', c20, [eur, sq], { allowRotate: true, gap: 0, allowStack: true, doorGap: 200 });
check('柜门预留至少 200mm', gapDoor.ok && gapDoor.doorClearance >= 200, gapDoor.ok ? String(gapDoor.doorClearance) : '');

const eur11 = scenario('20GP 11 EUR（叠放）', c20, [Object.assign({}, eur, { qty: 11 })]);
validatePlan('EUR11', eur11, c20);
check('11 EUR 可装', eur11.ok && eur11.totalCount === 11);
check('11 EUR 单层可放时优先不叠', eur11.ok && eur11.stackCount === 11 && eur11.maxHeight === 1100, eur11.ok ? (eur11.stackCount + '垛/' + eur11.maxHeight) : '');

const eur12s = scenario('20GP 12 EUR（不叠放优先）', c20, [Object.assign({}, eur, { qty: 12 })]);
validatePlan('EUR12S', eur12s, c20);
check('12 EUR 可装', eur12s.ok && eur12s.totalCount === 12);
check('12 EUR 不叠放优先：1 个双层 + 10 个单层', eur12s.ok && eur12s.stackCount === 11 && eur12s.placements.filter((p) => p.count === 2).length === 1);
const eur12Stack = scenario('20GP 12 EUR（叠放优先）', c20, [Object.assign({}, eur, { qty: 12 })], { allowRotate: true, gap: 0, allowStack: true, preferSingle: false, doorGap: 0 });
check('12 EUR 叠放优先：6 个满垛', eur12Stack.ok && eur12Stack.stackCount === 6 && eur12Stack.placements.every((p) => p.count === 2));

const eur12 = scenario('20GP 12 EUR（关闭叠放）', c20, [Object.assign({}, eur, { qty: 12 })], { allowRotate: true, gap: 0, allowStack: false });
check('12 EUR 单层不可装', !eur12.ok);

const sq20 = scenario('20GP 1120 fill only（默认优先不叠）', c20, [Object.assign({}, sq, { fill: true, qty: 0 })]);
validatePlan('SQ20', sq20, c20);
check('1120 默认单层 10 托', sq20.ok && sq20.totalCount === 10, sq20.ok ? String(sq20.totalCount) : '');
const sq20s = scenario('20GP 1120 fill only（关闭优先不叠）', c20, [Object.assign({}, sq, { fill: true, qty: 0 })], { allowRotate: true, gap: 0, allowStack: true, preferSingle: false, doorGap: 0 });
check('1120 允许叠放 20 托', sq20s.ok && sq20s.totalCount === 20, sq20s.ok ? String(sq20s.totalCount) : '');

const hq = scenario('40HQ 8 EUR + 1120 fill（默认优先不叠）', c40, [eur, sq]);
validatePlan('40HQ', hq, c40);
check('40HQ 默认单层 23 托', hq.ok && hq.totalCount === 23, hq.ok ? String(hq.totalCount) : '');
const hqStack = scenario('40HQ 8 EUR + 1120 fill（关闭优先不叠）', c40, [eur, sq], { allowRotate: true, gap: 0, allowStack: true, preferSingle: false, doorGap: 0 });
check('40HQ 叠放补柜 >= 34', hqStack.ok && hqStack.fillCount >= 34, hqStack.ok ? String(hqStack.fillCount) : '');
check('40HQ 叠放最高垛 2200', hqStack.ok && hqStack.maxHeight === 2200);

const gap = scenario('20GP gap 20（关闭优先不叠）', c20, [eur, sq], { allowRotate: true, gap: 20, allowStack: true, preferSingle: false, doorGap: 0 });
validatePlan('GAP20', gap, c20);
check('20mm 间隙叠放补柜 >= 12', gap.ok && gap.fillCount >= 12, gap.ok ? String(gap.fillCount) : '');

const noRotate = scenario('20GP no rotate 11 EUR（叠放）', c20, [Object.assign({}, eur, { qty: 11 })], { allowRotate: false, gap: 0, allowStack: true });
check('禁止旋转时 11 EUR 仍可装', noRotate.ok && noRotate.totalCount === 11, noRotate.ok ? String(noRotate.totalCount) : 'no plan');

const custom = scenario('custom 1000x700（叠放）', c20, [
  Object.assign({}, eur, { id: 'c', name: 'custom', code: 'C', l: 1000, w: 700, qty: 4 }),
  Object.assign({}, sq, { id: 'f', l: 1000, w: 1000, qty: 0, fill: true })
]);
validatePlan('CUSTOM', custom, c20);

const big = { id: 'big', name: 'big', code: 'BIG', l: 1160, w: 1150, h: 1100, baseH: 144, qty: 9, weight: 0, fill: false, color: 0 };
const small = { id: 'small', name: 'small', code: 'SM', l: 1120, w: 1120, h: 1100, baseH: 144, qty: 9, weight: 0, fill: false, color: 1 };
const mixed = scenario('1160 大托 + 1120 小托（允许大底小上）', c20, [big, small]);
validatePlan('MIXED', mixed, c20);
check('混合叠放允许大底小上', mixed.ok && mixed.mixedStacks >= 1, mixed.ok ? String(mixed.mixedStacks) : '');
check('混合叠放没有重复计数', mixed.ok && mixed.totalCount === 18, mixed.ok ? String(mixed.totalCount) : '');

const windP = { id: 'wind', name: '风车 1200×1000', code: 'WIND', l: 1200, w: 1000, h: 1100, baseH: 144, qty: 20, weight: 0, fill: false, color: 0 };
const wind = scenario('20GP 20 托 1200×1000 风车', c20, [windP]);
validatePlan('WIND20', wind, c20);
check('风车放下 20 托', wind.ok && wind.totalCount === 20, wind.ok ? String(wind.totalCount) : '');
check('风车为 10 个 2 层垛', wind.ok && wind.stackCount === 10 && wind.maxHeight === 2200, wind.ok ? (wind.stackCount + '垛/' + wind.maxHeight) : '');
check('风车贴柜底、余量在柜门', wind.ok && wind.bottomGap === 0 && wind.doorClearance >= 0, wind.ok ? ('底缝' + wind.bottomGap + '/门余' + wind.doorClearance) : '');
const wind10 = scenario('20GP 10 托 1200×1000 风车单层', c20, [Object.assign({}, windP, { qty: 10 })]);
check('10 托风车单层优先', wind10.ok && wind10.totalCount === 10 && wind10.stackingUsed === false && wind10.maxHeight === 1100, wind10.ok ? (wind10.stackCount + '垛/' + wind10.maxHeight) : '');

const three = scenario('20GP 3 托 1200×1000 柜底对齐', c20, [{ id: 'e2', name: 'EUR2', code: 'EUR2', l: 1200, w: 1000, h: 1100, baseH: 144, qty: 3, weight: 0, fill: false, color: 0 }]);
validatePlan('THREE', three, c20);
check('3 托短通道也贴柜底', three.ok && three.placements.every((p) => p.x === 0 || three.placements.some((q) => q !== p && Math.abs(q.x + q.baseL - p.x) < 1 && q.y < p.y + p.w && p.y < q.y + q.w)), three.ok ? JSON.stringify(three.placements.map((p) => [p.x, p.y, p.l, p.w])) : '');

const eur2x11 = { id: 'e2', name: 'EUR2', code: 'EUR2', l: 1200, w: 1000, h: 1100, baseH: 144, qty: 11, weight: 0, fill: false, color: 0 };
const least11 = scenario('20GP 11 托 1200×1000 不叠放优先', c20, [eur2x11]);
validatePlan('LEAST11', least11, c20);
const counts11 = least11.ok ? least11.placements.map((p) => p.count).sort((a, b) => a - b) : [];
check('11 托不叠放优先：1 组叠放 + 9 个平放', least11.ok && counts11.filter((n) => n === 2).length === 1 && counts11.filter((n) => n === 1).length === 9, least11.ok ? counts11.join(',') : '');
const stack11 = scenario('20GP 11 托 1200×1000 叠放优先', c20, [eur2x11], { allowRotate: true, gap: 0, allowStack: true, preferSingle: false, doorGap: 0 });
check('11 托叠放优先：5 个双层 + 1 个单层', stack11.ok && stack11.stackCount === 6 && stack11.placements.filter((p) => p.count === 2).length === 5, stack11.ok ? stack11.placements.map((p) => p.count).join(',') : '');

const small2 = { id: 's2', name: 'SMALL 1000×700', code: 'SM', l: 1000, w: 700, h: 1000, baseH: 144, qty: 2, weight: 0, fill: false, color: 1 };
const multiDoor = scenario('20GP 8 EUR + 2 SMALL（多规格全局重排）', c20, [eur, small2]);
validatePlan('MULTI', multiDoor, c20);
check('多规格总托数 10', multiDoor.ok && multiDoor.totalCount === 10, multiDoor.ok ? String(multiDoor.totalCount) : '');

const woda = { id: 'woda', name: 'WODA', code: 'WODA', l: 1130, w: 1130, h: 1100, baseH: 144, qty: 7, weight: 0, fill: false, color: 0 };
const eur2 = { id: 'eur2', name: 'EUR', code: 'EUR', l: 1200, w: 800, h: 1100, baseH: 144, qty: 2, weight: 0, fill: false, color: 1 };
const zoned = scenario('WODA + EUR 叠放优先：单层不夹在叠放中间', c20, [woda, eur2], { allowRotate: true, gap: 0, allowStack: true, preferSingle: false, doorGap: 0 });
validatePlan('ZONED', zoned, c20);
const highEnd = zoned.ok ? Math.max(...zoned.placements.filter((p) => p.count > 1).map((p) => p.x + p.baseL)) : 0;
const lowMin = zoned.ok ? Math.min(...zoned.placements.filter((p) => p.count === 1).map((p) => p.x)) : 0;
check('单层托盘不夹在叠放托盘中间', zoned.ok && lowMin >= highEnd - 1, zoned.ok ? ('低层起点 ' + lowMin + ' / 高层终点 ' + highEnd) : '');

const woda10 = Object.assign({}, woda, { qty: 10 });
const eur4 = Object.assign({}, eur2, { qty: 4 });
const gapFix = scenario('WODA10 + EUR4：柜底利用率优先', c20, [woda10, eur4], { allowRotate: true, gap: 0, allowStack: true, preferSingle: false, doorGap: 0 });
validatePlan('GAPFIX', gapFix, c20);
const eurMin = gapFix.ok ? Math.min(...gapFix.placements.filter((p) => p.typeId === 'eur2').map((p) => p.x)) : 0;
const wodaMin = gapFix.ok ? Math.min(...gapFix.placements.filter((p) => p.typeId === 'woda').map((p) => p.x)) : 0;
check('WODA 先填柜底，EUR 接在后面', gapFix.ok && wodaMin === 0 && eurMin >= 2260, gapFix.ok ? ('WODA ' + wodaMin + ' / EUR ' + eurMin) : '');
check('WODA10+EUR4 实装 4590mm', gapFix.ok && Math.max(...gapFix.placements.map((p) => p.x + p.baseL)) === 4590, gapFix.ok ? String(Math.max(...gapFix.placements.map((p) => p.x + p.baseL))) : '');

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
