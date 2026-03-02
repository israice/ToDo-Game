FROM python:3.12-slim

# Install dependencies in one layer for better caching
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    unzip \
    && curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-29.2.1.tgz | \
    tar -xz -C /usr/local/bin/ --strip-components=1 docker/docker \
    && curl -fsSL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v1.1.0/bws-x86_64-unknown-linux-gnu-1.1.0.zip" \
    -o /tmp/bws.zip && unzip /tmp/bws.zip -d /usr/local/bin/ && chmod +x /usr/local/bin/bws && rm /tmp/bws.zip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for better layer caching
COPY requirements.txt .

# Pre-install dependencies (will be cached if requirements.txt unchanged)
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create data directory and migrate old data if exists
RUN mkdir -p /app/DATA/UPLOADS && \
    ( [ -f /app/users.db ] && mv /app/users.db /app/DATA/ || true ) && \
    ( [ -d /app/uploads ] && mv /app/uploads /app/DATA/UPLOADS/ || true ) && \
    chmod -R 755 /app/DATA

EXPOSE 5000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsSL http://localhost:5000/.well-known/health || exit 1

CMD ["uvicorn", "run:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*", "--log-level", "info"]
