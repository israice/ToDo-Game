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
  achievements: {}, streak: 0, sound: false, history: []
};
let comboTimer = null;
let audioCtx = null;

// Generate unique tab ID for multi-tab support
const TAB_ID = 'tab_' + Math.random().toString(36).substr(2, 9);

// SSE connection
let eventSource = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 3000;

// Media popup state
let currentMediaTaskId = null;
let cameraStream = null;
let mediaRecorder = null;
let recordedChunks = [];

// Video autoplay state
let videoObserver = null;
let isMobileDevice = false;
const MOBILE_BREAKPOINT = 768;

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
    headers: {
      'Content-Type': 'application/json',
      'X-Tab-ID': TAB_ID,  // Send tab ID for multi-tab support
      ...options.headers
    },
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
  
  // Show brief refresh indicator
  showRefreshIndicator();
}

let refreshIndicatorTimeout = null;
function showRefreshIndicator() {
  // Create indicator if it doesn't exist
  let indicator = $('refresh-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'refresh-indicator';
    indicator.innerHTML = '🔄';
    indicator.style.cssText = 'position:fixed;top:10px;right:10px;font-size:24px;opacity:0;transition:opacity 0.3s;z-index:9999;';
    document.body.appendChild(indicator);
  }
  
  // Show indicator
  indicator.style.opacity = '1';

  // Hide after 1 second
  if (refreshIndicatorTimeout) clearTimeout(refreshIndicatorTimeout);
  refreshIndicatorTimeout = setTimeout(() => {
    indicator.style.opacity = '0';
  }, 1000);
}

// ========== SSE (Server-Sent Events) ==========

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  // Connect with tabId for multi-tab support
  eventSource = new EventSource(`/api/events?tabId=${TAB_ID}`);

  eventSource.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    console.log('✓ SSE connected:', data);
    reconnectAttempts = 0;
  });

  eventSource.addEventListener('task_created', (e) => {
    const data = JSON.parse(e.data);
    console.log('📝 Task created (SSE):', data);
    
    // Check if this is from another tab/window
    const existingTask = state.tasks.find(t => t.id === data.id);
    if (!existingTask) {
      state.tasks.unshift({ id: data.id, text: data.text, xp: data.xp });
      
      // Update state if includes XP/level changes
      if (data.xpEarned) {
        state.level = data.level;
        state.xp = data.currentXp;
        state.xpMax = data.xpMax;
        if (data.leveledUp) showPopup('levelup');
      }
      
      renderTasks();
      updateUI();
      playSound('add');
    }
  });

  eventSource.addEventListener('task_updated', (e) => {
    const data = JSON.parse(e.data);
    console.log('✏️ Task updated (SSE):', data);
    
    const task = state.tasks.find(t => t.id === data.id);
    if (task) {
      task.text = data.text;
      renderTasks();
    }
  });

  eventSource.addEventListener('task_deleted', (e) => {
    const data = JSON.parse(e.data);
    console.log('🗑️ Task deleted (SSE):', data);
    
    const taskIndex = state.tasks.findIndex(t => t.id === data.id);
    if (taskIndex !== -1) {
      state.tasks.splice(taskIndex, 1);
      renderTasks();
    }
  });

  eventSource.addEventListener('task_completed', (e) => {
    const data = JSON.parse(e.data);
    console.log('✅ Task completed (SSE):', data);
    
    // Remove task from list
    const taskIndex = state.tasks.findIndex(t => t.id === data.id);
    if (taskIndex !== -1) {
      state.tasks.splice(taskIndex, 1);
    }
    
    // Update state
    state.level = data.level;
    state.xp = data.xp;
    state.xpMax = data.xpMax;
    state.completed = data.completed;
    state.streak = data.streak;
    state.combo = data.combo;
    
    // Handle achievements
    if (data.newAchievements && data.newAchievements.length > 0) {
      data.newAchievements.forEach((achId, i) => {
        state.achievements[achId] = true;
        const ach = ACHIEVEMENTS.find(a => a.id === achId);
        if (ach) addToHistory(ach.name, 100, ach.icon);
        setTimeout(() => showPopup('achievement', achId), i * 500);
      });
      renderAchievements();
    }
    
    // Handle level up
    if (data.leveledUp) showPopup('levelup');
    
    if (state.combo > 1) playSound('combo');
    
    renderTasks();
    updateUI();
  });

  eventSource.onerror = (err) => {
    console.error('❌ SSE error:', err);
    eventSource.close();
    
    // Reconnect with exponential backoff
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);
      console.log(`🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(connectSSE, delay);
    } else {
      console.error('❌ Max reconnection attempts reached');
    }
  };

  console.log('📡 Connecting to SSE...');
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

    // Build media HTML
    const mediaHtml = task.media
      ? (task.media.type === 'image'
        ? `<img src="${task.media.url}" alt="">`
        : `<video src="${task.media.url}" muted></video>`)
      : '🖼️';
    const hasImageClass = task.media ? 'has-image' : '';

    li.innerHTML = `
      <span class="task-media ${hasImageClass}">${mediaHtml}</span>
      <label class="task-checkbox"><input type="checkbox" aria-label="Выполнить квест"><span class="checkbox-custom"></span></label>
      <span class="task-text">${esc(task.text)}</span>
      <span class="task-xp">+${task.xp} XP</span>
      <button class="task-delete" aria-label="Удалить квест">&#128465;</button>`;

    li.querySelector('input').onchange = () => completeTask(task.id, li);
    li.querySelector('.task-delete').onclick = () => deleteTask(task.id, li);
    li.querySelector('.task-media').onclick = () => openMediaPopup(task.id);

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
    state.tasks.unshift({ id: result.id, text: result.text, xp: result.xp });

    // +3 XP за создание задачи
    if (result.xpEarned) {
      state.level = result.level;
      state.xp = result.currentXp;
      state.xpMax = result.xpMax;
      addToHistory('Создание задачи', result.xpEarned);
      if (result.leveledUp) showPopup('levelup');
    }

    renderTasks();
    updateUI();
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

      // Add to history
      addToHistory('Выполнение задачи', result.xpEarned);

      // Show achievements
      if (result.newAchievements && result.newAchievements.length > 0) {
        result.newAchievements.forEach((achId, i) => {
          state.achievements[achId] = true;
          const ach = ACHIEVEMENTS.find(a => a.id === achId);
          if (ach) addToHistory(ach.name, 100, ach.icon);
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

// ========== TABS ==========
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const socialSearch = $('social-search');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;

      // Update active button and aria
      tabBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');

      // Show selected content
      tabContents.forEach(content => {
        content.style.display = content.id === `tab-${tabId}` ? 'block' : 'none';
      });

      // Show/hide search for SOCIAL tab
      socialSearch.classList.toggle('show', tabId === 'social');

      // Render content if needed
      if (tabId === 'history') renderHistory();
      if (tabId === 'social') loadFriendsData();
    });
  });
}


// ========== HISTORY ==========
function addToHistory(action, points, icon = null) {
  const item = {
    id: Date.now(),
    action: action,
    icon: icon,
    points: points,
    timestamp: new Date().toISOString()
  };

  state.history = state.history || [];
  state.history.unshift(item);

  // Keep last 50 entries
  if (state.history.length > 50) {
    state.history = state.history.slice(0, 50);
  }

  // Save to localStorage
  localStorage.setItem('questTodoHistory', JSON.stringify(state.history));
}

function loadHistory() {
  try {
    const saved = localStorage.getItem('questTodoHistory');
    if (saved) {
      state.history = JSON.parse(saved);
    }
  } catch (e) {
    state.history = [];
  }
}

function renderHistory() {
  const list = $('history-list');
  const empty = $('history-empty');

  // Only show entries with XP
  const xpHistory = (state.history || []).filter(item => item.points > 0);

  if (xpHistory.length === 0) {
    list.innerHTML = '';
    empty.classList.add('show');
    return;
  }

  empty.classList.remove('show');
  list.innerHTML = xpHistory.map(item => `
    <li class="history-item">
      <span class="history-action">${item.icon ? item.icon + ' ' : ''}${esc(item.action)}</span>
      <span class="history-points">+${item.points} XP</span>
      <span class="history-time">${formatTime(item.timestamp)}</span>
    </li>`).join('');
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('ru-RU');
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

// ========== FRIENDS API ==========
let feedOffset = 0;
let feedHasMore = false;

async function searchUsers(query) {
  if (query.length < 2) return { users: [] };
  return await api(`/api/users/search?q=${encodeURIComponent(query)}`);
}

async function getFriends() {
  return await api('/api/friends');
}

async function sendFriendRequest(userId) {
  return await api('/api/friends/request', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId })
  });
}

async function respondToRequest(requestId, action) {
  return await api('/api/friends/respond', {
    method: 'POST',
    body: JSON.stringify({ request_id: requestId, action })
  });
}

async function cancelFriendRequest(requestId) {
  return await api(`/api/friends/request/${requestId}`, { method: 'DELETE' });
}

async function getFriendsFeed(limit = 20, offset = 0) {
  return await api(`/api/friends/feed?limit=${limit}&offset=${offset}`);
}

// ========== FRIENDS RENDERING ==========
function renderSearchResults(users) {
  const container = $('search-results');
  const empty = $('search-empty');

  if (!container) return;

  if (!users || users.length === 0) {
    container.innerHTML = '';
    empty?.classList.add('show');
    return;
  }

  empty?.classList.remove('show');
  container.innerHTML = users.map(user => {
    let btnClass = 'add-friend-btn';
    let btnText = 'Добавить';
    let btnDisabled = '';

    if (user.friendship_status === 'friends') {
      btnClass += ' disabled';
      btnText = 'В друзьях';
      btnDisabled = 'disabled';
    } else if (user.friendship_status === 'pending_sent') {
      btnClass += ' pending';
      btnText = 'Ожидает';
      btnDisabled = 'disabled';
    } else if (user.friendship_status === 'pending_received') {
      btnClass += ' accept';
      btnText = 'Принять';
    }

    return `
      <div class="user-card" data-user-id="${user.id}">
        <div class="social-avatar">${esc(user.avatar_letter)}</div>
        <div class="user-info">
          <span class="user-name">${esc(user.username)}</span>
          <span class="user-level">Уровень ${user.level}</span>
        </div>
        <button class="${btnClass}" data-user-id="${user.id}" data-status="${user.friendship_status || ''}" ${btnDisabled}>
          ${btnText}
        </button>
      </div>`;
  }).join('');

  // Add click handlers
  container.querySelectorAll('.add-friend-btn:not([disabled])').forEach(btn => {
    btn.onclick = async () => {
      const userId = parseInt(btn.dataset.userId);
      const status = btn.dataset.status;

      if (status === 'pending_received') {
        // Accept incoming request - need to find request id
        const friendsData = await getFriends();
        const req = friendsData.incoming.find(r => r.user_id === userId);
        if (req) {
          await respondToRequest(req.id, 'accept');
          btn.classList.remove('accept');
          btn.classList.add('disabled');
          btn.textContent = 'В друзьях';
          btn.disabled = true;
        }
      } else {
        // Send friend request
        const result = await sendFriendRequest(userId);
        if (result && result.success) {
          btn.classList.add('pending');
          btn.textContent = 'Ожидает';
          btn.disabled = true;
        }
      }
    };
  });
}

async function loadFriendsData() {
  const data = await getFriends();
  if (!data) return;

  const incomingSection = $('incoming-requests-section');
  const outgoingSection = $('outgoing-requests-section');
  const incomingList = $('incoming-requests');
  const outgoingList = $('outgoing-requests');
  const incomingCount = $('incoming-count');
  const friendsEmpty = $('friends-empty');

  // Render incoming requests
  if (data.incoming && data.incoming.length > 0) {
    incomingSection.style.display = 'block';
    incomingCount.textContent = data.incoming.length;
    incomingList.innerHTML = data.incoming.map(req => `
      <div class="request-item" data-request-id="${req.id}">
        <div class="social-avatar">${esc(req.avatar_letter)}</div>
        <div class="request-info">
          <span class="user-name">${esc(req.username)}</span>
          <span class="request-time">${formatRelativeTime(req.created_at)}</span>
        </div>
        <div class="request-actions">
          <button class="accept-btn" title="Принять">&#10004;</button>
          <button class="reject-btn" title="Отклонить">&#10006;</button>
        </div>
      </div>`).join('');

    // Add handlers
    incomingList.querySelectorAll('.request-item').forEach(item => {
      const reqId = parseInt(item.dataset.requestId);
      item.querySelector('.accept-btn').onclick = async () => {
        await respondToRequest(reqId, 'accept');
        item.remove();
        const remaining = incomingList.children.length;
        incomingCount.textContent = remaining;
        if (remaining === 0) incomingSection.style.display = 'none';
        loadFriendsFeed();
      };
      item.querySelector('.reject-btn').onclick = async () => {
        await respondToRequest(reqId, 'reject');
        item.remove();
        const remaining = incomingList.children.length;
        incomingCount.textContent = remaining;
        if (remaining === 0) incomingSection.style.display = 'none';
      };
    });
  } else {
    incomingSection.style.display = 'none';
  }

  // Render outgoing requests
  if (data.outgoing && data.outgoing.length > 0) {
    outgoingSection.style.display = 'block';
    outgoingList.innerHTML = data.outgoing.map(req => `
      <div class="request-item outgoing" data-request-id="${req.id}">
        <div class="social-avatar">${esc(req.avatar_letter)}</div>
        <div class="request-info">
          <span class="user-name">${esc(req.username)}</span>
          <span class="request-status">Ожидает ответа</span>
        </div>
        <button class="cancel-btn" title="Отменить">&#10006;</button>
      </div>`).join('');

    // Add handlers
    outgoingList.querySelectorAll('.request-item').forEach(item => {
      const reqId = parseInt(item.dataset.requestId);
      item.querySelector('.cancel-btn').onclick = async () => {
        await cancelFriendRequest(reqId);
        item.remove();
        if (outgoingList.children.length === 0) outgoingSection.style.display = 'none';
      };
    });
  } else {
    outgoingSection.style.display = 'none';
  }

  // Load friends feed
  await loadFriendsFeed();

  // Show/hide empty state - hide if there are requests OR friends with activity
  const hasRequests = (data.incoming && data.incoming.length > 0) ||
                      (data.outgoing && data.outgoing.length > 0);
  const hasFeed = $('friends-feed').children.length > 0;

  friendsEmpty.style.display = (hasRequests || hasFeed) ? 'none' : 'block';
  friendsEmpty.classList.toggle('show', !hasRequests && !hasFeed);
}

async function loadFriendsFeed(append = false) {
  if (!append) feedOffset = 0;

  const feedData = await getFriendsFeed(20, feedOffset);
  if (!feedData) return;

  feedHasMore = feedData.has_more;
  renderFriendsFeed(feedData.feed || [], append);

  const loadMoreBtn = $('load-more-feed');
  loadMoreBtn.style.display = feedHasMore ? 'block' : 'none';
}

function renderFriendsFeed(feed, append = false) {
  const container = $('friends-feed');
  const friendsEmpty = $('friends-empty');

  if (!append) container.innerHTML = '';

  if (feed.length === 0 && !append) {
    return;
  }

  const html = feed.map(item => {
    let actionText = '';
    if (item.activity_type === 'task_completed') {
      actionText = `выполнил задание: "${esc(item.task_text || '')}"`;
    } else if (item.activity_type === 'achievement') {
      actionText = 'получил достижение';
    } else if (item.activity_type === 'level_up') {
      actionText = 'повысил уровень';
    }

    let mediaHtml = '';
    if (item.media_url) {
      if (item.media_type === 'image') {
        mediaHtml = `<img class="social-media" src="${item.media_url}" alt="">`;
      } else if (item.media_type === 'video') {
        mediaHtml = `<div class="video-wrapper"><video class="social-media" src="${item.media_url}" muted playsinline preload="metadata"></video><div class="video-play-overlay"><span class="play-icon">▶</span></div></div>`;
      }
    }

    return `
      <div class="social-item">
        <div class="social-avatar">${esc(item.avatar_letter)}</div>
        ${mediaHtml}
        <div class="social-content">
          <span class="social-user">${esc(item.username)}</span>
          <span class="social-action">${actionText}</span>
          <div class="social-meta">
            <span class="social-xp">+${item.xp_earned} XP</span>
            <span class="social-time">${formatRelativeTime(item.created_at)}</span>
          </div>
        </div>
      </div>`;
  }).join('');

  if (append) {
    container.innerHTML += html;
  } else {
    container.innerHTML = html;
  }

  if (container.children.length > 0) {
    friendsEmpty.classList.remove('show');
  }

  // Initialize video autoplay handlers
  initFeedVideos();
}

function formatRelativeTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'только что';
  if (diffMins < 60) return `${diffMins} мин. назад`;
  if (diffHours < 24) return `${diffHours} ч. назад`;
  if (diffDays < 7) return `${diffDays} дн. назад`;
  return formatTime(timestamp);
}

// ========== SEARCH INIT ==========
function initSearch() {
  const searchInput = $('user-search-input');
  const searchBtn = $('user-search-btn');

  if (!searchInput) return;

  const debouncedSearch = debounce(async (query) => {
    if (query.length < 2) {
      renderSearchResults([]);
      return;
    }
    const result = await searchUsers(query);
    renderSearchResults(result?.users || []);
  }, 300);

  searchInput.addEventListener('input', (e) => {
    debouncedSearch(e.target.value.trim());
  });

  searchBtn.addEventListener('click', async () => {
    const query = searchInput.value.trim();
    if (query.length >= 2) {
      const result = await searchUsers(query);
      renderSearchResults(result?.users || []);
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchBtn.click();
    }
  });
}

// ========== LOAD MORE FEED ==========
$('load-more-feed')?.addEventListener('click', async () => {
  feedOffset += 20;
  await loadFriendsFeed(true);
});

// ========== HORIZONTAL SCROLL ==========
$('achievements-grid')?.addEventListener('wheel', e => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    e.preventDefault();
    e.currentTarget.scrollLeft += e.deltaY;
  }
}, { passive: false });

// ========== MEDIA POPUP ==========
function openMediaPopup(taskId) {
  currentMediaTaskId = taskId;
  const popup = $('media-popup');
  const preview = $('media-preview');
  const cameraView = $('camera-view');

  // Hide camera on open
  cameraView.classList.add('hidden');
  stopCamera();

  // Find media for this task
  const task = state.tasks.find(t => t.id === taskId);
  const media = task?.media;

  if (media) {
    preview.innerHTML = media.type === 'image'
      ? `<img src="${media.url}" alt="Media"><button class="delete-media-btn" onclick="deleteMedia()">🗑️ Удалить</button>`
      : `<video src="${media.url}" controls></video><button class="delete-media-btn" onclick="deleteMedia()">🗑️ Удалить</button>`;
    preview.classList.add('has-media');
  } else {
    preview.innerHTML = '';
    preview.classList.remove('has-media');
  }

  popup.classList.add('show');
}

function closeMediaPopup() {
  $('media-popup').classList.remove('show');
  stopCamera();
  currentMediaTaskId = null;
}

async function uploadMedia(file) {
  if (!file || !currentMediaTaskId) return;

  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`/api/tasks/${currentMediaTaskId}/media`, {
    method: 'POST',
    body: formData
  });

  if (response.ok) {
    const data = await response.json();
    const task = state.tasks.find(t => t.id === currentMediaTaskId);
    if (task) {
      task.media = { type: data.media_type, url: data.url };
    }
    updateTaskMediaIcon(currentMediaTaskId);
    closeMediaPopup();
  }
}

function handleMediaSelect(event) {
  const file = event.target.files[0];
  uploadMedia(file);
  event.target.value = '';
}

async function startCamera(forVideo = false) {
  const cameraView = $('camera-view');
  const video = $('camera-video');
  const captureBtn = $('btn-camera-capture');

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: forVideo
    });
    video.srcObject = cameraStream;
    cameraView.classList.remove('hidden');
    cameraView.dataset.mode = forVideo ? 'video' : 'photo';

    if (forVideo) {
      captureBtn.textContent = '🔴 Записать';
      captureBtn.onclick = startVideoRecording;
    } else {
      captureBtn.textContent = '📸 Снять';
      captureBtn.onclick = capturePhoto;
    }
  } catch (err) {
    alert('Не удалось получить доступ к камере');
    console.error(err);
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  const video = $('camera-video');
  if (video) video.srcObject = null;
}

function capturePhoto() {
  const video = $('camera-video');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  canvas.toBlob(blob => {
    const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });
    uploadMedia(file);
  }, 'image/jpeg', 0.9);
}

function startVideoRecording() {
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(cameraStream, { mimeType: 'video/webm' });

  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const file = new File([blob], 'video.webm', { type: 'video/webm' });
    uploadMedia(file);
  };

  mediaRecorder.start();
  $('btn-camera-capture').textContent = '⏹️ Стоп';
  $('btn-camera-capture').onclick = stopVideoRecording;
}

function stopVideoRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

function updateTaskMediaIcon(taskId) {
  const taskItem = document.querySelector(`.task-item[data-id="${taskId}"]`);
  if (!taskItem) return;

  const mediaEl = taskItem.querySelector('.task-media');
  const task = state.tasks.find(t => t.id === taskId);
  const media = task?.media;

  if (media) {
    mediaEl.innerHTML = media.type === 'image'
      ? `<img src="${media.url}" alt="Task media">`
      : `<video src="${media.url}" muted></video>`;
    mediaEl.classList.add('has-image');
  } else {
    mediaEl.innerHTML = '🖼️';
    mediaEl.classList.remove('has-image');
  }
}

async function deleteMedia() {
  if (!currentMediaTaskId) return;

  const response = await fetch(`/api/tasks/${currentMediaTaskId}/media`, {
    method: 'DELETE'
  });

  if (response.ok) {
    const task = state.tasks.find(t => t.id === currentMediaTaskId);
    if (task) delete task.media;
    updateTaskMediaIcon(currentMediaTaskId);
    closeMediaPopup();
  }
}

// Media popup event listeners
$('media-file-input')?.addEventListener('change', handleMediaSelect);
$('btn-add-media')?.addEventListener('click', () => $('media-file-input').click());
$('btn-take-photo')?.addEventListener('click', () => startCamera(false));
$('btn-take-video')?.addEventListener('click', () => startCamera(true));
$('media-popup-close')?.addEventListener('click', closeMediaPopup);
$('media-popup')?.addEventListener('click', e => {
  if (e.target.id === 'media-popup') closeMediaPopup();
});
$('btn-camera-cancel')?.addEventListener('click', () => {
  $('camera-view').classList.add('hidden');
  stopCamera();
});

// ========== VIDEO AUTOPLAY HANDLERS ==========
function playVideoMuted(video) {
  if (!video || !video.paused) return;
  video.muted = true;
  const wrapper = video.closest('.video-wrapper');
  video.play()
    .then(() => { if (wrapper) wrapper.classList.add('playing'); })
    .catch(() => {});
}

function pauseVideo(video) {
  if (!video || video.paused) return;
  video.pause();
  const wrapper = video.closest('.video-wrapper');
  if (wrapper) wrapper.classList.remove('playing');
}

function initMobileVideoObserver() {
  if (videoObserver) videoObserver.disconnect();
  videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const video = entry.target;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        playVideoMuted(video);
      } else {
        pauseVideo(video);
      }
    });
  }, { threshold: [0, 0.5, 1.0] });
}

function addDesktopVideoHandlers(video) {
  video.addEventListener('mouseenter', () => { if (!isMobileDevice) playVideoMuted(video); });
  video.addEventListener('mouseleave', () => { if (!isMobileDevice) pauseVideo(video); });
}

function openVideoFullscreen(src) {
  const lightbox = $('social-lightbox');
  const content = $('social-lightbox-content');
  content.innerHTML = `<video src="${src}" autoplay playsinline></video>`;
  const video = content.querySelector('video');
  video.currentTime = 0;
  video.muted = false;

  // Apply fullscreen to container, not video - this hides browser controls
  if (content.requestFullscreen) {
    content.requestFullscreen().catch(() => {});
  } else if (content.webkitRequestFullscreen) {
    content.webkitRequestFullscreen();
  }
  lightbox.classList.add('show');
}

function initFeedVideos() {
  const container = $('friends-feed');
  if (!container) return;
  const videos = container.querySelectorAll('video.social-media');
  videos.forEach(video => {
    addDesktopVideoHandlers(video);
    if (isMobileDevice && videoObserver) {
      videoObserver.observe(video);
    }
  });
}

function reinitVideoHandlers() {
  const container = $('friends-feed');
  if (!container) return;
  const videos = container.querySelectorAll('video.social-media');
  if (videoObserver) videoObserver.disconnect();
  videos.forEach(video => pauseVideo(video));
  if (isMobileDevice) {
    initMobileVideoObserver();
    videos.forEach(video => videoObserver.observe(video));
  }
}

// ========== SOCIAL LIGHTBOX ==========
function openSocialLightbox(src, isVideo) {
  const lightbox = $('social-lightbox');
  const content = $('social-lightbox-content');
  if (isVideo) {
    content.innerHTML = `<video src="${src}" autoplay playsinline></video>`;
  } else {
    content.innerHTML = `<img src="${src}" alt="">`;
  }
  lightbox.classList.add('show');
}

function closeSocialLightbox() {
  const lightbox = $('social-lightbox');
  const content = $('social-lightbox-content');
  const video = content.querySelector('video');
  if (video) video.pause();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  lightbox.classList.remove('show');
  content.innerHTML = '';
}

$('social-lightbox')?.addEventListener('click', closeSocialLightbox);

// Delegate clicks on .social-media in feed
$('friends-feed')?.addEventListener('click', e => {
  const media = e.target.closest('.social-media');
  if (media) {
    e.stopPropagation();
    if (media.tagName === 'VIDEO') {
      openVideoFullscreen(media.src);
    } else {
      openSocialLightbox(media.src, false);
    }
  }
});

// ========== INIT ==========
// Inject particle animation
const style = document.createElement('style');
style.textContent = `@keyframes particle-float{0%{opacity:1;transform:translate(0,0) scale(1) rotate(0)}100%{opacity:0;transform:translate(var(--tx,0),var(--ty,-100px)) scale(0) rotate(360deg)}}`;
document.head.appendChild(style);

// Initialize device detection and video observer
checkIfMobile();
if (isMobileDevice) initMobileVideoObserver();

// Initialize tabs
initTabs();
initSearch();
loadHistory();

// Load state from server
loadState().then(() => {
  $('task-input').focus();
  // Connect to SSE after initial load
  connectSSE();
});

// ========== AUTO-REFRESH ==========

// Refresh state when tab becomes visible (user returns to tab)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    console.log('Tab visible - refreshing data...');
    loadState();
  }
});

// Refresh state when window regains focus
window.addEventListener('focus', () => {
  console.log('Window focused - refreshing data...');
  loadState();
});

// Periodic background refresh (every 60 seconds)
// Only used as fallback when SSE is not available
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    // Only refresh if tab is visible and SSE is not connected
    if (!document.hidden && !eventSource) {
      console.log('Auto-refreshing data (SSE not available)...');
      loadState();
    }
  }, 60000); // 60 seconds
}

// Start auto-refresh
startAutoRefresh();

// Stop auto-refresh and SSE on page unload
window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (eventSource) {
    eventSource.close();
    console.log('SSE connection closed');
  }
});
