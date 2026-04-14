"""FastAPI entrypoint.

This file is intentionally thin: it wires up middleware, templates,
static files, the background calendar sync loop, and includes all
routers from BACKEND/. All business logic lives in BACKEND/*.
"""

import os
import asyncio
import logging
import warnings

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from dotenv import load_dotenv
import uvicorn

# Silence dependency warnings before any library imports
warnings.filterwarnings('ignore')
os.environ['PYTHONWARNINGS'] = 'ignore'

load_dotenv()

# Load secrets from Bitwarden (may override .env)
from BACKEND.bws_loader import load_bws_secrets
load_bws_secrets()

from SETTINGS import (
    APP_DEBUG, PORT, GOOGLE_CALENDAR_SYNC_INTERVAL,
    DRUM_ROW_HEIGHT, DRUM_MAX_TOP_ANGLE, DRUM_PERSPECTIVE_K, DRUM_HIGHLIGHT_OFFSET,
    ACCENT_PRIMARY, ACCENT_FIRE,
)

from BACKEND.core import (
    logger, SECRET_KEY, templates, init_db, get_version,
    APP_URL, GOOGLE_CLIENT_ID, GOOGLE_CALENDAR_ENABLED, INSTANCE_ROLE,
)
from BACKEND.gcal_helpers import calendar_sync_loop
from BACKEND.auth_router import router as auth_router
from BACKEND.tasks_router import router as tasks_router
from BACKEND.bot_router import router as bot_router
from BACKEND.media_router import router as media_router
from BACKEND.friends_router import router as friends_router
from BACKEND.gcal_router import router as gcal_router
from BACKEND.system_router import router as system_router


# ============== Logging ==============

class IgnoreWellKnown(logging.Filter):
    def filter(self, record):
        return '/.well-known/' not in record.getMessage()

logging.getLogger('uvicorn.access').addFilter(IgnoreWellKnown())


# ============== App ==============

app = FastAPI()

# Middleware (last added = outermost)
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)


class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        return response


app.add_middleware(NoCacheMiddleware)


# ============== Routers ==============

app.include_router(system_router)
app.include_router(auth_router)
app.include_router(tasks_router)
app.include_router(bot_router)
app.include_router(media_router)
app.include_router(friends_router)
app.include_router(gcal_router)


# ============== Startup ==============

init_db()


@app.on_event('startup')
async def start_calendar_sync():
    logger.warning('Calendar startup: enabled=%s, role=%s, APP_URL=%s, CLIENT_ID=%s',
                   GOOGLE_CALENDAR_ENABLED, INSTANCE_ROLE, APP_URL, bool(GOOGLE_CLIENT_ID))
    asyncio.create_task(calendar_sync_loop(INSTANCE_ROLE, APP_URL, GOOGLE_CALENDAR_SYNC_INTERVAL))


# Template globals (available in all Jinja templates)
templates.env.globals['app_version'] = get_version()
templates.env.globals['drum_row_height'] = DRUM_ROW_HEIGHT
templates.env.globals['drum_max_top_angle'] = DRUM_MAX_TOP_ANGLE
templates.env.globals['drum_perspective_k'] = DRUM_PERSPECTIVE_K
templates.env.globals['drum_highlight_offset'] = DRUM_HIGHLIGHT_OFFSET
templates.env.globals['accent_primary'] = ACCENT_PRIMARY
templates.env.globals['accent_fire'] = ACCENT_FIRE
import time as _time
templates.env.globals['cache_bust'] = str(int(_time.time()))


# Static files (mount last so they don't shadow routes)
app.mount('/static', StaticFiles(directory='FRONTEND'), name='static')


if __name__ == '__main__':
    uvicorn.run(
        "run:app", host='127.0.0.1', port=PORT,
        reload=APP_DEBUG, reload_includes=['*.py'] if APP_DEBUG else None,
        proxy_headers=True, forwarded_allow_ips='*',
        ws_ping_interval=60, ws_ping_timeout=30,
    )
