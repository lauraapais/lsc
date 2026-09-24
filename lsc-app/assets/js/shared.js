window.LSC = window.LSC || {};

(function (LSC) {
  LSC.MODE_TRACKER = 1;
  LSC.MODE_ILLUSION = 2;
  LSC.mode = LSC.MODE_TRACKER;

  LSC.settings = {
    density: 0.5,
    brightness: 0.5,
    mainColor: '#0000ff'
  };

  LSC.BASE_PALETTE = ['#0000ff', '#D0D0CE', '#383838', '#ebebeb', '#150F12'];
  LSC.MAIN_INDEX = 0;

  const HEX = /^#[0-9a-fA-F]{6}$/;

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

      this._promise.catch(() => {});
      return this._promise;
    },

    hasFrame() {
      const v = this.video;
      return !!(this.ready && v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
    }
  };

  LSC.camera = camera;

  LSC.SAVE_SCALE = 3;

  LSC.saveScale = function (w, h, want, maxDim) {
    const limit = Math.min(maxDim || 16384, 16384);
    let s = want || LSC.SAVE_SCALE;
    s = Math.min(s, limit / w, limit / h, Math.sqrt(120e6 / (w * h)));
    return Math.max(1, s);
  };

  LSC.downloadCanvas = function (canvas, name) {
    const fallback = () => {
      const a = document.createElement('a');
      a.download = name;
      a.href = canvas.toDataURL('image/png');
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    if (!canvas.toBlob) return fallback();
    canvas.toBlob((blob) => {
      if (!blob) return fallback();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = name;
      a.href = url;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, 'image/png');
  };

  LSC.coverMap = function (vw, vh, W, H) {
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale, dh = vh * scale;
    const ox = (W - dw) / 2, oy = (H - dh) / 2;
    return (nx, ny) => ({ x: ox + (1 - nx) * dw, y: oy + ny * dh });
  };
})(window.LSC);
