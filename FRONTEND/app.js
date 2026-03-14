/* Quest Todo - Core: globals, state, constants, utilities */

const $ = id => document.getElementById(id);
const esc = t => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

// ========== CONSTANTS ==========
const COMBO_TIMEOUT_MS = 5000;
const TASK_COMPLETE_ANIMATION_MS = 300;
const TASK_DELETE_ANIMATION_MS = 300;
const ACHIEVEMENT_POPUP_MS = 3500;
const LEVELUP_POPUP_MS = 2500;
const DEBOUNCE_DELAY_MS = 300;

// ========== STATE ==========
let state = {
  tasks: [], level: 1, xp: 0, xpMax: 100, combo: 0, completed: 0,
  achievements: {}, streak: 0, sound: false, drumView: true
};
let comboTimer = null;
let audioCtx = null;

// Video autoplay state
let videoObserver = null;
let isMobileDevice = false;
const MOBILE_BREAKPOINT = 768;

// Tab animation lock
let _tabAnimating = false;

// Drag-scroll offset for tasks carousel
let scrollOffset = 0;
let drumFraction = 0; // fractional offset for smooth 3D rotation (-0.5 to 0.5)
let _drumList = []; // virtual list: { type:'task', task } or { type:'header', dayName }

// ========== UTILITIES ==========
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ========== DEVICE DETECTION ==========
function checkIfMobile() {
  const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
  isMobileDevice = mediaQuery.matches;
  mediaQuery.addEventListener('change', (e) => {
    isMobileDevice = e.matches;
    reinitVideoHandlers();
  });
}

// ========== UI UPDATE ==========
function updateUI() {
  const txt = { level: state.level, xp: state.xp, 'xp-max': state.xpMax, 'tasks-completed': state.completed,
    'streak-count': state.streak, 'achievements-count': Object.keys(state.achievements).length };
  for (const [id, val] of Object.entries(txt)) { const el = $(id); if (el) el.textContent = val; }
  const lvlTop = $('level-top'); if (lvlTop) lvlTop.textContent = state.level;
  const xpFill = $('xp-fill'); if (xpFill) xpFill.style.width = (state.xp / state.xpMax * 100) + '%';
  $('combo-container').classList.toggle('active', state.combo > 0);
  $('combo').textContent = state.combo;
  // Static trusted HTML entities for sound icon (speaker symbols)
  $('sound-icon').innerHTML = state.sound ? '&#128266;' : '&#128263;';
  const ss = $('sound-status'); if (ss) ss.textContent = state.sound ? 'ON' : 'OFF';
  const dvs = $('drum-view-status'); if (dvs) dvs.textContent = state.drumView ? 'ON' : 'OFF';
}

// ========== AUTO-RESIZE TEXTAREA ==========
function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function resetTextarea(el) {
  el.value = '';
  el.style.height = 'auto';
  el.focus();
}

function closeOnClickOutside(elId, toggleId, closeAction) {
  document.addEventListener('click', e => {
    if (e.target.closest(`#${elId}, #${toggleId}`)) return;
    closeAction();
  });
}
