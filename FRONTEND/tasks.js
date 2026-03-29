// ========== DATE FORMATTING ==========

function formatTaskDate(iso) {
  if (!iso) return { day: '', time: '' };
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { day: '', time: '' };
  const day = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return { day, time };
}

function getHourFromISO(iso) {
  if (!iso) return -1;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? -1 : d.getHours();
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

// ========== TASK DOM BUILDERS ==========

function _getTaskDepth(taskId) {
  let depth = 0;
  let id = taskId;
  while (id) {
    const t = state.tasks.find(x => x.id === id);
    if (!t || !t.parent_id) break;
    id = t.parent_id;
    depth++;
    if (depth > 5) break;
  }
  return depth;
}

function createMediaSpan(task) {
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
  return mediaSpan;
}

function buildCheckbox(task, li) {
  const isCompleted = !!task.completed_at;
  const checkLabel = document.createElement('label');
  checkLabel.className = 'task-checkbox';
  if (isCompleted) {
    checkLabel.classList.add('task-completed-icon');
    const completedSpan = document.createElement('span');
    completedSpan.className = 'checkbox-completed';
    completedSpan.textContent = '\u2705';
    checkLabel.appendChild(completedSpan);
    li.classList.add('task-done');
  } else {
    const checkInput = document.createElement('input');
    checkInput.type = 'checkbox';
    checkInput.setAttribute('aria-label', 'Complete quest');
    const checkCustom = document.createElement('span');
    checkCustom.className = 'checkbox-custom';
    checkLabel.appendChild(checkInput);
    checkLabel.appendChild(checkCustom);
    li.classList.remove('task-done');
  }
  return checkLabel;
}

function buildTaskElements(task, depth) {
  const hour = getHourFromISO(task.scheduled_start);
  const { cls: timePeriod, icon: timeIconText } = getTimePeriodInfo(hour);

  const mediaSpan = createMediaSpan(task);

  const textSpan = document.createElement('span');
  textSpan.className = 'task-text';
  textSpan.dir = 'auto';
  textSpan.textContent = task.text;

  const start = formatTaskDate(task.scheduled_start);
  const end = formatTaskDate(task.scheduled_end);
  const sameDate = start.day && end.day && start.day === end.day && start.time === end.time;
  const startDateSpan = createDateSpan(start, sameDate ? 'task-date-same' : 'task-date-start');
  const endDateSpan = createDateSpan(end, sameDate ? 'task-date-same' : 'task-date-end');
  const datesWrapper = document.createElement('div');
  datesWrapper.className = 'task-dates';
  if (task.recurrence_rule || task.recurrence_source_id) datesWrapper.classList.add('has-recurrence');
  if (task.is_gcal_sourced) datesWrapper.classList.add('gcal-sourced');
  datesWrapper.appendChild(startDateSpan);
  datesWrapper.appendChild(endDateSpan);

  const settingsWrap = document.createElement('div');
  settingsWrap.className = 'task-settings-wrap';

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'task-settings';
  settingsBtn.setAttribute('aria-label', 'Task settings');
  settingsBtn.textContent = timeIconText || '\u2699';

  const settingsMenu = document.createElement('div');
  settingsMenu.className = 'task-settings-menu';

  function menuBtn(cls, icon, label) {
    const btn = document.createElement('button');
    btn.className = 'task-menu-item ' + cls;
    const ic = document.createElement('span');
    ic.className = 'task-menu-icon';
    ic.textContent = icon;
    const lb = document.createElement('span');
    lb.textContent = label;
    btn.appendChild(ic);
    btn.appendChild(lb);
    return btn;
  }

  const menuMediaBtn = menuBtn('task-menu-media', '\uD83D\uDDBC\uFE0F', 'Media');
  const menuMagicBtn = menuBtn('task-menu-magic', '\u{1FA84}', 'Split');
  if (depth >= 5) menuMagicBtn.style.display = 'none';
  const menuAddSubBtn = menuBtn('task-menu-addsub', '➕', 'Subtask');
  if (depth >= 5) menuAddSubBtn.style.display = 'none';
  const menuDeleteBtn = menuBtn('task-menu-delete', '\uD83D\uDDD1', 'Delete');

  settingsMenu.appendChild(menuMediaBtn);
  settingsMenu.appendChild(menuMagicBtn);
  settingsMenu.appendChild(menuAddSubBtn);
  settingsMenu.appendChild(menuDeleteBtn);
  settingsWrap.appendChild(settingsBtn);

  return { timePeriod, textSpan, datesWrapper, settingsWrap, settingsBtn, settingsMenu, menuDeleteBtn, menuMediaBtn, menuMagicBtn, menuAddSubBtn };
}

function assembleTaskItem(li, parts, depth) {
  if (depth > 0) {
    const prefix = document.createElement('span');
    prefix.className = 'subtask-prefix';
    prefix.textContent = ' ';
    for (let d = 1; d <= depth; d++) {
      const dash = document.createElement('span');
      dash.className = 'subtask-dash';
      dash.dataset.depth = d;
      dash.textContent = '-';
      prefix.appendChild(dash);
      if (d < depth) prefix.appendChild(document.createTextNode('  '));
    }
    li.appendChild(prefix);
  }
  li.appendChild(parts.checkLabel);
  li.appendChild(parts.textSpan);
  li.appendChild(parts.datesWrapper);
  li.appendChild(parts.settingsWrap);
}

function _closeAllTaskMenus() {
  document.querySelectorAll('.task-settings-wrap.open').forEach(el => el.classList.remove('open'));
  document.querySelectorAll('body > .task-settings-menu').forEach(el => el.remove());
}

function wireTaskEvents(li, task, parts) {
  const { checkLabel, settingsBtn, settingsMenu, menuDeleteBtn, menuMediaBtn, menuMagicBtn, menuAddSubBtn, settingsWrap, datesWrapper } = parts;
  const isCompleted = !!task.completed_at;
  li._taskId = task.id;
  if (isCompleted) {
    checkLabel.onclick = (e) => { e.preventDefault(); completeTask(task.id, li); };
  } else {
    checkLabel.querySelector('input').onchange = () => completeTask(task.id, li);
  }
  const closeTaskMenu = () => {
    if (settingsMenu.parentNode) settingsMenu.parentNode.removeChild(settingsMenu);
    settingsWrap.classList.remove('open');
  };
  settingsBtn.onclick = (e) => {
    e.stopPropagation();
    const wasOpen = settingsWrap.classList.contains('open');
    _closeAllTaskMenus();
    if (!wasOpen) {
      settingsWrap.classList.add('open');
      document.body.appendChild(settingsMenu);
      settingsMenu.style.display = 'flex';
      const rect = settingsBtn.getBoundingClientRect();
      settingsMenu.style.top = (rect.bottom + 4) + 'px';
      settingsMenu.style.right = (window.innerWidth - rect.right) + 'px';
    }
  };
  menuDeleteBtn.onclick = (e) => {
    e.stopPropagation();
    closeTaskMenu();
    _handleRecurringAction(task.id, li, 'delete');
  };
  menuMediaBtn.onclick = (e) => {
    e.stopPropagation();
    closeTaskMenu();
    openMediaPopup(task.id);
  };
  menuMagicBtn.onclick = (e) => {
    e.stopPropagation();
    closeTaskMenu();
    breakdownTask(task.id, menuMagicBtn);
  };
  menuAddSubBtn.onclick = (e) => {
    e.stopPropagation();
    closeTaskMenu();
    showSubtaskInput(task.id);
  };
  datesWrapper.onclick = (e) => { e.stopPropagation(); _handleRecurringAction(task.id, li, 'edit'); };
  datesWrapper.style.cursor = 'pointer';
}

function setupEditMode(textSpan, task, list, isDrum) {
  let original = task.text;
  const debouncedEdit = debounce((id, text) => editTask(id, text), DEBOUNCE_DELAY_MS);

  if (isDrum) {
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
      textSpan.innerText = text || original;
      textSpan.removeAttribute('contenteditable');
      list.classList.remove('editing');
      if (save && text && text !== original) debouncedEdit(task.id, text);
    };
    const origEnterEdit = textSpan._enterEdit;
    textSpan._enterEdit = () => { editing = true; origEnterEdit(); };
    textSpan.onblur = () => exitEdit(true);
    textSpan.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textSpan.blur(); } else if (e.key === 'Escape') { exitEdit(false); } };
  } else {
    let _lpTimer = null;
    textSpan.addEventListener('pointerdown', () => {
      _lpTimer = setTimeout(() => {
        _lpTimer = null;
        original = task.text;
        list.classList.add('editing');
        textSpan.setAttribute('contenteditable', 'true');
        textSpan.focus();
        document.getSelection().selectAllChildren(textSpan);
      }, 500);
    });
    textSpan.addEventListener('pointerup', () => { clearTimeout(_lpTimer); _lpTimer = null; });
    textSpan.addEventListener('pointercancel', () => { clearTimeout(_lpTimer); _lpTimer = null; });
    textSpan.addEventListener('pointermove', (e) => {
      if (_lpTimer && (Math.abs(e.movementX) > 5 || Math.abs(e.movementY) > 5)) { clearTimeout(_lpTimer); _lpTimer = null; }
    });
    textSpan.onblur = () => {
      const text = textSpan.innerText.trim();
      textSpan.removeAttribute('contenteditable');
      list.classList.remove('editing');
      if (text && text !== original) debouncedEdit(task.id, text);
    };
    textSpan.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); textSpan.blur(); }
      else if (e.key === 'Escape') { textSpan.innerText = original; textSpan.blur(); }
    };
  }
}

function applyXpResult(result) {
  if (!result.xpEarned) return;
  state.level = result.level;
  state.xp = result.currentXp;
  state.xpMax = result.xpMax;
  if (result.leveledUp) showPopup('levelup');
}

// ========== TASK ACTIONS ==========

async function addTask(text) {
  if (!text.trim()) return;

  const body = { text: text.trim() };
  const startInput = $('schedule-start');
  const endInput = $('schedule-end');
  const now = new Date();
  const in15 = new Date(now.getTime() + 15 * 60 * 1000);
  body.scheduled_start = (startInput && startInput.value) ? new Date(startInput.value).toISOString() : now.toISOString();
  body.scheduled_end = (endInput && endInput.value) ? new Date(endInput.value).toISOString() : in15.toISOString();

  const result = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (result && result.id) {
    state.tasks.unshift({
      id: result.id, text: result.text, xp: result.xp,
      scheduled_start: result.scheduled_start, scheduled_end: result.scheduled_end,
      completed_at: null, parent_id: null,
      recurrence_rule: result.recurrence_rule || null
    });

    applyXpResult(result);

    renderTasks();
    scrollToNewTask(result.id);
    updateUI();
    playSound('add');

    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    const schedFields = $('schedule-fields');
    if (schedFields) schedFields.style.display = 'none';
    $('schedule-toggle')?.classList.remove('active');
  }
}

async function breakdownTask(taskId, btn) {
  const orig = btn.textContent;
  btn.textContent = '\u231B';
  btn.disabled = true;
  try {
    const result = await api(`/api/tasks/${taskId}/breakdown`, { method: 'POST' });
    if (result && result.subtasks) {
      for (const st of result.subtasks) {
        state.tasks.push({
          id: st.id, text: st.text, xp: st.xp,
          scheduled_start: st.scheduled_start, scheduled_end: st.scheduled_end,
          completed_at: null, parent_id: st.parent_id,
          recurrence_rule: null
        });
      }
      renderTasks();
      updateUI();
      playSound('add');
    }
  } catch (e) {
    console.error('Breakdown failed:', e);
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

let _subtaskInputParentId = null;

async function showSubtaskInput(parentId) {
  const parent = state.tasks.find(t => t.id === parentId);
  if (!parent) return;

  const siblingCount = state.tasks.filter(t => t.parent_id === parentId).length;
  const body = {
    text: parent.text + ' ' + (siblingCount + 1),
    parent_id: parentId,
    scheduled_start: parent.scheduled_start || new Date().toISOString(),
    scheduled_end: parent.scheduled_end || new Date().toISOString()
  };

  const result = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  if (result && result.id) {
    state.tasks.push({
      id: result.id, text: result.text, xp: result.xp,
      scheduled_start: result.scheduled_start, scheduled_end: result.scheduled_end,
      completed_at: null, parent_id: result.parent_id,
      recurrence_rule: result.recurrence_rule || null
    });

    applyXpResult(result);

    const sorted = getSortedTasks();
    _drumList = buildDrumList(sorted);
    const newIdx = _drumList.findIndex(e => e.task && e.task.id === result.id);
    if (newIdx >= 0) {
      const { highlightIdx } = getDrumParams();
      scrollOffset = newIdx - highlightIdx;
      drumFraction = 0;
      _drumScrollTarget = null;
    }

    renderTasks();
    updateUI();
    playSound('add');

    requestAnimationFrame(() => {
      const allItems = document.querySelectorAll('.task-item');
      for (const li of allItems) {
        if (li._taskId === result.id) {
          const textSpan = li.querySelector('.task-text');
          if (textSpan && textSpan._enterEdit) textSpan._enterEdit();
          break;
        }
      }
    });
  }
}

function _applyDoneVisual(el, done) {
  const oldLabel = el.querySelector('.task-checkbox');
  if (!oldLabel) return;
  const fakeTask = { id: el._taskId, completed_at: done ? 'yes' : null };
  const newLabel = buildCheckbox(fakeTask, el);
  if (done) {
    newLabel.onclick = (e) => { e.preventDefault(); completeTask(el._taskId, el); };
  } else {
    newLabel.querySelector('input').onchange = () => completeTask(el._taskId, el);
  }
  oldLabel.replaceWith(newLabel);
}

async function completeTask(id, el) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;

  if (task.completed_at) {
    task.completed_at = null;
    _applyDoneVisual(el, false);
    updateUI();
    const result = await api(`/api/tasks/${id}/uncomplete`, { method: 'POST' });
    if (result && result.success) {
      Object.assign(state, { completed: result.completed, level: result.level, xp: result.xp, xpMax: result.xpMax });
      updateUI();
    } else {
      task.completed_at = new Date().toISOString();
      _applyDoneVisual(el, true);
      updateUI();
    }
    return;
  }

  const r = el.getBoundingClientRect();
  particles(r.left + r.width / 2, r.top + r.height / 2);
  playSound('complete');

  clearTimeout(comboTimer);

  task.completed_at = new Date().toISOString();
  _applyDoneVisual(el, true);
  updateUI();

  const result = await api(`/api/tasks/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ combo: state.combo })
  });

  if (result && result.success) {
    task.completed_at = result.completed_at;
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
    task.completed_at = null;
    _applyDoneVisual(el, false);
    updateUI();
  }
}

async function deleteTask(id, el) {
  el.style.animation = 'task-enter 0.3s ease reverse';
  playSound('delete');

  await api(`/api/tasks/${id}`, { method: 'DELETE' });

  setTimeout(() => {
    if (_subtaskInputParentId === id) _subtaskInputParentId = null;
    state.tasks = state.tasks.filter(t => t.id !== id && t.parent_id !== id && t.recurrence_source_id !== id);
    adjustScrollAfterRemove();
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
