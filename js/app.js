/*!
 * Container Loader — 界面与交互
 */
(function () {
  'use strict';

  var DATA = window.CL_DATA;
  var SOLVER = window.CL_SOLVER;
  var PLAN = window.CL_PLAN;
  var SceneCtor = window.CL_SCENE.Scene;

  var STORAGE_KEY = 'container-loader.v1';
  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  var state = {
    containerId: '20GP',
    container: { l: 5898, w: 2352, h: 2393, payload: 28200 },
    pallets: [],
    options: { allowRotate: true, gap: 0, allowStack: true },
    showUpperLayer: true,
    layout: null,
    selectedSeq: null
  };

  var scene = null;
  var calcTimer = null;
  var saveTimer = null;
  var isSyncing = false;
  var lastUserCalc = false;

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function intVal(v, fallback) {
    var n = Math.round(Number(v));
    return isFinite(n) && n > 0 ? n : (fallback == null ? 0 : fallback);
  }
  function nonNeg(v, fallback) {
    var n = Math.round(Number(v));
    return isFinite(n) && n >= 0 ? n : (fallback == null ? 0 : fallback);
  }
  function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('zh-CN'); }
  function pct(n) { return (Math.max(0, Number(n) || 0) * 100).toFixed(1) + '%'; }
  function m2(n) { return ((Number(n) || 0) / 1e6).toFixed(2) + ' m²'; }
  function m3(n) { return ((Number(n) || 0) / 1e9).toFixed(1) + ' m³'; }
  function colorFor(index) { return DATA.colors[((index % DATA.colors.length) + DATA.colors.length) % DATA.colors.length]; }
  function layersFor(p) {
    if (!state.options.allowStack) return 1;
    return Math.max(1, Math.floor((Number(state.container.h) || 0) / (Number(p.h) || 1)));
  }
  function updateStackNote() {
    var maxLayers = 1;
    state.pallets.forEach(function (p) { maxLayers = Math.max(maxLayers, layersFor(p)); });
    var note = $('#stackNote');
    var hint = $('#stackHeadHint');
    if (hint) hint.textContent = state.options.allowStack ? '同规格叠放' : '单层';
    if (!note) return;
    if (state.options.allowStack) {
      note.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5 12 4l8 4.5-8 4.5zM4 12l8 4.5 8-4.5M4 15.5 12 20l8-4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
        '<span>同规格上下叠放，当前最高 <strong>' + maxLayers + ' 层</strong>；层数按柜内净高 ' + state.container.h + 'mm 自动计算，不同规格不混叠。</span>';
    } else {
      note.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5 12 4l8 4.5-8 4.5zM4 12l8 4.5 8-4.5M4 15.5 12 20l8-4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
        '<span>按<strong>单层、不叠放</strong>计算。高度用于 3D、净高与载重校验。</span>';
    }
  }
  function uid(prefix) { return (prefix || 'p') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); }

  function toast(message, ms) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.classList.remove('show'); }, ms || 2200);
  }

  /* ------------------------------------------------------------------ */
  /* 初始化数据                                                          */
  /* ------------------------------------------------------------------ */
  function sanitizePallets(pallets) {
    if (!Array.isArray(pallets) || !pallets.length) return null;
    var out = [];
    pallets.forEach(function (p, i) {
      if (!p) return;
      var l = intVal(p.l, 0), w = intVal(p.w, 0), h = intVal(p.h, 0);
      if (!l || !w || !h) return;
      out.push({
        id: String(p.id || uid('p')),
        name: String(p.name || ('托盘 ' + l + '×' + w)),
        code: String(p.code || (l + '×' + w)),
        l: l, w: w, h: h,
        baseH: Math.min(nonNeg(p.baseH, 144), h),
        qty: Math.max(0, Math.round(Number(p.qty) || 0)),
        weight: Math.max(0, Number(p.weight) || 0),
        fill: !!p.fill,
        color: Number.isFinite(Number(p.color)) ? Number(p.color) % DATA.colors.length : i % DATA.colors.length
      });
    });
    return out.length ? out : null;
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      if (!saved || saved.version !== DATA.version) return false;
      var pallets = sanitizePallets(saved.pallets);
      if (!pallets) return false;
      state.containerId = saved.containerId || '20GP';
      state.container = {
        l: intVal(saved.container && saved.container.l, 5898),
        w: intVal(saved.container && saved.container.w, 2352),
        h: intVal(saved.container && saved.container.h, 2393),
        payload: Math.max(0, Math.round(Number(saved.container && saved.container.payload) || 0))
      };
      state.pallets = pallets;
      state.options.allowRotate = saved.options ? saved.options.allowRotate !== false : true;
      state.options.allowStack = saved.options ? saved.options.allowStack !== false : true;
      state.options.gap = Math.max(0, Math.round(Number(saved.options && saved.options.gap) || 0));
      return true;
    } catch (e) {
      return false;
    }
  }

  function setExample() {
    var ex = clone(DATA.example);
    state.containerId = ex.containerId;
    state.container = ex.container;
    state.pallets = ex.pallets;
    state.options = ex.options;
    state.selectedSeq = null;
    state.layout = null;
    saveState();
    syncInputs();
    renderPalletList();
    renderPresetSelect();
    calculate(false);
    toast('已恢复示例：20GP · 8 托必装 + 1120 补柜');
  }

  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          version: DATA.version,
          containerId: state.containerId,
          container: state.container,
          pallets: state.pallets,
          options: state.options
        }));
      } catch (e) { /* 本地存储不可用时忽略 */ }
    }, 180);
  }

  /* ------------------------------------------------------------------ */
  /* 柜型 UI                                                             */
  /* ------------------------------------------------------------------ */
  function buildContainerSelect() {
    var select = $('#containerSelect');
    var html = '<option value="CUSTOM">自定义尺寸</option>';
    var groups = [
      { label: '标准柜 / 高柜', ids: ['20GP', '40GP', '40HQ', '45HQ'] },
      { label: '冷柜 / 开顶柜', ids: ['20RF', '40RF', '20OT', '40OT'] }
    ];
    groups.forEach(function (g) {
      html += '<optgroup label="' + g.label + '">';
      g.ids.forEach(function (id) {
        var c = DATA.getContainer(id);
        if (c) html += '<option value="' + c.id + '">' + esc(c.code + ' · ' + c.name) + '</option>';
      });
      html += '</optgroup>';
    });
    select.innerHTML = html;
  }

  function containerMeta() {
    var known = DATA.getContainer(state.containerId);
    var c = state.container;
    var volume = (c.l * c.w * c.h) / 1e9;
    $('#containerVolume').textContent = '柜内容积 ' + volume.toFixed(1) + ' m³';
    $('#containerDoor').textContent = known ? ('门宽 ' + known.doorW + ' × 门高 ' + known.doorH) : '自定义尺寸';
    $('#containerNote').textContent = known ? known.note : '自定义内尺寸：请按实际箱门铭牌或船公司数据填写。';
    $$('#containerTabs button').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-container') === state.containerId);
    });
  }

  function syncInputs() {
    isSyncing = true;
    var c = state.container;
    $('#cL').value = c.l;
    $('#cW').value = c.w;
    $('#cH').value = c.h;
    $('#cPayload').value = c.payload;
    $('#allowRotate').checked = !!state.options.allowRotate;
    $('#allowStack').checked = !!state.options.allowStack;
    $('#gapInput').value = state.options.gap;
    $('#containerSelect').value = DATA.getContainer(state.containerId) ? state.containerId : 'CUSTOM';
    containerMeta();
    updateStackNote();
    isSyncing = false;
  }

  function applyContainer(id, silent) {
    var preset = DATA.getContainer(id);
    if (!preset) return;
    state.containerId = preset.id;
    state.container = { l: preset.l, w: preset.w, h: preset.h, payload: preset.payload };
    syncInputs();
    saveState();
    if (!silent) calculate(false);
  }

  function markCustom() {
    if (state.containerId !== 'CUSTOM') {
      state.containerId = 'CUSTOM';
      containerMeta();
      $('#containerSelect').value = 'CUSTOM';
      $$('#containerTabs button').forEach(function (b) { b.classList.remove('active'); });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 托盘 UI                                                             */
  /* ------------------------------------------------------------------ */
  function buildPresetSelect() {
    var select = $('#presetSelect');
    var html = '<option value="">从常用规格添加…</option>';
    DATA.palletPresets.forEach(function (p) {
      html += '<option value="' + p.id + '">' + esc(p.name + ' · ' + p.l + '×' + p.w + '×' + p.h) + '</option>';
    });
    select.innerHTML = html;
  }

  function renderPresetSelect() {
    // 预留：如果以后需要按当前柜型筛选预设，可在这里处理。
  }

  function palletHTML(p, index) {
    var color = colorFor(p.color);
    var isFill = !!p.fill;
    var layers = layersFor(p);
    var layerTag = layers > 1 ? (' · ' + layers + '层') : '';
    return '' +
      '<div class="pallet-card' + (isFill ? ' is-fill' : '') + '" data-id="' + esc(p.id) + '">' +
        '<div class="pallet-card-head">' +
          '<span class="pallet-dot" style="background:' + color.solid + '"></span>' +
          '<input class="pallet-name" data-field="name" value="' + esc(p.name) + '" placeholder="托盘名称" aria-label="托盘名称">' +
          '<button class="fill-toggle' + (isFill ? ' active' : '') + '" type="button" data-action="toggle-fill" aria-pressed="' + (isFill ? 'true' : 'false') + '" title="' + (isFill ? '再点一次取消补柜，改为按实际数量填写' : '点按后计算该规格最多能补多少托') + '">' +
            '<i></i>补柜' +
          '</button>' +
          '<button class="pallet-remove" type="button" title="删除托盘" aria-label="删除托盘">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12M10 10v6M14 10v6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="pallet-dims">' +
          '<label><span>长 mm</span><input type="number" inputmode="numeric" min="1" step="1" data-field="l" value="' + p.l + '"></label>' +
          '<label><span>宽 mm</span><input type="number" inputmode="numeric" min="1" step="1" data-field="w" value="' + p.w + '"></label>' +
          '<label><span>总高 mm</span><input type="number" inputmode="numeric" min="1" step="1" data-field="h" value="' + p.h + '"></label>' +
        '</div>' +
        '<div class="pallet-foot">' +
          (isFill
            ? '<span class="pallet-qty fill-qty">尽量多装</span>'
            : '<label class="pallet-qty">数量 <input type="number" inputmode="numeric" min="1" step="1" data-field="qty" value="' + p.qty + '"></label>') +
          '<label class="pallet-weight">单托重 <input type="number" inputmode="numeric" min="0" step="10" data-field="weight" value="' + (p.weight || 0) + '"> kg</label>' +
          '<span class="pallet-tag">' + (isFill ? '补柜规格' : '必装') + layerTag + '</span>' +
        '</div>' +
      '</div>';
  }

  function renderPalletList() {
    var list = $('#palletList');
    list.innerHTML = state.pallets.map(palletHTML).join('');
    updateStackNote();
  }

  function updatePalletFromCard(card, field, value) {
    var id = card.getAttribute('data-id');
    var p = state.pallets.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    if (field === 'name') {
      p.name = String(value).slice(0, 40) || ('托盘 ' + p.l + '×' + p.w);
    } else if (field === 'l' || field === 'w' || field === 'h') {
      var n = intVal(value, field === 'h' ? 1100 : 1200);
      p[field] = Math.max(1, n);
      if (p.baseH > p.h) p.baseH = p.h;
    } else if (field === 'qty') {
      p.qty = Math.max(1, Math.round(Number(value) || 1));
    } else if (field === 'weight') {
      p.weight = Math.max(0, Math.round(Number(value) || 0));
    }
    if (!p.fill && !p.qty) p.qty = 1;
    if (field === 'h') {
      var layers = layersFor(p);
      var tag = card.querySelector('.pallet-tag');
      if (tag) tag.textContent = (p.fill ? '补柜规格' : '必装') + (layers > 1 ? ' · ' + layers + '层' : '');
      updateStackNote();
    }
    saveState();
  }

  function addPallet(source) {
    var base = source ? clone(source) : {
      name: '自定义托盘', code: 'CUSTOM', l: 1200, w: 800, h: 1100, baseH: 144, qty: 1, weight: 0
    };
    var used = state.pallets.map(function (p) { return p.color; });
    var color = 0;
    for (var i = 0; i < DATA.colors.length; i++) {
      if (used.indexOf(i) === -1) { color = i; break; }
      color = (i + 1) % DATA.colors.length;
    }
    state.pallets.push({
      id: uid('p'),
      name: base.name || ('托盘 ' + base.l + '×' + base.w),
      code: base.code || (base.l + '×' + base.w),
      l: intVal(base.l, 1200),
      w: intVal(base.w, 800),
      h: intVal(base.h, 1100),
      baseH: Math.min(nonNeg(base.baseH, 144), intVal(base.h, 1100)),
      qty: Math.max(1, intVal(base.qty, 1)),
      weight: Math.max(0, Number(base.weight) || 0),
      fill: false,
      color: color
    });
    renderPalletList();
    renderPresetSelect();
    saveState();
    calculate(false);
    if (!source) {
      setTimeout(function () {
        var cards = $$('.pallet-card');
        var card = cards[cards.length - 1];
        var input = card && $('.pallet-name', card);
        if (input) { input.focus(); input.select(); }
      }, 60);
    }
    toast(source ? ('已添加：' + state.pallets[state.pallets.length - 1].name) : '已添加自定义托盘，可直接修改名称和尺寸');
  }

  function removePallet(id) {
    if (state.pallets.length <= 1) {
      toast('至少保留一种托盘规格');
      return;
    }
    state.pallets = state.pallets.filter(function (p) { return p.id !== id; });
    renderPalletList();
    saveState();
    calculate(false);
  }

  function toggleFill(id) {
    var p = state.pallets.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    if (p.fill) {
      p.fill = false;
      if (!p.qty) p.qty = 1;
    } else {
      state.pallets.forEach(function (q) {
        if (q.fill) {
          q.fill = false;
          if (!q.qty) q.qty = 1;
        }
      });
      p.fill = true;
      if (!p.qty) p.qty = 1;
    }
    renderPalletList();
    saveState();
    calculate(false);
    if (p.fill) toast('已切换为补柜：计算该规格最多能装多少托');
    else toast('已取消补柜：这一行改为按实际数量填写');
  }

  /* ------------------------------------------------------------------ */
  /* 计算                                                                */
  /* ------------------------------------------------------------------ */
  function paintState() {
    // 程序性更新 UI 时不触发 input 事件，这里保留一个明确的同步点。
    syncInputs();
  }

  function currentContainer() {
    var known = DATA.getContainer(state.containerId);
    return {
      id: state.containerId,
      code: known ? known.code : 'CUSTOM',
      name: known ? known.name : '自定义柜型',
      l: state.container.l,
      w: state.container.w,
      h: state.container.h,
      payload: state.container.payload
    };
  }

  function enrich(result) {
    if (!result || !result.ok) return result;
    var byId = {};
    var typeById = {};
    state.pallets.forEach(function (p) {
      var c = colorFor(p.color);
      byId[p.id] = c;
      typeById[p.id] = p;
    });
    result.placements.forEach(function (p) {
      var c = byId[p.typeId] || DATA.colors[0];
      p.solid = c.solid;
      p.light = c.light;
      p.dark = c.dark;
      var t = typeById[p.typeId];
      if (t) {
        p.originalL = t.l;
        p.originalW = t.w;
        p.originalH = t.h;
      }
    });
    result.types = state.pallets.map(function (p) {
      var c = colorFor(p.color);
      return Object.assign({}, p, { solid: c.solid, light: c.light, dark: c.dark });
    });
    return result;
  }

  function calculate(userTriggered) {
    clearTimeout(calcTimer);
    updateStackNote();
    var c = currentContainer();
    var res;
    try {
      res = SOLVER.solve(c, state.pallets, state.options);
    } catch (e) {
      console.error(e);
      res = { ok: false, error: '计算出现异常，请检查托盘尺寸。' };
    }
    state.layout = enrich(res);
    state.selectedSeq = null;
    if (scene) scene.setSelected(null);
    renderScene();
    renderResult();
    updateStageCopy();
    buildPrint();
    lastUserCalc = !!userTriggered;
    if (userTriggered && window.matchMedia && window.matchMedia('(max-width: 980px)').matches) {
      setMobileTab('result');
    }
    if (res.ok) {
      $('#inputHint').textContent = '已计算：' + res.totalCount + ' 托 / ' + res.stackCount + ' 垛 · 地面利用率 ' + pct(res.floorUtil) + '。';
    } else {
      $('#inputHint').textContent = res.error || '无法排入，请调整参数。';
    }
  }

  function scheduleCalc() {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(function () { calculate(false); }, 260);
  }

  /* ------------------------------------------------------------------ */
  /* 3D                                                                  */
  /* ------------------------------------------------------------------ */
  function updateLayerToggle(res) {
    var input = $('#doubleLayer');
    var label = $('#layerToggle span');
    if (!input) return;
    var maxCount = 1;
    if (res && res.ok) {
      res.placements.forEach(function (p) { maxCount = Math.max(maxCount, p.count || 1); });
    }
    var hasUpper = maxCount > 1;
    input.disabled = !hasUpper;
    input.checked = hasUpper ? !!state.showUpperLayer : true;
    if (label) label.textContent = hasUpper ? '双层' : '单层';
    if (scene) scene.setShowUpper(!hasUpper || state.showUpperLayer);
  }

  function renderScene() {
    if (!scene) return;
    var c = currentContainer();
    var res = state.layout;
    var placements = res && res.ok ? res.placements : [];
    scene.setModel({
      L: c.l, W: c.w, H: c.h,
      placements: placements
    });
    updateLayerToggle(res);
    var empty = $('#sceneEmpty');
    if (empty) {
      empty.hidden = !!(res && res.ok);
      if (res && !res.ok) {
        empty.querySelector('b').textContent = '当前组合装不下';
        empty.querySelector('span').textContent = '调整柜型、数量或托盘尺寸后重新计算。';
      } else if (!res) {
        empty.querySelector('b').textContent = '还没有装载方案';
        empty.querySelector('span').textContent = '填写柜型和托盘后，点“计算装载方案”。';
      }
    }
    renderLegend();
    hideSelection();
  }

  function renderLegend() {
    var res = state.layout;
    var el = $('#stageLegend');
    if (!res || !res.ok) { el.innerHTML = ''; return; }
    var counts = res.typeCounts || {};
    el.innerHTML = state.pallets.filter(function (p) { return counts[p.id]; }).map(function (p) {
      var c = colorFor(p.color);
      return '<span class="legend-item"><i class="legend-swatch" style="background:' + c.solid + '"></i><b>' + esc(p.code) + '</b> ' + counts[p.id] + ' 托</span>';
    }).join('');
  }

  function hideSelection() {
    var el = $('#stageSelection');
    if (el) el.hidden = true;
    if (scene) scene.setSelected(null);
    state.selectedSeq = null;
  }

  function showSelection(seq) {
    if (!seq || !state.layout || !state.layout.ok) { hideSelection(); return; }
    var p = state.layout.placements.filter(function (x) { return x.seq === seq; })[0];
    if (!p) { hideSelection(); return; }
    state.selectedSeq = seq;
    scene.setSelected(seq);
    var c = colorFor(p.color);
    $('#selectionDot').style.background = c.solid;
    $('#selectionTitle').textContent = 'P' + String(p.seq).padStart(2, '0') + ' · ' + p.name;
    var origL = p.originalL || p.l, origW = p.originalW || p.w, origH = p.originalH || p.h;
    $('#selectionSub').textContent = origL + '×' + origW + '×' + origH + ' mm' +
      (p.rotated ? ' · 旋转90°' : '') + (p.count > 1 ? ' · ' + p.count + '层 / 垛高 ' + p.stackHeight + 'mm' : '') + ' · ' + (p.fill ? '补柜' : '必装') + ' · 侧边距 ' + Math.round(p.y) + ' mm';
    $('#stageSelection').hidden = false;
  }

  function updateStageCopy() {
    var c = currentContainer();
    var res = state.layout;
    var title = c.code + ' · 装柜预览';
    var badge = '等待计算';
    if (res && res.ok) {
      title = c.code + ' · ' + res.totalCount + ' 托 · ' + res.stackCount + ' 垛';
      badge = res.totalCount + ' 托 · ' + res.stackCount + ' 垛 · 地面 ' + pct(res.floorUtil);
      if (res.clearanceWarnings && res.clearanceWarnings.length) badge += ' · ⚠ ' + res.clearanceWarnings.length;
      $('#footFloor').textContent = pct(res.floorUtil);
      $('#footFloorBar').style.width = Math.min(100, res.floorUtil * 100).toFixed(1) + '%';
      $('#footVolume').textContent = pct(res.volumeUtil);
      $('#footVolumeBar').style.width = Math.min(100, res.volumeUtil * 100).toFixed(1) + '%';
      $('#footWeight').textContent = res.weightKnown ? fmt(res.totalWeight) + ' kg' : '未填写';
      $('#footFree').textContent = m2(res.floorArea - res.floorUsed);
      var cm = scene && scene._cargoMetrics ? scene._cargoMetrics() : null;
      $('#sceneDims').innerHTML = '柜内 ' + c.l + ' × ' + c.w + ' × ' + c.h + ' mm<br>' +
        (cm ? ('实装 ' + Math.round(cm.length) + ' × ' + Math.round(cm.width) + ' mm · ') : '') +
        '最高垛 ' + res.maxHeight + ' mm';
    } else {
      $('#footFloor').textContent = '—';
      $('#footFloorBar').style.width = '0%';
      $('#footVolume').textContent = '—';
      $('#footVolumeBar').style.width = '0%';
      $('#footWeight').textContent = '—';
      $('#footFree').textContent = '—';
      $('#sceneDims').innerHTML = '柜内 ' + c.l + ' × ' + c.w + ' × ' + c.h + ' mm';
      if (res && !res.ok) badge = '无法装柜';
    }
    $('#stageTitle').textContent = title;
    $('#sceneBadge').textContent = badge;
  }

  /* ------------------------------------------------------------------ */
  /* 结果面板                                                            */
  /* ------------------------------------------------------------------ */
  function renderResult() {
    var res = state.layout;
    var c = currentContainer();
    $('#resultContainer').textContent = c.code;

    if (!res || !res.ok) {
      $('#resultTotal').textContent = '—';
      $('#resultSub').textContent = res ? '当前组合装不下' : '等待计算';
      $('#resultRequired').textContent = '—';
      $('#resultFill').textContent = '—';
      $('#resultUtil').textContent = '—';
      $('#resultFillItem').hidden = true;
      $('#resultSplit').classList.add('no-fill');
      $('#clearanceAlert').hidden = true;
      $('#resultError').hidden = false;
      $('#errorTitle').textContent = '装不下';
      $('#errorText').textContent = (res && res.error) || '请填写柜型和托盘后计算。';
      var list = (res && res.suggestions) || [];
      $('#errorList').innerHTML = list.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
      $('#resultMain').hidden = true;
      $('#resultTypes').hidden = true;
      $('#resultNotes').hidden = true;
      $('#resultActions').hidden = true;
      return;
    }

    $('#resultError').hidden = true;
    $('#resultMain').hidden = false;
    $('#resultTypes').hidden = false;
    $('#resultNotes').hidden = false;
    $('#resultActions').hidden = false;

    $('#resultTotal').textContent = res.totalCount;
    var fillName = res.fillType ? res.fillType.name : '';
    $('#resultSub').textContent = res.requiredCount + ' 托必装 · ' +
      (res.fillType ? ('补柜 +' + res.fillCount + ' 托 · ') : '') +
      res.stackCount + ' 个垛位' + (fillName ? ' · ' + fillName : '');
    $('#resultRequired').textContent = res.requiredCount;
    $('#resultFill').textContent = res.fillType ? '+' + res.fillCount : '—';
    $('#resultUtil').textContent = pct(res.floorUtil);
    $('#resultFillItem').hidden = !res.fillType;
    $('#resultSplit').classList.toggle('no-fill', !res.fillType);
    var clearance = res.clearanceWarnings || [];
    $('#clearanceAlert').hidden = clearance.length === 0;
    $('#clearanceCount').textContent = clearance.length ? (clearance.length + ' 项需复核') : '';
    $('#clearanceList').innerHTML = clearance.map(function (w) { return '<li>' + esc(w.text) + '</li>'; }).join('');

    var badge = res.optimalByArea ? '达到面积上限' : (res.fillType ? '条带搜索方案' : '叠放排布');
    $('#resultBadge').textContent = badge;
    $('#resultBadge').classList.toggle('warn', !res.optimalByArea && !!res.fillType);

    var verdict;
    if (res.fillType) {
      verdict = '<strong>' + res.requiredCount + ' 托必装全部装入</strong>；补柜规格 ' + esc(fillName) + ' 还能加 <strong>' + res.fillCount + ' 托</strong>，总装载 <strong>' + res.totalCount + ' 托</strong>（' + res.stackCount + ' 个垛位）。';
      if (res.optimalByArea) verdict += ' 补柜数量已达到按柜底面积计算的理论上限。';
    } else {
      verdict = '<strong>' + res.requiredCount + ' 托必装全部装入</strong>，共 ' + res.stackCount + ' 个垛位' + (res.allowStack ? '（同规格叠放）' : '') + '。';
    }
    $('#verdict').innerHTML = verdict;

    $('#statVolume').textContent = m3(res.volume);
    $('#statFloor').textContent = m2(res.floorUsed) + ' / ' + m2(res.floorArea);
    $('#statWeight').textContent = res.weightKnown ? fmt(res.totalWeight) + ' kg' : '未填写';
    $('#statHeight').textContent = res.maxHeight + ' / ' + c.h + ' mm';

    renderTypeList();
    renderNotes();
  }

  function renderTypeList() {
    var res = state.layout;
    if (!res || !res.ok) { $('#typeList').innerHTML = ''; return; }
    var counts = res.typeCounts || {};
    var rows = [];
    state.pallets.forEach(function (p) {
      var count = counts[p.id] || 0;
      if (!count) return;
      var c = colorFor(p.color);
      var stacks = (res.stackCounts && res.stackCounts[p.id]) || 0;
      var layers = layersFor(p);
      rows.push('' +
        '<div class="type-row' + (p.fill ? ' fill' : '') + '">' +
          '<span class="type-swatch" style="background:' + c.solid + '"></span>' +
          '<div class="type-info"><b>' + esc(p.name) + '</b><span>' + p.l + '×' + p.w + '×' + p.h + ' mm · ' + (p.fill ? '补柜规格' : '必装') + ' · ' + stacks + ' 垛' + (layers > 1 ? ' × ' + layers + ' 层' : ' · 单层') + '</span></div>' +
          '<div class="type-count"><b>' + count + '</b><span>托</span></div>' +
        '</div>');
    });
    $('#typeList').innerHTML = rows.join('') || '<p class="micro">暂无装载明细。</p>';
    $('#typeCount').textContent = state.pallets.filter(function (p) { return counts[p.id]; }).length + ' 种规格';
  }

  function renderNotes() {
    var res = state.layout;
    var c = currentContainer();
    if (!res || !res.ok) { $('#layoutNotes').innerHTML = ''; return; }
    var notes = [];
    if (res.allowStack) {
      var maxLayers = 1;
      state.pallets.forEach(function (p) { maxLayers = Math.max(maxLayers, layersFor(p)); });
      notes.push('按<strong>同规格垂直叠放</strong>计算，最高 <strong>' + maxLayers + ' 层</strong>；不同规格不混叠，层数由柜内净高自动确定。');
    }
    if (res.fillType) {
      if (res.optimalByArea) {
        notes.push('补柜 <strong>' + res.fillCount + ' 托</strong> 已达到面积理论上限；在当前叠放模型下，数量已经最优。');
      } else {
        notes.push('补柜 <strong>' + res.fillCount + ' 托</strong>；按面积估算的上限为 ' + res.fillUpperBound + ' 托，受柜底长宽组合限制，实际可能低于该上限。');
      }
    }
    notes.push('共 <strong>' + res.stackCount + ' 个垛位</strong>，必装 ' + res.requiredStacks + ' 垛 + 补柜 ' + res.fillStacks + ' 垛。');
    var cm = scene && scene._cargoMetrics ? scene._cargoMetrics() : null;
    if (cm) {
      var env = '实际装载包络 <strong>' + Math.round(cm.length) + ' × ' + Math.round(cm.width) + ' mm</strong>';
      if (cm.sideDiff) env += '；两侧长度分别为 ' + Math.round(cm.lowerLen) + ' / ' + Math.round(cm.upperLen) + ' mm';
      if (cm.endDiff) env += '；柜门端宽 ' + Math.round(cm.doorW) + ' / 柜尾端宽 ' + Math.round(cm.farW) + ' mm';
      notes.push(env + '。');
    }
    var rotated = res.placements.filter(function (p) { return p.rotated; }).length;
    if (rotated) notes.push('有 <strong>' + rotated + ' 个垛位</strong> 旋转 90° 摆放，以利用柜宽或柜长方向的空间。');
    notes.push('最高垛 <strong>' + res.maxHeight + ' mm</strong>，柜内净高 ' + c.h + ' mm；顶部余高 ' + Math.max(0, c.h - res.maxHeight) + ' mm。');
    notes.push('已用柜底 <strong>' + m2(res.floorUsed) + '</strong>，剩余 <strong>' + m2(res.floorArea - res.floorUsed) + '</strong>；地面利用率 ' + pct(res.floorUtil) + '。');
    if (res.stripCount === 2) {
      var groups = { A: [], B: [] };
      res.placements.forEach(function (p) { if (groups[p.strip]) groups[p.strip].push(p); });
      var parts = [];
      ['A', 'B'].forEach(function (key) {
        var arr = groups[key];
        if (!arr.length) return;
        var minY = Infinity, maxY = 0;
        var byCode = {};
        arr.forEach(function (p) {
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y + p.w);
          byCode[p.code] = (byCode[p.code] || 0) + p.count;
        });
        var segs = Object.keys(byCode).map(function (code) {
          return byCode[code] + ' 托 ' + code;
        }).join(' + ');
        parts.push(key + ' 区（柜宽 ' + Math.round(minY) + '–' + Math.round(maxY) + 'mm）' + segs);
      });
      if (parts.length) notes.push('本次采用上下两条长条分区：<strong>' + parts.join('；') + '</strong>。同规格集中放置，便于叉车从柜门顺序推进。');
    }
    if (res.gap > 0) notes.push('计算时每个托盘四周已预留 <strong>' + res.gap + ' mm</strong> 间隙。');
    if (res.timedOut) notes.push('规格较多，已在约 1.2 秒内返回当前最佳方案；如需更充分搜索，可减少规格或数量后重算。');
    (res.warnings || []).forEach(function (w) {
      if (res.allowStack && w.indexOf('按同规格垂直叠放计算') === 0) return;
      notes.push('<strong>注意：</strong>' + esc(w));
    });
    if (res.weightKnown && res.payload) {
      notes.push('总重 <strong>' + fmt(res.totalWeight) + ' kg</strong>，箱型载重 ' + fmt(res.payload) + ' kg' + (res.totalWeight > res.payload ? '，已超重。' : '，未超重。'));
    }
    $('#layoutNotes').innerHTML = notes.map(function (n) { return '<li>' + n + '</li>'; }).join('');
  }

  /* ------------------------------------------------------------------ */
  /* 打印 / 导出                                                         */
  /* ------------------------------------------------------------------ */
  function buildPrint() {
    var res = state.layout;
    var root = $('#printRoot');
    if (!res || !res.ok) {
      root.innerHTML = '';
      return;
    }
    root.innerHTML = PLAN.buildPrintHTML(res, {
      types: res.types || state.pallets.map(function (p) { return Object.assign({}, p, { solid: colorFor(p.color).solid }); })
    });
  }

  function printNow() {
    if (!state.layout || !state.layout.ok) {
      toast('当前没有可打印的装载方案');
      return;
    }
    buildPrint();
    setTimeout(function () { window.print(); }, 60);
  }

  function exportJSON() {
    var res = state.layout;
    if (!res || !res.ok) { toast('当前没有可导出的方案'); return; }
    var payload = {
      app: 'Container Loader',
      version: DATA.version,
      exportedAt: new Date().toISOString(),
      container: currentContainer(),
      pallets: state.pallets,
      options: state.options,
      result: {
        requiredCount: res.requiredCount,
        fillCount: res.fillCount,
        totalCount: res.totalCount,
        stackCount: res.stackCount,
        fillUpperBound: res.fillUpperBound,
        optimalByArea: res.optimalByArea,
        allowStack: res.allowStack,
        floorUtil: res.floorUtil,
        volumeUtil: res.volumeUtil,
        totalWeight: res.totalWeight,
        placements: res.placements.map(function (p) {
          return {
            seq: p.seq, typeId: p.typeId, name: p.name, code: p.code,
            x: Math.round(p.x), y: Math.round(p.y), z: p.z,
            l: p.l, w: p.w, h: p.h, count: p.count, stackHeight: p.stackHeight,
            fill: p.fill, rotated: p.rotated
          };
        })
      }
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'container-loader-' + currentContainer().code + '-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('方案 JSON 已导出');
  }

  /* ------------------------------------------------------------------ */
  /* 移动端 Tab                                                          */
  /* ------------------------------------------------------------------ */
  function setMobileTab(tab) {
    document.body.setAttribute('data-mobile-tab', tab);
    $$('.tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
    if (tab === 'view') {
      requestAnimationFrame(function () {
        if (scene) { scene.resize(); scene.requestRender(); }
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    // 柜型
    $$('#containerTabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyContainer(btn.getAttribute('data-container'));
      });
    });
    $('#containerSelect').addEventListener('change', function (e) {
      var v = e.target.value;
      if (v === 'CUSTOM') {
        markCustom();
        saveState();
        scheduleCalc();
        return;
      }
      applyContainer(v);
    });
    ['cL', 'cW', 'cH', 'cPayload'].forEach(function (id) {
      $('#' + id).addEventListener('input', function (e) {
        if (isSyncing) return;
        var v = Math.max(0, Math.round(Number(e.target.value) || 0));
        if (id === 'cPayload') {
          state.container.payload = v;
        } else {
          state.container[id === 'cL' ? 'l' : id === 'cW' ? 'w' : 'h'] = Math.max(1, v);
          markCustom();
          updateStackNote();
        }
        saveState();
        scheduleCalc();
      });
    });
    $('#btnResetContainer').addEventListener('click', function () {
      var id = DATA.getContainer(state.containerId) ? state.containerId : '20GP';
      applyContainer(id);
      toast('已恢复 ' + id + ' 标准内尺寸');
    });

    // 托盘列表
    $('#palletList').addEventListener('input', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var field = el.getAttribute('data-field');
      if (!field) return;
      var card = el.closest('.pallet-card');
      if (!card) return;
      updatePalletFromCard(card, field, el.value);
      if (field === 'l' || field === 'w' || field === 'h' || field === 'qty' || field === 'weight') {
        // 不在输入过程中重建列表，避免光标丢失；计算结果会更新右侧。
        scheduleCalc();
      }
    });
    $('#palletList').addEventListener('change', function (e) {
      var el = e.target;
      if (el && el.getAttribute && el.getAttribute('data-field') === 'name') {
        var card = el.closest('.pallet-card');
        if (card) updatePalletFromCard(card, 'name', el.value);
        scheduleCalc();
      }
    });
    $('#palletList').addEventListener('click', function (e) {
      var fillBtn = e.target.closest('.fill-toggle');
      if (fillBtn) {
        var fillCard = e.target.closest('.pallet-card');
        if (fillCard) toggleFill(fillCard.getAttribute('data-id'));
        return;
      }
      var btn = e.target.closest('.pallet-remove');
      if (!btn) return;
      var card = e.target.closest('.pallet-card');
      if (card) removePallet(card.getAttribute('data-id'));
    });
    $('#btnAddPreset').addEventListener('click', function () {
      var id = $('#presetSelect').value;
      if (!id) { toast('先选择一个常用托盘规格'); return; }
      var preset = DATA.palletPresets.filter(function (p) { return p.id === id; })[0];
      if (preset) addPallet(preset);
      $('#presetSelect').value = '';
    });
    $('#btnAddCustom').addEventListener('click', function () { addPallet(null); });

    // 参数
    $('#allowRotate').addEventListener('change', function (e) {
      state.options.allowRotate = !!e.target.checked;
      saveState();
      calculate(false);
    });
    $('#allowStack').addEventListener('change', function (e) {
      state.options.allowStack = !!e.target.checked;
      renderPalletList();
      saveState();
      calculate(false);
    });
    $('#gapInput').addEventListener('input', function (e) {
      state.options.gap = Math.max(0, Math.min(200, Math.round(Number(e.target.value) || 0)));
      saveState();
      scheduleCalc();
    });

    // 计算 / 示例 / 打印
    $('#btnCalc').addEventListener('click', function () { calculate(true); });
    $('#btnCalcTop').addEventListener('click', function () { calculate(true); });
    $('#btnExample').addEventListener('click', setExample);
    $('#btnPrint').addEventListener('click', printNow);
    $('#btnPrintTop').addEventListener('click', printNow);
    $('#btnExport').addEventListener('click', exportJSON);
    window.addEventListener('beforeprint', buildPrint);

    // 3D 视角
    $$('#viewSeg button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var v = btn.getAttribute('data-view');
        if (scene) scene.setView(v);
      });
    });
    $('#btnResetView').addEventListener('click', function () {
      if (scene) scene.resetCamera();
    });
    $('#btnRotateCCW').addEventListener('click', function () {
      if (scene) scene.rotateBy(-Math.PI / 12);
    });
    $('#btnRotateCW').addEventListener('click', function () {
      if (scene) scene.rotateBy(Math.PI / 12);
    });
    $('#doubleLayer').addEventListener('change', function (e) {
      state.showUpperLayer = !!e.target.checked;
      if (scene) scene.setShowUpper(state.showUpperLayer);
    });

    // 选中托盘
    $('#selectionClose').addEventListener('click', hideSelection);
    $('#stageWrap').addEventListener('click', function (e) {
      if (e.target && e.target.id === 'scene') {
        // 点空白取消选择由 canvas 的 onSelect(null) 处理，这里不重复。
      }
    });

    // 移动端 Tab
    $$('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () { setMobileTab(btn.getAttribute('data-tab')); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideSelection();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */
  function initScene() {
    var canvas = $('#scene');
    scene = new SceneCtor(canvas);
    scene.onSelect = function (seq) {
      if (seq == null) hideSelection();
      else showSelection(seq);
    };
    scene.onViewChange = function (view) {
      $$('#viewSeg button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === view);
      });
    };
  }

  function init() {
    buildContainerSelect();
    buildPresetSelect();
    if (!loadState()) {
      var ex = clone(DATA.example);
      state.containerId = ex.containerId;
      state.container = ex.container;
      state.pallets = ex.pallets;
      state.options = ex.options;
    }
    syncInputs();
    renderPalletList();
    initScene();
    bindEvents();
    calculate(false);
    // 调试/自动化测试入口（不影响正常使用）
    window.__CL_DEBUG = {
      state: state,
      get scene() { return scene; },
      calculate: calculate,
      setMobileTab: setMobileTab
    };
    // 确保首次渲染后 3D 尺寸正确
    setTimeout(function () { if (scene) { scene.resize(); scene.requestRender(); } }, 80);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
