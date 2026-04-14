"""Shared core: config, DB, auth dependencies, validators, progress logic.

This module is the single import target for all routers. Keep it
dependency-light — no routes, no FastAPI app. Other BACKEND modules
can import from here freely without risking circular imports.
"""

import os
import sqlite3
import json
import math
import uuid
import random
import hashlib
import logging
from contextlib import contextmanager
from datetime import datetime, date, timedelta

from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse
from fastapi.templating import Jinja2Templates
from itsdangerous import URLSafeTimedSerializer

from SETTINGS import (
    MAX_DESCRIPTION_LENGTH, PORT, APP_DEBUG,
    INSTANCE_ROLE as DEFAULT_INSTANCE_ROLE,
)


logger = logging.getLogger('todo_game')


# ============== Config (env-loaded at import time) ==============

SECRET_KEY = os.environ.get('SECRET_KEY') or (_ for _ in ()).throw(
    RuntimeError("SECRET_KEY required")
)

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")

INSTANCE_ROLE = os.environ.get("INSTANCE_ROLE", DEFAULT_INSTANCE_ROLE)

GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "")
# Override redirect URI for local dev
if INSTANCE_ROLE == "replica" and GOOGLE_REDIRECT_URI:
    GOOGLE_REDIRECT_URI = f"http://localhost:{PORT}/auth/google/callback"
GOOGLE_CALENDAR_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
APP_URL = os.environ.get("APP_URL", "")

# Upload paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'DATA', 'UPLOADS')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov'}
MAX_TASK_TEXT_LENGTH = 2000

DB_PATH = os.path.join(BASE_DIR, 'DATA', 'users.db')

# Templates (shared Jinja env)
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, 'FRONTEND'))


# ============== Achievements definition ==============

ACHIEVEMENTS = [
    {'id': 'firstQuest', 'check': lambda s: s['completed'] >= 1},
    {'id': 'fiveQuests', 'check': lambda s: s['completed'] >= 5},
    {'id': 'tenQuests', 'check': lambda s: s['completed'] >= 10},
    {'id': 'twentyFiveQuests', 'check': lambda s: s['completed'] >= 25},
    {'id': 'fiftyQuests', 'check': lambda s: s['completed'] >= 50},
    {'id': 'combo3', 'check': lambda s: s['combo'] >= 3},
    {'id': 'combo5', 'check': lambda s: s['combo'] >= 5},
    {'id': 'combo10', 'check': lambda s: s['combo'] >= 10},
    {'id': 'level5', 'check': lambda s: s['level'] >= 5},
    {'id': 'level10', 'check': lambda s: s['level'] >= 10},
    {'id': 'streak7', 'check': lambda s: s['streak'] >= 7},
    {'id': 'streak30', 'check': lambda s: s['streak'] >= 30},
]


# ============== Responses ==============

def error_response(message: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse({'success': False, 'error': message}, status_code=status_code)


async def parse_json(request: Request):
    try:
        return await request.json()
    except Exception:
        return {}


# ============== CSRF ==============

_csrf_serializer = URLSafeTimedSerializer(SECRET_KEY)


def generate_csrf_token() -> str:
    return _csrf_serializer.dumps('csrf', salt='csrf-token')


def validate_csrf_token(token: str) -> bool:
    try:
        _csrf_serializer.loads(token, salt='csrf-token', max_age=3600)
        return True
    except Exception:
        return False


# ============== Database ==============

@contextmanager
def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    """Create tables and run migrations. Idempotent — safe to call on every boot."""
    with get_db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS user_progress (
                id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL,
                level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, xp_max INTEGER DEFAULT 100,
                completed_tasks INTEGER DEFAULT 0, current_streak INTEGER DEFAULT 0,
                combo INTEGER DEFAULT 0, last_completion_date TEXT, sound_enabled INTEGER DEFAULT 0, drum_view INTEGER DEFAULT 1, task_bg INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS user_achievements (
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, achievement_id TEXT NOT NULL,
                unlocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, achievement_id));
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, text TEXT NOT NULL,
                xp_reward INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS friendships (
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, friend_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(user_id, friend_id));
            CREATE INDEX IF NOT EXISTS idx_friendships_user ON friendships(user_id);
            CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);
            CREATE TABLE IF NOT EXISTS activity_log (
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, activity_type TEXT NOT NULL,
                task_text TEXT, xp_earned INTEGER DEFAULT 0, extra_data TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id);
            CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at DESC);
            CREATE TABLE IF NOT EXISTS task_media (
                id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, user_id INTEGER NOT NULL,
                media_type TEXT NOT NULL, filename TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(task_id));
            CREATE TABLE IF NOT EXISTS api_tokens (
                id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, token TEXT UNIQUE NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS idx_api_tokens ON api_tokens(token);
        ''')

        # tasks: add gcal/schedule/description columns if missing
        existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(tasks)")}
        for col in ['scheduled_start', 'scheduled_end', 'google_event_id', 'completed_at',
                    'parent_id', 'recurrence_rule', 'recurrence_source_id',
                    'is_gcal_sourced', 'description']:
            if col not in existing_cols:
                default = ' DEFAULT 0' if col == 'is_gcal_sourced' else ''
                conn.execute(f'ALTER TABLE tasks ADD COLUMN {col} TEXT{default}')

        # Fix zero-duration tasks
        conn.execute('''
            UPDATE tasks SET scheduled_end = datetime(scheduled_start, '+15 minutes')
            WHERE scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL
              AND scheduled_start = scheduled_end
        ''')

        conn.executescript('''
            CREATE TABLE IF NOT EXISTS google_tokens (
                user_id INTEGER PRIMARY KEY,
                access_token TEXT NOT NULL,
                refresh_token TEXT,
                token_expiry TEXT,
                calendar_id TEXT DEFAULT 'primary',
                sync_token TEXT,
                last_sync_at TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
            CREATE INDEX IF NOT EXISTS idx_tasks_google_event ON tasks(google_event_id);
            CREATE TABLE IF NOT EXISTS gcal_deleted_events (
                user_id INTEGER NOT NULL,
                google_event_id TEXT NOT NULL,
                deleted_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, google_event_id)
            );
        ''')

        # google_tokens: add watch columns
        gt_cols = {row[1] for row in conn.execute("PRAGMA table_info(google_tokens)")}
        for col in ['watch_channel_id', 'watch_resource_id', 'watch_expiration']:
            if col not in gt_cols:
                conn.execute(f'ALTER TABLE google_tokens ADD COLUMN {col} TEXT')

        # user_progress: drum_view, task_bg
        up_cols = {row[1] for row in conn.execute("PRAGMA table_info(user_progress)")}
        if 'drum_view' not in up_cols:
            conn.execute('ALTER TABLE user_progress ADD COLUMN drum_view INTEGER DEFAULT 1')
        if 'task_bg' not in up_cols:
            conn.execute('ALTER TABLE user_progress ADD COLUMN task_bg INTEGER DEFAULT 0')

        # activity_log: task_id
        al_cols = {row[1] for row in conn.execute("PRAGMA table_info(activity_log)")}
        if 'task_id' not in al_cols:
            conn.execute('ALTER TABLE activity_log ADD COLUMN task_id TEXT')

        # Backfill missing schedules
        conn.execute("UPDATE tasks SET scheduled_start = created_at WHERE scheduled_start IS NULL")
        conn.execute("UPDATE tasks SET scheduled_end = created_at WHERE scheduled_end IS NULL")

        # One-time cleanup of orphaned local recurrence instances
        cleanup = conn.execute(
            "DELETE FROM tasks WHERE recurrence_source_id IS NOT NULL "
            "AND google_event_id IS NULL AND completed_at IS NULL"
        )
        if cleanup.rowcount:
            logger.info('Removed %d orphaned local recurrence instances', cleanup.rowcount)

        conn.commit()


# ============== Authentication dependencies ==============

def get_authenticated_user(request: Request) -> int:
    username = request.session.get('user')
    if not username:
        raise HTTPException(status_code=401, detail='Not authorized')
    with get_db() as conn:
        user = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()
        if not user:
            request.session.pop('user', None)
            raise HTTPException(status_code=401, detail='Not authorized')
        return user['id']


async def get_token_authenticated_user(request: Request) -> int:
    token = None
    try:
        body = await request.body()
        if body:
            data = json.loads(body)
            token = data.get('token')
    except Exception:
        logger.debug('Failed to parse token from request body', exc_info=True)
    if not token:
        token = request.query_params.get('token')
    if not token:
        raise HTTPException(status_code=401, detail='Token required')
    with get_db() as conn:
        token_row = conn.execute('SELECT user_id FROM api_tokens WHERE token = ?', (token,)).fetchone()
        if not token_row:
            raise HTTPException(status_code=401, detail='Invalid or expired token')
        return token_row['user_id']


# ============== Validators ==============

def validate_task_text(data):
    """Returns (text, error_response) — one is always None."""
    if not data or not data.get('text', '').strip():
        return None, error_response('Task text is required')
    text = data['text'].strip()
    if len(text) > MAX_TASK_TEXT_LENGTH:
        return None, error_response(f'Task text must be at most {MAX_TASK_TEXT_LENGTH} characters')
    return text, None


def validate_description(data):
    """Returns (description_or_None, error_response)."""
    if not data or 'description' not in data:
        return None, None
    desc = data.get('description')
    if desc is None or desc == '':
        return '', None
    if not isinstance(desc, str):
        return None, error_response('Description must be a string')
    if len(desc) > MAX_DESCRIPTION_LENGTH:
        return None, error_response(f'Description must be at most {MAX_DESCRIPTION_LENGTH} characters')
    return desc, None


def new_task_id():
    """Generate unique task ID and random XP reward."""
    return f"{int(datetime.now().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}", random.randint(20, 35)


def normalize_schedule(scheduled_start, scheduled_end):
    """Ensure scheduled_start and scheduled_end are non-null ISO strings.
    Defaults: start -> now, end -> start + 15 min. Swaps if start > end."""
    from dateutil.parser import parse as dt_parse
    now = datetime.utcnow()
    if not scheduled_start:
        scheduled_start = now.isoformat()
    if not scheduled_end:
        try:
            s = dt_parse(scheduled_start)
            scheduled_end = (s.replace(tzinfo=None) + timedelta(minutes=15)).isoformat()
        except Exception:
            scheduled_end = (now + timedelta(minutes=15)).isoformat()
    try:
        s, e = dt_parse(scheduled_start), dt_parse(scheduled_end)
        if s > e:
            scheduled_end = (s.replace(tzinfo=None) + timedelta(minutes=15)).isoformat()
    except Exception:
        pass
    return scheduled_start, scheduled_end


# ============== Progress / XP / Achievements ==============

def get_or_create_progress(conn, user_id):
    progress = conn.execute('SELECT * FROM user_progress WHERE user_id = ?', (user_id,)).fetchone()
    if not progress:
        conn.execute('INSERT INTO user_progress (user_id) VALUES (?)', (user_id,))
        conn.commit()
        return {'level': 1, 'xp': 0, 'xp_max': 100, 'completed_tasks': 0,
                'current_streak': 0, 'combo': 0, 'sound_enabled': 0,
                'drum_view': 1, 'task_bg': 0}
    return dict(progress)


def apply_xp(progress, xp_amount):
    new_xp = progress['xp'] + xp_amount
    new_level = progress['level']
    new_xp_max = progress['xp_max']
    leveled_up = False
    while new_xp >= new_xp_max:
        new_xp -= new_xp_max
        new_level += 1
        new_xp_max = int(100 * math.pow(1.2, new_level - 1))
        leveled_up = True
    return new_xp, new_level, new_xp_max, leveled_up


def complete_task_logic(conn, user_id, task, client_combo=None):
    """Shared completion logic: combo, XP, streak, achievements. Returns result dict."""
    progress = get_or_create_progress(conn, user_id)
    combo = (client_combo + 1) if client_combo is not None else (progress['combo'] + 1)
    xp_earned = int(task['xp_reward'] * (1 + combo * 0.1))
    new_xp, new_level, new_xp_max, leveled_up = apply_xp(progress, xp_earned)

    today, last_date = date.today().isoformat(), progress['last_completion_date']
    new_streak = progress['current_streak']
    if last_date != today:
        if last_date:
            diff = (date.today() - date.fromisoformat(str(last_date))).days
            new_streak = new_streak + 1 if diff == 1 else 1
        else:
            new_streak = 1
    new_completed = progress['completed_tasks'] + 1

    state = {'completed': new_completed, 'combo': combo, 'level': new_level, 'streak': new_streak}
    existing = {a['achievement_id'] for a in conn.execute(
        'SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,))}
    new_achievements = [ach['id'] for ach in ACHIEVEMENTS
                        if ach['id'] not in existing and ach['check'](state)]
    for ach_id in new_achievements:
        conn.execute('INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, ?)',
                     (user_id, ach_id))

    achievement_xp = len(new_achievements) * 100
    if achievement_xp > 0:
        temp_progress = {'xp': new_xp, 'level': new_level, 'xp_max': new_xp_max}
        new_xp, new_level, new_xp_max, ach_leveled = apply_xp(temp_progress, achievement_xp)
        leveled_up = leveled_up or ach_leveled
        xp_earned += achievement_xp

    conn.execute('''UPDATE user_progress SET level=?, xp=?, xp_max=?, completed_tasks=?,
                    current_streak=?, combo=?, last_completion_date=? WHERE user_id=?''',
                 (new_level, new_xp, new_xp_max, new_completed, new_streak, combo, today, user_id))

    return {
        'xp_earned': xp_earned, 'level': new_level, 'xp': new_xp, 'xp_max': new_xp_max,
        'completed': new_completed, 'streak': new_streak, 'combo': combo,
        'leveled_up': leveled_up, 'new_achievements': new_achievements
    }


# ============== Version ==============

_version_cache = None


def get_version() -> str:
    global _version_cache
    if _version_cache is not None:
        return _version_cache
    try:
        version_file = os.path.join(BASE_DIR, 'VERSION.md')
        with open(version_file, 'r', encoding='utf-8') as f:
            for line in reversed(f.readlines()):
                if line.strip().startswith('v'):
                    _version_cache = line.strip().split()[0]
                    return _version_cache
    except Exception as e:
        logger.error(f'Error reading VERSION.md: {e}')
    _version_cache = 'v0.0.0'
    return _version_cache


# ============== Debug file hash (for hot reload) ==============

_WATCH_PATHS = ['FRONTEND', 'BACKEND', 'run.py', 'SETTINGS.py']
_WATCH_EXTENSIONS = {'.py', '.js', '.css', '.html'}


def compute_files_hash():
    """Return (css_hash, other_hash) for dev hot-reload detection."""
    css_mtimes = []
    other_mtimes = []
    for p in _WATCH_PATHS:
        full = os.path.join(BASE_DIR, p)
        if os.path.isfile(full):
            other_mtimes.append(f"{full}:{os.path.getmtime(full)}")
        elif os.path.isdir(full):
            for root, _, files in os.walk(full):
                for f in sorted(files):
                    if os.path.splitext(f)[1] in _WATCH_EXTENSIONS:
                        fp = os.path.join(root, f)
                        entry = f"{fp}:{os.path.getmtime(fp)}"
                        if f.endswith('.css'):
                            css_mtimes.append(entry)
                        else:
                            other_mtimes.append(entry)
    css_hash = hashlib.md5('|'.join(css_mtimes).encode()).hexdigest()[:8]
    other_hash = hashlib.md5('|'.join(other_mtimes).encode()).hexdigest()[:8]
    return css_hash, other_hash
