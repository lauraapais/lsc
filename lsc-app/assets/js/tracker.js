(function (LSC) {
  const MAX_SCALE = 1.3;
  const MIN_SCALE = 0.15;

  const DETAIL_LEVELS = 2;
  const DETAIL_CONTRAST = 42;
  const CELL_MAX = 56;
  const CELL_MIN = 6;
  const MIN_SUBCELL = 3;
  const SHAPES = 4;

  let cellW = 18, cellH = 18;
  let cols = 0, rows = 0;
  let levels = 0;
  let detailContrast = DETAIL_CONTRAST;
  let F = 1;
  let prevLum = new Float32Array(0);

  let order = [0, 1, 2, 3, 4];
  let lastFrame = null;
  let shapeSeed = 0;

  let p5Ready = false;
  let paused = false;
  let canvasEl = null;

  const sampler = document.createElement('canvas');
  const sctx = sampler.getContext('2d', { willReadFrequently: true });

  function applyDensityToCells() {
    const d = LSC.settings.density;
    const short = p5Ready ? Math.min(width, height) : 800;
    const fit = Math.min(1.3, Math.max(0.5, short / 800));
    const cell = Math.round(CELL_MAX * Math.pow(CELL_MIN / CELL_MAX, d) * fit);
    detailContrast = DETAIL_CONTRAST * Math.pow(2.5, 1 - 2 * d);
    cellW = cellH = Math.max(4, cell);
  }

  function regrid() {
    applyDensityToCells();
    if (!p5Ready) return;
    cols = Math.ceil(width / cellW);
    rows = Math.ceil(height / cellH);
    levels = 0;
    while (levels < DETAIL_LEVELS && cellW / Math.pow(2, levels + 1) >= MIN_SUBCELL) levels++;
    F = 1 << levels;
    prevLum = new Float32Array(cols * rows * F * F);
    sampler.width = cols * F;
    sampler.height = rows * F;
  }

  function containerSize() {
    const c = document.querySelector('.interaction-container');
    return {
      el: c,
      w: (c && c.clientWidth) || windowWidth,
      h: (c && c.clientHeight) || windowHeight
    };
  }

  window.setup = function () {
    const { el, w, h } = containerSize();
    pixelDensity(Math.min(2, window.devicePixelRatio || 1));
    const cnv = createCanvas(w, h);
    if (el) cnv.parent(el);
    cnv.addClass('points-canvas');
    canvasEl = cnv.elt;
    canvasEl.style.position = 'absolute';
    canvasEl.style.top = '0';
    canvasEl.style.left = '0';

    p5Ready = true;
    order = LSC.shuffle([0, 1, 2, 3, 4]);
    regrid();

    if (paused || LSC.mode !== LSC.MODE_TRACKER) {
      paused = true;
      canvasEl.style.display = 'none';
      noLoop();
    }
  };

  window.windowResized = function () {
    if (!p5Ready) return;
    const { w, h } = containerSize();
    resizeCanvas(w, h);
    regrid();
    if (paused) redraw();
  };

  window.draw = function () {
    const pal = order.map(LSC.color);
    background(pal[0]);

    if (paused || !LSC.camera.hasFrame() || cols === 0) { if (!paused) lastFrame = null; return; }

    const video = LSC.camera.video;
    const vw = video.videoWidth, vh = video.videoHeight;

    const canvasAR = width / height;
    const videoAR = vw / vh;
    let srcW, srcH, srcX, srcY;
    if (canvasAR > videoAR) {
      srcW = vw; srcH = vw / canvasAR; srcX = 0; srcY = (vh - srcH) / 2;
    } else {
      srcH = vh; srcW = vh * canvasAR; srcY = 0; srcX = (vw - srcW) / 2;
    }

    const fw = cols * F, fh = rows * F;
    sctx.setTransform(-1, 0, 0, 1, fw, 0);
    sctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, fw, fh);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    let px;
    try {
      px = sctx.getImageData(0, 0, fw, fh).data;
    } catch (e) {
      return;
    }

    const L = prevLum;
    for (let k = 0, i = 0; k < L.length; k++, i += 4) {
      const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      L[k] += (lum - L[k]) * 0.2;
    }

    const bright = LSC.settings.brightness;
    const blankThreshold = 60 + (255 - 60) * bright;

    const stepW = width / cols;
    const stepH = height / rows;
    const baseSize = Math.min(stepW, stepH) * 0.8;
    const fineW = stepW / F, fineH = stepH / F;

    const paths = [new Path2D(), new Path2D(), new Path2D()];
    const rings = [], crosses = [];
    for (let l = 0; l <= levels; l++) { rings.push(new Path2D()); crosses.push(new Path2D()); }

    const circle = (path, x, y, r) => { path.moveTo(x + r, y); path.arc(x, y, r, 0, 6.283185307); };
    const square = (path, x, y, r) => { path.rect(x - r, y - r, r * 2, r * 2); };

    const drawX = (path, x, y, r) => {
      path.moveTo(x - r, y - r);
      path.lineTo(x + r, y + r);
      path.moveTo(x + r, y - r);
      path.lineTo(x - r, y + r);
    };

    const drawCell = (fx, fy, n, level) => {
      let sum = 0, mn = 255, mx = 0;
      for (let yy = fy; yy < fy + n; yy++) {
        const row = yy * fw;
        for (let xx = fx; xx < fx + n; xx++) {
          const v = L[row + xx];
          sum += v;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }

      if (level < levels && mx - mn > detailContrast && mn < blankThreshold) {
        const h = n >> 1, next = level + 1;
        drawCell(fx, fy, h, next);
        drawCell(fx + h, fy, h, next);
        drawCell(fx, fy + h, h, next);
        drawCell(fx + h, fy + h, h, next);
        return;
      }

      const lum = sum / (n * n);
      if (lum > blankThreshold) return;

      const t01 = lum / blankThreshold;
      let type = Math.floor(t01 * SHAPES);
      type = type < 0 ? 0 : type >= SHAPES ? SHAPES - 1 : type;
      const size = baseSize * (n / F);
      const r = (size * (MAX_SCALE + (MIN_SCALE - MAX_SCALE) * t01)) / 2;
      const x = (fx + n / 2) * fineW;
      const y = (fy + n / 2) * fineH;

      const t = (type + shapeSeed) % SHAPES;
      if (t === 0) {
        circle(paths[0], x, y, r);
      } else if (t === 1) {
        circle(paths[1], x, y, r);
        circle(paths[2], x, y, r / 2);
      } else if (t === 2) {
        circle(rings[level], x, y, r * 0.8);
      } else {
        drawX(crosses[level], x, y, r * 0.8);
      }
    };

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        drawCell(gx * F, gy * F, F, 0);
      }
    }

    lastFrame = { paths, rings, crosses, levels, baseSize };
    paint(drawingContext, pal, lastFrame, false);
  };

  function paint(ctx, pal, f, withBackground) {
    ctx.save();
    if (withBackground) {
      ctx.fillStyle = pal[0];
      ctx.fillRect(0, 0, width, height);
    }
    if (f) {
      for (let k = 0; k < 3; k++) {
        ctx.fillStyle = pal[k + 1];
        ctx.fill(f.paths[k]);
      }
      ctx.lineCap = 'butt';
      for (let l = 0; l <= f.levels; l++) {
        const lw = (f.baseSize / (1 << l)) * 0.1;
        ctx.lineWidth = lw * 1.2;
        ctx.strokeStyle = pal[3];
        ctx.stroke(f.rings[l]);
        ctx.lineWidth = lw;
        ctx.strokeStyle = pal[4];
        ctx.stroke(f.crosses[l]);
      }
    }
    ctx.restore();
  }

  LSC.tracker = {
    pause() {
      paused = true;
      if (!p5Ready) return;
      noLoop();
      if (canvasEl) canvasEl.style.display = 'none';
    },
    resume() {
      paused = false;
      if (!p5Ready) return;
      if (canvasEl) canvasEl.style.display = 'block';
      const { w, h } = containerSize();
      if (w !== width || h !== height) {
        resizeCanvas(w, h);
      }
      regrid();
      loop();
    },
    applyDensity() {
      regrid();
    },
    randomizeShapes() {
      shapeSeed = Math.floor(Math.random() * 1000);
    },
    randomizeColors() {
      order = LSC.shuffle([0, 1, 2, 3, 4]);
    },
    save() {
      if (!p5Ready) return;
      const S = LSC.saveScale(width, height);
      const out = document.createElement('canvas');
      out.width = Math.round(width * S);
      out.height = Math.round(height * S);
      const ctx = out.getContext('2d');
      ctx.scale(out.width / width, out.height / height);
      paint(ctx, order.map(LSC.color), lastFrame, true);
      LSC.downloadCanvas(out, `LSC-capture-${S.toFixed(0)}x-${Date.now()}.png`);
    }
  };
})(window.LSC);
