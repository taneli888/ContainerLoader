/*!
 * Container Loader — 平面示意图 / 两侧侧视图 / A4 纵向单页打印版（三视图 1:1 真实比例 + 100% 满宽对齐）
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

  var VIEW_W = 820;
  var PAD_L = 46;
  var PAD_R = 46;

  /* ------------------------------------------------------------------ */
  /* 俯视示意图（长与宽 1:1 真实几何比例）                                   */
  /* ------------------------------------------------------------------ */
  function topSVG(result, options) {
    options = options || {};
    var c = result.container;
    var L = c.l, W = c.w;
    var scaleX = (VIEW_W - PAD_L - PAD_R) / L;
    var scaleY = scaleX;
    var boxH = Math.round(W * scaleY);
    var padT = 50;
    var padB = 40;
    var VW = VIEW_W;
    var VH = padT + boxH + padB;
    var ox = PAD_L;
    var oy = padT;
    var font = options.print ? 13.5 : 13;

    function X(x) { return ox + x * scaleX; }
    function Y(y) { return oy + y * scaleY; }

    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="width:100%;height:auto;display:block" viewBox="0 0 ' + VW + ' ' + VH + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="集装箱托盘俯视示意图">');
    out.push('<defs>');
    out.push('<pattern id="planGrid" width="' + (500 * scaleX) + '" height="' + (500 * scaleY) + '" patternUnits="userSpaceOnUse">');
    out.push('<path d="M ' + (500 * scaleX) + ' 0 L 0 0 0 ' + (500 * scaleY) + '" fill="none" stroke="#d9cebe" stroke-width=".55" opacity=".55"/>');
    out.push('</pattern>');
    out.push('</defs>');
    out.push('<rect width="' + VW + '" height="' + VH + '" fill="#fffdf9"/>');

    out.push('<text x="' + X(0) + '" y="20" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13.5" font-weight="700" fill="#1d272c">俯视图（Top View · 柜顶向下 · 1:1 比例）</text>');
    out.push('<text x="' + X(L) + '" y="20" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11.5" fill="#6f7a7e">上侧 = 面对柜底左侧 · 下侧 = 面对柜底右侧 · ' + (result.stackingUsed ? '叠放' : '单层') + '</text>');

    out.push('<rect x="' + X(0) + '" y="' + Y(0) + '" width="' + (L * scaleX) + '" height="' + (W * scaleY) + '" fill="url(#planGrid)" stroke="#1d272c" stroke-width="2"/>');

    var labeledDimsTop = {};
    (result.placements || []).forEach(function (p) {
      var x = X(p.x), y = Y(p.y), w = p.l * scaleX, h = p.w * scaleY;
      var fill = tint(colorOf(p), p.fill ? .30 : .24);
      var stroke = colorOf(p);
      out.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.6"/>');

      var seqLabel = 'P' + String(p.seq).padStart(2, '0');
      var nameLabel = p.code || p.name || '';
      if (p.layers && p.layers.length > 1) {
        var names = [];
        p.layers.forEach(function (ly) {
          var nm = ly.code || ly.name || nameLabel;
          if (names.indexOf(nm) === -1) names.push(nm);
        });
        if (names.length > 1) nameLabel = names.join('/');
      }

      var dimKey = (p.typeId || nameLabel) + '_' + Math.round(p.l) + 'x' + Math.round(p.w);
      var showDim = !labeledDimsTop[dimKey];
      if (showDim) labeledDimsTop[dimKey] = true;
      var dimStr = Math.round(p.l) + '×' + Math.round(p.w);

      var f = Math.max(8.5, Math.min(font, w * .17, h * .22));
      var fName = Math.max(7.5, Math.min(font * 0.88, w * .15, h * .19));
      var fDim = Math.max(7, Math.min(font * 0.80, w * .14, h * .17));
      var hasName = !!nameLabel && w > 24 && h > 22;

      if (showDim && hasName && h > 44) {
        out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h / 2 - f * 0.92).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + f.toFixed(1) + '" font-weight="700" fill="#1d272c">' + seqLabel + '</text>');
        out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h / 2 + fName * 0.12).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fName.toFixed(1) + '" font-weight="700" fill="' + stroke + '">' + esc(nameLabel) + '</text>');
        out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h / 2 + fName * 1.18).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fDim.toFixed(1) + '" font-weight="600" fill="#2c4650">' + dimStr + '</text>');
      } else {
        out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h / 2 - (hasName ? f * 0.55 : 0)).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + f.toFixed(1) + '" font-weight="700" fill="#1d272c">' + seqLabel + '</text>');
        if (hasName) {
          out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h / 2 + fName * 0.68).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fName.toFixed(1) + '" font-weight="700" fill="' + stroke + '">' + esc(nameLabel) + '</text>');
        }
        if (showDim && w > 30 && h > 28) {
          out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (y + h - 7).toFixed(1) + '" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fDim.toFixed(1) + '" font-weight="600" fill="#2c4650">' + dimStr + '</text>');
        }
      }

      if ((p.count || 1) > 1) {
        out.push('<text x="' + (x + w - 5).toFixed(1) + '" y="' + (y + 11.5).toFixed(1) + '" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="10.5" font-weight="700" fill="' + stroke + '">×' + p.count + '</text>');
      }
    });

    out.push('<path d="M' + X(L) + ' ' + Y(0) + 'v' + (W * scaleY) + '" stroke="#c2733c" stroke-width="3"/>');
    out.push('<path d="M' + (X(L) + 6) + ' ' + Y(W / 2) + 'h14" stroke="#c2733c" stroke-width="1.4"/>');
    out.push('<path d="M' + (X(L) + 10) + ' ' + (Y(W / 2) - 4) + 'l5 4-5 4" fill="none" stroke="#c2733c" stroke-width="1.4"/>');
    out.push('<text x="' + X(0) + '" y="' + (Y(W) + 37) + '" text-anchor="start" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="12" font-weight="700" fill="#2c4650">柜底 · 装载起点</text>');
    out.push('<text x="' + X(L) + '" y="' + (Y(W) + 37) + '" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="12" font-weight="700" fill="#9e5527">柜门</text>');

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

    function hDimTop(y, x1, x2, label) {
      out.push('<path d="M' + x1 + ' ' + y + 'H' + x2 + '" stroke="#c2733c" stroke-width="1.3"/>');
      out.push('<path d="M' + x1 + ' ' + y + 'l6 -3.5v7z" fill="#c2733c"/>');
      out.push('<path d="M' + x2 + ' ' + y + 'l-6 -3.5v7z" fill="#c2733c"/>');
      out.push('<text x="' + ((x1 + x2) / 2) + '" y="' + (y - 6) + '" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="12" font-weight="700" fill="#9e5527">' + label + '</text>');
    }
    function hDimBottom(y, x1, x2, label) {
      out.push('<path d="M' + x1 + ' ' + y + 'H' + x2 + '" stroke="#c2733c" stroke-width="1.3"/>');
      out.push('<path d="M' + x1 + ' ' + y + 'l6 -3.5v7z" fill="#c2733c"/>');
      out.push('<path d="M' + x2 + ' ' + y + 'l-6 -3.5v7z" fill="#c2733c"/>');
      out.push('<text x="' + ((x1 + x2) / 2) + '" y="' + (y + 13) + '" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="12" font-weight="700" fill="#9e5527">' + label + '</text>');
    }
    function vDim(x, y1, y2, label, side) {
      out.push('<path d="M' + x + ' ' + y1 + 'V' + y2 + '" stroke="#c2733c" stroke-width="1.3"/>');
      out.push('<path d="M' + x + ' ' + y1 + 'l-3.5 6h7z" fill="#c2733c"/>');
      out.push('<path d="M' + x + ' ' + y2 + 'l-3.5 -6h7z" fill="#c2733c"/>');
      var tx = x + (side === 'right' ? 14 : -13);
      out.push('<text x="' + tx + '" y="' + ((y1 + y2) / 2) + '" text-anchor="middle" transform="rotate(-90 ' + tx + ' ' + ((y1 + y2) / 2) + ')" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="12" font-weight="700" fill="#9e5527">' + label + '</text>');
    }

    if (sideDiff) {
      hDimTop(Y(0) - 13, X(minX), X(minX + lowerLen), '左侧长 ' + num(lowerLen) + ' mm');
      hDimBottom(Y(W) + 13, X(minX), X(minX + upperLen), '右侧长 ' + num(upperLen) + ' mm');
    } else {
      hDimTop(Y(0) - 13, X(minX), X(maxX), '实装长 ' + num(maxX - minX) + ' mm');
    }
    if (endDiff) {
      vDim(X(0) - 24, Y(doorY.lo), Y(doorY.hi), '柜底宽 ' + num(doorY.hi - doorY.lo) + ' mm', 'left');
      vDim(X(L) + 26, Y(farY.lo), Y(farY.hi), '柜门宽 ' + num(farY.hi - farY.lo) + ' mm', 'right');
    } else {
      vDim(X(0) - 24, Y(minY), Y(maxY), '实装宽 ' + num(maxY - minY) + ' mm', 'left');
    }

    out.push('</svg>');
    return out.join('');
  }

  /* ------------------------------------------------------------------ */
  /* 侧视示意图（长与高 1:1 真实几何比例，与俯视图严格等长对齐）                   */
  /* ------------------------------------------------------------------ */
  function sideSVG(result, options) {
    options = options || {};
    var side = options.side || 'all';
    var c = result.container;
    var L = c.l, W = c.w, H = c.h;
    var padL = PAD_L, padT = 28, padR = PAD_R, padB = 26;
    var scaleX = (VIEW_W - padL - padR) / L;
    var scaleZ = scaleX;
    var boxH = Math.round(H * scaleZ);
    var VW = VIEW_W;
    var VH = padT + boxH + padB;
    var ox = padL;
    var oy = padT;

    function X(x) { return ox + x * scaleX; }
    function Y(z) { return oy + (H - z) * scaleZ; }

    var sideTitle = side === 'left'
      ? '左侧视图（Left Side · 面对柜底左侧通道 · 1:1 比例）'
      : side === 'right'
        ? '右侧视图（Right Side · 面对柜底右侧通道 · 1:1 比例）'
        : '侧视图（Side View · 1:1 比例）';

    var out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="width:100%;height:auto;display:block" viewBox="0 0 ' + VW + ' ' + VH + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(sideTitle) + '">');
    out.push('<rect width="' + VW + '" height="' + VH + '" fill="#fffdf9"/>');
    out.push('<text x="' + X(0) + '" y="' + (Y(H) - 12) + '" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="13" font-weight="700" fill="#1d272c">' + esc(sideTitle) + '</text>');
    out.push('<rect x="' + X(0) + '" y="' + Y(H) + '" width="' + (L * scaleX) + '" height="' + (H * scaleZ) + '" fill="#faf6ef" stroke="#1d272c" stroke-width="1.8"/>');

    var midY = W / 2;
    var visiblePlacements = (result.placements || []).filter(function (p) {
      if (side === 'left') return (p.y + p.w / 2) < midY - 1;
      if (side === 'right') return (p.y + p.w / 2) >= midY - 1;
      return true;
    });

    if (side === 'right') {
      visiblePlacements.sort(function (a, b) { return a.y - b.y; });
    } else if (side === 'left') {
      visiblePlacements.sort(function (a, b) { return b.y - a.y; });
    }

    var labeledDimsSide = {};

    visiblePlacements.forEach(function (p) {
      var layers = p.layers && p.layers.length ? p.layers : (function () {
        var arr = [];
        for (var i = 0; i < (p.count || 1); i++) {
          arr.push({ l: p.l, w: p.w, h: p.h, baseH: p.baseH, solid: p.solid, color: p.color, code: p.code, name: p.name, typeId: p.typeId, relX: 0 });
        }
        return arr;
      })();
      var z = 0;
      layers.forEach(function (layer) {
        var layL = layer.l || p.l;
        var layH = layer.h || p.h;
        var x = X(p.x + (layer.relX || 0)), y = Y(z + layH), w = layL * scaleX, h = layH * scaleZ;
        var stroke = colorOf(layer);
        out.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + tint(stroke, .26) + '" stroke="' + stroke + '" stroke-width="1.3"/>');
        if (layer.baseH) {
          out.push('<rect x="' + x.toFixed(1) + '" y="' + Y(z + layer.baseH).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + (layer.baseH * scaleZ).toFixed(1) + '" fill="rgba(145,97,58,.62)"/>');
        }

        var bodyTop = y;
        var bodyH = h - (layer.baseH ? layer.baseH * scaleZ : 0);
        var cy = bodyTop + bodyH * 0.5;
        var seqStr = 'P' + String(p.seq).padStart(2, '0');
        var nameStr = layer.code || p.code || layer.name || p.name || '';

        var dimKey = (layer.typeId || p.typeId || nameStr) + '_' + Math.round(layL) + 'x' + Math.round(layH);
        var showDim = !labeledDimsSide[dimKey];
        if (showDim) labeledDimsSide[dimKey] = true;
        var dimStr = Math.round(layL) + '×' + Math.round(layH);

        if (w > 22 && bodyH > 14) {
          var fSeq = Math.max(8, Math.min(11, w * 0.14, bodyH * 0.28));
          var fNm = Math.max(7.5, Math.min(10.5, w * 0.13, bodyH * 0.25));
          var fDim = Math.max(7, Math.min(9.5, w * 0.12, bodyH * 0.22));

          if (showDim && bodyH >= 42 && nameStr) {
            out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (cy - fSeq * 0.95).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fSeq.toFixed(1) + '" font-weight="700" fill="#1d272c">' + seqStr + '</text>');
            out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (cy + fNm * 0.08).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fNm.toFixed(1) + '" font-weight="700" fill="' + stroke + '">' + esc(nameStr) + '</text>');
            out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (cy + fNm * 1.15).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fDim.toFixed(1) + '" font-weight="600" fill="#2c4650">' + dimStr + '</text>');
          } else if (bodyH >= 24 && nameStr) {
            var line2 = showDim ? (nameStr + ' (' + dimStr + ')') : nameStr;
            out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (cy - fSeq * 0.52).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fSeq.toFixed(1) + '" font-weight="700" fill="#1d272c">' + seqStr + '</text>');
            out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + (cy + fNm * 0.68).toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fNm.toFixed(1) + '" font-weight="700" fill="' + stroke + '">' + esc(line2) + '</text>');
          } else {
            var inlineText = nameStr ? (seqStr + ' ' + nameStr) : seqStr;
            if (showDim) inlineText += ' ' + dimStr;
            out.push('<text x="' + (x + w / 2).toFixed(1) + '" y="' + cy.toFixed(1) + '" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="' + fSeq.toFixed(1) + '" font-weight="700" fill="#1d272c">' + esc(inlineText) + '</text>');
          }
        }
        z += layH;
      });
    });

    out.push('<path d="M' + X(L) + ' ' + Y(H) + 'v' + (H * scaleZ) + '" stroke="#c2733c" stroke-width="2.4"/>');
    out.push('<text x="' + X(L) + '" y="' + (Y(0) + 18) + '" text-anchor="end" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11.5" font-weight="700" fill="#9e5527">柜门</text>');
    out.push('<text x="' + X(0) + '" y="' + (Y(0) + 18) + '" text-anchor="start" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11.5" font-weight="700" fill="#2c4650">柜底</text>');

    var dimX = X(L) + 22;
    out.push('<path d="M' + dimX + ' ' + Y(0) + 'V' + Y(H) + '" stroke="#8a9295" stroke-width="1"/>');
    out.push('<path d="M' + (dimX - 3.5) + ' ' + Y(0) + 'h7M' + (dimX - 3.5) + ' ' + Y(H) + 'h7" stroke="#8a9295" stroke-width="1"/>');
    out.push('<text x="' + (dimX + 12) + '" y="' + Y(H / 2) + '" text-anchor="middle" transform="rotate(90 ' + (dimX + 12) + ' ' + Y(H / 2) + ')" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" font-weight="600" fill="#4d585c">内高 ' + num(H) + ' mm</text>');

    out.push('</svg>');
    return out.join('');
  }

  /* ------------------------------------------------------------------ */
  /* A4 纵向单页打印版（三视图 100% 满宽 + 比例协调）                        */
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
      if (result.mergedMap && result.mergedMap[t.id] && result.mergedMap[t.id] !== t.id) return '';
      var count = result.typeCounts[t.id] || 0;
      if (!count) return '';
      var stacks = (result.stackCounts && result.stackCounts[t.id]) || 0;
      var typePlacements = (result.placements || []).filter(function (p) { return p.typeId === t.id; });
      var layerCounts = typePlacements.map(function (p) { return (p.layers && p.layers.length) || 1; });
      var layers = layerCounts.length ? Math.max.apply(null, layerCounts) : 1;
      var minLayers = layerCounts.length ? Math.min.apply(null, layerCounts) : 1;
      var layerText = minLayers === layers ? (layers + '层') : (minLayers + '–' + layers + '层');
      var tag = t.code ? (' [' + esc(t.code) + ']') : '';
      return '<tr>' +
        '<td><span style="display:inline-block;width:3mm;height:3mm;border-radius:.6mm;background:' + esc(t.solid || '#c2733c') + ';margin-right:1.6mm;vertical-align:-.3mm"></span><b>' + esc(t.name) + '</b><span style="color:' + esc(t.solid || '#c2733c') + ';font-weight:700">' + tag + '</span></td>' +
        '<td>' + num(t.l) + ' × ' + num(t.w) + ' × ' + num(t.h) + ' · ' + layerText + '</td>' +
        '<td class="num">' + (hasFill ? (t.fill ? '—' : num(t.qty)) : num(count)) + '</td>' +
        (hasFill ? '<td class="num">' + (t.fill ? num(count) : '—') : '') +
        '<td class="num"><b>' + num(count) + '</b></td>' +
        '<td class="num">' + num(stacks) + '</td>' +
        '<td class="num">' + (t.weight ? num(t.weight) + ' kg' : '—') + '</td>' +
        '</tr>';
    }).join('');

    var top = topSVG(result, { print: true });
    var sideLeft = sideSVG(result, { side: 'left' });
    var sideRight = sideSVG(result, { side: 'right' });

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

    var planMode = result.strategy === 'min-stack' ? '最少叠放装柜方案' : (result.stackingUsed ? (result.mixedStacks ? '混合叠放装柜方案' : '叠放装柜方案') : '单层装柜方案');

    return '' +
      '<div class="print-sheet">' +
        '<header class="print-head">' +
          '<div class="print-brand">' +
            '<div class="print-logo">CL</div>' +
            '<div><h1>Container Loader · 集装箱装柜示意图</h1><p>' + planMode + ' / Container Load Plan</p></div>' +
          '</div>' +
          '<div class="print-meta">' +
            '<b>' + esc(c.code) + ' · ' + esc(c.name) + '</b><br>' +
            '内尺寸 ' + num(c.l) + '×' + num(c.w) + '×' + num(c.h) + ' mm · 实装 ' + envText + '<br>' +
            (result.doorClearance > 0 ? ('柜门余量 ' + num(result.doorClearance) + ' mm · ') : '') +
            '生成 ' + esc(stamp) +
          '</div>' +
        '</header>' +
        '<div class="print-kpi-bar">' +
          '<span>总装载 <b>' + num(result.totalCount) + '</b> 托（' + num(result.stackCount) + ' 垛）</span>' +
          '<span>必装 <b>' + num(result.requiredCount) + '</b> 托' + (hasFill ? (' · 补柜 <b>' + num(result.fillCount) + '</b> 托') : '') + '</span>' +
          '<span>地面利用率 <b>' + pct(result.floorUtil) + '</b></span>' +
          '<span>体积利用率 <b>' + pct(result.volumeUtil) + '</b></span>' +
          (result.weightKnown ? ('<span>总重 <b>' + num(result.totalWeight) + '</b> kg</span>') : '') +
        '</div>' +
        '<section class="print-views">' +
          '<div class="print-view-box print-top-box">' + top + '</div>' +
          '<div class="print-view-box print-side-box">' + sideLeft + '</div>' +
          '<div class="print-view-box print-side-box">' + sideRight + '</div>' +
        '</section>' +
        '<div class="print-bottom">' +
          (function () {
            var cw = result.clearanceWarnings || [];
            if (!cw.length) return '';
            var items = cw.map(function (w) { return '<li>' + esc(w.text) + '</li>'; }).join('');
            return '<section class="print-clearance">' +
              '<div class="print-clearance-title">⚠ 间隙报警（' + cw.length + ' 项需复核）：</div>' +
              '<ul>' + items + '</ul>' +
              '</section>';
          })() +
          '<section class="print-table">' +
            '<table><thead><tr><th>规格与标记名</th><th>尺寸 (mm) / 层数</th><th class="num">' + (hasFill ? '必装' : '数量') + '</th>' +
            (hasFill ? '<th class="num">补柜</th>' : '') +
            '<th class="num">合计</th><th class="num">垛位</th><th class="num">单托重</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '</section>' +
          '<footer class="print-foot">' +
            '<div><b>说明：</b>P01–P' + String(result.stackCount).padStart(2, '0') + ' 为垛位编号，方框内标注托盘标记名称及尺寸（mm，同规格托盘仅标注一处）。三张视图按集装箱实际尺寸 1:1 比例绘制并垂直对齐。图为几何排布，不含绑扎、偏载及道路限重。</div>' +
            '<div class="print-sign">Container Loader</div>' +
          '</footer>' +
        '</div>' +
      '</div>';
  }

  root.CL_PLAN = {
    topSVG: topSVG,
    sideSVG: sideSVG,
    buildPrintHTML: buildPrintHTML
  };
})(typeof window !== 'undefined' ? window : globalThis);
