/* =========================================================================
   PROGRAM 02 — ILLUSION
   Dot-matrix text fused by a "goo" filter: at rest the dots melt together
   into soft, readable letters that gently breathe. Where the hand passes,
   the dots swell and are pulled toward the fingers, so the letters inflate
   into liquid blobs and become unreadable. When the hand leaves they
   shrink back into the text.

     • Brightness    -> strength of the fingers: reach, how much the dots
                        swell and how far they are pulled.
                        (Tied to the camera/hand detection, never to colour.)
     • Pixel density -> not used here: the dot spacing is fixed (DENSITY below);
                        the slider is hidden while this program is on.
     • Main Color    -> replaces the pink only; the other palette colours
                        keep their roles.
     • Randomize Colors -> picks new background / text / finger colours
                        from the palette (legibility-checked).
     • Keyboard      -> type to add text, Backspace to delete, Enter for a new
                        line; the usual shortcuts work (Option+Backspace deletes
                        a word, Cmd+A selects all, paste, accents). The dots
                        re-flow smoothly as the text changes.
     • Tuning: the constants below (goo, swell, pull, breathing).

   Rendering: WebGL2 — the dots are drawn crisp, blurred, then thresholded
   (the same maths as the SVG goo filter: Gaussian blur, alpha × 24 − 10),
   computed at a reduced resolution when the blur is large, so it stays fast. Falls back to the SVG goo filter on a 2D
   canvas if WebGL2 is unavailable. Hand tracking: MediaPipe HandLandmarker
   (loaded once). Only hands interact with the text (no mouse).
   ========================================================================= */

(function (LSC) {
  const DEFAULT_TEXT =
    'Illusion shows a world that is real and not real at once, a double that has no weight, ' +
    'no breath, and yet cannot be dismissed. To look into it is to ask which side is the ' +
    'illusion: the reflection, or the certainty that stands before it. Illusion does the work ' +
    'that truth cannot do alone. It softens what is too vast to face directly, so that the eye ' +
    'can bear to look at all.';

  const FONT_FAMILY = 'ExposureTrial';
  const FONT_STACK = `"${FONT_FAMILY}", Poppins, "Arial Black", sans-serif`;
  const FONT_WEIGHT = 800;     // 800 = bolder (as the reference); 400 = the font's own weight

  // ---- Tuning (defaults = the reference effect) ---------------------------
  // The goo blur and the dot size follow the dot spacing, so letters look the
  // same at any size (and never break into gaps when the text is large).
  const GOO_SOFTNESS = 0.9;    // blur radius ÷ dot spacing (how much dots melt together)
  const DOT_SIZE = 0.6;        // dot radius ÷ dot spacing (0.5 = solid, no holes)
  // At rest the goo is kept inside each letter's outline (plus this soft
  // margin), so letters stay solid and separate with open counters. Dots the
  // hands push around — and dots re-flowing while typing — are free to blob.
  const LETTER_MARGIN = 0.35;  // outline margin ÷ dot spacing (bigger = rounder, blobbier;
                               // negative turns the outline off = the pure goo look)
  const GOO_CONTRAST = 24;     // alpha multiplier of the goo threshold
  const GOO_OFFSET = 10;       // alpha offset of the goo threshold
  const REACH_FRAC = 0.165;    // finger reach as a fraction of min(width, height)
  const REACH_MIN = 95;        // px
  const SWELL = 1.2;           // how much dots grow under the fingers
  const PULL_MAX = 14;         // px — how far dots are pulled toward the fingers
  const INF_MAX = 1.8;         // cap on accumulated finger influence
  const BREATH = 0.2;         // resting breathing of every dot (±5% size)
  const FINGER_DOT = 12;       // px — radius of the finger keypoints
  const MAX_CHARS = 600;       // typing limit (keeps the text legible)
  const DENSITY = 0.5;         // fixed dot density, 0 (sparse) .. 1 (dense) — same scale as the old slider
  // -------------------------------------------------------------------------

  const MP_VERSION = '0.10.14';
  const MP_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
  const MP_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
  const MP_MODEL =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /* ---- Hand model: loaded once, shared across starts ------------------- */
  let handModelPromise = null;
  function loadHandModel() {
    if (handModelPromise) return handModelPromise;
    handModelPromise = (async () => {
      const vision = await import(MP_BUNDLE);
      const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: MP_MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5
      });
      try {
        return await vision.HandLandmarker.createFromOptions(fileset, options('GPU'));
      } catch (e) {
        console.warn('[LSC] GPU hand tracking unavailable, using CPU:', e);
        return await vision.HandLandmarker.createFromOptions(fileset, options('CPU'));
      }
    })();
    // A failed load (e.g. offline) may be retried the next time we start.
    handModelPromise.catch(() => { handModelPromise = null; });
    return handModelPromise;
  }

  /* ---- Shaders ---------------------------------------------------------- */
  // Crisp anti-aliased dots.
  const VS_DOTS = `#version 300 es
    layout(location = 0) in vec4 aP;      // x, y, radius (css px), free 0..1
    uniform vec2 uRes;
    uniform float uScale;                 // texture px per css px
    out float vR;
    out float vSize;
    out float vFree;
    void main() {
      vFree = aP.w;
      vec2 c = aP.xy / uRes * 2.0 - 1.0;
      gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
      vR = aP.z * uScale;
      vSize = ceil(vR * 2.0 + 2.0);
      gl_PointSize = vSize;
    }`;

  const FS_DOTS = `#version 300 es
    precision highp float;
    in float vR;
    in float vSize;
    in float vFree;
    out vec4 o;
    void main() {
      float d = length(gl_PointCoord - 0.5) * vSize;
      float a = clamp(vR - d + 0.5, 0.0, 1.0);
      if (a <= 0.0) discard;
      o = vec4(a * vFree, 0.0, 0.0, a);   // A: coverage, R: coverage of "free" dots
    }`;

  const VS_QUAD = `#version 300 es
    out vec2 vUv;
    void main() {
      vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
      vUv = p;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;

  // Separable Gaussian blur of the dot coverage.
  const FS_BLUR = `#version 300 es
    precision highp float;
    uniform sampler2D uTex;
    uniform vec2 uStep;                   // one texel in the blur direction
    uniform float uSigma;                 // in texels
    in vec2 vUv;
    out vec4 o;
    void main() {
      vec2 sum = vec2(0.0);
      float wsum = 0.0;
      float inv = 1.0 / (2.0 * uSigma * uSigma);
      for (int i = -16; i <= 16; i++) {
        float fi = float(i);
        if (abs(fi) > uSigma * 3.0 + 0.5) continue;
        float w = exp(-fi * fi * inv);
        sum += texture(uTex, vUv + uStep * fi).ra * w;
        wsum += w;
      }
      sum /= wsum;
      o = vec4(sum.x, 0.0, 0.0, sum.y);
    }`;

  // Goo threshold (same as feColorMatrix alpha row "0 0 0 24 -10") + colour.
  const FS_COMPOSE = `#version 300 es
    precision highp float;
    uniform sampler2D uTex;
    uniform sampler2D uMask;              // letter outlines (+ margin)
    uniform bool uUseMask;
    uniform vec3 uBg;
    uniform vec3 uInk;
    uniform float uContrast;
    uniform float uOffset;
    in vec2 vUv;
    out vec4 o;
    void main() {
      vec4 g = texture(uTex, vUv);
      float a = clamp(g.a * uContrast - uOffset, 0.0, 1.0);
      if (uUseMask) {
        float letter = texture(uMask, vec2(vUv.x, 1.0 - vUv.y)).a;
        float free = smoothstep(0.01, 0.08, g.r);   // pushed / moving dots escape
        a *= max(letter, free);
      }
      o = vec4(mix(uBg, uInk, a), 1.0);
    }`;

  /* ======================================================================= */
  class IllusionApp {
    constructor(container) {
      this.container = container;
      this.running = false;
      this.dirty = true;
      this.buildToken = 0;
      this.reduceMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Palette roles as indices into LSC.BASE_PALETTE (0 = the Main Color).
      this.roles = { bg: 4, dot: 0, finger: 1 };

      this.W = 0; this.H = 0; this.DPR = 1;
      this.time = 0;
      this.lastT = 0;
      this.N = 0;
      this.hands = [];
      this.text = DEFAULT_TEXT;
      this.textDirty = false;
      this.caret = null;
      this.landmarker = null;
      this.lastVideoTime = -1;
      this.lastDetectTs = 0;

      this.initDOM();
      this.gl = this.initGL();
      if (!this.gl) {
        // A canvas that already holds a (failed) WebGL context can't give 2D.
        const fresh = this.canvas.cloneNode(false);
        this.canvas.replaceWith(fresh);
        this.canvas = fresh;
        this.canvas.style.filter = 'url(#lsc-goo)';
        this.ctx2d = this.canvas.getContext('2d');
        console.warn('[LSC] WebGL2 unavailable — using the SVG goo filter.');
      }

      this.randomizeColors();

      this.fontReady = Promise.race([
        document.fonts ? document.fonts.load(`64px "${FONT_FAMILY}"`).catch(() => {}) : Promise.resolve(),
        new Promise((r) => setTimeout(r, 3000))
      ]);

      this.loop = (t) => this.frame(t);
    }

    /* ---- DOM ------------------------------------------------------------ */
    initDOM() {
      const root = document.createElement('div');
      root.className = 'illusion-root';
      root.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;overflow:hidden;z-index:2;display:none;';

      // SVG goo filter, used only by the no-WebGL fallback.
      root.innerHTML = `
        <svg style="position:absolute;width:0;height:0;" aria-hidden="true">
          <defs>
            <filter id="lsc-goo">
              <feGaussianBlur class="lsc-goo-blur" in="SourceGraphic" stdDeviation="4" result="blur"/>
              <feColorMatrix in="blur" mode="matrix"
                values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${GOO_CONTRAST} -${GOO_OFFSET}" result="goo"/>
              <feComposite in="SourceGraphic" in2="goo" operator="atop"/>
            </filter>
          </defs>
        </svg>`;

      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
      this.overlay = document.createElement('canvas');
      this.overlay.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;';
      root.appendChild(this.canvas);
      root.appendChild(this.overlay);
      this.container.appendChild(root);
      this.root = root;
      this.octx = this.overlay.getContext('2d');

      // Typing: a hidden textarea receives the keyboard, so the browser's own
      // text editing handles accents/dead keys, paste, Cmd+A, mobile keyboards.
      const ta = document.createElement('textarea');
      ta.className = 'lsc-typer';
      ta.setAttribute('aria-label', 'Illusion text');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('autocapitalize', 'off');
      ta.spellcheck = false;
      ta.maxLength = MAX_CHARS;
      ta.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;' +
        'resize:none;overflow:hidden;font-size:16px;pointer-events:none;z-index:-1;';
      ta.value = this.text;
      document.body.appendChild(ta);
      this.typer = ta;
      ta.addEventListener('input', () => this.setText(ta.value));
      ta.addEventListener('keydown', (e) => {
        // The cursor always stays at the end of the text.
        if (/^(Arrow|Home$|End$|Page)/.test(e.key)) e.preventDefault();
      });
      // Keys pressed while something else has focus (switch, slider…) are
      // sent to the textarea, so Space never toggles the program by accident.
      window.addEventListener('keydown', (e) => this.routeKey(e), true);
      // Touch screens: tap the text to open the keyboard.
      root.addEventListener('click', () => this.focusTyper());

      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.glLost = true;
      });
      this.canvas.addEventListener('webglcontextrestored', () => {
        this.glLost = false;
        this.gl = this.initGL();
        this.targetsReady = false;
        this.dirty = true;
        if (this.running) this.rebuild();
      });

      if ('ResizeObserver' in window) {
        this.ro = new ResizeObserver(() => this.onResize());
        this.ro.observe(this.container);
      }
      window.addEventListener('resize', () => this.onResize());
    }

    onResize() {
      const W = this.container.clientWidth, H = this.container.clientHeight;
      const DPR = Math.min(window.devicePixelRatio || 1, 2);
      if (W === this.W && H === this.H && DPR === this.DPR) return;
      this.dirty = true;
      if (!this.running) return;                 // rebuilt on next start()
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.rebuild(), 100);
    }

    /* ---- WebGL setup ---------------------------------------------------- */
    initGL() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false
      });
      if (!gl) return null;

      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const program = (vs, fs) => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const u = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
          const info = gl.getActiveUniform(p, i);
          u[info.name] = gl.getUniformLocation(p, info.name);
        }
        return { p, u };
      };

      try {
        this.progDots = program(VS_DOTS, FS_DOTS);
        this.progBlur = program(VS_QUAD, FS_BLUR);
        this.progCompose = program(VS_QUAD, FS_COMPOSE);
      } catch (err) {
        console.error('[LSC] shader error:', err);
        return null;
      }

      // Half-float targets keep the goo edge smooth (it amplifies alpha ×24).
      this.floatTargets = !!gl.getExtension('EXT_color_buffer_float');

      const target = () => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return { tex, fbo: gl.createFramebuffer() };
      };
      this.rtDots = target();
      this.rtBlurX = target();
      this.rtBlurY = target();
      this.texMask = target().tex;

      this.vbo = gl.createBuffer();
      this.vaoDots = gl.createVertexArray();
      gl.bindVertexArray(this.vaoDots);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
      this.vaoQuad = gl.createVertexArray();
      gl.bindVertexArray(null);
      return gl;
    }

    allocTargets(w, h) {
      const gl = this.gl;
      const alloc = (useFloat) => {
        let ok = true;
        for (const rt of [this.rtDots, this.rtBlurX, this.rtBlurY]) {
          gl.bindTexture(gl.TEXTURE_2D, rt.tex);
          if (useFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
          else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt.tex, 0);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ok = false;
        }
        return ok;
      };
      if (this.floatTargets && !alloc(true)) this.floatTargets = false;
      if (!this.floatTargets && !alloc(false)) console.error('[LSC] framebuffer incomplete');
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /* ---- Layout: text -> dots ------------------------------------------ */
    async rebuild() {
      const token = ++this.buildToken;
      await this.fontReady;
      if (token !== this.buildToken) return; // a newer rebuild superseded this one
      this.build();
    }

    build() {
      this.dirty = false;
      this.textDirty = false;
      const W = Math.max(1, this.container.clientWidth || window.innerWidth);
      const H = Math.max(1, this.container.clientHeight || window.innerHeight);
      const DPR = Math.min(window.devicePixelRatio || 1, 2);
      const sizeChanged = W !== this.W || H !== this.H || DPR !== this.DPR || !this.targetsReady;
      this.W = W; this.H = H; this.DPR = DPR;

      if (sizeChanged) {
        this.canvas.width = Math.round(W * DPR);
        this.canvas.height = Math.round(H * DPR);
        this.overlay.width = Math.round(W * DPR);
        this.overlay.height = Math.round(H * DPR);
      }

      // --- Fit the text to the container (Enter = new paragraph).
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const o = off.getContext('2d', { willReadFrequently: true });
      o.textBaseline = 'top';
      const margin = Math.min(W, H) * 0.08;
      const maxW = Math.max(50, W - margin * 2);
      const targetH = Math.max(50, H - margin * 2);
      const paragraphs = this.text.split('\n');

      const wrap = (size) => {
        o.font = `${FONT_WEIGHT} ${size}px ${FONT_STACK}`;
        const lines = [];
        let widest = 0;
        for (const para of paragraphs) {
          let line = '';
          const words = para.split(' ');
          for (let i = 0; i < words.length; i++) {
            const w = words[i];
            const test = i === 0 ? w : line + ' ' + w;
            if (i > 0 && line && o.measureText(test).width > maxW) { lines.push(line); line = w; }
            else line = test;
          }
          lines.push(line);
        }
        for (const l of lines) widest = Math.max(widest, o.measureText(l).width);
        return { lines, widest };
      };

      let fs = Math.min(W, H) * 0.15;
      let fit = wrap(fs);
      for (let i = 0; i < 60; i++) {
        fit = wrap(fs);
        if (fit.lines.length * fs * 1.2 <= targetH && fit.widest <= maxW && fs > 14) break;
        fs *= 0.94;
        if (fs < 13) { fs = 13; fit = wrap(fs); break; }
      }
      const lines = fit.lines;
      this.fs = fs;

      o.font = `${FONT_WEIGHT} ${fs}px ${FONT_STACK}`;
      o.fillStyle = '#fff';
      const lineH = fs * 1.2;
      let y = Math.max(margin, (H - lines.length * lineH) / 2);
      let last = { x: W / 2, y, w: 0 };
      const placed = [];
      for (const ln of lines) {
        const w = o.measureText(ln).width;
        const x = (W - w) / 2;
        o.fillText(ln, x, y);
        placed.push({ ln, x, y });
        last = { x, y, w };
        y += lineH;
      }
      // Blinking cursor sits right after the last character.
      this.caret = { x: last.x + last.w + fs * 0.06, y: last.y + fs * 0.05, h: fs * 0.9, w: Math.max(2, fs * 0.07) };

      // --- Sample the text into dots at the fixed density (0.5 = the
      // reference spacing). Program 01's Pixel density slider doesn't apply here.
      const densityScale = 0.5 + DENSITY;
      const S = Math.max(2.5, Math.max(4, fs * 0.08) / densityScale);
      this.S = S;
      this.sigma = S * GOO_SOFTNESS;                  // goo blur (css px)

      // Letter outlines with a rounded margin: the resting goo stays inside.
      const mask = document.createElement('canvas');
      mask.width = W; mask.height = H;
      const m = mask.getContext('2d');
      m.textBaseline = 'top';
      m.font = `${FONT_WEIGHT} ${fs}px ${FONT_STACK}`;
      m.fillStyle = m.strokeStyle = '#fff';
      m.lineJoin = 'round';
      // (capped by the font size so sparse dot settings don't close the gaps)
      m.lineWidth = 2 * LETTER_MARGIN * Math.min(S, fs * 0.08);
      for (const p of placed) {
        m.fillText(p.ln, p.x, p.y);
        if (m.lineWidth > 0) m.strokeText(p.ln, p.x, p.y);
      }
      // Goo texture resolution: keep the blur ≈ ≤4 texels so it stays cheap.
      const gooScale = Math.min(1, 4 / this.sigma);
      const img = o.getImageData(0, 0, W, H).data;
      const jitter = S * 0.12;
      const hx = [], hy = [], br = [];
      for (let py = S; py < H; py += S) {
        const iy = py | 0;
        for (let px = S; px < W; px += S) {
          if (img[(iy * W + (px | 0)) * 4 + 3] > 80) {
            hx.push(px + (Math.random() * 2 - 1) * jitter);
            hy.push(py + (Math.random() * 2 - 1) * jitter);
            br.push(S * (DOT_SIZE - 0.03 + Math.random() * 0.06));
          }
        }
      }

      // --- Carry the previous dots over, so edits morph instead of jumping:
      // each new dot starts from the nearest old dot (and slides home); new
      // ink grows in from nothing; old dots with no match shrink away.
      const prev = (this.N && this.x) ? {
        n: this.N, x: this.x, y: this.y, r: this.r, inf: this.inf,
        phase: this.phase, alive: this.alive
      } : null;

      const nNew = hx.length;
      let hash = null, cell = 1;
      const used = prev ? new Uint8Array(prev.n) : null;
      if (prev) {
        cell = Math.max(S * 3, fs * 0.6);
        hash = new Map();
        for (let j = 0; j < prev.n; j++) {
          if (!prev.alive[j]) continue;
          const key = Math.floor(prev.x[j] / cell) * 65536 + Math.floor(prev.y[j] / cell);
          let list = hash.get(key);
          if (!list) hash.set(key, (list = []));
          list.push(j);
        }
      }
      const match = new Int32Array(nNew).fill(-1);
      if (prev) {
        for (let i = 0; i < nNew; i++) {
          const cx = Math.floor(hx[i] / cell), cy = Math.floor(hy[i] / cell);
          let best = -1, bestD = cell * cell;
          for (let gx = cx - 1; gx <= cx + 1; gx++) {
            for (let gy = cy - 1; gy <= cy + 1; gy++) {
              const list = hash.get(gx * 65536 + gy);
              if (!list) continue;
              for (const j of list) {
                const dx = prev.x[j] - hx[i], dy = prev.y[j] - hy[i];
                const d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = j; }
              }
            }
          }
          if (best >= 0) { match[i] = best; used[best] = 1; }
        }
      }
      let nDying = 0;
      if (prev) for (let j = 0; j < prev.n; j++) if (prev.alive[j] && !used[j] && prev.r[j] > 0.05) nDying++;

      const N = nNew + nDying;
      this.N = N;
      this.nAlive = nNew;          // dots after this index are shrinking away
      this.hx = new Float32Array(N);
      this.hy = new Float32Array(N);
      this.baseR = new Float32Array(N);
      this.x = new Float32Array(N);
      this.y = new Float32Array(N);
      this.r = new Float32Array(N);
      this.inf = new Float32Array(N);
      this.phase = new Float32Array(N);
      this.alive = new Uint8Array(N);
      for (let i = 0; i < nNew; i++) {
        this.hx[i] = hx[i]; this.hy[i] = hy[i]; this.baseR[i] = br[i]; this.alive[i] = 1;
        const j = match[i];
        if (j >= 0) {
          this.x[i] = prev.x[j]; this.y[i] = prev.y[j]; this.r[i] = prev.r[j];
          this.inf[i] = prev.inf[j]; this.phase[i] = prev.phase[j];
        } else {
          this.x[i] = hx[i]; this.y[i] = hy[i];
          this.r[i] = prev ? 0 : br[i];                  // new ink grows in
          this.phase[i] = Math.random() * Math.PI * 2;
        }
      }
      if (prev) {
        let k = nNew;
        for (let j = 0; j < prev.n; j++) {
          if (!prev.alive[j] || used[j] || prev.r[j] <= 0.05) continue;
          // Dying dot: stays where it is and shrinks to nothing.
          this.hx[k] = this.x[k] = prev.x[j];
          this.hy[k] = this.y[k] = prev.y[j];
          this.r[k] = prev.r[j];
          this.baseR[k] = 0;
          this.phase[k] = prev.phase[j];
          k++;
        }
      }
      this.pbuf = new Float32Array(N * 4);

      this.reach = Math.max(REACH_MIN, Math.min(W, H) * REACH_FRAC);

      // No-WebGL fallback: keep the SVG goo blur in step with the spacing.
      const blurEl = this.root.querySelector('.lsc-goo-blur');
      if (blurEl) blurEl.setAttribute('stdDeviation', this.sigma.toFixed(2));

      if (this.gl && !this.glLost) {
        const gw = Math.max(1, Math.ceil(W * gooScale)), gh = Math.max(1, Math.ceil(H * gooScale));
        if (sizeChanged || gw !== this.gooW || gh !== this.gooH) {
          this.allocTargets(gw, gh);
          this.gooW = gw; this.gooH = gh;
          this.targetsReady = true;
        }
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.texMask);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, Math.max(12, this.pbuf.byteLength), gl.DYNAMIC_DRAW);
      }
    }

    /* ---- Hand tracking -------------------------------------------------- */
    updateTracking() {
      if (!this.landmarker || !LSC.camera.hasFrame()) {
        this.hands = [];
        return;
      }
      const v = LSC.camera.video;
      if (v.currentTime === this.lastVideoTime) return; // no new camera frame yet
      this.lastVideoTime = v.currentTime;

      let ts = performance.now();
      if (ts <= this.lastDetectTs) ts = this.lastDetectTs + 1; // must strictly increase
      this.lastDetectTs = ts;

      let res = null;
      try {
        res = this.landmarker.detectForVideo(v, ts);
      } catch (e) {
        return;
      }
      const lms = (res && res.landmarks) || [];
      const hd = (res && (res.handedness || res.handednesses)) || [];
      const map = LSC.coverMap(v.videoWidth, v.videoHeight, this.W, this.H);

      const next = [];
      for (let i = 0; i < lms.length; i++) {
        const label = (hd[i] && hd[i][0] && hd[i][0].categoryName) || String(i);
        const pts = lms[i].map((p) => map(p.x, p.y));
        const prev = this.hands.find((h) => h.label === label);
        if (prev && !this.reduceMotion) {
          for (let k = 0; k < pts.length; k++) {
            pts[k].x = prev.pts[k].x + (pts[k].x - prev.pts[k].x) * 0.45;
            pts[k].y = prev.pts[k].y + (pts[k].y - prev.pts[k].y) * 0.45;
          }
        }
        next.push({ label, pts });
      }
      this.hands = next;
    }

    // Every hand keypoint is a focus (only hands interact — no mouse).
    fingerFoci() {
      const foci = [];
      for (const h of this.hands) {
        for (const p of h.pts) if (p) foci.push({ x: p.x, y: p.y, w: 1 });
      }
      return foci;
    }

    /* ---- Keyboard ------------------------------------------------------- */
    isTextField(el) {
      if (!el) return false;
      if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
      return el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/i.test(el.type);
    }

    focusTyper() {
      const ta = this.typer;
      if (!ta || !this.running) return;
      if (document.activeElement !== ta) ta.focus({ preventScroll: true });
      const end = ta.value.length;
      if (ta.selectionStart === ta.selectionEnd) ta.setSelectionRange(end, end);
    }

    routeKey(e) {
      if (!this.running || e.target === this.typer || this.isTextField(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const typing = !mod && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter' ||
        e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified');
      const editShortcut = mod && /^(a|v|x|z|Backspace)$/i.test(e.key);
      if (typing || editShortcut) this.focusTyper(); // the key then lands in the textarea
    }

    setText(t) {
      const chars = Array.from(t);
      if (chars.length > MAX_CHARS) t = chars.slice(0, MAX_CHARS).join('');
      if (this.typer && this.typer.value !== t) this.typer.value = t;
      if (t === this.text) return;
      this.text = t;
      this.textDirty = true;       // rebuilt on the next frame (coalesces key repeat)
      this.caretT = performance.now();
    }

    /* ---- Simulation ----------------------------------------------------- */
    step(dt) {
      const T = (this.time += dt * (this.reduceMotion ? 0.3 : 1));
      const f60 = dt * 60;                      // frame-rate independent easing
      const infEase = 1 - Math.pow(1 - 0.28, f60);
      const rEase = 1 - Math.pow(1 - 0.3, f60);
      const posEase = 1 - Math.pow(1 - 0.22, f60);

      // Brightness slider = strength of the fingers (0.5 = reference effect).
      const k = clamp01(LSC.settings.brightness);
      this.strength = k;
      const R = this.reach * lerp(0.6, 1.4, k);
      const R2 = R * R, invR = 1 / R;
      const swell = SWELL * lerp(0.35, 1.65, k);
      const pullMax = PULL_MAX * lerp(0.4, 1.6, k);
      const pullScale = pullMax / PULL_MAX;
      const breathe = this.reduceMotion ? 0 : BREATH;

      const foci = this.fingerFoci();
      this.foci = foci;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const f of foci) {
        if (f.x < minX) minX = f.x; if (f.x > maxX) maxX = f.x;
        if (f.y < minY) minY = f.y; if (f.y > maxY) maxY = f.y;
      }
      minX -= R; maxX += R; minY -= R; maxY += R;
      const nf = foci.length;

      const { hx, hy, x, y, r, baseR, inf, phase, pbuf } = this;
      const tb = T * 1.5;
      const nAlive = this.nAlive;
      const invS = 1 / this.S;
      for (let i = 0, o = 0; i < this.N; i++, o += 4) {
        const dx0 = hx[i], dy0 = hy[i];
        const near = nf > 0 && dx0 > minX && dx0 < maxX && dy0 > minY && dy0 < maxY;

        // Finger influence on this dot, and the direction toward the fingers.
        let tInf = 0, ax = 0, ay = 0, aw = 0;
        if (near) {
          for (let j = 0; j < nf; j++) {
            const f = foci[j];
            const dx = f.x - dx0, dy = f.y - dy0;
            const dd = dx * dx + dy * dy;
            if (dd < R2) {
              const dist = Math.sqrt(dd) + 1e-3;
              const fall = 1 - dist * invR;
              tInf += fall * fall * f.w;
              ax += (dx / dist) * fall; ay += (dy / dist) * fall; aw += fall;
            }
          }
        }
        if (tInf > INF_MAX) tInf = INF_MAX;
        inf[i] += (tInf - inf[i]) * infEase;
        const di = inf[i];

        // Size: gentle breathing, swelling under the fingers.
        const b = 1 + breathe * Math.sin(tb + phase[i]);
        const targetR = baseR[i] * b * (1 + di * swell);
        r[i] += (targetR - r[i]) * rEase;

        // Position: pulled toward the fingers.
        let tx = dx0, ty = dy0;
        if (di > 0.02 && aw > 0) {
          const pull = Math.min(pullMax, di * 12 * pullScale);
          tx += (ax / aw) * pull;
          ty += (ay / aw) * pull;
        }
        x[i] += (tx - x[i]) * posEase;
        y[i] += (ty - y[i]) * posEase;

        pbuf[o] = x[i];
        pbuf[o + 1] = y[i];
        pbuf[o + 2] = r[i];
        // "Free" dots may leave the letter outline: pushed by the hands,
        // still sliding to a new place (typing), or shrinking away (deleted).
        let free = 1;
        if (i < nAlive) {
          const off = Math.hypot(x[i] - dx0, y[i] - dy0) * invS;
          free = Math.max(di * 3, off - 0.25);
          if (free > 1) free = 1; else if (free < 0) free = 0;
        }
        pbuf[o + 3] = free;
      }

      // Drop deleted dots once they have fully shrunk away.
      if (this.N > this.nAlive) {
        let gone = true;
        for (let i = this.nAlive; i < this.N; i++) if (r[i] > 0.05) { gone = false; break; }
        if (gone) this.N = this.nAlive;
      }
    }

    /* ---- Colours -------------------------------------------------------- */
    colors() {
      return {
        bg: LSC.color(this.roles.bg),
        dot: LSC.color(this.roles.dot),
        finger: LSC.color(this.roles.finger)
      };
    }

    randomizeColors() {
      const cur = this.roles;
      const main = LSC.MAIN_INDEX;
      for (let attempt = 0; attempt < 300; attempt++) {
        const p = LSC.shuffle([0, 1, 2, 3, 4]);
        const r = { bg: p[0], dot: p[1], finger: p[2] };
        if (r.bg === cur.bg && r.dot === cur.dot && r.finger === cur.finger) continue;
        // The Main Color (pink slot) must be in use, so the picker always shows.
        if (r.bg !== main && r.dot !== main && r.finger !== main) continue;
        const bg = LSC.color(r.bg), dot = LSC.color(r.dot), fi = LSC.color(r.finger);
        if (LSC.contrast(bg, dot) < 2.5) continue;   // text must read
        if (LSC.contrast(bg, fi) < 1.4) continue;    // fingers must be visible
        this.roles = r;
        return;
      }
    }

    /* ---- Rendering ------------------------------------------------------ */
    render() {
      const c = this.colors();
      if (this.root.style.backgroundColor !== c.bg) this.root.style.backgroundColor = c.bg;
      if (this.gl && !this.glLost) this.renderGL(c);
      else if (this.ctx2d) this.render2D(c);
      this.renderFingers(c);
    }

    renderGL(c) {
      const gl = this.gl;
      const W = this.W, H = this.H;
      const rgb = (hex) => LSC.hexToRgb(hex).map((v) => v / 255);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, null);

      // Pass 1: crisp dots.
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtDots.fbo);
      const gw = this.gooW, gh = this.gooH, gs = gw / W;
      gl.viewport(0, 0, gw, gh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (this.N) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(this.progDots.p);
        gl.uniform2f(this.progDots.u.uRes, W, H);
        gl.uniform1f(this.progDots.u.uScale, gs);
        gl.bindVertexArray(this.vaoDots);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pbuf);
        gl.drawArrays(gl.POINTS, 0, this.N);
        gl.disable(gl.BLEND);
      }

      // Pass 2 + 3: Gaussian blur (horizontal, then vertical).
      const B = this.progBlur;
      gl.useProgram(B.p);
      gl.bindVertexArray(this.vaoQuad);
      gl.uniform1i(B.u.uTex, 0);
      gl.uniform1f(B.u.uSigma, this.sigma * gs);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtBlurX.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.rtDots.tex);
      gl.uniform2f(B.u.uStep, 1 / gw, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtBlurY.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.rtBlurX.tex);
      gl.uniform2f(B.u.uStep, 0, 1 / gh);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Pass 4: goo threshold + colour, to the screen.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      const P = this.progCompose;
      gl.useProgram(P.p);
      gl.bindTexture(gl.TEXTURE_2D, this.rtBlurY.tex);
      gl.uniform1i(P.u.uTex, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      gl.uniform1i(P.u.uMask, 1);
      gl.uniform1i(P.u.uUseMask, LETTER_MARGIN >= 0 ? 1 : 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform3fv(P.u.uBg, rgb(c.bg));
      gl.uniform3fv(P.u.uInk, rgb(c.dot));
      gl.uniform1f(P.u.uContrast, GOO_CONTRAST);
      gl.uniform1f(P.u.uOffset, GOO_OFFSET);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }

    render2D(c) {
      const ctx = this.ctx2d;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      const path = new Path2D();
      const b = this.pbuf;
      for (let o = 0; o < this.N * 4; o += 4) {
        path.moveTo(b[o] + b[o + 2], b[o + 1]);
        path.arc(b[o], b[o + 1], b[o + 2], 0, 6.2832);
      }
      ctx.fillStyle = c.dot;
      ctx.fill(path);
    }

    // Hand keypoints as solid circles (not gooed), sized by strength.
    renderFingers(c) {
      const ctx = this.octx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
      ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);

      // Blinking text cursor (solid for a moment after each key press).
      const cr = this.caret;
      if (cr && !this.hideCaret) {
        const since = performance.now() - (this.caretT || 0);
        if (since < 600 || Math.floor(since / 530) % 2 === 0) {
          ctx.fillStyle = c.dot;
          ctx.fillRect(cr.x, cr.y, cr.w, cr.h);
        }
      }

      const foci = this.foci || [];
      if (!foci.length) return;
      const rad = FINGER_DOT * lerp(0.6, 1.4, this.strength || 0);
      ctx.fillStyle = c.finger;
      ctx.beginPath();
      for (const f of foci) {
        ctx.moveTo(f.x + rad, f.y);
        ctx.arc(f.x, f.y, rad, 0, 6.2832);
      }
      ctx.fill();
    }

    /* ---- Loop / lifecycle ---------------------------------------------- */
    frame(t) {
      if (!this.running) return;
      this.raf = requestAnimationFrame(this.loop);
      if (this.dirty || !this.pbuf) return; // layout not built yet
      if (this.textDirty) this.build();     // typing: rebuild once per frame at most
      const dt = this.lastT ? Math.min(0.05, Math.max(0, (t - this.lastT) / 1000)) : 1 / 60;
      this.lastT = t;
      this.updateTracking();
      this.step(dt);
      this.render();
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.root.style.display = 'block';
      this.lastT = 0;
      this.hands = [];
      this.lastVideoTime = -1;

      if (this.dirty || this.W !== this.container.clientWidth || this.H !== this.container.clientHeight) {
        this.dirty = true;
        this.rebuild();
      }

      if (!this.landmarker) {
        LSC.status('hands', 'Loading hand tracking…');
        loadHandModel()
          .then((lm) => {
            this.landmarker = lm;
            LSC.status('hands', null);
          })
          .catch((err) => {
            console.warn('[LSC] hand tracking failed to load:', err);
            if (this.running) LSC.status('hands', 'Hand tracking unavailable — check your connection and reload');
          });
      }

      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(this.loop);

      // Ready to type straight away (not on touch screens: that would pop the
      // on-screen keyboard every time — tap the text there instead).
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (!coarse) this.focusTyper();
    }

    pause() {
      this.running = false;
      cancelAnimationFrame(this.raf);
      this.root.style.display = 'none';
      this.hands = [];
      this.foci = [];
      if (this.typer && document.activeElement === this.typer) this.typer.blur();
      LSC.status('hands', null);
    }

    applyDensity() {
      if (this.running) this.rebuild();
      else this.dirty = true;
    }

    save() {
      if (!this.pbuf) return;
      this.hideCaret = true;
      this.render(); // draw now so the WebGL buffer is valid to copy
      this.hideCaret = false;
      const out = document.createElement('canvas');
      out.width = this.canvas.width;
      out.height = this.canvas.height;
      const ctx = out.getContext('2d');
      ctx.fillStyle = this.colors().bg;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(this.canvas, 0, 0);
      ctx.drawImage(this.overlay, 0, 0);
      const a = document.createElement('a');
      a.download = `LSC-illusion-${Date.now()}.png`;
      a.href = out.toDataURL('image/png');
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  /* ---- Public API (used by controls-2.js) ------------------------------ */
  let app = null;
  function instance() {
    if (!app) {
      const container = document.querySelector('.interaction-container');
      if (!container) return null;
      app = new IllusionApp(container);
    }
    return app;
  }

  LSC.illusion = {
    start() { const a = instance(); if (a) a.start(); },
    pause() { if (app) app.pause(); },
    applyDensity() { if (app) app.applyDensity(); },
    randomizeColors() { const a = instance(); if (a) a.randomizeColors(); },
    save() { if (app && app.running) app.save(); },
    _app: () => app // for debugging from the console
  };
})(window.LSC);
