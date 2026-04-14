"""Google Calendar OAuth, status, disconnect, and push webhook.

Instance role and APP_URL are imported at module load — they affect the
background sync loop which is started from run.py.
"""

import asyncio

from fastapi import APIRouter, Request, Depends, Response
from fastapi.responses import JSONResponse, RedirectResponse

from BACKEND.core import (
    logger, get_db, error_response, get_authenticated_user,
    GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI,
    GOOGLE_CALENDAR_ENABLED, INSTANCE_ROLE,
)
from BACKEND.gcal_helpers import do_calendar_sync_for_user

router = APIRouter()

# In-memory store for PKCE code verifiers (session cookie too small)
_pkce_verifiers: dict[int, str] = {}


def _google_client_config():
    return {'web': {
        'client_id': GOOGLE_CLIENT_ID,
        'client_secret': GOOGLE_CLIENT_SECRET,
        'auth_uri': 'https://accounts.google.com/o/oauth2/auth',
        'token_uri': 'https://oauth2.googleapis.com/token',
        'redirect_uris': [GOOGLE_REDIRECT_URI],
    }}


@router.get('/auth/google/connect')
async def google_connect(request: Request, user_id: int = Depends(get_authenticated_user)):
    if not GOOGLE_CALENDAR_ENABLED:
        return error_response('Google Calendar integration is not configured', 400)
    from google_auth_oauthlib.flow import Flow
    flow = Flow.from_client_config(
        _google_client_config(),
        scopes=['https://www.googleapis.com/auth/calendar'],
        redirect_uri=GOOGLE_REDIRECT_URI,
    )
    auth_url, _state = flow.authorization_url(
        access_type='offline',
        prompt='consent',
        state=str(user_id),
    )
    _pkce_verifiers[user_id] = flow.code_verifier
    return RedirectResponse(auth_url)


@router.get('/auth/google/callback')
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


@router.post('/api/google/disconnect')
async def google_disconnect(user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        row = conn.execute(
            'SELECT watch_channel_id, watch_resource_id FROM google_tokens WHERE user_id = ?',
            (user_id,),
        ).fetchone()
        if row and row['watch_channel_id'] and row['watch_resource_id']:
            try:
                from BACKEND.google_calendar import (
                    get_google_credentials, get_calendar_service, stop_watch,
                )
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


@router.get('/api/google/status')
async def google_status(user_id: int = Depends(get_authenticated_user)):
    if not GOOGLE_CALENDAR_ENABLED:
        return JSONResponse({'connected': False, 'available': False})
    with get_db() as conn:
        row = conn.execute('SELECT user_id FROM google_tokens WHERE user_id = ?',
                           (user_id,)).fetchone()
        if not row:
            return JSONResponse({'connected': False, 'available': True})
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


@router.post('/api/google/webhook')
async def google_calendar_webhook(request: Request):
    """Receive push notifications from Google Calendar."""
    if INSTANCE_ROLE != 'primary':
        return Response(status_code=200)
    channel_id = request.headers.get("X-Goog-Channel-ID", "")
    resource_state = request.headers.get("X-Goog-Resource-State", "")

    if resource_state == "sync":
        return Response(status_code=200)
    if not channel_id:
        return Response(status_code=400)

    with get_db() as conn:
        row = conn.execute(
            'SELECT user_id, sync_token, calendar_id FROM google_tokens WHERE watch_channel_id = ?',
            (channel_id,),
        ).fetchone()

    if not row:
        return Response(status_code=404)

    logger.info('Calendar push notification for user %d (state: %s)', row['user_id'], resource_state)
    asyncio.create_task(do_calendar_sync_for_user(
        row['user_id'], row['sync_token'], row['calendar_id'] or 'primary', INSTANCE_ROLE,
    ))
    return Response(status_code=200)
