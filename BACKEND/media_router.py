"""Task media upload/delete and file serving."""

import os
import uuid

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from fastapi.responses import JSONResponse, FileResponse

from BACKEND.core import (
    logger, get_db, error_response, get_authenticated_user,
    UPLOAD_FOLDER, ALLOWED_EXTENSIONS,
)

router = APIRouter()


@router.post('/api/tasks/{task_id}/media')
async def api_upload_media(task_id: str, file: UploadFile = File(...),
                           user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        task = conn.execute('SELECT id FROM tasks WHERE id = ? AND user_id = ?',
                            (task_id, user_id)).fetchone()
        if not task:
            return error_response('Task not found', 404)

        if not file.filename:
            return error_response('No file selected')

        ext = file.filename.rsplit('.', 1)[-1].lower() if '.' in file.filename else ''
        if ext not in ALLOWED_EXTENSIONS:
            return error_response('Invalid format')

        media_type = 'video' if ext in {'mp4', 'webm', 'mov'} else 'image'
        filename = f"{task_id}_{uuid.uuid4().hex[:8]}.{ext}"
        filepath = os.path.join(UPLOAD_FOLDER, filename)

        old_media = conn.execute('SELECT filename FROM task_media WHERE task_id = ?',
                                 (task_id,)).fetchone()
        if old_media:
            old_path = os.path.join(UPLOAD_FOLDER, old_media['filename'])
            if os.path.exists(old_path):
                os.remove(old_path)
            conn.execute('DELETE FROM task_media WHERE task_id = ?', (task_id,))

        contents = await file.read()
        try:
            with open(filepath, 'wb') as f:
                f.write(contents)
        except IOError:
            logger.error('Failed to write uploaded file: %s', filepath, exc_info=True)
            return error_response('Failed to save file', 500)

        conn.execute(
            'INSERT INTO task_media (task_id, user_id, media_type, filename) VALUES (?, ?, ?, ?)',
            (task_id, user_id, media_type, filename),
        )
        conn.commit()

    return JSONResponse({'success': True, 'media_type': media_type, 'url': f'/UPLOADS/{filename}'})


@router.delete('/api/tasks/{task_id}/media')
async def api_delete_media(task_id: str, user_id: int = Depends(get_authenticated_user)):
    with get_db() as conn:
        media = conn.execute(
            'SELECT filename FROM task_media WHERE task_id = ? AND user_id = ?',
            (task_id, user_id),
        ).fetchone()
        if not media:
            return error_response('Media not found', 404)

        filepath = os.path.join(UPLOAD_FOLDER, media['filename'])
        if os.path.exists(filepath):
            os.remove(filepath)

        conn.execute('DELETE FROM task_media WHERE task_id = ?', (task_id,))
        conn.commit()
    return JSONResponse({'success': True})


@router.get('/UPLOADS/{filename}')
async def serve_upload(filename: str):
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.realpath(filepath).startswith(os.path.realpath(UPLOAD_FOLDER)):
        raise HTTPException(status_code=403)
    if not os.path.exists(filepath):
        raise HTTPException(status_code=404)
    return FileResponse(filepath)
