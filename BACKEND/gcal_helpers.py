"""Google Calendar sync helpers.

Pure functions used by both task routes (push local changes to gcal)
and the background sync loop (pull remote changes). No routes here —
those live in gcal_router.py.
"""

import asyncio
from datetime import datetime, timedelta

from SETTINGS import MAX_DESCRIPTION_LENGTH
from BACKEND.core import (
    logger, get_db, new_task_id,
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALENDAR_ENABLED,
)


def gcal_service(conn, user_id):
    """Return (service, calendar_id) or (None, None) if not connected."""
    from BACKEND.google_calendar import get_google_credentials, get_calendar_service
    creds = get_google_credentials(conn, user_id, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
    if not creds:
        return None, None
    service = get_calendar_service(creds)
    cal_row = conn.execute(
        'SELECT calendar_id FROM google_tokens WHERE user_id = ?', (user_id,)
    ).fetchone()
    cal_id = cal_row['calendar_id'] if cal_row else 'primary'
    return service, cal_id


def gcal_delete_tasks(conn, user_id, task_ids):
    """Delete GCal events for given local task IDs and record them as deleted."""
    if not GOOGLE_CALENDAR_ENABLED or not task_ids:
        return
    ph = ','.join('?' * len(task_ids))
    rows = conn.execute(
        f'SELECT id, google_event_id FROM tasks WHERE id IN ({ph}) AND google_event_id IS NOT NULL',
        task_ids,
    ).fetchall()
    if not rows:
        return
    try:
        service, cal_id = gcal_service(conn, user_id)
        if service:
            from BACKEND.google_calendar import delete_calendar_event
            for r in rows:
                try:
                    delete_calendar_event(service, cal_id, r['google_event_id'])
                except Exception:
                    pass
                conn.execute(
                    'INSERT OR IGNORE INTO gcal_deleted_events (user_id, google_event_id) VALUES (?,?)',
                    (user_id, r['google_event_id']),
                )
    except Exception:
        logger.error('Failed to sync task deletion to Google Calendar', exc_info=True)


def process_sync_events(conn, user_id, events):
    """Apply incoming gcal events to local tasks (create/update/delete)."""
    from BACKEND.google_calendar import parse_event_times, strip_prefix

    for event in events:
        event_id = event.get('id')
        summary = event.get('summary', '')
        status = event.get('status')

        existing_task = conn.execute(
            'SELECT id, text FROM tasks WHERE google_event_id = ? AND user_id = ?',
            (event_id, user_id),
        ).fetchone()

        if status == 'cancelled':
            if existing_task:
                conn.execute('DELETE FROM tasks WHERE id = ?', (existing_task['id'],))
                conn.commit()
            continue

        start_iso, end_iso = parse_event_times(event)
        text = strip_prefix(summary)
        description = (event.get('description') or '')[:MAX_DESCRIPTION_LENGTH] or None
        recurring_event_id = event.get('recurringEventId')
        if not text:
            continue

        # 30-day horizon for new events
        if start_iso and not existing_task:
            horizon = (datetime.utcnow() + timedelta(days=30)).isoformat() + 'Z'
            if start_iso > horizon:
                continue

        # Resolve recurrence parent via google_event_id lookup
        local_recurrence_source = None
        if recurring_event_id:
            parent_row = conn.execute(
                'SELECT id FROM tasks WHERE google_event_id = ? AND user_id = ?',
                (recurring_event_id, user_id),
            ).fetchone()
            if parent_row:
                local_recurrence_source = parent_row['id']

        if existing_task:
            conn.execute(
                'UPDATE tasks SET text = ?, scheduled_start = ?, scheduled_end = ?, '
                'description = ?, recurrence_source_id = COALESCE(?, recurrence_source_id) '
                'WHERE id = ?',
                (text, start_iso, end_iso, description, local_recurrence_source, existing_task['id']),
            )
            conn.commit()
        elif start_iso and end_iso:
            was_deleted = conn.execute(
                'SELECT 1 FROM gcal_deleted_events WHERE user_id=? AND google_event_id=?',
                (user_id, event_id),
            ).fetchone()
            if was_deleted:
                continue

            task_id, xp = new_task_id()
            conn.execute(
                'INSERT INTO tasks (id, user_id, text, xp_reward, scheduled_start, scheduled_end, '
                'google_event_id, is_gcal_sourced, description, recurrence_source_id) '
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (task_id, user_id, text, xp, start_iso, end_iso, event_id, '1',
                 description, local_recurrence_source),
            )
            conn.commit()


async def do_calendar_sync_for_user(user_id, sync_token, calendar_id, instance_role):
    """Incremental sync for a single user (triggered by push notification)."""
    from BACKEND.google_calendar import (
        get_google_credentials, get_calendar_service, sync_calendar_events,
    )
    try:
        with get_db() as conn:
            creds = get_google_credentials(conn, user_id, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
            if not creds:
                return

        service = await asyncio.to_thread(get_calendar_service, creds)
        effective_token = None if instance_role != 'primary' else sync_token
        events, new_token, _ = await asyncio.to_thread(
            sync_calendar_events, service, calendar_id, effective_token
        )

        if not events and not new_token:
            return

        with get_db() as conn:
            process_sync_events(conn, user_id, events)
            if new_token and instance_role == 'primary':
                conn.execute(
                    'UPDATE google_tokens SET sync_token = ?, last_sync_at = ? WHERE user_id = ?',
                    (new_token, datetime.now().isoformat(), user_id),
                )
                conn.commit()
    except Exception:
        logger.error('Calendar push sync failed for user %d', user_id, exc_info=True)


async def do_calendar_sync(instance_role, app_url):
    """One round of background sync + watch channel management."""
    from BACKEND.google_calendar import (
        get_google_credentials, get_calendar_service, sync_calendar_events,
        watch_calendar, stop_watch,
    )

    webhook_url = (app_url.rstrip('/') + '/api/google/webhook') if app_url and instance_role == 'primary' else ''

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

            # Renew watch channel if push enabled
            if webhook_url and instance_role == 'primary':
                watch_exp = int(user_row['watch_expiration'] or 0)
                if not user_row['watch_channel_id'] or watch_exp - now_ms < 3600_000:
                    if user_row['watch_channel_id'] and user_row['watch_resource_id']:
                        await asyncio.to_thread(
                            stop_watch, service, user_row['watch_channel_id'], user_row['watch_resource_id']
                        )
                    result = await asyncio.to_thread(watch_calendar, service, calendar_id, webhook_url)
                    if result:
                        ch_id, res_id, exp_ms = result
                        with get_db() as conn:
                            conn.execute(
                                'UPDATE google_tokens SET watch_channel_id=?, watch_resource_id=?, '
                                'watch_expiration=? WHERE user_id=?',
                                (ch_id, res_id, str(exp_ms), user_id),
                            )
                            conn.commit()
                        logger.info('Registered calendar watch for user %d (expires %s)',
                                    user_id, datetime.fromtimestamp(exp_ms / 1000).isoformat())

            effective_token = None if instance_role != 'primary' else sync_token
            events, new_token, _ = await asyncio.to_thread(
                sync_calendar_events, service, calendar_id, effective_token
            )

            if not events and not new_token:
                continue

            with get_db() as conn:
                process_sync_events(conn, user_id, events)
                conn.execute(
                    "DELETE FROM gcal_deleted_events WHERE deleted_at < datetime('now', '-90 days')"
                )
                conn.commit()
                if new_token and instance_role == 'primary':
                    conn.execute(
                        'UPDATE google_tokens SET sync_token = ?, last_sync_at = ? WHERE user_id = ?',
                        (new_token, datetime.now().isoformat(), user_id),
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


async def calendar_sync_loop(instance_role, app_url, poll_interval):
    """Background loop: register/renew watch channels, poll events as fallback."""
    if not GOOGLE_CALENDAR_ENABLED:
        return
    use_push = bool(app_url and instance_role == 'primary')
    interval = 300 if use_push else poll_interval
    logger.warning('Calendar sync: role=%s, push=%s, interval=%ds', instance_role, use_push, interval)
    while True:
        try:
            await do_calendar_sync(instance_role, app_url)
        except Exception:
            logger.error('Calendar sync loop error', exc_info=True)
        await asyncio.sleep(interval)
