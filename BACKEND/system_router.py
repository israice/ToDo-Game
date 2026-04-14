"""System routes: health, well-known, GitHub deploy webhook, dev file hash."""

import os
import json
import hmac
import hashlib
import subprocess
from datetime import datetime

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from SETTINGS import APP_DEBUG, BRANCH as DEFAULT_BRANCH
from BACKEND.core import logger, get_version, compute_files_hash, WEBHOOK_SECRET

router = APIRouter()

BRANCH = os.environ.get("BRANCH", DEFAULT_BRANCH)


@router.get('/.well-known/health')
async def health_check():
    return JSONResponse({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'version': get_version(),
    })


@router.get('/.well-known/{path:path}')
async def well_known(path: str):
    return Response(status_code=204)


if APP_DEBUG:
    @router.get('/api/files-hash')
    async def api_files_hash():
        css_hash, other_hash = compute_files_hash()
        return {'css': css_hash, 'other': other_hash}


def _graceful_reload():
    """Send SIGTERM to self so the container supervisor restarts us."""
    subprocess.Popen(
        ["python", "-c",
         f"import os, signal, time; time.sleep(0.5); os.kill({os.getpid()}, signal.SIGTERM)"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


@router.post('/webhook')
async def github_webhook(request: Request):
    """GitHub push webhook: pull latest code and graceful-restart."""
    body = await request.body()
    sig = request.headers.get("X-Hub-Signature-256", "")
    if not WEBHOOK_SECRET or not hmac.compare_digest(
        f"sha256={hmac.new(WEBHOOK_SECRET.encode(), body, hashlib.sha256).hexdigest()}", sig
    ):
        return Response(content="Forbidden", status_code=403)

    if request.headers.get("X-GitHub-Event") != "push":
        return Response(content="OK", status_code=200)

    payload = json.loads(body) if body else {}
    if payload.get("ref") != f"refs/heads/{BRANCH}":
        return Response(content="Ignored", status_code=200)

    logger.info("Webhook received - starting update...")

    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd="/app", capture_output=True, text=True)
    old_commit = result.stdout.strip() if result.returncode == 0 else None

    for cmd in [["git", "fetch", "origin"], ["git", "reset", "--hard", f"origin/{BRANCH}"]]:
        result = subprocess.run(cmd, cwd="/app", capture_output=True, text=True)
        if result.returncode != 0:
            logger.error(f"{cmd[1]} failed: {result.stderr}")
            return Response(content=f"Git {cmd[1]} failed", status_code=500)

    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd="/app", capture_output=True, text=True)
    new_commit = result.stdout.strip() if result.returncode == 0 else None

    if old_commit == new_commit:
        logger.info("No changes detected - skipping update")
        return Response(content="OK (no changes)", status_code=200)

    logger.info(f"Code updated: {old_commit[:7] if old_commit else 'unknown'} -> "
                f"{new_commit[:7] if new_commit else 'unknown'}")

    result = subprocess.run(
        ["git", "diff", "--name-only", old_commit, new_commit] if old_commit
        else ["git", "diff", "--name-only", "HEAD~1", "HEAD"],
        cwd="/app", capture_output=True, text=True,
    )
    changed_files = result.stdout.strip().split('\n') if result.stdout.strip() else []
    requirements_changed = 'requirements.txt' in changed_files
    bot_code_changed = any(f.startswith('BACKEND/TELEGRAM/') for f in changed_files)

    if requirements_changed:
        logger.info("requirements.txt changed - updating dependencies...")
        pip_result = subprocess.run(
            ["pip", "install", "--no-cache-dir", "-r", "requirements.txt"],
            cwd="/app", capture_output=True, text=True,
        )
        if pip_result.returncode != 0:
            logger.error(f"Pip install failed: {pip_result.stderr}")
        else:
            logger.info("Dependencies updated")
    else:
        logger.info("requirements.txt unchanged - skipping pip install")

    if bot_code_changed:
        logger.info("Telegram bot code changed - restarting...")
        try:
            env = os.environ.copy()
            env['DOCKER_API_VERSION'] = '1.44'
            dr = subprocess.run(
                ["docker", "restart", "todo-telegram-bot"],
                capture_output=True, text=True, timeout=30, env=env,
            )
            if dr.returncode == 0:
                logger.info("Telegram bot container restarted")
            else:
                logger.warning(f"Docker restart failed: {dr.stderr}")
        except FileNotFoundError:
            logger.warning("Docker CLI not available - bot will update on next manual restart")
        except subprocess.TimeoutExpired:
            logger.warning("Docker restart timeout")
        except Exception as e:
            logger.warning(f"Could not restart bot container: {e}")
    else:
        logger.info("Telegram bot code unchanged - skipping restart")

    logger.info("Sending SIGTERM for graceful shutdown...")
    _graceful_reload()

    return Response(content="OK", status_code=200)
