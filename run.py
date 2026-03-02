import os, math, uuid, random, hashlib, hmac, subprocess, sqlite3, logging, json
import warnings
from datetime import datetime, date
from typing import Optional
from contextlib import contextmanager

from fastapi import FastAPI, Request, Response, Form, UploadFile, File, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, RedirectResponse, HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from dotenv import load_dotenv
import bcrypt
from itsdangerous import URLSafeTimedSerializer
import uvicorn
from SETTINGS import APP_DEBUG, PORT, BRANCH as DEFAULT_BRANCH

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

# Media uploads configuration
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'DATA', 'UPLOADS')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mov'}

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

# ============== WebSocket Manager ==============

class ConnectionManager:
    def __init__(self):
        self.user_connections: dict[int, dict[str, WebSocket]] = {}

    async def connect(self, user_id: int, session_id: str, ws: WebSocket):
        await ws.accept()
        self.user_connections.setdefault(user_id, {})[session_id] = ws

    def disconnect(self, user_id: int, session_id: str):
        if user_id in self.user_connections:
            self.user_connections[user_id].pop(session_id, None)
            if not self.user_connections[user_id]:
                del self.user_connections[user_id]

    async def broadcast(self, user_id: int, event: str, data: dict, source_sid: Optional[str] = None):
        if user_id not in self.user_connections:
            return
        dead = []
        for sid, ws in list(self.user_connections[user_id].items()):
            if sid == source_sid:
                continue
            try:
                await ws.send_json({"event": event, "data": data})
            except Exception:
                dead.append(sid)
        for sid in dead:
            self.user_connections[user_id].pop(sid, None)

    async def broadcast_all(self, event: str, data: dict):
        dead_users = []
        for user_id in list(self.user_connections.keys()):
            dead = []
            for sid, ws in list(self.user_connections[user_id].items()):
                try:
                    await ws.send_json({"event": event, "data": data})
                except Exception:
                    dead.append(sid)
            for sid in dead:
                self.user_connections[user_id].pop(sid, None)
            if not self.user_connections[user_id]:
                dead_users.append(user_id)
        for user_id in dead_users:
            del self.user_connections[user_id]

manager = ConnectionManager()

async def send_user_event(user_id: int, event_type: str, data: dict, source_session_id: Optional[str] = None):
    await manager.broadcast(user_id, event_type, data, source_session_id)

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
                combo INTEGER DEFAULT 0, last_completion_date TEXT, sound_enabled INTEGER DEFAULT 0,
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
        pass
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
        return {'level': 1, 'xp': 0, 'xp_max': 100, 'completed_tasks': 0, 'current_streak': 0, 'combo': 0, 'sound_enabled': 0}
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
    try:
        data = await request.json()
    except Exception:
        data = {}
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
    try:
        data = await request.json()
    except Exception:
        data = {}
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
    try:
        data = await request.json()
    except Exception:
        data = {}
    token = data.get('token', '')

    with get_db() as conn:
        conn.execute('DELETE FROM api_tokens WHERE token = ?', (token,))
        conn.commit()

    return JSONResponse({'success': True})

# ============== API Routes ==============

@app.get('/api/state')
async def api_get_state(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        progress = get_or_create_progress(conn, user_id)
        media_map = {m['task_id']: {'type': m['media_type'], 'url': f"/UPLOADS/{m['filename']}"}
                     for m in conn.execute('SELECT task_id, media_type, filename FROM task_media WHERE user_id = ?', (user_id,))}
        tasks = [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward'], 'media': media_map.get(t['id'])}
                 for t in conn.execute('SELECT id, text, xp_reward FROM tasks WHERE user_id = ? ORDER BY created_at DESC', (user_id,))]
        achievements = {a['achievement_id']: True for a in conn.execute('SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,))}
        return JSONResponse({
            'tasks': tasks, 'level': progress['level'], 'xp': progress['xp'], 'xpMax': progress['xp_max'],
            'completed': progress['completed_tasks'], 'streak': progress['current_streak'],
            'combo': progress['combo'], 'achievements': achievements, 'sound': bool(progress['sound_enabled'])
        })

@app.put('/api/settings')
async def api_update_settings(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    with get_db() as conn:
        if 'sound' in data:
            conn.execute('UPDATE user_progress SET sound_enabled = ? WHERE user_id = ?', (1 if data['sound'] else 0, user_id))
            conn.commit()
    return JSONResponse({'success': True})

@app.post('/api/tasks')
async def api_create_task(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    if not data or not data.get('text', '').strip():
        return JSONResponse({'error': 'Task text is required'}, status_code=400)
    task_id = f"{int(datetime.now().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}"
    xp = random.randint(20, 35)

    with get_db() as conn:
        conn.execute('INSERT INTO tasks (id, user_id, text, xp_reward) VALUES (?, ?, ?, ?)',
                     (task_id, user_id, data['text'].strip(), xp))
        progress = get_or_create_progress(conn, user_id)
        new_xp, new_level, new_xp_max, leveled_up = apply_xp(progress, 3)
        conn.execute('UPDATE user_progress SET xp=?, level=?, xp_max=? WHERE user_id=?',
                     (new_xp, new_level, new_xp_max, user_id))
        conn.commit()

    await send_user_event(user_id, 'task_created', {
        'id': task_id, 'text': data['text'].strip(), 'xp': xp,
        'xpEarned': 3, 'level': new_level, 'currentXp': new_xp, 'xpMax': new_xp_max, 'leveledUp': leveled_up
    })

    return JSONResponse({
        'id': task_id, 'text': data['text'].strip(), 'xp': xp,
        'xpEarned': 3, 'level': new_level, 'currentXp': new_xp, 'xpMax': new_xp_max, 'leveledUp': leveled_up
    })

@app.put('/api/tasks/{task_id}')
async def api_update_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    if not data or not data.get('text', '').strip():
        return JSONResponse({'error': 'Task text is required'}, status_code=400)
    with get_db() as conn:
        conn.execute('UPDATE tasks SET text = ? WHERE id = ? AND user_id = ?', (data['text'].strip(), task_id, user_id))
        conn.commit()

    await send_user_event(user_id, 'task_updated', {'id': task_id, 'text': data['text'].strip()})
    return JSONResponse({'success': True})

@app.delete('/api/tasks/{task_id}')
async def api_delete_task(task_id: str, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id))
        conn.commit()

    await send_user_event(user_id, 'task_deleted', {'id': task_id})
    return JSONResponse({'success': True})

@app.post('/api/tasks/{task_id}/complete')
async def api_complete_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
        if not task:
            return JSONResponse({'error': 'Task not found'}, status_code=404)

        progress = get_or_create_progress(conn, user_id)
        try:
            data = await request.json()
        except Exception:
            data = {}
        client_combo = data.get('combo', 0)
        combo = client_combo + 1
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

        # Log activity for friends feed ONLY if task has media
        media = conn.execute('SELECT media_type, filename FROM task_media WHERE task_id = ?', (task_id,)).fetchone()
        if media:
            extra_data = json.dumps({'media_type': media['media_type'], 'media_url': f"/UPLOADS/{media['filename']}"})
            conn.execute('''INSERT INTO activity_log (user_id, activity_type, task_text, xp_earned, extra_data)
                            VALUES (?, 'task_completed', ?, ?, ?)''', (user_id, task['text'], xp_earned, extra_data))

        conn.execute('DELETE FROM tasks WHERE id = ?', (task_id,))
        conn.commit()

    await send_user_event(user_id, 'task_completed', {
        'id': task_id, 'xpEarned': xp_earned, 'level': new_level, 'xp': new_xp, 'xpMax': new_xp_max,
        'completed': new_completed, 'streak': new_streak, 'combo': combo,
        'leveledUp': leveled_up, 'newAchievements': new_achievements
    })

    return JSONResponse({
        'success': True, 'xpEarned': xp_earned, 'level': new_level, 'xp': new_xp, 'xpMax': new_xp_max,
        'completed': new_completed, 'streak': new_streak, 'combo': combo,
        'leveledUp': leveled_up, 'newAchievements': new_achievements
    })

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
            'SELECT id, text, xp_reward FROM tasks WHERE user_id = ? ORDER BY created_at DESC',
            (user_id,)
        ).fetchall()
        return JSONResponse({
            'success': True,
            'tasks': [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward']} for t in tasks]
        })

@app.post('/api/bot/tasks/add')
async def bot_add_task(request: Request, user_id: int = Depends(get_token_authenticated_user)):
    try:
        data = await request.json()
    except Exception:
        data = {}
    text = data.get('text', '').strip()

    if not text:
        return JSONResponse({'success': False, 'error': 'Task text required'}, status_code=400)

    task_id = f"{int(datetime.now().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}"
    xp = random.randint(20, 35)

    with get_db() as conn:
        conn.execute('INSERT INTO tasks (id, user_id, text, xp_reward) VALUES (?, ?, ?, ?)',
                     (task_id, user_id, text, xp))
        progress = get_or_create_progress(conn, user_id)
        new_xp, new_level, new_xp_max, leveled_up = apply_xp(progress, 3)
        conn.execute('UPDATE user_progress SET xp=?, level=?, xp_max=? WHERE user_id=?',
                     (new_xp, new_level, new_xp_max, user_id))
        conn.commit()

    await send_user_event(user_id, 'task_created', {
        'id': task_id, 'text': text, 'xp': xp,
        'xpEarned': 3, 'level': new_level, 'currentXp': new_xp, 'xpMax': new_xp_max, 'leveledUp': leveled_up
    })

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

        progress = get_or_create_progress(conn, user_id)
        combo = progress['combo'] + 1
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

        conn.execute('''UPDATE user_progress SET level=?, xp=?, xp_max=?, completed_tasks=?,
                        current_streak=?, combo=?, last_completion_date=? WHERE user_id=?''',
                     (new_level, new_xp, new_xp_max, new_completed, new_streak, combo, today, user_id))
        conn.execute('DELETE FROM tasks WHERE id = ?', (task_id,))
        conn.commit()

    await send_user_event(user_id, 'task_completed', {
        'id': task_id, 'xpEarned': xp_earned, 'level': new_level, 'xp': new_xp, 'xpMax': new_xp_max,
        'completed': new_completed, 'streak': new_streak, 'combo': combo,
        'leveledUp': leveled_up, 'newAchievements': []
    })

    return JSONResponse({
        'success': True, 'xpEarned': xp_earned, 'level': new_level, 'leveledUp': leveled_up
    })

@app.post('/api/bot/tasks/{task_id}/delete')
async def bot_delete_task(task_id: str, user_id: int = Depends(get_token_authenticated_user)):
    with get_db() as conn:
        conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id))
        conn.commit()

    await send_user_event(user_id, 'task_deleted', {'id': task_id})
    return JSONResponse({'success': True})

@app.post('/api/bot/tasks/{task_id}/rename')
async def bot_rename_task(task_id: str, request: Request, user_id: int = Depends(get_token_authenticated_user)):
    try:
        data = await request.json()
    except Exception:
        data = {}
    text = data.get('text', '').strip()

    if not text:
        return JSONResponse({'success': False, 'error': 'Task text required'}, status_code=400)

    with get_db() as conn:
        conn.execute('UPDATE tasks SET text = ? WHERE id = ? AND user_id = ?', (text, task_id, user_id))
        conn.commit()

    await send_user_event(user_id, 'task_updated', {'id': task_id, 'text': text})
    return JSONResponse({'success': True})

# ============== Media API ==============

@app.post('/api/tasks/{task_id}/media')
async def api_upload_media(task_id: str, file: UploadFile = File(...), user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT id FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
        if not task:
            return JSONResponse({'error': 'Task not found'}, status_code=404)

        if not file.filename:
            return JSONResponse({'error': 'No file selected'}, status_code=400)

        ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''
        if ext not in ALLOWED_EXTENSIONS:
            return JSONResponse({'error': 'Invalid format'}, status_code=400)

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
        with open(filepath, 'wb') as f:
            f.write(contents)

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
            return JSONResponse({'error': 'Media not found'}, status_code=404)

        filepath = os.path.join(UPLOAD_FOLDER, media['filename'])
        if os.path.exists(filepath):
            os.remove(filepath)

        conn.execute('DELETE FROM task_media WHERE task_id = ?', (task_id,))
        conn.commit()
    return JSONResponse({'success': True})

@app.get('/UPLOADS/{filename}')
async def serve_upload(filename: str):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
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
        return JSONResponse({'error': 'Invalid request'}, status_code=400)

    with get_db() as conn:
        friend = conn.execute('SELECT id FROM users WHERE id = ?', (friend_id,)).fetchone()
        if not friend:
            return JSONResponse({'error': 'User not found'}, status_code=404)

        existing = conn.execute('''
            SELECT status FROM friendships
            WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        ''', (user_id, friend_id, friend_id, user_id)).fetchone()

        if existing:
            if existing['status'] == 'accepted':
                return JSONResponse({'error': 'Already friends'}, status_code=400)
            return JSONResponse({'error': 'Request already exists'}, status_code=400)

        conn.execute('INSERT INTO friendships (user_id, friend_id) VALUES (?, ?)', (user_id, friend_id))
        conn.commit()
    return JSONResponse({'success': True, 'message': 'Request sent'})

@app.post('/api/friends/respond')
async def api_respond_friend_request(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    request_id = data.get('request_id')
    action = data.get('action')

    if action not in ('accept', 'reject'):
        return JSONResponse({'error': 'Invalid action'}, status_code=400)

    with get_db() as conn:
        request_row = conn.execute('''
            SELECT * FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'
        ''', (request_id, user_id)).fetchone()

        if not request_row:
            return JSONResponse({'error': 'Request not found'}, status_code=404)

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
            return JSONResponse({'error': 'Request not found'}, status_code=404)
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
            return JSONResponse({'error': 'User is not a friend'}, status_code=404)
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

# ============== WebSocket ==============

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Read session from cookie via SessionMiddleware
    username = websocket.session.get('user')
    if not username:
        await websocket.close(code=4001)
        return

    with get_db() as conn:
        user = conn.execute('SELECT id FROM users WHERE username = ?', (username,)).fetchone()
    if not user:
        await websocket.close(code=4001)
        return

    user_id = user['id']
    session_id = f"ws_{uuid.uuid4().hex[:8]}"
    await manager.connect(user_id, session_id, websocket)

    try:
        await websocket.send_json({"event": "connected", "data": {"user_id": user_id, "sessionId": session_id}})
        while True:
            await websocket.receive_text()  # Keep-alive
    except WebSocketDisconnect:
        manager.disconnect(user_id, session_id)

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

    # Notify WebSocket clients before restart
    logger.info('Notifying clients of server reload...')
    try:
        await manager.broadcast_all("server_shutdown", {"message": "Server reloading..."})
    except Exception as e:
        logger.error(f'Error notifying clients: {e}')

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

# ============== Init ==============

init_db()

# Template globals
templates.env.globals['app_version'] = get_version()

# Static files (must be after all routes)
app.mount('/static', StaticFiles(directory='FRONTEND'), name='static')

if __name__ == '__main__':
    debug_mode = APP_DEBUG
    uvicorn.run(
        "run:app", host='127.0.0.1', port=PORT,
        reload=debug_mode, proxy_headers=True, forwarded_allow_ips='*'
    )
