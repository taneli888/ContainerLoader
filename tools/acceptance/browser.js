'use strict';
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 8799;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
});

function P(id, l, w, qty, h, fill) {
  return { id, name: id, code: id, l, w, h: h || 1100, baseH: 144, qty, weight: 500, fill: !!fill, color: 0 };
}
const SCEN = [
  { tag: '8 EUR + 补柜', p: [P('EUR', 1200, 800, 8), P('F', 1120, 1120, 1, 1100, true)], o: {} },
  { tag: '6+6 同尺寸', p: [P('A', 1200, 800, 6), P('B', 1200, 800, 6)], o: {} },
  { tag: '12 EUR + 2 ASIA', p: [P('EUR', 1200, 800, 12), P('ASIA', 1100, 1100, 2)], o: {} },
  { tag: '1160+1120 混合', p: [P('BIG', 1160, 1150, 9), P('SM', 1120, 1120, 9)], o: {} },
  { tag: '间隙50', p: [P('EUR', 1200, 800, 10)], o: { gap: 50 } },
  { tag: '柜门预留300', p: [P('EUR', 1200, 800, 10)], o: { doorGap: 300 } },
  { tag: '门高超限', p: [P('TALL', 1200, 800, 2, 2350)], o: {} }
];

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'networkidle2' });
  await page.waitForFunction('window.__CL_DEBUG && window.CL_SOLVER', { timeout: 15000 });
  console.log('页面加载完成，JS 报错：' + (errors.length ? errors.join(' | ') : '无'));

  for (const s of SCEN) {
    const info = await page.evaluate((sc) => {
      const D = window.CL_DATA;
      const c = D.getContainer('20GP');
      const st = window.__CL_DEBUG.state;
      st.containerId = c.id;
      st.container = { l: c.l, w: c.w, h: c.h, payload: c.payload };
      st.pallets = JSON.parse(JSON.stringify(sc.p));
      st.options = Object.assign({ allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 }, sc.o || {});
      window.__CL_DEBUG.calculate(false);
      const lay = st.layout;
      return {
        total: lay && lay.totalCount,
        fill: lay && lay.fillCount,
        stacks: lay && lay.stackCount,
        ok: lay && lay.ok,
        error: lay && lay.error,
        typeRows: document.querySelectorAll('#typeList .type-row').length,
        gap: lay && lay.placements && lay.placements[0] && lay.placements[0].gap,
        maxX: lay && lay.placements && lay.placements.length ? Math.max.apply(null, lay.placements.map(p => p.x + p.l)) : null,
        notes: Array.from(document.querySelectorAll('#layoutNotes li')).map(x => x.textContent).join(' | '),
        canvas: (() => { const cv = document.querySelector('#scene'); return cv ? [cv.width, cv.height] : null; })()
      };
    }, s);
    console.log('[' + s.tag + '] ' + JSON.stringify(info));
  }

  await page.evaluate(() => { window.__CL_DEBUG.setMobileTab('view'); });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(__dirname, 'browser-last.png') });
  console.log('JS 报错汇总：' + (errors.length ? '\n  ' + errors.join('\n  ') : '无'));
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
