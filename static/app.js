/* Quest Todo - Server-side Version */

const $ = id => document.getElementById(id);
const esc = t => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

// ========== CONSTANTS ==========
const COMBO_TIMEOUT_MS = 5000;
const TASK_COMPLETE_ANIMATION_MS = 600;
const TASK_DELETE_ANIMATION_MS = 300;
const ACHIEVEMENT_POPUP_MS = 3500;
const LEVELUP_POPUP_MS = 2500;
const DEBOUNCE_DELAY_MS = 300;

// ========== STATE ==========
let state = {
  tasks: [], level: 1, xp: 0, xpMax: 100, combo: 0, completed: 0,
  achievements: {}, streak: 0, sound: false
};
let comboTimer = null;
let audioCtx = null;

// ========== UTILITIES ==========
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ========== ACHIEVEMENTS ==========
const ACHIEVEMENTS = [
  ['firstQuest', 'Первые шаги', 'Выполни свой первый квест', '&#127941;'],
  ['fiveQuests', 'Путешественник', 'Выполни 5 квестов', '&#9876;'],
  ['tenQuests', 'Ветеран', 'Выполни 10 квестов', '&#128737;'],
  ['twentyFiveQuests', 'Герой', 'Выполни 25 квестов', '&#129409;'],
  ['fiftyQuests', 'Легенда', 'Выполни 50 квестов', '&#128081;'],
  ['combo3', 'Начало комбо', 'Достигни комбо x3', '&#128293;'],
  ['combo5', 'В огне!', 'Достигни комбо x5', '&#9889;'],
  ['combo10', 'Неудержимый', 'Достигни комбо x10', '&#127775;'],
  ['level5', 'Восходящая звезда', 'Достигни 5 уровня', '&#11088;'],
  ['level10', 'Мастер', 'Достигни 10 уровня', '&#128142;'],
  ['streak7', 'Воин недели', 'Поддерживай серию 7 дней', '&#128170;'],
  ['streak30', 'Мастер месяца', 'Поддерживай серию 30 дней', '&#127942;'],
].map(([id, name, desc, icon]) => ({ id, name, desc, icon }));

// ========== API HELPERS ==========
async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });

  if (response.status === 401) {
    window.location.href = '/';
    return null;
  }

  return response.json();
}

async function loadState() {
  const data = await api('/api/state');
  if (data) {
    state = { ...state, ...data };
    renderTasks();
    renderAchievements();
    updateUI();
  }
  // Hide skeleton loader
  $('skeleton-loader')?.classList.add('hidden');
}

// ========== SOUND ==========
function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }

function playSound(type) {
  if (!audioCtx || !state.sound) return;
  const now = audioCtx.currentTime;
  const play = (freq, dur, vol = 0.3, wave = 'sine') => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = wave; o.connect(g); g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(freq[0], now); o.frequency.exponentialRampToValueAtTime(freq[1], now + dur);
    g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.01, now + dur);
    o.start(now); o.stop(now + dur);
  };
  const cfg = {
    add: () => play([400, 600], 0.15),
    complete: () => { [523, 659, 784].forEach((f, i) => play([f, f], 0.12, 0.25)); },
    combo: () => { const f = 600 + state.combo * 50; play([f, f + 200], 0.15, 0.2, 'square'); },
    levelup: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => play([f, f], 0.2), i * 150)),
    achievement: () => play([800, 1600], 0.5, 0.25, 'triangle'),
    delete: () => play([300, 100], 0.15, 0.2)
  };
  cfg[type]?.();
}

// ========== PARTICLES ==========
function particles(x, y, isLevelup = false) {
  const colors = isLevelup ? ['#ffeaa7', '#fdcb6e', '#f39c12', '#e74c3c'] : ['#00d9a5', '#6c5ce7', '#a29bfe', '#ffeaa7'];
  const icons = ['&#10024;', '&#10023;', '&#9733;', '&#9734;'];
  for (let i = 0; i < (isLevelup ? 30 : 15); i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.innerHTML = icons[Math.random() * 4 | 0];
    p.style.cssText = `left:${x}px;top:${y}px;color:${colors[Math.random() * 4 | 0]};font-size:${12 + Math.random() * 16}px;--tx:${(Math.random() - 0.5) * 200}px;--ty:${-Math.random() * 150 - 50}px;animation:particle-float ${0.6 + Math.random() * 0.4}s ease-out forwards`;
    $('particles').appendChild(p);
    setTimeout(() => p.remove(), 1000);
  }
}

// ========== UI UPDATE ==========
function updateUI() {
  const txt = { level: state.level, xp: state.xp, 'xp-max': state.xpMax, 'tasks-completed': state.completed,
    'streak-count': state.streak, 'achievements-count': Object.keys(state.achievements).length, 'task-count': `(${state.tasks.length})` };
  for (const [id, val] of Object.entries(txt)) $(id).textContent = val;
  $('xp-fill').style.width = (state.xp / state.xpMax * 100) + '%';
  $('combo-container').classList.toggle('active', state.combo > 0);
  if (state.combo > 0) $('combo').textContent = state.combo;
  $('sound-icon').innerHTML = state.sound ? '&#128266;' : '&#128263;';
  const ss = $('sound-status'); if (ss) ss.textContent = state.sound ? 'ON' : 'OFF';
}

// ========== RENDER TASKS ==========
function renderTasks() {
  const list = $('tasks-list');
  list.innerHTML = '';
  $('empty-state').classList.toggle('show', state.tasks.length === 0);

  state.tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = 'task-item';
    li.dataset.id = task.id;
    li.innerHTML = `
      <label class="task-checkbox"><input type="checkbox" aria-label="Выполнить квест"><span class="checkbox-custom"></span></label>
      <span class="task-text">${esc(task.text)}</span>
      <span class="task-xp">+${task.xp} XP</span>
      <button class="task-delete" aria-label="Удалить квест">&#128465;</button>`;

    li.querySelector('input').onchange = () => completeTask(task.id, li);
    li.querySelector('.task-delete').onclick = () => deleteTask(task.id, li);

    const textEl = li.querySelector('.task-text');
    let original = task.text;
    const debouncedEdit = debounce((id, text) => editTask(id, text), DEBOUNCE_DELAY_MS);
    textEl.onclick = e => { e.stopPropagation(); original = task.text; textEl.contentEditable = 'true'; textEl.focus(); document.getSelection().selectAllChildren(textEl); };
    textEl.onblur = () => { textEl.contentEditable = 'false'; debouncedEdit(task.id, textEl.textContent); };
    textEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); } else if (e.key === 'Escape') { textEl.textContent = original; textEl.contentEditable = 'false'; } };

    list.appendChild(li);
  });
  $('task-count').textContent = `(${state.tasks.length})`;
}

// ========== RENDER ACHIEVEMENTS ==========
function renderAchievements() {
  $('achievements-grid').innerHTML = ACHIEVEMENTS.map(a => `
    <div class="achievement-item ${state.achievements[a.id] ? 'unlocked' : ''}">
      <div class="achievement-icon">${a.icon}</div>
      <div class="achievement-name">${a.name}</div>
      <div class="achievement-desc">${a.desc}</div>
    </div>`).join('');
}

// ========== POPUPS ==========
function showPopup(type, data) {
  const isAch = type === 'achievement';
  const popup = $(isAch ? 'achievement-popup' : 'levelup-popup');
  if (isAch) {
    const a = ACHIEVEMENTS.find(x => x.id === data);
    if (!a) return;
    $('popup-icon').innerHTML = a.icon; $('popup-name').textContent = a.name; $('popup-desc').textContent = a.desc;
  } else $('new-level').textContent = state.level;
  popup.classList.add('show');
  playSound(isAch ? 'achievement' : 'levelup');
  setTimeout(() => { const r = popup.getBoundingClientRect(); particles(r.left + r.width / 2, r.top + r.height / 2, !isAch); }, 100);
  setTimeout(() => popup.classList.remove('show'), isAch ? ACHIEVEMENT_POPUP_MS : LEVELUP_POPUP_MS);
}

// ========== TASK ACTIONS ==========
async function addTask(text) {
  if (!text.trim()) return;

  const result = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ text: text.trim() })
  });

  if (result && result.id) {
    state.tasks.unshift(result);
    renderTasks();
    playSound('add');
  }
}

async function completeTask(id, el) {
  el.classList.add('completing');
  const r = el.getBoundingClientRect();
  particles(r.left + r.width / 2, r.top + r.height / 2);
  playSound('complete');

  // Reset combo timer
  clearTimeout(comboTimer);

  const result = await api(`/api/tasks/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ combo: state.combo })
  });

  setTimeout(() => {
    if (result && result.success) {
      // Update state from server response
      state.tasks = state.tasks.filter(t => t.id !== id);
      state.level = result.level;
      state.xp = result.xp;
      state.xpMax = result.xpMax;
      state.completed = result.completed;
      state.streak = result.streak;
      state.combo = result.combo;

      // Show achievements
      if (result.newAchievements && result.newAchievements.length > 0) {
        result.newAchievements.forEach((achId, i) => {
          state.achievements[achId] = true;
          setTimeout(() => showPopup('achievement', achId), i * 500);
        });
      }

      // Show level up
      if (result.leveledUp) showPopup('levelup');

      if (state.combo > 1) playSound('combo');

      // Start combo timer - will reset combo after timeout
      comboTimer = setTimeout(async () => {
        await api('/api/combo/reset', { method: 'POST' });
        state.combo = 0;
        updateUI();
      }, COMBO_TIMEOUT_MS);

      renderTasks();
      renderAchievements();
      updateUI();
    }
  }, TASK_COMPLETE_ANIMATION_MS);
}

async function deleteTask(id, el) {
  el.style.animation = 'task-enter 0.3s ease reverse';
  playSound('delete');

  await api(`/api/tasks/${id}`, { method: 'DELETE' });

  setTimeout(() => {
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderTasks();
  }, TASK_DELETE_ANIMATION_MS);
}

async function editTask(id, newText) {
  const text = newText.trim();
  if (!text) {
    const el = document.querySelector(`[data-id="${id}"]`);
    if (el) deleteTask(id, el);
    return;
  }

  await api(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ text })
  });

  const task = state.tasks.find(t => t.id === id);
  if (task) task.text = text;
}

// ========== EVENT LISTENERS ==========
$('add-task-form').onsubmit = e => {
  e.preventDefault();
  addTask($('task-input').value);
  $('task-input').value = '';
  $('task-input').focus();
};

async function toggleSetting(key, transform = v => !v) {
  if (key === 'sound') initAudio();
  state[key] = transform(state[key]);
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ [key]: state[key] }) });
  updateUI();
  if (state.sound) playSound('add');
}
$('sound-toggle').onclick = () => toggleSetting('sound');
$('version-btn').onclick = () => alert('Скоро будет!');

document.addEventListener('click', initAudio, { once: true });
document.addEventListener('keydown', initAudio, { once: true });

// ========== SETTINGS DROPDOWN ==========
const [sToggle, sDrop] = [$('settings-toggle'), $('settings-dropdown')];
sToggle.onclick = e => { e.stopPropagation(); sDrop.classList.toggle('show'); };
document.addEventListener('click', e => { if (!sDrop.contains(e.target) && !sToggle.contains(e.target)) sDrop.classList.remove('show'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') sDrop.classList.remove('show'); });

// ========== HORIZONTAL SCROLL ==========
$('achievements-grid')?.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY;
  }
}, { passive: false });

// ========== INIT ==========
// Inject particle animation
const style = document.createElement('style');
style.textContent = `@keyframes particle-float{0%{opacity:1;transform:translate(0,0) scale(1) rotate(0)}100%{opacity:0;transform:translate(var(--tx,0),var(--ty,-100px)) scale(0) rotate(360deg)}}`;
document.head.appendChild(style);

// Load state from server
loadState().then(() => {
  $('task-input').focus();
});
