/* 空间排列审计：坐标、碰撞、越界、内部空隙、可移动性、柜门余量。 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.resolve(__dirname, '..');
const ctx = { console };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['js/data.js', 'js/solver.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const DATA = ctx.CL_DATA;
const SOLVER = ctx.CL_SOLVER;

function overlap(a, b, eps = 1e-6) {
  return a.x < b.x + b.l - eps && b.x < a.x + a.l - eps &&
    a.y < b.y + b.w - eps && b.y < a.y + a.w - eps;
}
function yOverlap(a, b, eps = 1e-6) {
  return a.y < b.y + b.w - eps && b.y < a.y + a.w - eps;
}
function canMoveLeft(p, all, L) {
  if (p.x <= 1e-6) return false;
  const test = Object.assign({}, p, { x: Math.max(0, p.x - 1) });
  if (test.x < 0) return false;
  return !all.some((q) => q !== p && overlap(test, q));
}
function canMoveLeftWall(p, all) {
  if (p.y <= 1e-6) return false;
  const test = Object.assign({}, p, { y: Math.max(0, p.y - 1) });
  return !all.some((q) => q !== p && overlap(test, q));
}
function gapFlags(all) {
  const flags = [];
  const sorted = all.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const right = sorted.filter((q) => q !== p && q.x >= p.x - 1e-6 && yOverlap(p, q))
      .sort((a, b) => a.x - b.x)[0];
    if (!right) continue;
    const gap = right.x - (p.x + p.l);
    if (gap > 1) {
      // 检查 gap 区域是否被其他托盘覆盖（不同排错位时可能是假报警）。
      const y0 = Math.max(p.y, right.y);
      const y1 = Math.min(p.y + p.w, right.y + right.w);
      const covered = all.some((q) => q !== p && q !== right &&
        q.x <= p.x + p.l + 1e-6 && q.x + q.l >= right.x - 1e-6 &&
        q.y <= y0 + 1e-6 && q.y + q.w >= y1 - 1e-6);
      if (!covered) flags.push({ from: p.seq, to: right.seq, gap: Math.round(gap) });
    }
  }
  return flags;
}

function audit(name, container, pallets, options) {
  const res = SOLVER.solve(container, pallets, options);
  console.log('\n=== ' + name + ' ===');
  if (!res.ok) {
    console.log('FAIL: ' + res.error);
    return;
  }
  const L = container.l, W = container.w;
  const rows = res.placements.map((p) => ({
    seq: p.seq,
    X: Math.round(p.x),
    Y: Math.round(p.y),
    L: Math.round(p.l),
    W: Math.round(p.w),
    rot: p.rotated ? 90 : 0,
    stack: p.count
  }));
  console.table(rows);

  const collisions = [];
  for (let i = 0; i < res.placements.length; i++) {
    for (let j = i + 1; j < res.placements.length; j++) {
      if (overlap(res.placements[i], res.placements[j])) {
        collisions.push([res.placements[i].seq, res.placements[j].seq]);
      }
    }
  }
  const out = res.placements.filter((p) =>
    p.x < -1e-6 || p.y < -1e-6 || p.x + p.l > L + 1e-6 || p.y + p.w > W + 1e-6
  );
  const movable = res.placements.filter((p) => canMoveLeft(p, res.placements, L));
  const movableY = res.placements.filter((p) => canMoveLeftWall(p, res.placements));
  const gaps = gapFlags(res.placements);
  const minX = Math.min(...res.placements.map((p) => p.x));
  const maxX = Math.max(...res.placements.map((p) => p.x + p.l));
  const minY = Math.min(...res.placements.map((p) => p.y));
  const maxY = Math.max(...res.placements.map((p) => p.y + p.w));

  console.log(JSON.stringify({
    total: res.totalCount,
    stacks: res.stackCount,
    collisions: collisions.length ? collisions : '无',
    outOfBounds: out.length ? out.map((p) => p.seq) : '无',
    bottomGap: Math.round(minX),
    doorResidual: Math.round(L - maxX),
    sideGapLeft: Math.round(minY),
    sideGapRight: Math.round(W - maxY),
    avoidableXGaps: gaps.length ? gaps : '无',
    canMoveTowardBottom: movable.length ? movable.map((p) => p.seq) : '无',
    canMoveTowardLeftWall: movableY.length ? movableY.map((p) => p.seq) : '无',
    xRange: [Math.round(minX), Math.round(maxX)],
    yRange: [Math.round(minY), Math.round(maxY)]
  }, null, 2));
}

const c20 = DATA.getContainer('20GP');
const eur2 = { id: 'e2', name: 'EUR2', code: 'EUR2', l: 1200, w: 1000, h: 1100, baseH: 144, qty: 3, weight: 0, fill: false, color: 0 };
audit('20GP · 3 托 1200×1000', c20, [eur2], { allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 });

const example = DATA.clone(DATA.example);
audit('20GP · 8 EUR + 1120 补柜（当前默认）', example.container, example.pallets, example.options);

const least11 = { id: 'e2', name: 'EUR2', code: 'EUR2', l: 1200, w: 1000, h: 1100, baseH: 144, qty: 11, weight: 0, fill: false, color: 0 };
audit('20GP · 11 托 1200×1000 不叠放优先', c20, [least11], { allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 });

const eur8 = { id: 'e', name: 'EUR', code: 'EUR', l: 1200, w: 800, h: 1100, baseH: 144, qty: 8, weight: 0, fill: false, color: 0 };
const small2 = { id: 's', name: 'SMALL', code: 'SM', l: 1000, w: 700, h: 1000, baseH: 144, qty: 2, weight: 0, fill: false, color: 1 };
audit('20GP · 8 EUR + 2 SMALL（后装规格靠柜门）', c20, [eur8, small2], { allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 });

const wind = { id: 'w', name: '1200×1000', code: 'WIND', l: 1200, w: 1000, h: 1100, baseH: 144, qty: 20, weight: 0, fill: false, color: 0 };
audit('20GP · 20 托 1200×1000 风车', c20, [wind], { allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 });
