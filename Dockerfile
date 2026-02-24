FROM python:3.12-slim

RUN apt-get update && apt-get install -y git curl && \
    curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-29.2.1.tgz | \
    tar -xz -C /usr/local/bin/ --strip-components=1 docker/docker && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

EXPOSE 5000

CMD ["python", "server.py"]
