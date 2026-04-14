"""Telegram bot API (token-authenticated)."""

from datetime import datetime, timedelta

from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse

from BACKEND.core import (
    logger, get_db, parse_json, get_token_authenticated_user,
    validate_task_text, new_task_id,
    get_or_create_progress, apply_xp, complete_task_logic,
    GOOGLE_CALENDAR_ENABLED,
)
from BACKEND.gcal_helpers import gcal_service

router = APIRouter(prefix='/api/bot')


@router.get('/tasks')
async def bot_get_tasks(user_id: int = Depends(get_token_authenticated_user)):
    with get_db() as conn:
        tasks = conn.execute(
            'SELECT id, text, xp_reward, completed_at, parent_id FROM tasks '
            'WHERE user_id = ? ORDER BY created_at DESC', (user_id,),
        ).fetchall()
        return JSONResponse({
            'success': True,
            'tasks': [{'id': t['id'], 'text': t['text'], 'xp': t['xp_reward'],
                       'completed_at': t['completed_at'], 'parent_id': t['parent_id']}
                      for t in tasks],
        })


@router.post('/tasks/add')
async def bot_add_task(request: Request, user_id: int = Depends(get_token_authenticated_user)):
    data = await parse_json(request)
    text, err = validate_task_text(data)
    if err: return err

    task_id, xp = new_task_id()
    now_iso = datetime.utcnow().isoformat()
    scheduled_start = data.get('scheduled_start') or now_iso
    scheduled_end = data.get('scheduled_end') or now_iso
    from dateutil.parser import parse as dt_parse
    s, e = dt_parse(scheduled_start), dt_parse(scheduled_end)
    if s > e:
        scheduled_end = (s + timedelta(minutes=15)).isoformat()

    with get_db() as conn:
        conn.execute(
            'INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (task_id, user_id, text, xp, scheduled_start, scheduled_end),
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
                        service, cal_id, text, scheduled_start, scheduled_end, None,
                    )
                    if google_event_id:
                        conn.execute('UPDATE tasks SET google_event_id = ? WHERE id = ?',
                                     (google_event_id, task_id))
            except Exception:
                logger.error('Failed to sync bot task to Google Calendar', exc_info=True)

        conn.commit()

    return JSONResponse({
        'success': True,
        'task': {'id': task_id, 'text': text, 'xp': xp},
        'xpEarned': 3, 'level': new_level, 'leveledUp': leveled_up,
    })


@router.post('/tasks/{task_id}/complete')
async def bot_complete_task(task_id: str, request: Request, user_id: int = Depends(get_token_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT * FROM tasks WHERE id = ? AND user_id = ?',
                            (task_id, user_id)).fetchone()
        if not task:
            return JSONResponse({'success': False, 'error': 'Task not found'}, status_code=404)
        if task['completed_at']:
            return JSONResponse({'success': False, 'error': 'Task already completed'}, status_code=400)

        r = complete_task_logic(conn, user_id, task)

        if GOOGLE_CALENDAR_ENABLED and task['google_event_id']:
            try:
                service, cal_id = gcal_service(conn, user_id)
                if service:
                    from BACKEND.google_calendar import delete_calendar_event
                    delete_calendar_event(service, cal_id, task['google_event_id'])
            except Exception:
                logger.error('Failed to delete calendar event on bot task completion', exc_info=True)
            conn.execute(
                'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                (user_id, task['google_event_id']),
            )

        completed_at = datetime.utcnow().isoformat()
        conn.execute('UPDATE tasks SET completed_at = ? WHERE id = ?', (completed_at, task_id))
        conn.commit()

    return JSONResponse({
        'success': True, 'xpEarned': r['xp_earned'], 'level': r['level'],
        'leveledUp': r['leveled_up'],
    })


@router.post('/tasks/{task_id}/delete')
async def bot_delete_task(task_id: str, user_id: int = Depends(get_token_authenticated_user)):
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
                    logger.error('Failed to sync bot task deletion to Google Calendar', exc_info=True)
                conn.execute(
                    'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                    (user_id, task['google_event_id']),
                )

            for inst in conn.execute(
                'SELECT google_event_id FROM tasks WHERE recurrence_source_id = ? '
                'AND user_id = ? AND google_event_id IS NOT NULL',
                (task_id, user_id),
            ).fetchall():
                conn.execute(
                    'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                    (user_id, inst['google_event_id']),
                )

        conn.execute('DELETE FROM tasks WHERE recurrence_source_id = ? AND user_id = ?',
                     (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE parent_id = ? AND user_id = ?',
                     (task_id, user_id))
        conn.execute('DELETE FROM tasks WHERE id = ? AND user_id = ?',
                     (task_id, user_id))
        conn.commit()

    return JSONResponse({'success': True})


@router.post('/tasks/{task_id}/rename')
async def bot_rename_task(task_id: str, request: Request, user_id: int = Depends(get_token_authenticated_user)):
    data = await parse_json(request)
    text, err = validate_task_text(data)
    if err: return err

    with get_db() as conn:
        conn.execute('UPDATE tasks SET text = ? WHERE id = ? AND user_id = ?',
                     (text, task_id, user_id))

        if GOOGLE_CALENDAR_ENABLED:
            task = conn.execute(
                'SELECT google_event_id, scheduled_start, scheduled_end, recurrence_rule '
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
                            task['recurrence_rule'],
                        )
                except Exception:
                    logger.error('Failed to sync bot task rename to Google Calendar', exc_info=True)

        conn.commit()

    return JSONResponse({'success': True})
