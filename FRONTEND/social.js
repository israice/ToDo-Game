// ========== SOCIAL TAB ==========
// Depends on: $(), api(), esc(), debounce(), formatTime(),
//             videoObserver, isMobileDevice from app.js

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
  // All user data is escaped with esc() to prevent XSS
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

  container.querySelectorAll('.add-friend-btn:not([disabled])').forEach(btn => {
    btn.onclick = async () => {
      const userId = parseInt(btn.dataset.userId);
      const status = btn.dataset.status;

      if (status === 'pending_received') {
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

function renderRequestList(section, listEl, requests, type, countEl) {
  if (!requests || requests.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  if (countEl) countEl.textContent = requests.length;

  const isIncoming = type === 'incoming';
  listEl.textContent = '';
  requests.forEach(req => {
    const item = document.createElement('div');
    item.className = 'request-item' + (isIncoming ? '' : ' outgoing');
    item.dataset.requestId = req.id;

    const avatar = document.createElement('div');
    avatar.className = 'social-avatar';
    avatar.textContent = req.avatar_letter;

    const info = document.createElement('div');
    info.className = 'request-info';
    const name = document.createElement('span');
    name.className = 'user-name';
    name.textContent = req.username;
    const sub = document.createElement('span');
    sub.className = isIncoming ? 'request-time' : 'request-status';
    sub.textContent = isIncoming ? formatRelativeTime(req.created_at) : 'Awaiting response';
    info.append(name, sub);

    item.append(avatar, info);

    const reqId = req.id;
    if (isIncoming) {
      const actions = document.createElement('div');
      actions.className = 'request-actions';
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'icon-btn accept-btn';
      acceptBtn.title = 'Accept';
      acceptBtn.textContent = '\u2714';
      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'icon-btn reject-btn';
      rejectBtn.title = 'Decline';
      rejectBtn.textContent = '\u2716';
      actions.append(acceptBtn, rejectBtn);
      item.appendChild(actions);

      acceptBtn.onclick = async () => {
        await respondToRequest(reqId, 'accept');
        item.remove();
        if (countEl) countEl.textContent = listEl.children.length;
        if (listEl.children.length === 0) section.style.display = 'none';
        loadFriendsFeed();
      };
      rejectBtn.onclick = async () => {
        await respondToRequest(reqId, 'reject');
        item.remove();
        if (countEl) countEl.textContent = listEl.children.length;
        if (listEl.children.length === 0) section.style.display = 'none';
      };
    } else {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'icon-btn cancel-btn';
      cancelBtn.title = 'Cancel';
      cancelBtn.textContent = '\u2716';
      item.appendChild(cancelBtn);

      cancelBtn.onclick = async () => {
        await cancelFriendRequest(reqId);
        item.remove();
        if (listEl.children.length === 0) section.style.display = 'none';
      };
    }

    listEl.appendChild(item);
  });
}

async function loadFriendsData() {
  const data = await getFriends();
  if (!data) return;

  renderRequestList($('incoming-requests-section'), $('incoming-requests'), data.incoming, 'incoming', $('incoming-count'));
  renderRequestList($('outgoing-requests-section'), $('outgoing-requests'), data.outgoing, 'outgoing');

  await loadFriendsFeed();

  const hasRequests = (data.incoming && data.incoming.length > 0) ||
                      (data.outgoing && data.outgoing.length > 0);
  const hasFeed = $('friends-feed').children.length > 0;
  const friendsEmpty = $('friends-empty');
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
  loadMoreBtn.classList.toggle('show', hasMore);
}

// All user data is escaped with esc() to prevent XSS
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
        mediaHtml = `<div class="video-wrapper"><video class="social-media" src="${item.media_url}" muted playsinline preload="metadata"></video><div class="video-play-overlay"><span class="play-icon">\u25B6</span></div></div>`;
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
