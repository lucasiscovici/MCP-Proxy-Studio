FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    MCP_DASH_DATA=/data/flows.json \
    PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

WORKDIR /app

# System deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates git golang curl gnupg supervisor \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt && pip install --no-cache-dir uv

# Install Go mcp-proxy CLI (pinning recommended via build arg later)
RUN GO111MODULE=on GOBIN=/usr/local/bin go install github.com/TBXark/mcp-proxy@latest

# App code
COPY backend ./backend
COPY frontend ./frontend

RUN mkdir -p /data

EXPOSE 8000 8001 8002 8003 6274 6277

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
