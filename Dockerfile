# mc-webui v2 Dockerfile
# Single container with direct MeshCore device access (serial/TCP)

FROM python:3.11-slim

# Install system deps: curl (healthcheck), udev (serial), bluez+dbus (BLE)
RUN apt-get update && apt-get install -y \
    curl \
    udev \
    bluez \
    dbus \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
# Note: Run 'python -m app.version freeze' before build to include version info
COPY app/ ./app/

# Expose Flask port
EXPOSE 5000

# Environment variables (can be overridden by docker-compose)
ENV FLASK_HOST=0.0.0.0
ENV FLASK_PORT=5000
ENV FLASK_DEBUG=false

# Entrypoint: disconnect stale BLE connections before starting the app.
# BlueZ auto-reconnects trusted devices, leaving stale GATT notification
# handles that block bleak from establishing a new session.
COPY scripts/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["python", "-m", "app.main"]
