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

const example = scenario('20GP 8 EUR + 1120 fill（默认叠放）', c20, [eur, sq]);
validatePlan('示例', example, c20);
check('示例补柜 = 14', example.ok && example.fillCount === 14, example.ok ? String(example.fillCount) : example.error);
check('示例总托数 = 22', example.ok && example.totalCount === 22, example.ok ? String(example.totalCount) : '');
check('示例 11 个垛位', example.ok && example.stackCount === 11, example.ok ? String(example.stackCount) : '');
check('示例最高垛 2200', example.ok && example.maxHeight === 2200, example.ok ? String(example.maxHeight) : '');
check('示例达到面积上限', example.ok && example.optimalByArea === true);
check('示例地面利用率约 91.0%', example.ok && Math.abs(example.floorUtil - 0.910) < 0.003, example.ok ? String(example.floorUtil) : '');
check('示例触发 2 项间隙报警', example.ok && example.clearanceWarnings.length === 2, example.ok ? String(example.clearanceWarnings.length) : '');
check('示例宽向报警余量 32mm', example.ok && example.clearanceWarnings.some((w) => w.axis === 'width' && w.clearance === 32));
check('示例长向报警余量 138mm', example.ok && example.clearanceWarnings.some((w) => w.axis === 'length' && w.clearance === 138));

const single = scenario('20GP 8 EUR + 1120 fill（关闭叠放）', c20, [eur, sq], { allowRotate: true, gap: 0, allowStack: false });
validatePlan('单层', single, c20);
check('单层补柜 = 4', single.ok && single.fillCount === 4, single.ok ? String(single.fillCount) : '');
check('单层总托数 = 12', single.ok && single.totalCount === 12);
check('单层最高 1100', single.ok && single.maxHeight === 1100);

const eur11 = scenario('20GP 11 EUR（叠放）', c20, [Object.assign({}, eur, { qty: 11 })]);
validatePlan('EUR11', eur11, c20);
check('11 EUR 可装', eur11.ok && eur11.totalCount === 11);
check('11 EUR 为 6 垛', eur11.ok && eur11.stackCount === 6);

const eur12s = scenario('20GP 12 EUR（叠放）', c20, [Object.assign({}, eur, { qty: 12 })]);
validatePlan('EUR12S', eur12s, c20);
check('12 EUR 叠放可装', eur12s.ok && eur12s.totalCount === 12);
check('12 EUR 为 6 个满垛', eur12s.ok && eur12s.stackCount === 6 && eur12s.placements.every((p) => p.count === 2));

const eur12 = scenario('20GP 12 EUR（关闭叠放）', c20, [Object.assign({}, eur, { qty: 12 })], { allowRotate: true, gap: 0, allowStack: false });
check('12 EUR 单层不可装', !eur12.ok);

const sq20 = scenario('20GP 1120 fill only（叠放）', c20, [Object.assign({}, sq, { fill: true, qty: 0 })]);
validatePlan('SQ20', sq20, c20);
check('1120 单规格叠放 20 托', sq20.ok && sq20.totalCount === 20, sq20.ok ? String(sq20.totalCount) : '');
check('1120 单规格 10 个垛位', sq20.ok && sq20.stackCount === 10);

const hq = scenario('40HQ 8 EUR + 1120 fill（叠放）', c40, [eur, sq]);
validatePlan('40HQ', hq, c40);
check('40HQ 补柜 >= 34', hq.ok && hq.fillCount >= 34, hq.ok ? String(hq.fillCount) : '');
check('40HQ 最高垛 2200', hq.ok && hq.maxHeight === 2200);

const gap = scenario('20GP gap 20（叠放）', c20, [eur, sq], { allowRotate: true, gap: 20, allowStack: true });
validatePlan('GAP20', gap, c20);
check('20mm 间隙补柜 >= 12', gap.ok && gap.fillCount >= 12, gap.ok ? String(gap.fillCount) : '');

const noRotate = scenario('20GP no rotate 11 EUR（叠放）', c20, [Object.assign({}, eur, { qty: 11 })], { allowRotate: false, gap: 0, allowStack: true });
check('禁止旋转时 11 EUR 仍可装', noRotate.ok && noRotate.totalCount === 11, noRotate.ok ? String(noRotate.totalCount) : 'no plan');

const custom = scenario('custom 1000x700（叠放）', c20, [
  Object.assign({}, eur, { id: 'c', name: 'custom', code: 'C', l: 1000, w: 700, qty: 4 }),
  Object.assign({}, sq, { id: 'f', l: 1000, w: 1000, qty: 0, fill: true })
]);
validatePlan('CUSTOM', custom, c20);

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
