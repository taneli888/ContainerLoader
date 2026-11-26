/* Container Loader 浏览器实测：桌面 / 手机 / 打印媒体 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'tests');
const PORT = 9345;
const PROFILE = path.join(OUT, 'edge-test-profile');
const URL = process.env.CL_URL || 'http://127.0.0.1:8777/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    };
  }
  open() { return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function waitPort() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && !/^chrome-extension:/.test(t.url));
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(120);
  }
  throw new Error('Edge CDP 未启动');
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
  return r.result.value;
}

async function metrics(cdp, width, height, mobile) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: !!mobile,
    screenWidth: width, screenHeight: height
  });
  await sleep(450);
}

async function shot(cdp, name) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('截图超时: ' + name)), 20000));
  try {
    const r = await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }),
      timeout
    ]);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('screenshot:', name);
  } catch (e) {
    console.log('screenshot skipped:', name, e.message);
  }
}

(async () => {
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const edge = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    const ws = await waitPort();
    const cdp = new CDP(ws);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL });
    await sleep(1600);

    await metrics(cdp, 1440, 960, false);
    await sleep(500);
    await shot(cdp, 'desktop-cdp.png');

    // 点击一个可见托盘面，验证选中信息卡
    const hit = await evaluate(cdp, `(() => {
      const scene = window.__CL_DEBUG.scene;
      const f = scene._hitFaces[0];
      const rect = document.querySelector('#scene').getBoundingClientRect();
      if (!f) return null;
      return { x: rect.left + f.points.reduce((s,p)=>s+p.x,0)/f.points.length, y: rect.top + f.points.reduce((s,p)=>s+p.y,0)/f.points.length, seq: f.seq };
    })()`);
    if (hit) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount: 1 });
      await sleep(300);
    }
    const selected = await evaluate(cdp, `({ hidden: document.querySelector('#stageSelection').hidden, title: document.querySelector('#selectionTitle').textContent, sub: document.querySelector('#selectionSub').textContent })`);
    await shot(cdp, 'desktop-selected-cdp.png');
    await evaluate(cdp, `document.querySelector('#selectionClose').click()`);
    await sleep(200);

    // 拖拽旋转 / Shift 平移 / 滚轮缩放 / 复位
    const box = await evaluate(cdp, `(() => { const r=document.querySelector('#scene').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const cam0 = await evaluate(cdp, `({ yaw: __CL_DEBUG.scene.cam.yaw, pitch: __CL_DEBUG.scene.cam.pitch, panX: __CL_DEBUG.scene.cam.panX, panY: __CL_DEBUG.scene.cam.panY, zoom: __CL_DEBUG.scene.cam.zoom })`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + i * 15, y: box.y + i * 7, button: 'left', buttons: 1 });
      await sleep(25);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 90, y: box.y + 42, button: 'left', clickCount: 1 });
    await sleep(250);
    const camOrbit = await evaluate(cdp, `({ yaw: __CL_DEBUG.scene.cam.yaw, pitch: __CL_DEBUG.scene.cam.pitch })`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers: 8 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 50, y: box.y - 30, button: 'left', buttons: 1, modifiers: 8 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 50, y: box.y - 30, button: 'left', clickCount: 1, modifiers: 8 });
    await sleep(200);
    const camPan = await evaluate(cdp, `({ panX: __CL_DEBUG.scene.cam.panX, panY: __CL_DEBUG.scene.cam.panY })`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -160 });
    await sleep(200);
    const camZoom = await evaluate(cdp, `({ zoom: __CL_DEBUG.scene.cam.zoom })`);
    await evaluate(cdp, `document.querySelector('#btnResetView').click()`);
    await sleep(550);
    const camReset = await evaluate(cdp, `({ yaw: __CL_DEBUG.scene.cam.yaw, pitch: __CL_DEBUG.scene.cam.pitch, panX: __CL_DEBUG.scene.cam.panX, panY: __CL_DEBUG.scene.cam.panY, zoom: __CL_DEBUG.scene.cam.zoom })`);

    // 双层显示切换
    const layerOn = await evaluate(cdp, `({ checked: document.querySelector('#doubleLayer').checked, disabled: document.querySelector('#doubleLayer').disabled, label: document.querySelector('#layerToggle span').textContent, showUpper: __CL_DEBUG.scene.showUpper })`);
    await evaluate(cdp, `document.querySelector('#doubleLayer').click()`);
    await sleep(300);
    const layerOff = await evaluate(cdp, `({ checked: document.querySelector('#doubleLayer').checked, showUpper: __CL_DEBUG.scene.showUpper })`);
    await shot(cdp, 'desktop-single-layer-cdp.png');
    await evaluate(cdp, `document.querySelector('#doubleLayer').click()`);
    await sleep(250);

    // 顺时针 / 逆时针按钮：按一次持续旋转，再按停止
    const yaw0 = await evaluate(cdp, `__CL_DEBUG.scene.cam.yaw`);
    await evaluate(cdp, `document.querySelector('#btnRotateCCW').click()`);
    await sleep(650);
    const yawCCW = await evaluate(cdp, `({ yaw: __CL_DEBUG.scene.cam.yaw, active: document.querySelector('#btnRotateCCW').classList.contains('active'), auto: __CL_DEBUG.scene.autoRotate })`);
    await evaluate(cdp, `document.querySelector('#btnRotateCCW').click()`);
    await sleep(250);
    const yawStopped1 = await evaluate(cdp, `__CL_DEBUG.scene.cam.yaw`);
    await sleep(300);
    const yawStopped2 = await evaluate(cdp, `__CL_DEBUG.scene.cam.yaw`);
    await evaluate(cdp, `document.querySelector('#btnRotateCW').click()`);
    await sleep(500);
    const yawCW = await evaluate(cdp, `({ yaw: __CL_DEBUG.scene.cam.yaw, active: document.querySelector('#btnRotateCW').classList.contains('active'), auto: __CL_DEBUG.scene.autoRotate })`);
    await evaluate(cdp, `document.querySelector('#btnRotateCW').click()`);
    await sleep(250);

    // 视角切换
    await evaluate(cdp, `document.querySelector('#viewSeg button[data-view="top"]').click()`);
    await sleep(700);
    await shot(cdp, 'desktop-top-cdp.png');
    await evaluate(cdp, `document.querySelector('#viewSeg button[data-view="iso"]').click()`);
    await sleep(500);

    const desktop = await evaluate(cdp, `(() => ({
      title: document.title,
      inner: [innerWidth, innerHeight],
      doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
      body: [document.body.clientWidth, document.body.scrollWidth],
      total: document.querySelector('#resultTotal').textContent,
      required: document.querySelector('#resultRequired').textContent,
      fill: document.querySelector('#resultFill').textContent,
      util: document.querySelector('#resultUtil').textContent,
      clearanceVisible: !document.querySelector('#clearanceAlert').hidden,
      clearanceCount: document.querySelectorAll('#clearanceList li').length,
      clearanceText: (document.querySelector('#clearanceList').innerText || '').slice(0, 160),
      palletCards: document.querySelectorAll('.pallet-card').length,
      placements: (window.CL_SCENE ? 1 : 0),
      stage: (() => { const r = document.querySelector('#stageWrap').getBoundingClientRect(); return [r.width, r.height]; })(),
      errors: window.__errors || []
    }))()`);

    // 切 40HQ
    await evaluate(cdp, `(() => { const s=document.querySelector('#containerSelect'); s.value='40HQ'; s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await sleep(700);
    const hq = await evaluate(cdp, `({ code: document.querySelector('#resultContainer').textContent, total: document.querySelector('#resultTotal').textContent, fill: document.querySelector('#resultFill').textContent, title: document.querySelector('#stageTitle').textContent })`);
    await shot(cdp, 'desktop-40hq-cdp.png');

    // 增加间隙 20mm
    await evaluate(cdp, `(() => { const s=document.querySelector('#gapInput'); s.value='20'; s.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(700);
    const gap = await evaluate(cdp, `({ total: document.querySelector('#resultTotal').textContent, fill: document.querySelector('#resultFill').textContent, util: document.querySelector('#resultUtil').textContent })`);

    // 超量必装，验证错误态
    await evaluate(cdp, `(() => { const s=document.querySelector('#containerSelect'); s.value='20GP'; s.dispatchEvent(new Event('change',{bubbles:true})); const g=document.querySelector('#gapInput'); g.value='0'; g.dispatchEvent(new Event('input',{bubbles:true})); const q=document.querySelector('.pallet-card [data-field="qty"]'); q.value='100'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(900);
    const error = await evaluate(cdp, `({ errorHidden: document.querySelector('#resultError').hidden, errorText: document.querySelector('#errorText').textContent, total: document.querySelector('#resultTotal').textContent, badge: document.querySelector('#sceneBadge').textContent })`);
    await shot(cdp, 'desktop-error-cdp.png');

    // 新建自定义托盘并重算
    await evaluate(cdp, `document.querySelector('#btnAddCustom').click()`);
    await sleep(300);
    const customState = await evaluate(cdp, `(() => {
      const cards = [...document.querySelectorAll('.pallet-card')];
      const firstQty = cards[0].querySelector('[data-field="qty"]');
      firstQty.value='8'; firstQty.dispatchEvent(new Event('input',{bubbles:true}));
      const card = cards[cards.length-1];
      const set = (f,v) => { const el = card.querySelector('[data-field="'+f+'"]'); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); };
      set('name','蓝托 1000×700');
      set('code','BLUE');
      set('l','1000'); set('w','700'); set('h','1000'); set('qty','4');
      return { cards: cards.length };
    })()`);
    await sleep(900);
    const customResult = await evaluate(cdp, `({ cards: document.querySelectorAll('.pallet-card').length, total: document.querySelector('#resultTotal').textContent, errorHidden: document.querySelector('#resultError').hidden, error: document.querySelector('#errorText').textContent, typeRows: document.querySelectorAll('.type-row').length, code: __CL_DEBUG.state.pallets[2].code, name: __CL_DEBUG.state.pallets[2].name, presetText: [...document.querySelectorAll('#presetSelect option')].map(o=>o.textContent).join(' | ') })`);
    await shot(cdp, 'desktop-custom-cdp.png');
    await evaluate(cdp, `document.querySelector('#btnManagePresets').click()`);
    await sleep(200);
    const presetBefore = await evaluate(cdp, `({ rows: document.querySelectorAll('.custom-preset-row').length, cards: document.querySelectorAll('.pallet-card').length })`);
    await shot(cdp, 'desktop-preset-manager-cdp.png');
    await evaluate(cdp, `document.querySelector('.custom-preset-row button[data-delete-preset]').click()`);
    await sleep(200);
    const presetAfter = await evaluate(cdp, `({ rows: document.querySelectorAll('.custom-preset-row').length, cards: document.querySelectorAll('.pallet-card').length, empty: document.querySelectorAll('.custom-empty').length })`);
    await evaluate(cdp, `document.querySelector('#btnDonePresetModal').click()`);
    await evaluate(cdp, `(() => { const cards=document.querySelectorAll('.pallet-card'); cards[cards.length-1].querySelector('.pallet-remove').click(); })()`);
    await sleep(700);
    const deleted = await evaluate(cdp, `({ cards: document.querySelectorAll('.pallet-card').length, total: document.querySelector('#resultTotal').textContent, errorHidden: document.querySelector('#resultError').hidden })`);

    // 恢复示例
    await evaluate(cdp, `document.querySelector('#btnExample').click()`);
    await sleep(900);

    // 补柜按钮：按一次算最多，再按取消并显示实际数量输入
    await evaluate(cdp, `document.querySelectorAll('.fill-toggle')[1].click()`);
    await sleep(600);
    const fillOff = await evaluate(cdp, `({
      fillItemHidden: document.querySelector('#resultFillItem').hidden,
      qtyVisible: !!document.querySelectorAll('.pallet-card')[1].querySelector('[data-field="qty"]'),
      total: document.querySelector('#resultTotal').textContent,
      sub: document.querySelector('#resultSub').textContent
    })`);
    await evaluate(cdp, `document.querySelectorAll('.fill-toggle')[1].click()`);
    await sleep(600);
    const fillOn = await evaluate(cdp, `({
      fillItemHidden: document.querySelector('#resultFillItem').hidden,
      fill: document.querySelector('#resultFill').textContent,
      total: document.querySelector('#resultTotal').textContent
    })`);

    // 叠放优先 / 不叠放优先按钮
    await evaluate(cdp, `document.querySelector('#prioritySeg button[data-priority="stack"]').click()`);
    await sleep(700);
    const priorityStack = await evaluate(cdp, `({ total: document.querySelector('#resultTotal').textContent, stacking: __CL_DEBUG.state.layout.stackingUsed })`);
    await evaluate(cdp, `document.querySelector('#prioritySeg button[data-priority="single"]').click()`);
    await sleep(700);
    const prioritySingle = await evaluate(cdp, `({ total: document.querySelector('#resultTotal').textContent, stacking: __CL_DEBUG.state.layout.stackingUsed })`);

    // 混合叠放：1160×1150 底 + 1120×1120 上
    await evaluate(cdp, `(() => {
      __CL_DEBUG.state.pallets = [
        { id:'mix-big', name:'大托 1160×1150', code:'BIG', l:1160, w:1150, h:1100, baseH:144, qty:9, weight:0, fill:false, color:0 },
        { id:'mix-small', name:'小托 1120×1120', code:'SM', l:1120, w:1120, h:1100, baseH:144, qty:9, weight:0, fill:false, color:1 }
      ];
      __CL_DEBUG.state.options.allowStack = true;
      __CL_DEBUG.calculate(false);
    })()`);
    await sleep(900);
    const mixedResult = await evaluate(cdp, `({ total: document.querySelector('#resultTotal').textContent, stacks: __CL_DEBUG.state.layout.stackCount, mixed: __CL_DEBUG.state.layout.mixedStacks, badge: document.querySelector('#resultBadge').textContent })`);
    await shot(cdp, 'desktop-mixed-cdp.png');
    await evaluate(cdp, `document.querySelector('#btnExample').click()`);
    await sleep(700);

    // 1200×1000 风车：20 托 / 2 层
    await evaluate(cdp, `(() => {
      __CL_DEBUG.state.pallets = [
        { id:'wind', name:'风车 1200×1000', code:'WIND', l:1200, w:1000, h:1100, baseH:144, qty:20, weight:0, fill:false, color:0 }
      ];
      __CL_DEBUG.state.options.allowStack = true;
      __CL_DEBUG.state.options.preferSingle = true;
      __CL_DEBUG.calculate(false);
    })()`);
    await sleep(900);
    const windmill = await evaluate(cdp, `({ total: document.querySelector('#resultTotal').textContent, stacks: __CL_DEBUG.state.layout.stackCount, maxH: __CL_DEBUG.state.layout.maxHeight, strat: __CL_DEBUG.state.layout.strategy })`);
    await shot(cdp, 'desktop-windmill-cdp.png');
    await evaluate(cdp, `document.querySelector('#btnExample').click()`);
    await sleep(700);

    // 11 托 1200×1000：不叠放优先应为 1 组双层 + 9 个平放
    await evaluate(cdp, `(() => {
      __CL_DEBUG.state.pallets = [
        { id:'e11', name:'EUR2 1200×1000', code:'EUR2', l:1200, w:1000, h:1100, baseH:144, qty:11, weight:0, fill:false, color:0 }
      ];
      __CL_DEBUG.state.options.allowStack = true;
      __CL_DEBUG.state.options.preferSingle = true;
      __CL_DEBUG.calculate(false);
    })()`);
    await sleep(900);
    const least11 = await evaluate(cdp, `({ total: document.querySelector('#resultTotal').textContent, stacks: __CL_DEBUG.state.layout.stackCount, doubles: __CL_DEBUG.state.layout.placements.filter(p=>p.count===2).length, strategy: __CL_DEBUG.state.layout.strategy, badge: document.querySelector('#resultBadge').textContent })`);
    await shot(cdp, 'desktop-11-cdp.png');
    await evaluate(cdp, `document.querySelector('#btnExample').click()`);
    await sleep(700);

    // 多规格：最后添加的 SMALL 应靠近柜门
    await evaluate(cdp, `(() => {
      __CL_DEBUG.state.pallets = [
        { id:'eur8', name:'欧标 EUR', code:'EUR', l:1200, w:800, h:1100, baseH:144, qty:8, weight:0, fill:false, color:0 },
        { id:'sm2', name:'SMALL 1000×700', code:'SM', l:1000, w:700, h:1000, baseH:144, qty:2, weight:0, fill:false, color:1 }
      ];
      __CL_DEBUG.state.options.allowStack = true;
      __CL_DEBUG.state.options.preferSingle = true;
      __CL_DEBUG.calculate(false);
    })()`);
    await sleep(900);
    const multi = await evaluate(cdp, `(() => {
      const ps = __CL_DEBUG.state.layout.placements;
      const eurMax = Math.max(...ps.filter(p=>p.typeId==='eur8').map(p=>p.x+p.l));
      const smMin = Math.min(...ps.filter(p=>p.typeId==='sm2').map(p=>p.x));
      return { total: document.querySelector('#resultTotal').textContent, stacks: __CL_DEBUG.state.layout.stackCount, eurMax, smMin, door: __CL_DEBUG.state.layout.doorClearance };
    })()`);
    await shot(cdp, 'desktop-multi-cdp.png');
    await evaluate(cdp, `document.querySelector('#btnExample').click()`);
    await sleep(700);

    // 平板 / 窄桌面
    await metrics(cdp, 1024, 900, false);
    await sleep(500);
    await shot(cdp, 'tablet-cdp.png');
    const tablet = await evaluate(cdp, `({ doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth], workspace: (() => { const r=document.querySelector('.workspace').getBoundingClientRect(); return [r.width,r.height]; })(), result: document.querySelector('#panelResult').getBoundingClientRect().height })`);
    await evaluate(cdp, `window.scrollTo(0, 900)`);
    await sleep(300);
    await shot(cdp, 'tablet-result-cdp.png');
    await evaluate(cdp, `window.scrollTo(0, 0)`);
    await metrics(cdp, 1440, 960, false);
    await sleep(400);

    await metrics(cdp, 390, 844, true);
    await sleep(500);
    await evaluate(cdp, `document.body.setAttribute('data-mobile-tab','input'); window.dispatchEvent(new Event('resize'));`);
    await sleep(300);
    await shot(cdp, 'mobile-cdp.png');
    await evaluate(cdp, `document.querySelector('.tab[data-tab="view"]').click()`);
    await sleep(700);
    await shot(cdp, 'mobile-view-cdp.png');
    await evaluate(cdp, `document.querySelector('.tab[data-tab="result"]').click()`);
    await sleep(500);
    const mobileResult = await evaluate(cdp, `({
      tab: document.body.getAttribute('data-mobile-tab'),
      resultHidden: getComputedStyle(document.querySelector('#panelResult')).display === 'none',
      heroWidth: Math.round(document.querySelector('.result-hero').getBoundingClientRect().width),
      docWidth: document.documentElement.scrollWidth,
      actionsTop: Math.round(document.querySelector('#resultActions').getBoundingClientRect().top),
      printButton: !!document.querySelector('#btnPrint')
    })`);
    await evaluate(cdp, `document.querySelector('.tab[data-tab="input"]').click()`);
    await sleep(200);
    const mobile = await evaluate(cdp, `(() => ({
      inner: [innerWidth, innerHeight],
      doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
      body: [document.body.clientWidth, document.body.scrollWidth],
      panel: (() => { const r = document.querySelector('#panelInput').getBoundingClientRect(); return [r.left,r.width,r.right]; })(),
      tabs: (() => { const r = document.querySelector('#containerTabs').getBoundingClientRect(); return [r.left,r.width,r.right]; })(),
      dim: (() => { const r = document.querySelector('.dim-grid').getBoundingClientRect(); return [r.left,r.width,r.right]; })(),
      tabbar: (() => { const r = document.querySelector('.tabbar').getBoundingClientRect(); return [r.left,r.width,r.right]; })(),
      scroll: [document.documentElement.scrollWidth, document.body.scrollWidth]
    }))()`);

    // 打印媒体截图
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    await metrics(cdp, 1123, 794, false);
    await sleep(500);
    await shot(cdp, 'print-cdp.png');
    const print = await evaluate(cdp, `(() => ({
      rootDisplay: getComputedStyle(document.querySelector('#printRoot')).display,
      sheets: document.querySelectorAll('.print-sheet').length,
      svgs: document.querySelectorAll('.print-sheet svg').length,
      tableRows: document.querySelectorAll('.print-sheet tbody tr').length,
      printText: (document.querySelector('#printRoot').innerText || '').slice(0, 300)
    }))()`);

    const errors = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.text : e.params.entry.text);

    console.log('DESKTOP', JSON.stringify(desktop, null, 2));
    console.log('SELECTED', JSON.stringify(selected, null, 2));
    console.log('CAMERA', JSON.stringify({ before: cam0, orbit: camOrbit, pan: camPan, zoom: camZoom, reset: camReset }, null, 2));
    console.log('LAYER', JSON.stringify({ on: layerOn, off: layerOff }, null, 2));
    console.log('ROTATE_BUTTONS', JSON.stringify({ yaw0, yawCCW, stopped: [yawStopped1, yawStopped2], yawCW }, null, 2));
    console.log('40HQ', JSON.stringify(hq, null, 2));
    console.log('GAP20', JSON.stringify(gap, null, 2));
    console.log('ERROR_STATE', JSON.stringify(error, null, 2));
    console.log('CUSTOM', JSON.stringify(customState, null, 2), JSON.stringify(customResult, null, 2));
    console.log('PRESET_MANAGER', JSON.stringify({ before: presetBefore, after: presetAfter }, null, 2));
    console.log('DELETED', JSON.stringify(deleted, null, 2));
    console.log('FILL_TOGGLE', JSON.stringify({ off: fillOff, on: fillOn }, null, 2));
    console.log('PRIORITY', JSON.stringify({ stack: priorityStack, single: prioritySingle }, null, 2));
    console.log('MIXED', JSON.stringify(mixedResult, null, 2));
    console.log('WINDMILL', JSON.stringify(windmill, null, 2));
    console.log('LEAST11', JSON.stringify(least11, null, 2));
    console.log('MULTI', JSON.stringify(multi, null, 2));

    console.log('TABLET', JSON.stringify(tablet, null, 2));
    console.log('MOBILE', JSON.stringify(mobile, null, 2));
    console.log('MOBILE_RESULT', JSON.stringify(mobileResult, null, 2));
    console.log('PRINT', JSON.stringify(print, null, 2));
    console.log('CONSOLE_ERRORS', JSON.stringify(errors, null, 2));
  } finally {
    edge.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
