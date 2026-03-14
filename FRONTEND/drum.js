// ========== TASK DATA HELPERS ==========

function getSortedTasks() {
  return [...state.tasks].filter(t => !t.parent_id).sort((a, b) => {
    const sa = a.scheduled_start || '';
    const sb = b.scheduled_start || '';
    if (sa && sb) return new Date(sa).getTime() - new Date(sb).getTime();
    if (sa) return -1;
    if (sb) return 1;
    return 0;
  });
}

function buildDrumList(sorted) {
  const list = [];
  let lastDateKey = '';
  const subMap = {};
  for (const t of state.tasks) {
    if (t.parent_id) {
      if (!subMap[t.parent_id]) subMap[t.parent_id] = [];
      subMap[t.parent_id].push(t);
    }
  }
  function insertWithChildren(task, type) {
    list.push({ type, task });
    const subs = subMap[task.id];
    if (subs) {
      for (const sub of subs) insertWithChildren(sub, 'subtask');
    }
  }
  for (const task of sorted) {
    const iso = task.scheduled_start || '';
    if (iso) {
      const d = new Date(iso);
      const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (dateKey !== lastDateKey) {
        const dayName = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase() + ' ' + String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0');
        list.push({ type: 'header', dayName });
        lastDateKey = dateKey;
      }
    }
    insertWithChildren(task, 'task');
  }
  return list;
}

function getDrumBounds(highlightIdx) {
  const min = -highlightIdx;
  const max = Math.max(0, _drumList.length - highlightIdx - 1);
  return { min, max };
}

// ========== 3D DRUM ROLLER ==========

const _bd = document.body.dataset;
const ROW_HEIGHT_SETTING = Number(_bd.drumRowHeight) || 20;
const MAX_TOP_ANGLE = Number(_bd.drumMaxTopAngle) || 85;
const PERSP_K = Number(_bd.drumPerspectiveK) || 2;
const HIGHLIGHT_OFFSET = Number(_bd.drumHighlightOffset) ?? 2;

function getDrumParams() {
  const list = $('tasks-list');
  let h = list ? list.clientHeight : 700;
  if (h < 50) return { totalRows: 11, centerIdx: 5, highlightIdx: 5, radius: 220, angleStep: 11 };

  const isLarge = window.innerWidth >= MOBILE_BREAKPOINT;
  if (!isLarge) {
    const header = document.querySelector('.header-block');
    const tabs = document.querySelector('.tabs-container');
    const overlay = (header ? header.offsetHeight : 0) + (tabs ? tabs.offsetHeight : 0);
    h -= overlay;
  }
  const rowHeight = isLarge ? ROW_HEIGHT_SETTING : Math.max(20, Math.round(ROW_HEIGHT_SETTING * 0.85));
  const raw = Math.max(7, Math.floor(h / rowHeight));
  const totalRows = raw % 2 === 1 ? raw : raw - 1;
  const centerIdx = (totalRows - 1) / 2;

  const highlightIdx = isLarge ? Math.max(0, Math.min(totalRows - 1, centerIdx - HIGHLIGHT_OFFSET)) : centerIdx;

  const maxAngle = isLarge ? MAX_TOP_ANGLE : Math.min(MAX_TOP_ANGLE, 55);
  const angleStep = maxAngle / centerIdx;
  const topAngleRad = maxAngle * Math.PI / 180;

  const sinA = Math.sin(topAngleRad);
  const cosA = Math.cos(topAngleRad);
  const radius = sinA > 0 ? (h / 2) * (PERSP_K + 1 - cosA) / (PERSP_K * sinA) : 220;

  return { totalRows, centerIdx, highlightIdx, radius, angleStep };
}

function renderTasks() {
  if (_tabAnimating) return;
  if ($('tasks-list')?.classList.contains('editing')) return;

  if (_drumNeedsReset) {
    _drumNeedsReset = false;
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    _drumJumpToIdx = -2;
    drumFraction = 0;
  }

  const list = $('tasks-list');
  list.textContent = '';
  const activeTasks = state.tasks.filter(t => !t.parent_id && !t.completed_at);
  const empty = activeTasks.length === 0;
  $('empty-state').classList.toggle('show', empty);

  const sorted = getSortedTasks();
  _drumList = buildDrumList(sorted);

  const { totalRows, centerIdx, highlightIdx, radius, angleStep } = getDrumParams();

  if (_drumJumpToIdx !== -1) {
    let targetIdx = _drumJumpToIdx;
    if (targetIdx === -2) targetIdx = findCurrentTaskIndex(true);
    scrollOffset = targetIdx - highlightIdx;
    _drumJumpToIdx = -1;
  }

  const { min: minOffset, max: maxOffset } = getDrumBounds(highlightIdx);
  if (_drumScrollTarget === null) {
    scrollOffset = Math.max(minOffset, Math.min(maxOffset, scrollOffset));
  }

  const curved = state.drumView;
  list.style.perspective = curved ? Math.round(radius * PERSP_K) + 'px' : 'none';
  const wrapper = document.createElement('div');
  wrapper.className = 'drum-wrapper';
  wrapper.style.transform = curved ? 'translateZ(' + (-radius) + 'px)' : 'none';
  list.appendChild(wrapper);

  const highlightTaskIdx = scrollOffset + highlightIdx;

  let expandExtra = 0;
  let centerH = 38;
  const highlightEntry = (highlightTaskIdx >= 0 && highlightTaskIdx < _drumList.length) ? _drumList[highlightTaskIdx] : null;
  if (highlightEntry && highlightEntry.type === 'task') {
    const ct = highlightEntry.task;
    const probe = document.createElement('li');
    probe.className = 'task-item center';
    probe.style.cssText = 'position:absolute;left:8px;right:8px;visibility:hidden;pointer-events:none;';
    const pText = document.createElement('span');
    pText.className = 'task-text';
    pText.textContent = ct.text;
    const pCheck = document.createElement('label'); pCheck.className = 'task-checkbox';
    const pDates = document.createElement('div'); pDates.className = 'task-dates';
    const pDate1 = document.createElement('span'); pDate1.className = 'task-date';
    const pDate2 = document.createElement('span'); pDate2.className = 'task-date';
    pDates.append(pDate1, pDate2);
    const pSetWrap = document.createElement('div'); pSetWrap.className = 'task-settings-wrap';
    const pSetBtn = document.createElement('button'); pSetBtn.className = 'task-settings';
    pSetWrap.appendChild(pSetBtn);
    probe.append(pCheck, pText, pDates, pSetWrap);
    list.appendChild(probe);
    centerH = probe.offsetHeight;
    list.removeChild(probe);
    if (centerH > 38) {
      const projGap = radius * Math.sin(angleStep * Math.PI / 180);
      const overlap = centerH / 2 - (projGap - 19) + 4;
      if (overlap > 0) {
        expandExtra = (overlap / Math.max(1, projGap)) * angleStep;
      }
    }
  }

  const headerEl = document.querySelector('.header-block');
  const headerBottom = headerEl ? Math.ceil(headerEl.getBoundingClientRect().bottom) + 4 : 0;

  const flatStep = radius * Math.sin(angleStep * Math.PI / 180);
  function drumTransform(angle) {
    if (curved) return 'rotateX(' + angle + 'deg) translateZ(' + radius + 'px)';
    const y = -angle / angleStep * flatStep;
    return 'translateY(' + Math.round(y) + 'px)';
  }

  for (let idx = 0; idx < totalRows; idx++) {
    const taskIdx = scrollOffset + idx;
    let angle = (centerIdx + drumFraction - idx) * angleStep;
    if (idx !== highlightIdx && expandExtra > 0) {
      angle -= Math.sign(idx - highlightIdx) * expandExtra;
    }
    const absAngle = Math.abs(angle);
    const opacity = Math.max(0.15, 1 - absAngle / 120);

    if (taskIdx < 0 || taskIdx >= _drumList.length) {
      const li = document.createElement('li');
      li.className = 'task-item placeholder';
      li.style.transform = drumTransform(angle);
      li.style.opacity = opacity;
      li.dataset.drumIdx = idx;
      wrapper.appendChild(li);
      continue;
    }

    const entry = _drumList[taskIdx];

    if (entry.type === 'header') {
      const li = document.createElement('li');
      li.className = 'task-item day-header';
      li.style.transform = drumTransform(angle);
      li.style.opacity = opacity;
      li.dataset.drumIdx = idx;
      li.textContent = entry.dayName;
      wrapper.appendChild(li);
      continue;
    }

    const task = entry.task;
    const li = document.createElement('li');
    const isHighlight = idx === highlightIdx;
    const depth = _getTaskDepth(task.id);
    const parts = buildTaskElements(task, depth);
    const checkLabel = buildCheckbox(task, li);

    li.className = 'task-item' + (parts.timePeriod ? ' ' + parts.timePeriod : '') + (isHighlight ? ' center' : '') + (depth > 0 ? ' subtask-item' : '') + (task.completed_at ? ' task-done' : '');
    if (depth > 0) li.dataset.depth = depth;
    li.style.transform = drumTransform(angle);
    li.style.opacity = opacity;
    if (isHighlight && centerH > 38) {
      li.style.top = 'max(' + headerBottom + 'px, calc(50% - ' + (centerH / 2) + 'px))';
    }
    li.dataset.id = task.id;

    assembleTaskItem(li, { ...parts, checkLabel }, depth);
    wireTaskEvents(li, task, { ...parts, checkLabel });

    li.dataset.drumIdx = idx;
    setupEditMode(parts.textSpan, task, list, true);

    wrapper.appendChild(li);
  }

  const centerCard = wrapper.querySelector('.center');
  if (centerCard) {
    const realH = centerCard.offsetHeight;
    if (realH > 38) {
      centerCard.style.top = 'max(' + headerBottom + 'px, calc(50% - ' + (realH / 2) + 'px))';
      const projGap = radius * Math.sin(angleStep * Math.PI / 180);
      const overlap = realH / 2 - (projGap - 19) + 10;
      if (overlap > 0) {
        const realExpand = (overlap / Math.max(1, projGap)) * angleStep;
        if (realExpand > expandExtra) {
          wrapper.querySelectorAll('.task-item:not(.center)').forEach(li => {
            const idx = Number(li.dataset.drumIdx);
            if (isNaN(idx)) return;
            let a = (centerIdx + drumFraction - idx) * angleStep;
            a -= Math.sign(idx - highlightIdx) * realExpand;
            li.style.transform = drumTransform(a);
            li.style.opacity = Math.max(0.15, 1 - Math.abs(a) / 120);
          });
        }
      }
    }
  }

  const taskCount = $('task-count');
  if (taskCount) taskCount.textContent = `(${state.tasks.filter(t => !t.parent_id && !t.completed_at).length})`;

  scheduleNextTaskScroll();
}

// ========== AUTO-SCROLL TO CURRENT TASK WHEN ITS TIME ARRIVES ==========
let _nextTaskTimer = null;

function scheduleNextTaskScroll() {
  clearTimeout(_nextTaskTimer);
  _nextTaskTimer = null;
  const nowMs = Date.now();
  let nearest = Infinity;
  for (let i = 0; i < _drumList.length; i++) {
    if (_drumList[i].type !== 'task') continue;
    const s = _drumList[i].task.scheduled_start;
    if (!s) continue;
    const t = new Date(s).getTime();
    if (t > nowMs && t < nearest) nearest = t;
  }
  if (nearest === Infinity) return;
  const delay = nearest - nowMs + 500;
  _nextTaskTimer = setTimeout(() => {
    scrollToCurrentTask();
    scheduleNextTaskScroll();
  }, delay);
}

// ========== DRAG-SCROLL FOR TASKS CAROUSEL ==========
let _drumSnapRaf = 0;
let _drumScrollTarget = null;
let _drumNeedsReset = false;
let _drumJumpToIdx = -1;

function findCurrentTaskIndex(reuseList) {
  if (!reuseList || _drumList.length === 0) {
    const sorted = getSortedTasks();
    _drumList = buildDrumList(sorted);
  }
  const nowMs = Date.now();
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < _drumList.length; i++) {
    if (_drumList[i].type !== 'task') continue;
    const s = _drumList[i].task.scheduled_start;
    if (!s) continue;
    const dist = Math.abs(new Date(s).getTime() - nowMs);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) return bestIdx;
  for (let i = 0; i < _drumList.length; i++) {
    if (_drumList[i].type === 'task') return i;
  }
  return 0;
}

function skipHeaderAtHighlight(offset, highlightIdx, direction) {
  const step = direction >= 0 ? 1 : -1;
  let cur = offset;
  for (let i = 0; i < 5; i++) {
    const hi = cur + highlightIdx;
    if (hi < 0 || hi >= _drumList.length) break;
    if (_drumList[hi].type !== 'header') break;
    cur += step;
  }
  const hiFinal = cur + highlightIdx;
  if (hiFinal < 0 || hiFinal >= _drumList.length) return offset;
  return cur;
}

function adjustScrollAfterRemove() {
  const sorted = getSortedTasks();
  _drumList = buildDrumList(sorted);
  if (_drumList.length === 0) return;
  const { highlightIdx } = getDrumParams();
  const { min, max } = getDrumBounds(highlightIdx);
  scrollOffset = Math.max(min, Math.min(max, scrollOffset));
  scrollOffset = skipHeaderAtHighlight(scrollOffset, highlightIdx, 1);
  drumFraction = 0;
}

function scrollToCurrentTask(instant) {
  if (instant) {
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    _drumJumpToIdx = -2;
    drumFraction = 0;
    renderTasks();
  } else {
    const idx = findCurrentTaskIndex();
    const { highlightIdx } = getDrumParams();
    scrollToTarget(idx - highlightIdx);
  }
}

function scrollToNewTask(id) {
  const sorted = getSortedTasks();
  _drumList = buildDrumList(sorted);
  const idx = _drumList.findIndex(e => e.task && e.task.id === id);
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
  let clamped = Math.max(min, Math.min(max, target));
  clamped = skipHeaderAtHighlight(clamped, highlightIdx, target >= scrollOffset ? 1 : -1);
  _drumScrollTarget = Math.max(min, Math.min(max, clamped));
  if (_drumSnapAnimate) _drumSnapRaf = requestAnimationFrame(_drumSnapAnimate);
}

let _drumSnapAnimate;

function initTaskDrag() {
  const list = $('tasks-list');
  if (!list) return;

  const ROW_PX = 30;
  let startY = 0;
  let startX = 0;
  let startRawOffset = 0;
  let isDragging = false;
  let directionLocked = false;
  let tapTarget = null;
  let _prevTickOffset = scrollOffset;

  function drumTick() {
    const { highlightIdx } = getDrumParams();
    const { min, max } = getDrumBounds(highlightIdx);
    const clamped = Math.max(min, Math.min(max, scrollOffset));
    if (clamped !== _prevTickOffset) {
      const hi = clamped + highlightIdx;
      if (hi < 0 || hi >= _drumList.length || _drumList[hi].type !== 'header') {
        playSound('tick');
      }
      _prevTickOffset = clamped;
    }
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

    if (!directionLocked && (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8)) {
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        isDragging = false;
        directionLocked = false;
        try { list.releasePointerCapture(e.pointerId); } catch (_) {}
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerCancel);
        list.classList.remove('dragging');
        clearTimeout(_listLongPressTimer);
        _listLongPressTimer = null;
        return;
      }
      directionLocked = true;
      try { list.setPointerCapture(e.pointerId); } catch (_) {}
    }

    if (_listLongPressTimer && (Math.abs(deltaY) > 15 || Math.abs(deltaX) > 15)) {
      clearTimeout(_listLongPressTimer);
      _listLongPressTimer = null;
    }
    const rawOffset = startRawOffset - deltaY / ROW_PX;
    scrollOffset = Math.round(rawOffset);
    drumFraction = rawOffset - scrollOffset;
    clampDrum();
    drumTick();
    renderTasks();
  }

  function snapAnimate() {
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

    if (Math.abs(drumFraction) < 0.005) {
      drumFraction = 0;
      const { highlightIdx: hi2 } = getDrumParams();
      scrollOffset = skipHeaderAtHighlight(scrollOffset, hi2, 1);
      drumTick();
      renderTasks();
      list.classList.remove('dragging');
      return;
    }
    drumFraction *= 0.82;
    renderTasks();
    _drumSnapRaf = requestAnimationFrame(snapAnimate);
  }
  _drumSnapAnimate = snapAnimate;

  function onPointerCancel() {
    if (!isDragging) return;
    isDragging = false;
    clearTimeout(_listLongPressTimer);
    _listLongPressTimer = null;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    list.classList.remove('dragging');
    _drumSnapRaf = requestAnimationFrame(snapAnimate);
  }

  function onPointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    clearTimeout(_listLongPressTimer);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);

    if (_listDidLongPress) {
      _listDidLongPress = false;
      tapTarget = null;
      list.classList.remove('dragging');
      return;
    }

    const totalDrag = Math.abs(e.clientY - startY);
    if (totalDrag < 5 && tapTarget) {
      const idx = Number(tapTarget.dataset.drumIdx);
      const { highlightIdx } = getDrumParams();
      if (!isNaN(idx) && idx !== highlightIdx) {
        scrollToTarget(scrollOffset + (idx - highlightIdx));
        tapTarget = null;
        list.classList.remove('dragging');
        return;
      }
      if (!isNaN(idx) && idx === highlightIdx) {
        tapTarget = null;
        list.classList.remove('dragging');
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el) {
          const textEl = el.closest('.task-text');
          if (textEl && el === textEl && textEl.textContent.trim()) {
            const range = document.createRange();
            range.selectNodeContents(textEl);
            const textRect = range.getBoundingClientRect();
            if (e.clientX <= textRect.right) {
              textEl.click();
              return;
            }
          }
          const btn = el.closest('button');
          if (btn) { btn.click(); return; }
          const label = el.closest('label');
          if (label) { label.click(); return; }
        }
        return;
      }
    }
    tapTarget = null;

    _drumSnapRaf = requestAnimationFrame(snapAnimate);
  }

  let _listLongPressTimer = null;
  let _listDidLongPress = false;

  list.addEventListener('contextmenu', e => {
    if (e.target.closest('.task-text') && !e.target.closest('[contenteditable="true"]')) {
      e.preventDefault();
    }
  });

  list.addEventListener('pointerdown', e => {
    if (e.target.closest('button, input, label, [contenteditable="true"]')) return;
    tapTarget = e.target.closest('.task-item');
    _listDidLongPress = false;
    clearTimeout(_listLongPressTimer);

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

    const centerText = e.target.closest('.center .task-text');
    if (centerText && centerText.scrollHeight > centerText.clientHeight) {
      list.style.touchAction = 'pan-y';
      const restoreTouch = () => {
        list.style.touchAction = '';
        document.removeEventListener('pointerup', restoreTouch);
        document.removeEventListener('pointercancel', restoreTouch);
      };
      document.addEventListener('pointerup', restoreTouch);
      document.addEventListener('pointercancel', restoreTouch);
      return;
    }

    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    isDragging = true;
    directionLocked = false;
    startY = e.clientY;
    startX = e.clientX;
    startRawOffset = scrollOffset + drumFraction;
    list.classList.add('dragging');
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
  });

  let _keyRepeatTimer = null;
  let _keyRepeatInterval = null;

  function drumArrowStep(direction, instant) {
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    const { highlightIdx } = getDrumParams();
    const { min, max } = getDrumBounds(highlightIdx);
    let next = scrollOffset + direction;
    if (next < min || next > max) return;
    next = skipHeaderAtHighlight(next, highlightIdx, direction);
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
    if (e.repeat) return;
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    drumArrowStep(dir);
    resetIdleTimer();
    stopKeyRepeat();
    _keyRepeatTimer = setTimeout(() => {
      _keyRepeatInterval = setInterval(() => {
        drumArrowStep(dir, true);
        resetIdleTimer();
      }, 300);
    }, 500);
  });

  document.addEventListener('keyup', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      stopKeyRepeat();
    }
  });

  list.addEventListener('wheel', e => {
    if (e.target.closest('[contenteditable="true"]')) return;
    const taskText = e.target.closest('.center .task-text');
    if (taskText && taskText.scrollHeight > taskText.clientHeight) return;
    e.preventDefault();
    cancelAnimationFrame(_drumSnapRaf);
    _drumScrollTarget = null;
    const { highlightIdx } = getDrumParams();
    const { min, max } = getDrumBounds(highlightIdx);
    const delta = e.deltaY > 0 ? 1 : -1;
    let next = scrollOffset + delta;
    if (next < min || next > max) return;
    next = skipHeaderAtHighlight(next, highlightIdx, delta);
    if (next < min || next > max) return;
    scrollOffset = next;
    drumTick();
    drumFraction = -delta * 0.4;
    _drumSnapRaf = requestAnimationFrame(snapAnimate);
  }, { passive: false });
}
