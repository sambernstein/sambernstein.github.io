/*
 * Background: Conway's Game of Life coupled to a growth curve.
 *
 * The curve is a generalized logistic (Richards) curve. What fits on screen is
 * mostly its exponential stretch: it climbs steeply and only begins to bend
 * toward its ceiling at the top edge. Two gentle grooves interrupt the climb,
 * places where progress briefly slows before resuming. Near the top it divides
 * into three: one that keeps steepening, one that bends toward its ceiling,
 * and one that rolls over. Only the second has light behind it.
 *
 * Whenever a cell is born within two tiles of the curve, the curve takes it
 * up and answers with a climb: a trail of new cells sparking up its length,
 * led by a pulse of light. Whatever touches the curve gets carried up it.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('field');
  var ctx = canvas.getContext('2d', { alpha: false });
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- Tunables -----

  var BG = '#060a09';
  var STEP_MS = 150;          // one generation
  var BAND = 2;               // births within this many tiles of the curve trigger it
  var COOLDOWN = 24;          // generations before a stretch of curve can start another climb
  var ABSORB = 3;             // radius (tiles) taken up by the curve on contact
  var HOT = 0.3;              // cells this warm descend from the curve's own sparks
  var HOP = 3;                // tiles a climb advances per generation
  var CLIMB_MIN = 8, CLIMB_VAR = 10;
  var MAX_CLIMBS = 4;
  var SPACING = 3;            // px between curve samples
  var PULSE_TAIL = 140;       // px
  var MAX_PULSES = 14;

  // Curve shape (in the curve's own units; see buildCurve)
  var NU = 7;                 // asymmetry: larger pushes the bend toward the ceiling
  var P_TOP = 0.975;          // fraction of the ceiling reached at the top edge
  var GROOVES = [             // h: height (fraction of ceiling), w: width, m: how much it slows
    { h: 0.12, w: 1.0, m: 2.2 },
    { h: 0.40, w: 0.9, m: 1.8 }
  ];
  var BRANCH_H = 0.52;        // height (fraction of screen) where the curve divides
  var CURVE_DIM = 0.88;       // overall strength of the curve and its pulses

  // ----- State -----

  var W = 0, H = 0, dpr = 1, cell = 14, cols = 0, rows = 0, n = 0;
  var cur, nxt, prev, heat, heatNxt, vis;
  var band, nearest;
  var curveX, curveY, curveN = 0, bucketLen = 1;
  var paths = [], branchAt = 0;  // [main, steep, rollover]; all share the trunk up to branchAt
  var nearestPath;
  var layer;
  var pulses = [], climbs = [];
  var hopSamples = 1, pulseSpeed = 300;
  var generation = 0, lastTriggerGen = 0, lastAmbientGen = 0;
  var lastStep = 0, lastFrame = 0;

  // ----- Curve -----

  function f(t) { return Math.pow(1 + Math.exp(-t), -1 / NU); }
  function fInv(h) { return -Math.log(Math.pow(h, -NU) - 1); }
  function sig(z) { return 1 / (1 + Math.exp(-z)); }

  function buildCurve() {
    var mobile = W <= 760;
    var xTop;
    if (mobile) {
      xTop = W * 0.8;
    } else {
      var projects = document.querySelector('.projects');
      var right = projects ? projects.getBoundingClientRect().right : W * 0.8;
      xTop = Math.min(W * 0.93, Math.max(W * 0.86, right + (W - right) * 0.45));
    }
    var yTop = -2;
    var yBase = H - Math.max(16, H * 0.03);
    var tTop = fInv(P_TOP);
    var sy = (yBase - yTop) / P_TOP;

    // Grooves stretch the x-axis locally (time passes more slowly there),
    // which flattens the climb into a soft S before it resumes.
    var grooves = GROOVES.map(function (g) {
      return { c: fInv(g.h), w: g.w, a: 4 * g.w * g.m };
    });
    function X(t) {
      var s = t;
      for (var i = 0; i < grooves.length; i++) {
        s += grooves[i].a * sig((t - grooves[i].c) / grooves[i].w);
      }
      return s;
    }

    // Horizontal scale: the visible rise (from 2% of ceiling to the top) spans
    // a fixed share of the screen, so the curve reads the same on any aspect.
    var riseWidth = mobile ? W * 0.68 : Math.min(W * 0.28, 560);
    var sx = riseWidth / (X(tTop) - X(fInv(0.02)));
    var XTop = X(tTop);

    var raw = [];
    for (var t = tTop; ; t -= 0.01) {
      var x = xTop - sx * (XTop - X(t));
      raw.push(x, yBase - sy * f(t));
      if (x < -cell * 4) break;
    }

    // Resample bottom → top at even arc length.
    var xs = [], ys = [];
    var px = raw[raw.length - 2], py = raw[raw.length - 1];
    xs.push(px); ys.push(py);
    var carry = 0;
    for (var k = raw.length - 4; k >= 0; k -= 2) {
      var qx = raw[k], qy = raw[k + 1];
      var seg = Math.hypot(qx - px, qy - py);
      while (carry + seg >= SPACING) {
        var r = (SPACING - carry) / seg;
        px += (qx - px) * r;
        py += (qy - py) * r;
        seg = Math.hypot(qx - px, qy - py);
        carry = 0;
        xs.push(px); ys.push(py);
      }
      carry += seg;
      px = qx; py = qy;
    }
    curveX = Float32Array.from(xs);
    curveY = Float32Array.from(ys);
    curveN = xs.length;

    // Where it divides
    var yb = yBase - BRANCH_H * (yBase - yTop);
    branchAt = curveN - 1;
    for (var b = 0; b < curveN; b++) {
      if (curveY[b] <= yb) { branchAt = b; break; }
    }
    var room = W - curveX[branchAt];
    var rise = curveY[branchAt] - yTop;

    // The main branch bends toward its ceiling, leaving the top edge about
    // 60% of the way across the space to its right, clear of the steep branch.
    var mainLen = rise * 1.1;
    var mainTarget = curveX[branchAt] + room * 0.62;
    var lo = 0.2, hi = Math.PI / 2;
    for (var it = 0; it < 24; it++) {
      var mid = (lo + hi) / 2;
      var trial = steer(curveX, curveY, mid, mainLen);
      if (trial.x[trial.x.length - 1] > mainTarget) lo = mid; else hi = mid;
    }

    paths = [
      makePath(steer(curveX, curveY, (lo + hi) / 2, mainLen), false),
      // keeps steepening, straight up and out of frame
      makePath(steer(curveX, curveY, Math.PI / 2 - 0.03, rise * 0.25), true),
      // levels off early, then sags a little
      makePath(steer(curveX, curveY, -0.11, Math.max(70, Math.min(room * 1.5, H * 0.45))), true)
    ];

    bucketLen = Math.max(1, Math.round((cell * 3) / SPACING));
    hopSamples = Math.round((HOP * cell) / SPACING);
    pulseSpeed = (hopSamples * SPACING) / (STEP_MS / 1000);  // pulses keep pace with climbs
    paths.forEach(function (p) {
      p.lastFire = new Int32Array(Math.ceil(p.n / bucketLen) + 1).fill(-1000);
    });
  }

  // Follow the curve up to branchAt, then ease the heading toward `turn`
  // (radians) over `len` px until leaving the screen.
  function steer(xs, ys, turn, len) {
    var b = branchAt;
    var bx = Array.from(xs.subarray(0, b + 1));
    var by = Array.from(ys.subarray(0, b + 1));
    var th0 = Math.atan2(-(ys[b + 2] - ys[b - 2]), xs[b + 2] - xs[b - 2]);
    var x = xs[b], y = ys[b];
    for (var d = SPACING; d < 6000; d += SPACING) {
      var u = Math.min(1, d / len);
      var th = th0 + (turn - th0) * u * u * (3 - 2 * u);
      x += Math.cos(th) * SPACING;
      y -= Math.sin(th) * SPACING;
      bx.push(x); by.push(y);
      if (y < -4 || x > W + 4 || y > H + 4) break;
    }
    return { x: bx, y: by };
  }

  // Side branches fade along their length; the main one doesn't.
  function makePath(pts, fades) {
    var n2 = pts.x.length;
    var fade = new Float32Array(n2).fill(1);
    if (fades) {
      for (var k = branchAt; k < n2; k++) {
        var v = (k - branchAt) / (n2 - 1 - branchAt);
        fade[k] = 1 - 0.7 * v * v * (3 - 2 * v);
      }
    }
    return { x: Float32Array.from(pts.x), y: Float32Array.from(pts.y), n: n2, fade: fade };
  }

  function buildBand() {
    band = new Uint8Array(n).fill(255);
    nearest = new Int32Array(n).fill(-1);
    nearestPath = new Uint8Array(n);
    for (var p = 0; p < paths.length; p++) {
      // Branches only need their own samples; the trunk is covered by path 0.
      for (var s = p === 0 ? 0 : branchAt + 1; s < paths[p].n; s++) {
        markBand(p, s);
      }
    }
  }

  function markBand(p, s) {
    var cx = Math.floor(paths[p].x[s] / cell);
    var cy = Math.floor(paths[p].y[s] / cell);
    for (var dy = -BAND; dy <= BAND; dy++) {
      var gy = cy + dy;
      if (gy < 0 || gy >= rows) continue;
      for (var dx = -BAND; dx <= BAND; dx++) {
        var gx = cx + dx;
        if (gx < 0 || gx >= cols) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        var i = gy * cols + gx;
        if (d < band[i] || (d === band[i] && p === nearestPath[i] && s > nearest[i])) {
          band[i] = d;
          nearest[i] = s;
          nearestPath[i] = p;
        }
      }
    }
  }

  // Static layer: faint lattice, the light behind the main branch, the area
  // under the curve, and the curve itself.
  function renderLayer() {
    layer = document.createElement('canvas');
    layer.width = Math.round(W * dpr);
    layer.height = Math.round(H * dpr);
    var g = layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    var k = CURVE_DIM;
    var main = paths[0];

    // Lattice points at cell corners
    g.fillStyle = 'rgba(167, 243, 208, 0.045)';
    for (var y = cell; y < H; y += cell) {
      for (var x = cell; x < W; x += cell) {
        g.fillRect(x - 0.5, y - 0.5, 1, 1);
      }
    }

    // A faint dawn just beyond where the main branch leaves the frame.
    var ex = main.x[main.n - 1];
    var rx = Math.max(80, Math.min(W * 0.11, 210));
    var ry = H * 0.42;
    g.save();
    g.translate(ex + rx * 0.6, -H * 0.04);
    g.scale(1, ry / rx);
    var dawn = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    dawn.addColorStop(0, 'rgba(238, 228, 200, 0.085)');
    dawn.addColorStop(0.4, 'rgba(226, 232, 206, 0.04)');
    dawn.addColorStop(1, 'rgba(210, 236, 214, 0)');
    g.fillStyle = dawn;
    g.fillRect(-rx, -rx, rx * 2, rx * 2);
    g.restore();

    function trace(P, from) {
      g.beginPath();
      g.moveTo(P.x[from], P.y[from]);
      for (var s = from + 1; s < P.n; s++) g.lineTo(P.x[s], P.y[s]);
    }

    // Area under the main curve
    trace(main, 0);
    g.lineTo(main.x[main.n - 1] + W, main.y[main.n - 1]);
    g.lineTo(W + 10, H + 10);
    g.lineTo(main.x[0], H + 10);
    g.closePath();
    var fill = g.createLinearGradient(0, 0, 0, H);
    fill.addColorStop(0, 'rgba(110, 231, 183, ' + (0.045 * k) + ')');
    fill.addColorStop(1, 'rgba(110, 231, 183, 0)');
    g.fillStyle = fill;
    g.fill();

    g.lineJoin = 'round';
    g.lineCap = 'round';

    // Branches first, so the main line sits on top where they part. Each takes
    // its own hue as it leaves: the steep one cooler, the other greyer.
    var hues = [null, [150, 214, 226], [132, 160, 148]];
    for (var p = 1; p < paths.length; p++) {
      var P = paths[p], b = Math.max(0, branchAt - 1), end = P.n - 1;
      var c = hues[p].join(', ');
      var grad = g.createLinearGradient(P.x[b], P.y[b], P.x[end], P.y[end]);
      grad.addColorStop(0, 'rgba(110, 231, 183, ' + (0.41 * k) + ')');
      grad.addColorStop(0.35, 'rgba(' + c + ', ' + (0.34 * k) + ')');
      grad.addColorStop(1, 'rgba(' + c + ', ' + (0.12 * k) + ')');
      trace(P, b);
      g.strokeStyle = 'rgba(110, 231, 183, ' + (0.035 * k) + ')';
      g.lineWidth = 7;
      g.stroke();
      g.strokeStyle = grad;
      g.lineWidth = 1.1;
      g.stroke();
    }

    // Main curve: emerald at the base, paler toward the top, warming slightly
    // where it starts to bend.
    var stroke = g.createLinearGradient(0, H, 0, 0);
    stroke.addColorStop(0, 'rgba(52, 211, 153, ' + (0.22 * k) + ')');
    stroke.addColorStop(0.55, 'rgba(110, 231, 183, ' + (0.42 * k) + ')');
    stroke.addColorStop(0.85, 'rgba(190, 242, 214, ' + (0.55 * k) + ')');
    stroke.addColorStop(1, 'rgba(240, 228, 196, ' + (0.62 * k) + ')');

    trace(main, 0);
    g.strokeStyle = 'rgba(52, 211, 153, ' + (0.05 * k) + ')';
    g.lineWidth = 9;
    g.stroke();
    g.strokeStyle = 'rgba(110, 231, 183, ' + (0.07 * k) + ')';
    g.lineWidth = 3.5;
    g.stroke();
    g.strokeStyle = stroke;
    g.lineWidth = 1.25;
    g.stroke();
  }

  // ----- Grid -----

  function alloc(oldCols, oldRows, oldCur) {
    cur = new Uint8Array(n);
    nxt = new Uint8Array(n);
    prev = new Uint8Array(n);
    heat = new Float32Array(n);
    heatNxt = new Float32Array(n);
    vis = new Float32Array(n);
    if (oldCur) {
      for (var y = 0; y < Math.min(rows, oldRows); y++) {
        for (var x = 0; x < Math.min(cols, oldCols); x++) {
          cur[y * cols + x] = oldCur[y * oldCols + x];
          vis[y * cols + x] = oldCur[y * oldCols + x];
        }
      }
    }
  }

  function idx(x, y) {
    x = ((x % cols) + cols) % cols;
    y = ((y % rows) + rows) % rows;
    return y * cols + x;
  }

  function setLive(x, y, h) {
    var i = idx(x, y);
    cur[i] = 1;
    heat[i] = Math.max(heat[i], h || 0);
  }

  // Glider travelling diagonally in direction (dx, dy), each ±1.
  function placeGlider(x, y, dx, dy, h) {
    var shape = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
    for (var k = 0; k < shape.length; k++) {
      var sx = dx === 1 ? shape[k][0] : 2 - shape[k][0];
      var sy = dy === 1 ? shape[k][1] : 2 - shape[k][1];
      setLive(x - 1 + sx, y - 1 + sy, h);
    }
  }

  function sampleAtHeight(frac) {
    var P = paths[0];
    var target = P.y[0] - frac * (P.y[0] - P.y[P.n - 1]);
    for (var s = 0; s < P.n; s++) if (P.y[s] <= target) return s;
    return P.n - 1;
  }

  // Launch a glider from `dist` tiles away so that it runs into curve sample s.
  function launchToward(s, dist) {
    var tx = Math.floor(paths[0].x[s] / cell);
    var ty = Math.floor(paths[0].y[s] / cell);
    var dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    dirs.sort(function () { return Math.random() - 0.5; });
    for (var k = 0; k < dirs.length; k++) {
      var dx = dirs[k][0], dy = dirs[k][1];
      var x0 = tx - dx * dist, y0 = ty - dy * dist;
      if (x0 < 2 || y0 < 2 || x0 > cols - 3 || y0 > rows - 3) continue;
      if (band[y0 * cols + x0] !== 255) continue;
      placeGlider(x0, y0, dx, dy, 0);
      return true;
    }
    return false;
  }

  // A spark on path p at sample s: three cells on a diagonal through it.
  // Under Life's rules it flares for a generation or two and leaves nothing.
  function spark(p, s) {
    var cx = Math.floor(paths[p].x[s] / cell);
    var cy = Math.floor(paths[p].y[s] / cell);
    var d = Math.random() < 0.5 ? 1 : -1;
    for (var k = -1; k <= 1; k++) {
      var x = cx + k, y = cy + k * d;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      var i = y * cols + x;
      cur[i] = 1;
      heat[i] = 1;
    }
  }

  // Whatever touches the curve is taken up into it.
  function absorb(i) {
    var cx = i % cols, cy = (i / cols) | 0;
    for (var dy = -ABSORB; dy <= ABSORB; dy++) {
      for (var dx = -ABSORB; dx <= ABSORB; dx++) {
        var x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        var j = y * cols + x;
        if (cur[j] && heat[j] < HOT) cur[j] = 0;
      }
    }
  }

  function addPulse(p, s, strength) {
    if (pulses.length >= MAX_PULSES) pulses.shift();
    pulses.push({ path: p, pos: s, life: strength });
  }

  // ----- Evolution -----

  function step() {
    generation++;
    var triggers = [];
    var population = 0;

    for (var y = 0; y < rows; y++) {
      var ro = y * cols;
      var ru = ((y - 1 + rows) % rows) * cols;
      var rd = ((y + 1) % rows) * cols;
      for (var x = 0; x < cols; x++) {
        var xl = x === 0 ? cols - 1 : x - 1;
        var xr = x === cols - 1 ? 0 : x + 1;
        var sum = cur[ru + xl] + cur[ru + x] + cur[ru + xr] +
                  cur[ro + xl] + cur[ro + xr] +
                  cur[rd + xl] + cur[rd + x] + cur[rd + xr];
        var i = ro + x;
        var alive = cur[i];
        var live = (sum === 3 || (alive && sum === 2)) ? 1 : 0;
        nxt[i] = live;
        if (!live) {
          heatNxt[i] = 0;
          continue;
        }
        population++;
        if (alive) {
          heatNxt[i] = heat[i] * 0.9;
        } else {
          // Births inherit a little warmth from their parents.
          var h = Math.max(heat[ru + xl], heat[ru + x], heat[ru + xr],
                           heat[ro + xl], heat[ro + xr],
                           heat[rd + xl], heat[rd + x], heat[rd + xr]);
          heatNxt[i] = h * 0.85;
          // A birth near the curve. Skip cells that were alive two
          // generations ago so blinkers don't fire it forever.
          if (band[i] <= BAND && !prev[i]) triggers.push(i);
        }
      }
    }

    var t = prev; prev = cur; cur = nxt; nxt = t;
    var th = heat; heat = heatNxt; heatNxt = th;

    // Let the curve answer: each new contact starts a climb.
    for (var q = 0; q < triggers.length; q++) {
      var ti = triggers[q];
      if (heat[ti] >= HOT) continue;  // the curve's own sparks don't re-trigger it
      absorb(ti);
      lastTriggerGen = generation;
      var s = nearest[ti];
      var p = nearestPath[ti];
      var lastFire = paths[p].lastFire;
      var b = Math.floor(s / bucketLen);
      if (generation - lastFire[b] < COOLDOWN || climbs.length >= MAX_CLIMBS) continue;
      for (var bb = Math.max(0, b - 2); bb <= Math.min(lastFire.length - 1, b + 2); bb++) {
        lastFire[bb] = generation;
      }
      // Below the divide, which future a climb follows is left to chance.
      if (s < branchAt) p = Math.floor(Math.random() * paths.length);
      climbs.push({ path: p, pos: s, hops: CLIMB_MIN + Math.floor(Math.random() * CLIMB_VAR) });
      addPulse(p, s, 1);
    }

    // Climbs leave a trail of sparks up the curve, then burn out.
    for (var c = climbs.length - 1; c >= 0; c--) {
      var cl = climbs[c];
      cl.pos += hopSamples;
      if (cl.pos >= paths[cl.path].n || --cl.hops < 0) {
        climbs.splice(c, 1);
        continue;
      }
      spark(cl.path, cl.pos);
    }

    // When things go quiet, send something toward the curve.
    if (generation - lastTriggerGen > 30 && generation - lastAmbientGen > 40 && population < n * 0.03) {
      lastAmbientGen = generation;
      launchToward(sampleAtHeight(0.08 + Math.random() * 0.8), 5 + Math.floor(Math.random() * 6));
    }
  }

  // ----- Drawing -----

  function draw(dt) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    var up = 1 - Math.exp(-dt / 70);     // fade in
    var down = 1 - Math.exp(-dt / 420);  // slow afterglow
    var inset = cell > 12 ? 1.5 : 1.25;
    var size = cell - inset * 2;

    for (var i = 0; i < n; i++) {
      var target = cur[i];
      var v = vis[i];
      if (v === 0 && !target) continue;
      v += (target - v) * (target ? up : down);
      if (!target && v < 0.01) v = 0;
      vis[i] = v;
      if (v === 0) continue;
      var h = heat[i];
      var r = 38 + 120 * h, gr = 150 + 95 * h, bl = 112 + 95 * h;
      var a = v * (0.26 + 0.3 * h);
      ctx.fillStyle = 'rgba(' + (r | 0) + ',' + (gr | 0) + ',' + (bl | 0) + ',' + a.toFixed(3) + ')';
      ctx.fillRect((i % cols) * cell + inset, ((i / cols) | 0) * cell + inset, size, size);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Pulses running up the curve
    if (pulses.length) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      var advance = (pulseSpeed * dt / 1000) / SPACING;
      var tail = PULSE_TAIL / SPACING;
      for (var p = pulses.length - 1; p >= 0; p--) {
        var pu = pulses[p];
        var P = paths[pu.path];
        pu.pos += advance;
        pu.life -= dt / 2600;
        if (pu.life <= 0 || pu.pos - tail >= P.n) {
          pulses.splice(p, 1);
          continue;
        }
        var head = Math.min(Math.floor(pu.pos), P.n - 1);
        var start = Math.max(0, Math.floor(pu.pos - tail));
        for (var s = start; s < head; s++) {
          var u = (s - (pu.pos - tail)) / tail;
          var al = pu.life * u * u * 0.85 * CURVE_DIM * P.fade[s];
          if (al < 0.01) continue;
          ctx.strokeStyle = 'rgba(190, 255, 225, ' + al.toFixed(3) + ')';
          ctx.lineWidth = 1.2 + 1.6 * u;
          ctx.beginPath();
          ctx.moveTo(P.x[s], P.y[s]);
          ctx.lineTo(P.x[s + 1], P.y[s + 1]);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ----- Setup -----

  function resize(force) {
    var w = canvas.clientWidth, h = canvas.clientHeight;
    var d = Math.min(window.devicePixelRatio || 1, 2);
    if (!force && w === W && h === H && d === dpr) return;

    var oldCols = cols, oldRows = rows, oldCur = cur;
    var newCell = w <= 760 ? 11 : 14;
    if (newCell !== cell) oldCur = null;

    W = w; H = h; dpr = d; cell = newCell;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    cols = Math.ceil(W / cell);
    rows = Math.ceil(H / cell);
    n = cols * rows;

    alloc(oldCols, oldRows, oldCur);
    buildCurve();
    buildBand();
    renderLayer();
    pulses = [];
    climbs = [];
    return !oldCur;
  }

  function seedInitial() {
    // A few gliders already en route, timed to reach the curve one after another.
    launchToward(sampleAtHeight(0.3), 3);
    launchToward(sampleAtHeight(0.62), 6);
    launchToward(sampleAtHeight(0.12), 9);
    launchToward(sampleAtHeight(0.85), 13);
  }

  function onClick(e) {
    if (e.target.closest && e.target.closest('a, button')) return;
    var gx = Math.floor(e.clientX / cell);
    var gy = Math.floor(e.clientY / cell);
    // Aim the new glider at the nearest point on the curve.
    var bx = 0, by = 0, bestD = Infinity;
    for (var p = 0; p < paths.length; p++) {
      var P = paths[p];
      for (var s = 0; s < P.n; s += 2) {
        var dd = (P.x[s] - e.clientX) * (P.x[s] - e.clientX) + (P.y[s] - e.clientY) * (P.y[s] - e.clientY);
        if (dd < bestD) { bestD = dd; bx = P.x[s]; by = P.y[s]; }
      }
    }
    var dx = bx >= e.clientX ? 1 : -1;
    var dy = by >= e.clientY ? 1 : -1;
    placeGlider(gx, gy, dx, dy, 0.6);
  }

  function frame(now) {
    var dt = Math.min(64, now - (lastFrame || now));
    lastFrame = now;
    if (now - lastStep >= STEP_MS) {
      step();
      lastStep = now;
    }
    draw(dt);
    requestAnimationFrame(frame);
  }

  resize(true);
  seedInitial();

  if (reduceMotion) {
    for (var i = 0; i < n; i++) vis[i] = cur[i];
    draw(0);
    window.addEventListener('resize', function () { resize(false); draw(0); });
    return;
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (resize(false)) seedInitial();
    }, 120);
  });
  document.addEventListener('click', onClick);

  // Fonts shift the layout slightly once loaded; the curve keys off it.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { buildCurve(); buildBand(); renderLayer(); });
  }

  requestAnimationFrame(frame);
})();
