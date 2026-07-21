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
let paCurrentView = 'messages';   // 'messages' | 'stats'
let paContacts = [];              // /api/contacts/cached?format=full
let paStatsSort = { key: 'relayed', dir: -1 };

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
        const raw = paFilters.token;                 // lowercase
        const isHex = /^[0-9a-f]+$/.test(raw);
        const hexPrefix = raw.toUpperCase();
        // Hex input matches hash tokens by prefix; any input also matches
        // the names of contacts the token resolves to
        const ok = msg.echoView.some(e => e.tokens.some(tok =>
            (isHex && tok.startsWith(hexPrefix)) ||
            paTokenNames(tok).some(n => n.includes(raw))
        ));
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
    document.querySelectorAll('.pa-sortable').forEach(th => {
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
// Map view
// ================================================================

let paMap = null;
let paBaseLayer = null;   // repeater contact markers
let paPathLayer = null;   // drawn path for the selected echo

// Path drawing color - distinct from the purple base markers so the
// route stands out (origin stays green, ambiguous candidates amber)
const PA_PATH_COLOR = '#dc3545';

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

function paInitMap() {
    if (paMap) return;
    paMap = L.map('paMap').setView([52.0, 19.0], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(paMap);
    paBaseLayer = L.layerGroup().addTo(paMap);
    paPathLayer = L.layerGroup().addTo(paMap);
}

function paPlotBaseMarkers() {
    paBaseLayer.clearLayers();
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

function paDrawSelectedEcho() {
    paPathLayer.clearLayers();
    const msg = paMessages.find(m => m.id === paMapSelection.msgId);
    if (!msg || paMapSelection.echoIdx === null) return;
    const echo = msg.echoView[paMapSelection.echoIdx];
    if (!echo) return;

    const points = [];   // {latlng, gapBefore}
    let gapPending = false;

    // Origin: sender name -> contact with geo (channel messages carry no sender pubkey)
    const origin = paContacts.find(c => c.name === msg.sender && paGeoContact(c));
    if (origin) {
        L.circleMarker([origin.adv_lat, origin.adv_lon], {
            radius: 7, color: '#198754', weight: 2, fillOpacity: 0.8
        }).bindPopup(`<strong>${origin.name}</strong><br>Origin (sender)`)
          .bindTooltip(origin.name, { permanent: true, direction: 'right', offset: [8, 0], className: 'pa-hop-label' })
          .addTo(paPathLayer);
        points.push({ latlng: [origin.adv_lat, origin.adv_lon], gapBefore: false });
    }

    echo.tokens.forEach((tok, i) => {
        const { contact, candidates } = paResolveHop(tok);
        if (contact) {
            L.marker([contact.adv_lat, contact.adv_lon], { icon: paHopIcon(i + 1) })
                .bindPopup(`<strong>${contact.name}</strong><br>Hop ${i + 1}: <code>${tok}</code>`)
                .bindTooltip(contact.name, { permanent: true, direction: 'right', offset: [13, 0], className: 'pa-hop-label' })
                .addTo(paPathLayer);
            points.push({ latlng: [contact.adv_lat, contact.adv_lon], gapBefore: gapPending });
            gapPending = false;
        } else {
            // Ambiguous: show all geo candidates as amber markers, excluded from the line
            candidates.forEach(c => {
                L.circleMarker([c.adv_lat, c.adv_lon], {
                    radius: 6, color: '#d39e00', weight: 2, fillOpacity: 0.5, dashArray: '3'
                }).bindPopup(`<strong>${c.name}</strong><br>Candidate for hop ${i + 1}: <code>${tok}</code>`).addTo(paPathLayer);
            });
            gapPending = true;
        }
    });

    // Polyline: solid between consecutive resolved hops, dashed across skipped ones
    for (let i = 1; i < points.length; i++) {
        L.polyline([points[i - 1].latlng, points[i].latlng], {
            color: PA_PATH_COLOR, weight: 3, opacity: 0.85,
            dashArray: points[i].gapBefore ? '6 8' : null
        }).addTo(paPathLayer);
    }

    const allLatLngs = points.map(p => p.latlng);
    if (allLatLngs.length > 0) {
        paMap.fitBounds(L.latLngBounds(allLatLngs).pad(0.25), { maxZoom: 13 });
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

function paRenderMapView() {
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
        const senderEl = document.createElement('strong');
        senderEl.className = 'text-truncate';
        senderEl.textContent = msg.sender || '—';
        const timeEl = document.createElement('span');
        timeEl.className = 'text-muted text-nowrap';
        timeEl.textContent = paFormatTime(msg).slice(5, 16);
        head.appendChild(senderEl);
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
            paMapSelection = { msgId: msg.id, echoIdx: null };
            paRenderMapView();
        });

        if (selected) {
            msg.echoView.forEach((echo, idx) => {
                if (echo.hops === 0) return;
                const eEl = document.createElement('div');
                eEl.className = 'pa-map-echo' + (idx === paMapSelection.echoIdx ? ' pa-selected' : '');
                const snr = (echo.snr === null || echo.snr === undefined) ? '?' : `${Number(echo.snr).toFixed(1)} dB`;
                eEl.textContent = `${echo.tokens.join(' → ')} (${snr})`;
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
    // and fitBounds in paDrawSelectedEcho needs the corrected size, so
    // drawing must happen after invalidateSize in the same deferred step
    setTimeout(() => {
        paMap.invalidateSize();
        paDrawSelectedEcho();
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
    document.getElementById('paMapClearBtn').classList.add('d-none');
    paRenderMapView();
}

function paRender() {
    if (paCurrentView === 'stats') {
        paRenderStats();
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
    paApplyFilters();
}

// ================================================================
// Init
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
    loadUiSettings();
    document.getElementById('paDaysSelect').addEventListener('change', paLoadMessages);
    document.getElementById('paRefreshBtn').addEventListener('click', paLoadMessages);

    let filterDebounce = null;
    const debouncedApply = () => {
        clearTimeout(filterDebounce);
        filterDebounce = setTimeout(paApplyFilters, 150);
    };
    document.getElementById('paHopsFilter').addEventListener('change', paApplyFilters);
    document.getElementById('paHashSizeFilter').addEventListener('change', paApplyFilters);
    document.getElementById('paTokenFilter').addEventListener('input', debouncedApply);
    document.getElementById('paSenderFilter').addEventListener('input', debouncedApply);
    document.getElementById('paContentFilter').addEventListener('input', debouncedApply);
    document.getElementById('paClearFiltersBtn').addEventListener('click', paClearFilters);

    document.getElementById('paViewMessagesBtn').addEventListener('click', () => paSwitchView('messages'));
    document.getElementById('paViewStatsBtn').addEventListener('click', () => paSwitchView('stats'));
    document.getElementById('paViewMapBtn').addEventListener('click', () => paSwitchView('map'));
    document.getElementById('paMapClearBtn').addEventListener('click', paClearMapSelection);
    document.querySelectorAll('.pa-sortable').forEach(th => {
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

    paLoadContacts();
    paLoadMessages();
});
