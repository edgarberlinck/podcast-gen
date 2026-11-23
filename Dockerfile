FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.171.0 \
    && npm cache clean --force

WORKDIR /app

COPY app.py codex_audio.py narration.py transistor.py ./
COPY static/ ./static/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CODEX_BIN=codex \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=8000 \
    STUDIO_DATA_DIR=/app/data

EXPOSE 8000

CMD ["python3", "app.py"]
