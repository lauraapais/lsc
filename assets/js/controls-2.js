/* =========================================================================
   CONTROLS — wires the HTML UI to the two programs.
     Program 01 = tracker.js   (camera dot-matrix)          -> LSC.tracker
     Program 02 = illusion.js  (blob text + hand tracking)  -> LSC.illusion

   Both programs read LSC.settings every frame, so the controls only have to
   store values. Switching programs pauses one and resumes the other (nothing
   is torn down), so the camera, hand model and GPU context are reused.
   ========================================================================= */

(function (LSC) {
  const S = LSC.settings;

  /* ---- Program toggle -------------------------------------------------- */
  function setProgram(isIllusion) {
    const mode = isIllusion ? LSC.MODE_ILLUSION : LSC.MODE_TRACKER;
    LSC.mode = mode;

    // Label next to the switch shows which program is running.
    const label = document.getElementById('programLabel');
    if (label) label.textContent = (mode === LSC.MODE_ILLUSION) ? 'Program 02' : 'Program 01';

    // Program 01-only controls: Randomize Shapes and Pixel density.
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

  /* ---- Main color ------------------------------------------------------ */
  function wireColor() {
    const picker = document.getElementById('mainColor');
    if (!picker) return;
    const update = () => { S.mainColor = picker.value; };
    picker.addEventListener('input', update);
    picker.addEventListener('change', update);
    update();
  }

  /* ---- Sliders --------------------------------------------------------- */
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

      // Density only applies to Program 01; debounce the re-grid.
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

  /* ---- Buttons --------------------------------------------------------- */
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

  /* ---- Boot ------------------------------------------------------------ */
  function boot() {
    const toggle = document.getElementById('programToggle');

    wireColor();
    wireSlider('pixelDensity', 'pixelDensityFill', 'pixelDensityValue', 'density');
    wireSlider('brightness', 'brightnessFill', 'brightnessValue', 'brightness');

    document.getElementById('btnRandomizeShapes')?.addEventListener('click', onRandomizeShapes);
    document.getElementById('btnRandomizeColors')?.addEventListener('click', onRandomizeColors);
    document.getElementById('btnSave')?.addEventListener('click', onSave);

    if (toggle) toggle.addEventListener('change', () => setProgram(toggle.checked));

    LSC.camera.start();
    setProgram(!!(toggle && toggle.checked)); // honours a browser-restored toggle
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.LSC);
