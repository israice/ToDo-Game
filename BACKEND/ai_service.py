import json
import httpx
from SETTINGS import GROQ_API_KEY, GROQ_MODEL

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

BREAKDOWN_SYSTEM = """You are a task breakdown assistant. Given a task, break it down into exactly 3 concise actionable steps.
Return a JSON object with a "subtasks" key containing an array of objects, each with "text" (task description).
Example: {{"subtasks": [{{"text": "Buy groceries"}}, {{"text": "Cook dinner"}}, {{"text": "Set the table"}}]}}
Always return exactly 3 sub-tasks. Keep them concise and actionable."""


async def _call_groq(system: str, user: str) -> str:
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY is not set")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            GROQ_URL,
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0.7,
                "max_tokens": 1024,
                "response_format": {"type": "json_object"},
            },
        )
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"]


def _parse_json(text: str):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        text = text.rsplit("```", 1)[0]
    return json.loads(text.strip())


async def breakdown_task(task_text: str) -> list[dict]:
    result = await _call_groq(BREAKDOWN_SYSTEM, task_text)
    parsed = _parse_json(result)
    if isinstance(parsed, list):
        return parsed[:3]
    if isinstance(parsed, dict) and "subtasks" in parsed:
        return parsed["subtasks"][:3]
    return [parsed]
