// Path Analyzer panel
// - bulk channel messages across all channels (GET /api/path-analyzer/messages)
// - stage 2: days selector + flat message table
// - later stages: path detail rows, filters, per-repeater stats, map view

// ================================================================
// UI settings + toast (same behavior as repeaters.js)
// ================================================================

const PA_UI_SETTINGS_DEFAULTS = {
    toast_timeout_sec: 2,
    toast_no_autoclose: false,
    toast_position: 'top-left'
};

const PA_TOAST_POSITION_CLASSES = {
    'top-left':     ['top-0', 'start-0'],
    'top-right':    ['top-0', 'end-0'],
    'bottom-left':  ['bottom-0', 'start-0'],
    'bottom-right': ['bottom-0', 'end-0'],
    'center':       ['top-50', 'start-50', 'translate-middle']
};
const PA_ALL_POSITION_CLASSES = ['top-0', 'top-50', 'start-0', 'start-50', 'bottom-0', 'end-0', 'translate-middle'];

window.uiSettingsCache = window.uiSettingsCache || { ...PA_UI_SETTINGS_DEFAULTS };

function applyToastPosition(position) {
    const classes = PA_TOAST_POSITION_CLASSES[position] || PA_TOAST_POSITION_CLASSES['top-left'];
    document.querySelectorAll('[data-toast-container]').forEach(el => {
        PA_ALL_POSITION_CLASSES.forEach(c => el.classList.remove(c));
        classes.forEach(c => el.classList.add(c));
    });
}

async function loadUiSettings() {
    try {
        const resp = await fetch('/api/ui/settings');
        if (resp.ok) {
            const data = await resp.json();
            window.uiSettingsCache = { ...PA_UI_SETTINGS_DEFAULTS, ...data };
            applyToastPosition(window.uiSettingsCache.toast_position);
        }
    } catch (e) {
        console.error('Failed to load UI settings:', e);
    }
}

function showNotification(message, type = 'info') {
    const toastEl = document.getElementById('notificationToast');
    if (!toastEl) return;

    const toastBody = toastEl.querySelector('.toast-body');
    if (toastBody) {
        toastBody.textContent = message;
    }

    const toastHeader = toastEl.querySelector('.toast-header');
    if (toastHeader) {
        toastHeader.className = 'toast-header';
        if (type === 'success') {
            toastHeader.classList.add('bg-success', 'text-white');
        } else if (type === 'danger') {
            toastHeader.classList.add('bg-danger', 'text-white');
        } else if (type === 'warning') {
            toastHeader.classList.add('bg-warning');
        }
    }

    const cfg = window.uiSettingsCache || {};
    const noAutoclose = !!cfg.toast_no_autoclose;
    const timeoutSec = parseFloat(cfg.toast_timeout_sec);
    const delay = isFinite(timeoutSec) && timeoutSec > 0 ? Math.round(timeoutSec * 1000) : 2000;

    const toast = new bootstrap.Toast(toastEl, {
        autohide: !noAutoclose,
        delay: delay
    });
    toast.show();
}

// ================================================================
// Data loading + table rendering
// ================================================================

let paMessages = [];
let paFilters = { hops: 'any', hashSize: 'any', token: '', sender: '', content: '' };
let paCurrentView = 'messages';   // 'messages' | 'stats' | 'routes' | 'map'
let paContacts = [];              // /api/contacts/cached?format=full
let paStatsSort = { key: 'relayed', dir: -1 };
let paRoutesSort = { key: 'echoes', dir: -1 };
let paDeepLink = null;            // ?hash=..&path=.. from a chat path popup
let paContactsReady = Promise.resolve();

async function paLoadContacts() {
    try {
        const resp = await fetch('/api/contacts/cached?format=full');
        if (resp.ok) {
            const data = await resp.json();
            if (data.success) {
                paContacts = data.contacts || [];
                paTokenNameCache = new Map();
            }
        }
    } catch (e) {
        console.error('Failed to load contacts:', e);
    }
}

// Match a repeater hash token against contacts by public key prefix.
// 1-byte hashes can collide - callers must handle multiple candidates.
function paMatchContacts(token) {
    const prefix = token.toLowerCase();
    return paContacts.filter(c => (c.public_key || '').toLowerCase().startsWith(prefix));
}

// token -> lowercase candidate contact names, memoized (contacts are
// static per page load; cache is rebuilt when they arrive)
let paTokenNameCache = new Map();

function paTokenNames(token) {
    let names = paTokenNameCache.get(token);
    if (!names) {
        names = paMatchContacts(token).map(c => (c.name || '').toLowerCase());
        paTokenNameCache.set(token, names);
    }
    return names;
}

// Split an echo's path hex into per-hop tokens using that echo's own
// hash_size (same logic as showPathsPopup in app.js; trailing partial kept)
function paDecodeEcho(echo) {
    const chunkLen = (echo.hash_size || 1) * 2;
    const tokens = [];
    const hex = echo.path || '';
    for (let i = 0; i < hex.length; i += chunkLen) {
        tokens.push(hex.substring(i, i + chunkLen).toUpperCase());
    }
    return { ...echo, tokens: tokens, hops: tokens.length };
}

// One filter element (lowercase) vs one path token: hex input matches the
// hash by prefix; any input also matches resolved contact names
function paTokenMatchesElement(tok, el) {
    return (/^[0-9a-f]+$/.test(el) && tok.startsWith(el.toUpperCase()))
        || paTokenNames(tok).some(n => n.includes(el));
}

function paMessageMatchesFilters(msg) {
    if (paFilters.hops !== 'any') {
        const want = paFilters.hops;
        const ok = msg.echoView.some(e =>
            want === '4+' ? e.hops >= 4 : e.hops === parseInt(want, 10));
        if (!ok) return false;
    }
    if (paFilters.hashSize !== 'any') {
        // Value is a comma list of accepted sizes (e.g. "2" or "2,3");
        // only routed echoes carry a meaningful hash size
        const wanted = paFilters.hashSize.split(',').map(Number);
        const ok = msg.echoView.some(e => e.hops > 0 && wanted.includes(e.hash_size || 1));
        if (!ok) return false;
    }
    if (paFilters.token) {
        // '>' (or '→') chains elements into a consecutive-sequence match;
        // a single element behaves as before. Spaces are NOT separators -
        // contact names may contain them.
        const els = paFilters.token.split(/[>→]/).map(s => s.trim()).filter(Boolean);
        const ok = els.length > 0 && msg.echoView.some(e => {
            for (let i = 0; i + els.length <= e.tokens.length; i++) {
                if (els.every((el, j) => paTokenMatchesElement(e.tokens[i + j], el))) return true;
            }
            return false;
        });
        if (!ok) return false;
    }
    if (paFilters.sender) {
        if (!(msg.sender || '').toLowerCase().includes(paFilters.sender)) return false;
    }
    if (paFilters.content) {
        if (!(msg.content || '').toLowerCase().includes(paFilters.content)) return false;
    }
    return true;
}

function paFiltersActive() {
    return paFilters.hops !== 'any' || paFilters.hashSize !== 'any'
        || paFilters.token !== '' || paFilters.sender !== '' || paFilters.content !== '';
}

function paFormatTime(msg) {
    if (!msg.timestamp) return '—';
    const d = new Date(msg.timestamp * 1000);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function paCopyText(text, label) {
    navigator.clipboard.writeText(text).then(
        () => showNotification(`${label} copied to clipboard`, 'success'),
        () => showNotification(`Failed to copy ${label}`, 'danger')
    );
}

function paBuildEchoLine(msg, echo, echoIdx) {
    const line = document.createElement('div');
    line.className = 'pa-echo-line';
    line.title = 'Click to copy route';

    const dirBadge = document.createElement('span');
    dirBadge.className = 'badge ' + (echo.direction === 'outgoing' ? 'text-bg-primary' : 'text-bg-secondary');
    dirBadge.textContent = echo.direction === 'outgoing' ? 'out' : 'in';
    line.appendChild(dirBadge);

    if (echo.hops === 0) {
        const direct = document.createElement('span');
        direct.className = 'pa-direct';
        direct.textContent = 'Direct (flood, 0 hops)';
        line.appendChild(direct);
    } else {
        echo.tokens.forEach((tok, i) => {
            if (i > 0) {
                const arrow = document.createElement('i');
                arrow.className = 'bi bi-arrow-right pa-chip-arrow';
                line.appendChild(arrow);
            }
            const chip = document.createElement('span');
            chip.className = 'pa-chip';
            chip.textContent = tok;
            chip.title = `Copy repeater hash ${tok}`;
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                paCopyText(tok, 'Repeater hash');
            });
            line.appendChild(chip);
        });
    }

    const meta = document.createElement('span');
    meta.className = 'pa-echo-meta ms-1';
    const snr = (echo.snr === null || echo.snr === undefined) ? '?' : `${Number(echo.snr).toFixed(1)} dB`;
    meta.textContent = `SNR: ${snr} | ${echo.received_at || ''}`;
    line.appendChild(meta);

    if (echo.hops > 0) {
        const mapBtn = document.createElement('i');
        mapBtn.className = 'bi bi-map pa-echo-mapbtn';
        mapBtn.title = 'Show this path on the map';
        mapBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            paMapSelection = { msgId: msg.id, echoIdx: echoIdx };
            paSwitchView('map');
        });
        line.appendChild(mapBtn);
    }

    line.addEventListener('click', () => {
        paCopyText(echo.tokens.join(','), 'Route');
    });
    return line;
}

function paRenderTable() {
    const body = document.getElementById('paTableBody');
    body.innerHTML = '';

    const filtered = paMessages.filter(paMessageMatchesFilters);

    for (const msg of filtered) {
        const tr = document.createElement('tr');
        tr.className = 'pa-msg-row' + (msg.echoView.length === 0 ? ' pa-no-echoes' : '');

        const tdCaret = document.createElement('td');
        tdCaret.innerHTML = '<i class="bi bi-chevron-right pa-caret"></i>';
        tr.appendChild(tdCaret);

        const tdTime = document.createElement('td');
        tdTime.className = 'pa-time';
        const full = paFormatTime(msg);
        tdTime.innerHTML = `<span class="pa-time-full"></span><span class="pa-time-short"></span>`;
        tdTime.querySelector('.pa-time-full').textContent = full;
        tdTime.querySelector('.pa-time-short').textContent = full === '—' ? '—' : full.slice(5, 16);
        tr.appendChild(tdTime);

        const tdChannel = document.createElement('td');
        tdChannel.textContent = msg.channel_name || `#${msg.channel_idx}`;
        tr.appendChild(tdChannel);

        const tdSender = document.createElement('td');
        tdSender.textContent = msg.is_own ? `${msg.sender || 'Me'} (own)` : (msg.sender || '—');
        tr.appendChild(tdSender);

        const tdContent = document.createElement('td');
        const preview = document.createElement('div');
        preview.className = 'pa-content-preview';
        preview.textContent = msg.content || '';
        preview.title = msg.content || '';
        tdContent.appendChild(preview);
        tr.appendChild(tdContent);

        const tdHash = document.createElement('td');
        tdHash.className = 'pa-col-hash';
        if (msg.packet_hash) {
            const span = document.createElement('span');
            span.className = 'pa-hash';
            span.textContent = msg.packet_hash;
            span.title = 'Click to copy';
            span.addEventListener('click', (e) => {
                e.stopPropagation();
                paCopyText(msg.packet_hash, 'Packet hash');
            });
            tdHash.appendChild(span);
        } else {
            tdHash.innerHTML = '<span class="text-muted small">no path data</span>';
        }
        tr.appendChild(tdHash);

        const tdHops = document.createElement('td');
        tdHops.className = 'text-end';
        tdHops.textContent = (msg.hop_count === null || msg.hop_count === undefined) ? '—' : msg.hop_count;
        tr.appendChild(tdHops);

        const tdHb = document.createElement('td');
        tdHb.className = 'text-end pa-col-hb';
        const hbSizes = [...new Set(msg.echoView.filter(e => e.hops > 0).map(e => e.hash_size || 1))].sort();
        tdHb.textContent = hbSizes.length > 0 ? hbSizes.join(',') : '—';
        tr.appendChild(tdHb);

        const tdEchoes = document.createElement('td');
        tdEchoes.className = 'text-end pa-col-echoes';
        tdEchoes.textContent = msg.echoView.length;
        tr.appendChild(tdEchoes);

        body.appendChild(tr);

        if (msg.echoView.length > 0) {
            const detailTr = document.createElement('tr');
            detailTr.className = 'd-none';
            const detailTd = document.createElement('td');
            detailTd.className = 'pa-echo-cell';
            detailTd.colSpan = 9;
            if (msg.packet_hash) {
                // Narrow screens hide the Hash/HB columns - surface both here
                const hashLine = document.createElement('div');
                hashLine.className = 'pa-detail-hash';
                const hashSpan = document.createElement('span');
                hashSpan.className = 'pa-hash';
                hashSpan.textContent = msg.packet_hash;
                hashSpan.title = 'Click to copy';
                hashSpan.addEventListener('click', (e) => {
                    e.stopPropagation();
                    paCopyText(msg.packet_hash, 'Packet hash');
                });
                hashLine.append('Hash: ');
                hashLine.appendChild(hashSpan);
                if (hbSizes.length > 0) hashLine.append(` | HB: ${hbSizes.join(',')}`);
                detailTd.appendChild(hashLine);
            }
            msg.echoView.forEach((echo, echoIdx) => {
                detailTd.appendChild(paBuildEchoLine(msg, echo, echoIdx));
            });
            detailTr.appendChild(detailTd);
            body.appendChild(detailTr);

            tr.addEventListener('click', () => {
                tr.classList.toggle('pa-open');
                detailTr.classList.toggle('d-none');
            });
        }
    }

    const counter = document.getElementById('paCounter');
    counter.textContent = paFiltersActive()
        ? `${filtered.length} of ${paMessages.length} messages`
        : `${paMessages.length} message${paMessages.length === 1 ? '' : 's'}`;

    // Empty state when filters exclude everything
    if (paMessages.length > 0) {
        if (filtered.length === 0) {
            document.getElementById('paEmptyText').textContent = 'No messages match the current filters.';
            paSetView('empty');
        } else {
            paSetView('table');
        }
    }
}

function paSetView(state) {
    document.getElementById('paLoading').classList.toggle('d-none', state !== 'loading');
    document.getElementById('paEmpty').classList.toggle('d-none', state !== 'empty');
    document.getElementById('paTableWrap').classList.toggle('d-none', state !== 'table');
    document.getElementById('paStatsWrap').classList.toggle('d-none', state !== 'stats');
    document.getElementById('paRoutesWrap').classList.toggle('d-none', state !== 'routes');
    document.getElementById('paMapWrap').classList.toggle('d-none', state !== 'map');
}

// ================================================================
// Per-repeater statistics
// ================================================================

function paComputeStats(filtered) {
    const stats = new Map();  // exact token -> aggregate
    for (const msg of filtered) {
        for (const e of msg.echoView) {
            e.tokens.forEach((tok, i) => {
                let s = stats.get(tok);
                if (!s) {
                    s = { token: tok, relayed: 0, msgIds: new Set(), lastHop: 0, snrSum: 0, snrCount: 0 };
                    stats.set(tok, s);
                }
                s.relayed++;
                s.msgIds.add(msg.id);
                if (i === e.tokens.length - 1) {
                    // SNR is measured at our receiver - attribute it to the
                    // final hop only, never to intermediate hops
                    s.lastHop++;
                    if (e.snr !== null && e.snr !== undefined) {
                        s.snrSum += Number(e.snr);
                        s.snrCount++;
                    }
                }
            });
        }
    }
    return [...stats.values()].map(s => ({
        token: s.token,
        relayed: s.relayed,
        messages: s.msgIds.size,
        lastHop: s.lastHop,
        avgSnr: s.snrCount > 0 ? s.snrSum / s.snrCount : null,
    }));
}

function paRenderStats() {
    const body = document.getElementById('paStatsBody');
    body.innerHTML = '';

    const filtered = paMessages.filter(paMessageMatchesFilters);
    const rows = paComputeStats(filtered);

    const { key, dir } = paStatsSort;
    rows.sort((a, b) => {
        const av = a[key], bv = b[key];
        if (av === null && bv === null) return 0;
        if (av === null) return 1;   // nulls (never last hop) always last
        if (bv === null) return -1;
        return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });

    // Show sort direction on the active header
    document.querySelectorAll('#paStatsWrap .pa-sortable').forEach(th => {
        th.textContent = th.textContent.replace(/ [▲▼]$/, '')
            + (th.dataset.sort === key ? (dir === -1 ? ' ▼' : ' ▲') : '');
    });

    for (const s of rows) {
        const tr = document.createElement('tr');
        tr.className = 'pa-stats-row';
        tr.title = `Filter messages by ${s.token}`;

        const tdToken = document.createElement('td');
        tdToken.innerHTML = `<span class="pa-hash">${s.token}</span>`;
        tr.appendChild(tdToken);

        const tdContact = document.createElement('td');
        const candidates = paMatchContacts(s.token);
        if (candidates.length === 1) {
            tdContact.textContent = candidates[0].name || '—';
        } else if (candidates.length > 1) {
            tdContact.innerHTML = `<span class="pa-ambiguous" title="${candidates.map(c => c.name).join(', ')}">ambiguous (${candidates.length})</span>`;
        } else {
            tdContact.textContent = '—';
        }
        tr.appendChild(tdContact);

        for (const [val, cls] of [[s.relayed, ''], [s.messages, ' pa-col-msgs'], [s.lastHop, ' pa-col-lasthop']]) {
            const td = document.createElement('td');
            td.className = 'text-end' + cls;
            td.textContent = val;
            tr.appendChild(td);
        }

        const tdSnr = document.createElement('td');
        tdSnr.className = 'text-end';
        tdSnr.textContent = s.avgSnr === null ? '—' : `${s.avgSnr.toFixed(1)} dB`;
        tr.appendChild(tdSnr);

        // Click -> apply this token as the filter and jump to the message list
        tr.addEventListener('click', () => {
            document.getElementById('paTokenFilter').value = s.token;
            paSwitchView('messages');
        });

        body.appendChild(tr);
    }

    const counter = document.getElementById('paCounter');
    counter.textContent = paFiltersActive()
        ? `${rows.length} repeaters (${filtered.length} of ${paMessages.length} messages)`
        : `${rows.length} repeaters (${paMessages.length} messages)`;

    if (rows.length === 0) {
        document.getElementById('paEmptyText').textContent =
            filtered.length === 0 ? 'No messages match the current filters.'
                                  : 'No routed echoes in the current selection.';
        paSetView('empty');
    } else {
        paSetView('stats');
    }
}

// ================================================================
// Route segment statistics (consecutive hop n-grams)
// ================================================================

function paComputeRoutes(filtered, n) {
    const routes = new Map();  // 'A→B→...' -> aggregate
    for (const msg of filtered) {
        for (const e of msg.echoView) {
            const seen = new Set();  // count each segment once per echo
            for (let i = 0; i + n <= e.tokens.length; i++) {
                const key = e.tokens.slice(i, i + n).join('→');
                let r = routes.get(key);
                if (!r) {
                    r = { tokens: e.tokens.slice(i, i + n), echoes: 0, msgIds: new Set(), pathEnd: 0 };
                    routes.set(key, r);
                }
                if (!seen.has(key)) {
                    seen.add(key);
                    r.echoes++;
                    r.msgIds.add(msg.id);
                }
                if (i + n === e.tokens.length) r.pathEnd++;
            }
        }
    }
    return [...routes.values()].map(r => ({
        tokens: r.tokens,
        echoes: r.echoes,
        messages: r.msgIds.size,
        pathEnd: r.pathEnd,
    }));
}

function paRenderRoutes() {
    const body = document.getElementById('paRoutesBody');
    body.innerHTML = '';

    const n = parseInt(document.getElementById('paSegLenSelect').value, 10);
    const filtered = paMessages.filter(paMessageMatchesFilters);
    const rows = paComputeRoutes(filtered, n);

    const { key, dir } = paRoutesSort;
    rows.sort((a, b) => (a[key] - b[key]) * dir || b.echoes - a.echoes);

    // Show sort direction on the active header
    document.querySelectorAll('#paRoutesWrap .pa-sortable').forEach(th => {
        th.textContent = th.textContent.replace(/ [▲▼]$/, '')
            + (th.dataset.sort === key ? (dir === -1 ? ' ▼' : ' ▲') : '');
    });

    for (const r of rows) {
        const tr = document.createElement('tr');
        tr.className = 'pa-stats-row';
        tr.title = 'Filter messages by this segment';

        const tdRoute = document.createElement('td');
        const hashLine = document.createElement('div');
        hashLine.innerHTML = r.tokens
            .map(t => `<span class="pa-hash">${t}</span>`)
            .join(' <span class="pa-chip-arrow">→</span> ');
        tdRoute.appendChild(hashLine);

        // Resolved contact names beneath the hashes (skipped when nothing resolves)
        const names = r.tokens.map(tok => {
            const cands = paMatchContacts(tok);
            if (cands.length === 1) return cands[0].name || '—';
            return cands.length > 1 ? `ambiguous (${cands.length})` : '—';
        });
        if (names.some(nm => nm !== '—')) {
            const nameLine = document.createElement('div');
            nameLine.className = 'small text-muted';
            nameLine.textContent = names.join(' → ');
            tdRoute.appendChild(nameLine);
        }
        tr.appendChild(tdRoute);

        for (const [val, cls] of [[r.echoes, ''], [r.messages, ' pa-col-msgs'], [r.pathEnd, '']]) {
            const td = document.createElement('td');
            td.className = 'text-end' + cls;
            td.textContent = val;
            tr.appendChild(td);
        }

        // Click -> apply this segment as a sequence filter and jump to the list
        tr.addEventListener('click', () => {
            document.getElementById('paTokenFilter').value = r.tokens.join('>');
            paSwitchView('messages');
        });

        body.appendChild(tr);
    }

    const counter = document.getElementById('paCounter');
    counter.textContent = paFiltersActive()
        ? `${rows.length} segments (${filtered.length} of ${paMessages.length} messages)`
        : `${rows.length} segments (${paMessages.length} messages)`;

    if (rows.length === 0) {
        document.getElementById('paEmptyText').textContent =
            filtered.length === 0 ? 'No messages match the current filters.'
                                  : `No paths with at least ${n} hops in the current selection.`;
        paSetView('empty');
    } else {
        paSetView('routes');
    }
}

// ================================================================
// Map view
// ================================================================

let paMap = null;
let paBaseLayer = null;   // repeater contact markers
let paAltLayer = null;    // the selected message's other echoes
let paPathLayer = null;   // drawn path for the selected echo

// Both map overlays are opt-in: the map opens showing just the picked
// route, everything else is noise until the user asks for it
let paShowAllRepeaters = false;
let paShowAltPaths = false;

// Path drawing color - distinct from the purple base markers so the
// route stands out (origin stays green, ambiguous candidates amber).
const PA_PATH_COLOR = '#dc3545';

// Alternative echoes get one light hue each, cycled by echo index, so two
// alternatives running near each other stay tellable apart. Kept clear of
// the primary red and of the marker colors above.
const PA_ALT_PATH_COLORS = [
    '#4dabf7',   // light blue
    '#20c997',   // teal
    '#ff922b',   // orange
    '#e599f7',   // violet
    '#94d82d',   // lime
];

function paAltColor(echoIdx) {
    return PA_ALT_PATH_COLORS[echoIdx % PA_ALT_PATH_COLORS.length];
}

function paHopIcon(n) {
    return L.divIcon({
        className: 'pa-hop-icon',
        html: `<div class="pa-hop-badge">${n}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    });
}
let paMapSelection = { msgId: null, echoIdx: null };
let paPicks = {};         // token -> public_key chosen by the user (collision disambiguation)

function paGeoContact(c) {
    return c.adv_lat !== null && c.adv_lat !== undefined &&
           c.adv_lon !== null && c.adv_lon !== undefined &&
           !(Number(c.adv_lat) === 0 && Number(c.adv_lon) === 0);
}

// Overlay toggles live on the map itself, not in the shared filter bar -
// they only make sense for this view
function paAddMapToggles() {
    const ctl = L.control({ position: 'topright' });
    ctl.onAdd = () => {
        const box = L.DomUtil.create('div', 'pa-map-toggles');
        box.innerHTML =
            '<label><input type="checkbox" id="paToggleRepeaters"> All repeaters</label>' +
            '<label><input type="checkbox" id="paToggleAltPaths"> Alternative paths</label>';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.disableScrollPropagation(box);
        return box;
    };
    ctl.addTo(paMap);

    // Re-render without refitting: toggling an overlay must not throw away
    // the viewport the user panned/zoomed to
    document.getElementById('paToggleRepeaters').addEventListener('change', (e) => {
        paShowAllRepeaters = e.target.checked;
        paRenderMapView(false);
    });
    document.getElementById('paToggleAltPaths').addEventListener('change', (e) => {
        paShowAltPaths = e.target.checked;
        paRenderMapView(false);
    });
}

function paInitMap() {
    if (paMap) return;
    paMap = L.map('paMap').setView([52.0, 19.0], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(paMap);
    // Added in draw order: base markers at the bottom, the selected path on top
    paBaseLayer = L.layerGroup().addTo(paMap);
    paAltLayer = L.layerGroup().addTo(paMap);
    paPathLayer = L.layerGroup().addTo(paMap);
    paAddMapToggles();
}

function paPlotBaseMarkers() {
    paBaseLayer.clearLayers();
    if (!paShowAllRepeaters) return;
    paContacts.filter(c => c.type_label === 'REP' && paGeoContact(c)).forEach(c => {
        L.circleMarker([c.adv_lat, c.adv_lon], {
            radius: 5, color: '#6f42c1', weight: 1.5, fillOpacity: 0.5
        }).bindPopup(`<strong>${c.name || '?'}</strong><br><code>${(c.public_key || '').slice(0, 12)}</code>`)
          .addTo(paBaseLayer);
    });
}

// Resolve a hop token to a contact: manual pick wins, else the single
// geo-located candidate. Returns {contact, candidates} - contact null
// when unknown or ambiguous.
function paResolveHop(token) {
    const candidates = paMatchContacts(token);
    const geoCandidates = candidates.filter(paGeoContact);
    if (paPicks[token]) {
        const picked = geoCandidates.find(c => c.public_key === paPicks[token]);
        if (picked) return { contact: picked, candidates: geoCandidates };
    }
    if (geoCandidates.length === 1) return { contact: geoCandidates[0], candidates: geoCandidates };
    return { contact: null, candidates: geoCandidates };
}

// Draw one echo's route. The primary echo gets numbered hop badges, name
// labels and candidate markers; alternatives get a plain coloured line -
// several fully decorated paths at once would be unreadable.
// Returns the latlngs it contributed, for bounds fitting.
function paDrawEcho(msg, echo, primary, seen, altColor) {
    const layer = primary ? paPathLayer : paAltLayer;
    const points = [];   // {latlng, gapBefore}
    let gapPending = false;

    // Origin: sender name -> contact with geo (channel messages carry no sender pubkey)
    const origin = paContacts.find(c => c.name === msg.sender && paGeoContact(c));
    if (origin) {
        if (primary) {
            L.circleMarker([origin.adv_lat, origin.adv_lon], {
                radius: 7, color: '#198754', weight: 2, fillOpacity: 0.8
            }).bindPopup(`<strong>${origin.name}</strong><br>Origin (sender)`)
              .bindTooltip(origin.name, { permanent: true, direction: 'right', offset: [8, 0], className: 'pa-hop-label' })
              .addTo(layer);
        }
        points.push({ latlng: [origin.adv_lat, origin.adv_lon], gapBefore: false });
    }

    echo.tokens.forEach((tok, i) => {
        const { contact, candidates } = paResolveHop(tok);
        if (contact) {
            if (primary) {
                L.marker([contact.adv_lat, contact.adv_lon], { icon: paHopIcon(i + 1) })
                    .bindPopup(`<strong>${contact.name}</strong><br>Hop ${i + 1}: <code>${tok}</code>`)
                    .bindTooltip(contact.name, { permanent: true, direction: 'right', offset: [13, 0], className: 'pa-hop-label' })
                    .addTo(layer);
            }
            points.push({ latlng: [contact.adv_lat, contact.adv_lon], gapBefore: gapPending });
            gapPending = false;
        } else {
            // Ambiguous: show all geo candidates as amber markers, excluded from the line
            if (primary) {
                candidates.forEach(c => {
                    L.circleMarker([c.adv_lat, c.adv_lon], {
                        radius: 6, color: '#d39e00', weight: 2, fillOpacity: 0.5, dashArray: '3'
                    }).bindPopup(`<strong>${c.name}</strong><br>Candidate for hop ${i + 1}: <code>${tok}</code>`).addTo(layer);
                });
            }
            gapPending = true;
        }
    });

    // Polyline: solid between consecutive resolved hops, dashed across skipped ones.
    // Echoes of one message usually share a long prefix, so a segment is drawn
    // only once - an alternative then shows exactly where it diverges instead of
    // hiding under the primary route.
    const snr = (echo.snr === null || echo.snr === undefined) ? '?' : `${Number(echo.snr).toFixed(1)} dB`;
    const popup = `<strong>Alternative path</strong><br>${echo.tokens.join(' → ')}<br>${snr}`;
    let drawn = 0;
    for (let i = 1; i < points.length; i++) {
        const key = [String(points[i - 1].latlng), String(points[i].latlng)].sort().join('|');
        if (!primary && seen.has(key)) continue;
        seen.add(key);
        const line = L.polyline([points[i - 1].latlng, points[i].latlng], primary ? {
            color: PA_PATH_COLOR, weight: 3, opacity: 0.85,
            dashArray: points[i].gapBefore ? '6 8' : null
        } : {
            color: altColor, weight: 3, opacity: 0.9,
            dashArray: points[i].gapBefore ? '4 6' : null
        });
        // Alternatives carry no labels, so name them in a popup instead
        if (!primary) line.bindPopup(popup);
        line.addTo(layer);
        drawn++;
    }

    // Mark where an alternative ends - often its only difference is the last hop
    if (!primary && drawn > 0 && points.length > 1) {
        L.circleMarker(points[points.length - 1].latlng, {
            radius: 5, color: altColor, weight: 2, fillOpacity: 0.9
        }).bindPopup(popup).addTo(layer);
    }

    return points.map(p => p.latlng);
}

// Redraw the selected message's paths. `fit` recentres the map - skipped
// when only the overlay toggles changed, so the user keeps their viewport.
function paDrawPaths(fit) {
    paAltLayer.clearLayers();
    paPathLayer.clearLayers();
    const msg = paMessages.find(m => m.id === paMapSelection.msgId);
    if (!msg || paMapSelection.echoIdx === null) return;
    const echo = msg.echoView[paMapSelection.echoIdx];
    if (!echo) return;

    // The primary route is drawn first so it claims the shared segments;
    // alternatives then only add the parts that differ
    const seen = new Set();
    const latlngs = paDrawEcho(msg, echo, true, seen);
    if (paShowAltPaths) {
        // Colour by echo index, so an alternative keeps its hue when the
        // user switches which echo is the primary one
        msg.echoView.forEach((alt, idx) => {
            if (idx === paMapSelection.echoIdx || alt.hops === 0) return;
            latlngs.push(...paDrawEcho(msg, alt, false, seen, paAltColor(idx)));
        });
    }

    if (fit && latlngs.length > 0) {
        paMap.fitBounds(L.latLngBounds(latlngs).pad(0.25), { maxZoom: 13 });
    }

    document.getElementById('paMapClearBtn').classList.remove('d-none');
}

function paBuildLegend(echo) {
    const legend = document.createElement('div');
    legend.className = 'pa-legend';

    // Path-level reset for manual candidate assignments
    if (echo.tokens.some(tok => paPicks[tok])) {
        const resetRow = document.createElement('div');
        resetRow.className = 'text-end';
        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn btn-sm btn-outline-warning py-0 pa-reset-picks';
        resetBtn.innerHTML = '<i class="bi bi-arrow-counterclockwise"></i> Reset picks';
        resetBtn.title = 'Clear all manual repeater assignments on this path';
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            echo.tokens.forEach(tok => { delete paPicks[tok]; });
            paRenderMapView();
        });
        resetRow.appendChild(resetBtn);
        legend.appendChild(resetRow);
    }

    echo.tokens.forEach((tok, i) => {
        const row = document.createElement('div');
        row.className = 'pa-legend-hop';
        const { contact, candidates } = paResolveHop(tok);
        const label = document.createElement('span');
        label.innerHTML = `${i + 1}. <span class="pa-hash">${tok}</span>`;
        row.appendChild(label);
        if (contact) {
            const name = document.createElement('span');
            name.textContent = '— ' + contact.name;
            row.appendChild(name);
            if (paPicks[tok]) {
                // Manually assigned - allow undoing just this hop
                const undo = document.createElement('i');
                undo.className = 'bi bi-x-circle pa-unpick';
                undo.title = 'Undo this manual assignment';
                undo.addEventListener('click', (e) => {
                    e.stopPropagation();
                    delete paPicks[tok];
                    paRenderMapView();
                });
                row.appendChild(undo);
            }
        } else if (candidates.length > 1) {
            const amb = document.createElement('span');
            amb.className = 'pa-ambiguous';
            amb.textContent = `— ${candidates.length} candidates:`;
            row.appendChild(amb);
            candidates.forEach(c => {
                const chip = document.createElement('span');
                chip.className = 'pa-pick-chip' + (paPicks[tok] === c.public_key ? ' pa-picked' : '');
                chip.textContent = c.name || c.public_key.slice(0, 8);
                chip.title = 'Use this contact for the hop';
                chip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    paPicks[tok] = c.public_key;
                    paRenderMapView();
                });
                row.appendChild(chip);
            });
        } else {
            const unk = document.createElement('span');
            unk.className = 'pa-ambiguous';
            unk.textContent = '— unknown / no position';
            row.appendChild(unk);
        }
        legend.appendChild(row);
    });
    return legend;
}

// Default echo selection: the routed echo with the fewest hops
// (ties -> first in arrival order)
function paShortestEchoIdx(msg) {
    let best = null;
    msg.echoView.forEach((echo, idx) => {
        if (echo.hops > 0 && (best === null || echo.hops < msg.echoView[best].hops)) {
            best = idx;
        }
    });
    return best;
}

// `fit` recentres the map on the drawn paths - suppressed when only an
// overlay toggle changed, so the user keeps their viewport
function paRenderMapView(fit = true) {
    paInitMap();
    paPlotBaseMarkers();

    const list = document.getElementById('paMapMsgList');
    list.innerHTML = '';
    const filtered = paMessages.filter(paMessageMatchesFilters)
        .filter(m => m.echoView.some(e => e.hops > 0));

    // Drop a stale selection (filters changed underneath it)
    if (paMapSelection.msgId !== null && !filtered.some(m => m.id === paMapSelection.msgId)) {
        paMapSelection = { msgId: null, echoIdx: null };
        paPathLayer.clearLayers();
        paAltLayer.clearLayers();
        document.getElementById('paMapClearBtn').classList.add('d-none');
    }

    if (filtered.length === 0) {
        list.innerHTML = '<div class="small text-muted p-2">No messages with routed echoes match the current filters.</div>';
    }

    for (const msg of filtered) {
        const selected = msg.id === paMapSelection.msgId;
        const entry = document.createElement('div');
        entry.className = 'pa-map-msg' + (selected ? ' pa-selected' : '');

        const head = document.createElement('div');
        head.className = 'd-flex justify-content-between gap-2';
        const left = document.createElement('div');
        left.className = 'd-flex align-items-baseline gap-1';
        left.style.minWidth = '0';
        const senderEl = document.createElement('strong');
        senderEl.className = 'text-truncate';
        senderEl.textContent = msg.sender || '—';
        const chanEl = document.createElement('span');
        chanEl.className = 'pa-map-msg-chan';
        chanEl.textContent = msg.channel_name || `#${msg.channel_idx}`;
        left.appendChild(senderEl);
        left.appendChild(chanEl);
        const timeEl = document.createElement('span');
        timeEl.className = 'text-muted text-nowrap';
        timeEl.textContent = paFormatTime(msg).slice(5, 16);
        head.appendChild(left);
        head.appendChild(timeEl);
        entry.appendChild(head);

        // Content preview: one truncated line; full text when selected
        if (msg.content) {
            const preview = document.createElement('div');
            preview.className = 'pa-map-msg-preview' + (selected ? '' : ' text-truncate');
            preview.textContent = msg.content;
            preview.title = msg.content;
            entry.appendChild(preview);
        }

        entry.addEventListener('click', () => {
            // Re-clicking the selected message keeps the user's echo choice
            if (paMapSelection.msgId === msg.id) return;
            paMapSelection = { msgId: msg.id, echoIdx: paShortestEchoIdx(msg) };
            paRenderMapView();
        });

        if (selected) {
            msg.echoView.forEach((echo, idx) => {
                if (echo.hops === 0) return;
                const eEl = document.createElement('div');
                eEl.className = 'pa-map-echo' + (idx === paMapSelection.echoIdx ? ' pa-selected' : '');
                const snr = (echo.snr === null || echo.snr === undefined) ? '?' : `${Number(echo.snr).toFixed(1)} dB`;
                // While alternatives are drawn, a swatch ties each row to its line
                if (paShowAltPaths && idx !== paMapSelection.echoIdx) {
                    const swatch = document.createElement('span');
                    swatch.className = 'pa-echo-swatch';
                    swatch.style.backgroundColor = paAltColor(idx);
                    eEl.appendChild(swatch);
                }
                eEl.appendChild(document.createTextNode(`${echo.tokens.join(' → ')} (${snr})`));
                eEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    paMapSelection.echoIdx = idx;
                    paRenderMapView();
                });
                entry.appendChild(eEl);

                if (idx === paMapSelection.echoIdx) {
                    entry.appendChild(paBuildLegend(echo));
                }
            });
        }
        list.appendChild(entry);
    }

    paSetView('map');
    // Leaflet cannot size itself while the container was display:none -
    // and fitBounds in paDrawPaths needs the corrected size, so
    // drawing must happen after invalidateSize in the same deferred step
    setTimeout(() => {
        paMap.invalidateSize();
        paDrawPaths(fit);
    }, 60);

    // Keep the selected message visible (e.g. after jumping from the table)
    const selectedEl = list.querySelector('.pa-map-msg.pa-selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });

    const counter = document.getElementById('paCounter');
    counter.textContent = paFiltersActive()
        ? `${filtered.length} of ${paMessages.length} messages`
        : `${filtered.length} routed message${filtered.length === 1 ? '' : 's'}`;
}

function paClearMapSelection() {
    paMapSelection = { msgId: null, echoIdx: null };
    paPathLayer.clearLayers();
    paAltLayer.clearLayers();
    document.getElementById('paMapClearBtn').classList.add('d-none');
    paRenderMapView();
}

function paRender() {
    if (paCurrentView === 'stats') {
        paRenderStats();
    } else if (paCurrentView === 'routes') {
        paRenderRoutes();
    } else if (paCurrentView === 'map') {
        paRenderMapView();
    } else {
        paRenderTable();
    }
}

function paSwitchView(view) {
    paCurrentView = view;
    for (const [btnId, v] of [['paViewMessagesBtn', 'messages'],
                              ['paViewStatsBtn', 'stats'],
                              ['paViewRoutesBtn', 'routes'],
                              ['paViewMapBtn', 'map']]) {
        document.getElementById(btnId).className =
            'btn ' + (view === v ? 'btn-primary' : 'btn-outline-primary');
    }
    paApplyFilters();
}

async function paLoadMessages() {
    const days = document.getElementById('paDaysSelect').value;
    paSetView('loading');
    document.getElementById('paCounter').textContent = '';

    try {
        const resp = await fetch(`/api/path-analyzer/messages?days=${encodeURIComponent(days)}`);
        const data = await resp.json();
        if (!resp.ok || !data.success) {
            throw new Error(data.error || `HTTP ${resp.status}`);
        }
        // Newest first for the analysis table (API returns ascending)
        paMessages = (data.messages || []).slice().reverse();
        paMessages.forEach(msg => {
            msg.echoView = (msg.echoes || []).map(paDecodeEcho);
        });
    } catch (e) {
        console.error('Failed to load messages:', e);
        showNotification(`Failed to load messages: ${e.message}`, 'danger');
        paMessages = [];
    }

    if (paMessages.length === 0) {
        document.getElementById('paEmptyText').textContent = 'No messages in the selected time range.';
        paSetView('empty');
    } else {
        paRender();
    }

    if (paDeepLink) paApplyDeepLink();
}

// Deep link from the chat path popup: jump to the map view with the
// linked message selected and the linked echo path drawn.
async function paApplyDeepLink() {
    const dl = paDeepLink;
    const hash = (dl.hash || '').toLowerCase();
    const msg = paMessages.find(m => (m.packet_hash || '').toLowerCase() === hash);

    if (!msg) {
        // The chat can show messages older than the default window - widen
        // to the max range once before giving up
        const daysSel = document.getElementById('paDaysSelect');
        if (!dl.retried && daysSel.value !== '7') {
            dl.retried = true;
            daysSel.value = '7';
            paLoadMessages();   // re-enters paApplyDeepLink when done
            return;
        }
        paDeepLink = null;
        showNotification('This message is no longer in the analyzer data (max 7 days).', 'warning');
        return;
    }

    paDeepLink = null;
    await paContactsReady;   // map needs contacts to resolve hop positions

    let echoIdx = msg.echoView.findIndex(e =>
        e.hops > 0 && (e.path || '').toLowerCase() === (dl.path || '').toLowerCase());
    if (echoIdx === -1) echoIdx = paShortestEchoIdx(msg);
    if (echoIdx === null) {
        showNotification('This message has no routed echoes to draw.', 'warning');
        return;
    }

    paMapSelection = { msgId: msg.id, echoIdx: echoIdx };
    paSwitchView('map');
}

// ================================================================
// Filters
// ================================================================

function paReadFilters() {
    paFilters.hops = document.getElementById('paHopsFilter').value;
    paFilters.hashSize = document.getElementById('paHashSizeFilter').value;
    paFilters.token = document.getElementById('paTokenFilter').value.trim().toLowerCase();
    paFilters.sender = document.getElementById('paSenderFilter').value.trim().toLowerCase();
    paFilters.content = document.getElementById('paContentFilter').value.trim().toLowerCase();
    document.getElementById('paClearFiltersBtn').classList.toggle('d-none', !paFiltersActive());

    // Active-filter count on the mobile Filters toggle, so filters applied
    // while the panel is collapsed stay visible
    const activeCount = [paFilters.hops !== 'any', paFilters.hashSize !== 'any',
                         paFilters.token !== '', paFilters.sender !== '',
                         paFilters.content !== ''].filter(Boolean).length;
    const badge = document.getElementById('paFiltersBadge');
    badge.textContent = activeCount;
    badge.classList.toggle('d-none', activeCount === 0);
}

function paApplyFilters() {
    paReadFilters();
    if (paMessages.length > 0) {
        paRender();
    }
}

function paClearFilters() {
    document.getElementById('paHopsFilter').value = 'any';
    document.getElementById('paHashSizeFilter').value = 'any';
    document.getElementById('paTokenFilter').value = '';
    document.getElementById('paSenderFilter').value = '';
    document.getElementById('paContentFilter').value = '';
    paApplyAndSaveFilters();
}

// ================================================================
// Filter persistence
// ================================================================

// Browser-local only - these are a personal working set, not device state,
// so they stay out of the database
const PA_FILTERS_KEY = 'mc-webui-pa-filters';

// The toolbar controls, plus the Routes segment length - same "set it
// again on every visit" annoyance
const PA_SAVED_CONTROLS = [
    'paDaysSelect', 'paHopsFilter', 'paHashSizeFilter',
    'paTokenFilter', 'paSenderFilter', 'paContentFilter',
    'paSegLenSelect',
];

function paSaveFilters() {
    const state = {};
    PA_SAVED_CONTROLS.forEach(id => { state[id] = document.getElementById(id).value; });
    try {
        localStorage.setItem(PA_FILTERS_KEY, JSON.stringify(state));
    } catch (e) {
        // Private mode or a full quota - remembering filters is a convenience,
        // never a reason to break the panel
        console.warn('Could not save filters:', e);
    }
}

function paRestoreFilters() {
    let state;
    try {
        state = JSON.parse(localStorage.getItem(PA_FILTERS_KEY) || '{}');
    } catch (e) {
        return;
    }
    PA_SAVED_CONTROLS.forEach(id => {
        const val = state[id];
        if (typeof val !== 'string') return;
        const el = document.getElementById(id);
        // A stored option may no longer exist after a UI change - skip it
        // rather than leaving the select on a value it cannot display
        if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === val)) return;
        el.value = val;
    });
    // Sync paFilters, the Clear button and the mobile badge with the
    // restored controls before the first render
    paReadFilters();
}

// Every user-driven filter change goes through here, so the stored set
// only ever reflects deliberate choices - not programmatic ones such as
// the deep-link widening the time range
function paApplyAndSaveFilters() {
    paApplyFilters();
    paSaveFilters();
}

// ================================================================
// Init
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
    loadUiSettings();

    const qs = new URLSearchParams(window.location.search);
    if (qs.get('hash')) {
        paDeepLink = { hash: qs.get('hash'), path: qs.get('path') || '' };
    }

    document.getElementById('paDaysSelect').addEventListener('change', () => {
        paSaveFilters();
        paLoadMessages();
    });
    document.getElementById('paRefreshBtn').addEventListener('click', paLoadMessages);

    let filterDebounce = null;
    const debouncedApply = () => {
        clearTimeout(filterDebounce);
        filterDebounce = setTimeout(paApplyAndSaveFilters, 150);
    };
    document.getElementById('paHopsFilter').addEventListener('change', paApplyAndSaveFilters);
    document.getElementById('paHashSizeFilter').addEventListener('change', paApplyAndSaveFilters);
    document.getElementById('paTokenFilter').addEventListener('input', debouncedApply);
    document.getElementById('paSenderFilter').addEventListener('input', debouncedApply);
    document.getElementById('paContentFilter').addEventListener('input', debouncedApply);
    document.getElementById('paClearFiltersBtn').addEventListener('click', paClearFilters);

    document.getElementById('paViewMessagesBtn').addEventListener('click', () => paSwitchView('messages'));
    document.getElementById('paViewStatsBtn').addEventListener('click', () => paSwitchView('stats'));
    document.getElementById('paViewRoutesBtn').addEventListener('click', () => paSwitchView('routes'));
    document.getElementById('paViewMapBtn').addEventListener('click', () => paSwitchView('map'));
    document.getElementById('paMapClearBtn').addEventListener('click', paClearMapSelection);
    document.getElementById('paSegLenSelect').addEventListener('change', paApplyAndSaveFilters);
    document.querySelectorAll('#paStatsWrap .pa-sortable').forEach(th => {
        th.addEventListener('click', () => {
            const k = th.dataset.sort;
            if (paStatsSort.key === k) {
                paStatsSort.dir = -paStatsSort.dir;
            } else {
                paStatsSort = { key: k, dir: -1 };
            }
            paRenderStats();
        });
    });
    document.querySelectorAll('#paRoutesWrap .pa-sortable').forEach(th => {
        th.addEventListener('click', () => {
            const k = th.dataset.sort;
            if (paRoutesSort.key === k) {
                paRoutesSort.dir = -paRoutesSort.dir;
            } else {
                paRoutesSort = { key: k, dir: -1 };
            }
            paRenderRoutes();
        });
    });

    // A deep link carries its own intent - restoring a saved filter set
    // could hide the very message the user clicked through to
    if (!paDeepLink) paRestoreFilters();

    paContactsReady = paLoadContacts();
    paLoadMessages();
});
