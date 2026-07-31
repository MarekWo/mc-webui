"""
Translation catalog delivery.

The catalog is served as a blocking script rather than fetched, so window.t exists
before any page script runs. It cannot live under /static because admin-supplied
catalogs are outside the image, in $MC_CONFIG_DIR/translations/.
"""

import logging

from flask import Blueprint, Response, abort, jsonify

from app import i18n

logger = logging.getLogger(__name__)

i18n_bp = Blueprint('i18n', __name__)


@i18n_bp.route('/i18n/<path:filename>')
def catalog_js(filename: str):
    """
    Serve a language catalog as JavaScript.

    URL shape: /i18n/<lang>.<hash8>.js — the content hash is in the path, so the
    response can be immutable and the service worker can cache-first it safely.
    The hash is not verified: any hash for a known language returns the current
    catalog, which is what makes a dropped-in file appear on the next refresh.
    """
    if not filename.endswith('.js'):
        abort(404)

    # "<lang>.<hash8>.js" -> lang. Reject anything else before touching the filesystem.
    parts = filename[:-3].split('.')
    if len(parts) != 2:
        abort(404)

    lang = parts[0]
    if not i18n.LANG_RE.match(lang) or lang not in i18n.available_languages():
        abort(404)

    hash8, body = i18n.get_catalog_js(lang)

    resp = Response(body, mimetype='application/javascript')
    resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    resp.headers['ETag'] = f'"{hash8}"'
    resp.charset = 'utf-8'
    return resp


@i18n_bp.route('/api/i18n/reload', methods=['POST'])
def reload_catalogs():
    """
    Drop the catalog caches.

    Normally unnecessary — catalogs are fingerprinted with stat() on every render, so a
    dropped-in file is live on the next refresh. This covers network filesystems whose
    mtime granularity is too coarse for that to work.
    """
    try:
        i18n.clear_cache()
        langs = i18n.available_languages()
        logger.info(f"Translation catalogs reloaded: {', '.join(sorted(langs))}")
        return jsonify({'success': True, 'languages': langs}), 200
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
