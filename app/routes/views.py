"""
HTML views for mc-webui
"""

import os
import time
import logging
from flask import Blueprint, render_template, request, jsonify
from app.config import config, runtime_config

logger = logging.getLogger(__name__)

views_bp = Blueprint('views', __name__)

# Thresholds for the strict health check (used by the external watchdog).
# Kept as module constants so they can be tuned without code review.
HEALTH_STRICT_MAX_RX_STALE_SEC = 300        # >5 min since last RX event → unhealthy
HEALTH_STRICT_MAX_STATS_FAILURES = 5        # ≥5 consecutive get_stats/battery failures → unhealthy


@views_bp.route('/')
def index():
    """
    Main chat view - displays message list and send form.
    """
    return render_template(
        'index.html',
        device_name=runtime_config.get_device_name()
    )


@views_bp.route('/dm')
def direct_messages():
    """
    Direct Messages view - full-page DM interface.

    Query params:
        conversation: Optional conversation ID to open initially
    """
    initial_conversation = request.args.get('conversation', '')

    return render_template(
        'dm.html',
        device_name=runtime_config.get_device_name(),
        initial_conversation=initial_conversation
    )


@views_bp.route('/contacts/manage')
def contact_management():
    """
    Contact Management Settings - manual approval + cleanup + navigation.
    """
    return render_template(
        'contacts-manage.html',
        device_name=runtime_config.get_device_name()
    )


@views_bp.route('/contacts/add')
def contact_add():
    """
    Add Contact page - URI paste, QR scan, manual fields.
    """
    return render_template(
        'contacts-add.html',
        device_name=runtime_config.get_device_name()
    )


@views_bp.route('/contacts/pending')
def contact_pending_list():
    """
    Full-screen pending contacts list.
    """
    return render_template(
        'contacts-pending.html',
        device_name=runtime_config.get_device_name()
    )


@views_bp.route('/contacts/existing')
def contact_existing_list():
    """
    Full-screen existing contacts list with search, filter, sort.
    """
    return render_template(
        'contacts-existing.html',
        device_name=runtime_config.get_device_name()
    )


@views_bp.route('/console')
def console():
    """
    Interactive meshcli console - chat-style command interface.

    WebSocket connection is handled by the main Flask app and proxied to bridge.
    """
    return render_template(
        'console.html',
        device_name=runtime_config.get_device_name()
    )


@views_bp.route('/repeaters')
def repeaters():
    """My Repeaters - repeater administration panel (list + login)."""
    return render_template(
        'repeaters.html',
        device_name=runtime_config.get_device_name()
    )


@views_bp.route('/logs')
def logs():
    """System log viewer - real-time log streaming with filters."""
    return render_template('logs.html')


@views_bp.route('/health')
def health():
    """Health check endpoint for monitoring.

    Returns 503 when BLE reconnection has permanently failed so Docker's
    healthcheck triggers a container restart (which clears all BLE state).
    """
    from flask import current_app
    dm = getattr(current_app, 'device_manager', None)
    if dm and getattr(dm, '_ble_permanently_failed', False):
        return 'BLE connection permanently failed', 503
    return 'OK', 200


@views_bp.route('/health/strict')
def health_strict():
    """Stricter device-health check for the external watchdog.

    Returns 503 when:
      - BLE reconnection has permanently failed (same as /health), or
      - The device is connected but has produced N consecutive stats/battery
        failures (firmware/USB stalled), or
      - The device is connected via USB and we haven't received any RX event
        in HEALTH_STRICT_MAX_RX_STALE_SEC seconds.

    The watchdog uses this to catch "sluggish" failures the regular /health
    endpoint can't see. Returns 200 otherwise. Always returns JSON so the
    caller can log the specific reason.
    """
    from flask import current_app
    dm = getattr(current_app, 'device_manager', None)
    if dm is None:
        return jsonify({'status': 'ok', 'reason': 'no_device_manager'}), 200

    if getattr(dm, '_ble_permanently_failed', False):
        return jsonify({'status': 'fail', 'reason': 'ble_permanent_failure'}), 503

    if not getattr(dm, 'is_connected', False):
        # Don't fail strict on "not yet connected" — let DM keep retrying.
        return jsonify({'status': 'ok', 'reason': 'not_connected'}), 200

    failures = getattr(dm, '_consecutive_stats_failures', 0)
    if failures >= HEALTH_STRICT_MAX_STATS_FAILURES:
        return jsonify({
            'status': 'fail',
            'reason': 'consecutive_stats_failures',
            'count': failures,
        }), 503

    transport = getattr(config, 'transport_type', 'serial')
    last_rx = getattr(dm, '_last_rx_at', 0.0) or 0.0
    # TCP included: long-lived TCP to meshcore-proxy can degrade in ways the
    # socket can't detect (commands time out while events still trickle in or
    # vice versa). rx_stale is the cheapest external symptom.
    if transport in ('serial', 'usb', 'tcp') and last_rx > 0:
        stale = time.time() - last_rx
        if stale > HEALTH_STRICT_MAX_RX_STALE_SEC:
            return jsonify({
                'status': 'fail',
                'reason': 'rx_stale',
                'seconds_since_last_rx': int(stale),
            }), 503

    return jsonify({
        'status': 'ok',
        'consecutive_stats_failures': failures,
        'seconds_since_last_rx': int(time.time() - last_rx) if last_rx else None,
    }), 200
