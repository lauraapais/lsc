let currentMode = 0.1;

function toggleSwitchText(checkbox) {
  const label = document.getElementById('switch-text');
  currentMode = checkbox.checked ? 0.2 : 0.1;

  if (label) label.innerText = currentMode.toFixed(1);

  const trackerCanvas = document.querySelector('.points-canvas');
  const shapesBtn = document.querySelector('.btn-shapes');

  if (currentMode === 0.2) {
    // Hide tracker-3.js canvas and launch Illusion mode
    if (trackerCanvas) trackerCanvas.style.display = 'none';
    if (typeof startIllusionMode === 'function') startIllusionMode();
    if (shapesBtn) shapesBtn.style.display = 'none';
  } else {
    // Stop Illusion mode and restore tracker-3.js canvas
    if (typeof stopIllusionMode === 'function') stopIllusionMode();
    if (trackerCanvas) trackerCanvas.style.display = 'block';
    if (shapesBtn) shapesBtn.style.display = '';
  }
}

function handleRandomizeShapes() {
  if (currentMode === 0.2) return; // no shapes concept in Illusion mode
  if (typeof randomizeShapes === 'function') randomizeShapes();
}

function handleRandomizeColor() {
  if (currentMode === 0.2) {
    if (typeof illusionRandomizeColor === 'function') illusionRandomizeColor();
  } else if (typeof shuffleColors === 'function') {
    shuffleColors();
  }
}

function handleSave() {
  if (currentMode === 0.2) {
    if (typeof illusionSaveSnapshot === 'function') illusionSaveSnapshot();
  } else if (typeof window.saveCanvas === 'function') {
    window.saveCanvas('LSC-capture', 'png');
  }
}