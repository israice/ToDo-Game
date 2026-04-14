// ========== GOOGLE CALENDAR ==========
// Depends on: $(), api() from app.js

async function checkGoogleCalendarStatus() {
  const data = await api('/api/google/status');
  if (!data) return;
  const statusEl = $('gcal-status');
  const toggleEl = $('gcal-toggle');
  const overlay = $('gcal-required-overlay');
  if (!data.available) {
    if (toggleEl) toggleEl.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    return;
  }
  if (statusEl) statusEl.textContent = data.connected ? 'ON' : 'OFF';
  if (overlay) overlay.style.display = data.connected ? 'none' : 'flex';
}

$('gcal-required-connect')?.addEventListener('click', () => {
  window.location.href = '/auth/google/connect';
});

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
