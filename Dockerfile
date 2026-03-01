# mc-webui v2 Dockerfile
# Single container with direct MeshCore device access (serial/TCP)

FROM python:3.11-slim

# Install system deps: curl (healthcheck), udev (serial device support)
RUN apt-get update && apt-get install -y \
    curl \
    udev \
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

# Run the application
CMD ["python", "-m", "app.main"]
