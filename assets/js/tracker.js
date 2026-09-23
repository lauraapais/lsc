/* =========================================================================
   PROGRAM 01 — TRACKER (p5, global mode)
   Camera dot-matrix: every grid cell reads the camera luminance and becomes
   one of three palette shapes (darker = bigger).

     • Pixel density -> grid cell size
     • Brightness    -> camera detection threshold: how bright a camera pixel
                        can be and still be detected as a shape. It changes
                        what the camera picks up, never the colours.
     • Main Color    -> replaces the pink wherever the shuffle put it.

   The camera comes from LSC.camera (one stream shared with the illusion).
   ========================================================================= */

(function (LSC) {
  const MAX_SCALE = 1.3;
  const MIN_SCALE = 0.15;

  let cellW = 18, cellH = 18;
  let cols = 0, rows = 0;
  let prevLum = new Float32Array(0);

  // Palette order as INDICES into LSC.BASE_PALETTE; colours are resolved each
  // frame through LSC.color(), so the Main Color always replaces the pink
  // (index 0) wherever it sits, including after a shuffle or a mode switch.
  let order = [0, 1, 2, 3, 4];
  let shapeSeed = 0;

  let p5Ready = false;
  let paused = false;
  let canvasEl = null;

  // Small offscreen canvas the camera frame is scaled into (1 px per cell).
  const sampler = document.createElement('canvas');
  const sctx = sampler.getContext('2d', { willReadFrequently: true });

  function applyDensityToCells() {
    const d = LSC.settings.density;
    const cell = Math.round(34 + (6 - 34) * d); // 0 = sparse (34px) .. 1 = dense (6px)
    cellW = cellH = Math.max(3, cell);
  }

  function regrid() {
    applyDensityToCells();
    if (!p5Ready) return;
    cols = Math.ceil(width / cellW);
    rows = Math.ceil(height / cellH);
    prevLum = new Float32Array(cols * rows);
    sampler.width = cols;
    sampler.height = rows;
  }

  function containerSize() {
    const c = document.querySelector('.interaction-container');
    return {
      el: c,
      w: (c && c.clientWidth) || windowWidth,
      h: (c && c.clientHeight) || windowHeight
    };
  }

  /* ---- p5 lifecycle ---------------------------------------------------- */
  window.setup = function () {
    const { el, w, h } = containerSize();
    const cnv = createCanvas(w, h);
    if (el) cnv.parent(el);
    cnv.addClass('points-canvas');
    canvasEl = cnv.elt;
    canvasEl.style.position = 'absolute';
    canvasEl.style.top = '0';
    canvasEl.style.left = '0';

    p5Ready = true;
    order = LSC.shuffle([0, 1, 2, 3, 4]); // random palette arrangement per load
    regrid();

    // The toggle may already be on Program 02 by the time p5 boots.
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
    if (paused) redraw(); // keep the hidden canvas valid for the next resume
  };

  window.draw = function () {
    const pal = order.map(LSC.color);
    background(pal[0]);

    if (paused || !LSC.camera.hasFrame() || cols === 0) return;

    const video = LSC.camera.video;
    const vw = video.videoWidth, vh = video.videoHeight;

    // Centred "cover" crop of the camera to the canvas aspect ratio.
    const canvasAR = width / height;
    const videoAR = vw / vh;
    let srcW, srcH, srcX, srcY;
    if (canvasAR > videoAR) {
      srcW = vw; srcH = vw / canvasAR; srcX = 0; srcY = (vh - srcH) / 2;
    } else {
      srcH = vh; srcW = vh * canvasAR; srcY = 0; srcX = (vw - srcW) / 2;
    }

    // Mirror horizontally (like looking in a mirror) and scale to 1 px/cell.
    sctx.setTransform(-1, 0, 0, 1, cols, 0);
    sctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, cols, rows);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    let px;
    try {
      px = sctx.getImageData(0, 0, cols, rows).data;
    } catch (e) {
      return;
    }

    // Brightness slider = camera detection threshold (never colour).
    // Camera pixels darker than the threshold are detected and drawn; brighter
    // ones are ignored. Higher slider -> more of the camera image is picked up.
    const bright = LSC.settings.brightness;
    const blankThreshold = 60 + (255 - 60) * bright; // 60 (selective) .. 255 (everything)

    const stepW = width / cols;
    const stepH = height / rows;
    const baseSize = Math.min(stepW, stepH) * 0.8;

    // Batch every shape into one path per colour (thousands of cells per
    // frame; one fill per colour keeps high densities fast).
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const circle = (path, x, y, r) => { path.moveTo(x + r, y); path.arc(x, y, r, 0, 6.283185307); };

    for (let gy = 0; gy < rows; gy++) {
      const y = gy * stepH + stepH / 2;
      for (let gx = 0; gx < cols; gx++) {
        const idx = gx + gy * cols;
        const i = idx * 4;
        let lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        lum = prevLum[idx] + (lum - prevLum[idx]) * 0.2;
        prevLum[idx] = lum;

        if (lum > blankThreshold) continue;

        const n = lum / blankThreshold;
        let type = Math.floor(n * 3);
        type = type < 0 ? 0 : type > 2 ? 2 : type;
        const r = (baseSize * (MAX_SCALE + (MIN_SCALE - MAX_SCALE) * n)) / 2;
        const x = gx * stepW + stepW / 2;

        // SHAPES
        const t = (type + shapeSeed) % 3;
        if (t === 0) {
          circle(paths[0], x, y, r);            // full dot, colour 1
        } else if (t === 1) {
          circle(paths[1], x, y, r);            // full dot, colour 2 ...
          circle(paths[2], x, y, r / 4);        // ... with a colour-3 centre
        } else {
          circle(paths[3], x, y, r / 2);        // half dot, colour 4
        }
      }
    }

    const ctx = drawingContext;
    ctx.save();
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = pal[k + 1];
      ctx.fill(paths[k]);
    }
    ctx.restore();
  };

  /* ---- Public API (used by controls-2.js) ------------------------------ */
  LSC.tracker = {
    pause() {
      paused = true;
      if (!p5Ready) return;
      noLoop();
      if (canvasEl) canvasEl.style.display = 'none';
    },
    resume() {
      paused = false;
      if (!p5Ready) return; // setup() will start looping on its own
      if (canvasEl) canvasEl.style.display = 'block';
      // The window may have been resized while this program was hidden.
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
      if (paused) redraw();
      saveCanvas('LSC-capture', 'png');
    }
  };
})(window.LSC);
