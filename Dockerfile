# mc-webui Dockerfile
# Python 3.11+ with Flask and meshcore-cli

FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Install meshcore-cli
RUN pip install --no-cache-dir meshcore-cli

# Copy application code
COPY app/ ./app/

# Expose Flask port
EXPOSE 5000

# Environment variables (can be overridden by docker-compose)
ENV FLASK_HOST=0.0.0.0
ENV FLASK_PORT=5000
ENV FLASK_DEBUG=false

# Run the application
CMD ["python", "-m", "app.main"]
