/* Quest Todo - API Helpers & Auto-Refresh */

// Dev hot-reload state (used by loadState)
let _devCssHash = null;
let _devOtherHash = null;

// Polling interval for state sync (ms)
const POLL_INTERVAL_MS = 5000;

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
    // Dev hot-reload: check file hashes returned by server in debug mode
    if (data._devHash) {
      const { css, other } = data._devHash;
      if (_devCssHash === null) { _devCssHash = css; _devOtherHash = other; }
      else if (other !== _devOtherHash) {
        console.log('\uD83D\uDD04 Dev files changed \u2014 reloading page');
        window.location.reload(true);
        return;
      } else if (css !== _devCssHash) {
        console.log('\uD83D\uDD04 CSS changed \u2014 hot-swapping styles');
        _devCssHash = css;
        document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
          const url = new URL(link.href);
          url.searchParams.set('_r', Date.now());
          link.href = url.toString();
        });
      }
    }
    state = { ...state, ...data };
    renderTasks();
    renderAchievements();
    updateUI();
  }
  // Hide skeleton loader
  $('skeleton-loader')?.classList.add('hidden');
}

// ========== AUTO-REFRESH ==========

// Refresh state when tab becomes visible
let _lastRefreshAt = 0;
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    const now = Date.now();
    if (now - _lastRefreshAt < 3000) return;
    _lastRefreshAt = now;
    loadState();
  }
});

// Periodic background refresh
let refreshTimer = null;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!document.hidden) loadState();
  }, POLL_INTERVAL_MS);
}

// Start auto-refresh
startAutoRefresh();

// Stop auto-refresh on page unload
window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
