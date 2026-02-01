/* Quest Todo - Server-side Version */

const $ = id => document.getElementById(id);
const esc = t => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);

// ========== STATE ==========
let state = {
  tasks: [], level: 1, xp: 0, xpMax: 100, combo: 0, completed: 0,
  achievements: {}, streak: 0, sound: false, theme: 'dark'
};
let comboTimer = null;
let audioCtx = null;

// ========== ACHIEVEMENTS ==========
const ACHIEVEMENTS = [
  { id: 'firstQuest', name: 'First Steps', desc: 'Complete your first quest', icon: '&#127941;' },
  { id: 'fiveQuests', name: 'Adventurer', desc: 'Complete 5 quests', icon: '&#9876;' },
  { id: 'tenQuests', name: 'Veteran', desc: 'Complete 10 quests', icon: '&#128737;' },
  { id: 'twentyFiveQuests', name: 'Hero', desc: 'Complete 25 quests', icon: '&#129409;' },
  { id: 'fiftyQuests', name: 'Legend', desc: 'Complete 50 quests', icon: '&#128081;' },
  { id: 'combo3', name: 'Combo Starter', desc: 'Reach 3x combo', icon: '&#128293;' },
  { id: 'combo5', name: 'On Fire!', desc: 'Reach 5x combo', icon: '&#9889;' },
  { id: 'combo10', name: 'Unstoppable', desc: 'Reach 10x combo', icon: '&#127775;' },
  { id: 'level5', name: 'Rising Star', desc: 'Reach level 5', icon: '&#11088;' },
  { id: 'level10', name: 'Master', desc: 'Reach level 10', icon: '&#128142;' },
  { id: 'streak7', name: 'Week Warrior', desc: 'Maintain a 7-day streak', icon: '&#128170;' },
  { id: 'streak30', name: 'Month Master', desc: 'Maintain a 30-day streak', icon: '&#127942;' },
];

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
}

// ========== SOUND ==========
function initAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playSound(type) {
  if (!audioCtx || !state.sound) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  const sounds = {
    add: () => { osc.frequency.setValueAtTime(400, now); osc.frequency.exponentialRampToValueAtTime(600, now + 0.1); gain.gain.setValueAtTime(0.3, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15); osc.start(now); osc.stop(now + 0.15); },
    complete: () => { [523.25, 659.25, 783.99].forEach((f, i) => { osc.frequency.setValueAtTime(f, now + i * 0.1); }); gain.gain.setValueAtTime(0.3, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35); osc.start(now); osc.stop(now + 0.35); },
    combo: () => { const f = 600 + state.combo * 50; osc.type = 'square'; osc.frequency.setValueAtTime(f, now); osc.frequency.exponentialRampToValueAtTime(f + 200, now + 0.1); gain.gain.setValueAtTime(0.2, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15); osc.start(now); osc.stop(now + 0.15); },
    levelup: () => { [523.25, 659.25, 783.99, 1046.50].forEach((f, i) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.connect(g); g.connect(audioCtx.destination); o.frequency.setValueAtTime(f, now + i * 0.15); g.gain.setValueAtTime(0.3, now + i * 0.15); g.gain.exponentialRampToValueAtTime(0.01, now + i * 0.15 + 0.2); o.start(now + i * 0.15); o.stop(now + i * 0.15 + 0.2); }); return; },
    achievement: () => { osc.type = 'triangle'; osc.frequency.setValueAtTime(800, now); osc.frequency.exponentialRampToValueAtTime(1200, now + 0.2); osc.frequency.exponentialRampToValueAtTime(1600, now + 0.4); gain.gain.setValueAtTime(0.25, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5); osc.start(now); osc.stop(now + 0.5); },
    delete: () => { osc.frequency.setValueAtTime(300, now); osc.frequency.exponentialRampToValueAtTime(100, now + 0.15); gain.gain.setValueAtTime(0.2, now); gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15); osc.start(now); osc.stop(now + 0.15); }
  };
  sounds[type]?.();
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
  $('level').textContent = state.level;
  $('xp').textContent = state.xp;
  $('xp-max').textContent = state.xpMax;
  $('xp-fill').style.width = (state.xp / state.xpMax * 100) + '%';
  $('tasks-completed').textContent = state.completed;
  $('streak-count').textContent = state.streak;
  $('achievements-count').textContent = Object.keys(state.achievements).length;
  $('task-count').textContent = `(${state.tasks.length})`;

  // Combo
  if (state.combo > 0) {
    $('combo-container').classList.add('active');
    $('combo').textContent = state.combo;
  } else {
    $('combo-container').classList.remove('active');
  }

  // Sound icon
  $('sound-icon').innerHTML = state.sound ? '&#128266;' : '&#128263;';
  $('sound-toggle').classList.toggle('muted', !state.sound);

  // Theme
  document.documentElement.setAttribute('data-theme', state.theme);
  $('theme-icon').innerHTML = state.theme === 'light' ? '&#9790;' : '&#9728;';
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
      <label class="task-checkbox"><input type="checkbox"><span class="checkbox-custom"></span></label>
      <span class="task-text">${esc(task.text)}</span>
      <span class="task-xp">+${task.xp} XP</span>
      <button class="task-delete">&#128465;</button>`;

    li.querySelector('input').onchange = () => completeTask(task.id, li);
    li.querySelector('.task-delete').onclick = () => deleteTask(task.id, li);

    const textEl = li.querySelector('.task-text');
    let original = task.text;
    textEl.onclick = e => { e.stopPropagation(); original = task.text; textEl.contentEditable = 'true'; textEl.focus(); document.getSelection().selectAllChildren(textEl); };
    textEl.onblur = () => { textEl.contentEditable = 'false'; editTask(task.id, textEl.textContent); };
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
function showAchievement(achievementId) {
  const a = ACHIEVEMENTS.find(ach => ach.id === achievementId);
  if (!a) return;

  $('popup-icon').innerHTML = a.icon;
  $('popup-name').textContent = a.name;
  $('popup-desc').textContent = a.desc;
  $('achievement-popup').classList.add('show');
  playSound('achievement');
  setTimeout(() => { const r = $('achievement-popup').getBoundingClientRect(); particles(r.left + r.width / 2, r.top + r.height / 2); }, 100);
  setTimeout(() => $('achievement-popup').classList.remove('show'), 3500);
}

function showLevelUp() {
  $('new-level').textContent = state.level;
  $('levelup-popup').classList.add('show');
  const r = $('levelup-popup').getBoundingClientRect();
  particles(r.left + r.width / 2, r.top + r.height / 2, true);
  playSound('levelup');
  setTimeout(() => $('levelup-popup').classList.remove('show'), 2500);
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
          setTimeout(() => showAchievement(achId), i * 500);
        });
      }

      // Show level up
      if (result.leveledUp) {
        showLevelUp();
      }

      if (state.combo > 1) playSound('combo');

      // Start combo timer - will reset combo after 5 seconds
      comboTimer = setTimeout(async () => {
        await api('/api/combo/reset', { method: 'POST' });
        state.combo = 0;
        updateUI();
      }, 5000);

      renderTasks();
      renderAchievements();
      updateUI();
    }
  }, 600);
}

async function deleteTask(id, el) {
  el.style.animation = 'task-enter 0.3s ease reverse';
  playSound('delete');

  await api(`/api/tasks/${id}`, { method: 'DELETE' });

  setTimeout(() => {
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderTasks();
  }, 300);
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

$('sound-toggle').onclick = async () => {
  initAudio();
  state.sound = !state.sound;
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ sound: state.sound })
  });
  updateUI();
  if (state.sound) playSound('add');
};

$('theme-toggle').onclick = async () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ theme: state.theme })
  });
  updateUI();
  playSound('add');
};

document.addEventListener('click', initAudio, { once: true });
document.addEventListener('keydown', initAudio, { once: true });

// ========== INIT ==========
// Inject particle animation
const style = document.createElement('style');
style.textContent = `@keyframes particle-float{0%{opacity:1;transform:translate(0,0) scale(1) rotate(0)}100%{opacity:0;transform:translate(var(--tx,0),var(--ty,-100px)) scale(0) rotate(360deg)}}`;
document.head.appendChild(style);

// Load state from server
loadState().then(() => {
  $('task-input').focus();
});
