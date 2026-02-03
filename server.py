import os
import math
import uuid
import random
import hashlib
import hmac
import subprocess
from datetime import datetime, date
from flask import Flask, request, redirect, session, render_template, jsonify
from werkzeug.middleware.proxy_fix import ProxyFix
from dotenv import load_dotenv
import bcrypt
from flask_wtf.csrf import CSRFProtect
import sqlite3

load_dotenv()

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.secret_key = os.environ.get('SECRET_KEY')
if not app.secret_key:
    raise RuntimeError("SECRET_KEY environment variable is required")

csrf = CSRFProtect(app)

@app.after_request
def no_cache(response):
    response.headers['Cache-Control'] = 'no-store'
    return response

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
BRANCH = os.environ.get("BRANCH", "master")


def verify_signature(payload, signature):
    if not WEBHOOK_SECRET:
        return False
    expected = "sha256=" + hmac.new(
        WEBHOOK_SECRET.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def get_version():
    """Read version from VERSION.md (last line starting with 'v')"""
    try:
        version_file = os.path.join(os.path.dirname(__file__), 'VERSION.md')
        with open(version_file, 'r', encoding='utf-8') as f:
            for line in reversed(f.readlines()):
                line = line.strip()
                if line.startswith('v'):
                    return line.split()[0] if ' ' in line else line
    except Exception:
        pass
    return 'v0.0.0'


# Achievement definitions (same as in app.js)
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

def get_db():
    conn = sqlite3.connect('users.db')
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()

    # Users table (existing)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
    ''')

    # User progress table
    conn.execute('''
        CREATE TABLE IF NOT EXISTS user_progress (
            id INTEGER PRIMARY KEY,
            user_id INTEGER UNIQUE NOT NULL,
            level INTEGER DEFAULT 1,
            xp INTEGER DEFAULT 0,
            xp_max INTEGER DEFAULT 100,
            completed_tasks INTEGER DEFAULT 0,
            current_streak INTEGER DEFAULT 0,
            combo INTEGER DEFAULT 0,
            last_completion_date TEXT,
            sound_enabled INTEGER DEFAULT 0,
            theme TEXT DEFAULT 'dark',
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')

    # User achievements table
    conn.execute('''
        CREATE TABLE IF NOT EXISTS user_achievements (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL,
            achievement_id TEXT NOT NULL,
            unlocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, achievement_id)
        )
    ''')

    # Tasks table
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            xp_reward INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    ''')

    conn.commit()
    conn.close()

def get_user_id():
    """Get current user's ID from session"""
    if 'user' not in session:
        return None
    conn = get_db()
    user = conn.execute('SELECT id FROM users WHERE username = ?', (session['user'],)).fetchone()
    conn.close()
    return user['id'] if user else None

def require_auth(f):
    """Decorator to require authentication for API routes"""
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user' not in session:
            return jsonify({'error': 'Unauthorized'}), 401
        return f(*args, **kwargs)
    return decorated

# ============== Page Routes ==============

@app.route('/')
def index():
    if 'user' in session:
        return render_template('dashboard.html', user=session['user'], version=get_version())
    return render_template('login.html')

@app.route('/login', methods=['POST'])
def login():
    conn = get_db()
    user = conn.execute('SELECT * FROM users WHERE username=?',
        (request.form['username'],)).fetchone()
    conn.close()
    if user and bcrypt.checkpw(
        request.form['password'].encode('utf-8'),
        user['password'].encode('utf-8')
    ):
        session['user'] = user['username']
        session['user_id'] = user['id']
        return redirect('/')
    return render_template('login.html', error='Invalid credentials')

@app.route('/register', methods=['POST'])
def register():
    conn = get_db()
    try:
        password_hash = bcrypt.hashpw(
            request.form['password'].encode('utf-8'),
            bcrypt.gensalt()
        ).decode('utf-8')
        cursor = conn.execute('INSERT INTO users (username, password) VALUES (?, ?)',
            (request.form['username'], password_hash))
        user_id = cursor.lastrowid

        # Create initial progress record for new user
        conn.execute('''
            INSERT INTO user_progress (user_id, level, xp, xp_max, completed_tasks, current_streak, combo, sound_enabled, theme)
            VALUES (?, 1, 0, 100, 0, 0, 0, 0, 'dark')
        ''', (user_id,))

        conn.commit()
        session['user'] = request.form['username']
        session['user_id'] = user_id
        conn.close()
        return redirect('/')
    except:
        conn.close()
        return render_template('login.html', error='User already exists')

@app.route('/logout')
def logout():
    session.pop('user', None)
    session.pop('user_id', None)
    return redirect('/')

# ============== API Routes ==============

@app.route('/api/state')
@require_auth
def api_get_state():
    """Get full state: progress, tasks, achievements"""
    user_id = get_user_id()
    conn = get_db()

    # Get progress
    progress = conn.execute('SELECT * FROM user_progress WHERE user_id = ?', (user_id,)).fetchone()

    # Get tasks
    tasks_rows = conn.execute('SELECT id, text, xp_reward FROM tasks WHERE user_id = ? ORDER BY created_at DESC', (user_id,)).fetchall()
    tasks = [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward']} for t in tasks_rows]

    # Get achievements
    ach_rows = conn.execute('SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,)).fetchall()
    achievements = {a['achievement_id']: True for a in ach_rows}

    conn.close()

    if not progress:
        # Create progress if doesn't exist (for old users)
        conn = get_db()
        conn.execute('''
            INSERT INTO user_progress (user_id, level, xp, xp_max, completed_tasks, current_streak, combo, sound_enabled, theme)
            VALUES (?, 1, 0, 100, 0, 0, 0, 0, 'dark')
        ''', (user_id,))
        conn.commit()
        conn.close()
        progress = {'level': 1, 'xp': 0, 'xp_max': 100, 'completed_tasks': 0, 'current_streak': 0, 'combo': 0, 'sound_enabled': 0, 'theme': 'dark'}

    return jsonify({
        'tasks': tasks,
        'level': progress['level'],
        'xp': progress['xp'],
        'xpMax': progress['xp_max'],
        'completed': progress['completed_tasks'],
        'streak': progress['current_streak'],
        'combo': progress['combo'],
        'achievements': achievements,
        'sound': bool(progress['sound_enabled']),
        'theme': progress['theme']
    })

@app.route('/api/settings', methods=['PUT'])
@require_auth
@csrf.exempt
def api_update_settings():
    """Update user settings (sound, theme)"""
    user_id = get_user_id()
    data = request.get_json()

    conn = get_db()
    if 'sound' in data:
        conn.execute('UPDATE user_progress SET sound_enabled = ? WHERE user_id = ?', (1 if data['sound'] else 0, user_id))
    if 'theme' in data:
        conn.execute('UPDATE user_progress SET theme = ? WHERE user_id = ?', (data['theme'], user_id))
    conn.commit()
    conn.close()

    return jsonify({'success': True})

@app.route('/api/tasks', methods=['GET'])
@require_auth
def api_get_tasks():
    """Get all tasks for current user"""
    user_id = get_user_id()
    conn = get_db()
    tasks_rows = conn.execute('SELECT id, text, xp_reward FROM tasks WHERE user_id = ? ORDER BY created_at DESC', (user_id,)).fetchall()
    conn.close()
    tasks = [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward']} for t in tasks_rows]
    return jsonify(tasks)

@app.route('/api/tasks', methods=['POST'])
@require_auth
@csrf.exempt
def api_create_task():
    """Create a new task"""
    user_id = get_user_id()
    data = request.get_json()

    if not data or not data.get('text', '').strip():
        return jsonify({'error': 'Task text is required'}), 400

    task_id = f"{int(datetime.now().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}"
    xp_reward = random.randint(20, 35)

    conn = get_db()
    conn.execute('INSERT INTO tasks (id, user_id, text, xp_reward) VALUES (?, ?, ?, ?)',
        (task_id, user_id, data['text'].strip(), xp_reward))
    conn.commit()
    conn.close()

    return jsonify({'id': task_id, 'text': data['text'].strip(), 'xp': xp_reward})

@app.route('/api/tasks/<task_id>', methods=['PUT'])
@require_auth
@csrf.exempt
def api_update_task(task_id):
    """Update task text"""
    user_id = get_user_id()
    data = request.get_json()

    if not data or not data.get('text', '').strip():
        return jsonify({'error': 'Task text is required'}), 400

    conn = get_db()
    conn.execute('UPDATE tasks SET text = ? WHERE id = ? AND user_id = ?',
        (data['text'].strip(), task_id, user_id))
    conn.commit()
    conn.close()

    return jsonify({'success': True})

@app.route('/api/tasks/<task_id>', methods=['DELETE'])
@require_auth
@csrf.exempt
def api_delete_task(task_id):
    """Delete a task"""
    user_id = get_user_id()
    conn = get_db()
    conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/tasks/<task_id>/complete', methods=['POST'])
@require_auth
@csrf.exempt
def api_complete_task(task_id):
    """Complete a task - calculates XP, level, achievements"""
    user_id = get_user_id()
    data = request.get_json() or {}
    client_combo = data.get('combo', 0)

    conn = get_db()

    # Get task
    task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id)).fetchone()
    if not task:
        conn.close()
        return jsonify({'error': 'Task not found'}), 404

    # Get current progress
    progress = conn.execute('SELECT * FROM user_progress WHERE user_id = ?', (user_id,)).fetchone()

    # Calculate new values
    combo = client_combo + 1
    xp_earned = int(task['xp_reward'] * (1 + combo * 0.1))
    new_xp = progress['xp'] + xp_earned
    new_level = progress['level']
    new_xp_max = progress['xp_max']
    leveled_up = False

    # Level up logic
    while new_xp >= new_xp_max:
        new_xp -= new_xp_max
        new_level += 1
        new_xp_max = int(100 * math.pow(1.2, new_level - 1))
        leveled_up = True

    # Streak logic
    today = date.today().isoformat()
    last_date = progress['last_completion_date']
    new_streak = progress['current_streak']

    if last_date != today:
        if last_date:
            last = date.fromisoformat(last_date)
            diff = (date.today() - last).days
            new_streak = new_streak + 1 if diff == 1 else 1
        else:
            new_streak = 1

    new_completed = progress['completed_tasks'] + 1

    # Update progress
    conn.execute('''
        UPDATE user_progress
        SET level = ?, xp = ?, xp_max = ?, completed_tasks = ?,
            current_streak = ?, combo = ?, last_completion_date = ?
        WHERE user_id = ?
    ''', (new_level, new_xp, new_xp_max, new_completed, new_streak, combo, today, user_id))

    # Delete completed task
    conn.execute('DELETE FROM tasks WHERE id = ?', (task_id,))

    # Check achievements
    state = {
        'completed': new_completed,
        'combo': combo,
        'level': new_level,
        'streak': new_streak
    }

    existing_achievements = [a['achievement_id'] for a in
        conn.execute('SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,)).fetchall()]

    new_achievements = []
    for ach in ACHIEVEMENTS:
        if ach['id'] not in existing_achievements and ach['check'](state):
            conn.execute('INSERT INTO user_achievements (user_id, achievement_id) VALUES (?, ?)',
                (user_id, ach['id']))
            new_achievements.append(ach['id'])

    conn.commit()
    conn.close()

    return jsonify({
        'success': True,
        'xpEarned': xp_earned,
        'level': new_level,
        'xp': new_xp,
        'xpMax': new_xp_max,
        'completed': new_completed,
        'streak': new_streak,
        'combo': combo,
        'leveledUp': leveled_up,
        'newAchievements': new_achievements
    })

@app.route('/api/combo/reset', methods=['POST'])
@require_auth
@csrf.exempt
def api_reset_combo():
    """Reset combo to 0"""
    user_id = get_user_id()
    conn = get_db()
    conn.execute('UPDATE user_progress SET combo = 0 WHERE user_id = ?', (user_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route("/webhook", methods=["POST"])
@csrf.exempt
def webhook():
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not verify_signature(request.data, signature):
        app.logger.warning("Webhook: invalid signature")
        return "Forbidden", 403

    if request.headers.get("X-GitHub-Event") == "push":
        payload = request.get_json(silent=True) or {}
        ref = payload.get("ref")
        if ref != f"refs/heads/{BRANCH}":
            app.logger.info(f"Webhook: ignored push to {ref}")
            return "Ignored", 200

        app.logger.info(f"Webhook: updating from {BRANCH}")

        fetch_result = subprocess.run(
            ["git", "fetch", "origin"],
            cwd="/app",
            capture_output=True,
            text=True
        )
        if fetch_result.returncode != 0:
            app.logger.error(f"Git fetch failed: {fetch_result.stderr}")
            return "Git fetch failed", 500

        reset_result = subprocess.run(
            ["git", "reset", "--hard", f"origin/{BRANCH}"],
            cwd="/app",
            capture_output=True,
            text=True
        )
        if reset_result.returncode != 0:
            app.logger.error(f"Git reset failed: {reset_result.stderr}")
            return "Git reset failed", 500

        app.logger.info("Webhook: update successful, restarting...")

        # Delayed restart via shell to send response first
        subprocess.Popen(f"sleep 1 && kill -9 {os.getpid()}", shell=True, start_new_session=True)
        return "OK", 200
    return "OK", 200


# Initialize database on module load (for gunicorn)
init_db()

if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    app.run(debug=debug_mode)
