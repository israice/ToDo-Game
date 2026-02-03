import os, math, uuid, random, hashlib, hmac, subprocess, sqlite3, logging
from datetime import datetime, date
from functools import wraps
from contextlib import contextmanager
from flask import Flask, request, redirect, session, render_template, jsonify
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
import bcrypt
from flask_wtf.csrf import CSRFProtect

load_dotenv()

class IgnoreWellKnown(logging.Filter):
    def filter(self, record):
        return '/.well-known/' not in record.getMessage()

logging.getLogger('werkzeug').addFilter(IgnoreWellKnown())

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.secret_key = os.environ.get('SECRET_KEY') or (_ for _ in ()).throw(RuntimeError("SECRET_KEY required"))
csrf = CSRFProtect(app)

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
BRANCH = os.environ.get("BRANCH", "master")

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

@app.after_request
def no_cache(response):
    response.headers['Cache-Control'] = 'no-store'
    return response

# ============== DB Helpers ==============

@contextmanager
def get_db():
    conn = sqlite3.connect('users.db')
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
        ''')

def with_db(f):
    """Decorator: auth check + db connection + user_id injection"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Не авторизован'}), 401
        with get_db() as conn:
            user = conn.execute('SELECT id FROM users WHERE username = ?', (session['user'],)).fetchone()
            return f(conn, user['id'], *args, **kwargs)
    return decorated

def get_or_create_progress(conn, user_id):
    progress = conn.execute('SELECT * FROM user_progress WHERE user_id = ?', (user_id,)).fetchone()
    if not progress:
        conn.execute('INSERT INTO user_progress (user_id) VALUES (?)', (user_id,))
        conn.commit()
        return {'level': 1, 'xp': 0, 'xp_max': 100, 'completed_tasks': 0, 'current_streak': 0, 'combo': 0, 'sound_enabled': 0}
    return dict(progress)

def get_version():
    try:
        with open(os.path.join(os.path.dirname(__file__), 'VERSION.md'), 'r', encoding='utf-8') as f:
            for line in reversed(f.readlines()):
                if line.strip().startswith('v'):
                    return line.strip().split()[0]
    except: pass
    return 'v0.0.0'

# ============== Auth Routes ==============

@app.route('/.well-known/<path:path>')
def well_known(path):
    return '', 204

@app.route('/')
def index():
    if 'user' in session:
        return render_template('dashboard.html', user=session['user'], version=get_version())
    return render_template('login.html', register_error=session.pop('register_error', None))

@app.route('/login', methods=['POST'])
def login():
    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE username=?', (request.form['username'],)).fetchone()
    if user and bcrypt.checkpw(request.form['password'].encode(), user['password'].encode()):
        session['user'] = user['username']
        return redirect('/')
    return render_template('login.html', error='Неверные учётные данные')

@app.route('/register', methods=['POST'])
def register():
    with get_db() as conn:
        try:
            pw_hash = bcrypt.hashpw(request.form['password'].encode(), bcrypt.gensalt()).decode()
            cursor = conn.execute('INSERT INTO users (username, password) VALUES (?, ?)',
                                  (request.form['username'], pw_hash))
            conn.execute('INSERT INTO user_progress (user_id) VALUES (?)', (cursor.lastrowid,))
            conn.commit()
            session['user'] = request.form['username']
            return redirect('/')
        except:
            session['register_error'] = 'Пользователь уже существует'
            return redirect('/')

@app.route('/logout')
def logout():
    session.pop('user', None)
    return redirect('/')

# ============== API Routes ==============

@app.route('/api/state')
@with_db
def api_get_state(conn, user_id):
    progress = get_or_create_progress(conn, user_id)
    tasks = [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward']}
             for t in conn.execute('SELECT id, text, xp_reward FROM tasks WHERE user_id = ? ORDER BY created_at DESC', (user_id,))]
    achievements = {a['achievement_id']: True for a in conn.execute('SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,))}
    return jsonify({
        'tasks': tasks, 'level': progress['level'], 'xp': progress['xp'], 'xpMax': progress['xp_max'],
        'completed': progress['completed_tasks'], 'streak': progress['current_streak'],
        'combo': progress['combo'], 'achievements': achievements, 'sound': bool(progress['sound_enabled'])
    })

@app.route('/api/settings', methods=['PUT'])
@csrf.exempt
@with_db
def api_update_settings(conn, user_id):
    data = request.get_json()
    if 'sound' in data:
        conn.execute('UPDATE user_progress SET sound_enabled = ? WHERE user_id = ?', (1 if data['sound'] else 0, user_id))
        conn.commit()
    return jsonify({'success': True})

@app.route('/api/tasks', methods=['POST'])
@csrf.exempt
@with_db
def api_create_task(conn, user_id):
    data = request.get_json()
    if not data or not data.get('text', '').strip():
        return jsonify({'error': 'Текст задачи обязателен'}), 400
    task_id = f"{int(datetime.now().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}"
    xp = random.randint(20, 35)
    conn.execute('INSERT INTO tasks (id, user_id, text, xp_reward) VALUES (?, ?, ?, ?)',
                 (task_id, user_id, data['text'].strip(), xp))
    conn.commit()
    return jsonify({'id': task_id, 'text': data['text'].strip(), 'xp': xp})

@app.route('/api/tasks/<task_id>', methods=['PUT'])
@csrf.exempt
@with_db
def api_update_task(conn, user_id, task_id):
    data = request.get_json()
    if not data or not data.get('text', '').strip():
        return jsonify({'error': 'Текст задачи обязателен'}), 400
    conn.execute('UPDATE tasks SET text = ? WHERE id = ? AND user_id = ?', (data['text'].strip(), task_id, user_id))
    conn.commit()
    return jsonify({'success': True})

@app.route('/api/tasks/<task_id>', methods=['DELETE'])
@csrf.exempt
@with_db
def api_delete_task(conn, user_id, task_id):
    conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id))
    conn.commit()
    return jsonify({'success': True})

@app.route('/api/tasks/<task_id>/complete', methods=['POST'])
@csrf.exempt
@with_db
def api_complete_task(conn, user_id, task_id):
    task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
    if not task:
        return jsonify({'error': 'Задача не найдена'}), 404

    progress = get_or_create_progress(conn, user_id)
    client_combo = (request.get_json() or {}).get('combo', 0)
    combo = client_combo + 1
    xp_earned = int(task['xp_reward'] * (1 + combo * 0.1))

    new_xp, new_level, new_xp_max, leveled_up = progress['xp'] + xp_earned, progress['level'], progress['xp_max'], False
    while new_xp >= new_xp_max:
        new_xp -= new_xp_max
        new_level += 1
        new_xp_max = int(100 * math.pow(1.2, new_level - 1))
        leveled_up = True

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

    state = {'completed': new_completed, 'combo': combo, 'level': new_level, 'streak': new_streak}
    existing = {a['achievement_id'] for a in conn.execute('SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,))}
    new_achievements = [ach['id'] for ach in ACHIEVEMENTS if ach['id'] not in existing and ach['check'](state)]
    for ach_id in new_achievements:
        conn.execute('INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, ?)', (user_id, ach_id))
    conn.commit()

    return jsonify({
        'success': True, 'xpEarned': xp_earned, 'level': new_level, 'xp': new_xp, 'xpMax': new_xp_max,
        'completed': new_completed, 'streak': new_streak, 'combo': combo,
        'leveledUp': leveled_up, 'newAchievements': new_achievements
    })

@app.route('/api/combo/reset', methods=['POST'])
@csrf.exempt
@with_db
def api_reset_combo(conn, user_id):
    conn.execute('UPDATE user_progress SET combo = 0 WHERE user_id = ?', (user_id,))
    conn.commit()
    return jsonify({'success': True})

# ============== Webhook ==============

@app.route("/webhook", methods=["POST"])
@csrf.exempt
def webhook():
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not WEBHOOK_SECRET or not hmac.compare_digest(
        f"sha256={hmac.new(WEBHOOK_SECRET.encode(), request.data, hashlib.sha256).hexdigest()}", sig):
        return "Forbidden", 403

    if request.headers.get("X-GitHub-Event") != "push":
        return "OK", 200

    payload = request.get_json(silent=True) or {}
    if payload.get("ref") != f"refs/heads/{BRANCH}":
        return "Ignored", 200

    for cmd in [["git", "fetch", "origin"], ["git", "reset", "--hard", f"origin/{BRANCH}"]]:
        result = subprocess.run(cmd, cwd="/app", capture_output=True, text=True)
        if result.returncode != 0:
            app.logger.error(f"{cmd[1]} failed: {result.stderr}")
            return f"Git {cmd[1]} failed", 500

    subprocess.Popen(f"sleep 1 && kill -HUP {os.getppid()}", shell=True, start_new_session=True)
    return "OK", 200

# ============== Init ==============

init_db()

if __name__ == '__main__':
    app.run(debug=os.environ.get('FLASK_DEBUG', '').lower() == 'true')
