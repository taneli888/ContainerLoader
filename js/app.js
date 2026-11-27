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
    customPresets: [],
    options: { allowRotate: true, gap: 0, allowStack: true, preferSingle: true, doorGap: 0 },
    showUpperLayer: true,
    manualMode: false,
    autoRotate: 0,
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
    if (!state.options.allowStack || p.allowStack === false) return 1;
    var layers = Math.max(1, Math.floor((Number(state.container.h) || 0) / (Number(p.h) || 1)));
    if (p.maxLayers > 0) layers = Math.min(layers, Math.max(1, Math.round(Number(p.maxLayers))));
    if (p.maxLoad > 0 && p.weight > 0) layers = Math.min(layers, 1 + Math.floor(p.maxLoad / p.weight + 1e-6));
    return layers;
  }
  function updateStackNote() {
    var maxLayers = 1;
    state.pallets.forEach(function (p) { maxLayers = Math.max(maxLayers, layersFor(p)); });
    var note = $('#stackNote');
    var hint = $('#stackHeadHint');
    if (hint) hint.textContent = state.options.allowStack ? '大底小上' : '单层';
    if (!note) return;
    if (state.options.allowStack) {
      note.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5 12 4l8 4.5-8 4.5zM4 12l8 4.5 8-4.5M4 15.5 12 20l8-4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>' +
        '<span>叠放时<strong>上面托盘的长短边都不能超过下方托盘</strong>；大托底、小托上可以，反过来不行。层数按 ' + state.container.h + 'mm 净高自动计算。</span>';
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
        presetId: p.presetId ? String(p.presetId) : null,
        name: String(p.name || ('托盘 ' + l + '×' + w)),
        code: String(p.code || (l + '×' + w)),
        l: l, w: w, h: h,
        baseH: Math.min(nonNeg(p.baseH, 144), h),
        qty: Math.max(0, Math.round(Number(p.qty) || 0)),
        weight: Math.max(0, Number(p.weight) || 0),
        allowStack: p.allowStack !== false,
        allowRotate: p.allowRotate !== false,
        maxLayers: Math.max(0, Math.round(Number(p.maxLayers) || 0)),
        maxLoad: Math.max(0, Math.round(Number(p.maxLoad) || 0)),
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
      state.customPresets = Array.isArray(saved.customPresets) ? saved.customPresets.filter(function (p) {
        return p && p.id && intVal(p.l, 0) && intVal(p.w, 0) && intVal(p.h, 0);
      }).map(function (p) {
        return {
          id: String(p.id),
          name: String(p.name || '自定义托盘'),
          code: String(p.code || '自定义'),
          l: intVal(p.l, 1200),
          w: intVal(p.w, 800),
          h: intVal(p.h, 1100),
          baseH: Math.min(nonNeg(p.baseH, 144), intVal(p.h, 1100)),
          weight: Math.max(0, Number(p.weight) || 0),
          custom: true
        };
      }) : [];
      state.options.allowRotate = saved.options ? saved.options.allowRotate !== false : true;
      state.options.allowStack = saved.options ? saved.options.allowStack !== false : true;
      state.options.preferSingle = saved.options ? saved.options.preferSingle !== false : true;
      state.options.gap = Math.max(0, Math.round(Number(saved.options && saved.options.gap) || 0));
      state.options.doorGap = Math.max(0, Math.round(Number(saved.options && saved.options.doorGap) || 0));
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
          customPresets: state.customPresets,
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
    $$('#prioritySeg button').forEach(function (b) {
      b.classList.toggle('active', (b.getAttribute('data-priority') === 'stack') === (state.options.preferSingle === false));
    });
    $('#gapInput').value = state.options.gap;
    $('#doorGapInput').value = state.options.doorGap;
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
    var html = '<option value="" disabled selected>从常用规格添加…</option>';
    html += '<option value="__new__">＋ 新建自定义规格…</option>';
    html += '<optgroup label="内置常用规格">';
    DATA.palletPresets.forEach(function (p) {
      html += '<option value="' + p.id + '">' + esc(p.name + ' · ' + p.l + '×' + p.w + '×' + p.h) + '</option>';
    });
    html += '</optgroup>';
    if (state.customPresets.length) {
      html += '<optgroup label="我的自定义规格">';
      state.customPresets.forEach(function (p) {
        html += '<option value="' + esc(p.id) + '">' + esc(p.name + ' · ' + p.l + '×' + p.w + '×' + p.h + ' · ' + p.code) + '</option>';
      });
      html += '</optgroup>';
    }
    select.innerHTML = html;
    select.value = '';
  }

  function findPreset(id) {
    for (var i = 0; i < DATA.palletPresets.length; i++) if (DATA.palletPresets[i].id === id) return DATA.palletPresets[i];
    for (var j = 0; j < state.customPresets.length; j++) if (state.customPresets[j].id === id) return state.customPresets[j];
    return null;
  }

  function renderPresetSelect() {
    // 预留：如果以后需要按当前柜型筛选预设，可在这里处理。
  }

  function renderCustomPresetList() {
    var list = $('#customPresetList');
    if (!state.customPresets.length) {
      list.innerHTML = '<div class="custom-empty">还没有自定义规格。点“新建自定义规格”添加。</div>';
      return;
    }
    list.innerHTML = state.customPresets.map(function (p, index) {
      var color = colorFor(index % DATA.colors.length);
      return '<div class="custom-preset-row">' +
        '<i class="dot" style="background:' + esc(color.solid) + '"></i>' +
        '<div><b>' + esc(p.name) + ' · ' + esc(p.code || '') + '</b>' +
        '<span>' + p.l + ' × ' + p.w + ' × ' + p.h + ' mm · 单托 ' + (p.weight || 0) + ' kg</span></div>' +
        '<button type="button" data-delete-preset="' + esc(p.id) + '">删除</button>' +
      '</div>';
    }).join('');
  }

  function openPresetModal() {
    renderCustomPresetList();
    $('#presetModal').hidden = false;
    $('#btnClosePresetModal').focus();
  }

  function closePresetModal() {
    $('#presetModal').hidden = true;
  }

  function deleteCustomPreset(id) {
    var preset = state.customPresets.filter(function (p) { return p.id === id; })[0];
    if (!preset) return;
    state.customPresets = state.customPresets.filter(function (p) { return p.id !== id; });
    // 已经添加到托盘列表的卡片保留，只是不再关联这个预设。
    state.pallets.forEach(function (p) {
      if (p.presetId === id) p.presetId = null;
    });
    buildPresetSelect();
    renderCustomPresetList();
    saveState();
    toast('已删除自定义规格：' + preset.name);
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
        '<div class="pallet-code-row">' +
          '<span>显示名</span>' +
          '<input data-field="code" maxlength="10" value="' + esc(p.code || '') + '" placeholder="如 蓝托 / C1" title="3D 和打印图上显示的简短名称">' +
          '<em>用于 3D / 打印</em>' +
        '</div>' +
        '<div class="pallet-opts-row">' +
          '<label class="pallet-check" title="取消勾选表示该规格不可叠放（仅单层）">' +
            '<input type="checkbox" data-field="allowStack"' + (p.allowStack !== false ? ' checked' : '') + '>可叠' +
          '</label>' +
          '<label class="pallet-check" title="取消勾选表示该规格禁止旋转 90°">' +
            '<input type="checkbox" data-field="allowRotate"' + (p.allowRotate !== false ? ' checked' : '') + '>可转' +
          '</label>' +
          '<label class="pallet-mini-num" title="单垛最大层数限制，0 或留空为按柜高自动计算">' +
            '限层<input type="number" inputmode="numeric" min="0" max="20" step="1" data-field="maxLayers" value="' + (p.maxLayers > 0 ? p.maxLayers : '') + '" placeholder="不限">' +
          '</label>' +
          '<label class="pallet-mini-num" title="单托顶面允许承受的最大上层重量(kg)，0 或留空为不限">' +
            '顶载<input type="number" inputmode="numeric" min="0" step="50" data-field="maxLoad" value="' + (p.maxLoad > 0 ? p.maxLoad : '') + '" placeholder="不限">kg' +
          '</label>' +
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

  function updatePalletFromCard(card, field, value, checked) {
    var id = card.getAttribute('data-id');
    var p = state.pallets.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    if (field === 'name') {
      p.name = String(value).slice(0, 40) || ('托盘 ' + p.l + '×' + p.w);
    } else if (field === 'code') {
      p.code = String(value).slice(0, 10) || ('P' + p.l);
    } else if (field === 'l' || field === 'w' || field === 'h') {
      var n = intVal(value, field === 'h' ? 1100 : 1200);
      p[field] = Math.max(1, n);
      if (p.baseH > p.h) p.baseH = p.h;
    } else if (field === 'qty') {
      p.qty = Math.max(1, Math.round(Number(value) || 1));
    } else if (field === 'weight') {
      p.weight = Math.max(0, Math.round(Number(value) || 0));
    } else if (field === 'allowStack') {
      p.allowStack = !!checked;
    } else if (field === 'allowRotate') {
      p.allowRotate = !!checked;
    } else if (field === 'maxLayers') {
      p.maxLayers = Math.max(0, Math.round(Number(value) || 0));
    } else if (field === 'maxLoad') {
      p.maxLoad = Math.max(0, Math.round(Number(value) || 0));
    }
    if (!p.fill && !p.qty) p.qty = 1;
    if (p.presetId) {
      var cp = state.customPresets.filter(function (x) { return x.id === p.presetId; })[0];
      if (cp) {
        cp.name = p.name;
        cp.code = p.code;
        cp.l = p.l;
        cp.w = p.w;
        cp.h = p.h;
        cp.baseH = p.baseH;
        cp.weight = p.weight;
        buildPresetSelect();
      }
    }
    if (field === 'h' || field === 'allowStack' || field === 'maxLayers' || field === 'maxLoad' || field === 'weight') {
      var layers = layersFor(p);
      var tag = card.querySelector('.pallet-tag');
      if (tag) tag.textContent = (p.fill ? '补柜规格' : '必装') + (layers > 1 ? ' · ' + layers + '层' : '');
      updateStackNote();
    }
    saveState();
  }

  function addPallet(source) {
    var isNewCustom = !source;
    var customNumber = state.customPresets.length + 1;
    var presetId = null;
    var base;
    if (source) {
      base = clone(source);
      if (source.custom) presetId = source.id;
    } else {
      base = {
        name: '自定义托盘 ' + customNumber,
        code: '自定义' + customNumber,
        l: 1200, w: 800, h: 1100, baseH: 144, qty: 1, weight: 0
      };
      presetId = uid('cp');
      state.customPresets.push({
        id: presetId,
        name: base.name,
        code: base.code,
        l: base.l, w: base.w, h: base.h,
        baseH: base.baseH, weight: base.weight,
        custom: true
      });
    }
    var used = state.pallets.map(function (p) { return p.color; });
    var color = 0;
    for (var i = 0; i < DATA.colors.length; i++) {
      if (used.indexOf(i) === -1) { color = i; break; }
      color = (i + 1) % DATA.colors.length;
    }
    state.pallets.push({
      id: uid('p'),
      presetId: presetId,
      name: base.name || ('托盘 ' + base.l + '×' + base.w),
      code: base.code || ('P' + (state.pallets.length + 1)),
      l: intVal(base.l, 1200),
      w: intVal(base.w, 800),
      h: intVal(base.h, 1100),
      baseH: Math.min(nonNeg(base.baseH, 144), intVal(base.h, 1100)),
      qty: Math.max(1, intVal(base.qty, 1)),
      weight: Math.max(0, Number(base.weight) || 0),
      allowStack: base.allowStack !== false,
      allowRotate: base.allowRotate !== false,
      maxLayers: Math.max(0, Math.round(Number(base.maxLayers) || 0)),
      maxLoad: Math.max(0, Math.round(Number(base.maxLoad) || 0)),
      fill: false,
      color: color
    });
    renderPalletList();
    buildPresetSelect();
    saveState();
    calculate(false);
    if (isNewCustom) {
      setTimeout(function () {
        var cards = $$('.pallet-card');
        var card = cards[cards.length - 1];
        var input = card && $('.pallet-name', card);
        if (input) { input.focus(); input.select(); }
      }, 60);
    }
    toast(isNewCustom ? '已添加自定义托盘：可直接改名、改显示名，并会自动加入下拉列表' : ('已添加：' + state.pallets[state.pallets.length - 1].name));
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
      payload: state.container.payload,
      doorW: known ? known.doorW : (state.container.doorW || 0),
      doorH: known ? known.doorH : (state.container.doorH || 0),
      openTop: known ? !!known.openTop : false,
      reefer: known ? !!known.reefer : false,
      loadLineH: known ? (known.loadLineH || 0) : 0
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
      if (p.layers) {
        p.layers.forEach(function (layer) {
          var lc = byId[layer.typeId] || c;
          layer.solid = lc.solid;
          layer.light = lc.light;
          layer.dark = lc.dark;
        });
      }
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
    if (state.manualMode) setManualMode(false, true);
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
  function updateAutoButtons() {
    var ccw = $('#btnRotateCCW');
    var cw = $('#btnRotateCW');
    if (ccw) {
      ccw.classList.toggle('active', state.autoRotate === -1);
      ccw.setAttribute('aria-pressed', state.autoRotate === -1 ? 'true' : 'false');
    }
    if (cw) {
      cw.classList.toggle('active', state.autoRotate === 1);
      cw.setAttribute('aria-pressed', state.autoRotate === 1 ? 'true' : 'false');
    }
  }

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
      doorGap: state.options.doorGap || 0,
      packingL: Math.max(0, c.l - (state.options.doorGap || 0)),
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
    var rot = $('#btnRotatePallet');
    if (rot) rot.hidden = true;
    state.selectedSeq = null;
    updateEdgePad();
  }

  function updateEdgePad() {
    var pad = $('#edgePad');
    if (!pad) return;
    pad.hidden = !(state.manualMode && state.selectedSeq && state.layout && state.layout.ok);
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
    var rot = $('#btnRotatePallet');
    if (rot) rot.hidden = !(state.manualMode && seq);
    updateEdgePad();
  }

  function setManualMode(on, silent) {
    state.manualMode = !!on;
    if (scene) scene.setManualMode(state.manualMode);
    var btn = $('#btnManual');
    if (btn) {
      btn.classList.toggle('active', state.manualMode);
      btn.textContent = state.manualMode ? '退出手动' : '手动';
    }
    var rot = $('#btnRotatePallet');
    if (rot) rot.hidden = !(state.manualMode && state.selectedSeq);
    var hint = $('.stage-hint');
    if (hint) hint.textContent = state.manualMode
      ? '拖托盘移动（自动吸附；碰撞/越界会挡住）· 空白处旋转视角 · ↑/←/→ 贴边 · R 旋转 90°'
      : '左键旋转 · 右键/Shift 平移 · 滚轮缩放 · 双击复位';
    updateEdgePad();
    if (!silent) toast(state.manualMode ? '手动调整已开启：拖动托盘到空位' : '已退出手动调整');
  }

  function refreshManualLayout(final) {
    var res = state.layout;
    if (!res || !res.ok || !res.placements || !res.placements.length) return;
    var minX = Infinity, maxX = 0;
    var used = 0;
    res.placements.forEach(function (p) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + p.baseL);
      used += p.baseL * p.baseW;
    });
    if (!isFinite(minX)) minX = 0;
    res.bottomGap = Math.max(0, minX);
    res.doorClearance = Math.max(0, currentContainer().l - maxX);
    res.floorUsed = used;
    res.floorUtil = res.floorArea ? used / res.floorArea : 0;
    res.manual = true;
    updateStageCopy();
    if (final) {
      renderResult();
      buildPrint();
    }
  }

  function rotateManualPallet() {
    if (!state.manualMode || !scene) { toast('先开启“手动”，再选中一个托盘'); return; }
    if (!state.selectedSeq) { toast('先在 3D 里选中一个托盘'); return; }
    if (scene.rotateSelected()) {
      toast('已旋转 90°，并放到最近的可用位置');
    } else {
      toast('旋转后没有可用位置，已保持原方向');
    }
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
        '最高垛 ' + res.maxHeight + ' mm' + (res.doorClearance > 0 ? ' · 柜门余 ' + res.doorClearance + ' mm' : '');
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
      $('#typeList').innerHTML = '';
      $('#layoutNotes').innerHTML = '';
      $('#stageLegend').innerHTML = '';
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

    var badge = res.mixedStacks ? '混合叠放方案' : (res.strategy === 'min-stack' ? '最少叠放' : ((!res.stackingUsed && res.allowStack) ? '单层优先' : (res.optimalByWeight && !res.optimalByArea ? '达到载重上限' : (res.optimalByArea ? '达到面积上限' : (res.fillType ? '条带搜索方案' : '叠放排布')))));
    $('#resultBadge').textContent = badge;
    $('#resultBadge').classList.toggle('warn', !res.optimalByArea && !res.optimalByWeight && !!res.fillType);

    var verdict;
    if (res.fillType) {
      verdict = '<strong>' + res.requiredCount + ' 托必装全部装入</strong>；补柜规格 ' + esc(fillName) + ' 还能加 <strong>' + res.fillCount + ' 托</strong>，总装载 <strong>' + res.totalCount + ' 托</strong>（' + res.stackCount + ' 个垛位）' + (res.mixedStacks ? '，含 ' + res.mixedStacks + ' 个混合叠放垛位' : '') + '。';
      if (res.optimalByArea) verdict += ' 补柜数量已达到按柜底面积计算的理论上限。';
      else if (res.optimalByWeight) verdict += ' 补柜数量已达到箱型最大载重上限。';
    } else {
      verdict = '<strong>' + res.requiredCount + ' 托必装全部装入</strong>，共 ' + res.stackCount + ' 个垛位' + (res.mixedStacks ? '（含混合叠放）' : (res.strategy === 'min-stack' ? '（最少叠放）' : (res.stackingUsed ? '（叠放）' : '（单层）'))) + '。';
    }
    $('#verdict').innerHTML = verdict;

    $('#statVolume').textContent = m3(res.volume);
    $('#statFloor').textContent = m2(res.floorUsed) + ' / ' + m2(res.floorArea);
    $('#statWeight').textContent = res.weightKnown
      ? (fmt(res.totalWeight) + (res.payload ? (' / ' + fmt(res.payload) + ' kg') : ' kg'))
      : '未填写';
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
      if (res.mergedMap && res.mergedMap[p.id] && res.mergedMap[p.id] !== p.id) return;
      var count = counts[p.id] || 0;
      if (!count) return;
      var c = colorFor(p.color);
      var stacks = (res.stackCounts && res.stackCounts[p.id]) || 0;
      var typePlacements = res.placements.filter(function (x) { return x.typeId === p.id; });
      var layerCounts = typePlacements.map(function (x) { return (x.layers && x.layers.length) || 1; });
      var maxLayers = layerCounts.length ? Math.max.apply(null, layerCounts) : 1;
      var minLayers = layerCounts.length ? Math.min.apply(null, layerCounts) : 1;
      var layerLabel = minLayers === maxLayers ? (maxLayers > 1 ? ' × ' + maxLayers + ' 层' : ' · 单层') : (' · ' + minLayers + '–' + maxLayers + ' 层');
      rows.push('' +
        '<div class="type-row' + (p.fill ? ' fill' : '') + '">' +
          '<span class="type-swatch" style="background:' + c.solid + '"></span>' +
          '<div class="type-info"><b>' + esc(p.name) + '</b><span>' + p.l + '×' + p.w + '×' + p.h + ' mm · ' + (p.fill ? '补柜规格' : '必装') + ' · ' + stacks + ' 垛' + layerLabel + '</span></div>' +
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
    if (res.strategy === 'single-no-fill') {
      notes.push('没有补柜规格时，叠放不会增加总托数；已按<strong>单层</strong>排布，避免无意义地全叠。');
    }
    if (!res.stackingUsed && res.allowStack && res.strategy !== 'single-no-fill') {
      notes.push('单层已经能装下全部必装，按<strong>优先不叠放</strong>采用单层方案；如需用叠放换更多补柜，可取消“优先不叠放”。');
    }
    if (res.strategy === 'min-stack') {
      notes.push('按<strong>不叠放优先</strong>：先把能平放的托盘全部平放，只叠最少的组数；不会为了减少垛位而把整票货都叠起来。');
    }
    if (res.mergedGroups && res.mergedGroups.length) {
      var mergedCount = res.mergedGroups.reduce(function (n, g) { return n + Math.max(0, g.from.length - 1); }, 0);
      notes.push('有 <strong>' + mergedCount + ' 行同尺寸托盘已自动合并计算</strong>，结果中合并显示。');
    }
    if (res.manual) {
      notes.push('当前方案包含<strong>手动拖动/旋转</strong>后的托盘坐标；自动间隙报警仍按系统初始排布计算，现场请再复核。');
    }
    if (res.stackingUsed && res.allowStack) {
      notes.push('叠放规则：<strong>上面托盘的长边和短边都不超过下方托盘</strong>才允许叠放；大托底、小托上可以，反过来不行。');
    }
    if (res.fillType) {
      if (res.optimalByArea) {
        notes.push('补柜 <strong>' + res.fillCount + ' 托</strong> 已达到面积理论上限；在当前叠放模型下，数量已经最优。');
      } else if (res.optimalByWeight) {
        notes.push('补柜 <strong>' + res.fillCount + ' 托</strong> 已达到箱型载重上限（' + fmt(res.payload) + ' kg）；按空间理论上限最多为 ' + res.fillUpperBoundByArea + ' 托。');
      } else {
        notes.push('补柜 <strong>' + res.fillCount + ' 托</strong>；综合空间与载重估算上限为 ' + res.fillUpperBound + ' 托，受长宽组合限制，实际可能低于该上限。');
      }
    }
    notes.push('共 <strong>' + res.stackCount + ' 个垛位</strong>，必装参与 ' + res.requiredStacks + ' 垛 + 补柜纯垛 ' + res.fillStacks + ' 垛' + (res.mixedStacks ? '；其中混合叠放 ' + res.mixedStacks + ' 垛' : '') + '。');
    if (res.mixedStacks) notes.push('本方案使用了混合叠放，因此不按单一规格的面积上限判断最优。');
    if (state.pallets.length > 1 && res.placements && res.placements.length) {
      notes.push('多规格会全局重排：多层垛先集中柜底，单层垛集中柜门侧；会尝试不同规格顺序，选择柜底宽度覆盖最大、内部空缝最小的方案。');
    }
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
    if (res.doorClearance > 0) notes.push('装载从柜底开始：每个纵向通道都向柜底对齐，柜门侧留出 <strong>' + res.doorClearance + ' mm</strong>，不在柜底留局部空位。');
    if (res.stackingUsed) notes.push('在整票货内部，<strong>单层/矮垛优先排在柜门侧</strong>，高垛放柜底侧，便于从柜门先卸。');
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
    if (res.gap > 0) notes.push('计算时相邻托盘之间已预留 <strong>' + res.gap + ' mm</strong> 间隙（托盘与柜壁之间不额外加）。');
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

  function isInAppWebView() {
    var ua = navigator.userAgent || '';
    return /MicroMessenger|QQ\/|Weibo|DingTalk|AlipayClient/i.test(ua);
  }

  function ensureHtml2Pdf(cb) {
    if (window.html2pdf && (window.html2canvas || (window.jspdf && window.jspdf.jsPDF) || window.jsPDF)) {
      cb(null);
      return;
    }
    var script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    script.onload = function () {
      if (window.html2pdf) cb(null);
      else cb(new Error('PDF 组件初始化失败'));
    };
    script.onerror = function () {
      cb(new Error('PDF 组件加载失败，请检查网络连接'));
    };
    document.head.appendChild(script);
  }

  function deliverPdfBlob(blob, filename) {
    try {
      var file = new File([blob], filename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '')) {
        navigator.share({
          files: [file],
          title: filename
        }).catch(function (err) {
          if (err && err.name === 'AbortError') return;
          triggerDownloadBlob(blob, filename);
        });
        return;
      }
    } catch (e) { /* fallback */ }
    triggerDownloadBlob(blob, filename);
  }

  function triggerDownloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 2000);
  }

  function rasterizeSvgElements(rootEl, cb) {
    var svgs = Array.prototype.slice.call(rootEl.querySelectorAll('svg'));
    if (!svgs.length) { cb(); return; }
    var done = 0;
    svgs.forEach(function (svg) {
      var vb = (svg.getAttribute('viewBox') || '0 0 820 300').split(/\s+/).map(Number);
      var vw = vb[2] || 820;
      var vh = vb[3] || 300;
      var scale = 2.5;
      var xml = new XMLSerializer().serializeToString(svg);
      if (xml.indexOf('xmlns=') === -1) {
        xml = xml.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      var svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas');
        c.width = Math.round(vw * scale);
        c.height = Math.round(vh * scale);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fffdf9';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        var pngImg = document.createElement('img');
        pngImg.src = c.toDataURL('image/png');
        pngImg.style.width = '100%';
        pngImg.style.height = 'auto';
        pngImg.style.display = 'block';
        if (svg.parentNode) svg.parentNode.replaceChild(pngImg, svg);
        done++;
        if (done === svgs.length) cb();
      };
      img.onerror = function () {
        done++;
        if (done === svgs.length) cb();
      };
      img.src = svgUrl;
    });
  }

  function savePdfNow() {
    if (!state.layout || !state.layout.ok) {
      toast('当前没有可导出的装载方案');
      return;
    }
    if (isInAppWebView()) {
      toast('微信/内置浏览器可能拦截文件保存，如未弹出请点右上角「···」用 Safari / 默认浏览器打开');
    } else {
      toast('正在生成单页 A4 PDF 装箱图…');
    }

    var btns = [$('#btnSavePdf'), $('#btnSavePdfTop')].filter(Boolean);
    btns.forEach(function (b) { b.disabled = true; });

    ensureHtml2Pdf(function (err) {
      if (err) {
        btns.forEach(function (b) { b.disabled = false; });
        toast(err.message);
        return;
      }

      buildPrint();
      var srcSheet = $('#printRoot .print-sheet');
      if (!srcSheet) {
        btns.forEach(function (b) { b.disabled = false; });
        toast('生成内容为空，请重新计算方案');
        return;
      }

      // 使用独立 iframe 锁定 560px 桌面版心宽度，彻底隔离手机端窄屏视口与缩放影响
      var iframe = document.createElement('iframe');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:fixed;left:0;top:0;width:560px;height:1200px;border:0;opacity:0;pointer-events:none;z-index:-999;';
      document.body.appendChild(iframe);

      var idoc = iframe.contentDocument || iframe.contentWindow.document;
      var baseHref = document.baseURI || window.location.href;
      var styleTags = Array.prototype.slice.call(document.querySelectorAll('link[rel="stylesheet"], style'))
        .map(function (el) {
          if (el.tagName === 'LINK' && el.href) {
            return '<link rel="stylesheet" href="' + el.href + '">';
          }
          return el.outerHTML;
        }).join('\n');

      idoc.open();
      idoc.write('<!doctype html><html><head><meta charset="utf-8"><base href="' + baseHref + '">' + styleTags +
        '<style>html,body{margin:0!important;padding:0!important;width:560px!important;min-width:560px!important;max-width:560px!important;background:#fff!important;overflow:visible!important;}' +
        '.print-root{display:block!important;width:560px!important;max-width:560px!important;margin:0!important;padding:0!important;}' +
        '.print-sheet{width:560px!important;max-width:560px!important;margin:0!important;padding:0!important;background:#fff!important;}</style>' +
        '</head><body><div class="print-root">' + srcSheet.outerHTML + '</div></body></html>');
      idoc.close();

      var c = currentContainer();
      var code = (c && c.code ? c.code : 'Container').replace(/[^a-zA-Z0-9_-]/g, '');
      var d = new Date();
      var ymd = d.getFullYear() +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0');
      var filename = 'Container-Loader-' + code + '-' + ymd + '.pdf';

      var targetEl = idoc.querySelector('.print-sheet');
      rasterizeSvgElements(targetEl, function () {
        setTimeout(function () {
          var contentW = 560;
          var contentH = Math.ceil(targetEl.scrollHeight || targetEl.getBoundingClientRect().height || 780);
          iframe.style.height = (contentH + 20) + 'px';

          var captureFn = window.html2canvas
            ? window.html2canvas(targetEl, {
                scale: 2,
                useCORS: true,
                backgroundColor: '#ffffff',
                width: contentW,
                height: contentH,
                windowWidth: contentW,
                windowHeight: contentH,
                scrollX: 0,
                scrollY: 0,
                logging: false
              })
            : window.html2pdf().set({
                html2canvas: {
                  scale: 2,
                  useCORS: true,
                  backgroundColor: '#ffffff',
                  width: contentW,
                  height: contentH,
                  windowWidth: contentW,
                  windowHeight: contentH,
                  scrollX: 0,
                  scrollY: 0,
                  logging: false
                }
              }).from(targetEl).toCanvas().get('canvas');

          captureFn.then(function (canvas) {
            var JsPDFCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
            if (!JsPDFCtor) {
              throw new Error('jsPDF constructor unavailable');
            }
            var pdf = new JsPDFCtor({
              orientation: 'portrait',
              unit: 'mm',
              format: 'a4'
            });

            var pageW = 210;
            var pageH = 297;
            var marginTop = 25.4;
            var marginBottom = 18.0;
            var marginLR = 31.7;

            var maxW = pageW - marginLR * 2;          // 146.6 mm
            var maxH = pageH - marginTop - marginBottom; // 253.6 mm

            var ratio = canvas.height / canvas.width;
            var renderW = maxW;
            var renderH = renderW * ratio;

            if (renderH > maxH) {
              renderH = maxH;
              renderW = renderH / ratio;
            }
            var offsetX = (pageW - renderW) / 2;
            var offsetY = marginTop;

            var imgData = canvas.toDataURL('image/jpeg', 0.96);
            pdf.addImage(imgData, 'JPEG', offsetX, offsetY, renderW, renderH, undefined, 'FAST');

            var blob = pdf.output('blob');
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            btns.forEach(function (b) { b.disabled = false; });
            deliverPdfBlob(blob, filename);
            toast('单页 A4 PDF 已生成');
          }).catch(function (e) {
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            btns.forEach(function (b) { b.disabled = false; });
            console.error(e);
            toast('PDF 生成失败，请尝试在 Safari 菜单中选择「分享 → 打印 → 存为 PDF」');
          });
        }, 120);
      });
    });
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
      if (!field || el.type === 'checkbox') return;
      var card = el.closest('.pallet-card');
      if (!card) return;
      updatePalletFromCard(card, field, el.value, el.checked);
      if (field === 'name' || field === 'code' || field === 'l' || field === 'w' || field === 'h' || field === 'qty' || field === 'weight' || field === 'maxLayers' || field === 'maxLoad') {
        scheduleCalc();
      }
    });
    $('#palletList').addEventListener('change', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var field = el.getAttribute('data-field');
      if (!field) return;
      var card = el.closest('.pallet-card');
      if (!card) return;
      if (el.type === 'checkbox' || field === 'name') {
        updatePalletFromCard(card, field, el.value, el.checked);
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
      if (id === '__new__') {
        addPallet(null);
        $('#presetSelect').value = '';
        return;
      }
      var preset = findPreset(id);
      if (preset) addPallet(preset);
      $('#presetSelect').value = '';
    });
    $('#btnManagePresets').addEventListener('click', openPresetModal);
    $('#btnClosePresetModal').addEventListener('click', closePresetModal);
    $('#btnDonePresetModal').addEventListener('click', closePresetModal);
    $('#btnNewPresetFromModal').addEventListener('click', function () {
      closePresetModal();
      addPallet(null);
    });
    $('#presetModal').addEventListener('click', function (e) {
      if (e.target === $('#presetModal')) closePresetModal();
    });
    $('#customPresetList').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-delete-preset]');
      if (!btn) return;
      deleteCustomPreset(btn.getAttribute('data-delete-preset'));
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#presetModal').hidden) closePresetModal();
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
    $$('#prioritySeg button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.options.preferSingle = btn.getAttribute('data-priority') === 'single';
        $$('#prioritySeg button').forEach(function (b) { b.classList.toggle('active', b === btn); });
        saveState();
        calculate(false);
      });
    });
    $('#gapInput').addEventListener('input', function (e) {
      state.options.gap = Math.max(0, Math.min(200, Math.round(Number(e.target.value) || 0)));
      saveState();
      scheduleCalc();
    });
    $('#doorGapInput').addEventListener('input', function (e) {
      state.options.doorGap = Math.max(0, Math.min(2000, Math.round(Number(e.target.value) || 0)));
      saveState();
      scheduleCalc();
    });

    // 计算 / 示例 / 打印
    $('#btnCalc').addEventListener('click', function () { calculate(true); });
    $('#btnCalcTop').addEventListener('click', function () { calculate(true); });
    $('#btnExample').addEventListener('click', setExample);
    $('#btnSavePdf').addEventListener('click', savePdfNow);
    $('#btnSavePdfTop').addEventListener('click', savePdfNow);
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
      if (!scene) return;
      scene.setAutoRotate(state.autoRotate === -1 ? 0 : -1);
    });
    $('#btnRotateCW').addEventListener('click', function () {
      if (!scene) return;
      scene.setAutoRotate(state.autoRotate === 1 ? 0 : 1);
    });
    $('#doubleLayer').addEventListener('change', function (e) {
      state.showUpperLayer = !!e.target.checked;
      if (scene) scene.setShowUpper(state.showUpperLayer);
    });

    // 选中托盘
    $('#selectionClose').addEventListener('click', hideSelection);
    $('#btnManual').addEventListener('click', function () { setManualMode(!state.manualMode); });
    $('#btnRotatePallet').addEventListener('click', rotateManualPallet);
    $$('#edgePad button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!state.manualMode || !state.selectedSeq || !scene) { toast('先开启手动并选中一个托盘'); return; }
        var ok = scene.moveSelectedToEdge(btn.getAttribute('data-dir'));
        if (!ok) toast('这个方向已经贴边或没有可用位置');
      });
    });
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
      var tag = (e.target && e.target.tagName || '').toLowerCase();
      if ((e.key === 'r' || e.key === 'R') && state.manualMode && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        e.preventDefault();
        rotateManualPallet();
      }
      if (state.manualMode && state.selectedSeq && scene && tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
        var dir = e.key === 'ArrowUp' ? 'front' : e.key === 'ArrowLeft' ? 'left' : e.key === 'ArrowRight' ? 'right' : null;
        if (dir) {
          e.preventDefault();
          if (!scene.moveSelectedToEdge(dir)) toast('这个方向已经贴边或没有可用位置');
        }
      }
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
    scene.onPlacementChange = function (p, final) {
      refreshManualLayout(!!final);
    };
    scene.onPlacementBlocked = function () {
      toast('这个位置会碰到其他托盘或超出柜体，已挡住');
    };
    scene.onViewChange = function (view) {
      $$('#viewSeg button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-view') === view);
      });
    };
    scene.onAutoRotateChange = function (dir) {
      state.autoRotate = dir || 0;
      updateAutoButtons();
    };
    updateAutoButtons();
  }

  function init() {
    buildContainerSelect();
    if (!loadState()) {
      var ex = clone(DATA.example);
      state.containerId = ex.containerId;
      state.container = ex.container;
      state.pallets = ex.pallets;
      state.options = ex.options;
    }
    buildPresetSelect();
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
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
