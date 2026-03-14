// ========== HISTORY ==========
// Depends on: $(), api(), formatTaskDate() from app.js

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
  const d = formatTaskDate(timestamp);
  return `${d.day} ${d.time}`;
}
