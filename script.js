/*
 * Background: Conway's Game of Life coupled to a growth curve.
 *
 * The curve is a generalized logistic (Richards) curve. What fits on screen is
 * mostly its exponential stretch: it climbs steeply and only begins to bend
 * toward its ceiling at the top edge. Two gentle grooves interrupt the climb,
 * places where progress briefly slows before resuming.
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

  // ----- State -----

  var W = 0, H = 0, dpr = 1, cell = 14, cols = 0, rows = 0, n = 0;
  var cur, nxt, prev, heat, heatNxt, vis;
  var band, nearest;
  var curveX, curveY, curveN = 0, bucketLen = 1;
  var lastFire;
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

    bucketLen = Math.max(1, Math.round((cell * 3) / SPACING));
    hopSamples = Math.round((HOP * cell) / SPACING);
    pulseSpeed = (hopSamples * SPACING) / (STEP_MS / 1000);  // pulses keep pace with climbs
    lastFire = new Int32Array(Math.ceil(curveN / bucketLen) + 1).fill(-1000);
  }

  function buildBand() {
    band = new Uint8Array(n).fill(255);
    nearest = new Int32Array(n).fill(-1);
    for (var s = 0; s < curveN; s++) {
      var cx = Math.floor(curveX[s] / cell);
      var cy = Math.floor(curveY[s] / cell);
      for (var dy = -BAND; dy <= BAND; dy++) {
        var gy = cy + dy;
        if (gy < 0 || gy >= rows) continue;
        for (var dx = -BAND; dx <= BAND; dx++) {
          var gx = cx + dx;
          if (gx < 0 || gx >= cols) continue;
          var d = Math.max(Math.abs(dx), Math.abs(dy));
          var i = gy * cols + gx;
          if (d < band[i] || (d === band[i] && s > nearest[i])) {
            band[i] = d;
            nearest[i] = s;
          }
        }
      }
    }
  }

  // Static layer: faint lattice, the area under the curve, and the curve itself.
  function renderLayer() {
    layer = document.createElement('canvas');
    layer.width = Math.round(W * dpr);
    layer.height = Math.round(H * dpr);
    var g = layer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Lattice points at cell corners
    g.fillStyle = 'rgba(167, 243, 208, 0.045)';
    for (var y = cell; y < H; y += cell) {
      for (var x = cell; x < W; x += cell) {
        g.fillRect(x - 0.5, y - 0.5, 1, 1);
      }
    }

    function tracePath() {
      g.beginPath();
      g.moveTo(curveX[0], curveY[0]);
      for (var s = 1; s < curveN; s++) g.lineTo(curveX[s], curveY[s]);
    }

    // Area under the curve
    tracePath();
    g.lineTo(curveX[curveN - 1] + W, curveY[curveN - 1]);
    g.lineTo(W + 10, H + 10);
    g.lineTo(curveX[0], H + 10);
    g.closePath();
    var fill = g.createLinearGradient(0, 0, 0, H);
    fill.addColorStop(0, 'rgba(110, 231, 183, 0.045)');
    fill.addColorStop(1, 'rgba(110, 231, 183, 0.0)');
    g.fillStyle = fill;
    g.fill();

    // Stroke: emerald at the base, paler toward the top, warming slightly
    // where it starts to bend.
    var stroke = g.createLinearGradient(0, H, 0, 0);
    stroke.addColorStop(0, 'rgba(52, 211, 153, 0.22)');
    stroke.addColorStop(0.55, 'rgba(110, 231, 183, 0.42)');
    stroke.addColorStop(0.85, 'rgba(190, 242, 214, 0.55)');
    stroke.addColorStop(1, 'rgba(236, 226, 196, 0.62)');

    g.lineJoin = 'round';
    g.lineCap = 'round';
    tracePath();
    g.strokeStyle = 'rgba(52, 211, 153, 0.05)';
    g.lineWidth = 9;
    g.stroke();
    g.strokeStyle = 'rgba(110, 231, 183, 0.07)';
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
    var target = curveY[0] - frac * (curveY[0] - curveY[curveN - 1]);
    for (var s = 0; s < curveN; s++) if (curveY[s] <= target) return s;
    return curveN - 1;
  }

  // Launch a glider from `dist` tiles away so that it runs into curve sample s.
  function launchToward(s, dist) {
    var tx = Math.floor(curveX[s] / cell);
    var ty = Math.floor(curveY[s] / cell);
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

  // A spark on the curve at sample s: three cells on a diagonal through it.
  // Under Life's rules it flares for a generation or two and leaves nothing.
  function spark(s) {
    var cx = Math.floor(curveX[s] / cell);
    var cy = Math.floor(curveY[s] / cell);
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

  function addPulse(s, strength) {
    if (pulses.length >= MAX_PULSES) pulses.shift();
    pulses.push({ pos: s, life: strength });
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
      var b = Math.floor(s / bucketLen);
      if (generation - lastFire[b] < COOLDOWN || climbs.length >= MAX_CLIMBS) continue;
      for (var bb = Math.max(0, b - 2); bb <= Math.min(lastFire.length - 1, b + 2); bb++) {
        lastFire[bb] = generation;
      }
      climbs.push({ pos: s, hops: CLIMB_MIN + Math.floor(Math.random() * CLIMB_VAR) });
      addPulse(s, 1);
    }

    // Climbs leave a trail of sparks up the curve, then burn out.
    for (var c = climbs.length - 1; c >= 0; c--) {
      var cl = climbs[c];
      cl.pos += hopSamples;
      if (cl.pos >= curveN || --cl.hops < 0) {
        climbs.splice(c, 1);
        continue;
      }
      spark(cl.pos);
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
        pu.pos += advance;
        pu.life -= dt / 2600;
        if (pu.life <= 0 || pu.pos - tail >= curveN) {
          pulses.splice(p, 1);
          continue;
        }
        var head = Math.min(Math.floor(pu.pos), curveN - 1);
        var start = Math.max(0, Math.floor(pu.pos - tail));
        for (var s = start; s < head; s++) {
          var u = (s - (pu.pos - tail)) / tail;
          var al = pu.life * u * u * 0.85;
          if (al < 0.01) continue;
          ctx.strokeStyle = 'rgba(190, 255, 225, ' + al.toFixed(3) + ')';
          ctx.lineWidth = 1.2 + 1.6 * u;
          ctx.beginPath();
          ctx.moveTo(curveX[s], curveY[s]);
          ctx.lineTo(curveX[s + 1], curveY[s + 1]);
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
    var best = 0, bestD = Infinity;
    for (var s = 0; s < curveN; s += 2) {
      var dd = (curveX[s] - e.clientX) * (curveX[s] - e.clientX) + (curveY[s] - e.clientY) * (curveY[s] - e.clientY);
      if (dd < bestD) { bestD = dd; best = s; }
    }
    var dx = curveX[best] >= e.clientX ? 1 : -1;
    var dy = curveY[best] >= e.clientY ? 1 : -1;
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
