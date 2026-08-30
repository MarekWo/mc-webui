/**
 * Geographic Coordinate Utilities
 *
 * Advert positions arrive from the mesh unvalidated, and a corrupted packet
 * can carry a latitude of 1642 or a longitude of -1768. A single such entry
 * poisons a whole map: Leaflet clamps latitude when projecting but not
 * longitude, so fitBounds() zooms out to the entire world and pushes every
 * real marker off-screen.
 *
 * The server drops such values on write and on API output (see app/geo.py);
 * this is the last line of defence, and the single place where "does this
 * contact have a usable position?" is answered for every map in the app.
 */

const GEO_MAX_LAT = 90;
const GEO_MAX_LON = 180;

/**
 * True when value is a finite number within +/-limit degrees.
 * @param {*} value
 * @param {number} limit
 * @returns {boolean}
 */
function isValidCoord(value, limit) {
    if (value === null || value === undefined || value === '') return false;
    const num = Number(value);
    return Number.isFinite(num) && Math.abs(num) <= limit;
}

/**
 * True when an object carries a usable advert position.
 *
 * Rejects missing values, non-finite values, coordinates outside the
 * geographic range, and the zero placeholder. A zero in either component
 * means "no fix" - firmware sends 0/0 for a node without GPS, and a
 * genuine node sitting exactly on the equator or the prime meridian to six
 * decimal places does not happen in practice.
 *
 * @param {Object} obj - contact / repeater / neighbour entry
 * @param {string} [latKey='adv_lat']
 * @param {string} [lonKey='adv_lon']
 * @returns {boolean}
 */
function hasValidGps(obj, latKey, lonKey) {
    if (!obj) return false;
    const lat = obj[latKey || 'adv_lat'];
    const lon = obj[lonKey || 'adv_lon'];
    if (!isValidCoord(lat, GEO_MAX_LAT) || !isValidCoord(lon, GEO_MAX_LON)) return false;
    return Number(lat) !== 0 && Number(lon) !== 0;
}

/**
 * True when a [lat, lon] pair is safe to hand to Leaflet.
 * @param {Array} point
 * @returns {boolean}
 */
function isValidLatLng(point) {
    return Array.isArray(point) && point.length >= 2 &&
        isValidCoord(point[0], GEO_MAX_LAT) && isValidCoord(point[1], GEO_MAX_LON);
}

/**
 * Filter a list down to entries with a usable advert position.
 * @param {Array} list
 * @param {string} [latKey]
 * @param {string} [lonKey]
 * @returns {Array}
 */
function withValidGps(list, latKey, lonKey) {
    return (list || []).filter(item => hasValidGps(item, latKey, lonKey));
}

/**
 * Fit a Leaflet map to a list of [lat, lon] points, skipping any that would
 * distort the view. Returns false when nothing could be fitted, so callers
 * can fall back to their own default view.
 *
 * @param {L.Map} map
 * @param {Array<Array<number>>} points
 * @param {Object} [options] - padding, maxZoom, singleZoom
 * @returns {boolean}
 */
function fitMapToPoints(map, points, options) {
    const opts = options || {};
    if (!map) return false;

    const valid = (points || []).filter(isValidLatLng);
    if (valid.length === 0) return false;

    if (valid.length === 1) {
        map.setView(valid[0], opts.singleZoom || 13);
        return true;
    }

    const bounds = L.latLngBounds(valid);
    if (!bounds.isValid()) return false;

    map.fitBounds(bounds, {
        padding: opts.padding || [20, 20],
        maxZoom: opts.maxZoom || 16
    });
    return true;
}

// Export functions for use in other modules
window.GeoUtils = {
    isValidCoord,
    hasValidGps,
    isValidLatLng,
    withValidGps,
    fitMapToPoints
};
