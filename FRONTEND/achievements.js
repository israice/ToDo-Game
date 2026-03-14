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
    // NOTE: icons are hardcoded static HTML entities, not user input
    p.innerHTML = icons[Math.random() * 4 | 0];
    p.style.cssText = `left:${x}px;top:${y}px;color:${colors[Math.random() * 4 | 0]};font-size:${12 + Math.random() * 16}px;--tx:${(Math.random() - 0.5) * 200}px;--ty:${-Math.random() * 150 - 50}px;animation:particle-float ${0.6 + Math.random() * 0.4}s ease-out forwards`;
    $('particles').appendChild(p);
    setTimeout(() => p.remove(), 1000);
  }
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
  ['level10', 'Master', 'Reach level 10', '<img src="https://avatars.githubusercontent.com/u/1953053?s=400&u=d8370094252d77402f8073148d1168d1d0633d12&v=4" style="width:100%;height:100%;object-fit:cover;border-radius:50%">'],
  ['streak7', 'Weekly Warrior', 'Maintain a 7-day streak', '&#128170;'],
  ['streak30', 'Monthly Master', 'Maintain a 30-day streak', '&#127942;'],
].map(([id, name, desc, icon]) => ({ id, name, desc, icon }));

// ========== RENDER ACHIEVEMENTS ==========
// Achievement data is static/trusted, not user input — safe to use innerHTML
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
    const now = Date.now();
    if (now - _lastLevelUpAt < 3000) return;
    _lastLevelUpAt = now;
    $('new-level').textContent = state.level;
    const achContainer = $('levelup-achievements');
    achContainer.textContent = '';
    const achIds = Array.isArray(data) ? data : [];
    achIds.forEach(achId => {
      const a = ACHIEVEMENTS.find(x => x.id === achId);
      if (!a) return;
      const el = document.createElement('div');
      el.className = 'levelup-ach';
      const iconSpan = document.createElement('span');
      iconSpan.className = 'levelup-ach-icon';
      // Static trusted icon HTML (hardcoded achievement icons)
      iconSpan.innerHTML = a.icon;
      const textDiv = document.createElement('div');
      textDiv.className = 'levelup-ach-text';
      const nameDiv = document.createElement('div');
      nameDiv.className = 'levelup-ach-name';
      nameDiv.textContent = a.name;
      const descDiv = document.createElement('div');
      descDiv.className = 'levelup-ach-desc';
      descDiv.textContent = a.desc;
      textDiv.append(nameDiv, descDiv);
      el.append(iconSpan, textDiv);
      achContainer.appendChild(el);
    });
  } else {
    const a = ACHIEVEMENTS.find(x => x.id === data);
    if (!a) return;
    // Static trusted icon HTML (hardcoded achievement icons)
    $('popup-icon').innerHTML = a.icon;
    $('popup-name').textContent = a.name;
    $('popup-desc').textContent = a.desc;
  }
  popup.classList.add('show');
  playSound(isAch ? 'achievement' : 'levelup');
  setTimeout(() => { const r = popup.getBoundingClientRect(); particles(r.left + r.width / 2, r.top + r.height / 2, !isAch); }, 100);
  const duration = isAch ? ACHIEVEMENT_POPUP_MS : (LEVELUP_POPUP_MS + (Array.isArray(data) && data.length ? 1000 : 0));
  setTimeout(() => popup.classList.remove('show'), duration);
}

function processNewAchievements(achIds, leveledUp) {
  achIds.forEach(achId => {
    state.achievements[achId] = true;
  });
  if (achIds.length) renderAchievements();
  if (leveledUp) {
    showPopup('levelup', achIds);
  } else {
    achIds.forEach((achId, i) => setTimeout(() => showPopup('achievement', achId), i * 500));
  }
}
