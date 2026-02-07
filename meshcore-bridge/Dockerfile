# MeshCore Bridge Dockerfile
FROM python:3.11-slim

LABEL maintainer="mc-webui"
LABEL description="MeshCore CLI Bridge - HTTP API wrapper for meshcli"

WORKDIR /bridge

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install meshcore-cli (from PyPI)
RUN pip install --no-cache-dir meshcore-cli==1.3.21

# Copy bridge application
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY bridge.py .

# Expose bridge API port
EXPOSE 5001

# Run bridge
CMD ["python", "bridge.py"]
