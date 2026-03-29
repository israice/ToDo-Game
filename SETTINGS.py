import os

API_URL = "http://localhost:5000"
APP_DEBUG = True
PORT = 5000
REPO_URL = "https://github.com/israice/ToDo-Game.git"
BRANCH = "master"
GOOGLE_CALENDAR_SYNC_INTERVAL = 5
INSTANCE_ROLE = "primary"  # "primary" = prod (push + incremental), "replica" = dev (polling + full sync)

# Drum (3D carousel) settings
DRUM_ROW_HEIGHT = 50        # row height in px (packing density on the drum)
DRUM_MAX_TOP_ANGLE = 30     # max angle for outermost row (degrees) — higher = more curvature
DRUM_PERSPECTIVE_K = 3      # perspective = k * radius — higher = flatter look
DRUM_HIGHLIGHT_OFFSET = 1   # rows above center for highlighted task on large screens

# Groq AI settings
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
