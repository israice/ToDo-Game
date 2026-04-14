"""Friends, search, feed."""

import json

from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse

from BACKEND.core import get_db, error_response, get_authenticated_user

router = APIRouter()


@router.get('/api/users/search')
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
                'friendship_status': status,
            })

        return JSONResponse({'users': result})


@router.get('/api/friends')
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
                         'avatar_letter': r['username'][0].upper()} for r in friends],
        })


@router.post('/api/friends/request')
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

        conn.execute('INSERT INTO friendships (user_id, friend_id) VALUES (?, ?)',
                     (user_id, friend_id))
        conn.commit()
    return JSONResponse({'success': True, 'message': 'Request sent'})


@router.post('/api/friends/respond')
async def api_respond_friend_request(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    request_id = data.get('request_id')
    action = data.get('action')

    if action not in ('accept', 'reject'):
        return error_response('Invalid action')

    with get_db() as conn:
        request_row = conn.execute(
            "SELECT * FROM friendships WHERE id = ? AND friend_id = ? AND status = 'pending'",
            (request_id, user_id),
        ).fetchone()

        if not request_row:
            return error_response('Request not found', 404)

        new_status = 'accepted' if action == 'accept' else 'rejected'
        conn.execute('UPDATE friendships SET status = ? WHERE id = ?',
                     (new_status, request_id))
        conn.commit()

    message = 'Request accepted' if action == 'accept' else 'Request declined'
    return JSONResponse({'success': True, 'message': message})


@router.delete('/api/friends/request/{request_id}')
async def api_cancel_friend_request(request_id: int, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        result = conn.execute(
            "DELETE FROM friendships WHERE id = ? AND user_id = ? AND status = 'pending'",
            (request_id, user_id),
        )
        conn.commit()
        if result.rowcount == 0:
            return error_response('Request not found', 404)
    return JSONResponse({'success': True})


@router.delete('/api/friends/{friend_id}')
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


@router.get('/api/friends/feed')
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
                'avatar_letter': f['username'][0].upper(),
                'activity_type': f['activity_type'],
                'task_text': f['task_text'], 'xp_earned': f['xp_earned'],
                'created_at': f['created_at'],
            }
            if f['extra_data']:
                extra = json.loads(f['extra_data'])
                item['media_type'] = extra.get('media_type')
                item['media_url'] = extra.get('media_url')
            result.append(item)

        return JSONResponse({'feed': result, 'has_more': has_more})
