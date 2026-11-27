/*!
 * Container Loader — 轻量 3D 装柜渲染器
 * Canvas 2D 透视投影，无 WebGL、无第三方依赖。
 * 支持等轴测 / 俯视 / 侧视 / 柜门视角，拖动旋转、滚轮缩放、点击托盘。
 */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function vec(x, y, z) { return { x: x, y: y, z: z }; }
  function add(a, b) { return vec(a.x + b.x, a.y + b.y, a.z + b.z); }
  function sub(a, b) { return vec(a.x - b.x, a.y - b.y, a.z - b.z); }
  function mul(a, n) { return vec(a.x * n, a.y * n, a.z * n); }
  function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross(a, b) {
    return vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var l = len(a) || 1; return vec(a.x / l, a.y / l, a.z / l); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function hexToRgb(hex) {
    var h = String(hex || '#c2733c').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb(c, f) {
    f = f == null ? 1 : f;
    return 'rgb(' + Math.round(clamp(c[0] * f, 0, 255)) + ',' +
      Math.round(clamp(c[1] * f, 0, 255)) + ',' +
      Math.round(clamp(c[2] * f, 0, 255)) + ')';
  }
  function rgba(c, a) {
    return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a + ')';
  }

  var WOOD = hexToRgb('#91613a');
  var WOOD_TOP = hexToRgb('#ab7a4c');
  var LIGHT = norm(vec(-0.42, -0.56, 0.82));

  function Scene(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.model = null;
    this.cam = {
      yaw: -2.32,
      pitch: 0.46,
      zoom: 1,
      panX: 0,
      panY: 0
    };
    this.view = 'iso';
    this.selectedSeq = null;
    this.showUpper = true;
    this.manualMode = false;
    this.autoRotate = 0;
    this.onAutoRotateChange = null;
    this.onSelect = null;
    this.onPlacementChange = null;
    this.onPlacementBlocked = null;
    this.onViewChange = null;
    this._w = 0;
    this._h = 0;
    this._dpr = 1;
    this._raf = null;
    this._tween = null;
    this._drag = null;
    this._pointers = new Map();
    this._pinch = null;
    this._hitFaces = [];
    this._bind();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      var self = this;
      this._ro = new ResizeObserver(function () { self.resize(); });
      this._ro.observe(canvas.parentElement || canvas);
    }
  }

  Scene.prototype.setModel = function (model) {
    this.model = model || null;
    this._hitFaces = [];
    if (this.view === 'iso' && this.model) this.cam.pitch = this._isoPitch();
    this.requestRender();
  };

  Scene.prototype._isoPitch = function () {
    var m = this.model;
    if (!m || !m.W) return 0.46;
    var ratio = m.L / m.W;
    return clamp(0.46 + Math.max(0, ratio - 3.2) * 0.08, 0.46, 0.70);
  };

  Scene.prototype.setSelected = function (seq) {
    this.selectedSeq = seq == null ? null : seq;
    this.requestRender();
  };

  Scene.prototype.setManualMode = function (v) {
    this.manualMode = !!v;
    this.requestRender();
  };

  Scene.prototype._findPlacement = function (seq) {
    var m = this.model;
    if (!m || seq == null) return null;
    for (var i = 0; i < (m.placements || []).length; i++) {
      if (m.placements[i].seq === seq) return m.placements[i];
    }
    return null;
  };

  Scene.prototype._canPlace = function (p, x, y, l, w) {
    var m = this.model;
    if (!m) return false;
    var maxX = m.packingL == null ? m.L : m.packingL;
    if (x < -1e-6 || y < -1e-6 || x + l > maxX + 1e-6 || y + w > m.W + 1e-6) return false;
    for (var i = 0; i < (m.placements || []).length; i++) {
      var q = m.placements[i];
      if (q === p) continue;
      var qg = q.gap || 0;
      if (x < q.x + q.l + qg - 1e-6 && q.x < x + l + (p.gap || 0) - 1e-6 &&
          y < q.y + q.w + qg - 1e-6 && q.y < y + w + (p.gap || 0) - 1e-6) return false;
    }
    return true;
  };

  // 手动拖动吸附：柜内壁 / 其他托盘边缘，阈值 28mm。
  Scene.prototype._snapPosition = function (p, rawX, rawY) {
    var m = this.model;
    if (!m) return { x: rawX, y: rawY, snapped: false };
    var SNAP = 28;
    var maxX = m.packingL == null ? m.L : m.packingL;
    var xs = [0, maxX - p.l];
    var ys = [0, m.W - p.w];
    var yOverlap = function (y0, w, q) {
      return y0 < q.y + q.w - 1e-6 && q.y < y0 + w - 1e-6;
    };
    var xOverlap = function (x0, l, q) {
      return x0 < q.x + q.l - 1e-6 && q.x < x0 + l - 1e-6;
    };
    (m.placements || []).forEach(function (q) {
      if (q === p) return;
      if (yOverlap(rawY, p.w, q)) {
        xs.push(q.x, q.x + q.l + (q.gap || 0), q.x - p.l - (p.gap || 0), q.x + q.l - p.l);
      }
      if (xOverlap(rawX, p.l, q)) {
        ys.push(q.y, q.y + q.w + (q.gap || 0), q.y - p.w - (p.gap || 0), q.y + q.w - p.w);
      }
    });
    function nearest(v, arr, min, max) {
      var best = v, dist = SNAP + 1;
      arr.forEach(function (c) {
        if (c < min - 1e-6 || c > max + 1e-6) return;
        var d = Math.abs(c - v);
        if (d <= SNAP && d < dist) { dist = d; best = c; }
      });
      return best;
    }
    var sx = nearest(rawX, xs, 0, maxX - p.l);
    var sy = nearest(rawY, ys, 0, m.W - p.w);
    var snappedX = Math.abs(sx - rawX) > 1e-6;
    var snappedY = Math.abs(sy - rawY) > 1e-6;
    // 优先同时吸附，其次单轴，最后原始位置；任何组合都不能碰撞/越界。
    var tries = [
      [sx, sy], [rawX, sy], [sx, rawY], [rawX, rawY]
    ];
    for (var i = 0; i < tries.length; i++) {
      if (this._canPlace(p, tries[i][0], tries[i][1], p.l, p.w)) {
        return {
          x: tries[i][0], y: tries[i][1],
          snapped: (Math.abs(tries[i][0] - rawX) > 1e-6 || Math.abs(tries[i][1] - rawY) > 1e-6)
        };
      }
    }
    return { x: rawX, y: rawY, snapped: false };
  };

  // 屏幕点反投影到 z=0 柜底平面，用于把鼠标拖动映射成真实 X/Y 坐标。
  Scene.prototype._screenToFloor = function (clientX, clientY) {
    var cam = this._camera();
    if (!cam || !this.ctx) return null;
    var canvas = this.ctx.canvas;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var px = (clientX - rect.left) * (this._w / rect.width);
    var py = (clientY - rect.top) * (this._h / rect.height);
    var sx = px - (this._w / 2 + this.cam.panX);
    var sy = (this._h / 2 + this.cam.panY) - py;
    var dir = add(mul(cam.forward, cam.focal), add(mul(cam.right, sx), mul(cam.up, sy)));
    if (Math.abs(dir.z) < 1e-6) return null;
    var t = -cam.eye.z / dir.z;
    if (t <= 0) return null;
    return { x: cam.eye.x + dir.x * t, y: cam.eye.y + dir.y * t };
  };

  Scene.prototype._findRotationSpot = function (p, nl, nw) {
    var m = this.model;
    if (!m) return null;
    var ocx = p.x + p.l / 2, ocy = p.y + p.w / 2;
    var maxX = m.packingL == null ? m.L : m.packingL;
    var xs = [p.x, ocx - nl / 2, 0, maxX - nl];
    var ys = [p.y, ocy - nw / 2, 0, m.W - nw];
    (m.placements || []).forEach(function (q) {
      if (q === p) return;
      xs.push(q.x, q.x + q.l + (q.gap || 0), q.x - nl - (p.gap || 0), q.x + q.l - nl);
      ys.push(q.y, q.y + q.w + (q.gap || 0), q.y - nw - (p.gap || 0), q.y + q.w - nw);
    });
    var best = null;
    xs.forEach(function (x) {
      if (x < -1e-6 || x + nl > maxX + 1e-6) return;
      ys.forEach(function (y) {
        if (y < -1e-6 || y + nw > m.W + 1e-6) return;
        if (!this._canPlace(p, x, y, nl, nw)) return;
        var score = Math.pow(x + nl / 2 - ocx, 2) + Math.pow(y + nw / 2 - ocy, 2);
        if (!best || score < best.score - 1e-6 ||
            (Math.abs(score - best.score) < 1e-6 && (x < best.x - 1e-6 || (Math.abs(x - best.x) < 1e-6 && y < best.y - 1e-6)))) {
          best = { x: x, y: y, score: score };
        }
      }, this);
    }, this);
    return best;
  };

  Scene.prototype.moveSelectedToEdge = function (dir) {
    var p = this._findPlacement(this.selectedSeq);
    if (!p || !this.model) return false;
    var m = this.model;
    var nx = p.x, ny = p.y;
    var yHit = function (q) {
      return p.y < q.y + q.w - 1e-6 && q.y < p.y + p.w - 1e-6;
    };
    var xHit = function (q) {
      return p.x < q.x + q.l - 1e-6 && q.x < p.x + p.l - 1e-6;
    };
    if (dir === 'front') {
      nx = 0;
      (m.placements || []).forEach(function (q) {
        if (q === p || !yHit(q)) return;
        if (q.x + q.l + (q.gap || 0) <= p.x + 1e-6) nx = Math.max(nx, q.x + q.l + (q.gap || 0));
      });
    } else if (dir === 'left') {
      ny = 0;
      (m.placements || []).forEach(function (q) {
        if (q === p || !xHit(q)) return;
        if (q.y + q.w + (q.gap || 0) <= p.y + 1e-6) ny = Math.max(ny, q.y + q.w + (q.gap || 0));
      });
    } else if (dir === 'right') {
      ny = m.W - p.w;
      (m.placements || []).forEach(function (q) {
        if (q === p || !xHit(q)) return;
        if (q.y >= p.y + p.w - 1e-6) ny = Math.min(ny, q.y - p.w - (q.gap || 0));
      });
    } else {
      return false;
    }
    nx = Math.round(nx); ny = Math.round(ny);
    if (Math.abs(nx - p.x) < 1e-6 && Math.abs(ny - p.y) < 1e-6) return false;
    if (!this._canPlace(p, nx, ny, p.l, p.w)) return false;
    p.x = nx; p.y = ny;
    if (this.onPlacementChange) this.onPlacementChange(p, true);
    this.requestRender();
    return true;
  };

  Scene.prototype.rotateSelected = function () {
    var p = this._findPlacement(this.selectedSeq);
    if (!p) return false;
    var nl = p.w, nw = p.l;
    var spot = this._findRotationSpot(p, nl, nw);
    if (!spot) return false;
    p.x = Math.round(spot.x); p.y = Math.round(spot.y);
    p.l = nl; p.w = nw;
    p.baseL = nl; p.baseW = nw;
    p.rotated = !p.rotated;
    if (p.layers && p.layers.length) {
      p.layers.forEach(function (layer) {
        var ol = layer.l, ow = layer.w;
        layer.l = ow; layer.w = ol;
        var rx = layer.relX || 0, ry = layer.relY || 0;
        layer.relX = ry; layer.relY = rx;
      });
    }
    if (this.onPlacementChange) this.onPlacementChange(p, true);
    this.requestRender();
    return true;
  };

  Scene.prototype.setShowUpper = function (v) {
    this.showUpper = v !== false;
    this.requestRender();
  };

  Scene.prototype.setAutoRotate = function (dir) {
    this.autoRotate = dir === 1 || dir === -1 ? dir : 0;
    this._tween = null;
    if (this.autoRotate) {
      this.view = 'free';
      if (this.onViewChange) this.onViewChange('free');
    }
    if (this.onAutoRotateChange) this.onAutoRotateChange(this.autoRotate);
    this.requestRender();
  };

  Scene.prototype.setView = function (name, animate) {
    if (this.autoRotate) {
      this.autoRotate = 0;
      if (this.onAutoRotateChange) this.onAutoRotateChange(0);
    }
    var views = {
      iso: { yaw: -2.32, pitch: this._isoPitch() },
      top: { yaw: -Math.PI / 2, pitch: 1.48 },
      front: { yaw: Math.PI, pitch: 0.06 },
      side: { yaw: -Math.PI / 2, pitch: 0.055 },
      door: { yaw: Math.PI, pitch: 0.06 }
    };
    var v = views[name] || views.iso;
    this.view = name;
    if (this.onViewChange) this.onViewChange(name);
    if (animate === false) {
      this.cam.yaw = v.yaw;
      this.cam.pitch = v.pitch;
      this.cam.zoom = 1;
      this.cam.panX = 0;
      this.cam.panY = 0;
      this.requestRender();
      return;
    }
    this._tween = {
      t0: performance.now(),
      dur: 420,
      y0: this.cam.yaw,
      p0: this.cam.pitch,
      y1: v.yaw,
      p1: v.pitch
    };
    this.cam.zoom = 1;
    this.cam.panX = 0;
    this.cam.panY = 0;
    this.requestRender();
  };

  Scene.prototype.resetCamera = function () {
    this.setView('iso');
  };

  Scene.prototype.resize = function () {
    var parent = this.canvas.parentElement;
    if (!parent) return;
    var w = Math.max(80, parent.clientWidth);
    var h = Math.max(80, parent.clientHeight);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this._w === w && this._h === h && this._dpr === dpr) return;
    this._w = w;
    this._h = h;
    this._dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestRender();
  };

  Scene.prototype.requestRender = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () {
      self._raf = null;
      self.draw();
    });
  };

  Scene.prototype._fit = function () {
    var m = this.model;
    if (!m) return;
    var L = m.L || 6000, W = m.W || 2400, H = m.H || 2400;
    var radius = Math.sqrt(L * L + W * W + H * H) * 0.5;
    this.target = vec(L / 2, W / 2, H * 0.33);
    this.baseDist = radius * 2.95;
    this.focal = Math.min(this._w || 800, this._h || 600) * 1.48;
  };

  Scene.prototype._camera = function () {
    var m = this.model;
    if (!m) return null;
    var L = m.L || 6000, W = m.W || 2400, H = m.H || 2400;
    var yaw = this.cam.yaw;
    var pitch = this.cam.pitch;
    var dist = (this.baseDist || Math.max(L, W, H) * 2) / this.cam.zoom;
    var right = vec(-Math.sin(yaw), Math.cos(yaw), 0);
    var forward = norm(vec(
      -Math.cos(yaw) * Math.cos(pitch),
      -Math.sin(yaw) * Math.cos(pitch),
      -Math.sin(pitch)
    ));
    var up = cross(right, forward);
    var eye = sub(this.target, mul(forward, dist));
    return { right: right, up: up, forward: forward, eye: eye, focal: this.focal, dist: dist };
  };

  Scene.prototype._project = function (p, cam) {
    if (!cam) return null;
    var rel = sub(p, cam.eye);
    var z = dot(rel, cam.forward);
    if (z <= 1) return null;
    var x = dot(rel, cam.right);
    var y = dot(rel, cam.up);
    var scale = cam.focal / z;
    return {
      x: this._w / 2 + this.cam.panX + x * scale,
      y: this._h / 2 + this.cam.panY - y * scale,
      z: z,
      scale: scale
    };
  };

  Scene.prototype._poly = function (points, fill, stroke, width) {
    var ctx = this.ctx;
    if (!points.length || points.some(function (p) { return !p; })) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (var i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width || 1; ctx.stroke(); }
  };

  Scene.prototype._line = function (a, b, color, width, dash) {
    if (!a || !b) return;
    var ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    if (dash) ctx.setLineDash(dash);
    ctx.stroke();
    ctx.restore();
  };

  Scene.prototype._pill = function (text, x, y, align, color) {
    var ctx = this.ctx;
    ctx.save();
    ctx.font = '500 11.5px "Segoe UI", "Microsoft YaHei", sans-serif';
    var metrics = ctx.measureText(text);
    var pad = 7;
    var w = metrics.width + pad * 2;
    var h = 22;
    var tx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = color || 'rgba(10, 20, 24, .62)';
    this._roundRect(tx, y - h / 2, w, h, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(248, 238, 225, .9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, tx + pad, y + .5);
    ctx.restore();
  };

  Scene.prototype._roundRect = function (x, y, w, h, r) {
    var ctx = this.ctx;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  Scene.prototype._boxFaces = function (p, color, cam, kind) {
    var x0 = p.x, y0 = p.y, z0 = p.z || 0;
    var x1 = x0 + p.l, y1 = y0 + p.w, z1 = z0 + p.h;
    var pts = [
      vec(x0, y0, z0), vec(x1, y0, z0), vec(x1, y1, z0), vec(x0, y1, z0),
      vec(x0, y0, z1), vec(x1, y0, z1), vec(x1, y1, z1), vec(x0, y1, z1)
    ];
    var faces = [
      { idx: [4, 5, 6, 7], n: vec(0, 0, 1), top: true },
      { idx: [0, 1, 5, 4], n: vec(0, -1, 0) },
      { idx: [1, 2, 6, 5], n: vec(1, 0, 0) },
      { idx: [2, 3, 7, 6], n: vec(0, 1, 0) },
      { idx: [3, 0, 4, 7], n: vec(-1, 0, 0) },
      { idx: [0, 3, 2, 1], n: vec(0, 0, -1) }
    ];
    var self = this;
    var out = [];
    faces.forEach(function (f) {
      var center = vec(0, 0, 0);
      f.idx.forEach(function (i) { center = add(center, mul(pts[i], .25)); });
      var toEye = sub(cam.eye, center);
      if (dot(f.n, toEye) <= 0) return;
      var projected = f.idx.map(function (i) { return self._project(pts[i], cam); });
      if (projected.some(function (q) { return !q; })) return;
      var depth = dot(sub(center, cam.eye), cam.forward);
      var light = Math.max(0, dot(f.n, LIGHT));
      var shade = .67 + light * .34 + (f.top ? .08 : 0);
      if (kind === 'base') shade *= .92;
      out.push({
        points: projected,
        depth: depth,
        fill: rgb(color, shade),
        stroke: rgba([color[0] * .42, color[1] * .42, color[2] * .42], .82),
        top: !!f.top,
        center: center,
        normal: f.n,
        kind: kind,
        placement: p
      });
    });
    return out;
  };

  Scene.prototype._drawWalls = function (cam) {
    var m = this.model;
    if (!m) return;
    var ctx = this.ctx;
    var L = m.L, W = m.W, H = m.H;
    var eye = cam.eye;
    // 只画远离相机的一侧墙，形成“柜内”的深度，不遮挡近处托盘。
    var farX = eye.x < L / 2 ? L : 0;
    var farY = eye.y < W / 2 ? W : 0;

    var wallX = [
      this._project(vec(farX, 0, 0), cam),
      this._project(vec(farX, W, 0), cam),
      this._project(vec(farX, W, H), cam),
      this._project(vec(farX, 0, H), cam)
    ];
    this._poly(wallX, 'rgba(42, 66, 75, .43)', 'rgba(151, 184, 190, .16)', 1);

    var wallY = [
      this._project(vec(0, farY, 0), cam),
      this._project(vec(L, farY, 0), cam),
      this._project(vec(L, farY, H), cam),
      this._project(vec(0, farY, H), cam)
    ];
    this._poly(wallY, 'rgba(35, 57, 65, .38)', 'rgba(151, 184, 190, .12)', 1);

    // 墙面竖向分格，让空柜也有尺度感。
    var step = 1200;
    ctx.save();
    ctx.strokeStyle = 'rgba(146, 178, 184, .07)';
    ctx.lineWidth = 1;
    for (var x = step; x < L; x += step) {
      var a = this._project(vec(x, farY, 0), cam);
      var b = this._project(vec(x, farY, H), cam);
      if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    for (var y = step; y < W; y += step) {
      var c = this._project(vec(farX, y, 0), cam);
      var d = this._project(vec(farX, y, H), cam);
      if (c && d) { ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke(); }
    }
    ctx.restore();
  };

  Scene.prototype._drawFloor = function (cam) {
    var m = this.model;
    if (!m) return;
    var L = m.L, W = m.W;
    var floor = [
      this._project(vec(0, 0, 0), cam),
      this._project(vec(L, 0, 0), cam),
      this._project(vec(L, W, 0), cam),
      this._project(vec(0, W, 0), cam)
    ];
    this._poly(floor, 'rgba(25, 45, 53, .92)', 'rgba(165, 196, 200, .30)', 1.2);

    var ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(159, 191, 195, .085)';
    ctx.lineWidth = 1;
    var step = 500;
    for (var x = step; x < L; x += step) {
      var a = this._project(vec(x, 0, 1), cam);
      var b = this._project(vec(x, W, 1), cam);
      if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    for (var y = step; y < W; y += step) {
      var c = this._project(vec(0, y, 1), cam);
      var d = this._project(vec(L, y, 1), cam);
      if (c && d) { ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke(); }
    }
    ctx.restore();

    // 柜门地标（X=L；X=0 是柜底装载起点）
    var d0 = this._project(vec(L, 0, 3), cam);
    var d1 = this._project(vec(L, W, 3), cam);
    this._line(d0, d1, 'rgba(230, 170, 110, .74)', 2, [7, 5]);
  };

  Scene.prototype._drawDoor = function (cam) {
    var m = this.model;
    if (!m) return;
    var W = m.W, H = m.H;
    var a = this._project(vec(m.L, -90, 0), cam);
    var b = this._project(vec(m.L, 0, 0), cam);
    this._line(a, b, 'rgba(230, 170, 110, .82)', 1.8);
    var arrow = this._project(vec(m.L, -150, H * 0.16), cam);
    if (arrow) this._pill('柜门 →', arrow.x, arrow.y, 'center', 'rgba(120, 71, 36, .88)');
  };

  Scene.prototype._drawBottomLabel = function (cam) {
    var m = this.model;
    if (!m) return;
    var base = this._project(vec(0, m.W / 2, 0), cam);
    var top = this._project(vec(0, m.W / 2, m.H + 80), cam);
    if (base && top) this._line(base, top, 'rgba(146, 178, 184, .30)', 1, [4, 4]);
    var p = this._project(vec(0, m.W / 2, m.H + 130), cam);
    if (p) this._pill('柜底 · 装载起点', p.x, p.y, 'center', 'rgba(44, 70, 80, .92)');
  };

  Scene.prototype._arrow = function (a, b, label, cam, dx, dy, color) {
    var pa = this._project(a, cam);
    var pb = this._project(b, cam);
    if (!pa || !pb) return;
    var ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = color || 'rgba(255, 225, 183, .92)';
    ctx.fillStyle = color || 'rgba(255, 225, 183, .92)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    var ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    var s = 5;
    ctx.beginPath();
    ctx.moveTo(pb.x, pb.y);
    ctx.lineTo(pb.x - s * Math.cos(ang - .55), pb.y - s * Math.sin(ang - .55));
    ctx.lineTo(pb.x - s * Math.cos(ang + .55), pb.y - s * Math.sin(ang + .55));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    var lx = clamp((pa.x + pb.x) / 2 + (dx || 0), 48, this._w - 48);
    var ly = clamp((pa.y + pb.y) / 2 + (dy || 0), 24, this._h - 24);
    this._pill(label, lx, ly, 'center', 'rgba(102, 61, 31, .88)');
  };

  Scene.prototype._cargoMetrics = function () {
    var ps = (this.model && this.model.placements) || [];
    if (!ps.length) return null;
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ps.forEach(function (p) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + p.l);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y + p.w);
    });
    var midY = (minY + maxY) / 2;
    var lower = ps.filter(function (p) { return p.y + p.w / 2 < midY; });
    var upper = ps.filter(function (p) { return p.y + p.w / 2 >= midY; });
    function maxXOf(arr) {
      var v = -Infinity;
      arr.forEach(function (p) { v = Math.max(v, p.x + p.l); });
      return v;
    }
    var lowerLen = maxXOf(lower) - minX;
    var upperLen = maxXOf(upper) - minX;
    if (!isFinite(lowerLen)) lowerLen = maxX - minX;
    if (!isFinite(upperLen)) upperLen = maxX - minX;
    var door = ps.filter(function (p) { return p.x <= minX + 5; });
    var far = ps.filter(function (p) { return p.x + p.l >= maxX - 5; });
    function spanY(arr) {
      if (!arr.length) return maxY - minY;
      var lo = Infinity, hi = -Infinity;
      arr.forEach(function (p) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y + p.w); });
      return hi - lo;
    }
    return {
      minX: minX, maxX: maxX, minY: minY, maxY: maxY,
      length: maxX - minX, width: maxY - minY,
      lowerLen: lowerLen, upperLen: upperLen,
      doorW: spanY(door), farW: spanY(far),
      sideDiff: Math.abs(lowerLen - upperLen) > 5,
      endDiff: Math.abs(spanY(door) - spanY(far)) > 5
    };
  };

  Scene.prototype._drawCargoDims = function (cam) {
    var m = this._cargoMetrics();
    if (!m) return;
    var z = 12;
    var yLen = m.minY - 170;
    if (m.sideDiff) {
      this._arrow(vec(m.minX, m.minY - 170, z), vec(m.minX + m.lowerLen, m.minY - 170, z), '长 ' + Math.round(m.lowerLen), cam, 0, -14);
      this._arrow(vec(m.minX, m.maxY + 170, z), vec(m.minX + m.upperLen, m.maxY + 170, z), '长 ' + Math.round(m.upperLen), cam, 0, 14);
    } else {
      this._arrow(vec(m.minX, yLen, z), vec(m.maxX, yLen, z), '实装长 ' + Math.round(m.length), cam, 0, -14);
    }
    if (m.endDiff) {
      this._arrow(vec(m.minX - 170, m.minY, z), vec(m.minX - 170, m.maxY, z), '宽 ' + Math.round(m.doorW), cam, -22, 0);
      this._arrow(vec(m.maxX + 170, m.minY, z), vec(m.maxX + 170, m.maxY, z), '宽 ' + Math.round(m.farW), cam, 22, 0);
    } else {
      this._arrow(vec(m.minX - 170, m.minY, z), vec(m.minX - 170, m.maxY, z), '实装宽 ' + Math.round(m.width), cam, -22, 0);
    }
  };

  Scene.prototype._drawPalletDims = function (p, cam) {
    var z = (p.stackHeight || p.h * (p.count || 1)) + 14;
    var origL = p.originalL || p.l;
    var origW = p.originalW || p.w;
    var x0 = p.x, y0 = p.y, x1 = p.x + p.l, y1 = p.y + p.w;
    var xLabel = p.rotated ? ('宽 ' + Math.round(origW)) : ('长 ' + Math.round(origL));
    var yLabel = p.rotated ? ('长 ' + Math.round(origL)) : ('宽 ' + Math.round(origW));
    this._arrow(vec(x0, y0, z), vec(x1, y0, z), xLabel, cam, 0, -13);
    this._arrow(vec(x0, y0, z), vec(x0, y1, z), yLabel, cam, -26, 0);
  };

  Scene.prototype._drawFrame = function (cam) {
    var m = this.model;
    if (!m) return;
    var L = m.L, W = m.W, H = m.H;
    var ctx = this.ctx;
    var edges = [
      [[0, 0, 0], [L, 0, 0]], [[0, W, 0], [L, W, 0]],
      [[0, 0, H], [L, 0, H]], [[0, W, H], [L, W, H]],
      [[0, 0, 0], [0, W, 0]], [[L, 0, 0], [L, W, 0]],
      [[0, 0, H], [0, W, H]], [[L, 0, H], [L, W, H]],
      [[0, 0, 0], [0, 0, H]], [[0, W, 0], [0, W, H]],
      [[L, 0, 0], [L, 0, H]], [[L, W, 0], [L, W, H]]
    ];
    ctx.save();
    ctx.strokeStyle = 'rgba(182, 211, 215, .25)';
    ctx.lineWidth = 1;
    edges.forEach(function (e) {
      var a = this._project(vec(e[0][0], e[0][1], e[0][2]), cam);
      var b = this._project(vec(e[1][0], e[1][1], e[1][2]), cam);
      if (a && b) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }, this);

    // 门框更醒目
    ctx.strokeStyle = 'rgba(232, 175, 113, .64)';
    ctx.lineWidth = 1.6;
    var doorEdges = [
      [[0, 0, 0], [0, 0, H]], [[0, W, 0], [0, W, H]],
      [[0, 0, H], [0, W, H]]
    ];
    doorEdges.forEach(function (e) {
      var a = this._project(vec(e[0][0], e[0][1], e[0][2]), cam);
      var b = this._project(vec(e[1][0], e[1][1], e[1][2]), cam);
      if (a && b) {
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }, this);
    ctx.restore();
  };

  Scene.prototype._drawDimensions = function (cam) {
    var m = this.model;
    if (!m) return;
    var L = m.L, W = m.W, H = m.H;
    var edge = Math.min(74, this._w * 0.18);
    function sx(p) { return clamp(p.x, edge, this._w - edge); }
    var a = this._project(vec(L / 2, -190, 0), cam);
    if (a) this._pill('内长 ' + L + ' mm', sx.call(this, a), a.y, 'center');
    var b = this._project(vec(-190, W / 2, 0), cam);
    if (b) this._pill('内宽 ' + W + ' mm', sx.call(this, b), b.y, 'center');
    var c = this._project(vec(L / 2, W + 170, H * 0.92), cam);
    if (c) this._pill('内高 ' + H + ' mm', sx.call(this, c), c.y, 'center');
  };

  Scene.prototype._drawShadow = function (p, cam) {
    var grow = 18;
    var pts = [
      this._project(vec(p.x - grow, p.y - grow, .8), cam),
      this._project(vec(p.x + p.l + grow, p.y - grow, .8), cam),
      this._project(vec(p.x + p.l + grow, p.y + p.w + grow, .8), cam),
      this._project(vec(p.x - grow, p.y + p.w + grow, .8), cam)
    ];
    this._poly(pts, 'rgba(2, 9, 12, .22)', null, 0);
  };

  Scene.prototype._drawTopLabel = function (face, cam) {
    var p = face.placement;
    if (!p || !face.top) return;
    var pts = face.points;
    if (!pts || pts.length < 4) return;
    var e1 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    var e2 = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);
    var minEdge = Math.min(e1, e2);
    if (minEdge < 28) return;
    var a = e1 >= e2 ? pts[0] : pts[1];
    var b = e1 >= e2 ? pts[1] : pts[2];
    var angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    var cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
    var cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
    var font = clamp(minEdge * .17, 7.5, 13.5);
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.font = '600 ' + font.toFixed(1) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 249, 238, .72)';
    var label = (p.code || '') + ((p.count || 1) > 1 ? ' ×' + p.count : '');
    if (label.length > 10) label = label.slice(0, 10) + '…';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };

  Scene.prototype._drawSelection = function (p, cam) {
    var x0 = p.x, y0 = p.y, z0 = p.z || 0;
    var fullH = p.stackHeight || p.h * (p.count || 1);
    var firstH = p.layers && p.layers.length ? p.layers[0].h : p.h;
    var shownH = this.showUpper ? fullH : firstH;
    var x1 = x0 + p.l, y1 = y0 + p.w, z1 = z0 + shownH;
    var edges = [
      [[x0, y0, z0], [x1, y0, z0]], [[x1, y0, z0], [x1, y1, z0]],
      [[x1, y1, z0], [x0, y1, z0]], [[x0, y1, z0], [x0, y0, z0]],
      [[x0, y0, z1], [x1, y0, z1]], [[x1, y0, z1], [x1, y1, z1]],
      [[x1, y1, z1], [x0, y1, z1]], [[x0, y1, z1], [x0, y0, z1]],
      [[x0, y0, z0], [x0, y0, z1]], [[x1, y0, z0], [x1, y0, z1]],
      [[x1, y1, z0], [x1, y1, z1]], [[x0, y1, z0], [x0, y1, z1]]
    ];
    var ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 216, 173, .95)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 5;
    edges.forEach(function (e) {
      var a = this._project(vec(e[0][0], e[0][1], e[0][2]), cam);
      var b = this._project(vec(e[1][0], e[1][1], e[1][2]), cam);
      if (a && b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }, this);
    ctx.restore();
  };

  Scene.prototype.draw = function () {
    var m = this.model;
    var ctx = this.ctx;
    var w = this._w, h = this._h;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    if (this._tween) {
      var tw = this._tween;
      var t = clamp((performance.now() - tw.t0) / tw.dur, 0, 1);
      var k = ease(t);
      this.cam.yaw = lerp(tw.y0, tw.y1, k);
      this.cam.pitch = lerp(tw.p0, tw.p1, k);
      if (t >= 1) this._tween = null;
      else this.requestRender();
    } else if (this.autoRotate) {
      this.cam.yaw += this.autoRotate * .0085;
      this.requestRender();
    }

    if (!m) return;
    this._fit();
    var cam = this._camera();
    if (!cam) return;

    this._drawWalls(cam);
    this._drawFloor(cam);

    var self = this;
    var faceQueue = [];
    var labels = [];
    var shadows = [];

    (m.placements || []).forEach(function (p) {
      shadows.push(p);
      var layers = p.layers && p.layers.length ? p.layers : (function () {
        var arr = [];
        for (var i = 0; i < (p.count || 1); i++) {
          arr.push({ l: p.l, w: p.w, h: p.h, baseH: p.baseH, code: p.code, fill: p.fill, relX: 0, relY: 0, solid: p.solid, color: p.color });
        }
        return arr;
      })();
      var shown = self.showUpper ? layers : layers.slice(0, 1);
      var z0 = 0;
      for (var li = 0; li < shown.length; li++) {
        var layer = shown[li];
        var baseColor = hexToRgb(layer.solid || p.solid || layer.color || '#c2733c');
        var tone = .96 + ((p.seq || 0) % 3) * .025;
        var cargoColor = [baseColor[0] * tone, baseColor[1] * tone, baseColor[2] * tone];
        var inset = Math.min(11, layer.l * .03, layer.w * .03);
        var q = Object.assign({}, p, {
          x: p.x + (layer.relX || 0) + inset,
          y: p.y + (layer.relY || 0) + inset,
          l: Math.max(1, layer.l - inset * 2),
          w: Math.max(1, layer.w - inset * 2),
          h: layer.h,
          baseH: layer.baseH,
          code: layer.code,
          count: shown.length
        });
        if (layer.baseH > 0) {
          var base = Object.assign({}, q, { z: z0, h: layer.baseH });
          var baseFaces = self._boxFaces(base, WOOD, cam, 'base');
          baseFaces.forEach(function (f) { if (f.top) f.fill = rgb(WOOD_TOP, .92); });
          faceQueue.push.apply(faceQueue, baseFaces);
        }
        var cargo = Object.assign({}, q, {
          z: z0 + (layer.baseH || 0),
          h: Math.max(1, layer.h - (layer.baseH || 0)),
          layer: li
        });
        var cargoFaces = self._boxFaces(cargo, cargoColor, cam, 'cargo');
        faceQueue.push.apply(faceQueue, cargoFaces);
        if (li === shown.length - 1) {
          cargoFaces.forEach(function (f) { if (f.top) labels.push(f); });
        }
        z0 += layer.h;
      }
    });

    shadows.forEach(function (p) { self._drawShadow(p, cam); });

    faceQueue.sort(function (a, b) { return b.depth - a.depth; });

    this._hitFaces = [];
    faceQueue.forEach(function (f) {
      self._poly(f.points, f.fill, f.stroke, 1.15);
      if (f.kind === 'cargo') {
        self._hitFaces.push({
          seq: f.placement.seq,
          points: f.points,
          depth: f.depth
        });
      }
    });

    labels.forEach(function (f) { self._drawTopLabel(f, cam); });

    var selected = null;
    if (this.selectedSeq != null) {
      for (var i = 0; i < (m.placements || []).length; i++) {
        if (m.placements[i].seq === this.selectedSeq) { selected = m.placements[i]; break; }
      }
      if (selected) this._drawSelection(selected, cam);
    }

    this._drawFrame(cam);
    this._drawCargoDims(cam);
    this._drawDoor(cam);
    this._drawBottomLabel(cam);

    var dimTargets = [];
    if (selected) {
      dimTargets = [selected];
    } else {
      var seenType = Object.create(null);
      (m.placements || []).forEach(function (p) {
        if (seenType[p.typeId] || dimTargets.length >= 4) return;
        seenType[p.typeId] = true;
        dimTargets.push(p);
      });
    }
    dimTargets.forEach(function (p) { self._drawPalletDims(p, cam); });

    // 选中时给一个轻量的坐标提示
    if (selected) {
      var fullH = selected.stackHeight || selected.h * (selected.count || 1);
      var firstH = selected.layers && selected.layers.length ? selected.layers[0].h : selected.h;
      var totalH = this.showUpper ? fullH : firstH;
      var anchor = this._project(vec(selected.x + selected.l / 2, selected.y + selected.w / 2, totalH), cam);
      if (anchor) {
        var dl = selected.originalL || selected.l;
        var dw = selected.originalW || selected.w;
        this._pill(
          'P' + String(selected.seq).padStart(2, '0') + ' · ' + Math.round(dl) + '×' + Math.round(dw) + '×' + Math.round(totalH) + ((selected.count || 1) > 1 ? ' · ' + selected.count + '托/垛' : ''),
          anchor.x, anchor.y - 16, 'center', 'rgba(120, 71, 36, .9)'
        );
      }
    }

    this._hitFaces.sort(function (a, b) { return a.depth - b.depth; });
  };

  Scene.prototype._clampPan = function () {
    var maxX = Math.max(120, this._w * .7);
    var maxY = Math.max(120, this._h * .7);
    this.cam.panX = clamp(this.cam.panX, -maxX, maxX);
    this.cam.panY = clamp(this.cam.panY, -maxY, maxY);
  };

  Scene.prototype._pointInPoly = function (pt, poly) {    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var xi = poly[i].x, yi = poly[i].y;
      var xj = poly[j].x, yj = poly[j].y;
      var intersect = ((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || .00001) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  };

  Scene.prototype._pick = function (x, y) {
    for (var i = 0; i < this._hitFaces.length; i++) {
      var f = this._hitFaces[i];
      if (this._pointInPoly({ x: x, y: y }, f.points)) return f.seq;
    }
    return null;
  };

  Scene.prototype._bind = function () {
    var self = this;
    var canvas = this.canvas;
    canvas.style.cursor = 'grab';

    function updatePointers(e) {
      if (self._pointers.has(e.pointerId)) {
        self._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
    }

    function onMove(e) {
      updatePointers(e);
      if (self._pinch && self._pointers.size === 2) {
        var pts = Array.from(self._pointers.values());
        var cx = (pts[0].x + pts[1].x) / 2;
        var cy = (pts[0].y + pts[1].y) / 2;
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (self._pinch.center) {
          self.cam.panX += cx - self._pinch.center.x;
          self.cam.panY += cy - self._pinch.center.y;
        }
        self._pinch.center = { x: cx, y: cy };
        if (self._pinch.dist > 0) {
          self.cam.zoom = clamp(self._pinch.zoom * (d / self._pinch.dist), .5, 3.2);
          self._clampPan();
          self.requestRender();
        }
        return;
      }
      if (!self._drag) return;
      var dx = e.clientX - self._drag.x;
      var dy = e.clientY - self._drag.y;
      var totalDx = e.clientX - self._drag.startX;
      var totalDy = e.clientY - self._drag.startY;
      if (Math.abs(totalDx) + Math.abs(totalDy) > 3) {
        self._drag.moved = true;
      }
      if (self._drag.mode === 'pallet') {
        var fp = self._screenToFloor(e.clientX, e.clientY);
        if (!fp || !self._drag.placement) return;
        var pl = self._drag.placement;
        var nx = Math.round((self._drag.startFloor.x + (fp.x - self._drag.startFloor.x)) / 10) * 10;
        var ny = Math.round((self._drag.startFloor.y + (fp.y - self._drag.startFloor.y)) / 10) * 10;
        nx = clamp(nx, 0, self.model.L - pl.l);
        ny = clamp(ny, 0, self.model.W - pl.w);
        var sp = self._snapPosition(pl, nx, ny);
        nx = sp.x;
        ny = sp.y;
        self._drag.snapped = sp.snapped;
        if (self._canPlace(pl, nx, ny, pl.l, pl.w)) {
          pl.x = nx; pl.y = ny;
          self._drag.blocked = false;
          canvas.style.cursor = 'grabbing';
          if (self.onPlacementChange) self.onPlacementChange(pl, false);
        } else {
          if (!self._drag.blocked && self.onPlacementBlocked) self.onPlacementBlocked(pl);
          self._drag.blocked = true;
          canvas.style.cursor = 'not-allowed';
        }
        self._drag.x = e.clientX;
        self._drag.y = e.clientY;
        self.requestRender();
        return;
      }
      if (self._drag.mode === 'pan') {
        self.cam.panX += dx;
        self.cam.panY += dy;
        self._clampPan();
      } else {
        // 用“从按下点到当前点”的总位移，而不是每帧增量，避免小步拖动被吃掉。
        self.cam.yaw = self._drag.yaw + totalDx * .0075;
        self.cam.pitch = clamp(self._drag.pitch + totalDy * .006, .06, 1.50);
        self.view = 'free';
        if (self.onViewChange) self.onViewChange('free');
      }
      self._drag.x = e.clientX;
      self._drag.y = e.clientY;
      self.requestRender();
    }

    function onUp(e) {
      var wasDrag = self._drag && self._drag.moved;
      self._pointers.delete(e.pointerId);
      if (self._pointers.size < 2) self._pinch = null;
      if (self._pointers.size === 0 && self._drag) {
        if (self._drag.mode === 'pallet') {
          if (self._drag.moved && self._drag.placement && self.onPlacementChange) {
            self.onPlacementChange(self._drag.placement, true);
          }
          if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
            try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
          }
          canvas.style.cursor = self.manualMode ? 'grab' : 'grab';
          self._drag = null;
          return;
        }
        if (!wasDrag && e.type === 'pointerup' && self._drag.button === 0) {
          var rect = canvas.getBoundingClientRect();
          var seq = self._pick(e.clientX - rect.left, e.clientY - rect.top);
          if (self.onSelect) self.onSelect(seq);
        }
        if (canvas.hasPointerCapture && canvas.hasPointerCapture(e.pointerId)) {
          try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        canvas.style.cursor = 'grab';
        self._drag = null;
      } else if (self._pointers.size === 1 && self._drag) {
        // 双指松开一根后，剩下那根继续单指旋转。
        var p = Array.from(self._pointers.values())[0];
        self._drag = {
          x: p.x, y: p.y, startX: p.x, startY: p.y,
          yaw: self.cam.yaw, pitch: self.cam.pitch,
          mode: 'orbit', button: 0, moved: true
        };
        self._pinch = null;
      }
    }

    canvas.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      if (self.autoRotate) self.setAutoRotate(0);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      self._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var panMode = e.button === 1 || e.button === 2 || e.shiftKey;
      if (self._pointers.size === 1) {
        var manualSeq = null;
        if (self.manualMode && !panMode && e.button === 0) {
          var mrect = canvas.getBoundingClientRect();
          manualSeq = self._pick(e.clientX - mrect.left, e.clientY - mrect.top);
        }
        if (manualSeq != null) {
          var mp = self._findPlacement(manualSeq);
          var floor = self._screenToFloor(e.clientX, e.clientY);
          if (mp && floor) {
            if (self.onSelect) self.onSelect(manualSeq);
            self._drag = {
              x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
              mode: 'pallet', button: e.button, moved: false, blocked: false,
              placement: mp, startFloor: floor
            };
            canvas.style.cursor = 'grabbing';
            if (e.cancelable) e.preventDefault();
            return;
          }
        }
        self._drag = {
          x: e.clientX,
          y: e.clientY,
          startX: e.clientX,
          startY: e.clientY,
          yaw: self.cam.yaw,
          pitch: self.cam.pitch,
          mode: panMode ? 'pan' : 'orbit',
          button: e.button,
          moved: false
        };
        canvas.style.cursor = panMode ? 'move' : 'grabbing';
      } else if (self._pointers.size === 2) {
        var pts = Array.from(self._pointers.values());
        self._pinch = {
          dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
          zoom: self.cam.zoom,
          center: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
        };
        if (self._drag) self._drag.moved = true;
      }
      if (e.cancelable) e.preventDefault();
    });

    // 监听 window：即使 pointer capture 不被支持/被浏览器取消，拖拽也不会中断。
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.cam.zoom = clamp(self.cam.zoom * Math.exp(-e.deltaY * .0011), .5, 3.2);
      self._clampPan();
      self.requestRender();
    }, { passive: false });

    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    canvas.addEventListener('dblclick', function () {
      self.resetCamera();
    });
  };

  root.CL_SCENE = { Scene: Scene };
})(typeof window !== 'undefined' ? window : globalThis);
