FROM python:3.12-slim

# Install dependencies in one layer for better caching
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-29.2.1.tgz | \
    tar -xz -C /usr/local/bin/ --strip-components=1 docker/docker \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir gunicorn eventlet

WORKDIR /app

# Copy requirements first for better layer caching
COPY requirements.txt .

# Pre-install dependencies (will be cached if requirements.txt unchanged)
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create data directory and migrate old data if exists
RUN mkdir -p /app/data && \
    ( [ -f /app/users.db ] && mv /app/users.db /app/data/ || true ) && \
    ( [ -d /app/uploads ] && mv /app/uploads /app/data/ || true ) && \
    chmod -R 755 /app/data

EXPOSE 5000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsSL http://localhost:5000/.well-known/health || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--worker-class", "eventlet", "--capture-output", "--log-level", "info", "server:app"]
