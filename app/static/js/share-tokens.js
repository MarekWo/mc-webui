/**
 * Share Token Parsing and Serialization
 *
 * MeshCore clients share contacts, channels and positions as plain text inside
 * ordinary chat messages. Three wire formats exist and none of them is ours to
 * choose — they are what the official MeshCore app emits and parses, so this
 * module must stay byte-compatible with it:
 *
 *   contact   <64-hex-pubkey:type:name>
 *             A compact custom token, NOT a URI. The URI form below costs
 *             ~110+ bytes before the name, which overflows a 135-byte channel
 *             packet, so the app uses this shorter form when sharing in chat.
 *   channel   meshcore://channel/add?name=…&secret=…&region_scope=…
 *   location  bare "lat,lon" decimal degrees
 *
 * The `meshcore://contact/add?…` URI is parsed too (it is what QR codes and
 * "biz cards" carry) but never emitted, for the size reason above.
 *
 * Reference: MeshCore Core docs/qr_codes.md
 *
 * This file is pure logic: no DOM, no fetch. Rendering lives in
 * message-utils.js, actions in app.js / dm.js.
 */

(function (global) {
    'use strict';

    // Numeric contact types, per docs/qr_codes.md. Anything else is coerced to
    // COMPANION, matching the tolerance of the Python and JS URI parsers.
    var CONTACT_TYPES = { COMPANION: 1, REPEATER: 2, ROOM_SERVER: 3, SENSOR: 4 };

    /**
     * Compact contact token: <pubkey:type:name>
     * The pubkey (64 hex) and type (digits) are anchored, so a name containing
     * ':' still parses — everything up to the closing '>' is the name.
     */
    var CONTACT_TOKEN_RE = /<([0-9a-fA-F]{64}):(\d{1,2}):([^>\n]{1,120})>/g;

    /** meshcore:// URIs for contact and channel. */
    var MESHCORE_URI_RE = /meshcore:\/\/(contact|channel)\/add\?[^\s<>"']+/gi;

    /**
     * Bare "lat,lon" in decimal degrees.
     *
     * Deliberately narrow. A loose pattern would turn ordinary prose into
     * location cards: "1,5" or a version like "2,10" would both match. So both
     * numbers must carry a decimal point with at least 3 fractional digits,
     * and neither side may abut a word character or another dot — which rules
     * out matches inside longer numbers. Ranges are checked separately.
     */
    var LOCATION_RE = /(?<![\w.])(-?\d{1,2}\.\d{3,10})\s*,\s*(-?\d{1,3}\.\d{3,10})(?![\w.])/g;

    /** Any URL-ish run, used to keep coordinates inside links from matching. */
    var URL_SPAN_RE = /(?:https?|meshcore):\/\/[^\s<>"']+/gi;

    // ---------------------------------------------------------------- helpers

    /** UTF-8 byte length — mesh packet budgets are bytes, not characters. */
    function byteLength(text) {
        if (!text) return 0;
        return new TextEncoder().encode(text).length;
    }

    /** Coerce an arbitrary value to a valid contact type, defaulting to 1. */
    function normalizeContactType(value) {
        var n = parseInt(value, 10);
        return (n >= 1 && n <= 4) ? n : CONTACT_TYPES.COMPANION;
    }

    function isValidPubkey(value) {
        return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
    }

    function isValidSecret(value) {
        return typeof value === 'string' && /^[0-9a-fA-F]{32}$/.test(value);
    }

    function isValidLatLon(lat, lon) {
        return Number.isFinite(lat) && Number.isFinite(lon) &&
               lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
               !(lat === 0 && lon === 0); // 0,0 is the firmware's "unset" marker
    }

    /**
     * Abbreviate a public key the way the rest of the UI does: first 6 and last
     * 6 hex characters. Purely cosmetic — actions always use the full key.
     */
    function shortPubkey(pubkey) {
        if (!pubkey || pubkey.length < 16) return pubkey || '';
        return pubkey.slice(0, 6) + '…' + pubkey.slice(-6);
    }

    /** Hashtag channels are public-by-name; anything else carries its own key. */
    function channelKindOf(name) {
        return (name && name.charAt(0) === '#') ? 'hashtag' : 'private';
    }

    // ------------------------------------------------------------ URI parsing

    /**
     * Parse the query string of a meshcore:// URI.
     * `new URL()` handles a custom scheme fine, but its `searchParams` needs a
     * hierarchical URL — meshcore://contact/add?x=1 qualifies, so this is safe.
     */
    function parseUriParams(uri) {
        try {
            return new URL(uri).searchParams;
        } catch (e) {
            return null;
        }
    }

    function parseContactUri(uri) {
        var params = parseUriParams(uri);
        if (!params) return null;

        var pubkey = (params.get('public_key') || '').trim().toLowerCase();
        if (!isValidPubkey(pubkey)) return null;

        return {
            public_key: pubkey,
            type: normalizeContactType(params.get('type')),
            name: (params.get('name') || '').trim()
        };
    }

    function parseChannelUri(uri) {
        var params = parseUriParams(uri);
        if (!params) return null;

        var secret = (params.get('secret') || '').trim().toLowerCase();
        var name = (params.get('name') || '').trim();
        // A channel without a name is unusable; without a secret it can only be
        // joined if the name is a hashtag channel (the key is derived from it).
        if (!name) return null;
        if (!isValidSecret(secret) && channelKindOf(name) !== 'hashtag') return null;

        return {
            name: name,
            secret: isValidSecret(secret) ? secret : null,
            region_scope: (params.get('region_scope') || '').trim() || null,
            kind: channelKindOf(name)
        };
    }

    // --------------------------------------------------------------- scanning

    function collectUrlSpans(text) {
        var spans = [];
        var re = new RegExp(URL_SPAN_RE.source, 'gi');
        var m;
        while ((m = re.exec(text)) !== null) {
            spans.push([m.index, m.index + m[0].length]);
        }
        return spans;
    }

    function overlapsAny(start, end, spans) {
        for (var i = 0; i < spans.length; i++) {
            if (start < spans[i][1] && end > spans[i][0]) return true;
        }
        return false;
    }

    /**
     * Find every share token in a raw (un-escaped) message body.
     *
     * Must run BEFORE HTML escaping. Escaping turns '&' into '&amp;', which
     * breaks channel-URI query strings, and the later passes in
     * processMessageContent() would chew the tokens apart anyway: '#name'
     * becomes a channel link, '@' becomes a mention, and the token's trailing
     * '>' collides with quote syntax.
     *
     * @param {string} text - Raw message content
     * @returns {Array<{index:number,length:number,kind:string,data:object}>}
     *          Non-overlapping matches, ordered by position.
     */
    function parse(text) {
        if (!text || typeof text !== 'string') return [];

        var found = [];
        var m;

        // Compact contact tokens.
        var contactRe = new RegExp(CONTACT_TOKEN_RE.source, 'g');
        while ((m = contactRe.exec(text)) !== null) {
            found.push({
                index: m.index,
                length: m[0].length,
                kind: 'contact',
                raw: m[0],
                data: {
                    public_key: m[1].toLowerCase(),
                    type: normalizeContactType(m[2]),
                    name: m[3].trim()
                }
            });
        }

        // meshcore:// URIs.
        var uriRe = new RegExp(MESHCORE_URI_RE.source, 'gi');
        while ((m = uriRe.exec(text)) !== null) {
            var isChannel = m[1].toLowerCase() === 'channel';
            var parsed = isChannel ? parseChannelUri(m[0]) : parseContactUri(m[0]);
            if (!parsed) continue;
            found.push({
                index: m.index,
                length: m[0].length,
                kind: isChannel ? 'channel' : 'contact',
                raw: m[0],
                data: parsed
            });
        }

        // Bare coordinates — skipped when they sit inside a URL, so a Google
        // Maps link keeps working as a link instead of being torn in half.
        var urlSpans = collectUrlSpans(text);
        var locRe = new RegExp(LOCATION_RE.source, 'g');
        while ((m = locRe.exec(text)) !== null) {
            var lat = parseFloat(m[1]);
            var lon = parseFloat(m[2]);
            if (!isValidLatLon(lat, lon)) continue;
            if (overlapsAny(m.index, m.index + m[0].length, urlSpans)) continue;
            found.push({
                index: m.index,
                length: m[0].length,
                kind: 'location',
                raw: m[0],
                data: { lat: lat, lon: lon }
            });
        }

        // Order by position, then drop anything overlapping an earlier match.
        // Longer matches win at equal position so a full URI beats a fragment.
        found.sort(function (a, b) {
            return (a.index - b.index) || (b.length - a.length);
        });

        var result = [];
        var consumedTo = -1;
        for (var i = 0; i < found.length; i++) {
            if (found[i].index < consumedTo) continue;
            result.push(found[i]);
            consumedTo = found[i].index + found[i].length;
        }
        return result;
    }

    /**
     * True when the message body is nothing but a single share token.
     * Used to render the card on its own instead of inline with surrounding
     * text, and to mirror how the official app composes these messages.
     */
    function isTokenOnly(text) {
        if (!text) return false;
        var tokens = parse(text);
        if (tokens.length !== 1) return false;
        return text.trim() === tokens[0].raw.trim();
    }

    // ------------------------------------------------------------ serializing

    /**
     * Build the compact contact token.
     * @param {{public_key:string, type:number, name:string}} contact
     * @returns {string|null} null when the contact cannot be represented
     */
    function serializeContact(contact) {
        if (!contact || !isValidPubkey(contact.public_key)) return null;
        var name = (contact.name || '').replace(/[>\n\r]/g, '').trim();
        if (!name) return null;
        return '<' + contact.public_key.toLowerCase() + ':' +
               normalizeContactType(contact.type) + ':' + name + '>';
    }

    /**
     * Build the channel URI. `region_scope` is omitted when absent — older
     * clients (before app v1.47.0) ignore it, but sending an empty one wastes
     * bytes from a tight packet budget.
     * @param {{name:string, secret:string, region_scope:?string}} channel
     */
    function serializeChannel(channel) {
        if (!channel || !channel.name) return null;
        var secret = (channel.secret || '').toLowerCase();
        if (!isValidSecret(secret)) return null;

        var uri = 'meshcore://channel/add?name=' + encodeURIComponent(channel.name) +
                  '&secret=' + secret;
        if (channel.region_scope) {
            uri += '&region_scope=' + encodeURIComponent(channel.region_scope);
        }
        return uri;
    }

    /**
     * Build the bare coordinate pair. Six decimals matches what the official
     * app emits (~10 cm precision, far beyond what GPS here justifies, but
     * staying identical keeps round-trips lossless).
     */
    function serializeLocation(lat, lon) {
        var la = parseFloat(lat);
        var lo = parseFloat(lon);
        if (!isValidLatLon(la, lo)) return null;
        return la.toFixed(6) + ',' + lo.toFixed(6);
    }

    // -------------------------------------------------------------- geo extras

    var COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

    function toRad(deg) { return deg * Math.PI / 180; }

    /** Great-circle distance in metres. */
    function distanceMeters(lat1, lon1, lat2, lon2) {
        var R = 6371000;
        var dLat = toRad(lat2 - lat1);
        var dLon = toRad(lon2 - lon1);
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /** Initial bearing, as an 8-point compass label. */
    function compassBearing(lat1, lon1, lat2, lon2) {
        var dLon = toRad(lon2 - lon1);
        var y = Math.sin(dLon) * Math.cos(toRad(lat2));
        var x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        var deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
        return COMPASS[Math.round(deg / 45) % 8];
    }

    /** Human-readable distance: metres below 1 km, otherwise kilometres. */
    function formatDistance(meters) {
        if (!Number.isFinite(meters)) return '';
        if (meters < 1000) return Math.round(meters) + ' m';
        if (meters < 10000) return (meters / 1000).toFixed(1) + ' km';
        return Math.round(meters / 1000) + ' km';
    }

    global.MCShare = {
        CONTACT_TYPES: CONTACT_TYPES,
        parse: parse,
        isTokenOnly: isTokenOnly,
        serializeContact: serializeContact,
        serializeChannel: serializeChannel,
        serializeLocation: serializeLocation,
        parseContactUri: parseContactUri,
        parseChannelUri: parseChannelUri,
        byteLength: byteLength,
        shortPubkey: shortPubkey,
        channelKindOf: channelKindOf,
        normalizeContactType: normalizeContactType,
        isValidPubkey: isValidPubkey,
        isValidSecret: isValidSecret,
        isValidLatLon: isValidLatLon,
        distanceMeters: distanceMeters,
        compassBearing: compassBearing,
        formatDistance: formatDistance
    };
})(window);
