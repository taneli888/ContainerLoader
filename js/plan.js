/*!
 * Container Loader — 平面示意图 / 侧视图 / A4 打印版
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function num(n) { return Math.round(Number(n) || 0).toLocaleString('zh-CN'); }
  function pct(n) { return (Math.max(0, Number(n) || 0) * 100).toFixed(1) + '%'; }
  function colorOf(p) { return p.solid || p.color || '#c2733c'; }
  function tint(hex, alpha) {
    var h = String(hex || '#c2733c').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /* ------------------------------------------------------------------ */
  /* 俯视示意图                                                          */
  /* ------------------------------------------------------------------ */
  function topSVG(result, options) {
    options = options || {};
    var c = result.container;
    var L = c.l, W = c.w;
    var VW = 1040, VH = 520;
    var padL = 72, padT = 82, padR = 54, padB = 72;
    var scale = Math.min((VW - padL - padR) / L, (VH - padT - padB) / W);
    var ox = padL + ((VW - padL - padR) - L * scale) / 2;
    var oy = padT + ((VH - padT - padB) - W * scale) / 2;
    var font = options.print ? 11 : 12;

    function X(x) { return ox + x * scale; }
    function Y(y) { return oy + y * scale; }

    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="集装箱托盘俯视示意图">');
    out.push('<defs>');
    out.push('<pattern id="planGrid" width="' + (500 * scale) + '" height="' + (500 * scale) + '" patternUnits="userSpaceOnUse">');
    out.push('<path d="M ' + (500 * scale) + ' 0 L 0 0 0 ' + (500 * scale) + '" fill="none" stroke="#d9cebe" stroke-width=".55" opacity=".55"/>');
    out.push('</pattern>');
    out.push('</defs>');
    out.push('<rect width="' + VW + '" height="' + VH + '" fill="#fffdf9"/>');

    // 容器底
    out.push('<rect x="' + X(0) + '" y="' + Y(0) + '" width="' + (L * scale) + '" height="' + (W * scale) + '" fill="url(#planGrid)" stroke="#1d272c" stroke-width="2"/>');

    // 托盘
    (result.placements || []).forEach(function (p) {
      var x = X(p.x), y = Y(p.y), w = p.l * scale, h = p.w * scale;
      var fill = tint(colorOf(p), p.fill ? .30 : .24);
      var stroke = colorOf(p);
      out.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.6"/>');
      // 托盘内的小叉车孔示意
      if (w > 26 && h > 26) {
        out.push('<path d="M' + (x + w * .16).toFixed(1) + ' ' + (y + h * .72).toFixed(1) + 'h' + (w * .68).toFixed(1) + 'M' + (x + w * .16).toFixed(1) + ' ' + (y + h * .82).toFixed(1) + 'h' + (w * .68).toFixed(1) + '" stroke="' + stroke + '" stroke-width=".8" opacity=".38"/>');
      }
      var label = 'P' + String(p.seq).padStart(2, '0');
      var f = Math.max(8, Math.min(font, w * .17, h * .23));
      out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h / 2 - 1).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + f.toFixed(1) + '" font-weight="700" fill="#283238">' + label + '</text>');
      if (w > 57 && h > 42) {
        out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h / 2 + f * .92).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + Math.max(6.5, f * .55).toFixed(1) + '" font-weight="600" fill="' + stroke + '" opacity=".9">' + esc(p.code) + '</text>');
      }
      if ((p.count || 1) > 1) {
        out.push('<text x="' + (x + w - 4).toFixed(1) + '" y="' + (y + 11).toFixed(1) + '" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="8" font-weight="700" fill="' + stroke + '">×' + p.count + '</text>');
      }
    });

    // 柜门线（X=L；X=0 是柜底装载起点）
    out.push('<path d="M' + X(L) + ' ' + Y(0) + 'v' + (W * scale) + '" stroke="#c2733c" stroke-width="3"/>');
    out.push('<path d="M' + (X(L) + 6) + ' ' + (Y(W / 2)) + 'h20" stroke="#c2733c" stroke-width="1.4"/>');
    out.push('<path d="M' + (X(L) + 12) + ' ' + (Y(W / 2) - 4) + 'l6 4-6 4" fill="none" stroke="#c2733c" stroke-width="1.4"/>');
    out.push('<text x="' + X(L) + '" y="' + (Y(W) + 24) + '" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10" font-weight="700" fill="#9e5527">柜门</text>');

    // 实际装载包络尺寸：长箭头 + 两侧不一致时分开标
    var ps = result.placements || [];
    var minX = 0, maxX = 0, minY = 0, maxY = 0;
    if (ps.length) {
      minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
      ps.forEach(function (p) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x + p.l);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y + p.w);
      });
    }
    var midY = (minY + maxY) / 2;
    var lower = ps.filter(function (p) { return p.y + p.w / 2 < midY; });
    var upper = ps.filter(function (p) { return p.y + p.w / 2 >= midY; });
    function maxEnd(arr) {
      var v = -Infinity;
      arr.forEach(function (p) { v = Math.max(v, p.x + p.l); });
      return isFinite(v) ? v : maxX;
    }
    function yRange(arr) {
      if (!arr.length) return { lo: minY, hi: maxY };
      var lo = Infinity, hi = -Infinity;
      arr.forEach(function (p) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y + p.w); });
      return { lo: lo, hi: hi };
    }
    var lowerLen = maxEnd(lower) - minX, upperLen = maxEnd(upper) - minX;
    var doorY = yRange(ps.filter(function (p) { return p.x <= minX + 5; }));
    var farY = yRange(ps.filter(function (p) { return p.x + p.l >= maxX - 5; }));
    var sideDiff = Math.abs(lowerLen - upperLen) > 5;
    var endDiff = Math.abs((doorY.hi - doorY.lo) - (farY.hi - farY.lo)) > 5;

    function hDim(y, x1, x2, label) {
      out.push('<path d="M' + x1 + ' ' + y + 'H' + x2 + '" stroke="#c2733c" stroke-width="1.4"/>');
      out.push('<path d="M' + x1 + ' ' + y + 'l7 -4v8z" fill="#c2733c"/>');
      out.push('<path d="M' + x2 + ' ' + y + 'l-7 -4v8z" fill="#c2733c"/>');
      out.push('<text x="' + ((x1 + x2) / 2) + '" y="' + (y - 8) + '" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10.5" font-weight="700" fill="#9e5527">' + label + '</text>');
    }
    function vDim(x, y1, y2, label, side) {
      out.push('<path d="M' + x + ' ' + y1 + 'V' + y2 + '" stroke="#c2733c" stroke-width="1.4"/>');
      out.push('<path d="M' + x + ' ' + y1 + 'l-4 7h8z" fill="#c2733c"/>');
      out.push('<path d="M' + x + ' ' + y2 + 'l-4 -7h8z" fill="#c2733c"/>');
      var tx = x + (side === 'right' ? 11 : -10);
      out.push('<text x="' + tx + '" y="' + ((y1 + y2) / 2) + '" text-anchor="middle" transform="rotate(-90 ' + tx + ' ' + ((y1 + y2) / 2) + ')" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10.5" font-weight="700" fill="#9e5527">' + label + '</text>');
    }

    if (sideDiff) {
      hDim(Y(0) - 48, X(minX), X(minX + lowerLen), '长 ' + num(lowerLen));
      hDim(Y(0) - 25, X(minX), X(minX + upperLen), '长 ' + num(upperLen));
    } else {
      hDim(Y(0) - 28, X(minX), X(maxX), '实装长 ' + num(maxX - minX) + ' mm');
    }
    if (endDiff) {
      vDim(X(minX) - 30, Y(doorY.lo), Y(doorY.hi), '宽 ' + num(doorY.hi - doorY.lo), 'left');
      vDim(X(maxX) + 30, Y(farY.lo), Y(farY.hi), '宽 ' + num(farY.hi - farY.lo), 'right');
    } else {
      vDim(X(minX) - 30, Y(minY), Y(maxY), '实装宽 ' + num(maxY - minY) + ' mm', 'left');
    }

    // 方向提示
    out.push('<text x="' + X(0) + '" y="' + (Y(W) + 24) + '" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10.5" font-weight="700" fill="#2c4650">柜底 · 装载起点</text>');
    out.push('<text x="' + (X(0) + 92) + '" y="' + (Y(W) + 24) + '" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9.5" fill="#9aa3a6">' + (result.stackingUsed ? '叠放' : '单层') + ' · 编号为垛位</text>');

    out.push('</svg>');
    return out.join('');
  }

  /* ------------------------------------------------------------------ */
  /* 侧视示意图                                                          */
  /* ------------------------------------------------------------------ */
  function sideSVG(result) {
    var c = result.container;
    var L = c.l, H = c.h;
    var VW = 1040, VH = 290;
    var padL = 72, padT = 48, padR = 54, padB = 56;
    var scale = Math.min((VW - padL - padR) / L, (VH - padT - padB) / H);
    var ox = padL + ((VW - padL - padR) - L * scale) / 2;
    var oy = padT + ((VH - padT - padB) - H * scale) / 2;

    function X(x) { return ox + x * scale; }
    function Y(z) { return oy + (H - z) * scale; }

    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + VW + ' ' + VH + '" role="img" aria-label="集装箱托盘侧视示意图">');
    out.push('<rect width="' + VW + '" height="' + VH + '" fill="#fffdf9"/>');
    out.push('<rect x="' + X(0) + '" y="' + Y(H) + '" width="' + (L * scale) + '" height="' + (H * scale) + '" fill="#faf6ef" stroke="#1d272c" stroke-width="2"/>');

    (result.placements || []).forEach(function (p) {
      var layers = p.layers && p.layers.length ? p.layers : (function () {
        var arr = [];
        for (var i = 0; i < (p.count || 1); i++) arr.push({ l: p.l, w: p.w, h: p.h, baseH: p.baseH, solid: p.solid, color: p.color, relX: 0 });
        return arr;
      })();
      var z = 0;
      layers.forEach(function (layer, li) {
        var x = X(p.x + (layer.relX || 0)), y = Y(z + layer.h), w = layer.l * scale, h = layer.h * scale;
        out.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + tint(colorOf(layer), .22) + '" stroke="' + colorOf(layer) + '" stroke-width="1.2"/>');
        if (layer.baseH) {
          out.push('<rect x="' + x.toFixed(1) + '" y="' + Y(z + layer.baseH).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (layer.baseH * scale).toFixed(1) + '" fill="rgba(145,97,58,.55)"/>');
        }
        if (li === layers.length - 1 && w > 18) {
          out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h * .56).toFixed(1) + '" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="7.5" font-weight="700" fill="#4b5559">' + p.seq + (layers.length > 1 ? ' ×' + layers.length : '') + '</text>');
        }
        z += layer.h;
      });
    });

    // 门（X=L）
    out.push('<path d="M' + X(L) + ' ' + Y(H) + 'v' + (H * scale) + '" stroke="#c2733c" stroke-width="2.4"/>');
    out.push('<text x="' + (X(L) + 8) + '" y="' + (Y(H) - 10) + '" text-anchor="start" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9.5" font-weight="700" fill="#9e5527">柜门</text>');
    out.push('<text x="' + (X(0) - 8) + '" y="' + (Y(H) - 10) + '" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9.5" font-weight="700" fill="#2c4650">柜底</text>');

    // 高度尺寸
    var dimX = X(L) + 24;
    out.push('<path d="M' + dimX + ' ' + Y(0) + 'V' + Y(H) + '" stroke="#8a9295" stroke-width="1"/>');
    out.push('<path d="M' + (dimX - 4) + ' ' + Y(0) + 'h8M' + (dimX - 4) + ' ' + Y(H) + 'h8" stroke="#8a9295" stroke-width="1"/>');
    out.push('<text x="' + (dimX + 9) + '" y="' + Y(H / 2) + '" text-anchor="middle" transform="rotate(90 ' + (dimX + 9) + ' ' + Y(H / 2) + ')" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10" font-weight="600" fill="#4d585c">内高 ' + num(H) + ' mm</text>');
    out.push('<text x="' + X(L) + '" y="' + (Y(0) + 21) + '" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="9.5" fill="#9aa3a6">' + (result.stackingUsed ? '叠放侧视' : '单层侧视') + ' · 未按比例显示托盘间隙</text>');
    out.push('</svg>');
    return out.join('');
  }

  /* ------------------------------------------------------------------ */
  /* 打印版                                                              */
  /* ------------------------------------------------------------------ */
  function buildPrintHTML(result, meta) {
    meta = meta || {};
    var c = result.container;
    var date = new Date();
    var stamp = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0') +
      ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');

    var types = meta.types || [];
    var hasFill = !!result.fillType;
    var rows = types.map(function (t) {
      var count = result.typeCounts[t.id] || 0;
      if (!count) return '';
      var stacks = (result.stackCounts && result.stackCounts[t.id]) || 0;
      var typePlacements = (result.placements || []).filter(function (p) { return p.typeId === t.id; });
      var layers = typePlacements.length ? ((typePlacements[0].layers && typePlacements[0].layers.length) || 1) : 1;
      return '<tr>' +
        '<td><span style="display:inline-block;width:2.4mm;height:2.4mm;border-radius:.5mm;background:' + esc(t.solid || '#c2733c') + ';margin-right:1.2mm;vertical-align:-.2mm"></span>' + esc(t.name) + '</td>' +
        '<td>' + num(t.l) + ' × ' + num(t.w) + ' × ' + num(t.h) + ' · ' + layers + '层</td>' +
        '<td class="num">' + (hasFill ? (t.fill ? '—' : num(t.qty)) : num(count)) + '</td>' +
        (hasFill ? '<td class="num">' + (t.fill ? num(count) : '—') + '</td>' : '') +
        '<td class="num"><b>' + num(count) + '</b></td>' +
        '<td class="num">' + num(stacks) + '</td>' +
        '<td class="num">' + (t.weight ? num(t.weight) + ' kg' : '—') + '</td>' +
        '</tr>';
    }).join('');

    var legend = types.filter(function (t) { return (result.typeCounts[t.id] || 0) > 0; }).map(function (t) {
      return '<span><i style="background:' + esc(t.solid || '#c2733c') + '"></i>' + esc(t.name) + ' · ' + num(result.typeCounts[t.id]) + ' 托</span>';
    }).join('');

    var verdict = '必装 ' + num(result.requiredCount) + ' 托全部装入' +
      (result.fillType ? '，另可补柜 ' + num(result.fillCount) + ' 托 ' + esc(result.fillType.name) : '') +
      '。总计 ' + num(result.totalCount) + ' 托、' + num(result.stackCount) + ' 个垛位' +
      (result.stackingUsed ? '（叠放）' : '（单层）') + '。' +
      (result.optimalByArea ? ' 补柜数量达到面积理论上限。' : '');
    var clearance = result.clearanceWarnings || [];
    if (clearance.length) {
      var widthWarn = clearance.filter(function (w) { return w.axis === 'width'; });
      var lengthWarn = clearance.filter(function (w) { return w.axis === 'length'; });
      verdict += ' ⚠ 间隙报警：';
      if (widthWarn.length) verdict += '宽向 ' + widthWarn.length + ' 项（最小余 ' + Math.round(Math.min.apply(null, widthWarn.map(function (w) { return w.clearance; }))) + 'mm）';
      if (widthWarn.length && lengthWarn.length) verdict += '；';
      if (lengthWarn.length) verdict += '长向 ' + lengthWarn.length + ' 项（最小余 ' + Math.round(Math.min.apply(null, lengthWarn.map(function (w) { return w.clearance; }))) + 'mm）';
      verdict += '。';
    }

    var top = topSVG(result, { print: true });
    var side = sideSVG(result);

    var envMinX = Infinity, envMaxX = 0, envMinY = Infinity, envMaxY = 0;
    (result.placements || []).forEach(function (p) {
      envMinX = Math.min(envMinX, p.x);
      envMaxX = Math.max(envMaxX, p.x + p.l);
      envMinY = Math.min(envMinY, p.y);
      envMaxY = Math.max(envMaxY, p.y + p.w);
    });
    var envText = envMaxX && envMaxY
      ? (num(envMaxX - envMinX) + ' × ' + num(envMaxY - envMinY) + ' mm')
      : '—';

    var planMode = result.stackingUsed ? (result.mixedStacks ? '混合叠放装柜方案' : '叠放装柜方案') : '单层装柜方案';
    return '' +
      '<div class="print-sheet">' +
        '<header class="print-head">' +
          '<div class="print-brand">' +
            '<div class="print-logo">CL</div>' +
            '<div><h1>Container Loader · 集装箱装柜示意图</h1><p>' + planMode + ' / Container Load Plan</p></div>' +
          '</div>' +
          '<div class="print-meta">' +
            '<b>' + esc(c.code) + ' · ' + esc(c.name) + '</b><br>' +
            '内尺寸 ' + num(c.l) + ' × ' + num(c.w) + ' × ' + num(c.h) + ' mm<br>' +
            '实装包络 ' + envText + '<br>' +
            (result.doorClearance > 0 ? ('柜门余量 ' + num(result.doorClearance) + ' mm<br>') : '') +
            '生成时间 ' + esc(stamp) +
          '</div>' +
        '</header>' +
        '<section class="print-summary' + (hasFill ? '' : ' no-fill') + '">' +
          '<div class="print-stat hot"><span>总装载</span><b>' + num(result.totalCount) + '<small>托</small></b></div>' +
          '<div class="print-stat"><span>必装已放入</span><b>' + num(result.requiredCount) + '<small>托</small></b></div>' +
          (hasFill ? '<div class="print-stat"><span>补柜可加</span><b>' + num(result.fillCount) + '<small>托</small></b></div>' : '') +
          '<div class="print-stat"><span>地面利用率</span><b>' + pct(result.floorUtil) + '</b></div>' +
          '<div class="print-stat"><span>总体积利用率</span><b>' + pct(result.volumeUtil) + '</b></div>' +
        '</section>' +
        '<section class="print-plan">' + top + '</section>' +
        '<div class="print-bottom">' +
          '<div>' +
            '<div class="print-side">' + side + '</div>' +
            '<div class="print-legend"><h2>颜色图例</h2>' + (legend || '<span>暂无</span>') + '</div>' +
          '</div>' +
          '<div class="print-table">' +
            '<h2>规格汇总</h2>' +
            '<table><thead><tr><th>规格</th><th>尺寸 (mm) / 层</th><th class="num">' + (hasFill ? '必装' : '数量') + '</th>' +
            (hasFill ? '<th class="num">补柜</th>' : '') +
            '<th class="num">合计</th><th class="num">垛位</th><th class="num">单托重</th></tr></thead><tbody>' + rows + '</tbody></table>' +
            '<p style="font-size:2.2mm;color:#666;line-height:1.5;margin-top:1.2mm">' + verdict + '</p>' +
          '</div>' +
        '</div>' +
        '<footer class="print-foot">' +
          '<span><b>说明：</b>编号 P01–P' + String(result.stackCount).padStart(2, '0') + ' 为垛位编号，不代表实际卸货顺序；图中 ×N 表示该垛位叠放 N 托。图为' + (result.stackingUsed ? '叠放' : '单层') + '几何排布，' + (result.stackingUsed ? '上层长宽不能超过下层；' : '') + '不含绑扎、加固、偏载、危险品及目的国道路限重。</span>' +
          '<span style="white-space:nowrap">Container Loader · 本地计算</span>' +
        '</footer>' +
      '</div>';
  }

  root.CL_PLAN = {
    topSVG: topSVG,
    sideSVG: sideSVG,
    buildPrintHTML: buildPrintHTML
  };
})(typeof window !== 'undefined' ? window : globalThis);
