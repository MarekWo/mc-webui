"""
In-memory ring buffer log handler with WebSocket broadcast.

Captures Python log records into a fixed-size deque and optionally
broadcasts them to connected SocketIO clients in real-time.
"""

import logging
from collections import deque
from datetime import datetime
from threading import Lock


class MemoryLogHandler(logging.Handler):
    """Logging handler that stores records in a ring buffer and broadcasts via SocketIO."""

    def __init__(self, capacity=2000, socketio=None):
        super().__init__()
        self.capacity = capacity
        self.buffer = deque(maxlen=capacity)
        self.socketio = socketio
        self._lock = Lock()
        self._seq = 0  # monotonic sequence for client catch-up

    def emit(self, record):
        try:
            entry = self._format_record(record)
            with self._lock:
                self._seq += 1
                entry['seq'] = self._seq
                self.buffer.append(entry)

            # Broadcast to connected clients
            if self.socketio:
                self.socketio.emit('log_entry', entry, namespace='/logs')
        except Exception:
            self.handleError(record)

    def _format_record(self, record):
        """Convert LogRecord to a serializable dict."""
        return {
            'timestamp': datetime.fromtimestamp(record.created).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3],
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
        }

    def get_entries(self, level=None, logger_filter=None, search=None, limit=None):
        """Return filtered log entries from the buffer.

        Args:
            level: Minimum log level name (DEBUG, INFO, WARNING, ERROR, CRITICAL)
            logger_filter: Logger name prefix filter (e.g. 'app.device_manager')
            search: Text search in message (case-insensitive)
            limit: Max entries to return (newest first before limit, returned in chronological order)

        Returns:
            List of log entry dicts
        """
        level_num = getattr(logging, level.upper(), 0) if level else 0
        search_lower = search.lower() if search else None

        with self._lock:
            entries = list(self.buffer)

        # Apply filters
        if level_num > 0:
            entries = [e for e in entries if getattr(logging, e['level'], 0) >= level_num]
        if logger_filter:
            entries = [e for e in entries if e['logger'].startswith(logger_filter)]
        if search_lower:
            entries = [e for e in entries if search_lower in e['message'].lower()]

        # Limit (return newest N, in chronological order)
        if limit and limit > 0 and len(entries) > limit:
            entries = entries[-limit:]

        return entries

    def get_loggers(self):
        """Return sorted list of unique logger names seen in the buffer."""
        with self._lock:
            loggers = sorted({e['logger'] for e in self.buffer})
        return loggers
