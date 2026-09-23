/* =========================================================================
   SHARED — state used by both programs.
     • LSC.settings  : live values of the UI controls (read every frame).
     • LSC.color(i)  : the palette, where slot 0 (the pink) is replaced by the
                       Main Color picker and every other slot stays fixed.
     • LSC.camera    : ONE camera stream for the whole app, so switching
                       programs never re-asks for the camera or opens a second
                       stream.
     • LSC.status()  : small message line over the canvas (camera errors etc).

   Settings live under window.LSC on purpose: p5 (global mode) owns the names
   window.pixelDensity and window.brightness, so storing slider values there
   clobbered p5 functions (and p5 clobbered the slider values back).
   ========================================================================= */

window.LSC = window.LSC || {};

(function (LSC) {
  LSC.MODE_TRACKER = 1;
  LSC.MODE_ILLUSION = 2;
  LSC.mode = LSC.MODE_TRACKER;

  LSC.settings = {
    density: 0.5,        // Pixel density slider, 0..1
    brightness: 0.5,     // Brightness slider, 0..1 (camera / detection, never colour)
    mainColor: '#D82B7D' // Main Color picker — replaces the pink only
  };

  // Base palette. Index 0 is the pink that the Main Color picker replaces.
  LSC.BASE_PALETTE = ['#D82B7D', '#D0D0CE', '#8C664F', '#24191F', '#150F12'];
  LSC.MAIN_INDEX = 0;

  const HEX = /^#[0-9a-fA-F]{6}$/;

  // Colour for a palette slot, with the Main Color substituted for the pink.
  LSC.color = function (index) {
    if (index === LSC.MAIN_INDEX) {
      const c = LSC.settings.mainColor;
      return (typeof c === 'string' && HEX.test(c)) ? c : LSC.BASE_PALETTE[0];
    }
    return LSC.BASE_PALETTE[index];
  };

  LSC.hexToRgb = function (hex) {
    const h = hex.replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16)
    ];
  };

  // WCAG relative luminance, 0..1
  LSC.luminance = function (hex) {
    const lin = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = LSC.hexToRgb(hex);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };

  LSC.contrast = function (a, b) {
    const la = LSC.luminance(a), lb = LSC.luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  LSC.shuffle = function (arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  /* ---- Status line ------------------------------------------------------ */
  let statusEl = null;
  const statusMsgs = {};
  LSC.status = function (key, text) {
    if (text) statusMsgs[key] = text; else delete statusMsgs[key];
    if (!statusEl) {
      const host = document.querySelector('.interaction-container');
      if (!host) return;
      statusEl = document.createElement('p');
      statusEl.className = 'lsc-status';
      host.appendChild(statusEl);
    }
    const lines = Object.values(statusMsgs);
    statusEl.textContent = lines.join(' · ');
    statusEl.style.display = lines.length ? 'block' : 'none';
  };

  /* ---- Camera (single shared stream) ------------------------------------ */
  const camera = {
    video: null,
    ready: false,
    error: null,
    _promise: null,

    start() {
      if (this._promise) return this._promise;

      const v = document.createElement('video');
      v.className = 'lsc-camera';
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('muted', '');
      v.setAttribute('aria-hidden', 'true');
      // Kept in the DOM and technically "visible" (1px, transparent): some
      // browsers stop decoding frames for display:none videos.
      v.style.cssText =
        'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
      v.style.setProperty('display', 'block', 'important');
      document.body.appendChild(v);
      this.video = v;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.error = new Error('Camera API unavailable (open the page over https or localhost).');
        LSC.status('camera', 'Camera unavailable — open the page over https:// or http://localhost');
        this._promise = Promise.reject(this.error);
        this._promise.catch(() => {});
        return this._promise;
      }

      LSC.status('camera', 'Waiting for camera…');

      this._promise = navigator.mediaDevices
        .getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        })
        .then((stream) => {
          v.srcObject = stream;
          return new Promise((resolve) => {
            if (v.readyState >= 2) resolve();
            else v.addEventListener('loadeddata', () => resolve(), { once: true });
          }).then(() => v.play().catch(() => {}));
        })
        .then(() => {
          this.ready = true;
          LSC.status('camera', null);
          return v;
        })
        .catch((err) => {
          this.error = err;
          console.warn('[LSC] camera error:', err);
          LSC.status('camera', 'Camera blocked — allow camera access and reload');
          throw err;
        });

      this._promise.catch(() => {}); // avoid unhandled-rejection noise
      return this._promise;
    },

    // True when a decoded frame is available to read.
    hasFrame() {
      const v = this.video;
      return !!(this.ready && v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
    }
  };

  LSC.camera = camera;

  // Map a point in camera space (0..1, un-mirrored) to container pixels, using
  // the same centred "cover" crop and mirror that the tracker uses, so both
  // programs line up with the person in front of the camera.
  LSC.coverMap = function (vw, vh, W, H) {
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    return (nx, ny) => ({ x: ox + (1 - nx) * dw, y: oy + ny * dh });
  };
})(window.LSC);
