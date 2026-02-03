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
  const subtabsNav = $('subtabs-nav');

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

      // Show/hide subtabs for SOCIAL tab
      subtabsNav.classList.toggle('show', tabId === 'social');

      // Render content if needed
      if (tabId === 'history') renderHistory();
      if (tabId === 'social') loadFriendsData();
    });
  });
}

// ========== SOCIAL SUB-TABS ==========
function initSubTabs() {
  const subtabBtns = document.querySelectorAll('.subtab-btn');
  const subtabContents = document.querySelectorAll('.subtab-content');

  subtabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const subtabId = btn.dataset.subtab;

      // Update active button
      subtabBtns.forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');

      // Show selected content
      subtabContents.forEach(content => {
        content.style.display = content.id === `subtab-${subtabId}` ? 'block' : 'none';
      });

      // Load friends data when switching to friends subtab
      if (subtabId === 'friends') loadFriendsData();
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

  if (!users || users.length === 0) {
    container.innerHTML = '';
    empty.classList.add('show');
    return;
  }

  empty.classList.remove('show');
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

    return `
      <div class="social-item">
        <div class="social-avatar">${esc(item.avatar_letter)}</div>
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

// ========== INIT ==========
// Inject particle animation
const style = document.createElement('style');
style.textContent = `@keyframes particle-float{0%{opacity:1;transform:translate(0,0) scale(1) rotate(0)}100%{opacity:0;transform:translate(var(--tx,0),var(--ty,-100px)) scale(0) rotate(360deg)}}`;
document.head.appendChild(style);

// Initialize tabs
initTabs();
initSubTabs();
initSearch();
loadHistory();

// Load state from server
loadState().then(() => {
  $('task-input').focus();
});
