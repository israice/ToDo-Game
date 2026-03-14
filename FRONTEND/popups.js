/* Quest Todo - Popups & Dialogs */

// Media popup state
let currentMediaTaskId = null;
let cameraStream = null;
let mediaRecorder = null;
let recordedChunks = [];

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
  // Media is now accessed via settings menu, no inline icon to update
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


// ========== DATE EDITOR POPUP ==========
let _dateEditorTaskId = null;

function toLocalDatetimeStr(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d)) return '';
  const pad = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function _updatePresetLabels(d) {
  const sel = $('recurrence-preset');
  const wd = d.getDay();
  const wdIdx = wd === 0 ? 6 : wd - 1;
  const dayName = DAY_NAMES[wdIdx];
  const monthDay = d.getDate();
  const monthName = MONTH_NAMES[d.getMonth()];
  for (const opt of sel.options) {
    if (opt.value === 'weekly') opt.textContent = 'Weekly on ' + dayName;
    if (opt.value === 'monthly') opt.textContent = 'Monthly on day ' + monthDay;
    if (opt.value === 'yearly') opt.textContent = 'Yearly on ' + monthName + ' ' + monthDay;
  }
}

function _ruleToPreset(rule) {
  if (!rule) return 'none';
  if (rule.frequency === 'daily' && (rule.interval || 1) === 1) return 'daily';
  if (rule.frequency === 'weekly' && (rule.interval || 1) === 1) {
    if (rule.weekdays && rule.weekdays.length === 5 &&
        [0,1,2,3,4].every(d => rule.weekdays.includes(d))) return 'weekdays';
    if (!rule.weekdays || rule.weekdays.length <= 1) return 'weekly';
  }
  if (rule.frequency === 'monthly' && (rule.interval || 1) === 1) return 'monthly';
  if (rule.frequency === 'yearly' && (rule.interval || 1) === 1) return 'yearly';
  return 'custom';
}

function openDateEditor(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  _dateEditorTaskId = taskId;

  $('date-editor-start').value = toLocalDatetimeStr(task.scheduled_start);
  $('date-editor-end').value = toLocalDatetimeStr(task.scheduled_end);

  // Hide recurrence editing for GCal-sourced tasks
  const gcalSourced = task.is_gcal_sourced || (task.recurrence_source_id && (state.tasks.find(t => t.id === task.recurrence_source_id) || {}).is_gcal_sourced);
  const recurrenceSection = document.querySelector('.date-editor-recurrence');
  recurrenceSection.style.display = gcalSourced ? 'none' : '';
  let gcalNotice = document.getElementById('gcal-recurrence-notice');
  if (gcalSourced) {
    if (!gcalNotice) {
      gcalNotice = document.createElement('div');
      gcalNotice.id = 'gcal-recurrence-notice';
      gcalNotice.className = 'gcal-recurrence-notice';
      gcalNotice.textContent = 'Recurrence managed by Google Calendar';
      recurrenceSection.parentNode.insertBefore(gcalNotice, recurrenceSection.nextSibling);
    }
    gcalNotice.style.display = '';
  } else if (gcalNotice) {
    gcalNotice.style.display = 'none';
  }

  // Update preset labels based on task date
  const taskDate = task.scheduled_start ? new Date(task.scheduled_start) : new Date();
  _updatePresetLabels(taskDate);

  // Parse recurrence rule (for instances, inherit from source task for display)
  let rule = null;
  const ruleRaw = task.recurrence_rule
    || (task.recurrence_source_id && (state.tasks.find(t => t.id === task.recurrence_source_id) || {}).recurrence_rule);
  if (ruleRaw) {
    try { rule = typeof ruleRaw === 'string' ? JSON.parse(ruleRaw) : ruleRaw; } catch {}
  }

  const preset = _ruleToPreset(rule);
  $('recurrence-preset').value = preset;
  _onPresetChange(preset, rule);

  $('date-editor-popup').classList.add('show');
}

function _onPresetChange(preset, rule) {
  const isCustom = preset === 'custom';
  $('recurrence-custom').classList.toggle('show', isCustom);

  if (isCustom && rule) {
    $('recurrence-freq').value = rule.frequency || 'weekly';
    $('recurrence-interval').value = rule.interval || 1;
    _updateCustomUI(rule.frequency || 'weekly');
    document.querySelectorAll('.weekday-btn').forEach(btn => {
      const day = parseInt(btn.dataset.day);
      btn.classList.toggle('active', rule.weekdays ? rule.weekdays.includes(day) : false);
    });
    $('recurrence-end-type').value = rule.endType || 'never';
    _updateEndUI(rule.endType || 'never');
    if (rule.endDate) $('recurrence-end-date').value = rule.endDate;
    if (rule.endCount) $('recurrence-end-count').value = rule.endCount;
  } else if (isCustom) {
    $('recurrence-freq').value = 'weekly';
    $('recurrence-interval').value = 1;
    _updateCustomUI('weekly');
    document.querySelectorAll('.weekday-btn').forEach(btn => btn.classList.remove('active'));
    $('recurrence-end-type').value = 'never';
    _updateEndUI('never');
  }
}

function closeDateEditor() {
  $('date-editor-popup').classList.remove('show');
  _dateEditorTaskId = null;
}

function _updateCustomUI(freq) {
  $('recurrence-weekdays').classList.toggle('show', freq === 'weekly');
}

function _updateEndUI(endType) {
  $('recurrence-end-date').style.display = endType === 'date' ? '' : 'none';
  $('recurrence-end-count').style.display = endType === 'count' ? '' : 'none';
}

function buildRecurrenceRule() {
  const preset = $('recurrence-preset').value;
  if (preset === 'none') return null;

  const startVal = $('date-editor-start').value;
  const d = startVal ? new Date(startVal) : new Date();
  const wd = d.getDay();
  const wdIdx = wd === 0 ? 6 : wd - 1;

  if (preset === 'daily') return { frequency: 'daily', interval: 1, endType: 'never' };
  if (preset === 'weekly') return { frequency: 'weekly', interval: 1, weekdays: [wdIdx], endType: 'never' };
  if (preset === 'monthly') return { frequency: 'monthly', interval: 1, monthDay: d.getDate(), endType: 'never' };
  if (preset === 'yearly') return { frequency: 'yearly', interval: 1, endType: 'never' };
  if (preset === 'weekdays') return { frequency: 'weekly', interval: 1, weekdays: [0,1,2,3,4], endType: 'never' };

  const freq = $('recurrence-freq').value;
  const rule = {
    frequency: freq,
    interval: parseInt($('recurrence-interval').value) || 1,
    endType: $('recurrence-end-type').value
  };
  if (freq === 'weekly') {
    rule.weekdays = [];
    document.querySelectorAll('.weekday-btn.active').forEach(btn => {
      rule.weekdays.push(parseInt(btn.dataset.day));
    });
  }
  if (freq === 'monthly') rule.monthDay = d.getDate();
  if (rule.endType === 'date') rule.endDate = $('recurrence-end-date').value || null;
  else if (rule.endType === 'count') rule.endCount = parseInt($('recurrence-end-count').value) || 10;
  return rule;
}

async function saveDateEditor() {
  if (!_dateEditorTaskId) return;
  const task = state.tasks.find(t => t.id === _dateEditorTaskId);
  if (!task) return;

  const startVal = $('date-editor-start').value;
  const endVal = $('date-editor-end').value;
  const scheduled_start = startVal ? new Date(startVal).toISOString() : null;
  const scheduled_end = endVal ? new Date(endVal).toISOString() : null;
  const recurrence_rule = buildRecurrenceRule();

  const isInstance = !!task.recurrence_source_id;
  const wasRecurring = !!(task.recurrence_rule || task.recurrence_source_id);
  const removedRecurrence = wasRecurring && !recurrence_rule;

  const body = { text: task.text, scheduled_start, scheduled_end, recurrence_rule };
  if (isInstance && removedRecurrence) {
    body.detach_from_series = true;
  }

  const result = await api(`/api/tasks/${_dateEditorTaskId}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  });

  if (result && result.success) {
    closeDateEditor();
    await loadState();
  } else {
    closeDateEditor();
  }
}

// Wire date editor events
(function initDateEditor() {
  $('date-editor-close').onclick = closeDateEditor;
  $('date-editor-save').onclick = saveDateEditor;

  $('date-editor-popup').addEventListener('click', (e) => {
    if (e.target === $('date-editor-popup')) closeDateEditor();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('date-editor-popup').classList.contains('show')) closeDateEditor();
  });

  $('recurrence-preset').onchange = () => _onPresetChange($('recurrence-preset').value, null);
  $('recurrence-freq').onchange = () => _updateCustomUI($('recurrence-freq').value);
  $('recurrence-end-type').onchange = () => _updateEndUI($('recurrence-end-type').value);

  $('date-editor-start').onchange = () => {
    const v = $('date-editor-start').value;
    if (v) _updatePresetLabels(new Date(v));
  };

  document.querySelectorAll('.weekday-btn').forEach(btn => {
    btn.onclick = () => btn.classList.toggle('active');
  });
})();

// ========== RECURRENCE CHOICE DIALOG ==========
let _recurrenceChoiceResolve = null;

function _isRecurring(task) {
  return !!(task.recurrence_rule || task.recurrence_source_id);
}

function _getSourceTaskId(task) {
  return task.recurrence_source_id || task.id;
}

function _showRecurrenceChoice() {
  return new Promise(resolve => {
    _recurrenceChoiceResolve = resolve;
    $('recurrence-choice-popup').classList.add('show');
  });
}

function _closeRecurrenceChoice(result) {
  $('recurrence-choice-popup').classList.remove('show');
  if (_recurrenceChoiceResolve) {
    _recurrenceChoiceResolve(result || null);
    _recurrenceChoiceResolve = null;
  }
}

function _handleRecurringAction(taskId, li, action) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  if (!_isRecurring(task)) {
    if (action === 'edit') openDateEditor(taskId);
    else if (action === 'delete') deleteTask(taskId, li);
    return;
  }

  _showRecurrenceChoice().then(choice => {
    if (!choice) return;
    if (choice === 'this') {
      if (action === 'edit') openDateEditor(taskId);
      else if (action === 'delete') deleteTask(taskId, li);
    } else if (choice === 'all') {
      const sourceId = _getSourceTaskId(task);
      if (action === 'edit') openDateEditor(sourceId);
      else if (action === 'delete') {
        const sourceLi = document.querySelector(`[data-id="${sourceId}"]`) || li;
        deleteTask(sourceId, sourceLi);
      }
    }
  });
}

(function initRecurrenceChoice() {
  $('recurrence-choice-close').onclick = () => _closeRecurrenceChoice(null);
  $('recurrence-choice-this').onclick = () => _closeRecurrenceChoice('this');
  $('recurrence-choice-all').onclick = () => _closeRecurrenceChoice('all');

  $('recurrence-choice-popup').addEventListener('click', (e) => {
    if (e.target === $('recurrence-choice-popup')) _closeRecurrenceChoice(null);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('recurrence-choice-popup').classList.contains('show')) _closeRecurrenceChoice(null);
  });
})();
