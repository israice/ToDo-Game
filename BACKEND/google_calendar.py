"""Google Calendar API helper functions for ToDo-Game integration."""

import logging
import uuid
from datetime import datetime, timezone, timedelta

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

SCOPES = ['https://www.googleapis.com/auth/calendar']


def get_google_credentials(conn, user_id, client_id, client_secret):
    """Build Credentials from stored tokens, auto-refreshing if expired."""
    row = conn.execute(
        'SELECT access_token, refresh_token, token_expiry FROM google_tokens WHERE user_id = ?',
        (user_id,)
    ).fetchone()
    if not row:
        return None

    creds = Credentials(
        token=row['access_token'],
        refresh_token=row['refresh_token'],
        token_uri='https://oauth2.googleapis.com/token',
        client_id=client_id,
        client_secret=client_secret,
        scopes=SCOPES,
    )

    if creds.expired and creds.refresh_token:
        from google.auth.transport.requests import Request
        creds.refresh(Request())
        conn.execute(
            'UPDATE google_tokens SET access_token = ?, token_expiry = ? WHERE user_id = ?',
            (creds.token, creds.expiry.isoformat() if creds.expiry else None, user_id)
        )
        conn.commit()

    return creds


def get_calendar_service(creds):
    """Build a Google Calendar API service object."""
    return build('calendar', 'v3', credentials=creds, cache_discovery=False)


def recurrence_rule_to_rrule(rule):
    """Convert our recurrence_rule JSON/dict to a Google Calendar RRULE string.

    Returns a list like ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR'] or [].
    """
    if not rule:
        return []
    if isinstance(rule, str):
        import json
        try:
            rule = json.loads(rule)
        except (json.JSONDecodeError, TypeError):
            return []

    freq_map = {'daily': 'DAILY', 'weekly': 'WEEKLY', 'monthly': 'MONTHLY', 'yearly': 'YEARLY'}
    freq = freq_map.get(rule.get('frequency'))
    if not freq:
        return []

    parts = [f'FREQ={freq}']

    interval = rule.get('interval', 1)
    if interval and interval > 1:
        parts.append(f'INTERVAL={interval}')

    # Weekly: BYDAY
    if freq == 'WEEKLY' and rule.get('weekdays'):
        day_names = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
        days = [day_names[d] for d in rule['weekdays'] if 0 <= d <= 6]
        if days:
            parts.append('BYDAY=' + ','.join(days))

    # Monthly: BYMONTHDAY
    if freq == 'MONTHLY' and rule.get('monthDay'):
        parts.append(f'BYMONTHDAY={rule["monthDay"]}')

    # End condition
    end_type = rule.get('endType', 'never')
    if end_type == 'count' and rule.get('endCount'):
        parts.append(f'COUNT={rule["endCount"]}')
    elif end_type == 'date' and rule.get('endDate'):
        # UNTIL format: YYYYMMDD
        parts.append('UNTIL=' + rule['endDate'].replace('-', '') + 'T235959Z')

    return ['RRULE:' + ';'.join(parts)]


def task_to_event(text, start_iso, end_iso, recurrence_rule=None):
    """Convert task data to a Google Calendar event dict."""
    event = {'summary': text}

    if start_iso:
        if len(start_iso) <= 10:
            event['start'] = {'date': start_iso}
        else:
            event['start'] = {'dateTime': start_iso, 'timeZone': 'UTC'}
    else:
        # Default: all-day event for today
        event['start'] = {'date': datetime.now(timezone.utc).strftime('%Y-%m-%d')}

    if end_iso:
        if len(end_iso) <= 10:
            event['end'] = {'date': end_iso}
        else:
            event['end'] = {'dateTime': end_iso, 'timeZone': 'UTC'}
    else:
        event['end'] = dict(event['start'])

    rrule = recurrence_rule_to_rrule(recurrence_rule)
    if rrule:
        event['recurrence'] = rrule

    return event


def create_calendar_event(service, calendar_id, text, start_iso, end_iso, recurrence_rule=None):
    """Create a new event in Google Calendar. Returns the event ID."""
    event = task_to_event(text, start_iso, end_iso, recurrence_rule)
    try:
        result = service.events().insert(calendarId=calendar_id, body=event).execute()
        return result.get('id')
    except Exception:
        logger.error('Failed to create calendar event', exc_info=True)
        return None


def update_calendar_event(service, calendar_id, event_id, text, start_iso, end_iso, recurrence_rule=None):
    """Update an existing event in Google Calendar."""
    event = task_to_event(text, start_iso, end_iso, recurrence_rule)
    try:
        service.events().update(calendarId=calendar_id, eventId=event_id, body=event).execute()
        return True
    except Exception:
        logger.error('Failed to update calendar event %s', event_id, exc_info=True)
        return False


def delete_calendar_event(service, calendar_id, event_id):
    """Delete an event from Google Calendar."""
    try:
        service.events().delete(calendarId=calendar_id, eventId=event_id).execute()
        return True
    except Exception as e:
        if '410' in str(e) or '404' in str(e):
            logger.info('Calendar event %s already deleted, skipping', event_id)
            return True
        logger.error('Failed to delete calendar event %s', event_id, exc_info=True)
        return False


def sync_calendar_events(service, calendar_id, sync_token=None):
    """Fetch changed events using incremental sync.

    Returns (events_list, new_sync_token, is_full_sync).
    """
    events = []
    page_token = None
    new_sync_token = None
    is_full_sync = sync_token is None

    try:
        while True:
            kwargs = {'calendarId': calendar_id, 'singleEvents': True, 'maxResults': 100}
            if sync_token and not is_full_sync:
                kwargs['syncToken'] = sync_token
            else:
                # Full sync: get events from 30 days ago to 30 days ahead
                kwargs['timeMin'] = (datetime.now(timezone.utc) - timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
                kwargs['timeMax'] = (datetime.now(timezone.utc) + timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%SZ')
            if page_token:
                kwargs['pageToken'] = page_token

            result = service.events().list(**kwargs).execute()
            events.extend(result.get('items', []))
            page_token = result.get('nextPageToken')
            if not page_token:
                new_sync_token = result.get('nextSyncToken')
                break

    except Exception as e:
        from google.auth.exceptions import RefreshError
        if isinstance(e, RefreshError):
            raise  # Let caller handle expired/revoked tokens
        error_str = str(e)
        if '410' in error_str or 'Gone' in error_str:
            # syncToken invalidated, do full sync
            logger.info('Sync token expired, performing full sync')
            return sync_calendar_events(service, calendar_id, sync_token=None)
        logger.error('Failed to sync calendar events', exc_info=True)
        return [], None, is_full_sync

    return events, new_sync_token, is_full_sync


def parse_event_times(event):
    """Extract start and end ISO strings from a Google Calendar event."""
    start = event.get('start', {})
    end = event.get('end', {})
    start_iso = start.get('dateTime') or start.get('date')
    end_iso = end.get('dateTime') or end.get('date')
    return start_iso, end_iso


def strip_prefix(summary):
    """Return event summary as-is (kept for API compatibility)."""
    return summary or ''


def watch_calendar(service, calendar_id, webhook_url):
    """Register a push notification channel for calendar events.

    Returns (channel_id, resource_id, expiration_ms) or None on failure.
    The channel expires in ~7 days (Google maximum).
    """
    channel_id = str(uuid.uuid4())
    # Request expiration slightly under 7 days to renew before it lapses
    expiration = int((datetime.now(timezone.utc) + timedelta(days=6, hours=23)).timestamp() * 1000)
    body = {
        'id': channel_id,
        'type': 'web_hook',
        'address': webhook_url,
        'expiration': expiration,
    }
    try:
        result = service.events().watch(calendarId=calendar_id, body=body).execute()
        return result['id'], result['resourceId'], int(result.get('expiration', expiration))
    except Exception:
        logger.error('Failed to register calendar watch', exc_info=True)
        return None


def stop_watch(service, channel_id, resource_id):
    """Stop an existing push notification channel."""
    try:
        service.channels().stop(body={'id': channel_id, 'resourceId': resource_id}).execute()
    except Exception:
        logger.error('Failed to stop calendar watch channel %s', channel_id, exc_info=True)
