import os, math, uuid, random, hashlib, hmac, subprocess, sqlite3, logging, json, asyncio
import warnings
from datetime import datetime, date, timedelta
from contextlib import contextmanager

from fastapi import FastAPI, Request, Response, Form, UploadFile, File, Depends, HTTPException
from fastapi.responses import JSONResponse, RedirectResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from dotenv import load_dotenv
import bcrypt
from itsdangerous import URLSafeTimedSerializer
import uvicorn
from SETTINGS import APP_DEBUG, PORT, BRANCH as DEFAULT_BRANCH, GOOGLE_CALENDAR_SYNC_INTERVAL, DRUM_ROW_HEIGHT, DRUM_MAX_TOP_ANGLE, DRUM_PERSPECTIVE_K, DRUM_HIGHLIGHT_OFFSET, INSTANCE_ROLE as DEFAULT_INSTANCE_ROLE

# Suppress all dependency warnings
warnings.filterwarnings('ignore')
os.environ['PYTHONWARNINGS'] = 'ignore'

load_dotenv()

# Load secrets from Bitwarden (overrides .env values if BWS enabled)
from BACKEND.bws_loader import load_bws_secrets
load_bws_secrets()

# ============== Logging ==============

logger = logging.getLogger(__name__)

class IgnoreWellKnown(logging.Filter):
    def filter(self, record):
        return '/.well-known/' not in record.getMessage()

logging.getLogger('uvicorn.access').addFilter(IgnoreWellKnown())

# ============== App Initialization ==============

SECRET_KEY = os.environ.get('SECRET_KEY') or (_ for _ in ()).throw(RuntimeError("SECRET_KEY required"))

app = FastAPI()

# Middleware (last added = outermost)
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)

class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        return response

app.add_middleware(NoCacheMiddleware)

# Templates
templates = Jinja2Templates(directory="FRONTEND")

# Config
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
BRANCH = os.environ.get("BRANCH", DEFAULT_BRANCH)

# Google Calendar integration (optional)
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "")
GOOGLE_CALENDAR_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
APP_URL = os.environ.get("APP_URL", "")  # Public HTTPS URL for Google Calendar webhooks
INSTANCE_ROLE = os.environ.get("INSTANCE_ROLE", DEFAULT_INSTANCE_ROLE)  # "primary" or "replica"

# Override Google redirect URI for local development
if INSTANCE_ROLE == "replica" and GOOGLE_REDIRECT_URI:
    GOOGLE_REDIRECT_URI = f"http://localhost:{PORT}/auth/google/callback"

# Media uploads configuration
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'DATA', 'UPLOADS')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov'}
MAX_TASK_TEXT_LENGTH = 2000

# CSRF
csrf_serializer = URLSafeTimedSerializer(SECRET_KEY)

def generate_csrf_token():
    return csrf_serializer.dumps('csrf', salt='csrf-token')

def validate_csrf_token(token):
    try:
        csrf_serializer.loads(token, salt='csrf-token', max_age=3600)
        return True
    except Exception:
        return False

def error_response(message: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse({'success': False, 'error': message}, status_code=status_code)

# Achievements
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


# ============== File Hash (debug mode only) ==============

if APP_DEBUG:
    _WATCH_PATHS = ['FRONTEND', 'BACKEND', 'run.py', 'SETTINGS.py']
    _WATCH_EXTENSIONS = {'.py', '.js', '.css', '.html'}

    def _compute_files_hash():
        css_mtimes = []
        other_mtimes = []
        base = os.path.dirname(__file__)
        for p in _WATCH_PATHS:
            full = os.path.join(base, p)
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

    @app.get('/api/files-hash')
    async def api_files_hash():
        css_hash, other_hash = _compute_files_hash()
        return {'css': css_hash, 'other': other_hash}

# ============== DB Helpers ==============

@contextmanager
def get_db():
    db_path = os.path.join(os.path.dirname(__file__), 'DATA', 'users.db')
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS user_progress (
                id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL,
                level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, xp_max INTEGER DEFAULT 100,
                completed_tasks INTEGER DEFAULT 0, current_streak INTEGER DEFAULT 0,
                combo INTEGER DEFAULT 0, last_completion_date TEXT, sound_enabled INTEGER DEFAULT 0, drum_view INTEGER DEFAULT 1,
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

        # Google Calendar migration: add schedule columns to tasks
        cursor = conn.execute("PRAGMA table_info(tasks)")
        existing_cols = {row[1] for row in cursor.fetchall()}
        for col in ['scheduled_start', 'scheduled_end', 'google_event_id', 'completed_at', 'parent_id', 'recurrence_rule', 'recurrence_source_id', 'is_gcal_sourced']:
            if col not in existing_cols:
                default = ' DEFAULT 0' if col == 'is_gcal_sourced' else ''
                conn.execute(f'ALTER TABLE tasks ADD COLUMN {col} TEXT{default}')

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

        # Google Calendar push notifications: add watch columns
        gt_cursor = conn.execute("PRAGMA table_info(google_tokens)")
        gt_cols = {row[1] for row in gt_cursor.fetchall()}
        for col in ['watch_channel_id', 'watch_resource_id', 'watch_expiration']:
            if col not in gt_cols:
                conn.execute(f'ALTER TABLE google_tokens ADD COLUMN {col} TEXT')

        # Migrate user_progress: add drum_view column
        up_cursor = conn.execute("PRAGMA table_info(user_progress)")
        up_cols = {row[1] for row in up_cursor.fetchall()}
        if 'drum_view' not in up_cols:
            conn.execute('ALTER TABLE user_progress ADD COLUMN drum_view INTEGER DEFAULT 1')

        # Migrate activity_log: add task_id column
        al_cursor = conn.execute("PRAGMA table_info(activity_log)")
        al_cols = {row[1] for row in al_cursor.fetchall()}
        if 'task_id' not in al_cols:
            conn.execute('ALTER TABLE activity_log ADD COLUMN task_id TEXT')

        # Backfill: set scheduled_start/end to created_at where missing
        conn.execute("UPDATE tasks SET scheduled_start = created_at WHERE scheduled_start IS NULL")
        conn.execute("UPDATE tasks SET scheduled_end = created_at WHERE scheduled_end IS NULL")
        conn.commit()

# ============== Auth Dependencies ==============

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
    # Try body first (POST requests)
    try:
        body = await request.body()
        if body:
            data = json.loads(body)
            token = data.get('token')
    except Exception:
        logger.debug('Failed to parse token from request body', exc_info=True)
    # Fallback to query param (GET requests)
    if not token:
        token = request.query_params.get('token')
    if not token:
        raise HTTPException(status_code=401, detail='Token required')
    with get_db() as conn:
        token_row = conn.execute('SELECT user_id FROM api_tokens WHERE token = ?', (token,)).fetchone()
        if not token_row:
            raise HTTPException(status_code=401, detail='Invalid or expired token')
        return token_row['user_id']

# ============== Business Logic Helpers ==============

def get_or_create_progress(conn, user_id):
    progress = conn.execute('SELECT * FROM user_progress WHERE user_id = ?', (user_id,)).fetchone()
    if not progress:
        conn.execute('INSERT INTO user_progress (user_id) VALUES (?)', (user_id,))
        conn.commit()
        return {'level': 1, 'xp': 0, 'xp_max': 100, 'completed_tasks': 0, 'current_streak': 0, 'combo': 0, 'sound_enabled': 0, 'drum_view': 1}
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

def _gcal_service(conn, user_id):
    """Get Google Calendar service and calendar ID for user, or (None, None)."""
    from BACKEND.google_calendar import get_google_credentials, get_calendar_service
    creds = get_google_credentials(conn, user_id, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
    if not creds:
        return None, None
    service = get_calendar_service(creds)
    cal_row = conn.execute('SELECT calendar_id FROM google_tokens WHERE user_id = ?', (user_id,)).fetchone()
    cal_id = cal_row['calendar_id'] if cal_row else 'primary'
    return service, cal_id

def _complete_task_logic(conn, user_id, task, client_combo=None):
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
    existing = {a['achievement_id'] for a in conn.execute('SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,))}
    new_achievements = [ach['id'] for ach in ACHIEVEMENTS if ach['id'] not in existing and ach['check'](state)]
    for ach_id in new_achievements:
        conn.execute('INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, ?)', (user_id, ach_id))

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

def _validate_task_text(data):
    """Validate task text from request data. Returns (text, error_response) -- one is always None."""
    if not data or not data.get('text', '').strip():
        return None, error_response('Task text is required')
    text = data['text'].strip()
    if len(text) > MAX_TASK_TEXT_LENGTH:
        return None, error_response(f'Task text must be at most {MAX_TASK_TEXT_LENGTH} characters')
    return text, None

async def _parse_json(request):
    """Parse JSON body, return {} on failure."""
    try:
        return await request.json()
    except Exception:
        return {}

def _new_task_id():
    """Generate unique task ID and random XP reward."""
    return f"{int(datetime.now().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}", random.randint(20, 35)


def _gcal_delete_tasks(conn, user_id, task_ids):
    """Delete GCal events for given task IDs and record in gcal_deleted_events."""
    if not GOOGLE_CALENDAR_ENABLED or not task_ids:
        return
    ph = ','.join('?' * len(task_ids))
    rows = conn.execute(
        f'SELECT id, google_event_id FROM tasks WHERE id IN ({ph}) AND google_event_id IS NOT NULL',
        task_ids).fetchall()
    if not rows:
        return
    try:
        service, cal_id = _gcal_service(conn, user_id)
        if service:
            from BACKEND.google_calendar import delete_calendar_event
            for r in rows:
                try:
                    delete_calendar_event(service, cal_id, r['google_event_id'])
                except Exception:
                    pass
                conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                             (user_id, r['google_event_id']))
    except Exception:
        logger.error('Failed to sync task deletion to Google Calendar', exc_info=True)


def _generate_recurrence_instances(conn, user_id, source_task_id, text, xp, scheduled_start, scheduled_end, recurrence_rule_str, horizon_days=30):
    """Generate recurring task instances for the next horizon_days.

    Deletes old uncompleted instances first, then creates new ones.
    source_task_id: the original recurring task's ID.
    """
    # Collect GCal event IDs from instances about to be deleted
    old_instances = conn.execute(
        'SELECT id FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND completed_at IS NULL',
        (source_task_id, user_id)
    ).fetchall()
    if old_instances:
        _gcal_delete_tasks(conn, user_id, [r['id'] for r in old_instances])

    # Delete existing uncompleted future instances for this source
    conn.execute(
        'DELETE FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND completed_at IS NULL',
        (source_task_id, user_id)
    )

    if not recurrence_rule_str:
        return

    try:
        rule = json.loads(recurrence_rule_str) if isinstance(recurrence_rule_str, str) else recurrence_rule_str
    except (json.JSONDecodeError, TypeError):
        return

    freq = rule.get('frequency')
    interval = max(1, rule.get('interval', 1))
    end_type = rule.get('endType', 'never')
    end_date = None
    end_count = None
    if end_type == 'date' and rule.get('endDate'):
        try:
            end_date = datetime.fromisoformat(rule['endDate'])
        except ValueError:
            pass
    elif end_type == 'count':
        end_count = rule.get('endCount', 10)

    # Parse base start/end (strip timezone to keep everything naive UTC)
    def _parse_naive(iso):
        if not iso:
            return datetime.utcnow()
        try:
            dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
            return dt.replace(tzinfo=None) if dt.tzinfo else dt
        except ValueError:
            return datetime.utcnow()

    base_start = _parse_naive(scheduled_start)
    base_end = _parse_naive(scheduled_end)

    duration = base_end - base_start
    horizon = datetime.utcnow() + timedelta(days=horizon_days)
    weekdays = rule.get('weekdays', [])
    month_day = rule.get('monthDay')

    from dateutil.relativedelta import relativedelta

    instances_created = 0
    step = 1  # occurrence counter (0 = the original task itself)
    max_iterations = 400  # safety limit

    current = base_start
    for _ in range(max_iterations):
        # Advance to next occurrence
        if freq == 'daily':
            current = current + timedelta(days=interval * step)
        elif freq == 'weekly':
            if weekdays:
                # Find next matching weekday
                current = _next_weekday_occurrence(base_start, weekdays, interval, step)
                if current is None:
                    break
            else:
                current = current + timedelta(weeks=interval * step)
        elif freq == 'monthly':
            current = base_start + relativedelta(months=interval * step)
            if month_day:
                try:
                    current = current.replace(day=min(month_day, 28))
                except ValueError:
                    pass
        elif freq == 'yearly':
            current = base_start + relativedelta(years=interval * step)
        else:
            break

        step += 1

        # Check bounds
        if current > horizon:
            break
        if end_date and current.date() > end_date.date():
            break
        if end_count and instances_created >= end_count:
            break
        if current <= base_start:
            continue

        # Create instance
        inst_id, inst_xp = _new_task_id()
        inst_start = current.isoformat()
        inst_end = (current + duration).isoformat()
        conn.execute(
            'INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end, recurrence_source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (inst_id, user_id, text, xp, inst_start, inst_end, source_task_id)
        )
        instances_created += 1


def _next_weekday_occurrence(base_start, weekdays, interval, step):
    """Compute the step-th weekly-weekday occurrence from base_start."""
    if not weekdays:
        return None
    # Sort weekdays (0=Mon..6=Sun)
    sorted_days = sorted(weekdays)
    # base weekday: Monday=0
    base_wd = base_start.weekday()

    # Build flat list of all occurrences
    occurrence = 0
    week_offset = 0
    max_weeks = 200
    while week_offset < max_weeks:
        for wd in sorted_days:
            candidate = base_start + timedelta(weeks=week_offset * interval, days=wd - base_wd)
            if candidate <= base_start:
                continue
            occurrence += 1
            if occurrence == step:
                return candidate
        week_offset += 1
    return None

# Cache version after first read
_version_cache = None

def get_version():
    global _version_cache
    if _version_cache is not None:
        return _version_cache
    try:
        version_file = os.path.join(os.path.dirname(__file__), 'VERSION.md')
        with open(version_file, 'r', encoding='utf-8') as f:
            for line in reversed(f.readlines()):
                if line.strip().startswith('v'):
                    version = line.strip().split()[0]
                    _version_cache = version
                    return version
    except Exception as e:
        logger.error(f'Error reading VERSION.md: {e}')
    _version_cache = 'v0.0.0'
    return _version_cache

# ============== Well-Known & Health ==============

@app.get('/.well-known/health')
async def health_check():
    return JSONResponse({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'version': get_version()
    })

@app.get('/.well-known/{path:path}')
async def well_known(path: str):
    return Response(status_code=204)

# ============== Auth Routes ==============

@app.get('/')
async def index(request: Request):
    if request.session.get('user'):
        return templates.TemplateResponse('dashboard.html', {
            'request': request,
            'user': request.session['user'],
            'version': get_version()
        })
    register_error = request.session.pop('register_error', None)
    return templates.TemplateResponse('login.html', {
        'request': request,
        'error': None,
        'register_error': register_error,
        'csrf_token': generate_csrf_token()
    })

@app.post('/login')
async def login(request: Request, username: str = Form(...), password: str = Form(...), csrf_token: str = Form('')):
    if not validate_csrf_token(csrf_token):
        return templates.TemplateResponse('login.html', {
            'request': request,
            'error': 'Invalid request',
            'register_error': None,
            'csrf_token': generate_csrf_token()
        })
    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
    if user and bcrypt.checkpw(password.encode(), user['password'].encode()):
        request.session['user'] = user['username']
        return RedirectResponse('/', status_code=303)
    return templates.TemplateResponse('login.html', {
        'request': request,
        'error': 'Invalid credentials',
        'register_error': None,
        'csrf_token': generate_csrf_token()
    })

@app.post('/register')
async def register(request: Request, username: str = Form(...), password: str = Form(...), csrf_token: str = Form('')):
    if not validate_csrf_token(csrf_token):
        request.session['register_error'] = 'Invalid request'
        return RedirectResponse('/', status_code=303)
    if len(username.strip()) < 3:
        request.session['register_error'] = 'Username must be at least 3 characters'
        return RedirectResponse('/', status_code=303)
    if len(password) < 4:
        request.session['register_error'] = 'Password must be at least 4 characters'
        return RedirectResponse('/', status_code=303)
    with get_db() as conn:
        try:
            pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            cursor = conn.execute('INSERT INTO users (username, password) VALUES (?, ?)',
                                  (username, pw_hash))
            conn.execute('INSERT INTO user_progress (user_id) VALUES (?)', (cursor.lastrowid,))
            conn.commit()
            request.session['user'] = username
            return RedirectResponse('/', status_code=303)
        except Exception:
            request.session['register_error'] = 'User already exists'
            return RedirectResponse('/', status_code=303)

@app.get('/logout')
async def logout(request: Request):
    request.session.pop('user', None)
    return RedirectResponse('/', status_code=303)

# ============== API Auth Routes (for Telegram bot) ==============

@app.post('/api/auth/login')
async def api_login(request: Request):
    data = await _parse_json(request)
    username = data.get('username', '').strip()
    password = data.get('password', '')

    if not username or not password:
        return JSONResponse({'success': False, 'error': 'Username and password required'}, status_code=400)

    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        if not user:
            return JSONResponse({'success': False, 'error': 'User not found'}, status_code=404)

        if not bcrypt.checkpw(password.encode(), user['password'].encode()):
            return JSONResponse({'success': False, 'error': 'Invalid password'}, status_code=401)

        session_token = hashlib.sha256(f"{user['id']}-{username}-{os.urandom(16).hex()}".encode()).hexdigest()
        conn.execute('INSERT INTO api_tokens (user_id, token, created_at) VALUES (?, ?, datetime(\'now\'))',
                     (user['id'], session_token))
        conn.commit()

        return JSONResponse({
            'success': True,
            'token': session_token,
            'username': username,
            'user_id': user['id']
        })

@app.post('/api/auth/register')
async def api_register(request: Request):
    data = await _parse_json(request)
    username = data.get('username', '').strip()
    password = data.get('password', '')

    if not username or not password:
        return JSONResponse({'success': False, 'error': 'Username and password required'}, status_code=400)
    if len(username) < 3:
        return JSONResponse({'success': False, 'error': 'Username must be at least 3 characters'}, status_code=400)
    if len(password) < 4:
        return JSONResponse({'success': False, 'error': 'Password must be at least 4 characters'}, status_code=400)

    with get_db() as conn:
        try:
            pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
            cursor = conn.execute('INSERT INTO users (username, password) VALUES (?, ?)',
                                  (username, pw_hash))
            conn.execute('INSERT INTO user_progress (user_id) VALUES (?)', (cursor.lastrowid,))
            conn.commit()

            session_token = hashlib.sha256(f"{cursor.lastrowid}-{username}-{os.urandom(16).hex()}".encode()).hexdigest()
            conn.execute('INSERT INTO api_tokens (user_id, token, created_at) VALUES (?, ?, datetime(\'now\'))',
                         (cursor.lastrowid, session_token))
            conn.commit()

            return JSONResponse({
                'success': True,
                'token': session_token,
                'username': username,
                'user_id': cursor.lastrowid
            })
        except sqlite3.IntegrityError:
            return JSONResponse({'success': False, 'error': 'Username already exists', 'alreadyExists': True}, status_code=409)

@app.post('/api/auth/logout')
async def api_logout(request: Request):
    data = await _parse_json(request)
    token = data.get('token', '')

    with get_db() as conn:
        conn.execute('DELETE FROM api_tokens WHERE token = ?', (token,))
        conn.commit()

    return JSONResponse({'success': True})

# ============== API Routes ==============

@app.get('/api/state')
async def api_get_state(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        # Auto-delete completed tasks older than 7 days
        cutoff = (datetime.utcnow() - timedelta(days=7)).isoformat()
        expired = conn.execute(
            'SELECT id, google_event_id FROM tasks WHERE user_id = ? AND completed_at IS NOT NULL AND completed_at < ?',
            (user_id, cutoff)).fetchall()
        if expired:
            if GOOGLE_CALENDAR_ENABLED:
                try:
                    service, cal_id = _gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import delete_calendar_event
                        for t in expired:
                            if t['google_event_id']:
                                try:
                                    delete_calendar_event(service, cal_id, t['google_event_id'])
                                except Exception:
                                    pass
                                conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                                             (user_id, t['google_event_id']))
                except Exception:
                    logger.error('Failed to sync expired tasks deletion to Google Calendar', exc_info=True)
            expired_ids = [t['id'] for t in expired]
            ph = ','.join('?' * len(expired_ids))

            # Delete media files from disk
            media_files = conn.execute(
                f'SELECT filename FROM task_media WHERE task_id IN ({ph})', expired_ids).fetchall()
            for mf in media_files:
                fpath = os.path.join(UPLOAD_FOLDER, mf['filename'])
                if os.path.isfile(fpath):
                    try:
                        os.remove(fpath)
                    except OSError:
                        pass

            # Sync subtasks and recurrence instances to GCal before cascade delete
            cascade_subtasks = conn.execute(
                f'SELECT id FROM tasks WHERE parent_id IN ({ph}) AND user_id = ?', expired_ids + [user_id]).fetchall()
            cascade_recurrence = conn.execute(
                f'SELECT id FROM tasks WHERE recurrence_source_id IN ({ph}) AND user_id = ?', expired_ids + [user_id]).fetchall()
            cascade_ids = [r['id'] for r in cascade_subtasks] + [r['id'] for r in cascade_recurrence]
            if cascade_ids:
                _gcal_delete_tasks(conn, user_id, cascade_ids)

            # Delete subtasks and recurrence instances
            conn.execute(f'DELETE FROM tasks WHERE parent_id IN ({ph}) AND user_id = ?', expired_ids + [user_id])
            conn.execute(f'DELETE FROM tasks WHERE recurrence_source_id IN ({ph}) AND user_id = ?', expired_ids + [user_id])
            conn.execute(f'DELETE FROM tasks WHERE id IN ({ph})', expired_ids)
            conn.commit()

        progress = get_or_create_progress(conn, user_id)
        media_map = {m['task_id']: {'type': m['media_type'], 'url': f"/UPLOADS/{m['filename']}"}
                     for m in conn.execute('SELECT task_id, media_type, filename FROM task_media WHERE user_id = ?', (user_id,))}
        tasks = [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward'], 'media': media_map.get(t['id']),
                  'scheduled_start': t['scheduled_start'], 'scheduled_end': t['scheduled_end'],
                  'completed_at': t['completed_at'], 'parent_id': t['parent_id'],
                  'recurrence_rule': t['recurrence_rule'], 'recurrence_source_id': t['recurrence_source_id'],
                  'is_gcal_sourced': t['is_gcal_sourced'] == '1'}
                 for t in conn.execute('SELECT id, text, xp_reward, scheduled_start, scheduled_end, completed_at, parent_id, recurrence_rule, recurrence_source_id, is_gcal_sourced FROM tasks WHERE user_id = ? ORDER BY created_at DESC', (user_id,))]
        achievements = {a['achievement_id']: True for a in conn.execute('SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,))}
        result = {
            'tasks': tasks, 'level': progress['level'], 'xp': progress['xp'], 'xpMax': progress['xp_max'],
            'completed': progress['completed_tasks'], 'streak': progress['current_streak'],
            'combo': progress['combo'], 'achievements': achievements, 'sound': bool(progress['sound_enabled']),
            'drumView': bool(progress.get('drum_view', 1))
        }
        if APP_DEBUG:
            css_hash, other_hash = _compute_files_hash()
            result['_devHash'] = {'css': css_hash, 'other': other_hash}
        return JSONResponse(result)

@app.put('/api/settings')
async def api_update_settings(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    with get_db() as conn:
        if 'sound' in data:
            conn.execute('UPDATE user_progress SET sound_enabled = ? WHERE user_id = ?', (1 if data['sound'] else 0, user_id))
        if 'drumView' in data:
            conn.execute('UPDATE user_progress SET drum_view = ? WHERE user_id = ?', (1 if data['drumView'] else 0, user_id))
        conn.commit()
    return JSONResponse({'success': True})

@app.post('/api/tasks')
async def api_create_task(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    text, err = _validate_task_text(data)
    if err: return err
    task_id, xp = _new_task_id()
    scheduled_start = data.get('scheduled_start') or None
    scheduled_end = data.get('scheduled_end') or None
    parent_id = data.get('parent_id') or None
    recurrence_rule = data.get('recurrence_rule') or None
    if recurrence_rule and isinstance(recurrence_rule, dict):
        recurrence_rule = json.dumps(recurrence_rule)

    google_event_id = None
    with get_db() as conn:
        # Validate parent exists if provided
        if parent_id:
            parent = conn.execute('SELECT id FROM tasks WHERE id = ? AND user_id = ?', (parent_id, user_id)).fetchone()
            if not parent:
                return error_response('Parent task not found', 404)

        conn.execute('INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end, parent_id, recurrence_rule) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                     (task_id, user_id, text, xp, scheduled_start, scheduled_end, parent_id, recurrence_rule))
        progress = get_or_create_progress(conn, user_id)
        new_xp, new_level, new_xp_max, leveled_up = apply_xp(progress, 3)
        conn.execute('UPDATE user_progress SET xp=?, level=?, xp_max=? WHERE user_id=?',
                     (new_xp, new_level, new_xp_max, user_id))

        # Sync to Google Calendar
        if GOOGLE_CALENDAR_ENABLED:
            try:
                service, cal_id = _gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import create_calendar_event
                    google_event_id = create_calendar_event(service, cal_id, text, scheduled_start, scheduled_end, recurrence_rule)
                    if google_event_id:
                        conn.execute('UPDATE tasks SET google_event_id = ? WHERE id = ?', (google_event_id, task_id))
            except Exception:
                logger.error('Failed to sync new task to Google Calendar', exc_info=True)

        # Log activity
        conn.execute('''INSERT INTO activity_log (user_id, activity_type, task_text, xp_earned)
                        VALUES (?, 'task_created', ?, ?)''', (user_id, text, 3))

        # Generate recurrence instances
        if recurrence_rule and not parent_id:
            _generate_recurrence_instances(conn, user_id, task_id, text, xp, scheduled_start, scheduled_end, recurrence_rule)

        conn.commit()

    return JSONResponse({
        'id': task_id, 'text': text, 'xp': xp,
        'scheduled_start': scheduled_start, 'scheduled_end': scheduled_end,
        'parent_id': parent_id, 'recurrence_rule': recurrence_rule,
        'xpEarned': 3, 'level': new_level, 'currentXp': new_xp, 'xpMax': new_xp_max, 'leveledUp': leveled_up
    })

@app.put('/api/tasks/{task_id}')
async def api_update_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    text, err = _validate_task_text(data)
    if err: return err
    scheduled_start = data.get('scheduled_start')
    scheduled_end = data.get('scheduled_end')
    _sentinel = object()
    recurrence_rule = data.get('recurrence_rule', _sentinel)
    recurrence_rule_provided = recurrence_rule is not _sentinel
    if recurrence_rule is _sentinel:
        recurrence_rule = None
    if recurrence_rule is not None and isinstance(recurrence_rule, dict):
        recurrence_rule = json.dumps(recurrence_rule)
    detach_from_series = data.get('detach_from_series', False)

    with get_db() as conn:
        # Detach instance from recurring series: keep this task, delete all others in series
        if detach_from_series:
            task_row = conn.execute('SELECT recurrence_source_id FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
            if task_row and task_row['recurrence_source_id']:
                source_id = task_row['recurrence_source_id']
                # Record GCal event IDs of siblings before deleting
                siblings = conn.execute(
                    'SELECT id FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND id != ?',
                    (source_id, user_id, task_id)).fetchall()
                if siblings:
                    _gcal_delete_tasks(conn, user_id, [s['id'] for s in siblings])
                # Delete other instances (not this one)
                conn.execute('DELETE FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND id != ?', (source_id, user_id, task_id))
                # Clear recurrence_rule on source task
                conn.execute('UPDATE tasks SET recurrence_rule = NULL WHERE id = ? AND user_id = ?', (source_id, user_id))
                # Detach this task from the series
                conn.execute('UPDATE tasks SET recurrence_source_id = NULL, recurrence_rule = NULL WHERE id = ? AND user_id = ?', (task_id, user_id))
                conn.commit()
                return JSONResponse({'success': True})

        # Build dynamic update
        updates = ['text = ?']
        params = [text]
        if scheduled_start is not None:
            updates.append('scheduled_start = ?')
            params.append(scheduled_start or None)
        if scheduled_end is not None:
            updates.append('scheduled_end = ?')
            params.append(scheduled_end or None)
        if recurrence_rule_provided:
            updates.append('recurrence_rule = ?')
            params.append(recurrence_rule or None)
        params.extend([task_id, user_id])
        conn.execute(f'UPDATE tasks SET {", ".join(updates)} WHERE id = ? AND user_id = ?', params)

        # Sync to Google Calendar
        if GOOGLE_CALENDAR_ENABLED:
            task = conn.execute('SELECT google_event_id, scheduled_start, scheduled_end, recurrence_rule FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
            if task and task['google_event_id']:
                try:
                    service, cal_id = _gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import update_calendar_event
                        update_calendar_event(service, cal_id, task['google_event_id'], text, task['scheduled_start'], task['scheduled_end'], task['recurrence_rule'])
                except Exception:
                    logger.error('Failed to sync task update to Google Calendar', exc_info=True)

        # Regenerate recurrence instances when recurrence_rule changes (skip for GCal-sourced)
        if recurrence_rule_provided:
            task_row = conn.execute('SELECT xp_reward, scheduled_start, scheduled_end, recurrence_rule, parent_id, is_gcal_sourced FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
            if task_row and not task_row['parent_id'] and task_row['is_gcal_sourced'] != '1':
                _generate_recurrence_instances(conn, user_id, task_id, text, task_row['xp_reward'],
                                               task_row['scheduled_start'], task_row['scheduled_end'], task_row['recurrence_rule'])

        conn.commit()

    event_data = {'id': task_id, 'text': text}
    if scheduled_start is not None:
        event_data['scheduled_start'] = scheduled_start or None
    if scheduled_end is not None:
        event_data['scheduled_end'] = scheduled_end or None
    if recurrence_rule_provided:
        event_data['recurrence_rule'] = recurrence_rule or None
    return JSONResponse({'success': True})

@app.delete('/api/tasks/{task_id}')
async def api_delete_task(task_id: str, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        # Sync to Google Calendar before deleting
        if GOOGLE_CALENDAR_ENABLED:
            task = conn.execute('SELECT google_event_id FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
            if task and task['google_event_id']:
                try:
                    service, cal_id = _gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import delete_calendar_event
                        delete_calendar_event(service, cal_id, task['google_event_id'])
                except Exception:
                    logger.error('Failed to sync task deletion to Google Calendar', exc_info=True)
                # Record so sync won't recreate this event
                conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                             (user_id, task['google_event_id']))

            # Also record gcal event IDs from recurrence instances being cascade-deleted
            for inst in conn.execute(
                'SELECT google_event_id FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND google_event_id IS NOT NULL',
                (task_id, user_id)
            ).fetchall():
                conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                             (user_id, inst['google_event_id']))

        # Delete recurrence instances, subtasks, then the task itself
        conn.execute('DELETE FROM tasks WHERE recurrence_source_id = ? AND user_id = ?', (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE parent_id = ? AND user_id = ?', (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id))
        conn.commit()

    return JSONResponse({'success': True})

@app.post('/api/tasks/{task_id}/breakdown')
async def api_breakdown_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
        if not task:
            return error_response('Task not found', 404)

    from BACKEND.ai_service import breakdown_task
    try:
        subtasks_data = await breakdown_task(task['text'])
    except Exception as e:
        logger.error('AI breakdown failed: %s', e)
        return error_response('AI breakdown failed', 500)

    created = []
    with get_db() as conn:
        for st in subtasks_data:
            sub_id, xp = _new_task_id()
            text = st.get('text', '') if isinstance(st, dict) else str(st)
            conn.execute(
                'INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (sub_id, user_id, text, xp, task['scheduled_start'], task['scheduled_end'], task_id)
            )
            created.append({'id': sub_id, 'text': text, 'xp': xp,
                            'scheduled_start': task['scheduled_start'], 'scheduled_end': task['scheduled_end'],
                            'parent_id': task_id})
        conn.commit()

    return JSONResponse({'success': True, 'subtasks': created})

@app.post('/api/tasks/{task_id}/complete')
async def api_complete_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
        if not task:
            return error_response('Task not found', 404)
        if task['completed_at']:
            return error_response('Task already completed', 400)

        data = await _parse_json(request)
        r = _complete_task_logic(conn, user_id, task, data.get('combo', 0))

        # Log activity
        media = conn.execute('SELECT media_type, filename FROM task_media WHERE task_id = ?', (task_id,)).fetchone()
        extra_data = json.dumps({'media_type': media['media_type'], 'media_url': f"/UPLOADS/{media['filename']}"}) if media else None
        conn.execute('''INSERT INTO activity_log (user_id, activity_type, task_text, xp_earned, extra_data, task_id)
                        VALUES (?, 'task_completed', ?, ?, ?, ?)''', (user_id, task['text'], r['xp_earned'], extra_data, task_id))

        # Delete Google Calendar event on completion
        if GOOGLE_CALENDAR_ENABLED and task['google_event_id']:
            try:
                service, cal_id = _gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import delete_calendar_event
                    delete_calendar_event(service, cal_id, task['google_event_id'])
            except Exception:
                logger.error('Failed to delete calendar event on task completion', exc_info=True)
            # Record so sync won't recreate this event
            conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                         (user_id, task['google_event_id']))

        completed_at = datetime.utcnow().isoformat()
        conn.execute('UPDATE tasks SET completed_at = ? WHERE id = ?', (completed_at, task_id))

        # Replenish recurrence window: if this task belongs to a recurring source, top up instances
        # Skip for GCal-sourced tasks — GCal manages their recurrence
        source_id = task['recurrence_source_id'] if task['recurrence_source_id'] else (task_id if task['recurrence_rule'] else None)
        if source_id:
            source = conn.execute('SELECT id, text, xp_reward, scheduled_start, scheduled_end, recurrence_rule, is_gcal_sourced FROM tasks WHERE id = ? AND user_id = ?',
                                  (source_id, user_id)).fetchone()
            if source and source['recurrence_rule'] and source['is_gcal_sourced'] != '1':
                _generate_recurrence_instances(conn, user_id, source['id'], source['text'], source['xp_reward'],
                                               source['scheduled_start'], source['scheduled_end'], source['recurrence_rule'])

        conn.commit()

    return JSONResponse({
        'success': True, 'xpEarned': r['xp_earned'], 'level': r['level'], 'xp': r['xp'], 'xpMax': r['xp_max'],
        'completed': r['completed'], 'streak': r['streak'], 'combo': r['combo'],
        'leveledUp': r['leveled_up'], 'newAchievements': r['new_achievements'],
        'completed_at': completed_at
    })

@app.post('/api/tasks/{task_id}/uncomplete')
async def api_uncomplete_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
        if not task:
            return error_response('Task not found', 404)
        if not task['completed_at']:
            return error_response('Task is not completed', 400)

        # Find XP earned from activity_log for this task completion
        log_entry = conn.execute(
            '''SELECT id, xp_earned FROM activity_log
               WHERE user_id = ? AND activity_type = 'task_completed' AND task_id = ?
               ORDER BY created_at DESC LIMIT 1''',
            (user_id, task_id)).fetchone()
        xp_to_remove = log_entry['xp_earned'] if log_entry else task['xp_reward']

        # Remove the activity log entry
        if log_entry:
            conn.execute('DELETE FROM activity_log WHERE id = ?', (log_entry['id'],))

        # Reverse XP and completed count
        progress = get_or_create_progress(conn, user_id)
        new_completed = max(0, progress['completed_tasks'] - 1)
        new_xp = progress['xp'] - xp_to_remove
        new_level = progress['level']
        new_xp_max = progress['xp_max']

        # Handle level down if XP goes negative
        while new_xp < 0 and new_level > 1:
            new_level -= 1
            new_xp_max = int(100 * math.pow(1.2, new_level - 1))
            new_xp += new_xp_max
        new_xp = max(0, new_xp)
        if new_level <= 1:
            new_xp_max = 100

        conn.execute('''UPDATE user_progress SET level=?, xp=?, xp_max=?, completed_tasks=? WHERE user_id=?''',
                     (new_level, new_xp, new_xp_max, new_completed, user_id))

        conn.execute('UPDATE tasks SET completed_at = NULL WHERE id = ?', (task_id,))

        # Recreate Google Calendar event after uncomplete
        if GOOGLE_CALENDAR_ENABLED and task['scheduled_start'] and task['scheduled_end']:
            try:
                service, cal_id = _gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import create_calendar_event
                    new_event_id = create_calendar_event(service, cal_id, task['text'],
                                                         task['scheduled_start'], task['scheduled_end'],
                                                         task['recurrence_rule'])
                    if new_event_id:
                        conn.execute('UPDATE tasks SET google_event_id = ? WHERE id = ?', (new_event_id, task_id))
                    # Remove from deleted events so sync won't skip it
                    if task['google_event_id']:
                        conn.execute('DELETE FROM gcal_deleted_events WHERE user_id = ? AND google_event_id = ?',
                                     (user_id, task['google_event_id']))
            except Exception:
                logger.error('Failed to recreate calendar event on task uncomplete', exc_info=True)

        conn.commit()

        progress = get_or_create_progress(conn, user_id)
    return JSONResponse({
        'success': True, 'completed': progress['completed_tasks'],
        'level': progress['level'], 'xp': progress['xp'], 'xpMax': progress['xp_max']
    })

@app.get('/api/history')
async def api_history(user_id: int = Depends(get_authenticated_user), limit: int = 100, offset: int = 0):
    with get_db() as conn:
        rows = conn.execute('''SELECT activity_type, task_text, xp_earned, created_at
                               FROM activity_log WHERE user_id = ?
                               ORDER BY created_at DESC LIMIT ? OFFSET ?''',
                            (user_id, limit, offset)).fetchall()
        return JSONResponse({'history': [
            {'type': r['activity_type'], 'text': r['task_text'],
             'points': r['xp_earned'], 'timestamp': r['created_at']}
            for r in rows
        ]})

@app.post('/api/combo/reset')
async def api_reset_combo(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        conn.execute('UPDATE user_progress SET combo = 0 WHERE user_id = ?', (user_id,))
        conn.commit()
    return JSONResponse({'success': True})

# ============== Telegram Bot API (Token-based) ==============

@app.get('/api/bot/tasks')
async def bot_get_tasks(user_id: int = Depends(get_token_authenticated_user)):
    with get_db() as conn:
        tasks = conn.execute(
            'SELECT id, text, xp_reward, completed_at, parent_id FROM tasks WHERE user_id = ? ORDER BY created_at DESC',
            (user_id,)
        ).fetchall()
        return JSONResponse({
            'success': True,
            'tasks': [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward'],
                        'completed_at': t['completed_at'], 'parent_id': t['parent_id']} for t in tasks]
        })

@app.post('/api/bot/tasks/add')
async def bot_add_task(request: Request, user_id: int = Depends(get_token_authenticated_user)):
    data = await _parse_json(request)
    text, err = _validate_task_text(data)
    if err: return err

    task_id, xp = _new_task_id()
    now_iso = datetime.utcnow().isoformat()
    scheduled_start = data.get('scheduled_start') or now_iso
    scheduled_end = data.get('scheduled_end') or now_iso

    with get_db() as conn:
        conn.execute('INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end) VALUES (?, ?, ?, ?, ?, ?)',
                     (task_id, user_id, text, xp, scheduled_start, scheduled_end))
        progress = get_or_create_progress(conn, user_id)
        new_xp, new_level, new_xp_max, leveled_up = apply_xp(progress, 3)
        conn.execute('UPDATE user_progress SET xp=?, level=?, xp_max=? WHERE user_id=?',
                     (new_xp, new_level, new_xp_max, user_id))

        # Sync to Google Calendar
        if GOOGLE_CALENDAR_ENABLED:
            try:
                service, cal_id = _gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import create_calendar_event
                    google_event_id = create_calendar_event(service, cal_id, text, scheduled_start, scheduled_end, None)
                    if google_event_id:
                        conn.execute('UPDATE tasks SET google_event_id = ? WHERE id = ?', (google_event_id, task_id))
            except Exception:
                logger.error('Failed to sync bot task to Google Calendar', exc_info=True)

        conn.commit()

    return JSONResponse({
        'success': True,
        'task': {'id': task_id, 'text': text, 'xp': xp},
        'xpEarned': 3, 'level': new_level, 'leveledUp': leveled_up
    })

@app.post('/api/bot/tasks/{task_id}/complete')
async def bot_complete_task(task_id: str, request: Request, user_id: int = Depends(get_token_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
        if not task:
            return JSONResponse({'success': False, 'error': 'Task not found'}, status_code=404)
        if task['completed_at']:
            return JSONResponse({'success': False, 'error': 'Task already completed'}, status_code=400)

        r = _complete_task_logic(conn, user_id, task)

        # Delete Google Calendar event on completion
        if GOOGLE_CALENDAR_ENABLED and task['google_event_id']:
            try:
                service, cal_id = _gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import delete_calendar_event
                    delete_calendar_event(service, cal_id, task['google_event_id'])
            except Exception:
                logger.error('Failed to delete calendar event on bot task completion', exc_info=True)
            conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                         (user_id, task['google_event_id']))

        completed_at = datetime.utcnow().isoformat()
        conn.execute('UPDATE tasks SET completed_at = ? WHERE id = ?', (completed_at, task_id))
        conn.commit()

    return JSONResponse({
        'success': True, 'xpEarned': r['xp_earned'], 'level': r['level'], 'leveledUp': r['leveled_up']
    })

@app.post('/api/bot/tasks/{task_id}/delete')
async def bot_delete_task(task_id: str, user_id: int = Depends(get_token_authenticated_user)):
    with get_db() as conn:
        # Sync to Google Calendar before deleting
        if GOOGLE_CALENDAR_ENABLED:
            task = conn.execute('SELECT google_event_id FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
            if task and task['google_event_id']:
                try:
                    service, cal_id = _gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import delete_calendar_event
                        delete_calendar_event(service, cal_id, task['google_event_id'])
                except Exception:
                    logger.error('Failed to sync bot task deletion to Google Calendar', exc_info=True)
                conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                             (user_id, task['google_event_id']))

            # Record gcal event IDs from recurrence instances being cascade-deleted
            for inst in conn.execute(
                'SELECT google_event_id FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND google_event_id IS NOT NULL',
                (task_id, user_id)
            ).fetchall():
                conn.execute('INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                             (user_id, inst['google_event_id']))

        # Delete recurrence instances, subtasks, then the task itself
        conn.execute('DELETE FROM tasks WHERE recurrence_source_id = ? AND user_id = ?', (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE parent_id = ? AND user_id = ?', (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id))
        conn.commit()

    return JSONResponse({'success': True})

@app.post('/api/bot/tasks/{task_id}/rename')
async def bot_rename_task(task_id: str, request: Request, user_id: int = Depends(get_token_authenticated_user)):
    data = await _parse_json(request)
    text, err = _validate_task_text(data)
    if err: return err

    with get_db() as conn:
        conn.execute('UPDATE tasks SET text = ? WHERE id = ? AND user_id = ?', (text, task_id, user_id))

        # Sync rename to Google Calendar
        if GOOGLE_CALENDAR_ENABLED:
            task = conn.execute('SELECT google_event_id, scheduled_start, scheduled_end, recurrence_rule FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
            if task and task['google_event_id']:
                try:
                    service, cal_id = _gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import update_calendar_event
                        update_calendar_event(service, cal_id, task['google_event_id'], text, task['scheduled_start'], task['scheduled_end'], task['recurrence_rule'])
                except Exception:
                    logger.error('Failed to sync bot task rename to Google Calendar', exc_info=True)

        conn.commit()

    return JSONResponse({'success': True})

# ============== Media API ==============

@app.post('/api/tasks/{task_id}/media')
async def api_upload_media(task_id: str, file: UploadFile = File(...), user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT id FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
        if not task:
            return error_response('Task not found', 404)

        if not file.filename:
            return error_response('No file selected')

        ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''
        if ext not in ALLOWED_EXTENSIONS:
            return error_response('Invalid format')

        media_type = 'video' if ext in {'mp4', 'webm', 'mov'} else 'image'
        filename = f"{task_id}_{uuid.uuid4().hex[:8]}.{ext}"
        filepath = os.path.join(UPLOAD_FOLDER, filename)

        # Delete old file if exists
        old_media = conn.execute('SELECT filename FROM task_media WHERE task_id = ?', (task_id,)).fetchone()
        if old_media:
            old_path = os.path.join(UPLOAD_FOLDER, old_media['filename'])
            if os.path.exists(old_path):
                os.remove(old_path)
            conn.execute('DELETE FROM task_media WHERE task_id = ?', (task_id,))

        contents = await file.read()
        try:
            with open(filepath, 'wb') as f:
                f.write(contents)
        except IOError:
            logger.error('Failed to write uploaded file: %s', filepath, exc_info=True)
            return error_response('Failed to save file', 500)

        conn.execute('INSERT INTO task_media (task_id, user_id, media_type, filename) VALUES (?, ?, ?, ?)',
                     (task_id, user_id, media_type, filename))
        conn.commit()

    return JSONResponse({'success': True, 'media_type': media_type, 'url': f'/UPLOADS/{filename}'})

@app.delete('/api/tasks/{task_id}/media')
async def api_delete_media(task_id: str, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        media = conn.execute('SELECT filename FROM task_media WHERE task_id = ? AND user_id = ?',
                             (task_id, user_id)).fetchone()
        if not media:
            return error_response('Media not found', 404)

        filepath = os.path.join(UPLOAD_FOLDER, media['filename'])
        if os.path.exists(filepath):
            os.remove(filepath)

        conn.execute('DELETE FROM task_media WHERE task_id = ?', (task_id,))
        conn.commit()
    return JSONResponse({'success': True})

@app.get('/UPLOADS/{filename}')
async def serve_upload(filename: str):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.realpath(filepath).startswith(os.path.realpath(UPLOAD_FOLDER)):
        raise HTTPException(status_code=403)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404)
    return FileResponse(filepath)

# ============== Friends API ==============

@app.get('/api/users/search')
async def api_search_users(request: Request, user_id: int = Depends(get_authenticated_user)):
    query = request.query_params.get('q', '').strip()
    if len(query) < 2:
        return JSONResponse({'users': []})

    with get_db() as conn:
        params = [f'%{query}%', user_id]
        id_condition = ''
        if query.isdigit():
            id_condition = 'OR u.id = ?'
            params.insert(1, int(query))

        users = conn.execute(f'''
            SELECT u.id, u.username, COALESCE(p.level, 1) as level
            FROM users u
            LEFT JOIN user_progress p ON u.id = p.user_id
            WHERE (u.username LIKE ? {id_condition}) AND u.id != ?
            LIMIT 20
        ''', params).fetchall()

        result = []
        for u in users:
            friendship = conn.execute('''
                SELECT status, user_id FROM friendships
                WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
            ''', (user_id, u['id'], u['id'], user_id)).fetchone()

            status = None
            if friendship:
                if friendship['status'] == 'accepted':
                    status = 'friends'
                elif friendship['user_id'] == user_id:
                    status = 'pending_sent'
                else:
                    status = 'pending_received'

            result.append({
                'id': u['id'],
                'username': u['username'],
                'level': u['level'],
                'avatar_letter': u['username'][0].upper(),
                'friendship_status': status
            })

        return JSONResponse({'users': result})

@app.get('/api/friends')
async def api_get_friends(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        incoming = conn.execute('''
            SELECT f.id, f.user_id, u.username, COALESCE(p.level, 1) as level, f.created_at
            FROM friendships f
            JOIN users u ON f.user_id = u.id
            LEFT JOIN user_progress p ON u.id = p.user_id
            WHERE f.friend_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
        ''', (user_id,)).fetchall()

        outgoing = conn.execute('''
            SELECT f.id, f.friend_id as user_id, u.username, COALESCE(p.level, 1) as level, f.created_at
            FROM friendships f
            JOIN users u ON f.friend_id = u.id
            LEFT JOIN user_progress p ON u.id = p.user_id
            WHERE f.user_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
        ''', (user_id,)).fetchall()

        friends = conn.execute('''
            SELECT u.id, u.username, COALESCE(p.level, 1) as level
            FROM friendships f
            JOIN users u ON (CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END) = u.id
            LEFT JOIN user_progress p ON u.id = p.user_id
            WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
        ''', (user_id, user_id, user_id)).fetchall()

        return JSONResponse({
            'incoming': [{'id': r['id'], 'user_id': r['user_id'], 'username': r['username'],
                          'level': r['level'], 'avatar_letter': r['username'][0].upper(),
                          'created_at': r['created_at']} for r in incoming],
            'outgoing': [{'id': r['id'], 'user_id': r['user_id'], 'username': r['username'],
                          'level': r['level'], 'avatar_letter': r['username'][0].upper(),
                          'created_at': r['created_at']} for r in outgoing],
            'friends': [{'id': r['id'], 'username': r['username'], 'level': r['level'],
                         'avatar_letter': r['username'][0].upper()} for r in friends]
        })

@app.post('/api/friends/request')
async def api_send_friend_request(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    friend_id = data.get('user_id')

    if not friend_id or friend_id == user_id:
        return error_response('Invalid request')

    with get_db() as conn:
        friend = conn.execute('SELECT id FROM users WHERE id = ?', (friend_id,)).fetchone()
        if not friend:
            return error_response('User not found', 404)

        existing = conn.execute('''
            SELECT status FROM friendships
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        ''', (user_id, friend_id, friend_id, user_id)).fetchone()

        if existing:
            if existing['status'] == 'accepted':
                return error_response('Already friends')
            return error_response('Request already exists')

        conn.execute('INSERT INTO friendships (user_id, friend_id) VALUES (?, ?)', (user_id, friend_id))
        conn.commit()
    return JSONResponse({'success': True, 'message': 'Request sent'})

@app.post('/api/friends/respond')
async def api_respond_friend_request(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    request_id = data.get('request_id')
    action = data.get('action')

    if action not in ('accept', 'reject'):
        return error_response('Invalid action')

    with get_db() as conn:
        request_row = conn.execute('''
            SELECT * FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'
        ''', (request_id, user_id)).fetchone()

        if not request_row:
            return error_response('Request not found', 404)

        new_status = 'accepted' if action == 'accept' else 'rejected'
        conn.execute('UPDATE friendships SET status = ? WHERE id = ?', (new_status, request_id))
        conn.commit()

    message = 'Request accepted' if action == 'accept' else 'Request declined'
    return JSONResponse({'success': True, 'message': message})

@app.delete('/api/friends/request/{request_id}')
async def api_cancel_friend_request(request_id: int, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        result = conn.execute('''
            DELETE FROM friendships WHERE id = ? AND user_id = ? AND status = 'pending'
        ''', (request_id, user_id))
        conn.commit()

        if result.rowcount == 0:
            return error_response('Request not found', 404)
    return JSONResponse({'success': True})

@app.delete('/api/friends/{friend_id}')
async def api_remove_friend(friend_id: int, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        result = conn.execute('''
            DELETE FROM friendships
            WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))
            AND status = 'accepted'
        ''', (user_id, friend_id, friend_id, user_id))
        conn.commit()

        if result.rowcount == 0:
            return error_response('User is not a friend', 404)
    return JSONResponse({'success': True})

@app.get('/api/friends/feed')
async def api_friends_feed(request: Request, user_id: int = Depends(get_authenticated_user)):
    limit = min(int(request.query_params.get('limit', '20')), 50)
    offset = int(request.query_params.get('offset', '0'))

    with get_db() as conn:
        friend_ids = conn.execute('''
            SELECT CASE WHEN user_id = ? THEN friend_id ELSE user_id END as fid
            FROM friendships
            WHERE (user_id = ? OR friend_id = ?) AND status = 'accepted'
        ''', (user_id, user_id, user_id)).fetchall()

        if not friend_ids:
            return JSONResponse({'feed': [], 'has_more': False})

        ids = [f['fid'] for f in friend_ids]
        placeholders = ','.join('?' * len(ids))

        feed = conn.execute(f'''
            SELECT a.*, u.username
            FROM activity_log a
            JOIN users u ON a.user_id = u.id
            WHERE a.user_id IN ({placeholders})
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?
        ''', ids + [limit + 1, offset]).fetchall()

        has_more = len(feed) > limit
        feed = feed[:limit]

        result = []
        for f in feed:
            item = {
                'id': f['id'], 'user_id': f['user_id'], 'username': f['username'],
                'avatar_letter': f['username'][0].upper(), 'activity_type': f['activity_type'],
                'task_text': f['task_text'], 'xp_earned': f['xp_earned'], 'created_at': f['created_at']
            }
            if f['extra_data']:
                extra = json.loads(f['extra_data'])
                item['media_type'] = extra.get('media_type')
                item['media_url'] = extra.get('media_url')
            result.append(item)

        return JSONResponse({'feed': result, 'has_more': has_more})

# ============== Google Calendar OAuth ==============

# In-memory store for PKCE code verifiers (session cookies too small)
_pkce_verifiers = {}

def _google_client_config():
    return {'web': {
        'client_id': GOOGLE_CLIENT_ID,
        'client_secret': GOOGLE_CLIENT_SECRET,
        'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
        'token_uri': 'https://oauth2.googleapis.com/token',
        'redirect_uris': [GOOGLE_REDIRECT_URI],
    }}

@app.get('/auth/google/connect')
async def google_connect(request: Request, user_id: int = Depends(get_authenticated_user)):
    if not GOOGLE_CALENDAR_ENABLED:
        return error_response('Google Calendar integration is not configured', 400)
    from google_auth_oauthlib.flow import Flow
    flow = Flow.from_client_config(
        _google_client_config(),
        scopes=['https://www.googleapis.com/auth/calendar'],
        redirect_uri=GOOGLE_REDIRECT_URI,
    )
    auth_url, state = flow.authorization_url(
        access_type='offline',
        prompt='consent',
        state=str(user_id),
    )
    # Save code_verifier in memory for PKCE (cookie too small for 128-char verifier)
    _pkce_verifiers[user_id] = flow.code_verifier
    return RedirectResponse(auth_url)

@app.get('/auth/google/callback')
async def google_callback(request: Request):
    if not GOOGLE_CALENDAR_ENABLED:
        return error_response('Google Calendar integration is not configured', 400)
    code = request.query_params.get('code')
    user_id_str = request.query_params.get('state')
    if not code or not user_id_str:
        return error_response('Invalid callback parameters', 400)
    try:
        user_id = int(user_id_str)
    except ValueError:
        return error_response('Invalid state parameter', 400)

    from google_auth_oauthlib.flow import Flow
    flow = Flow.from_client_config(
        _google_client_config(),
        scopes=['https://www.googleapis.com/auth/calendar'],
        redirect_uri=GOOGLE_REDIRECT_URI,
    )
    # Restore code_verifier from memory for PKCE
    flow.code_verifier = _pkce_verifiers.pop(user_id, None)
    flow.fetch_token(code=code)
    creds = flow.credentials

    with get_db() as conn:
        conn.execute('''
            INSERT INTO google_tokens (user_id, access_token, refresh_token, token_expiry)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                access_token = excluded.access_token,
                refresh_token = excluded.refresh_token,
                token_expiry = excluded.token_expiry
        ''', (user_id, creds.token, creds.refresh_token,
              creds.expiry.isoformat() if creds.expiry else None))
        conn.commit()

    return RedirectResponse('/')

@app.post('/api/google/disconnect')
async def google_disconnect(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        row = conn.execute(
            'SELECT watch_channel_id, watch_resource_id FROM google_tokens WHERE user_id = ?', (user_id,)
        ).fetchone()
        # Stop watch channel if active
        if row and row['watch_channel_id'] and row['watch_resource_id']:
            try:
                from BACKEND.google_calendar import get_google_credentials, get_calendar_service, stop_watch
                creds = get_google_credentials(conn, user_id, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
                if creds:
                    service = get_calendar_service(creds)
                    stop_watch(service, row['watch_channel_id'], row['watch_resource_id'])
            except Exception:
                logger.error('Failed to stop watch on disconnect for user %d', user_id, exc_info=True)
        conn.execute('DELETE FROM google_tokens WHERE user_id = ?', (user_id,))
        conn.execute('UPDATE tasks SET google_event_id = NULL WHERE user_id = ?', (user_id,))
        conn.commit()
    return JSONResponse({'success': True})

@app.get('/api/google/status')
async def google_status(user_id: int = Depends(get_authenticated_user)):
    if not GOOGLE_CALENDAR_ENABLED:
        return JSONResponse({'connected': False, 'available': False})
    with get_db() as conn:
        row = conn.execute('SELECT user_id FROM google_tokens WHERE user_id = ?', (user_id,)).fetchone()
        if not row:
            return JSONResponse({'connected': False, 'available': True})
        # Validate that the stored token is still usable
        try:
            from BACKEND.google_calendar import get_google_credentials
            creds = get_google_credentials(conn, user_id, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
            if not creds or not creds.valid:
                raise Exception('invalid credentials')
        except Exception:
            conn.execute('DELETE FROM google_tokens WHERE user_id = ?', (user_id,))
            conn.commit()
            logger.warning('Removed expired Google tokens for user %s', user_id)
            return JSONResponse({'connected': False, 'available': True})
    return JSONResponse({'connected': True, 'available': True})


# ============== Webhook ==============

@app.post("/webhook")
async def webhook(request: Request):
    body = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not WEBHOOK_SECRET or not hmac.compare_digest(
        f"sha256={hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()}", sig):
        return Response(content="Forbidden", status_code=403)

    if request.headers.get("X-GitHub-Event") != "push":
        return Response(content="OK", status_code=200)

    payload = json.loads(body) if body else {}
    if payload.get("ref") != f"refs/heads/{BRANCH}":
        return Response(content="Ignored", status_code=200)

    logger.info("Webhook received - starting update...")

    # Get current commit hash before update
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd="/app", capture_output=True, text=True)
    old_commit = result.stdout.strip() if result.returncode == 0 else None

    # Git update
    for cmd in [["git", "fetch", "origin"], ["git", "reset", "--hard", f"origin/{BRANCH}"]]:
        result = subprocess.run(cmd, cwd="/app", capture_output=True, text=True)
        if result.returncode != 0:
            logger.error(f"{cmd[1]} failed: {result.stderr}")
            return Response(content=f"Git {cmd[1]} failed", status_code=500)

    # Get new commit hash after update
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd="/app", capture_output=True, text=True)
    new_commit = result.stdout.strip() if result.returncode == 0 else None

    if old_commit == new_commit:
        logger.info("No changes detected - skipping update")
        return Response(content="OK (no changes)", status_code=200)

    logger.info(f"Code updated: {old_commit[:7] if old_commit else 'unknown'} -> {new_commit[:7] if new_commit else 'unknown'}")

    # Check if requirements.txt changed
    result = subprocess.run(
        ["git", "diff", "--name-only", old_commit, new_commit] if old_commit else ["git", "diff", "--name-only", "HEAD~1", "HEAD"],
        cwd="/app", capture_output=True, text=True
    )
    changed_files = result.stdout.strip().split('\n') if result.stdout.strip() else []
    requirements_changed = 'requirements.txt' in changed_files
    bot_code_changed = any(f.startswith('BACKEND/TELEGRAM/') for f in changed_files)

    if requirements_changed:
        logger.info("requirements.txt changed - updating dependencies...")
        pip_cmd = ["pip", "install", "--no-cache-dir", "-r", "requirements.txt"]
        result = subprocess.run(pip_cmd, cwd="/app", capture_output=True, text=True)
        if result.returncode != 0:
            logger.error(f"Pip install failed: {result.stderr}")
        else:
            logger.info("Dependencies updated")
    else:
        logger.info("requirements.txt unchanged - skipping pip install")

    # Restart Telegram bot container only if bot code changed
    if bot_code_changed:
        logger.info("Telegram bot code changed - restarting...")
        try:
            env = os.environ.copy()
            env['DOCKER_API_VERSION'] = '1.44'
            result = subprocess.run(
                ["docker", "restart", "todo-telegram-bot"],
                capture_output=True, text=True, timeout=30, env=env
            )
            if result.returncode == 0:
                logger.info("Telegram bot container restarted")
            else:
                logger.warning(f"Docker restart failed: {result.stderr}")
        except FileNotFoundError:
            logger.warning("Docker CLI not available - bot will update on next manual restart")
        except subprocess.TimeoutExpired:
            logger.warning("Docker restart timeout")
        except Exception as e:
            logger.warning(f"Could not restart bot container: {e}")
    else:
        logger.info("Telegram bot code unchanged - skipping restart")

    # Send SIGTERM to self - Docker restart policy will restart the container
    logger.info("Sending SIGTERM for graceful shutdown...")
    graceful_reload()

    return Response(content="OK", status_code=200)

def graceful_reload():
    """Graceful shutdown - Docker restart: unless-stopped will restart the container"""
    import signal
    subprocess.Popen(
        ["python", "-c", f"import os, signal, time; time.sleep(0.5); os.kill({os.getpid()}, signal.SIGTERM)"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

# ============== Google Calendar Push Notifications ==============

@app.post("/api/google/webhook")
async def google_calendar_webhook(request: Request):
    """Receive push notifications from Google Calendar.
    Google sends a POST when events change on a watched calendar."""
    if INSTANCE_ROLE != 'primary':
        return Response(status_code=200)
    channel_id = request.headers.get("X-Goog-Channel-ID", "")
    resource_state = request.headers.get("X-Goog-Resource-State", "")

    # Ignore the initial sync message sent on channel creation
    if resource_state == "sync":
        return Response(status_code=200)

    if not channel_id:
        return Response(status_code=400)

    # Find user by channel_id
    with get_db() as conn:
        row = conn.execute(
            'SELECT user_id, sync_token, calendar_id FROM google_tokens WHERE watch_channel_id = ?',
            (channel_id,)
        ).fetchone()

    if not row:
        return Response(status_code=404)

    # Trigger incremental sync for this user
    logger.info('Calendar push notification for user %d (state: %s)', row['user_id'], resource_state)
    asyncio.create_task(_do_calendar_sync_for_user(
        row['user_id'], row['sync_token'], row['calendar_id'] or 'primary'
    ))
    return Response(status_code=200)


def _process_sync_events(conn, user_id, events):
    """Shared logic for processing Google Calendar sync events."""
    from BACKEND.google_calendar import parse_event_times, strip_prefix

    for event in events:
        event_id = event.get('id')
        summary = event.get('summary', '')
        status = event.get('status')

        existing_task = conn.execute(
            'SELECT id, text FROM tasks WHERE google_event_id = ? AND user_id = ?',
            (event_id, user_id)
        ).fetchone()

        if status == 'cancelled':
            if existing_task:
                conn.execute('DELETE FROM tasks WHERE id = ?', (existing_task['id'],))
                conn.commit()
            continue

        start_iso, end_iso = parse_event_times(event)
        text = strip_prefix(summary)
        if not text:
            continue

        # Skip events beyond 30-day horizon
        if start_iso and not existing_task:
            horizon = (datetime.utcnow() + timedelta(days=30)).isoformat() + 'Z'
            if start_iso > horizon:
                continue

        if existing_task:
            conn.execute(
                'UPDATE tasks SET text = ?, scheduled_start = ?, scheduled_end = ? WHERE id = ?',
                (text, start_iso, end_iso, existing_task['id'])
            )
            conn.commit()
        elif start_iso and end_iso:
            # Skip events we intentionally deleted/completed
            was_deleted = conn.execute(
                'SELECT 1 FROM gcal_deleted_events WHERE user_id=? AND google_event_id=?',
                (user_id, event_id)
            ).fetchone()
            if was_deleted:
                continue

            task_id, xp = _new_task_id()
            conn.execute(
                'INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end, google_event_id, is_gcal_sourced) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (task_id, user_id, text, xp, start_iso, end_iso, event_id, '1')
            )
            conn.commit()


async def _do_calendar_sync_for_user(user_id, sync_token, calendar_id):
    """Run incremental sync for a single user (triggered by push notification)."""
    from BACKEND.google_calendar import (
        get_google_credentials, get_calendar_service, sync_calendar_events
    )
    try:
        with get_db() as conn:
            creds = get_google_credentials(conn, user_id, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
            if not creds:
                return

        service = await asyncio.to_thread(get_calendar_service, creds)
        effective_token = None if INSTANCE_ROLE != 'primary' else sync_token
        events, new_token, is_full = await asyncio.to_thread(
            sync_calendar_events, service, calendar_id, effective_token
        )

        if not events and not new_token:
            return

        with get_db() as conn:
            _process_sync_events(conn, user_id, events)

            if new_token and INSTANCE_ROLE == 'primary':
                conn.execute(
                    'UPDATE google_tokens SET sync_token = ?, last_sync_at = ? WHERE user_id = ?',
                    (new_token, datetime.now().isoformat(), user_id)
                )
                conn.commit()

    except Exception:
        logger.error('Calendar push sync failed for user %d', user_id, exc_info=True)


# ============== Google Calendar Background Sync ==============

async def _calendar_sync_loop():
    """Periodically manage watch channels and poll as fallback."""
    if not GOOGLE_CALENDAR_ENABLED:
        return
    is_primary = INSTANCE_ROLE == 'primary'
    webhook_url = (APP_URL.rstrip('/') + '/api/google/webhook') if APP_URL and is_primary else ''
    use_push = bool(webhook_url)
    # With push: long interval as fallback; without push: short polling
    interval = 300 if use_push else GOOGLE_CALENDAR_SYNC_INTERVAL
    logger.warning('Calendar sync: role=%s, push=%s, interval=%ds', INSTANCE_ROLE, use_push, interval)
    while True:
        try:
            await _do_calendar_sync(webhook_url if use_push else '')
        except Exception:
            logger.error('Calendar sync loop error', exc_info=True)
        await asyncio.sleep(interval)

async def _do_calendar_sync(webhook_url=''):
    """Run one round of sync and ensure watch channels are active."""
    from BACKEND.google_calendar import (
        get_google_credentials, get_calendar_service, sync_calendar_events,
        watch_calendar, stop_watch
    )

    with get_db() as conn:
        users = conn.execute(
            'SELECT user_id, sync_token, calendar_id, watch_channel_id, watch_resource_id, watch_expiration FROM google_tokens'
        ).fetchall()

    now_ms = int(datetime.now().timestamp() * 1000)

    for user_row in users:
        user_id = user_row['user_id']
        sync_token = user_row['sync_token']
        calendar_id = user_row['calendar_id'] or 'primary'

        try:
            with get_db() as conn:
                creds = get_google_credentials(conn, user_id, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
                if not creds:
                    continue

            service = await asyncio.to_thread(get_calendar_service, creds)

            # Register or renew watch channel if push is enabled (primary only)
            if webhook_url and INSTANCE_ROLE == 'primary':
                watch_exp = int(user_row['watch_expiration'] or 0)
                # Renew if no channel or expiring within 1 hour
                if not user_row['watch_channel_id'] or watch_exp - now_ms < 3600_000:
                    # Stop old channel if exists
                    if user_row['watch_channel_id'] and user_row['watch_resource_id']:
                        await asyncio.to_thread(
                            stop_watch, service, user_row['watch_channel_id'], user_row['watch_resource_id']
                        )
                    result = await asyncio.to_thread(watch_calendar, service, calendar_id, webhook_url)
                    if result:
                        ch_id, res_id, exp_ms = result
                        with get_db() as conn:
                            conn.execute(
                                'UPDATE google_tokens SET watch_channel_id=?, watch_resource_id=?, watch_expiration=? WHERE user_id=?',
                                (ch_id, res_id, str(exp_ms), user_id)
                            )
                            conn.commit()
                        logger.info('Registered calendar watch for user %d (expires %s)',
                                    user_id, datetime.fromtimestamp(exp_ms / 1000).isoformat())

            # Replica always does full sync; primary uses incremental sync
            effective_token = None if INSTANCE_ROLE != 'primary' else sync_token
            events, new_token, _ = await asyncio.to_thread(
                sync_calendar_events, service, calendar_id, effective_token
            )

            if not events and not new_token:
                continue

            with get_db() as conn:
                _process_sync_events(conn, user_id, events)

                # Periodic cleanup: remove old gcal_deleted_events (>90 days)
                conn.execute(
                    "DELETE FROM gcal_deleted_events WHERE deleted_at < datetime('now', '-90 days')"
                )
                conn.commit()

                if new_token and INSTANCE_ROLE == 'primary':
                    conn.execute(
                        'UPDATE google_tokens SET sync_token = ?, last_sync_at = ? WHERE user_id = ?',
                        (new_token, datetime.now().isoformat(), user_id)
                    )
                    conn.commit()

        except Exception as e:
            from google.auth.exceptions import RefreshError
            if isinstance(e, RefreshError) or 'invalid_grant' in str(e):
                logger.warning('Expired Google token for user %d, removing credentials', user_id)
                with get_db() as conn:
                    conn.execute('DELETE FROM google_tokens WHERE user_id = ?', (user_id,))
                    conn.commit()
            else:
                logger.error('Calendar sync failed for user %d', user_id, exc_info=True)

@app.on_event('startup')
async def start_calendar_sync():
    logger.warning('Calendar startup: enabled=%s, role=%s, APP_URL=%s, CLIENT_ID=%s',
                   GOOGLE_CALENDAR_ENABLED, INSTANCE_ROLE, APP_URL, bool(GOOGLE_CLIENT_ID))
    asyncio.create_task(_calendar_sync_loop())

# ============== Init ==============

init_db()

# Template globals
templates.env.globals['app_version'] = get_version()
templates.env.globals['drum_row_height'] = DRUM_ROW_HEIGHT
templates.env.globals['drum_max_top_angle'] = DRUM_MAX_TOP_ANGLE
templates.env.globals['drum_perspective_k'] = DRUM_PERSPECTIVE_K
templates.env.globals['drum_highlight_offset'] = DRUM_HIGHLIGHT_OFFSET
import time as _time
templates.env.globals['cache_bust'] = str(int(_time.time()))

# Static files (must be after all routes)
app.mount('/static', StaticFiles(directory='FRONTEND'), name='static')

if __name__ == '__main__':
    debug_mode = APP_DEBUG
    uvicorn.run(
        "run:app", host='127.0.0.1', port=PORT,
        reload=debug_mode, reload_includes=['*.py'] if debug_mode else None,
        proxy_headers=True, forwarded_allow_ips='*',
        ws_ping_interval=60, ws_ping_timeout=30
    )
