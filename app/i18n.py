"""
UI internationalization — catalog loading, language resolution, translation helpers.

Design notes:
- Catalogs are flat JSON: {"namespace.area.element": "text"}. A dict value is always a
  plural form ({"one": ..., "other": ...}), never a nested namespace.
- Two sources: built-in (app/translations/) and an admin drop-in directory
  ($MC_CONFIG_DIR/translations/) which wins. Adding a language needs no restart.
- Catalogs are merged over en.json server-side, so the JS runtime needs no fallback logic.
- The backend stays English: this module translates the UI only, never API responses.
"""

import hashlib
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Callable, Optional

from flask import current_app, request
from markupsafe import Markup, escape

from .config import config

logger = logging.getLogger(__name__)

BUILTIN_DIR = Path(__file__).parent / 'translations'
DEFAULT_LANG = 'en'

# Language codes we are willing to touch the filesystem for. Guards the catalog route
# against path traversal before any path join happens.
LANG_RE = re.compile(r'^[a-z]{2}(-[A-Z]{2})?$')

# Only {word} is a placeholder. A bare "{" before punctuation is left alone, so strings
# like "set {name} <value>" survive. Deliberately not str.format: catalogs are
# community-supplied data, and str.format on untrusted data leaks globals.
PARAM_RE = re.compile(r'\{(\w+)\}')

CLDR_CATEGORIES = {'zero', 'one', 'two', 'few', 'many', 'other'}

# Caches, each keyed on a cheap stat() fingerprint of the files behind them.
_catalog_cache: dict[str, tuple[tuple, dict, str, bytes]] = {}  # lang -> (stamp, catalog, hash, js)
_languages_cache: Optional[tuple[tuple, dict[str, str]]] = None
_warned_keys: set[str] = set()


# ---------------------------------------------------------------------------
# Paths and filesystem fingerprinting
# ---------------------------------------------------------------------------

def override_dir() -> Path:
    """Admin drop-in directory. Mounted as /data/translations in Docker."""
    return Path(config.MC_CONFIG_DIR) / 'translations'


def _candidate_paths(lang: str) -> list[Path]:
    """Files that contribute to `lang`, most significant first."""
    paths = [override_dir() / f'{lang}.json', BUILTIN_DIR / f'{lang}.json']
    if lang != DEFAULT_LANG:
        paths += [override_dir() / f'{DEFAULT_LANG}.json', BUILTIN_DIR / f'{DEFAULT_LANG}.json']
    return paths


def _stat_stamp(paths) -> tuple:
    """Cheap fingerprint so a dropped-in file is picked up without a restart."""
    out = []
    for p in paths:
        try:
            st = os.stat(p)
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


# ---------------------------------------------------------------------------
# Catalog loading
# ---------------------------------------------------------------------------

def _read_catalog_file(path: Path) -> dict[str, Any]:
    """
    Read and validate one catalog file.

    A malformed community catalog must never take the app down — log and return empty.
    """
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as e:
        logger.warning(f"Ignoring translation catalog {path}: {e}")
        return {}

    if not isinstance(data, dict):
        logger.warning(f"Ignoring translation catalog {path}: top level is not an object")
        return {}

    clean: dict[str, Any] = {}
    for key, value in data.items():
        if not isinstance(key, str):
            continue
        if isinstance(value, str):
            clean[key] = value
        elif isinstance(value, dict) and all(
            isinstance(k, str) and k in CLDR_CATEGORIES and isinstance(v, str)
            for k, v in value.items()
        ):
            clean[key] = value
        else:
            logger.warning(f"Ignoring key '{key}' in {path}: value must be a string or plural object")
    return clean


def _load(lang: str) -> tuple[dict, str, bytes]:
    """
    Return (catalog, hash8, js_body) for `lang`, rebuilding only when a file changed.

    The catalog is en.json overlaid by the target language, so per-key English fallback
    is baked in here and the JS runtime never needs to think about it.
    """
    paths = _candidate_paths(lang)
    stamp = _stat_stamp(paths)

    cached = _catalog_cache.get(lang)
    if cached and cached[0] == stamp:
        return cached[1], cached[2], cached[3]

    # Least significant first, so more significant sources overwrite.
    catalog: dict[str, Any] = {}
    for path in reversed(paths):
        catalog.update(_read_catalog_file(path))

    payload = json.dumps(catalog, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    js = f'window.MC_LANG={json.dumps(lang)};window.MC_I18N={payload};'.encode('utf-8')
    hash8 = hashlib.sha256(js).hexdigest()[:8]

    _catalog_cache[lang] = (stamp, catalog, hash8, js)
    return catalog, hash8, js


def get_catalog(lang: str) -> dict[str, Any]:
    return _load(lang)[0]


def get_catalog_js(lang: str) -> tuple[str, bytes]:
    """Return (hash8, js_body) for the catalog route."""
    _, hash8, js = _load(lang)
    return hash8, js


def catalog_url(lang: str) -> str:
    """Content-hashed URL. Hash lives in the path, not a query string, so intermediary
    caches and the service worker bust reliably."""
    _, hash8, _ = _load(lang)
    return f'/i18n/{lang}.{hash8}.js'


# ---------------------------------------------------------------------------
# Language discovery
# ---------------------------------------------------------------------------

def available_languages() -> dict[str, str]:
    """
    Map language code -> display name, e.g. {'en': 'English', 'pl': 'Polski'}.

    The display name comes from `meta.language_name` inside each catalog, so a community
    hu.json shows up as "Magyar" with no code change anywhere.
    """
    global _languages_cache

    dirs = [override_dir(), BUILTIN_DIR]
    stamp = _stat_stamp(dirs)
    if _languages_cache and _languages_cache[0] == stamp:
        return _languages_cache[1]

    codes: set[str] = set()
    for directory in dirs:
        try:
            entries = list(directory.glob('*.json'))
        except OSError:
            continue
        for entry in entries:
            if LANG_RE.match(entry.stem):
                codes.add(entry.stem)

    langs: dict[str, str] = {}
    for code in sorted(codes):
        # Read the language's own files, not the en-merged catalog: a catalog that is
        # malformed or empty contributes nothing and must not be offered in the picker,
        # where it would look like a real language but render as pure English.
        own: dict[str, Any] = {}
        for path in (BUILTIN_DIR / f'{code}.json', override_dir() / f'{code}.json'):
            own.update(_read_catalog_file(path))
        if not own:
            continue

        name = own.get('meta.language_name')
        langs[code] = name if isinstance(name, str) and name else code

    if DEFAULT_LANG not in langs:
        # Built-in en.json is missing or unreadable; keep the app usable regardless.
        langs[DEFAULT_LANG] = 'English'

    _languages_cache = (stamp, langs)
    return langs


def clear_cache() -> None:
    """Drop every cache. Backs POST /api/i18n/reload, for filesystems whose mtime
    granularity is too coarse for the stat fingerprint to notice a change."""
    global _languages_cache
    _catalog_cache.clear()
    _languages_cache = None
    _warned_keys.clear()


# ---------------------------------------------------------------------------
# Language resolution
# ---------------------------------------------------------------------------

LANG_COOKIE = 'mc_lang'


def _server_default_lang() -> Optional[str]:
    try:
        settings = current_app.db.get_setting_json('ui_settings', {}) or {}
        value = settings.get('language')
        return value if isinstance(value, str) else None
    except Exception:
        return None


def resolve_lang() -> str:
    """
    Per-browser cookie wins over the server-wide default from the database.

    Deliberately no Accept-Language sniffing: this is a single-admin appliance, and
    auto-detection means the admin sets Polish and then sees German on their phone.
    """
    langs = available_languages()

    cookie = request.cookies.get(LANG_COOKIE) if request else None
    if cookie in langs:
        return cookie

    saved = _server_default_lang()
    if saved in langs:
        return saved

    return DEFAULT_LANG


# ---------------------------------------------------------------------------
# Plural categories
# ---------------------------------------------------------------------------

_SLAVIC_4FORM = {'pl'}


def plural_category(lang: str, count: int) -> str:
    """
    CLDR cardinal category for server-side rendering.

    Only en-like and pl are implemented exactly; anything else falls back to one/other,
    which is correct for de/es and near enough for fr. The JS side uses real
    Intl.PluralRules, so client-rendered plurals are always right — prefer putting
    plurals there. See docs/translations.md.
    """
    base = lang.split('-')[0]

    if base in _SLAVIC_4FORM:
        if count == 1:
            return 'one'
        mod10, mod100 = abs(count) % 10, abs(count) % 100
        if 2 <= mod10 <= 4 and not 12 <= mod100 <= 14:
            return 'few'
        return 'many'

    return 'one' if count == 1 else 'other'


# ---------------------------------------------------------------------------
# Translation helpers
# ---------------------------------------------------------------------------

def _interpolate(text: str, params: dict) -> str:
    """Substitute {name} placeholders. An unknown placeholder is left verbatim so it is
    visible in the UI rather than silently swallowed."""
    if not params or '{' not in text:
        return text
    return PARAM_RE.sub(lambda m: str(params.get(m.group(1), m.group(0))), text)


def _lookup(catalog: dict, key: str) -> Any:
    value = catalog.get(key)
    if value is None:
        if key not in _warned_keys:
            _warned_keys.add(key)
            logger.warning(f"Missing translation key: {key}")
        return None
    return value


def _resolve(catalog: dict, lang: str, key: str, count: Optional[int]) -> str:
    """Return the raw catalog string for `key`, or the key itself when missing.

    A missing key rendering as its own dotted name is deliberate: it is unmistakable in
    the UI and greppable in a screenshot.
    """
    value = _lookup(catalog, key)
    if value is None:
        return key
    if isinstance(value, str):
        return value

    category = plural_category(lang, count if count is not None else 1)
    return value.get(category) or value.get('other') or value.get('one') or key


def make_helpers(lang: str) -> dict[str, Callable]:
    """Build the t/t_html/tn callables bound to one language, for inject_globals()."""
    catalog = get_catalog(lang)

    def t(key: str, /, **params) -> str:
        """Translate to a plain string.

        Returns str, NOT Markup — Jinja's autoescape handles escaping at the insertion
        point. Escaping here would double-escape and render every French apostrophe
        as &#39;.
        """
        return _interpolate(_resolve(catalog, lang, key, None), params)

    def t_html(key: str, /, **params) -> Markup:
        """Translate a string that carries markup (<b>, <a>).

        Markup in the catalog is trusted (the admin installed the file); params are
        escaped individually, so interpolated user data can never inject HTML.
        """
        text = _resolve(catalog, lang, key, None)
        return Markup(_interpolate(text, {k: str(escape(v)) for k, v in params.items()}))

    def tn(key: str, count: int, /, **params) -> str:
        """Translate with a plural form. {count} is injected automatically."""
        text = _resolve(catalog, lang, key, count)
        return _interpolate(text, {'count': count, **params})

    return {'t': t, 't_html': t_html, 'tn': tn}
