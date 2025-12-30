"""
HTML views for mc-webui
"""

import logging
from flask import Blueprint, render_template, request
from app.config import config

logger = logging.getLogger(__name__)

views_bp = Blueprint('views', __name__)


@views_bp.route('/')
def index():
    """
    Main chat view - displays message list and send form.
    """
    return render_template(
        'index.html',
        device_name=config.MC_DEVICE_NAME,
        refresh_interval=config.MC_REFRESH_INTERVAL
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
        device_name=config.MC_DEVICE_NAME,
        refresh_interval=config.MC_REFRESH_INTERVAL,
        initial_conversation=initial_conversation
    )


@views_bp.route('/contacts/manage')
def contact_management():
    """
    Contact Management view - manual approval settings and pending contacts list.
    """
    return render_template(
        'contacts.html',
        device_name=config.MC_DEVICE_NAME,
        refresh_interval=config.MC_REFRESH_INTERVAL
    )


@views_bp.route('/health')
def health():
    """
    Health check endpoint for monitoring.
    """
    return 'OK', 200
