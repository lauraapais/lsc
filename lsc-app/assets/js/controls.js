(function (LSC) {
  const S = LSC.settings;

  function setProgram(isIllusion) {
    const mode = isIllusion ? LSC.MODE_ILLUSION : LSC.MODE_TRACKER;
    LSC.mode = mode;

    const label = document.getElementById('programLabel');
    if (label) label.textContent = (mode === LSC.MODE_ILLUSION) ? 'Program 02' : 'Program 01';

    const shapesBtn = document.getElementById('btnRandomizeShapes');
    if (shapesBtn) shapesBtn.style.display = (mode === LSC.MODE_ILLUSION) ? 'none' : '';
    const densityRow = document.getElementById('pixelDensity')?.closest('.control-flex');
    if (densityRow) densityRow.style.display = (mode === LSC.MODE_ILLUSION) ? 'none' : '';

    if (mode === LSC.MODE_ILLUSION) {
      if (LSC.tracker) LSC.tracker.pause();
      if (LSC.illusion) LSC.illusion.start();
    } else {
      if (LSC.illusion) LSC.illusion.pause();
      if (LSC.tracker) LSC.tracker.resume();
    }
  }
  LSC.setProgram = setProgram;

  function wireColor() {
    const picker = document.getElementById('mainColor');
    if (!picker) return;
    const update = () => { S.mainColor = picker.value; };
    picker.addEventListener('input', update);
    picker.addEventListener('change', update);
    update();
  }

  let densityTimer = null;

  function wireSlider(sliderId, fillId, valueId, key) {
    const slider = document.getElementById(sliderId);
    const fill = document.getElementById(fillId);
    const label = document.getElementById(valueId);
    if (!slider) return;

    const update = (fromUser) => {
      const min = parseFloat(slider.min) || 0;
      const max = parseFloat(slider.max) || 1;
      const val = parseFloat(slider.value);
      const pct = ((val - min) / (max - min)) * 100;
      if (fill) fill.style.width = pct + '%';
      if (label) label.textContent = val.toFixed(2);
      S[key] = val;

      if (key === 'density' && fromUser) {
        clearTimeout(densityTimer);
        densityTimer = setTimeout(() => {
          if (LSC.tracker) LSC.tracker.applyDensity();
        }, 120);
      }
    };

    slider.addEventListener('input', () => update(true));
    update(false);
  }

  function current() {
    return LSC.mode === LSC.MODE_ILLUSION ? LSC.illusion : LSC.tracker;
  }

  function onRandomizeShapes() {
    if (LSC.mode === LSC.MODE_TRACKER && LSC.tracker) LSC.tracker.randomizeShapes();
  }

  function onRandomizeColors() {
    const p = current();
    if (p) p.randomizeColors();
  }

  function onSave() {
    const p = current();
    if (p) p.save();
  }

  function wirePanel() {
    const panel = document.querySelector('.control-container');
    const btn = document.getElementById('panelToggle');
    if (!panel || !btn) return;
    const label = btn.querySelector('.panel-toggle-label');
    const setCollapsed = (v) => {
      panel.classList.toggle('collapsed', v);
      btn.setAttribute('aria-expanded', String(!v));
      if (label) label.textContent = v ? 'Show controls' : 'Hide controls';
    };
    const phone = window.matchMedia('(max-width: 599px), (max-height: 500px)');
    const wide = window.matchMedia('(min-width: 1024px)');
    setCollapsed(phone.matches);
    btn.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
    const onWide = () => { if (wide.matches) setCollapsed(false); };
    if (wide.addEventListener) wide.addEventListener('change', onWide);
    else if (wide.addListener) wide.addListener(onWide);
  }

  function boot() {
    wirePanel();
    const toggle = document.getElementById('programToggle');

    wireColor();
    wireSlider('pixelDensity', 'pixelDensityFill', 'pixelDensityValue', 'density');
    wireSlider('brightness', 'brightnessFill', 'brightnessValue', 'brightness');

    document.getElementById('btnRandomizeShapes')?.addEventListener('click', onRandomizeShapes);
    document.getElementById('btnRandomizeColors')?.addEventListener('click', onRandomizeColors);
    document.getElementById('btnSave')?.addEventListener('click', onSave);

    if (toggle) toggle.addEventListener('change', () => setProgram(toggle.checked));

    LSC.camera.start();
    setProgram(!!(toggle && toggle.checked));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.LSC);
