"""
Coordinate sanitation for advert-sourced positions.

Regression cover for a tester's blank contacts map (2026-08-28): two corrupted
adverts in a 2861-contact cache carried latitudes of 1642 and 309 and
longitudes of -323 and -1768. Leaflet clamps latitude when projecting but not
longitude, so fitBounds() spanned 1797 degrees, dropped to zoom 0 and pushed
all 2273 real markers off-screen.

Run: python -m pytest tests/test_geo.py -v
"""

import tempfile
from pathlib import Path

import pytest

from app.database import Database
from app.geo import (
    MAX_LAT,
    MAX_LON,
    is_valid_contact_type,
    sanitize_contact_latlon,
    sanitize_latlon,
    scrub_geo,
)


@pytest.fixture
def db():
    with tempfile.TemporaryDirectory() as tmp:
        yield Database(Path(tmp) / 'test.db')


# ================================================================
# sanitize_latlon
# ================================================================

class TestSanitizeLatLon:

    @pytest.mark.parametrize('lat,lon', [
        (50.866005, 20.669308),
        (0.0, 0.0),                 # "no fix" placeholder is in range, callers filter it
        (MAX_LAT, MAX_LON),
        (-MAX_LAT, -MAX_LON),
    ])
    def test_valid_pairs_survive(self, lat, lon):
        assert sanitize_latlon(lat, lon) == (lat, lon)

    @pytest.mark.parametrize('lat,lon', [
        (1642.584589, -323.210017),     # 'j000' - the REP that blanked the map
        (309.480255, -1768.532171),     # 'Supreme-PL-WAW' - the COM that blanked the map
        (-495.68555, -1192.263528),
        (90.000001, 20.0),
        (50.0, 180.000001),
        (float('nan'), 20.0),
        (float('inf'), 20.0),
        (50.0, float('-inf')),
    ])
    def test_out_of_range_is_dropped(self, lat, lon):
        assert sanitize_latlon(lat, lon) == (None, None)

    @pytest.mark.parametrize('lat,lon', [
        (None, None),
        (50.0, None),               # half a position is not a position
        (None, 20.0),
        ('abc', 20.0),
        (object(), 20.0),
    ])
    def test_unusable_input_yields_none_pair(self, lat, lon):
        assert sanitize_latlon(lat, lon) == (None, None)

    def test_numeric_strings_are_accepted(self):
        assert sanitize_latlon('50.5', '21.5') == (50.5, 21.5)

    def test_logs_what_it_drops(self, caplog):
        with caplog.at_level('WARNING'):
            assert sanitize_contact_latlon(1642.58, -323.21, label='j000') == (None, None)
        assert 'j000' in caplog.text

    def test_silent_when_nothing_to_drop(self, caplog):
        with caplog.at_level('WARNING'):
            sanitize_contact_latlon(50.0, 20.0, label='ok')
            sanitize_contact_latlon(None, None, label='no position')
        assert caplog.text == ''


# ================================================================
# scrub_geo (API output)
# ================================================================

class TestScrubGeo:

    def test_nulls_out_of_range_pair(self):
        payload = {'name': 'j000', 'adv_lat': 1642.58, 'adv_lon': -323.21}
        assert scrub_geo(payload) == {'name': 'j000', 'adv_lat': None, 'adv_lon': None}

    def test_leaves_valid_pair_alone(self):
        payload = {'name': 'ok', 'adv_lat': 50.1, 'adv_lon': 20.2}
        assert scrub_geo(dict(payload)) == payload

    def test_does_not_invent_keys(self):
        assert scrub_geo({'name': 'no position'}) == {'name': 'no position'}

    def test_honours_custom_keys(self):
        payload = {'lat': 1994.5, 'lon': 1118.9}
        assert scrub_geo(payload, 'lat', 'lon') == {'lat': None, 'lon': None}


# ================================================================
# Contact type
# ================================================================

class TestContactType:

    @pytest.mark.parametrize('value', [0, 1, 2, 3, 4])
    def test_known_types(self, value):
        assert is_valid_contact_type(value)

    @pytest.mark.parametrize('value', [42, 61, 126, 152, 210, -1, None, 'REP', True, 2.0])
    def test_corrupted_types(self, value):
        assert not is_valid_contact_type(value)


# ================================================================
# Write path
# ================================================================

class TestUpsertContact:

    def test_garbage_coordinates_never_reach_the_cache(self, db):
        db.upsert_contact('AA' * 32, name='j000', type=2,
                          adv_lat=1642.584589, adv_lon=-323.210017)
        row = db.get_contact('aa' * 32)
        assert row['adv_lat'] is None and row['adv_lon'] is None
        assert row['name'] == 'j000'          # the contact itself is still kept

    def test_valid_coordinates_are_stored(self, db):
        db.upsert_contact('BB' * 32, name='ok', type=2, adv_lat=50.5, adv_lon=21.5)
        row = db.get_contact('bb' * 32)
        assert (row['adv_lat'], row['adv_lon']) == (50.5, 21.5)

    def test_corrupted_advert_does_not_erase_a_known_position(self, db):
        pk = 'CC' * 32
        db.upsert_contact(pk, name='ok', type=2, adv_lat=50.5, adv_lon=21.5)
        db.upsert_contact(pk, name='ok', type=2, adv_lat=1642.5, adv_lon=-323.2)
        row = db.get_contact(pk.lower())
        assert (row['adv_lat'], row['adv_lon']) == (50.5, 21.5)

    def test_corrupted_type_is_kept_but_flagged(self, db, caplog):
        with caplog.at_level('WARNING'):
            db.upsert_contact('DD' * 32, name='LANDA 2 R', type=61,
                              adv_lat=542.26, adv_lon=1163.55)
        row = db.get_contact('dd' * 32)
        assert row['type'] == 61              # raw value preserved as evidence
        assert row['adv_lat'] is None
        assert 'LANDA 2 R' in caplog.text
