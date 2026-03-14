// ========== GOOGLE CALENDAR ==========
// Depends on: $(), api() from app.js

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
