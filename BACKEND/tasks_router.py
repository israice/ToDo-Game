"""Task CRUD + state + history + settings + combo."""

import os
import json
import math
from datetime import datetime, timedelta

from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse

from SETTINGS import APP_DEBUG
from BACKEND.core import (
    logger, get_db, error_response, parse_json,
    get_authenticated_user, validate_task_text, validate_description,
    new_task_id, normalize_schedule,
    get_or_create_progress, apply_xp, complete_task_logic, compute_files_hash,
    UPLOAD_FOLDER, GOOGLE_CALENDAR_ENABLED,
)
from BACKEND.gcal_helpers import gcal_service, gcal_delete_tasks

router = APIRouter()


@router.get('/api/state')
async def api_get_state(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        # Auto-delete tasks completed by user, 7 days after their scheduled end
        cutoff = (datetime.utcnow() - timedelta(days=7)).isoformat()
        expired = conn.execute(
            'SELECT id, google_event_id FROM tasks WHERE user_id = ? '
            'AND completed_at IS NOT NULL AND scheduled_end < ?',
            (user_id, cutoff),
        ).fetchall()
        if expired:
            if GOOGLE_CALENDAR_ENABLED:
                try:
                    service, cal_id = gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import delete_calendar_event
                        for t in expired:
                            if t['google_event_id']:
                                try:
                                    delete_calendar_event(service, cal_id, t['google_event_id'])
                                except Exception:
                                    pass
                                conn.execute(
                                    'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                                    (user_id, t['google_event_id']),
                                )
                except Exception:
                    logger.error('Failed to sync expired tasks deletion to Google Calendar', exc_info=True)

            expired_ids = [t['id'] for t in expired]
            ph = ','.join('?' * len(expired_ids))

            # Delete media files from disk
            for mf in conn.execute(
                f'SELECT filename FROM task_media WHERE task_id IN ({ph})', expired_ids
            ).fetchall():
                fpath = os.path.join(UPLOAD_FOLDER, mf['filename'])
                if os.path.isfile(fpath):
                    try:
                        os.remove(fpath)
                    except OSError:
                        pass

            # Sync cascaded subtasks/recurrence instances to gcal before delete
            cascade_subtasks = conn.execute(
                f'SELECT id FROM tasks WHERE parent_id IN ({ph}) AND user_id = ?',
                expired_ids + [user_id],
            ).fetchall()
            cascade_recurrence = conn.execute(
                f'SELECT id FROM tasks WHERE recurrence_source_id IN ({ph}) AND user_id = ?',
                expired_ids + [user_id],
            ).fetchall()
            cascade_ids = [r['id'] for r in cascade_subtasks] + [r['id'] for r in cascade_recurrence]
            if cascade_ids:
                gcal_delete_tasks(conn, user_id, cascade_ids)

            conn.execute(f'DELETE FROM tasks WHERE parent_id IN ({ph}) AND user_id = ?',
                         expired_ids + [user_id])
            conn.execute(f'DELETE FROM tasks WHERE recurrence_source_id IN ({ph}) AND user_id = ?',
                         expired_ids + [user_id])
            conn.execute(f'DELETE FROM tasks WHERE id IN ({ph})', expired_ids)
            conn.commit()

        progress = get_or_create_progress(conn, user_id)
        media_map = {
            m['task_id']: {'type': m['media_type'], 'url': f"/UPLOADS/{m['filename']}"}
            for m in conn.execute(
                'SELECT task_id, media_type, filename FROM task_media WHERE user_id = ?', (user_id,)
            )
        }
        tasks = [
            {
                'id': t['id'], 'text': t['text'], 'xp': t['xp_reward'],
                'media': media_map.get(t['id']),
                'scheduled_start': t['scheduled_start'], 'scheduled_end': t['scheduled_end'],
                'completed_at': t['completed_at'], 'parent_id': t['parent_id'],
                'recurrence_rule': t['recurrence_rule'],
                'recurrence_source_id': t['recurrence_source_id'],
                'is_gcal_sourced': t['is_gcal_sourced'] == '1',
                'description': t['description'] or '',
            }
            for t in conn.execute(
                'SELECT id, text, xp_reward, scheduled_start, scheduled_end, completed_at, '
                'parent_id, recurrence_rule, recurrence_source_id, is_gcal_sourced, description '
                'FROM tasks WHERE user_id = ? ORDER BY created_at DESC', (user_id,)
            )
        ]
        achievements = {
            a['achievement_id']: True
            for a in conn.execute(
                'SELECT achievement_id FROM user_achievements WHERE user_id = ?', (user_id,)
            )
        }
        result = {
            'tasks': tasks, 'level': progress['level'], 'xp': progress['xp'],
            'xpMax': progress['xp_max'], 'completed': progress['completed_tasks'],
            'streak': progress['current_streak'], 'combo': progress['combo'],
            'achievements': achievements, 'sound': bool(progress['sound_enabled']),
            'drumView': bool(progress.get('drum_view', 1)),
            'taskBg': bool(progress.get('task_bg', 0)),
        }
        if APP_DEBUG:
            css_hash, other_hash = compute_files_hash()
            result['_devHash'] = {'css': css_hash, 'other': other_hash}
        return JSONResponse(result)


@router.put('/api/settings')
async def api_update_settings(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    with get_db() as conn:
        if 'sound' in data:
            conn.execute('UPDATE user_progress SET sound_enabled = ? WHERE user_id = ?',
                         (1 if data['sound'] else 0, user_id))
        if 'drumView' in data:
            conn.execute('UPDATE user_progress SET drum_view = ? WHERE user_id = ?',
                         (1 if data['drumView'] else 0, user_id))
        if 'taskBg' in data:
            conn.execute('UPDATE user_progress SET task_bg = ? WHERE user_id = ?',
                         (1 if data['taskBg'] else 0, user_id))
        conn.commit()
    return JSONResponse({'success': True})


@router.post('/api/tasks')
async def api_create_task(request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    text, err = validate_task_text(data)
    if err: return err
    description, err = validate_description(data)
    if err: return err

    task_id, xp = new_task_id()
    scheduled_start, scheduled_end = normalize_schedule(
        data.get('scheduled_start'), data.get('scheduled_end'),
    )
    parent_id = data.get('parent_id') or None
    recurrence_rule = data.get('recurrence_rule') or None
    if recurrence_rule and isinstance(recurrence_rule, dict):
        recurrence_rule = json.dumps(recurrence_rule)

    google_event_id = None
    with get_db() as conn:
        if parent_id:
            parent = conn.execute('SELECT id FROM tasks WHERE id = ? AND user_id = ?',
                                  (parent_id, user_id)).fetchone()
            if not parent:
                return error_response('Parent task not found', 404)

        conn.execute(
            'INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end, '
            'parent_id, recurrence_rule, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (task_id, user_id, text, xp, scheduled_start, scheduled_end, parent_id,
             recurrence_rule, description or None),
        )
        progress = get_or_create_progress(conn, user_id)
        new_xp, new_level, new_xp_max, leveled_up = apply_xp(progress, 3)
        conn.execute('UPDATE user_progress SET xp=?, level=?, xp_max=? WHERE user_id=?',
                     (new_xp, new_level, new_xp_max, user_id))

        if GOOGLE_CALENDAR_ENABLED:
            try:
                service, cal_id = gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import create_calendar_event
                    google_event_id = create_calendar_event(
                        service, cal_id, text, scheduled_start, scheduled_end,
                        recurrence_rule, description,
                    )
                    if google_event_id:
                        conn.execute('UPDATE tasks SET google_event_id = ? WHERE id = ?',
                                     (google_event_id, task_id))
            except Exception:
                logger.error('Failed to sync new task to Google Calendar', exc_info=True)

        conn.execute(
            'INSERT INTO activity_log (user_id, activity_type, task_text, xp_earned) '
            "VALUES (?, 'task_created', ?, ?)", (user_id, text, 3),
        )
        conn.commit()

    return JSONResponse({
        'id': task_id, 'text': text, 'xp': xp,
        'scheduled_start': scheduled_start, 'scheduled_end': scheduled_end,
        'parent_id': parent_id, 'recurrence_rule': recurrence_rule,
        'description': description or '',
        'xpEarned': 3, 'level': new_level, 'currentXp': new_xp,
        'xpMax': new_xp_max, 'leveledUp': leveled_up,
    })


@router.put('/api/tasks/{task_id}')
async def api_update_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    data = await request.json()
    text, err = validate_task_text(data)
    if err: return err
    description_provided = 'description' in data
    description, err = validate_description(data)
    if err: return err

    scheduled_start = data.get('scheduled_start')
    scheduled_end = data.get('scheduled_end')
    if scheduled_start and scheduled_end:
        from dateutil.parser import parse as dt_parse
        s, e = dt_parse(scheduled_start), dt_parse(scheduled_end)
        if s > e:
            scheduled_end = (s + timedelta(minutes=15)).isoformat()

    _sentinel = object()
    recurrence_rule = data.get('recurrence_rule', _sentinel)
    recurrence_rule_provided = recurrence_rule is not _sentinel
    if recurrence_rule is _sentinel:
        recurrence_rule = None
    if recurrence_rule is not None and isinstance(recurrence_rule, dict):
        recurrence_rule = json.dumps(recurrence_rule)
    detach_from_series = data.get('detach_from_series', False)

    with get_db() as conn:
        if detach_from_series:
            task_row = conn.execute(
                'SELECT recurrence_source_id FROM tasks WHERE id = ? AND user_id = ?',
                (task_id, user_id),
            ).fetchone()
            if task_row and task_row['recurrence_source_id']:
                source_id = task_row['recurrence_source_id']
                siblings = conn.execute(
                    'SELECT id FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND id != ?',
                    (source_id, user_id, task_id),
                ).fetchall()
                if siblings:
                    gcal_delete_tasks(conn, user_id, [s['id'] for s in siblings])
                conn.execute(
                    'DELETE FROM tasks WHERE recurrence_source_id = ? AND user_id = ? AND id != ?',
                    (source_id, user_id, task_id),
                )
                conn.execute('UPDATE tasks SET recurrence_rule = NULL WHERE id = ? AND user_id = ?',
                             (source_id, user_id))
                conn.execute(
                    'UPDATE tasks SET recurrence_source_id = NULL, recurrence_rule = NULL '
                    'WHERE id = ? AND user_id = ?', (task_id, user_id),
                )
                conn.commit()
                return JSONResponse({'success': True})

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
        if description_provided:
            updates.append('description = ?')
            params.append(description or None)
        params.extend([task_id, user_id])
        conn.execute(f'UPDATE tasks SET {", ".join(updates)} WHERE id = ? AND user_id = ?', params)

        if GOOGLE_CALENDAR_ENABLED:
            task = conn.execute(
                'SELECT google_event_id, scheduled_start, scheduled_end, recurrence_rule, description '
                'FROM tasks WHERE id = ? AND user_id = ?', (task_id, user_id),
            ).fetchone()
            if task and task['google_event_id']:
                try:
                    service, cal_id = gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import update_calendar_event
                        update_calendar_event(
                            service, cal_id, task['google_event_id'], text,
                            task['scheduled_start'], task['scheduled_end'],
                            task['recurrence_rule'], task['description'],
                        )
                except Exception:
                    logger.error('Failed to sync task update to Google Calendar', exc_info=True)

        conn.commit()

    return JSONResponse({'success': True})


@router.delete('/api/tasks/{task_id}')
async def api_delete_task(task_id: str, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        if GOOGLE_CALENDAR_ENABLED:
            task = conn.execute(
                'SELECT google_event_id FROM tasks WHERE id = ? AND user_id = ?',
                (task_id, user_id),
            ).fetchone()
            if task and task['google_event_id']:
                try:
                    service, cal_id = gcal_service(conn, user_id)
                    if service:
                        from BACKEND.google_calendar import delete_calendar_event
                        delete_calendar_event(service, cal_id, task['google_event_id'])
                except Exception:
                    logger.error('Failed to sync task deletion to Google Calendar', exc_info=True)
                conn.execute(
                    'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                    (user_id, task['google_event_id']),
                )

            cascade_ids = [
                r['id'] for r in conn.execute(
                    'SELECT id FROM tasks WHERE (recurrence_source_id = ? OR parent_id = ?) '
                    'AND user_id = ? AND google_event_id IS NOT NULL',
                    (task_id, task_id, user_id),
                ).fetchall()
            ]
            if cascade_ids:
                gcal_delete_tasks(conn, user_id, cascade_ids)
                for cid in cascade_ids:
                    row = conn.execute('SELECT google_event_id FROM tasks WHERE id = ?',
                                       (cid,)).fetchone()
                    if row and row['google_event_id']:
                        conn.execute(
                            'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                            (user_id, row['google_event_id']),
                        )

        conn.execute('DELETE FROM tasks WHERE recurrence_source_id = ? AND user_id = ?',
                     (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE parent_id = ? AND user_id = ?',
                     (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?',
                     (task_id, user_id))
        conn.commit()

    return JSONResponse({'success': True})


@router.post('/api/tasks/{task_id}/breakdown')
async def api_breakdown_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?',
                            (task_id, user_id)).fetchone()
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
        service, cal_id = (None, None)
        if GOOGLE_CALENDAR_ENABLED:
            try:
                service, cal_id = gcal_service(conn, user_id)
            except Exception:
                logger.error('Failed to init GCal service for breakdown', exc_info=True)

        for st in subtasks_data:
            sub_id, xp = new_task_id()
            text = st.get('text', '') if isinstance(st, dict) else str(st)
            google_event_id = None
            if service:
                try:
                    from BACKEND.google_calendar import create_calendar_event
                    google_event_id = create_calendar_event(
                        service, cal_id, text,
                        task['scheduled_start'], task['scheduled_end'], None, None,
                    )
                except Exception:
                    logger.error('Failed to sync breakdown subtask to Google Calendar', exc_info=True)
            conn.execute(
                'INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end, '
                'parent_id, google_event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (sub_id, user_id, text, xp, task['scheduled_start'], task['scheduled_end'],
                 task_id, google_event_id),
            )
            created.append({
                'id': sub_id, 'text': text, 'xp': xp,
                'scheduled_start': task['scheduled_start'], 'scheduled_end': task['scheduled_end'],
                'parent_id': task_id,
            })
        conn.commit()

    return JSONResponse({'success': True, 'subtasks': created})


@router.post('/api/tasks/{task_id}/complete')
async def api_complete_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?',
                            (task_id, user_id)).fetchone()
        if not task:
            return error_response('Task not found', 404)
        if task['completed_at']:
            return error_response('Task already completed', 400)

        data = await parse_json(request)
        r = complete_task_logic(conn, user_id, task, data.get('combo', 0))

        media = conn.execute('SELECT media_type, filename FROM task_media WHERE task_id = ?',
                             (task_id,)).fetchone()
        extra_data = json.dumps({
            'media_type': media['media_type'],
            'media_url': f"/UPLOADS/{media['filename']}",
        }) if media else None
        conn.execute(
            'INSERT INTO activity_log (user_id, activity_type, task_text, xp_earned, extra_data, task_id) '
            "VALUES (?, 'task_completed', ?, ?, ?, ?)",
            (user_id, task['text'], r['xp_earned'], extra_data, task_id),
        )

        if GOOGLE_CALENDAR_ENABLED and task['google_event_id']:
            try:
                service, cal_id = gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import delete_calendar_event
                    delete_calendar_event(service, cal_id, task['google_event_id'])
            except Exception:
                logger.error('Failed to delete calendar event on task completion', exc_info=True)
            conn.execute(
                'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                (user_id, task['google_event_id']),
            )

        completed_at = datetime.utcnow().isoformat()
        conn.execute('UPDATE tasks SET completed_at = ? WHERE id = ?', (completed_at, task_id))
        conn.commit()

    return JSONResponse({
        'success': True, 'xpEarned': r['xp_earned'], 'level': r['level'],
        'xp': r['xp'], 'xpMax': r['xp_max'], 'completed': r['completed'],
        'streak': r['streak'], 'combo': r['combo'],
        'leveledUp': r['leveled_up'], 'newAchievements': r['new_achievements'],
        'completed_at': completed_at,
    })


@router.post('/api/tasks/{task_id}/uncomplete')
async def api_uncomplete_task(task_id: str, request: Request, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?',
                            (task_id, user_id)).fetchone()
        if not task:
            return error_response('Task not found', 404)
        if not task['completed_at']:
            return error_response('Task is not completed', 400)

        log_entry = conn.execute(
            "SELECT id, xp_earned FROM activity_log "
            "WHERE user_id = ? AND activity_type = 'task_completed' AND task_id = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (user_id, task_id),
        ).fetchone()
        xp_to_remove = log_entry['xp_earned'] if log_entry else task['xp_reward']

        if log_entry:
            conn.execute('DELETE FROM activity_log WHERE id = ?', (log_entry['id'],))

        progress = get_or_create_progress(conn, user_id)
        new_completed = max(0, progress['completed_tasks'] - 1)
        new_xp = progress['xp'] - xp_to_remove
        new_level = progress['level']
        new_xp_max = progress['xp_max']

        while new_xp < 0 and new_level > 1:
            new_level -= 1
            new_xp_max = int(100 * math.pow(1.2, new_level - 1))
            new_xp += new_xp_max
        new_xp = max(0, new_xp)
        if new_level <= 1:
            new_xp_max = 100

        conn.execute(
            'UPDATE user_progress SET level=?, xp=?, xp_max=?, completed_tasks=? WHERE user_id=?',
            (new_level, new_xp, new_xp_max, new_completed, user_id),
        )
        conn.execute('UPDATE tasks SET completed_at = NULL WHERE id = ?', (task_id,))

        if GOOGLE_CALENDAR_ENABLED and task['scheduled_start'] and task['scheduled_end']:
            try:
                service, cal_id = gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import create_calendar_event
                    new_event_id = create_calendar_event(
                        service, cal_id, task['text'],
                        task['scheduled_start'], task['scheduled_end'],
                        task['recurrence_rule'],
                    )
                    if new_event_id:
                        conn.execute('UPDATE tasks SET google_event_id = ? WHERE id = ?',
                                     (new_event_id, task_id))
                    if task['google_event_id']:
                        conn.execute(
                            'DELETE FROM gcal_deleted_events WHERE user_id = ? AND google_event_id = ?',
                            (user_id, task['google_event_id']),
                        )
            except Exception:
                logger.error('Failed to recreate calendar event on task uncomplete', exc_info=True)

        conn.commit()
        progress = get_or_create_progress(conn, user_id)

    return JSONResponse({
        'success': True, 'completed': progress['completed_tasks'],
        'level': progress['level'], 'xp': progress['xp'], 'xpMax': progress['xp_max'],
    })


@router.get('/api/history')
async def api_history(user_id: int = Depends(get_authenticated_user), limit: int = 100, offset: int = 0):
    with get_db() as conn:
        rows = conn.execute(
            'SELECT activity_type, task_text, xp_earned, created_at '
            'FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            (user_id, limit, offset),
        ).fetchall()
        return JSONResponse({'history': [
            {'type': r['activity_type'], 'text': r['task_text'],
             'points': r['xp_earned'], 'timestamp': r['created_at']}
            for r in rows
        ]})


@router.post('/api/combo/reset')
async def api_reset_combo(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        conn.execute('UPDATE user_progress SET combo = 0 WHERE user_id = ?', (user_id,))
        conn.commit()
    return JSONResponse({'success': True})
