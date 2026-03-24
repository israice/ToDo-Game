/* Quest Todo - UI interactions, tabs & initialization */

// ========== AUTO-RESIZE TEXTAREA LISTENERS ==========
['task-input','quick-task-input'].forEach(id => { const el = $(id); if (el) el.addEventListener('input', () => autoResizeTextarea(el)); });

// ========== EVENT LISTENERS ==========
if ($('add-task-form')) $('add-task-form').onsubmit = e => {
  e.preventDefault();
  addTask($('task-input').value);
  resetTextarea($('task-input'));
};

if ($('task-input')) $('task-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('add-task-form').requestSubmit();
  }
});

// ========== XP BAR → NEXT TAB ==========
document.querySelector('.xp-container-full').addEventListener('click', () => {
  const idx = getActiveTabIndex();
  const next = (idx + 1) % TAB_ORDER.length;
  switchTab(TAB_ORDER[next], 1);
});

// ========== SEARCH TOGGLE (header magnifier) ==========
$('search-toggle').addEventListener('click', e => {
  e.stopPropagation();
  const socialSearch = $('social-search');
  const activeTab = document.querySelector('.tab-btn.active');
  const onSocial = activeTab && activeTab.dataset.tab === 'social';

  if (onSocial) {
    socialSearch.classList.toggle('show');
    if (socialSearch.classList.contains('show')) $('user-search-input').focus();
  } else {
    const oldIdx = getActiveTabIndex();
    const newIdx = TAB_ORDER.indexOf('social');
    switchTab('social', newIdx - oldIdx);
    socialSearch.classList.add('show');
    setTimeout(() => $('user-search-input').focus(), 100);
  }
});

// ========== QUICK ADD TOGGLE ==========
$('add-task-toggle').addEventListener('click', e => {
  e.stopPropagation();
  const row = $('quick-add-row');
  row.classList.toggle('show');
  if (row.classList.contains('show')) $('quick-task-input').focus();
});

closeOnClickOutside('quick-add-row', 'add-task-toggle', () => { $('quick-add-row').classList.remove('show'); });
closeOnClickOutside('social-search', 'search-toggle', () => { $('social-search').classList.remove('show'); });

function quickAddSubmit() {
  const input = $('quick-task-input');
  const text = input.value.trim();
  if (!text) return;
  addTask(text);
  resetTextarea(input);
  $('quick-add-row').classList.remove('show');
}

$('quick-add-submit').addEventListener('click', quickAddSubmit);
$('quick-task-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); quickAddSubmit(); }
});

// ========== SCHEDULE TOGGLE ==========
$('schedule-toggle')?.addEventListener('click', () => {
  const fields = $('schedule-fields');
  const btn = $('schedule-toggle');
  const visible = fields.style.display !== 'none';
  fields.style.display = visible ? 'none' : 'flex';
  btn.classList.toggle('active', !visible);
});

async function toggleSetting(key, transform = v => !v) {
  if (key === 'sound') initAudio();
  state[key] = transform(state[key]);
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ [key]: state[key] }) });
  updateUI();
  if (state.sound) playSound('add');
}
$('sound-toggle').onclick = () => toggleSetting('sound');
if ($('drum-view-toggle')) $('drum-view-toggle').onclick = async () => {
  await toggleSetting('drumView');
  renderTasks();
};
if ($('bg-toggle')) $('bg-toggle').onclick = async () => {
  await toggleSetting('taskBg');
  renderTasks();
};
$('version-btn').onclick = () => {};

['click','keydown','pointerdown'].forEach(e => document.addEventListener(e, initAudio, { once: true }));

// ========== SETTINGS DROPDOWN ==========
const [sToggle, sDrop] = [$('settings-toggle'), $('settings-dropdown')];
function closeSettingsMenu() { sDrop.classList.remove('show'); }
sToggle.onclick = e => { e.stopPropagation(); sDrop.classList.toggle('show'); };
sDrop.addEventListener('click', e => { if (e.target.closest('.settings-item, .tab-btn')) closeSettingsMenu(); });
document.addEventListener('pointerdown', e => {
  if (!sDrop.contains(e.target) && !sToggle.contains(e.target)) closeSettingsMenu();
  if (!e.target.closest('.task-settings-wrap') && !e.target.closest('.task-settings-menu')) _closeAllTaskMenus();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSettingsMenu(); });

// ========== TABS ==========
const TAB_ORDER = ['todo', 'social', 'history', 'achievements'];

function switchTab(tabId, direction) {
  if (_tabAnimating) return;

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const socialSearch = $('social-search');

  const currentBtn = document.querySelector('.tab-btn.active');
  if (currentBtn && currentBtn.dataset.tab === tabId) return;

  const leavingTodo = currentBtn && currentBtn.dataset.tab === 'todo';

  tabBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
  const newBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (newBtn) { newBtn.classList.add('active'); newBtn.setAttribute('aria-selected', 'true'); }

  const slideOut = direction > 0 ? 'slide-out-left' : 'slide-out-right';
  const slideIn = direction > 0 ? 'slide-in-right' : 'slide-in-left';

  let oldTab = null;
  let newTab = null;
  tabContents.forEach(content => {
    if (content.id === `tab-${tabId}`) newTab = content;
    else if (content.style.display !== 'none') oldTab = content;
  });

  const container = document.querySelector('.main-content');
  _tabAnimating = true;

  container.style.height = container.clientHeight + 'px';
  container.style.overflow = 'visible';

  if (oldTab) oldTab.classList.add('tab-animating');

  if (newTab) {
    newTab.classList.add('tab-animating');
    newTab.style.display = newTab.id === 'tab-todo' ? 'flex' : 'block';
  }

  if (tabId === 'todo') {
    _tabAnimating = false;
    renderTasks();
    _tabAnimating = true;
  }

  let animsDone = 0;
  const totalAnims = (oldTab ? 1 : 0) + (newTab ? 1 : 0);

  function onAnimDone() {
    animsDone++;
    if (animsDone < totalAnims) return;

    if (oldTab) {
      oldTab.style.display = 'none';
      oldTab.classList.remove('tab-animating', slideOut);
    }
    if (newTab) {
      newTab.classList.remove('tab-animating', slideIn);
    }
    container.style.height = '';
    container.style.overflow = '';
    _tabAnimating = false;

    if (leavingTodo) _drumNeedsReset = true;
  }

  requestAnimationFrame(() => {
    if (oldTab) {
      oldTab.classList.add(slideOut);
      oldTab.addEventListener('animationend', onAnimDone, { once: true });
    }
    if (newTab) {
      newTab.classList.add(slideIn);
      newTab.addEventListener('animationend', onAnimDone, { once: true });
    }
  });

  if (tabId !== 'social') socialSearch.classList.remove('show');
  sDrop.classList.remove('show');
  if (tabId === 'history') renderHistory();
  if (tabId === 'social') loadFriendsData();
}

function getActiveTabIndex() {
  const active = document.querySelector('.tab-btn.active');
  return active ? TAB_ORDER.indexOf(active.dataset.tab) : 0;
}

function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      const oldIdx = getActiveTabIndex();
      const newIdx = TAB_ORDER.indexOf(tabId);
      switchTab(tabId, newIdx - oldIdx);
    });
  });

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
    const idx = getActiveTabIndex();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + TAB_ORDER.length) % TAB_ORDER.length;
    e.preventDefault();
    switchTab(TAB_ORDER[next], dir);
  });

  let _swipeStartX = 0;
  let _swipeStartY = 0;
  const mainContent = document.querySelector('.main-content');

  mainContent.addEventListener('touchstart', e => {
    _swipeStartX = e.touches[0].clientX;
    _swipeStartY = e.touches[0].clientY;
  }, { passive: true });

  mainContent.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _swipeStartX;
    const dy = e.changedTouches[0].clientY - _swipeStartY;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    const idx = getActiveTabIndex();
    const dir = dx < 0 ? 1 : -1;
    const next = (idx + dir + TAB_ORDER.length) % TAB_ORDER.length;
    switchTab(TAB_ORDER[next], dir);
  }, { passive: true });
}

// ========== INIT ==========
// Inject particle animation
const style = document.createElement('style');
style.textContent = `@keyframes particle-float{0%{opacity:1;transform:translate(0,0) scale(1) rotate(0)}100%{opacity:0;transform:translate(var(--tx,0),var(--ty,-100px)) scale(0) rotate(360deg)}}`;
document.head.appendChild(style);

// Initialize device detection and video observer
checkIfMobile();
if (isMobileDevice) initMobileVideoObserver();

// Initialize tabs and drag-scroll
initTabs();
initTaskDrag();
initSearch();

// Re-render drum on resize
window.addEventListener('resize', () => {
  if (_tabAnimating) return;
  if ($('tasks-list')?.classList.contains('editing')) return;
  const { highlightIdx: oldHi } = getDrumParams();
  _drumJumpToIdx = scrollOffset + oldHi;
  renderTasks();
});

// Auto-scroll to current task after 10s of inactivity
let _idleTimer = null;
function resetIdleTimer() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.contentEditable === 'true')) return;
    if ($('settings-dropdown')?.classList.contains('show')) return;
    if ($('quick-add-row')?.classList.contains('show')) return;
    scrollToCurrentTask();
  }, 10000);
}
['mousemove','keydown','pointerdown','scroll'].forEach(e => document.addEventListener(e, resetIdleTimer));
resetIdleTimer();

// Load state from server
loadState().then(async () => {
  checkGoogleCalendarStatus();

  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  requestAnimationFrame(() => {
    scrollToCurrentTask(true);
    requestAnimationFrame(() => {
      document.body.classList.add('ready');
    });
  });
});
