"""
Coordinate sanity checks for advert-sourced positions.

Adverts arrive from the mesh unvalidated, and a corrupted packet can carry a
latitude of 1642 or a longitude of -1768. A single such row poisons every map
that includes it: Leaflet clamps latitude when projecting but not longitude,
so fitBounds() zooms out to the whole world and pushes every real marker
off-screen. Reported by a tester on 2026-08-28 - the cached-contacts map was
blank because two of 2131 cached contacts carried garbage coordinates.

Coordinates are therefore checked twice: on write, so the cache never stores
them again, and on API output, so a cache already poisoned by an older build
heals itself without a migration.

The JavaScript counterpart is static/js/geo-utils.js - keep the two in sync.
"""

import math
import logging
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

MAX_LAT = 90.0
MAX_LON = 180.0

# MeshCore advert types: 0=none, 1=chat/companion, 2=repeater, 3=room, 4=sensor.
# Anything else means the advert was corrupted in flight.
VALID_CONTACT_TYPES = frozenset((0, 1, 2, 3, 4))


def _coord(value: Any, limit: float) -> Optional[float]:
    """Return value as a float inside +/-limit, or None if it is unusable."""
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num) or abs(num) > limit:
        return None
    return num


def sanitize_latlon(lat: Any, lon: Any) -> Tuple[Optional[float], Optional[float]]:
    """
    Return (lat, lon) as floats, or (None, None) if either value is unusable.

    Both are dropped together on purpose: half a position is not a position,
    and leaving one component behind would still skew map bounds.
    """
    clean_lat = _coord(lat, MAX_LAT)
    clean_lon = _coord(lon, MAX_LON)
    if clean_lat is None or clean_lon is None:
        return None, None
    return clean_lat, clean_lon


def sanitize_contact_latlon(lat: Any, lon: Any, label: str = '') -> Tuple[Optional[float], Optional[float]]:
    """sanitize_latlon() that logs whatever it had to throw away."""
    clean_lat, clean_lon = sanitize_latlon(lat, lon)
    if clean_lat is None and (lat is not None or lon is not None):
        logger.warning(
            f"Dropping out-of-range advert coordinates for {label or 'contact'}: "
            f"lat={lat!r} lon={lon!r}"
        )
    return clean_lat, clean_lon


def is_valid_contact_type(value: Any) -> bool:
    """True for a MeshCore advert type we know how to render."""
    return isinstance(value, int) and not isinstance(value, bool) and value in VALID_CONTACT_TYPES


def scrub_geo(payload: Dict, lat_key: str = 'adv_lat', lon_key: str = 'adv_lon') -> Dict:
    """
    Null out unusable coordinates in an outgoing API payload (in place).

    Applied to every response that feeds a map, so a contact cached by an
    older build cannot blank the map it appears on. Keys the payload does not
    already carry are left alone.
    """
    if lat_key not in payload and lon_key not in payload:
        return payload
    lat, lon = sanitize_latlon(payload.get(lat_key), payload.get(lon_key))
    if lat_key in payload:
        payload[lat_key] = lat
    if lon_key in payload:
        payload[lon_key] = lon
    return payload
