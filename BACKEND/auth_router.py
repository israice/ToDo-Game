"""Web + API authentication routes: index, login, register, logout."""

import os
import hashlib
import sqlite3

import bcrypt
from fastapi import APIRouter, Request, Form
from fastapi.responses import JSONResponse, RedirectResponse

from BACKEND.core import (
    get_db, templates, parse_json, get_version,
    generate_csrf_token, validate_csrf_token,
)

router = APIRouter()


# ============== Web routes ==============

@router.get('/')
async def index(request: Request):
    if request.session.get('user'):
        return templates.TemplateResponse('dashboard.html', {
            'request': request,
            'user': request.session['user'],
            'version': get_version(),
        })
    register_error = request.session.pop('register_error', None)
    return templates.TemplateResponse('login.html', {
        'request': request,
        'error': None,
        'register_error': register_error,
        'csrf_token': generate_csrf_token(),
    })


@router.post('/login')
async def login(request: Request, username: str = Form(...), password: str = Form(...),
                csrf_token: str = Form('')):
    if not validate_csrf_token(csrf_token):
        return templates.TemplateResponse('login.html', {
            'request': request, 'error': 'Invalid request',
            'register_error': None, 'csrf_token': generate_csrf_token(),
        })
    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
    if user and bcrypt.checkpw(password.encode(), user['password'].encode()):
        request.session['user'] = user['username']
        return RedirectResponse('/', status_code=303)
    return templates.TemplateResponse('login.html', {
        'request': request, 'error': 'Invalid credentials',
        'register_error': None, 'csrf_token': generate_csrf_token(),
    })


@router.post('/register')
async def register(request: Request, username: str = Form(...), password: str = Form(...),
                   csrf_token: str = Form('')):
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


@router.get('/logout')
async def logout(request: Request):
    request.session.pop('user', None)
    return RedirectResponse('/', status_code=303)


# ============== API auth (Telegram bot) ==============

@router.post('/api/auth/login')
async def api_login(request: Request):
    data = await parse_json(request)
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

        session_token = hashlib.sha256(
            f"{user['id']}-{username}-{os.urandom(16).hex()}".encode()
        ).hexdigest()
        conn.execute(
            'INSERT INTO api_tokens (user_id, token, created_at) VALUES (?, ?, datetime(\'now\'))',
            (user['id'], session_token),
        )
        conn.commit()

        return JSONResponse({
            'success': True,
            'token': session_token,
            'username': username,
            'user_id': user['id'],
        })


@router.post('/api/auth/register')
async def api_register(request: Request):
    data = await parse_json(request)
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

            session_token = hashlib.sha256(
                f"{cursor.lastrowid}-{username}-{os.urandom(16).hex()}".encode()
            ).hexdigest()
            conn.execute(
                'INSERT INTO api_tokens (user_id, token, created_at) VALUES (?, ?, datetime(\'now\'))',
                (cursor.lastrowid, session_token),
            )
            conn.commit()

            return JSONResponse({
                'success': True,
                'token': session_token,
                'username': username,
                'user_id': cursor.lastrowid,
            })
        except sqlite3.IntegrityError:
            return JSONResponse({'success': False, 'error': 'Username already exists',
                                 'alreadyExists': True}, status_code=409)


@router.post('/api/auth/logout')
async def api_logout(request: Request):
    data = await parse_json(request)
    token = data.get('token', '')
    with get_db() as conn:
        conn.execute('DELETE FROM api_tokens WHERE token = ?', (token,))
        conn.commit()
    return JSONResponse({'success': True})
