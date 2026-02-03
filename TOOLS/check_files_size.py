from pathlib import Path

ROOT_DIR = Path(".")
MIN_LINES = 250
EXCLUDED_DIRS = """
    .build_cache
    .git
    png
    jpg
    webm
    ZIP
    __pycache__
    python
""".split()

EXCLUDED_EXTENSIONS = ".png .md .jpg".split()

for path in ROOT_DIR.rglob("*"):
    # пропускаем файлы внутри исключённых директорий
    if any(part in EXCLUDED_DIRS for part in path.parts):
        continue

    # пропускаем файлы по расширению
    if path.suffix.lower() in EXCLUDED_EXTENSIONS:
        continue

    if path.is_file():
        try:
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                line_count = sum(1 for _ in f)

            if line_count > MIN_LINES:
                print(f"{path} : {line_count}")
        except OSError:
            pass
