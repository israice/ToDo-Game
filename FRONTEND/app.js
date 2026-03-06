/* Quest Todo - Server-side Version */

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
  achievements: {}, streak: 0, sound: false
};
let comboTimer = null;
let audioCtx = null;

// WebSocket connection
let socket = null;
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

// Tab animation lock
let _tabAnimating = false;

// Drag-scroll offset for tasks carousel
let scrollOffset = 0;
let drumFraction = 0; // fractional offset for smooth 3D rotation (-0.5 to 0.5)

// ========== UTILITIES ==========
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function getSortedTasks() {
  return [...state.tasks].sort((a, b) => {
    const sa = a.scheduled_start || '';
    const sb = b.scheduled_start || '';
    if (sa && sb) return sa.localeCompare(sb);
    if (sa) return -1;
    if (sb) return 1;
    return 0;
  });
}

function getDrumBounds(highlightIdx) {
  const min = -highlightIdx;
  const max = Math.max(0, state.tasks.length - highlightIdx - 1);
  return { min, max };
}

function getTimePeriodInfo(hour) {
  if (hour < 0) return { cls: '', icon: '' };
  if (hour < 6) return { cls: 'time-night', icon: '\uD83C\uDF19' };
  if (hour < 12) return { cls: 'time-morning', icon: '\uD83C\uDF05' };
  if (hour < 18) return { cls: 'time-day', icon: '\u2600\uFE0F' };
  return { cls: 'time-evening', icon: '\uD83C\uDF07' };
}

function createDateSpan(dateData, extraClass = '') {
  const span = document.createElement('span');
  span.className = ('task-date ' + extraClass).trim();
  const dayEl = document.createElement('span');
  dayEl.className = 'task-date-day';
  dayEl.textContent = dateData.day;
  const timeEl = document.createElement('span');
  timeEl.className = 'task-date-time';
  timeEl.textContent = dateData.time;
  span.appendChild(dayEl);
  span.appendChild(timeEl);
  return span;
}

function processNewAchievements(achIds, leveledUp) {
  achIds.forEach(achId => {
    state.achievements[achId] = true;
    const ach = ACHIEVEMENTS.find(a => a.id === achId);
    // achievements logged server-side via activity_log
  });
  if (achIds.length) renderAchievements();
  if (leveledUp) {
    showPopup('levelup', achIds);
  } else {
    achIds.forEach((achId, i) => setTimeout(() => showPopup('achievement', achId), i * 500));
  }
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
  ['firstQuest', 'First Steps', 'Complete your first quest', '&#127941;'],
  ['fiveQuests', 'Traveler', 'Complete 5 quests', '&#9876;'],
  ['tenQuests', 'Veteran', 'Complete 10 quests', '&#128737;'],
  ['twentyFiveQuests', 'Hero', 'Complete 25 quests', '&#129409;'],
  ['fiftyQuests', 'Legend', 'Complete 50 quests', '&#128081;'],
  ['combo3', 'Combo Starter', 'Reach combo x3', '&#128293;'],
  ['combo5', 'On Fire!', 'Reach combo x5', '&#9889;'],
  ['combo10', 'Unstoppable', 'Reach combo x10', '&#127775;'],
  ['level5', 'Rising Star', 'Reach level 5', '&#11088;'],
  ['level10', 'Master', 'Reach level 10', '&#128142;'],
  ['streak7', 'Weekly Warrior', 'Maintain a 7-day streak', '&#128170;'],
  ['streak30', 'Monthly Master', 'Maintain a 30-day streak', '&#127942;'],
].map(([id, name, desc, icon]) => ({ id, name, desc, icon }));

// ========== API HELPERS ==========
async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
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
  
}

// Connection status indicator
let connectionIndicator = null;
function updateConnectionStatus(connected) {
  if (!connectionIndicator) {
    connectionIndicator = document.createElement('div');
    connectionIndicator.id = 'connection-indicator';
    connectionIndicator.style.cssText = 'position:fixed;bottom:10px;left:10px;padding:8px 12px;border-radius:4px;font-size:12px;z-index:9999;transition:opacity 0.3s;';
    document.body.appendChild(connectionIndicator);
  }

  if (connected) {
    connectionIndicator.style.background = '#00d9a5';
    connectionIndicator.style.color = '#000';
    connectionIndicator.textContent = '● Online';
    connectionIndicator.style.opacity = '0';
    setTimeout(() => {
      if (connectionIndicator) connectionIndicator.style.opacity = '0';
    }, 2000);
  } else {
    connectionIndicator.style.background = '#e74c3c';
    connectionIndicator.style.color = '#fff';
    connectionIndicator.textContent = '● No connection...';
    connectionIndicator.style.opacity = '1';
  }
}

// ========== WebSocket (Native) ==========

let wasConnected = false;  // Track if we had a connection before

function connectWebSocket() {
  if (socket) {
    socket.close();
    socket = null;
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);

  socket.onopen = () => {
    console.log('✓ WebSocket connected');
    reconnectAttempts = 0;

    // If reconnecting after disconnection, refresh state to catch missed events
    if (wasConnected) {
      console.log('🔄 Reconnected - refreshing state...');
      loadState();
    }
    wasConnected = true;
    updateConnectionStatus(true);
  };

  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleWebSocketEvent(msg.event, msg.data);
  };

  socket.onclose = (e) => {
    console.log('✗ WebSocket disconnected:', e.code, e.reason);

    // Auth error - don't reconnect
    if (e.code === 4001) return;

    updateConnectionStatus(false);

    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`🔄 Reconnecting (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
      setTimeout(connectWebSocket, RECONNECT_DELAY_MS);
    } else {
      console.error('❌ Max reconnection attempts reached');
      updateConnectionStatus(false);
      setTimeout(() => window.location.reload(), 3000);
    }
  };

  socket.onerror = (err) => {
    console.error('❌ WebSocket error:', err);
  };

  console.log('📡 Connecting to WebSocket...');
}

function handleWebSocketEvent(event, data) {
  switch (event) {
    case 'connected':
      console.log('✓ Authenticated:', data);
      break;

    case 'task_created':
      console.log('📝 Task created (WS):', data);
      if (pendingTasks.has(data.id)) {
        console.log('⊘ Skipping duplicate task_created event for pending task:', data.id);
        return;
      }
      const existingTask = state.tasks.find(t => t.id === data.id);
      if (!existingTask) {
        state.tasks.unshift({ id: data.id, text: data.text, xp: data.xp,
          scheduled_start: data.scheduled_start, scheduled_end: data.scheduled_end });
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
      break;

    case 'task_updated': {
      if (pendingEdits.has(data.id)) return;
      const task = state.tasks.find(t => t.id === data.id);
      if (task) {
        task.text = data.text;
        if (data.scheduled_start !== undefined) task.scheduled_start = data.scheduled_start;
        if (data.scheduled_end !== undefined) task.scheduled_end = data.scheduled_end;
        renderTasks();
      }
      break;
    }

    case 'task_deleted': {
      if (pendingDeletes.has(data.id)) return;
      const taskIndex = state.tasks.findIndex(t => t.id === data.id);
      if (taskIndex !== -1) {
        state.tasks.splice(taskIndex, 1);
        renderTasks();
      }
      break;
    }

    case 'task_completed': {
      console.log('✅ Task completed (WS):', data);
      if (pendingCompletes.has(data.id)) {
        console.log('⊘ Skipping duplicate task_completed event for pending task:', data.id);
        return;
      }
      const idx = state.tasks.findIndex(t => t.id === data.id);
      if (idx !== -1) state.tasks.splice(idx, 1);
      Object.assign(state, { level: data.level, xp: data.xp, xpMax: data.xpMax, completed: data.completed, streak: data.streak, combo: data.combo });
      const wsAch = data.newAchievements || [];
      processNewAchievements(wsAch, data.leveledUp);
      if (state.combo > 1) playSound('combo');
      renderTasks();
      updateUI();
      break;
    }

    case 'server_shutdown':
      console.log('🔄 Server shutting down:', data.message);
      setTimeout(() => window.location.reload(true), 2000);
      break;
  }
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
    delete: () => play([300, 100], 0.15, 0.2),
    tick: () => {
      // Revolver cylinder click — sharp metallic click
      const len = Math.floor(audioCtx.sampleRate * 0.06);
      const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const t = i / audioCtx.sampleRate;
        // Initial sharp transient + metallic ring
        d[i] = ((Math.random() * 2 - 1) * Math.exp(-t * 150) +
                 Math.sin(t * 3500) * Math.exp(-t * 80) * 0.6) * 0.7;
      }
      const n = audioCtx.createBufferSource();
      n.buffer = buf;
      const bp = audioCtx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 2;
      const g = audioCtx.createGain();
      g.gain.value = 0.6;
      n.connect(bp); bp.connect(g); g.connect(audioCtx.destination);
      n.start(now);
    }
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
    'streak-count': state.streak, 'achievements-count': Object.keys(state.achievements).length };
  for (const [id, val] of Object.entries(txt)) { const el = $(id); if (el) el.textContent = val; }
  const lvlTop = $('level-top'); if (lvlTop) lvlTop.textContent = state.level;
  const xpFill = $('xp-fill'); if (xpFill) xpFill.style.width = (state.xp / state.xpMax * 100) + '%';
  $('combo-container').classList.toggle('active', state.combo > 0);
  $('combo').textContent = state.combo;
  $('sound-icon').innerHTML = state.sound ? '&#128266;' : '&#128263;';
  const ss = $('sound-status'); if (ss) ss.textContent = state.sound ? 'ON' : 'OFF';
}

// ========== DATE FORMATTING ==========
function formatTaskDate(iso) {
  if (!iso) return { day: '', time: '' };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { day: '', time: '' };
  const day = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return { day, time };
}

function getHourFromISO(iso) {
  if (!iso) return -1;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? -1 : d.getHours();
}

// ========== RENDER TASKS (3D Drum Roller) ==========
const _bd = document.body.dataset;
const ROW_HEIGHT_SETTING = Number(_bd.drumRowHeight) || 20;
const MAX_TOP_ANGLE = Number(_bd.drumMaxTopAngle) || 85;
const PERSP_K = Number(_bd.drumPerspectiveK) || 2;
const HIGHLIGHT_OFFSET = Number(_bd.drumHighlightOffset) ?? 2;

function getDrumParams() {
  const list = $('tasks-list');
  const h = list ? list.clientHeight : 700;
  if (h < 50) return { totalRows: 11, centerIdx: 5, highlightIdx: 5, radius: 220, angleStep: 11 };

  // How many rows fit the screen height
  const isLarge = window.innerWidth >= MOBILE_BREAKPOINT;
  const rowHeight = isLarge ? ROW_HEIGHT_SETTING : Math.max(20, Math.round(ROW_HEIGHT_SETTING * 0.85));
  const raw = Math.max(7, Math.floor(h / rowHeight));
  const totalRows = raw % 2 === 1 ? raw : raw - 1; // ensure odd
  const centerIdx = (totalRows - 1) / 2;

  // On large screens, highlight row is above center
  const highlightIdx = isLarge ? Math.max(0, Math.min(totalRows - 1, centerIdx - HIGHLIGHT_OFFSET)) : centerIdx;

  // Angle per row: spread rows evenly across ±MAX_TOP_ANGLE
  const angleStep = MAX_TOP_ANGLE / centerIdx;
  const topAngleRad = MAX_TOP_ANGLE * Math.PI / 180;

  // Radius with perspective compensation so projected top row hits screen edge
  const sinA = Math.sin(topAngleRad);
  const cosA = Math.cos(topAngleRad);
  const radius = sinA > 0 ? (h / 2) * (PERSP_K + 1 - cosA) / (PERSP_K * sinA) : 220;

  return { totalRows, centerIdx, highlightIdx, radius, angleStep };
}

function renderTasks() {
  if (_tabAnimating) return;   // drum reads clientHeight — wrong during transform

  if (_drumNeedsReset) {
    _drumNeedsReset = false;
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    const idx = findCurrentTaskIndex();
    const { highlightIdx } = getDrumParams();
    scrollOffset = idx - highlightIdx;
    drumFraction = 0;
  }

  const list = $('tasks-list');
  list.textContent = '';
  const empty = state.tasks.length === 0;
  $('empty-state').classList.toggle('show', empty);

  const sorted = getSortedTasks();

  const { totalRows, centerIdx, highlightIdx, radius, angleStep } = getDrumParams();

  // Clamp scrollOffset (skip during active scroll animation to avoid blocking it)
  const { min: minOffset, max: maxOffset } = getDrumBounds(highlightIdx);
  if (_drumScrollTarget === null) {
    scrollOffset = Math.max(minOffset, Math.min(maxOffset, scrollOffset));
  }

  // Set perspective proportional to radius for consistent visual depth
  list.style.perspective = Math.round(radius * PERSP_K) + 'px';
  // Wrapper pushed back by -radius so center item (translateZ=+radius) ends at Z=0
  const wrapper = document.createElement('div');
  wrapper.className = 'drum-wrapper';
  wrapper.style.transform = 'translateZ(' + (-radius) + 'px)';
  list.appendChild(wrapper);

  const highlightTaskIdx = scrollOffset + highlightIdx;

  // Measure actual highlight card height to compute symmetric expand
  let expandExtra = 0;
  let centerH = 38; // default card height
  if (highlightTaskIdx >= 0 && highlightTaskIdx < sorted.length) {
    const ct = sorted[highlightTaskIdx];
    const probe = document.createElement('li');
    probe.className = 'task-item center';
    probe.style.cssText = 'position:absolute;left:8px;right:8px;visibility:hidden;pointer-events:none;';
    const pText = document.createElement('span');
    pText.className = 'task-text';
    pText.textContent = ct.text;
    const pMedia = document.createElement('span'); pMedia.className = 'task-media'; pMedia.textContent = '\uD83D\uDDBC\uFE0F';
    const pCheck = document.createElement('label'); pCheck.className = 'task-checkbox';
    const pIcon = document.createElement('span'); pIcon.className = 'task-time-icon';
    const pDates = document.createElement('div'); pDates.className = 'task-dates';
    const pDate1 = document.createElement('span'); pDate1.className = 'task-date';
    const pDate2 = document.createElement('span'); pDate2.className = 'task-date';
    pDates.append(pDate1, pDate2);
    const pDel = document.createElement('button'); pDel.className = 'task-delete';
    probe.append(pMedia, pCheck, pIcon, pText, pDates, pDel);
    list.appendChild(probe);
    centerH = probe.offsetHeight;
    list.removeChild(probe);
    if (centerH > 38) {
      // Projected pixel gap between adjacent cards on drum
      const projGap = radius * Math.sin(angleStep * Math.PI / 180);
      // Overlap: center half-height vs neighbor top edge (neighbor center at projGap, top at projGap - 19)
      const overlap = centerH / 2 - (projGap - 19) + 4;
      if (overlap > 0) {
        expandExtra = (overlap / Math.max(1, projGap)) * angleStep;
      }
    }
  }

  for (let idx = 0; idx < totalRows; idx++) {
    const taskIdx = scrollOffset + idx;
    let angle = (idx - centerIdx - drumFraction) * angleStep;
    // Push non-highlight cards away symmetrically if highlight card is tall
    if (idx !== highlightIdx && expandExtra > 0) {
      angle += Math.sign(idx - highlightIdx) * expandExtra;
    }
    const absAngle = Math.abs(angle);
    const opacity = Math.max(0.15, 1 - absAngle / 120);

    // Placeholder if out of bounds
    if (taskIdx < 0 || taskIdx >= sorted.length) {
      const li = document.createElement('li');
      li.className = 'task-item placeholder';
      li.style.transform = 'rotateX(' + angle + 'deg) translateZ(' + radius + 'px)';
      li.style.opacity = opacity;
      li.dataset.drumIdx = idx;

      wrapper.appendChild(li);
      continue;
    }

    const task = sorted[taskIdx];
    const li = document.createElement('li');
    const hour = getHourFromISO(task.scheduled_start);
    const { cls: timePeriod, icon: timeIconText } = getTimePeriodInfo(hour);
    const isHighlight = idx === highlightIdx;
    li.className = 'task-item' + (timePeriod ? ' ' + timePeriod : '') + (isHighlight ? ' center' : '');
    li.style.transform = 'rotateX(' + angle + 'deg) translateZ(' + radius + 'px)';
    li.style.opacity = opacity;
    // Center tall card symmetrically on drum axis
    if (isHighlight && centerH > 38) {
      li.style.top = 'calc(50% - ' + (centerH / 2) + 'px)';
    }
    li.dataset.id = task.id;

    const start = formatTaskDate(task.scheduled_start);
    const end = formatTaskDate(task.scheduled_end);

    // Build task item using DOM methods
    const mediaSpan = document.createElement('span');
    mediaSpan.className = 'task-media' + (task.media ? ' has-image' : '');
    if (task.media) {
      const mediaEl = task.media.type === 'image' ? document.createElement('img') : document.createElement('video');
      mediaEl.src = task.media.url;
      if (task.media.type === 'image') mediaEl.alt = '';
      else mediaEl.muted = true;
      mediaSpan.appendChild(mediaEl);
    } else {
      mediaSpan.textContent = '\uD83D\uDDBC\uFE0F';
    }

    const checkLabel = document.createElement('label');
    checkLabel.className = 'task-checkbox';
    const checkInput = document.createElement('input');
    checkInput.type = 'checkbox';
    checkInput.setAttribute('aria-label', 'Complete quest');
    const checkCustom = document.createElement('span');
    checkCustom.className = 'checkbox-custom';
    checkLabel.appendChild(checkInput);
    checkLabel.appendChild(checkCustom);

    const textSpan = document.createElement('span');
    textSpan.className = 'task-text';
    textSpan.textContent = task.text;

    const sameDate = start.day && end.day && start.day === end.day && start.time === end.time;
    const startDateSpan = createDateSpan(start, sameDate ? 'task-date-same' : 'task-date-start');
    const endDateSpan = createDateSpan(end, sameDate ? 'task-date-same' : 'task-date-end');
    const datesWrapper = document.createElement('div');
    datesWrapper.className = 'task-dates';
    datesWrapper.appendChild(startDateSpan);
    datesWrapper.appendChild(endDateSpan);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'task-delete';
    deleteBtn.setAttribute('aria-label', 'Delete quest');
    deleteBtn.textContent = '\uD83D\uDDD1';

    const timeIcon = document.createElement('span');
    timeIcon.className = 'task-time-icon';
    timeIcon.textContent = timeIconText;

    li.appendChild(mediaSpan);
    li.appendChild(checkLabel);
    li.appendChild(timeIcon);
    li.appendChild(textSpan);
    li.appendChild(datesWrapper);
    li.appendChild(deleteBtn);

    checkInput.onchange = () => completeTask(task.id, li);
    deleteBtn.onclick = () => deleteTask(task.id, li);
    mediaSpan.onclick = () => openMediaPopup(task.id);

    li.dataset.drumIdx = idx;

    let original = task.text;
    const debouncedEdit = debounce((id, text) => editTask(id, text), DEBOUNCE_DELAY_MS);
    // Long press to edit — stored on the element for access from drag handler
    textSpan._enterEdit = () => {
      original = task.text;
      list.classList.add('editing');
      textSpan.setAttribute('contenteditable', 'true');
      const hl = document.createElement('span');
      hl.className = 'edit-highlight';
      hl.innerText = textSpan.innerText;
      textSpan.innerText = '';
      textSpan.appendChild(hl);
      textSpan.focus();
      document.getSelection().selectAllChildren(hl);
    };
    let editing = false;
    const exitEdit = (save) => {
      if (!editing) return;
      editing = false;
      const text = textSpan.innerText.trim();
      // Remove highlight wrapper
      textSpan.innerText = text || original;
      textSpan.removeAttribute('contenteditable');
      list.classList.remove('editing');
      if (save && text && text !== original) debouncedEdit(task.id, text);
    };
    const origEnterEdit = textSpan._enterEdit;
    textSpan._enterEdit = () => { editing = true; origEnterEdit(); };
    textSpan.onblur = () => exitEdit(true);
    textSpan.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textSpan.blur(); } else if (e.key === 'Escape') { exitEdit(false); } };

    wrapper.appendChild(li);
  }


  const taskCount = $('task-count');
  if (taskCount) taskCount.textContent = `(${state.tasks.length})`;
}

// ========== DRAG-SCROLL FOR TASKS CAROUSEL ==========
let _drumSnapRaf = 0;
let _drumScrollTarget = null;
let _drumNeedsReset = false;

// Find the sorted index of the current/next task (closest to now)
function findCurrentTaskIndex() {
  const sorted = getSortedTasks();
  const now = new Date().toISOString();
  // Find the last task that already started (scheduled_start <= now)
  let lastStarted = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].scheduled_start && sorted[i].scheduled_start <= now) {
      lastStarted = i;
      break;
    }
  }
  if (lastStarted >= 0) return lastStarted;
  // No started task — find first upcoming
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].scheduled_start && sorted[i].scheduled_start >= now) return i;
  }
  // All tasks have no date — show first
  return 0;
}

function scrollToCurrentTask(instant) {
  const idx = findCurrentTaskIndex();
  const { highlightIdx } = getDrumParams();
  if (instant) {
    // Jump directly without animation
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    scrollOffset = idx - highlightIdx;
    drumFraction = 0;
    renderTasks();
  } else {
    scrollToTarget(idx - highlightIdx);
  }
}

function scrollToNewTask(id) {
  const sorted = getSortedTasks();
  const idx = sorted.findIndex(t => t.id === id);
  if (idx >= 0) {
    const { highlightIdx } = getDrumParams();
    scrollToTarget(idx - highlightIdx);
    resetIdleTimer();
  }
}

function scrollToTarget(target) {
  cancelAnimationFrame(_drumSnapRaf);
  const { highlightIdx } = getDrumParams();
  const { min, max } = getDrumBounds(highlightIdx);
  _drumScrollTarget = Math.max(min, Math.min(max, target));
  if (_drumSnapAnimate) _drumSnapRaf = requestAnimationFrame(_drumSnapAnimate);
}

let _drumSnapAnimate; // assigned inside initTaskDrag

function initTaskDrag() {
  const list = $('tasks-list');
  if (!list) return;

  const ROW_PX = 30; // pixels of drag per 1 row shift
  let startY = 0;
  let startX = 0;
  let startRawOffset = 0;
  let isDragging = false;
  let directionLocked = false;
  let tapTarget = null;
  let _prevTickOffset = scrollOffset;

  function drumTick() {
    // Don't tick if at boundary (clamped — no real movement)
    const { highlightIdx } = getDrumParams();
    const { min, max } = getDrumBounds(highlightIdx);
    const clamped = Math.max(min, Math.min(max, scrollOffset));
    if (clamped !== _prevTickOffset) { playSound('tick'); _prevTickOffset = clamped; }
  }

  function clampDrum() {
    const { highlightIdx } = getDrumParams();
    const { min, max } = getDrumBounds(highlightIdx);
    const raw = scrollOffset + drumFraction;
    if (raw < min) { scrollOffset = min; drumFraction = 0; }
    else if (raw > max) { scrollOffset = max; drumFraction = 0; }
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;

    // Determine direction on first significant movement
    if (!directionLocked && (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8)) {
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        // Horizontal — release capture so swipe can work
        isDragging = false;
        directionLocked = false;
        list.releasePointerCapture(e.pointerId);
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        list.classList.remove('dragging');
        clearTimeout(_listLongPressTimer);
        _listLongPressTimer = null;
        return;
      }
      directionLocked = true;
    }

    // Cancel long press if user starts dragging
    if (_listLongPressTimer && Math.abs(deltaY) > 5) {
      clearTimeout(_listLongPressTimer);
      _listLongPressTimer = null;
    }
    const rawOffset = startRawOffset + deltaY / ROW_PX;
    scrollOffset = Math.round(rawOffset);
    drumFraction = rawOffset - scrollOffset;
    clampDrum();
    drumTick();
    renderTasks();
  }

  function snapAnimate() {
    // Multi-step scroll toward target (click-to-scroll)
    if (_drumScrollTarget !== null) {
      const diff = _drumScrollTarget - (scrollOffset + drumFraction);
      if (Math.abs(diff) < 0.005) {
        scrollOffset = _drumScrollTarget;
        drumFraction = 0;
        _drumScrollTarget = null;
        drumTick();
        renderTasks();
        list.classList.remove('dragging');
        return;
      }
      const step = diff * 0.18;
      const raw = scrollOffset + drumFraction + step;
      scrollOffset = Math.round(raw);
      drumFraction = raw - scrollOffset;
      drumTick();
      renderTasks();
      _drumSnapRaf = requestAnimationFrame(snapAnimate);
      return;
    }

    // Simple fraction snap (after drag/wheel)
    if (Math.abs(drumFraction) < 0.005) {
      drumFraction = 0;
      drumTick();
      renderTasks();
      list.classList.remove('dragging');
      return;
    }
    drumFraction *= 0.82; // exponential ease-out
    renderTasks();
    _drumSnapRaf = requestAnimationFrame(snapAnimate);
  }
  _drumSnapAnimate = snapAnimate;

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    clearTimeout(_listLongPressTimer);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);

    // If long press already triggered edit, skip tap logic
    if (_listDidLongPress) {
      _listDidLongPress = false;
      tapTarget = null;
      list.classList.remove('dragging');
      return;
    }

    // Detect tap (no significant drag)
    const totalDrag = Math.abs(e.clientY - startY);
    if (totalDrag < 5 && tapTarget) {
      const idx = Number(tapTarget.dataset.drumIdx);
      const { highlightIdx } = getDrumParams();
      if (!isNaN(idx) && idx !== highlightIdx) {
        // Scroll non-highlight row to red border
        scrollToTarget(scrollOffset + (idx - highlightIdx));
        tapTarget = null;
        list.classList.remove('dragging');
        return;
      }
      if (!isNaN(idx) && idx === highlightIdx) {
        // Tap on highlight row — only trigger specific elements
        tapTarget = null;
        list.classList.remove('dragging');
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el) {
          // Only text editing if clicked directly on text node content
          const textEl = el.closest('.task-text');
          if (textEl && el === textEl && textEl.textContent.trim()) {
            // Check if click X is within the actual text width
            const range = document.createRange();
            range.selectNodeContents(textEl);
            const textRect = range.getBoundingClientRect();
            if (e.clientX <= textRect.right) {
              textEl.click();
              return;
            }
          }
          // Other interactive elements
          const btn = el.closest('button');
          if (btn) { btn.click(); return; }
          const label = el.closest('label');
          if (label) { label.click(); return; }
          const media = el.closest('.task-media');
          if (media) { media.click(); return; }
        }
        return;
      }
    }
    tapTarget = null;

    // Smooth snap via rAF — no CSS transitions, no flicker
    _drumSnapRaf = requestAnimationFrame(snapAnimate);
  }

  let _listLongPressTimer = null;
  let _listDidLongPress = false;

  // Prevent native context menu during long press on task text
  list.addEventListener('contextmenu', e => {
    if (e.target.closest('.task-text') && !e.target.closest('[contenteditable="true"]')) {
      e.preventDefault();
    }
  });

  list.addEventListener('pointerdown', e => {
    // Skip drag when interacting with buttons, inputs, or editable text
    if (e.target.closest('button, input, label, [contenteditable="true"]')) return;
    tapTarget = e.target.closest('.task-item');
    _listDidLongPress = false;
    clearTimeout(_listLongPressTimer);

    // Start long press timer for text editing
    const textEl = e.target.closest('.task-text');
    if (textEl && tapTarget && !textEl.hasAttribute('contenteditable')) {
      _listLongPressTimer = setTimeout(() => {
        _listDidLongPress = true;
        const idx = Number(tapTarget.dataset.drumIdx);
        const { highlightIdx } = getDrumParams();
        if (!isNaN(idx) && idx === highlightIdx && textEl._enterEdit) {
          textEl._enterEdit();
        }
      }, 500);
    }

    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    isDragging = true;
    directionLocked = false;
    startY = e.clientY;
    startX = e.clientX;
    // Include leftover fraction so re-grab mid-snap feels continuous
    startRawOffset = scrollOffset + drumFraction;
    list.classList.add('dragging');
    list.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  });

  // Keyboard arrows
  let _keyRepeatTimer = null;
  let _keyRepeatInterval = null;

  function drumArrowStep(direction, instant) {
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    const { highlightIdx } = getDrumParams();
    const { min, max } = getDrumBounds(highlightIdx);
    const next = scrollOffset + direction;
    if (next < min || next > max) return;
    scrollOffset = next;
    drumTick();
    if (instant) {
      drumFraction = 0;
      renderTasks();
    } else {
      drumFraction = -direction * 0.4;
      _drumSnapRaf = requestAnimationFrame(snapAnimate);
    }
  }

  function stopKeyRepeat() {
    clearTimeout(_keyRepeatTimer);
    clearInterval(_keyRepeatInterval);
    _keyRepeatTimer = null;
    _keyRepeatInterval = null;
  }

  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (e.repeat) return; // ignore native repeat, we handle our own
    const dir = e.key === 'ArrowUp' ? 1 : -1;
    drumArrowStep(dir);
    resetIdleTimer();
    stopKeyRepeat();
    _keyRepeatTimer = setTimeout(() => {
      _keyRepeatInterval = setInterval(() => {
        drumArrowStep(dir, true);
        resetIdleTimer();
      }, 300);
    }, 500); // initial delay before repeat starts
  });

  document.addEventListener('keyup', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      stopKeyRepeat();
    }
  });

  // Mouse wheel / trackpad scroll
  list.addEventListener('wheel', e => {
    // During editing, let scroll happen inside the text
    if (e.target.closest('[contenteditable="true"]')) return;
    e.preventDefault();
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    const { highlightIdx } = getDrumParams();
    const { min, max } = getDrumBounds(highlightIdx);
    const delta = e.deltaY > 0 ? -1 : 1;
    const next = scrollOffset + delta;
    if (next < min || next > max) return; // at boundary — stop
    scrollOffset = next;
    drumTick();
    drumFraction = -delta * 0.4; // start with visual offset for smooth feel
    _drumSnapRaf = requestAnimationFrame(snapAnimate);
  }, { passive: false });
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
let _lastLevelUpAt = 0;

function showPopup(type, data) {
  const isAch = type === 'achievement';
  const popup = $(isAch ? 'achievement-popup' : 'levelup-popup');
  if (!isAch) {
    // Dedup: skip if level up was shown within last 3 seconds (HTTP + WS race)
    const now = Date.now();
    if (now - _lastLevelUpAt < 3000) return;
    _lastLevelUpAt = now;
    $('new-level').textContent = state.level;
    // Show achievements earned alongside level up
    const achContainer = $('levelup-achievements');
    achContainer.textContent = '';
    const achIds = Array.isArray(data) ? data : [];
    achIds.forEach(achId => {
      const a = ACHIEVEMENTS.find(x => x.id === achId);
      if (!a) return;
      const el = document.createElement('div');
      el.className = 'levelup-ach';
      el.innerHTML = `<span class="levelup-ach-icon">${a.icon}</span><div class="levelup-ach-text"><div class="levelup-ach-name">${esc(a.name)}</div><div class="levelup-ach-desc">${esc(a.desc)}</div></div>`;
      achContainer.appendChild(el);
    });
  } else {
    const a = ACHIEVEMENTS.find(x => x.id === data);
    if (!a) return;
    $('popup-icon').innerHTML = a.icon; $('popup-name').textContent = a.name; $('popup-desc').textContent = a.desc;
  }
  popup.classList.add('show');
  playSound(isAch ? 'achievement' : 'levelup');
  setTimeout(() => { const r = popup.getBoundingClientRect(); particles(r.left + r.width / 2, r.top + r.height / 2, !isAch); }, 100);
  const duration = isAch ? ACHIEVEMENT_POPUP_MS : (LEVELUP_POPUP_MS + (Array.isArray(data) && data.length ? 1000 : 0));
  setTimeout(() => popup.classList.remove('show'), duration);
}

// ========== TASK ACTIONS ==========
let pendingTasks = new Set();
let pendingCompletes = new Set();
let pendingDeletes = new Set();
let pendingEdits = new Set();

async function addTask(text) {
  if (!text.trim()) return;

  const body = { text: text.trim() };
  const startInput = $('schedule-start');
  const endInput = $('schedule-end');
  const nowISO = new Date().toISOString();
  body.scheduled_start = (startInput && startInput.value) ? new Date(startInput.value).toISOString() : nowISO;
  body.scheduled_end = (endInput && endInput.value) ? new Date(endInput.value).toISOString() : nowISO;

  const result = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (result && result.id) {
    // Mark as pending to avoid duplicate from WebSocket
    pendingTasks.add(result.id);

    // If WebSocket already added this task — just scroll to it
    if (state.tasks.find(t => t.id === result.id)) {
      scrollToNewTask(result.id);
      setTimeout(() => pendingTasks.delete(result.id), 3000);
      return;
    }

    state.tasks.unshift({
      id: result.id, text: result.text, xp: result.xp,
      scheduled_start: result.scheduled_start, scheduled_end: result.scheduled_end
    });

    // +3 XP for creating a task
    if (result.xpEarned) {
      state.level = result.level;
      state.xp = result.currentXp;
      state.xpMax = result.xpMax;
      if (result.leveledUp) showPopup('levelup');
    }

    renderTasks();
    scrollToNewTask(result.id);
    updateUI();
    playSound('add');

    // Clear schedule fields
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    const schedFields = $('schedule-fields');
    if (schedFields) schedFields.style.display = 'none';
    $('schedule-toggle')?.classList.remove('active');

    // Clear pending after short delay
    setTimeout(() => pendingTasks.delete(result.id), 3000);
  }
}

async function completeTask(id, el) {
  el.classList.add('completing');
  const r = el.getBoundingClientRect();
  particles(r.left + r.width / 2, r.top + r.height / 2);
  playSound('complete');

  // Reset combo timer
  clearTimeout(comboTimer);

  pendingCompletes.add(id);

  // Optimistic: remove task from UI after animation
  const taskIdx = state.tasks.findIndex(t => t.id === id);
  const savedTask = taskIdx >= 0 ? state.tasks[taskIdx] : null;

  setTimeout(() => {
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderTasks();
    updateUI();
  }, TASK_COMPLETE_ANIMATION_MS);

  // Send request in parallel
  const result = await api(`/api/tasks/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ combo: state.combo })
  });

  if (result && result.success) {
    setTimeout(() => pendingCompletes.delete(id), 3000);
    Object.assign(state, { level: result.level, xp: result.xp, xpMax: result.xpMax, completed: result.completed, streak: result.streak, combo: result.combo });

    const newAch = result.newAchievements || [];
    processNewAchievements(newAch, result.leveledUp);

    if (state.combo > 1) playSound('combo');

    comboTimer = setTimeout(async () => {
      await api('/api/combo/reset', { method: 'POST' });
      state.combo = 0;
      updateUI();
    }, COMBO_TIMEOUT_MS);

    renderAchievements();
    updateUI();
  } else {
    // Rollback: restore task if request failed
    pendingCompletes.delete(id);
    if (savedTask) {
      state.tasks.splice(taskIdx, 0, savedTask);
      renderTasks();
      updateUI();
    }
  }
}

async function deleteTask(id, el) {
  pendingDeletes.add(id);
  el.style.animation = 'task-enter 0.3s ease reverse';
  playSound('delete');

  await api(`/api/tasks/${id}`, { method: 'DELETE' });

  setTimeout(() => {
    state.tasks = state.tasks.filter(t => t.id !== id);
    renderTasks();
    setTimeout(() => pendingDeletes.delete(id), 3000);
  }, TASK_DELETE_ANIMATION_MS);
}

async function editTask(id, newText) {
  const text = newText.trim();
  if (!text) {
    const el = document.querySelector(`[data-id="${id}"]`);
    if (el) deleteTask(id, el);
    return;
  }

  pendingEdits.add(id);
  await api(`/api/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ text })
  });

  const task = state.tasks.find(t => t.id === id);
  if (task) task.text = text;
  setTimeout(() => pendingEdits.delete(id), 3000);
}

// ========== AUTO-RESIZE TEXTAREA ==========
function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

['task-input','quick-task-input'].forEach(id => $(id).addEventListener('input', () => autoResizeTextarea($(id))));

function resetTextarea(el) {
  el.value = '';
  el.style.height = 'auto';
  el.focus();
}

// ========== EVENT LISTENERS ==========
$('add-task-form').onsubmit = e => {
  e.preventDefault();
  addTask($('task-input').value);
  resetTextarea($('task-input'));
};

$('task-input').addEventListener('keydown', e => {
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
    // Already on social — toggle search bar
    socialSearch.classList.toggle('show');
    if (socialSearch.classList.contains('show')) $('user-search-input').focus();
  } else {
    // Switch to social tab, show search bar
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
  const visible = row.style.display !== 'none';
  row.style.display = visible ? 'none' : 'flex';
  if (!visible) $('quick-task-input').focus();
});

function closeOnClickOutside(elId, toggleId, closeAction) {
  document.addEventListener('click', e => {
    if (e.target.closest(`#${elId}, #${toggleId}`)) return;
    closeAction();
  });
}
closeOnClickOutside('quick-add-row', 'add-task-toggle', () => { $('quick-add-row').style.display = 'none'; });
closeOnClickOutside('social-search', 'search-toggle', () => { $('social-search').classList.remove('show'); });

function quickAddSubmit() {
  const input = $('quick-task-input');
  const text = input.value.trim();
  if (!text) return;
  addTask(text);
  resetTextarea(input);
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

// ========== GOOGLE CALENDAR TOGGLE ==========
async function checkGoogleCalendarStatus() {
  const data = await api('/api/google/status');
  if (!data) return;
  const statusEl = $('gcal-status');
  const toggleEl = $('gcal-toggle');
  if (!data.available) {
    if (toggleEl) toggleEl.style.display = 'none';
    return;
  }
  if (statusEl) statusEl.textContent = data.connected ? 'ON' : 'OFF';
}

$('gcal-toggle')?.addEventListener('click', async () => {
  const data = await api('/api/google/status');
  if (!data || !data.available) return;
  if (data.connected) {
    if (confirm('Disconnect Google Calendar?')) {
      await api('/api/google/disconnect', { method: 'POST' });
      $('gcal-status').textContent = 'OFF';
    }
  } else {
    window.location.href = '/auth/google/connect';
  }
});

async function toggleSetting(key, transform = v => !v) {
  if (key === 'sound') initAudio();
  state[key] = transform(state[key]);
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ [key]: state[key] }) });
  updateUI();
  if (state.sound) playSound('add');
}
$('sound-toggle').onclick = () => toggleSetting('sound');
$('version-btn').onclick = () => alert('Coming soon!');

['click','keydown','pointerdown'].forEach(e => document.addEventListener(e, initAudio, { once: true }));

// ========== SETTINGS DROPDOWN ==========
const [sToggle, sDrop] = [$('settings-toggle'), $('settings-dropdown')];
sToggle.onclick = e => { e.stopPropagation(); sDrop.classList.toggle('show'); };
document.addEventListener('click', e => { if (!sDrop.contains(e.target) && !sToggle.contains(e.target)) sDrop.classList.remove('show'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') sDrop.classList.remove('show'); });

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

  // Update active button and aria
  tabBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
  const newBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  if (newBtn) { newBtn.classList.add('active'); newBtn.setAttribute('aria-selected', 'true'); }

  // Determine slide direction
  const slideOut = direction > 0 ? 'slide-out-left' : 'slide-out-right';
  const slideIn = direction > 0 ? 'slide-in-right' : 'slide-in-left';

  // Find current visible tab and target tab
  let oldTab = null;
  let newTab = null;
  tabContents.forEach(content => {
    if (content.id === `tab-${tabId}`) newTab = content;
    else if (content.style.display !== 'none') oldTab = content;
  });

  const container = document.querySelector('.main-content');
  _tabAnimating = true;

  // 1. Freeze container so children can be absolute/fixed without collapse
  container.style.height = container.clientHeight + 'px';
  container.style.overflow = 'visible';

  // 2. Pull old tab out of flow
  if (oldTab) oldTab.classList.add('tab-animating');

  // 3. New tab out of flow BEFORE display (never enters flex)
  if (newTab) {
    newTab.classList.add('tab-animating');
    newTab.style.display = newTab.id === 'tab-todo' ? 'flex' : 'block';
  }

  // 3b. Pre-render drum so it's visible during slide-in animation
  if (tabId === 'todo') {
    _tabAnimating = false;
    renderTasks();
    _tabAnimating = true;
  }

  // 4. Start animations on next frame
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

    // Mark drum for reset when returning to todo tab
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

  // Hide search bar when leaving social tab
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

  // Keyboard: Left/Right arrows to switch tabs
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Don't interfere with drum up/down
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
    const idx = getActiveTabIndex();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (idx + dir + TAB_ORDER.length) % TAB_ORDER.length;
    e.preventDefault();
    switchTab(TAB_ORDER[next], dir);
  });

  // Swipe: touch gesture to switch tabs
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
    // Only horizontal swipes (dx > dy) with min 50px threshold
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    const idx = getActiveTabIndex();
    const dir = dx < 0 ? 1 : -1; // swipe left = next, swipe right = prev
    const next = (idx + dir + TAB_ORDER.length) % TAB_ORDER.length;
    switchTab(TAB_ORDER[next], dir);
  }, { passive: true });
}


// ========== HISTORY ==========
const HISTORY_ICONS = {
  task_created: '\uD83D\uDCDD',
  task_completed: '\u2705'
};

async function renderHistory() {
  const list = $('history-list');
  const empty = $('history-empty');

  const result = await api('/api/history');
  if (!result || !result.history) return;

  const items = result.history;

  if (items.length === 0) {
    list.textContent = '';
    empty.classList.add('show');
    return;
  }

  empty.classList.remove('show');
  list.textContent = '';
  items.forEach(item => {
    const icon = HISTORY_ICONS[item.type] || '';

    const li = document.createElement('li');
    li.className = 'history-item';
    li.onclick = () => li.classList.toggle('expanded');

    const actionSpan = document.createElement('span');
    actionSpan.className = 'history-action';
    actionSpan.textContent = icon + ' ' + (item.text || '');

    const pointsSpan = document.createElement('span');
    pointsSpan.className = 'history-points';
    pointsSpan.textContent = '+' + item.points + ' XP';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'history-time';
    timeSpan.textContent = formatTime(item.timestamp);

    li.append(actionSpan, pointsSpan, timeSpan);
    list.appendChild(li);
  });
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const day = date.toLocaleDateString('ru-RU');
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

// ========== FRIENDS API ==========
let feedOffset = 0;


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
    const statusMap = {
      friends: { cls: ' disabled', text: 'Friends', disabled: 'disabled' },
      pending_sent: { cls: ' pending', text: 'Pending', disabled: 'disabled' },
      pending_received: { cls: ' accept', text: 'Accept', disabled: '' }
    };
    const s = statusMap[user.friendship_status] || { cls: '', text: 'Add', disabled: '' };
    const btnClass = 'add-friend-btn' + s.cls;
    const btnText = s.text;
    const btnDisabled = s.disabled;

    return `
      <div class="user-card" data-user-id="${user.id}">
        <div class="social-avatar">${esc(user.avatar_letter)}</div>
        <div class="user-info">
          <span class="user-name">${esc(user.username)}</span>
          <span class="user-level">Level ${user.level}</span>
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
          btn.textContent = 'Friends';
          btn.disabled = true;
        }
      } else {
        // Send friend request
        const result = await sendFriendRequest(userId);
        if (result && result.success) {
          btn.classList.add('pending');
          btn.textContent = 'Pending';
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
          <button class="accept-btn" title="Accept">&#10004;</button>
          <button class="reject-btn" title="Decline">&#10006;</button>
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
          <span class="request-status">Awaiting response</span>
        </div>
        <button class="cancel-btn" title="Cancel">&#10006;</button>
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

  const hasMore = feedData.has_more;
  renderFriendsFeed(feedData.feed || [], append);

  const loadMoreBtn = $('load-more-feed');
  loadMoreBtn.style.display = hasMore ? 'block' : 'none';
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
      actionText = `completed task: "${esc(item.task_text || '')}"`;
    } else if (item.activity_type === 'achievement') {
      actionText = 'earned an achievement';
    } else if (item.activity_type === 'level_up') {
      actionText = 'leveled up';
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

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
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
      ? `<img src="${media.url}" alt="Media"><button class="delete-media-btn" onclick="deleteMedia()">🗑️ Delete</button>`
      : `<video src="${media.url}" controls></video><button class="delete-media-btn" onclick="deleteMedia()">🗑️ Delete</button>`;
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
      captureBtn.textContent = '🔴 Record';
      captureBtn.onclick = startVideoRecording;
    } else {
      captureBtn.textContent = '📸 Capture';
      captureBtn.onclick = capturePhoto;
    }
  } catch (err) {
    alert('Could not access the camera');
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
  $('btn-camera-capture').textContent = '⏹️ Stop';
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
function openSocialLightbox(src) {
  const lightbox = $('social-lightbox');
  const content = $('social-lightbox-content');
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  content.textContent = '';
  content.appendChild(img);
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
      openSocialLightbox(media.src);
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

// Initialize tabs and drag-scroll
initTabs();
initTaskDrag();
initSearch();

// Re-render drum on resize to adjust row count
window.addEventListener('resize', () => {
  if (_tabAnimating) return;
  if ($('tasks-list')?.classList.contains('editing')) return;
  renderTasks();
});

// Auto-scroll to current task after 10s of inactivity
let _idleTimer = null;
function resetIdleTimer() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    // Skip if user is typing, menu is open, or quick-add is open
    if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.contentEditable === 'true')) return;
    if ($('settings-dropdown')?.classList.contains('show')) return;
    if ($('quick-add-row')?.style.display !== 'none') return;
    scrollToCurrentTask();
  }, 10000);
}
['mousemove','keydown','pointerdown','scroll'].forEach(e => document.addEventListener(e, resetIdleTimer));
resetIdleTimer();
// history loaded on-demand from server when tab is opened

// Load state from server
loadState().then(async () => {
  // Connect to WebSocket after initial load
  connectWebSocket();
  // Check Google Calendar connection
  checkGoogleCalendarStatus();

  // Wait for fonts to be ready (prevents text reflow)
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  // First rAF: layout is calculated, render with correct dimensions
  requestAnimationFrame(() => {
    // Instant jump to current task (no animation)
    scrollToCurrentTask(true);
    // Second rAF: browser has painted, safe to show
    requestAnimationFrame(() => {
      document.body.classList.add('ready');
    });
  });
});

// ========== AUTO-REFRESH ==========

// Refresh state when tab becomes visible (covers both visibilitychange and focus)
let _lastRefreshAt = 0;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    const now = Date.now();
    if (now - _lastRefreshAt < 3000) return;
    _lastRefreshAt = now;
    loadState();
  }
});

// Periodic background refresh (every 60 seconds)
// Only used as fallback when WebSocket is not available
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    // Only refresh if tab is visible and WebSocket is not connected
    if (!document.hidden && (!socket || socket.readyState !== WebSocket.OPEN)) {
      console.log('Auto-refreshing data (WebSocket not available)...');
      loadState();
    }
  }, 60000); // 60 seconds
}

// Start auto-refresh
startAutoRefresh();

// ========== DEV FILE HASH POLLING ==========
let _devCssHash = null;
let _devOtherHash = null;
let _devPollTimer = null;

function startDevPoll() {
  if (_devPollTimer) return;
  _devPollTimer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const res = await fetch('/api/files-hash');
      if (!res.ok) return;
      const { css, other } = await res.json();
      if (_devCssHash === null) { _devCssHash = css; _devOtherHash = other; return; }
      if (other !== _devOtherHash) {
        console.log('🔄 Dev files changed — reloading page');
        window.location.reload(true);
        return;
      }
      if (css !== _devCssHash) {
        console.log('🔄 CSS changed — hot-swapping styles');
        _devCssHash = css;
        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
          const url = new URL(link.href);
          url.searchParams.set('_r', Date.now());
          link.href = url.toString();
        });
      }
    } catch {}
  }, 5000);
}
startDevPoll();

// Stop auto-refresh and WebSocket on page unload
window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  if (_devPollTimer) clearInterval(_devPollTimer);
  if (socket) {
    socket.close();
    console.log('WebSocket connection closed');
  }
});
