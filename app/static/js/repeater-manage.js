// Repeater Management panel (one repeater, after login)
// Loaded as /repeaters/manage?pubkey=<64 hex> inside the My Repeaters iframe.

// ================================================================
// UI settings + toast (same behavior as repeaters.js)
// ================================================================

const RPT_UI_SETTINGS_DEFAULTS = {
    toast_timeout_sec: 2,
    toast_no_autoclose: false,
    toast_position: 'top-left'
};

const RPT_TOAST_POSITION_CLASSES = {
    'top-left':     ['top-0', 'start-0'],
    'top-right':    ['top-0', 'end-0'],
    'bottom-left':  ['bottom-0', 'start-0'],
    'bottom-right': ['bottom-0', 'end-0'],
    'center':       ['top-50', 'start-50', 'translate-middle']
};
const RPT_ALL_POSITION_CLASSES = ['top-0', 'top-50', 'start-0', 'start-50', 'bottom-0', 'end-0', 'translate-middle'];

window.uiSettingsCache = window.uiSettingsCache || { ...RPT_UI_SETTINGS_DEFAULTS };

function applyToastPosition(position) {
    const classes = RPT_TOAST_POSITION_CLASSES[position] || RPT_TOAST_POSITION_CLASSES['top-left'];
    document.querySelectorAll('[data-toast-container]').forEach(el => {
        RPT_ALL_POSITION_CLASSES.forEach(c => el.classList.remove(c));
        classes.forEach(c => el.classList.add(c));
    });
}

async function loadUiSettings() {
    try {
        const resp = await fetch('/api/ui/settings');
        if (resp.ok) {
            const data = await resp.json();
            window.uiSettingsCache = { ...RPT_UI_SETTINGS_DEFAULTS, ...data };
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

function esc(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

// ================================================================
// Tools configuration
// ================================================================

// title/desc hold catalog KEYS, resolved with t() at render time.
const TOOLS = [
    { key: 'status',    icon: 'bi-bar-chart-line', title: 'rptmgmt.tools.status',
      desc: 'rptmgmt.tools.status_desc', adminOnly: false },
    { key: 'telemetry', icon: 'bi-activity',       title: 'rptmgmt.tools.telemetry',
      desc: 'rptmgmt.tools.telemetry_desc', adminOnly: false },
    { key: 'neighbors', icon: 'bi-people',         title: 'rptmgmt.tools.neighbors',
      desc: 'rptmgmt.tools.neighbors_desc', adminOnly: false },
    { key: 'cli',       icon: 'bi-terminal',       title: 'rptmgmt.tools.cli',
      desc: 'rptmgmt.tools.cli_desc', adminOnly: true },
    { key: 'settings',  icon: 'bi-gear',           title: 'rptmgmt.tools.settings',
      desc: 'rptmgmt.tools.settings_desc', adminOnly: true },
    { key: 'actions',   icon: 'bi-lightning',      title: 'rptmgmt.tools.actions',
      desc: 'rptmgmt.tools.actions_desc', adminOnly: true },
];

// ================================================================
// State
// ================================================================

let _pubkey = null;
let _repeater = null;   // merged entry from GET /api/repeaters/<pk>
let _session = null;    // {logged_in, is_admin, ...}
let _passwordModal = null;
let _powerOffModal = null;

// ================================================================
// State screens
// ================================================================

function showLoading(text) {
    document.getElementById('loadingState').style.display = '';
    document.getElementById('loadingText').textContent = text || t('common.loading');
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('panelContent').style.display = 'none';
}

function showError(text) {
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('errorState').style.display = '';
    document.getElementById('errorText').textContent = text || t('rptmgmt.error_generic');
    document.getElementById('panelContent').style.display = 'none';
}

function showPanel() {
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('panelContent').style.display = '';
    document.getElementById('logoutBtn').classList.remove('d-none');
    renderHeader();
    renderTools();
    showToolsGrid();
}

function goBackToList() {
    window.location.href = '/repeaters';
}

// ================================================================
// Header + tools rendering
// ================================================================

function shortPubkey(pk) {
    return `${pk.substring(0, 12)}…${pk.substring(pk.length - 8)}`;
}

function renderHeader() {
    const r = _repeater;
    document.getElementById('rptName').textContent = r.name || r.public_key.substring(0, 12);
    document.getElementById('rptPubkey').textContent = `<${shortPubkey(r.public_key)}>`;
    // '→' offers no line-break opportunity, so a multi-hop path would run off
    // a narrow screen; a zero-width space after each arrow lets it wrap by hop.
    const path = r.path_or_mode || '—';
    const ZWSP = String.fromCharCode(0x200B);
    document.getElementById('rptPath').textContent = path.replace(/→/g, '→' + ZWSP);

    const loc = hasValidGps(r)
        ? `${r.adv_lat.toFixed(4)}, ${r.adv_lon.toFixed(4)}`
        : '—';
    document.getElementById('rptLocation').textContent = loc;

    const badge = document.getElementById('roleBadge');
    if (_session && _session.logged_in) {
        const admin = !!_session.is_admin;
        badge.textContent = admin ? 'ADMIN' : 'GUEST';
        badge.className = 'badge ' + (admin ? 'bg-success' : 'bg-secondary');
    } else {
        badge.textContent = '';
        badge.className = 'badge';
    }
}

function renderTools() {
    const row = document.getElementById('toolsRow');
    row.innerHTML = '';
    const isAdmin = !!(_session && _session.is_admin);

    TOOLS.forEach(tool => {
        const locked = tool.adminOnly && !isAdmin;
        const col = document.createElement('div');
        col.className = 'col-12 col-sm-6 col-lg-4';
        col.innerHTML = `
            <div class="tool-tile${locked ? ' disabled' : ''}" data-tool="${tool.key}"
                 ${locked ? `title="${tHtml('rptmgmt.admin_required')}"` : ''}>
                <div class="tool-icon ${tool.key}"><i class="bi ${tool.icon}"></i></div>
                <div class="flex-grow-1" style="min-width: 0;">
                    <h6>${esc(t(tool.title))}${locked ? ' <i class="bi bi-lock-fill small text-muted"></i>' : ''}</h6>
                    <p class="tool-desc">${esc(t(tool.desc))}</p>
                </div>
                <i class="bi bi-chevron-right text-muted"></i>
            </div>
        `;
        const tile = col.querySelector('.tool-tile');
        tile.addEventListener('click', () => {
            if (locked) {
                showNotification(t('rptmgmt.toast.admin_required'), 'warning');
                return;
            }
            openToolPane(tool);
        });
        row.appendChild(col);
    });
}

// ================================================================
// Tool panes
// ================================================================

function showToolsGrid() {
    document.getElementById('toolsGrid').style.display = '';
    document.getElementById('toolPane').style.display = 'none';
}

function openToolPane(tool) {
    document.getElementById('toolsGrid').style.display = 'none';
    const pane = document.getElementById('toolPane');
    pane.style.display = '';

    const icon = document.getElementById('paneIcon');
    icon.className = `tool-icon ${tool.key}`;
    icon.style.width = '32px';
    icon.style.height = '32px';
    icon.style.fontSize = '1rem';
    icon.innerHTML = `<i class="bi ${tool.icon}"></i>`;
    document.getElementById('paneTitle').textContent = t(tool.title);

    const body = document.getElementById('paneBody');
    if (tool.key === 'status') {
        renderStatusPane(body);
        return;
    }
    if (tool.key === 'telemetry') {
        renderTelemetryPane(body);
        return;
    }
    if (tool.key === 'neighbors') {
        renderNeighborsPane(body);
        return;
    }
    if (tool.key === 'cli') {
        renderCliPane(body);
        return;
    }
    if (tool.key === 'settings') {
        renderSettingsPane(body);
        return;
    }
    if (tool.key === 'actions') {
        renderActionsPane(body);
        return;
    }
    body.innerHTML = `
        <div class="text-center text-muted py-4">
            <i class="bi ${tool.icon}" style="font-size: 2rem;"></i>
            <p class="mt-2 mb-0">${tHtml('rptmgmt.tool_coming', { tool: t(tool.title) })}</p>
        </div>
    `;
}

// ================================================================
// Formatting helpers
// ================================================================

function fmtDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return '—';
    seconds = Math.floor(seconds);
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h || d) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

// Delegates to datetime-utils.js; no longer forces en-US thousands separators, so
// numbers follow the reader's locale. Kept as a declaration (not const) so it stays
// hoisted, like the implementation it replaced.
function fmtInt(n) {
    return formatInt(n);
}

function batteryPercent(mv) {
    if (mv == null || isNaN(mv)) return null;
    // Simple linear LiPo estimate over 3.3–4.2 V.
    const pct = ((mv / 1000) - 3.3) / (4.2 - 3.3) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
}

// ================================================================
// Status tool
// ================================================================

let _statusUpdatedAt = null;
let _statusTimer = null;

function renderStatusPane(body) {
    body.innerHTML = `
        <div class="d-flex align-items-center mb-2">
            <span class="text-muted small flex-grow-1" id="statusUpdated"></span>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="statusRefreshBtn" title="${tHtml('rptmgmt.status.refresh_title')}">
                <i class="bi bi-arrow-clockwise"></i> ${tHtml('common.refresh')}
            </button>
        </div>
        <div id="statusContainer"></div>
    `;
    body.querySelector('#statusRefreshBtn').addEventListener('click', loadStatus);
    loadStatus();
}

function setStatusUpdatedLabel() {
    const el = document.getElementById('statusUpdated');
    if (!el) return;
    if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
    if (!_statusUpdatedAt) { el.textContent = ''; return; }
    const tick = () => {
        const label = document.getElementById('statusUpdated');
        if (!label) { clearInterval(_statusTimer); _statusTimer = null; return; }
        const secs = Math.floor((Date.now() - _statusUpdatedAt) / 1000);
        if (secs < 2) label.textContent = t('rptmgmt.updated_just_now');
        else if (secs < 60) label.textContent = t('rptmgmt.updated_ago', { time: `${secs}s` });
        else label.textContent = t('rptmgmt.updated_ago', { time: fmtDuration(secs) });
    };
    tick();
    _statusTimer = setInterval(tick, 5000);
}

async function loadStatus() {
    const container = document.getElementById('statusContainer');
    const btn = document.getElementById('statusRefreshBtn');
    if (!container) return;
    if (btn) btn.disabled = true;
    container.innerHTML = `
        <div class="text-center text-muted py-4">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="mt-2 mb-0">${tHtml('rptmgmt.status.loading')}</p>
        </div>
    `;

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/status`);
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }
    if (btn) btn.disabled = false;

    if (!data || !data.success) {
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-2">${esc((data && data.error) || t('rptmgmt.status_failed'))}</p>
                <button type="button" class="btn btn-sm btn-primary" id="statusRetryBtn">
                    <i class="bi bi-arrow-clockwise"></i> ${tHtml('common.try_again')}
                </button>
            </div>
        `;
        const retry = document.getElementById('statusRetryBtn');
        if (retry) retry.addEventListener('click', loadStatus);
        return;
    }

    renderStatusTable(container, data.data);
    _statusUpdatedAt = Date.now();
    setStatusUpdatedLabel();
    loadClock();
}

function statusSection(title, rows) {
    const body = rows.map(([label, value]) =>
        `<tr><td class="text-muted">${esc(label)}</td><td class="text-end fw-medium">${value}</td></tr>`
    ).join('');
    return `
        <div class="text-muted text-uppercase small fw-bold mt-3 mb-1">${esc(title)}</div>
        <table class="table table-sm mb-0"><tbody>${body}</tbody></table>
    `;
}

function renderStatusTable(container, s) {
    const bat = s.bat;
    const pct = batteryPercent(bat);
    const batStr = bat != null
        ? `${pct != null ? pct + '% / ' : ''}${(bat / 1000).toFixed(2)} V`
        : '—';
    const util = (s.airtime != null && s.rx_airtime != null && s.uptime)
        ? (((s.airtime + s.rx_airtime) / s.uptime) * 100).toFixed(2) + '%'
        : '—';

    // Row labels use t(), not tHtml(): statusSection() runs esc() over the
    // title and every label, so a pre-escaped value would be escaped twice.
    // "flood" / "direct" inside the values are protocol terms and stay
    // English (see docs/translations.md).
    const system = statusSection(t('rptmgmt.status.system'), [
        [t('rptmgmt.status.battery'), batStr],
        [t('rptmgmt.status.uptime'), fmtDuration(s.uptime)],
        [t('rptmgmt.status.clock'), '<span id="statusClock" class="text-muted">…</span>'],
        [t('rptmgmt.status.queue'), fmtInt(s.tx_queue_len)],
        [t('rptmgmt.status.events'), fmtInt(s.full_evts)],
    ]);
    const radio = statusSection(t('rptmgmt.status.radio'), [
        [t('rptmgmt.status.last_rssi'), s.last_rssi != null ? `${s.last_rssi} dBm` : '—'],
        [t('rptmgmt.status.last_snr'), s.last_snr != null ? `${s.last_snr} dB` : '—'],
        [t('rptmgmt.status.noise'), s.noise_floor != null ? `${s.noise_floor} dBm` : '—'],
        [t('rptmgmt.status.tx_airtime'), fmtDuration(s.airtime)],
        [t('rptmgmt.status.rx_airtime'), fmtDuration(s.rx_airtime)],
    ]);
    const packets = statusSection(t('rptmgmt.status.packets'), [
        [t('rptmgmt.status.sent'), `${fmtInt(s.nb_sent)} <span class="text-muted small">(flood ${fmtInt(s.sent_flood)} · direct ${fmtInt(s.sent_direct)})</span>`],
        [t('rptmgmt.status.received'), `${fmtInt(s.nb_recv)} <span class="text-muted small">(flood ${fmtInt(s.recv_flood)} · direct ${fmtInt(s.recv_direct)})</span>`],
        [t('rptmgmt.status.duplicates'), `<span class="text-muted small">flood</span> ${fmtInt(s.flood_dups)} · <span class="text-muted small">direct</span> ${fmtInt(s.direct_dups)}`],
        ...(s.recv_errors != null ? [[t('rptmgmt.status.rx_errors'), fmtInt(s.recv_errors)]] : []),
        [t('rptmgmt.status.utilization'), util],
    ]);

    container.innerHTML = system + radio + packets;
}

// ================================================================
// Telemetry tool
// ================================================================

// Cayenne LPP type name -> {unit, decimals, icon}
// TELEM_CHANNEL_SELF in the firmware: the node's own vitals, as opposed to
// readings from sensors attached to it.
const TELEM_CHANNEL_SELF = 1;

const LPP_DISPLAY = {
    'voltage':        { unit: 'V',   icon: 'bi-battery-half' },
    'current':        { unit: 'A',   icon: 'bi-lightning-charge' },
    'power':          { unit: 'W',   icon: 'bi-plug' },
    'energy':         { unit: 'kWh', icon: 'bi-plug-fill' },
    'temperature':    { unit: '°C',  icon: 'bi-thermometer-half' },
    'humidity':       { unit: '%',   icon: 'bi-droplet' },
    'percentage':     { unit: '%',   icon: 'bi-percent' },
    'barometer':      { unit: 'hPa', icon: 'bi-speedometer2' },
    'illuminance':    { unit: 'lx',  icon: 'bi-sun' },
    'altitude':       { unit: 'm',   icon: 'bi-arrow-up-right' },
    'distance':       { unit: 'm',   icon: 'bi-rulers' },
    'frequency':      { unit: 'Hz',  icon: 'bi-soundwave' },
    'concentration':  { unit: 'ppm', icon: 'bi-cloud-haze' },
    'load':           { unit: 'kg',  icon: 'bi-box' },
    'direction':      { unit: '°',   icon: 'bi-compass' },
    'gps':            { unit: '',    icon: 'bi-geo-alt' },
    'digital input':  { unit: '',    icon: 'bi-toggle-on' },
    'digital output': { unit: '',    icon: 'bi-toggle-off' },
    'analog input':   { unit: '',    icon: 'bi-sliders' },
    'analog output':  { unit: '',    icon: 'bi-sliders' },
    'generic sensor': { unit: '',    icon: 'bi-cpu' },
    'presence':       { unit: '',    icon: 'bi-person-check' },
    'switch':         { unit: '',    icon: 'bi-toggle2-on' },
    'time':           { unit: '',    icon: 'bi-clock' },
};

function fmtLppValue(type, value) {
    if (value == null) return '—';
    if (type === 'gps' && typeof value === 'object') {
        // lib returns {latitude, longitude, altitude}; tolerate array form too
        const lat = value.latitude ?? value[0];
        const lon = value.longitude ?? value[1];
        const alt = value.altitude ?? value[2];
        if (lat == null || lon == null) return esc(JSON.stringify(value));
        let s = `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
        if (alt != null) s += ` (${Number(alt).toFixed(0)} m)`;
        return esc(s);
    }
    if (Array.isArray(value)) return esc(value.join(', '));
    if (typeof value === 'object') return esc(JSON.stringify(value));
    if (typeof value === 'number' && !Number.isInteger(value)) {
        // Trim float noise, keep up to 3 decimals
        return esc(String(Math.round(value * 1000) / 1000));
    }
    return esc(String(value));
}

let _telemetryUpdatedAt = null;
let _telemetryTimer = null;

function renderTelemetryPane(body) {
    body.innerHTML = `
        <div class="d-flex align-items-center mb-2">
            <span class="text-muted small flex-grow-1" id="telemetryUpdated"></span>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="telemetryRefreshBtn" title="${tHtml('rptmgmt.tel.refresh_title')}">
                <i class="bi bi-arrow-clockwise"></i> ${tHtml('common.refresh')}
            </button>
        </div>
        <div id="telemetryContainer"></div>
    `;
    body.querySelector('#telemetryRefreshBtn').addEventListener('click', loadTelemetry);
    loadTelemetry();
}

function setTelemetryUpdatedLabel() {
    if (_telemetryTimer) { clearInterval(_telemetryTimer); _telemetryTimer = null; }
    if (!_telemetryUpdatedAt) return;
    const tick = () => {
        const label = document.getElementById('telemetryUpdated');
        if (!label) { clearInterval(_telemetryTimer); _telemetryTimer = null; return; }
        const secs = Math.floor((Date.now() - _telemetryUpdatedAt) / 1000);
        if (secs < 2) label.textContent = t('rptmgmt.updated_just_now');
        else if (secs < 60) label.textContent = t('rptmgmt.updated_ago', { time: `${secs}s` });
        else label.textContent = t('rptmgmt.updated_ago', { time: fmtDuration(secs) });
    };
    tick();
    _telemetryTimer = setInterval(tick, 5000);
}

async function loadTelemetry() {
    const container = document.getElementById('telemetryContainer');
    const btn = document.getElementById('telemetryRefreshBtn');
    if (!container) return;
    if (btn) btn.disabled = true;
    container.innerHTML = `
        <div class="text-center text-muted py-4">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="mt-2 mb-0">${tHtml('rptmgmt.tel.loading')}<br>
            <span class="small">${tHtml('rptmgmt.tel.loading_hint')}</span></p>
        </div>
    `;

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/telemetry`);
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }
    if (btn) btn.disabled = false;

    if (!data || !data.success) {
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-2">${esc((data && data.error) || t('rptmgmt.telemetry_failed'))}</p>
                <button type="button" class="btn btn-sm btn-primary" id="telemetryRetryBtn">
                    <i class="bi bi-arrow-clockwise"></i> ${tHtml('common.try_again')}
                </button>
            </div>
        `;
        const retry = document.getElementById('telemetryRetryBtn');
        if (retry) retry.addEventListener('click', loadTelemetry);
        return;
    }

    renderTelemetryCards(container, data.lpp || []);
    _telemetryUpdatedAt = Date.now();
    setTelemetryUpdatedLabel();
}

function renderTelemetryCards(container, lpp) {
    if (!lpp.length) {
        container.innerHTML = `<div class="text-muted text-center py-4">${tHtml('rptmgmt.telemetry_none')}</div>`;
        return;
    }

    // Group entries by channel, keep entry order inside a channel
    const byChannel = new Map();
    lpp.forEach(entry => {
        const ch = entry.channel ?? 0;
        if (!byChannel.has(ch)) byChannel.set(ch, []);
        byChannel.get(ch).push(entry);
    });
    const channels = [...byChannel.keys()].sort((a, b) => a - b);

    let html = '<div class="row g-3">';
    channels.forEach(ch => {
        const rows = byChannel.get(ch).map(entry => {
            // Firmware v1.17+ appends the on-die MCU temperature to channel 1.
            // That is silicon, typically well above ambient, so it must not
            // read as an environmental sensor. Board-dependent (the firmware
            // skips it when the chip has no usable sensor, e.g. ESP32-C3) —
            // absent simply means no row, never a zero.
            const isMcuTemp = ch === TELEM_CHANNEL_SELF && entry.type === 'temperature';
            const disp = isMcuTemp
                ? { unit: '°C', icon: 'bi-cpu' }
                : (LPP_DISPLAY[entry.type] || { unit: '', icon: 'bi-activity' });
            const label = isMcuTemp
                ? tHtml('rptmgmt.tel.mcu_temp')
                : esc(entry.type.charAt(0).toUpperCase() + entry.type.slice(1));
            const value = fmtLppValue(entry.type, entry.value);
            return `
                <tr>
                    <td class="text-muted"><i class="bi ${disp.icon} me-1"></i>${label}</td>
                    <td class="text-end fw-medium">${value}${disp.unit ? ' ' + disp.unit : ''}</td>
                </tr>
            `;
        }).join('');
        // Channel 1 carries the repeater's own vitals (battery, MCU temp)
        const chLabel = ch === TELEM_CHANNEL_SELF
            ? `${tHtml('rptmgmt.tel.channel', { n: ch })} <span class="text-muted fw-normal">· ${tHtml('rptmgmt.tel.device_suffix')}</span>`
            : tHtml('rptmgmt.tel.channel', { n: ch });
        html += `
            <div class="col-12 col-md-6 col-xl-4">
                <div class="border rounded p-2 h-100">
                    <div class="small fw-bold mb-1">${chLabel}</div>
                    <table class="table table-sm mb-0"><tbody>${rows}</tbody></table>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
}

// ================================================================
// CLI tool
// ================================================================

const CLI_QUICK_COMMANDS = ['get name', 'get radio', 'get tx', 'ver', 'clock', 'neighbors'];
let _cliHistory = [];
let _cliHistoryIndex = -1;
let _cliPending = false;

function cliHistoryKey() {
    return `mc-webui-rpt-cli-history-${_pubkey}`;
}

function loadCliHistory() {
    try {
        _cliHistory = JSON.parse(localStorage.getItem(cliHistoryKey()) || '[]');
    } catch (e) {
        _cliHistory = [];
    }
    _cliHistoryIndex = -1;
}

function pushCliHistory(cmd) {
    _cliHistory = _cliHistory.filter(c => c !== cmd);
    _cliHistory.push(cmd);
    if (_cliHistory.length > 50) _cliHistory = _cliHistory.slice(-50);
    localStorage.setItem(cliHistoryKey(), JSON.stringify(_cliHistory));
    _cliHistoryIndex = -1;
}

function renderCliPane(body) {
    loadCliHistory();
    _cliPending = false;
    const chips = CLI_QUICK_COMMANDS.map(c =>
        `<button type="button" class="btn btn-outline-secondary btn-sm cli-chip font-monospace" data-cmd="${esc(c)}">${esc(c)}</button>`
    ).join('');
    body.innerHTML = `
        <div class="cli-terminal" id="cliOutput">
            <div class="cli-line meta">${tHtml('rptmgmt.cli.intro', { name: _repeater ? _repeater.name : t('rptmgmt.cli.the_repeater') })}</div>
        </div>
        <div class="d-flex flex-wrap gap-1 mt-2">${chips}</div>
        <form id="cliForm" class="d-flex gap-2 mt-2">
            <input type="text" id="cliInput" class="form-control form-control-sm font-monospace"
                   placeholder="${tHtml('rptmgmt.cli.input_ph')}" autocomplete="off"
                   autocapitalize="off" spellcheck="false">
            <button type="submit" class="btn btn-sm btn-success" id="cliSendBtn">
                <i class="bi bi-send"></i>
            </button>
        </form>
    `;

    const form = body.querySelector('#cliForm');
    const input = body.querySelector('#cliInput');

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        sendCliCommand(input.value);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!_cliHistory.length) return;
            if (_cliHistoryIndex === -1) _cliHistoryIndex = _cliHistory.length;
            if (_cliHistoryIndex > 0) _cliHistoryIndex--;
            input.value = _cliHistory[_cliHistoryIndex] || '';
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (_cliHistoryIndex === -1) return;
            _cliHistoryIndex++;
            if (_cliHistoryIndex >= _cliHistory.length) {
                _cliHistoryIndex = -1;
                input.value = '';
            } else {
                input.value = _cliHistory[_cliHistoryIndex] || '';
            }
        }
    });

    body.querySelectorAll('.cli-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            input.value = chip.dataset.cmd;
            input.focus();
        });
    });

    setTimeout(() => input.focus(), 200);
}

function cliAppend(cls, text) {
    const out = document.getElementById('cliOutput');
    if (!out) return null;
    const line = document.createElement('div');
    line.className = `cli-line ${cls}`;
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
    return line;
}

async function sendCliCommand(raw) {
    const command = (raw || '').trim();
    const input = document.getElementById('cliInput');
    const sendBtn = document.getElementById('cliSendBtn');
    if (!command || _cliPending) return;

    _cliPending = true;
    if (input) { input.value = ''; input.disabled = true; }
    if (sendBtn) sendBtn.disabled = true;
    pushCliHistory(command);

    cliAppend('cmd', command);
    const pendingLine = cliAppend('meta cli-pending', t('rptmgmt.cli.waiting'));

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/cli`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        });
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }

    if (pendingLine) pendingLine.remove();
    if (data && data.success) {
        cliAppend('reply', data.output || t('rptmgmt.cli.empty_reply'));
        if (data.elapsed_ms != null) {
            cliAppend('meta', `(${(data.elapsed_ms / 1000).toFixed(1)} s)`);
        }
    } else {
        cliAppend('error', (data && data.error) || t('rptmgmt.command_failed'));
    }

    _cliPending = false;
    if (input) { input.disabled = false; input.focus(); }
    if (sendBtn) sendBtn.disabled = false;
}

// ================================================================
// Neighbors tool
// ================================================================

let _neighborsData = null;      // last successful response
let _neighborsView = 'list';    // 'list' | 'map'
let _nbMap = null;
let _nbMapLayers = null;
let _nbModal = null;            // neighbour detail / remove dialog
let _nbModalIdx = null;         // index into _neighborsData.entries
let _nbActionPending = false;

function renderNeighborsPane(body) {
    _neighborsView = 'list';
    _nbMap = null;   // pane body was rebuilt; force map re-init
    _nbActionPending = false;
    // The list itself only needs a login, but discovery and removal write to the
    // repeater, so the menu holding them is admin-only (and so is its backend).
    const isAdmin = !!(_session && _session.is_admin);
    body.innerHTML = `
        <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
            <span class="text-muted small flex-grow-1" id="neighborsCount"></span>
            <div class="btn-group btn-group-sm" role="group" id="neighborsViewToggle" style="display: none;">
                <button type="button" class="btn btn-outline-secondary active" id="nbListBtn">
                    <i class="bi bi-list-ul"></i> ${tHtml('rptmgmt.neigh.list')}
                </button>
                <button type="button" class="btn btn-outline-secondary" id="nbMapBtn">
                    <i class="bi bi-map"></i> ${tHtml('rptmgmt.neigh.map')}
                </button>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="neighborsRefreshBtn" title="${tHtml('rptmgmt.neigh.refresh_title')}">
                <i class="bi bi-arrow-clockwise"></i>
                <span class="d-none d-sm-inline">${tHtml('common.refresh')}</span>
            </button>
            ${isAdmin ? `
            <div class="dropdown">
                <button type="button" class="btn btn-sm btn-outline-secondary" id="neighborsMenuBtn"
                        data-bs-toggle="dropdown" aria-expanded="false"
                        title="${tHtml('rptmgmt.neigh.menu_title')}">
                    <i class="bi bi-three-dots-vertical"></i>
                </button>
                <ul class="dropdown-menu dropdown-menu-end">
                    <li><button type="button" class="dropdown-item" id="nbDiscoverBtn">
                        <i class="bi bi-broadcast me-2"></i>${tHtml('rptmgmt.neigh.discover')}
                    </button></li>
                    <li><hr class="dropdown-divider"></li>
                    <li><button type="button" class="dropdown-item text-danger" id="nbRemoveAllBtn">
                        <i class="bi bi-trash me-2"></i>${tHtml('rptmgmt.neigh.remove_all')}
                    </button></li>
                </ul>
            </div>` : ''}
        </div>
        <div class="alert py-2 small d-none" id="nbActionNote"></div>
        <div id="neighborsContainer"></div>
        <div id="neighborsMapWrap" style="display: none;">
            <div id="nbLeafletMap" style="height: 420px; width: 100%;" class="rounded border"></div>
            <div class="small text-muted mt-1" id="nbMapNote"></div>
        </div>
    `;
    body.querySelector('#neighborsRefreshBtn').addEventListener('click', () => {
        hideNeighborsNote();
        loadNeighbors();
    });
    body.querySelector('#nbListBtn').addEventListener('click', () => setNeighborsView('list'));
    body.querySelector('#nbMapBtn').addEventListener('click', () => setNeighborsView('map'));
    const discoverBtn = body.querySelector('#nbDiscoverBtn');
    if (discoverBtn) discoverBtn.addEventListener('click', runNeighborDiscover);
    const removeAllBtn = body.querySelector('#nbRemoveAllBtn');
    if (removeAllBtn) removeAllBtn.addEventListener('click', removeAllNeighbors);
    loadNeighbors();
}

function showNeighborsNote(text, kind) {
    const el = document.getElementById('nbActionNote');
    if (!el) return;
    el.className = `alert alert-${kind || 'info'} py-2 small`;
    el.textContent = text;
}

function hideNeighborsNote() {
    const el = document.getElementById('nbActionNote');
    if (el) el.className = 'alert py-2 small d-none';
}

function closeNeighborsMenu() {
    const btn = document.getElementById('neighborsMenuBtn');
    if (btn && window.bootstrap) bootstrap.Dropdown.getOrCreateInstance(btn).hide();
}

function setNeighborsBusy(busy) {
    _nbActionPending = busy;
    ['neighborsRefreshBtn', 'neighborsMenuBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = busy;
    });
}

// `discover.neighbors` only asks the repeater to broadcast the request - answers
// trickle in over the next minute, so the list is deliberately NOT reloaded here.
async function runNeighborDiscover() {
    if (_nbActionPending) return;
    closeNeighborsMenu();
    setNeighborsBusy(true);
    showNeighborsNote(t('rptmgmt.neigh.discover_sending'), 'info');
    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'discover_neighbours' })
        });
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }
    setNeighborsBusy(false);

    if (data && data.success && data.ok) {
        showNeighborsNote(t('rptmgmt.neigh.discover_sent'), 'success');
        return;
    }
    // Node types other than repeaters have no discover.neighbors at all, so their
    // complaint is the useful part of the answer - show it verbatim.
    const err = (data && (data.reply || data.error)) || t('rptmgmt.action_failed');
    showNeighborsNote(err, 'warning');
    showNotification(err, 'warning');
}

async function removeAllNeighbors() {
    if (_nbActionPending) return;
    closeNeighborsMenu();
    if (!window.confirm(t('rptmgmt.neigh.confirm_remove_all', {
            name: (_repeater && _repeater.name) || t('rptmgmt.this_repeater'),
        }))) {
        return;
    }
    await removeNeighbors('', t('rptmgmt.neigh.removed_all'));
}

async function removeNeighbors(prefix, successMsg) {
    if (_nbActionPending) return;
    setNeighborsBusy(true);
    showNeighborsNote(t('rptmgmt.neigh.removing'), 'info');
    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/neighbours/remove`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prefix })
        });
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }
    setNeighborsBusy(false);

    if (data && data.success && data.ok) {
        showNeighborsNote(successMsg, 'success');
        showNotification(successMsg, 'success');
        await loadNeighbors();
        return;
    }
    const err = (data && (data.reply || data.error)) || t('rptmgmt.action_failed');
    showNeighborsNote(err, 'danger');
    showNotification(err, 'danger');
}

async function loadNeighbors() {
    const container = document.getElementById('neighborsContainer');
    const btn = document.getElementById('neighborsRefreshBtn');
    if (!container) return;
    if (btn) btn.disabled = true;
    setNeighborsView('list');
    container.innerHTML = `
        <div class="text-center text-muted py-4">
            <div class="spinner-border text-primary" role="status"></div>
            <p class="mt-2 mb-0">${tHtml('rptmgmt.neigh.loading')}<br>
            <span class="small">${tHtml('rptmgmt.neigh.loading_hint')}</span></p>
        </div>
    `;

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/neighbours`);
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }
    if (btn) btn.disabled = false;

    if (!data || !data.success) {
        const countEl = document.getElementById('neighborsCount');
        if (countEl) countEl.textContent = '';
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-2">${esc((data && data.error) || t('rptmgmt.neighbours_failed'))}</p>
                <button type="button" class="btn btn-sm btn-primary" id="neighborsRetryBtn">
                    <i class="bi bi-arrow-clockwise"></i> ${tHtml('common.try_again')}
                </button>
            </div>
        `;
        const retry = document.getElementById('neighborsRetryBtn');
        if (retry) retry.addEventListener('click', loadNeighbors);
        return;
    }

    _neighborsData = data;
    renderNeighborsList();
}

function neighborLabel(n) {
    return n.name || `[${n.pubkey_prefix}]`;
}

function renderNeighborsList() {
    const container = document.getElementById('neighborsContainer');
    const countEl = document.getElementById('neighborsCount');
    const toggle = document.getElementById('neighborsViewToggle');
    const data = _neighborsData;
    if (!container || !data) return;

    const entries = data.entries || [];
    if (countEl) {
        let label = tn('rptmgmt.neigh.count', data.total);
        if (data.fetched < data.total) label += ` ${t('rptmgmt.neigh.showing', { count: data.fetched })}`;
        countEl.textContent = label;
    }

    // Map view is offered when the repeater or any neighbour has a position
    const mappable = entries.some(n => hasValidGps(n, 'lat', 'lon'))
        || hasValidGps(_repeater);
    if (toggle) toggle.style.display = mappable ? '' : 'none';

    if (!entries.length) {
        container.innerHTML = `<div class="text-muted text-center py-4">${tHtml('rptmgmt.neighbours_none')}<br><small>${tHtml('rptmgmt.neighbours_none_hint')}</small></div>`;
        return;
    }

    // Rows open a detail dialog rather than carrying their own buttons: the name
    // column is already truncated on a phone, and a trash icon at the edge of a
    // scrolling list is the easiest thing in the panel to hit by accident.
    const rows = entries.map((n, i) => `
        <tr class="nb-row" data-nb-idx="${i}" role="button" style="cursor: pointer;">
            <td class="text-truncate" style="max-width: min(220px, 40vw);">
                ${n.name ? esc(n.name) : `<span class="font-monospace text-muted">[${esc(n.pubkey_prefix)}]</span>`}
                ${n.lat != null ? `<i class="bi bi-geo-alt text-muted small ms-1" title="${tHtml('rptmgmt.neigh.position_title')}"></i>` : ''}
            </td>
            <td class="text-muted text-nowrap">${fmtHeardAgo(n.secs_ago)}</td>
            <td class="text-end text-nowrap fw-medium">${n.snr != null ? n.snr + ' dB' : '—'}</td>
        </tr>
    `).join('');
    container.innerHTML = `
        <div class="table-responsive">
        <table class="table table-sm align-middle mb-0">
            <thead><tr class="small text-muted">
                <th class="fw-normal">${tHtml('rptmgmt.neigh.repeater')}</th>
                <th class="fw-normal">${tHtml('rptmgmt.neigh.heard')}</th>
                <th class="fw-normal text-end">SNR</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        </div>
        <div class="small text-muted mt-2">
            <i class="bi bi-info-circle me-1"></i>${tHtml('rptmgmt.neigh.row_hint')}
        </div>
    `;
    container.querySelectorAll('.nb-row').forEach(row => {
        row.addEventListener('click', () => openNeighborModal(Number(row.dataset.nbIdx)));
    });
}

function neighborDetailRow(label, value, mono) {
    return `<dt class="col-5 fw-normal text-muted">${esc(label)}</dt>` +
           `<dd class="col-7 mb-1${mono ? ' font-monospace' : ''}">${esc(value)}</dd>`;
}

function openNeighborModal(idx) {
    const entries = (_neighborsData && _neighborsData.entries) || [];
    const n = entries[idx];
    if (!n || !_nbModal) return;
    _nbModalIdx = idx;

    document.getElementById('neighborModalTitle').textContent = neighborLabel(n);
    const rows = [
        neighborDetailRow(t('rptmgmt.neigh.pubkey'), n.pubkey_prefix, true),
        neighborDetailRow('SNR', n.snr != null ? `${n.snr} dB` : '—'),
        neighborDetailRow(t('rptmgmt.neigh.heard'), fmtHeardAgo(n.secs_ago)),
    ];
    if (n.lat != null && n.lon != null) {
        rows.push(neighborDetailRow(t('rptmgmt.neigh.position'),
                                    `${n.lat.toFixed(4)}, ${n.lon.toFixed(4)}`, true));
    }
    document.getElementById('neighborModalDetails').innerHTML = rows.join('');

    // Non-admins may look at a neighbour, but only an admin may drop it.
    const isAdmin = !!(_session && _session.is_admin);
    document.getElementById('neighborRemoveBtn').style.display = isAdmin ? '' : 'none';
    document.getElementById('neighborModalNote').style.display = isAdmin ? '' : 'none';
    _nbModal.show();
}

async function submitNeighborRemove() {
    const entries = (_neighborsData && _neighborsData.entries) || [];
    const n = entries[_nbModalIdx];
    if (!n) return;
    if (_nbModal) _nbModal.hide();
    await removeNeighbors(n.pubkey_prefix,
                          t('rptmgmt.neigh.removed_one', { name: neighborLabel(n) }));
}

function fmtHeardAgo(secs) {
    if (secs == null) return '—';
    if (secs < 60) return t('rptmgmt.ago_s', { s: secs });
    if (secs < 3600) return t('rptmgmt.ago_ms', { m: Math.floor(secs / 60), s: secs % 60 });
    if (secs < 86400) return t('rptmgmt.ago_hm', { h: Math.floor(secs / 3600), m: Math.floor((secs % 3600) / 60) });
    return t('rptmgmt.ago_dh', { d: Math.floor(secs / 86400), h: Math.floor((secs % 86400) / 3600) });
}

function setNeighborsView(view) {
    _neighborsView = view;
    const listWrap = document.getElementById('neighborsContainer');
    const mapWrap = document.getElementById('neighborsMapWrap');
    const listBtn = document.getElementById('nbListBtn');
    const mapBtn = document.getElementById('nbMapBtn');
    if (!listWrap || !mapWrap) return;
    const isMap = view === 'map';
    listWrap.style.display = isMap ? 'none' : '';
    mapWrap.style.display = isMap ? '' : 'none';
    if (listBtn) listBtn.classList.toggle('active', !isMap);
    if (mapBtn) mapBtn.classList.toggle('active', isMap);
    if (isMap) renderNeighborsMap();
}

function renderNeighborsMap() {
    const data = _neighborsData;
    if (!data) return;

    if (!_nbMap) {
        _nbMap = L.map('nbLeafletMap').setView([52.0, 19.0], 6);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
        }).addTo(_nbMap);
        _nbMapLayers = L.layerGroup().addTo(_nbMap);
        // Popups are rebuilt on every render, so the handler lives on the map
        // and reads the index off the button it finds inside the open popup.
        _nbMap.on('popupopen', (e) => {
            const el = e.popup.getElement();
            const btn = el ? el.querySelector('.nb-popup-remove') : null;
            if (!btn) return;
            btn.addEventListener('click', () => {
                _nbMap.closePopup();
                openNeighborModal(Number(btn.dataset.nbIdx));
            });
        });
    }
    _nbMapLayers.clearLayers();

    const hasCenter = hasValidGps(_repeater);
    const center = hasCenter ? [_repeater.adv_lat, _repeater.adv_lon] : null;
    const bounds = [];

    if (hasCenter) {
        const centerMarker = L.circleMarker(center, {
            radius: 11,
            fillColor: '#dc3545',
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.9
        }).addTo(_nbMapLayers);
        centerMarker.bindPopup(`<b>${esc(_repeater.name || t('rptmgmt.this_repeater'))}</b><br>${tHtml('rptmgmt.managed_repeater')}`);
        bounds.push(center);
    }

    let placed = 0;
    let skipped = 0;
    const canRemove = !!(_session && _session.is_admin);
    (data.entries || []).forEach((n, i) => {
        if (!hasValidGps(n, 'lat', 'lon')) { skipped++; return; }
        const pos = [n.lat, n.lon];
        const marker = L.circleMarker(pos, {
            radius: 9,
            fillColor: '#198754',
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.85
        }).addTo(_nbMapLayers);
        marker.bindPopup(
            `<b>${esc(neighborLabel(n))}</b><br>` +
            `SNR: ${n.snr != null ? n.snr + ' dB' : '—'}<br>` +
            tHtml('rptmgmt.neigh.heard_at', { time: fmtHeardAgo(n.secs_ago) }) +
            (canRemove
                ? `<br><button type="button" class="btn btn-sm btn-outline-danger mt-2 nb-popup-remove" data-nb-idx="${i}">`
                  + `<i class="bi bi-trash"></i> ${tHtml('rptmgmt.neigh.remove_btn')}</button>`
                : '')
        );
        if (hasCenter) {
            const line = L.polyline([center, pos], {
                color: '#6c757d',
                weight: 2,
                dashArray: '6 6',
                opacity: 0.8
            }).addTo(_nbMapLayers);
            line.bindTooltip(`${n.snr != null ? n.snr + ' dB' : '?'}`, {
                permanent: true,
                direction: 'center',
                className: 'nb-snr-tooltip'
            });
        }
        bounds.push(pos);
        placed++;
    });

    const note = document.getElementById('nbMapNote');
    if (note) {
        const parts = [`${placed} neighbor${placed === 1 ? '' : 's'} with known position`];
        if (skipped) parts.push(`${skipped} without position not shown`);
        if (!hasCenter) parts.push('managed repeater has no position — connection lines unavailable');
        note.textContent = parts.join(' · ');
    }

    // Leaflet needs a size recalc after the container becomes visible
    setTimeout(() => {
        _nbMap.invalidateSize();
        fitMapToPoints(_nbMap, bounds, { padding: [30, 30] });
    }, 50);
}

async function loadClock() {
    const el = document.getElementById('statusClock');
    if (!el) return;
    el.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/clock`);
        const data = await resp.json();
        if (data.success && data.timestamp) {
            const d = new Date(data.timestamp * 1000);
            el.classList.remove('text-muted');
            // Repeaters keep their RTC in UTC and their own CLI prints it as UTC,
            // but this renders in the browser's zone — so name the zone, or the two
            // readings look like different times. `timeZoneName` on its own still
            // yields the full date + time: it is not a date/time component option,
            // so it does not suppress the defaults.
            el.textContent = d.toLocaleString([], { timeZoneName: 'short' });
        } else {
            el.className = '';
            el.innerHTML = `<button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="clockRetryBtn">${tHtml('rptmgmt.status.clock_fetch')}</button>`;
            const b = document.getElementById('clockRetryBtn');
            if (b) b.addEventListener('click', loadClock);
        }
    } catch (e) {
        el.className = '';
        el.innerHTML = `<button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="clockRetryBtn">${tHtml('rptmgmt.status.clock_fetch')}</button>`;
        const b = document.getElementById('clockRetryBtn');
        if (b) b.addEventListener('click', loadClock);
    }
}

// ================================================================
// Settings tool
// ================================================================

// Sections and fields mirror _REPEATER_SETTINGS_FIELDS in api.py.
// Values travel as raw CLI strings (`get X` → `> value`, `set X value`).
// title/label/help/note hold catalog KEYS, resolved with t() at render time.
// `key` is the firmware CLI parameter and is never translated.
const SETTINGS_SECTIONS = [
    { key: 'basic', title: 'rptmgmt.set.basic', icon: 'bi-tag', fields: [
        { key: 'name', label: 'rptmgmt.set.name', type: 'text' },
        { key: 'password', label: 'rptmgmt.set.password', type: 'password', writeOnly: true,
          help: 'rptmgmt.set.password_help' },
        { key: 'guest.password', label: 'rptmgmt.set.guest_password', type: 'text',
          help: 'rptmgmt.set.guest_password_help' },
    ]},
    { key: 'radio', title: 'rptmgmt.set.radio', icon: 'bi-broadcast',
      note: 'rptmgmt.set.radio_note',
      fields: [
        { key: 'radio', label: 'rptmgmt.set.radio_params', type: 'radio4' },
        { key: 'tx', label: 'rptmgmt.set.tx', type: 'number', min: 0, max: 30, step: 1 },
        { key: 'radio.rxgain', label: 'rptmgmt.set.rxgain', type: 'onoff' },
    ]},
    { key: 'location', title: 'rptmgmt.set.location', icon: 'bi-geo-alt', fields: [
        { key: 'lat', label: 'rptmgmt.set.lat', type: 'text' },
        { key: 'lon', label: 'rptmgmt.set.lon', type: 'text' },
    ]},
    { key: 'features', title: 'rptmgmt.set.features', icon: 'bi-toggles', fields: [
        { key: 'repeat', label: 'rptmgmt.set.repeat', type: 'onoff' },
        { key: 'allow.read.only', label: 'rptmgmt.set.allow_read_only', type: 'onoff' },
        { key: 'multi.acks', label: 'rptmgmt.set.multi_acks', type: 'zeroone' },
    ]},
    { key: 'network', title: 'rptmgmt.set.network', icon: 'bi-heart-pulse', fields: [
        { key: 'loop.detect', label: 'rptmgmt.set.loop_detect', type: 'select',
          options: ['off', 'minimal', 'moderate', 'strict'] },
        { key: 'dutycycle', label: 'rptmgmt.set.dutycycle', type: 'number', min: 1, max: 100, step: 1 },
    ]},
    { key: 'advert', title: 'rptmgmt.set.advert', icon: 'bi-megaphone', fields: [
        { key: 'advert.interval', label: 'rptmgmt.set.advert_interval', type: 'number', min: 0, max: 240, step: 1,
          help: 'rptmgmt.set.advert_interval_help' },
        { key: 'flood.advert.interval', label: 'rptmgmt.set.flood_advert_interval', type: 'number', min: 0, step: 1 },
        { key: 'flood.max', label: 'rptmgmt.set.flood_max', type: 'number', min: 0, max: 64, step: 1 },
        { key: 'flood.max.unscoped', label: 'rptmgmt.set.flood_max_unscoped', type: 'number', min: 0, max: 64, step: 1,
          help: 'rptmgmt.set.flood_max_unscoped_help' },
        { key: 'flood.max.advert', label: 'rptmgmt.set.flood_max_advert', type: 'number', min: 0, max: 64, step: 1,
          help: 'rptmgmt.set.flood_max_advert_help' },
    ]},
    { key: 'operator', title: 'rptmgmt.set.operator', icon: 'bi-person-vcard', fields: [
        { key: 'owner.info', label: 'rptmgmt.set.owner_info', type: 'textarea',
          help: 'rptmgmt.set.owner_info_help' },
    ]},
    { key: 'advanced', title: 'rptmgmt.set.advanced', icon: 'bi-sliders', fields: [
        { key: 'path.hash.mode', label: 'rptmgmt.set.path_hash_mode', type: 'number', min: 0, max: 2, step: 1 },
        { key: 'txdelay', label: 'rptmgmt.set.txdelay', type: 'number', min: 0, max: 2, step: 'any' },
        { key: 'direct.txdelay', label: 'rptmgmt.set.direct_txdelay', type: 'number', min: 0, max: 2, step: 'any' },
        { key: 'int.thresh', label: 'rptmgmt.set.int_thresh', type: 'number', step: 1 },
        { key: 'agc.reset.interval', label: 'rptmgmt.set.agc_reset', type: 'number', min: 0, step: 4,
          help: 'rptmgmt.set.agc_reset_help' },
        // Firmware v1.17+. Older nodes answer `??: cad` and the field renders
        // as "not supported" rather than as an error — see setFieldBadge.
        { key: 'cad', label: 'rptmgmt.set.cad', type: 'onoff', help: 'rptmgmt.set.cad_help' },
    ]},
];

let _settingsState = {};   // section key → {loaded, loadedOnce, loading, applying}

function settingsSection(secKey) {
    return SETTINGS_SECTIONS.find(s => s.key === secKey);
}

function settingsSectionEl(secKey) {
    return document.querySelector(`#settingsAccordion .accordion-item[data-section="${secKey}"]`);
}

function sfControl(item, fieldKey) {
    return item.querySelector(`[data-field="${fieldKey}"]`);
}

function settingsControlHtml(f) {
    const df = `data-field="${esc(f.key)}"`;
    if (f.type === 'onoff' || f.type === 'zeroone') {
        return `<div class="form-check form-switch mb-0">
                    <input class="form-check-input sf-input" type="checkbox" role="switch" ${df} disabled>
                </div>`;
    }
    if (f.type === 'select') {
        const opts = (f.options || []).map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
        return `<select class="form-select form-select-sm sf-input" ${df} disabled>${opts}</select>`;
    }
    if (f.type === 'textarea') {
        return `<textarea class="form-control form-control-sm sf-input" rows="3" ${df} disabled></textarea>`;
    }
    if (f.type === 'password') {
        // Write-only: usable without loading, never prefilled
        return `<input type="password" class="form-control form-control-sm sf-input" ${df}
                       placeholder="${tHtml('rptmgmt.set.pw_unchanged_ph')}" autocomplete="new-password">`;
    }
    if (f.type === 'radio4') {
        const subs = [
            [tHtml('settings.device.freq'), 'any'],
            [tHtml('settings.device.bw'), 'any'],
            [tHtml('settings.device.sf'), '1'],
            [tHtml('settings.device.cr'), '1'],
        ].map(([lbl, step], i) => `
            <div class="col-6 col-lg-3">
                <label class="form-label small text-muted mb-0">${lbl}</label>
                <input type="number" step="${step}" class="form-control form-control-sm sf-sub" data-sub="${i}" disabled>
            </div>`).join('');
        return `<div class="row g-2" ${df}>${subs}</div>`;
    }
    const attrs = [
        f.min != null ? `min="${f.min}"` : '',
        f.max != null ? `max="${f.max}"` : '',
        f.step != null ? `step="${f.step}"` : '',
    ].filter(Boolean).join(' ');
    const type = f.type === 'number' ? 'number' : 'text';
    return `<input type="${type}" ${attrs} class="form-control form-control-sm sf-input" ${df} disabled>`;
}

function settingsFieldHtml(f) {
    return `
        <div class="sf-row mb-3" data-field-row="${esc(f.key)}">
            <label class="form-label small fw-semibold mb-1">${esc(t(f.label))} <span class="sf-badge ms-1"></span></label>
            ${settingsControlHtml(f)}
            <div class="sf-msg small text-danger d-none"></div>
            ${f.help ? `<div class="form-text small mb-0">${esc(t(f.help))}</div>` : ''}
        </div>`;
}

function renderSettingsPane(body) {
    _settingsState = {};
    const items = SETTINGS_SECTIONS.map(sec => {
        _settingsState[sec.key] = { loaded: {}, loadedOnce: false, loading: false, applying: false };
        return `
        <div class="accordion-item" data-section="${sec.key}">
            <h2 class="accordion-header">
                <button class="accordion-button collapsed" type="button" data-bs-toggle="collapse"
                        data-bs-target="#secCollapse-${sec.key}">
                    <i class="bi ${sec.icon} me-2"></i>${esc(t(sec.title))}
                    <span class="badge bg-warning text-dark ms-2 sec-dirty-badge d-none"></span>
                </button>
            </h2>
            <div id="secCollapse-${sec.key}" class="accordion-collapse collapse">
                <div class="accordion-body pt-2">
                    ${sec.note ? `<div class="small text-muted mb-2"><i class="bi bi-info-circle me-1"></i>${esc(t(sec.note))}</div>` : ''}
                    <div class="sec-status small text-muted mb-2 d-none"></div>
                    <div class="sec-reboot alert alert-warning py-1 px-2 small d-none mb-2">
                        <i class="bi bi-arrow-clockwise me-1"></i>${tHtml('rptmgmt.set.reboot_note')}
                    </div>
                    <div class="sec-fields">${sec.fields.map(settingsFieldHtml).join('')}</div>
                    ${sec.key === 'location' ? `
                    <button type="button" class="btn btn-sm btn-outline-primary sec-map-pick" disabled
                            title="${tHtml('rptmgmt.set.map_pick_title')}">
                        <i class="bi bi-geo-alt"></i> ${tHtml('rptmgmt.set.map_pick')}
                    </button>` : ''}
                    <div class="d-flex align-items-center gap-2 mt-3">
                        <button type="button" class="btn btn-sm btn-outline-secondary sec-refresh">
                            <i class="bi bi-arrow-clockwise"></i> ${tHtml('common.refresh')}
                        </button>
                        <button type="button" class="btn btn-sm btn-success sec-apply" disabled>
                            <i class="bi bi-check-lg"></i> ${tHtml('common.apply')}
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');

    body.innerHTML = `
        <p class="text-muted small mb-2">${tHtml('rptmgmt.set.intro')}</p>
        <div class="accordion" id="settingsAccordion">${items}</div>
    `;

    SETTINGS_SECTIONS.forEach(sec => {
        const item = settingsSectionEl(sec.key);
        const collapse = item.querySelector('.accordion-collapse');
        collapse.addEventListener('show.bs.collapse', () => {
            if (!_settingsState[sec.key].loadedOnce) loadSettingsSection(sec.key);
        });
        item.querySelector('.sec-refresh').addEventListener('click', () => loadSettingsSection(sec.key));
        item.querySelector('.sec-apply').addEventListener('click', () => applySettingsSection(sec.key));
        const mapPickBtn = item.querySelector('.sec-map-pick');
        if (mapPickBtn) mapPickBtn.addEventListener('click', openLocationMapPicker);
        item.querySelectorAll('.sf-input, .sf-sub').forEach(inp => {
            const evt = (inp.type === 'checkbox' || inp.tagName === 'SELECT') ? 'change' : 'input';
            inp.addEventListener(evt, () => updateSectionDirty(sec.key));
        });
    });
}

function setSettingsFieldValue(item, f, raw) {
    const el = sfControl(item, f.key);
    if (!el) return;
    const v = String(raw ?? '');
    if (f.type === 'onoff' || f.type === 'zeroone') {
        const low = v.trim().toLowerCase();
        el.checked = (low === 'on' || low === '1' || low === 'true' || low === 'yes');
    } else if (f.type === 'select') {
        const val = v.trim();
        if (![...el.options].some(o => o.value === val)) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            el.appendChild(opt);
        }
        el.value = val;
    } else if (f.type === 'radio4') {
        const parts = v.split(',').map(s => s.trim());
        el.querySelectorAll('.sf-sub').forEach((inp, i) => { inp.value = parts[i] ?? ''; });
    } else if (f.type === 'textarea') {
        el.value = v.split('|').join('\n');
    } else if (f.type === 'number') {
        // Some replies carry a unit suffix (e.g. `get dutycycle` → "70.0%")
        // that a number input would reject wholesale.
        el.value = v.trim().replace(/%$/, '');
    } else {
        el.value = v;
    }
}

function getSettingsFieldValue(item, f) {
    const el = sfControl(item, f.key);
    if (!el) return '';
    if (f.type === 'onoff') return el.checked ? 'on' : 'off';
    if (f.type === 'zeroone') return el.checked ? '1' : '0';
    if (f.type === 'radio4') {
        return [...el.querySelectorAll('.sf-sub')].map(inp => inp.value.trim()).join(',');
    }
    if (f.type === 'textarea') {
        return el.value.replace(/\r/g, '').split('\n').map(s => s.trim()).join('|').replace(/\|+$/, '');
    }
    return el.value.trim();
}

function disableSettingsField(item, f, disabled) {
    const el = sfControl(item, f.key);
    if (!el) return;
    if (f.type === 'radio4') {
        el.querySelectorAll('.sf-sub').forEach(inp => { inp.disabled = disabled; });
    } else {
        el.disabled = disabled;
    }
}

function setFieldBadge(item, fieldKey, kind, text) {
    const row = item.querySelector(`[data-field-row="${fieldKey}"]`);
    if (!row) return;
    const badge = row.querySelector('.sf-badge');
    const msg = row.querySelector('.sf-msg');
    msg.classList.add('d-none');
    msg.classList.toggle('text-danger', kind !== 'unsupported');
    msg.classList.toggle('text-muted', kind === 'unsupported');
    msg.textContent = '';
    if (kind === 'pending') {
        badge.innerHTML = '<span class="spinner-border spinner-border-sm text-muted"></span>';
    } else if (kind === 'ok') {
        badge.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i>';
    } else if (kind === 'reboot') {
        badge.innerHTML = `<span class="badge bg-warning text-dark">${tHtml('rptmgmt.reboot_required')}</span>`;
    } else if (kind === 'unsupported') {
        // Not a failure: the node either runs firmware without this setting or
        // has hardware that cannot do it. Both are permanent properties of the
        // node, so it reads muted and the control stays locked.
        badge.innerHTML = `<span class="badge bg-secondary">${tHtml('rptmgmt.unsupported')}</span>`;
        msg.textContent = text || t('rptmgmt.unsupported_hint');
        msg.classList.remove('d-none');
    } else if (kind === 'error') {
        badge.innerHTML = '<i class="bi bi-exclamation-triangle-fill text-danger"></i>';
        if (text) {
            msg.textContent = text;
            msg.classList.remove('d-none');
        }
    } else {
        badge.innerHTML = '';
    }
}

// A `>` reply can still be an answer to a different question. Up to firmware
// v1.16 the `radio.rxgain` getter was compiled out on radios other than
// SX1262/SX1268/LR1110, and `get radio.rxgain` then fell through to the `radio`
// branch — whose memcmp has no trailing space — so the node answered with its
// radio parameters ("> 869.525,250.00,11,5"). That parses as a valid reply and
// would silently render the switch as off. An on/off field can only ever answer
// on or off, so anything else means the field is not really there.
function valueShapeIsWrong(f, raw) {
    if (f.type !== 'onoff') return false;
    return !['on', 'off'].includes(String(raw ?? '').trim().toLowerCase());
}

function isFieldDirty(item, st, f) {
    if (f.writeOnly) {
        const el = sfControl(item, f.key);
        return !!(el && el.value);
    }
    if (!(f.key in st.loaded)) return false;   // never loaded → not editable
    return getSettingsFieldValue(item, f) !== st.loaded[f.key];
}

function updateSectionDirty(secKey) {
    const item = settingsSectionEl(secKey);
    const st = _settingsState[secKey];
    const sec = settingsSection(secKey);
    if (!item || !st || !sec) return 0;
    let count = 0;
    sec.fields.forEach(f => {
        const dirty = isFieldDirty(item, st, f);
        if (dirty) count++;
        const row = item.querySelector(`[data-field-row="${f.key}"]`);
        if (row) row.classList.toggle('sf-dirty', dirty);
    });
    const applyBtn = item.querySelector('.sec-apply');
    applyBtn.disabled = count === 0 || st.loading || st.applying;
    applyBtn.innerHTML = `<i class="bi bi-check-lg"></i> ${count ? tHtml('rptmgmt.set.apply_count', { count }) : tHtml('common.apply')}`;
    const badge = item.querySelector('.sec-dirty-badge');
    badge.classList.toggle('d-none', count === 0);
    badge.textContent = count;
    return count;
}

async function loadSettingsSection(secKey) {
    const st = _settingsState[secKey];
    const item = settingsSectionEl(secKey);
    const sec = settingsSection(secKey);
    if (!st || !item || !sec || st.loading || st.applying) return;
    st.loading = true;

    const statusEl = item.querySelector('.sec-status');
    statusEl.classList.remove('d-none', 'text-danger');
    statusEl.classList.add('text-muted');
    statusEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>'
        + tHtml('rptmgmt.set.reading');
    item.querySelector('.sec-refresh').disabled = true;
    item.querySelector('.sec-apply').disabled = true;
    const mapPickBtn = item.querySelector('.sec-map-pick');
    if (mapPickBtn) mapPickBtn.disabled = true;
    sec.fields.forEach(f => {
        if (f.writeOnly) return;
        setFieldBadge(item, f.key, 'clear');
        disableSettingsField(item, f, true);
    });

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/settings?section=${encodeURIComponent(secKey)}`);
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }

    st.loading = false;
    item.querySelector('.sec-refresh').disabled = false;

    if (!data || !data.success) {
        statusEl.classList.remove('text-muted');
        statusEl.classList.add('text-danger');
        statusEl.textContent = (data && data.error) || t('rptmgmt.settings_read_failed');
        updateSectionDirty(secKey);
        return;
    }

    const values = data.values || {};
    const errors = data.errors || {};
    const unsupported = data.unsupported || {};
    st.loaded = {};
    let errCount = 0;
    sec.fields.forEach(f => {
        if (f.writeOnly) return;
        if (f.key in values && !valueShapeIsWrong(f, values[f.key])) {
            setSettingsFieldValue(item, f, values[f.key]);
            disableSettingsField(item, f, false);
            // Baseline = the value as the control round-trips it, so
            // firmware formatting quirks never show up as dirty fields.
            st.loaded[f.key] = getSettingsFieldValue(item, f);
            setFieldBadge(item, f.key, 'clear');
        } else if (f.key in unsupported || f.key in values) {
            // Left out of st.loaded on purpose: a field with no baseline can
            // never go dirty, so it is neither editable nor sent on Apply.
            disableSettingsField(item, f, true);
            setFieldBadge(item, f.key, 'unsupported');
        } else {
            errCount++;
            disableSettingsField(item, f, true);
            setFieldBadge(item, f.key, 'error', errors[f.key] || t('rptmgmt.read_failed'));
        }
    });
    if (mapPickBtn) mapPickBtn.disabled = !('lat' in st.loaded && 'lon' in st.loaded);
    st.loadedOnce = true;

    if (errCount) {
        statusEl.classList.remove('text-muted');
        statusEl.classList.add('text-danger');
        statusEl.textContent = tn('rptmgmt.set.load_errors', errCount);
    } else {
        statusEl.classList.add('d-none');
    }
    updateSectionDirty(secKey);
}

async function applySettingsSection(secKey) {
    const st = _settingsState[secKey];
    const item = settingsSectionEl(secKey);
    const sec = settingsSection(secKey);
    if (!st || !item || !sec || st.loading || st.applying) return;

    const dirty = {};
    sec.fields.forEach(f => {
        if (isFieldDirty(item, st, f)) {
            dirty[f.key] = f.writeOnly ? sfControl(item, f.key).value : getSettingsFieldValue(item, f);
        }
    });
    const keys = Object.keys(dirty);
    if (!keys.length) return;

    const emptyKey = keys.find(k => dirty[k] === '' && k !== 'owner.info');
    if (emptyKey) {
        showNotification(t('rptmgmt.toast.field_empty', { field: emptyKey }), 'warning');
        return;
    }

    if ('radio' in dirty && !window.confirm(
            t('rptmgmt.confirm.radio', { params: dirty.radio }))) {
        return;
    }

    st.applying = true;
    item.querySelector('.sec-refresh').disabled = true;
    item.querySelector('.sec-apply').disabled = true;
    keys.forEach(k => setFieldBadge(item, k, 'pending'));

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: dirty })
        });
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }

    st.applying = false;
    item.querySelector('.sec-refresh').disabled = false;

    if (!data || !data.success) {
        keys.forEach(k => setFieldBadge(item, k, 'error'));
        showNotification((data && data.error) || t('rptmgmt.settings_apply_failed'), 'danger');
        updateSectionDirty(secKey);
        return;
    }

    const results = data.results || {};
    let okCount = 0, failCount = 0, rebootCount = 0, unsupCount = 0;
    for (const f of sec.fields) {
        if (!(f.key in dirty)) continue;
        const res = results[f.key] || { status: 'failed', error: t('rptmgmt.no_result') };
        if (res.status === 'unsupported') {
            // Claim nothing about the stored value — v1.17 persists
            // radio.rxgain before it discovers the radio cannot apply it.
            // Dropping the baseline clears the dirty state without asserting
            // the old value survived; Refresh is what reveals the truth.
            unsupCount++;
            setFieldBadge(item, f.key, 'unsupported');
            delete st.loaded[f.key];
            disableSettingsField(item, f, true);
        } else if (res.status === 'ok' || res.status === 'reboot_required') {
            if (res.status === 'reboot_required') {
                rebootCount++;
                setFieldBadge(item, f.key, 'reboot');
            } else {
                okCount++;
                setFieldBadge(item, f.key, 'ok');
            }
            if (f.writeOnly) {
                sfControl(item, f.key).value = '';
                if (f.key === 'password') await syncSavedPassword(dirty[f.key]);
            } else {
                st.loaded[f.key] = dirty[f.key];
                if (f.key === 'name' && _repeater) {
                    _repeater.name = dirty[f.key];
                    renderHeader();
                }
            }
        } else {
            failCount++;
            setFieldBadge(item, f.key, 'error', res.error || res.reply || t('rptmgmt.failed'));
        }
    }

    if (rebootCount) item.querySelector('.sec-reboot').classList.remove('d-none');
    updateSectionDirty(secKey);

    if (failCount) {
        showNotification(tn('rptmgmt.toast.apply_failed_count', failCount), 'danger');
    } else if (unsupCount && !okCount && !rebootCount) {
        // Nothing was applied — saying "applied" here would be a plain lie.
        showNotification(tn('rptmgmt.toast.apply_unsupported_count', unsupCount), 'warning');
    } else if (unsupCount) {
        showNotification(tn('rptmgmt.toast.apply_partial_unsupported', unsupCount), 'warning');
    } else {
        showNotification(rebootCount ? t('rptmgmt.toast.applied_reboot') : t('rptmgmt.toast.applied'), 'success');
    }
    if (okCount) {
        setTimeout(() => {
            sec.fields.forEach(f => {
                const row = item.querySelector(`[data-field-row="${f.key}"]`);
                if (row && row.querySelector('.sf-badge .bi-check-circle-fill')) {
                    setFieldBadge(item, f.key, 'clear');
                }
            });
        }, 4000);
    }
}

async function syncSavedPassword(newPassword) {
    // Keep auto-login working: when a password is saved for this repeater,
    // replace it with the one just set on the repeater itself.
    if (!_repeater || !_repeater.password_set) return;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newPassword })
        });
        const data = await resp.json();
        if (data && data.success) {
            showNotification(t('rptmgmt.toast.password_synced'), 'success');
        }
    } catch (e) {
        console.error('Failed to update saved password:', e);
    }
}

// ---------------- Location map picker (Settings → Location) ----------------

let _locMap = null;
let _locMapMarker = null;
let _locMapModal = null;
let _locMapPicked = null;   // {lat, lon} currently chosen on the map

function openLocationMapPicker() {
    const item = settingsSectionEl('location');
    if (!item) return;
    const latEl = sfControl(item, 'lat');
    const lonEl = sfControl(item, 'lon');

    // Seed from the loaded field values, then the advertised position, then a
    // wide default view of the mesh area.
    let seedLat = parseFloat(latEl && latEl.value);
    let seedLon = parseFloat(lonEl && lonEl.value);
    if (!isFinite(seedLat) || !isFinite(seedLon)) {
        seedLat = (_repeater && _repeater.adv_lat) || NaN;
        seedLon = (_repeater && _repeater.adv_lon) || NaN;
    }
    const hasSeed = isFinite(seedLat) && isFinite(seedLon) && (seedLat !== 0 || seedLon !== 0);

    if (!_locMapModal) {
        _locMapModal = new bootstrap.Modal(document.getElementById('locationMapModal'));
    }

    const useBtn = document.getElementById('locMapUseBtn');
    const selLabel = document.getElementById('locMapSelected');
    _locMapPicked = null;
    if (useBtn) useBtn.disabled = true;
    if (selLabel) selLabel.textContent = '—';

    const modalEl = document.getElementById('locationMapModal');
    const onShown = function () {
        const center = hasSeed ? [seedLat, seedLon] : [52.0, 19.0];
        const zoom = hasSeed ? 13 : 6;

        if (!_locMap) {
            _locMap = L.map('locLeafletMap').setView(center, zoom);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
            }).addTo(_locMap);
            _locMap.on('click', (e) => setLocMapMarker(e.latlng.lat, e.latlng.lng));
        } else {
            _locMap.setView(center, zoom);
        }
        _locMap.invalidateSize();

        if (_locMapMarker) { _locMap.removeLayer(_locMapMarker); _locMapMarker = null; }
        if (hasSeed) setLocMapMarker(seedLat, seedLon);

        modalEl.removeEventListener('shown.bs.modal', onShown);
    };
    modalEl.addEventListener('shown.bs.modal', onShown);
    _locMapModal.show();
}

function setLocMapMarker(lat, lon) {
    _locMapPicked = { lat, lon };
    if (!_locMapMarker) {
        _locMapMarker = L.circleMarker([lat, lon], {
            radius: 9, fillColor: '#dc3545', color: '#fff',
            weight: 2, opacity: 1, fillOpacity: 0.9
        }).addTo(_locMap);
    } else {
        _locMapMarker.setLatLng([lat, lon]);
    }
    const useBtn = document.getElementById('locMapUseBtn');
    const selLabel = document.getElementById('locMapSelected');
    if (useBtn) useBtn.disabled = false;
    if (selLabel) selLabel.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

function applyLocationFromMap() {
    if (!_locMapPicked) return;
    const item = settingsSectionEl('location');
    if (!item) return;
    const latEl = sfControl(item, 'lat');
    const lonEl = sfControl(item, 'lon');
    if (latEl) latEl.value = _locMapPicked.lat.toFixed(6);
    if (lonEl) lonEl.value = _locMapPicked.lon.toFixed(6);
    updateSectionDirty('location');
    if (_locMapModal) _locMapModal.hide();
}

// ================================================================
// Actions tool
// ================================================================

// Keys mirror _REPEATER_ACTIONS in api.py.
// title/desc/btn hold catalog KEYS, resolved with t() at render time.
const REPEATER_ACTIONS = [
    { key: 'zerohop_advert', icon: 'bi-megaphone', iconClass: 'text-primary',
      title: 'rptmgmt.act.zerohop', btn: 'rptmgmt.act.send', btnClass: 'btn-outline-primary',
      desc: 'rptmgmt.act.zerohop_desc' },
    { key: 'flood_advert', icon: 'bi-broadcast-pin', iconClass: 'text-warning',
      title: 'rptmgmt.act.flood', btn: 'rptmgmt.act.send', btnClass: 'btn-outline-warning',
      desc: 'rptmgmt.act.flood_desc' },
    { key: 'clock_sync', icon: 'bi-clock-history', iconClass: 'text-primary',
      title: 'rptmgmt.act.clock_sync', btn: 'rptmgmt.act.sync', btnClass: 'btn-outline-primary',
      desc: 'rptmgmt.act.clock_sync_desc' },
];

let _actionPending = false;

function actionRowHtml(a) {
    return `
        <div class="d-flex align-items-start gap-3 py-2 action-row" data-action="${a.key}">
            <i class="bi ${a.icon} fs-4 ${a.iconClass || ''}"></i>
            <div class="flex-grow-1" style="min-width: 0;">
                <div class="fw-semibold">${esc(t(a.title))}</div>
                <div class="small text-muted">${esc(t(a.desc))}</div>
                <div class="small action-result d-none mt-1"></div>
            </div>
            <button type="button" class="btn btn-sm ${a.btnClass} action-btn" style="min-width: 84px;">
                ${esc(t(a.btn))}
            </button>
        </div>`;
}

function renderActionsPane(body) {
    _actionPending = false;
    body.innerHTML = `
        <div class="card mb-3">
            <div class="card-body py-2">
                ${REPEATER_ACTIONS.map(actionRowHtml).join('<hr class="my-1">')}
            </div>
        </div>
        <div class="card border-danger">
            <div class="card-header py-2 text-danger">
                <i class="bi bi-exclamation-octagon me-1"></i>${tHtml('rptmgmt.danger_zone')}
            </div>
            <div class="card-body py-2">
                ${actionRowHtml({
                    key: 'reboot', icon: 'bi-arrow-clockwise', iconClass: 'text-danger',
                    title: 'rptmgmt.act.reboot', btn: 'rptmgmt.act.reboot_btn', btnClass: 'btn-danger',
                    desc: 'rptmgmt.act.reboot_desc',
                })}
                <hr class="my-1">
                ${actionRowHtml({
                    key: 'poweroff', icon: 'bi-power', iconClass: 'text-danger',
                    title: 'rptmgmt.act.poweroff', btn: 'rptmgmt.act.poweroff_btn', btnClass: 'btn-danger',
                    desc: 'rptmgmt.act.poweroff_desc',
                })}
                <div class="small text-muted mt-2">
                    <i class="bi bi-info-circle me-1"></i>${tHtml('rptmgmt.erase_fs_note')}
                </div>
            </div>
        </div>
    `;

    body.querySelectorAll('.action-row .action-btn').forEach(btn => {
        const row = btn.closest('.action-row');
        btn.addEventListener('click', () => {
            // Power-off is the one action a confirm() is too weak for.
            if (row.dataset.action === 'poweroff') openPowerOffModal();
            else runRepeaterAction(row.dataset.action);
        });
    });
}

function powerOffName() {
    return ((_repeater && _repeater.name) || '').trim();
}

function openPowerOffModal() {
    const name = powerOffName();
    if (!name) {
        // The backend matches against the saved name, so without one there is
        // nothing to type and nothing that would be accepted.
        showNotification(t('rptmgmt.poweroff.no_name'), 'warning');
        return;
    }
    document.getElementById('powerOffPrompt').textContent = t('rptmgmt.poweroff.prompt', { name });
    const input = document.getElementById('powerOffNameInput');
    input.value = '';
    input.placeholder = name;
    updatePowerOffConfirmState();
    _powerOffModal.show();
    setTimeout(() => input.focus(), 300);
}

function updatePowerOffConfirmState() {
    const typed = document.getElementById('powerOffNameInput').value.trim();
    const matches = !!typed && typed.toLowerCase() === powerOffName().toLowerCase();
    document.getElementById('powerOffConfirmBtn').disabled = !matches;
    return matches;
}

async function submitPowerOffModal() {
    if (!updatePowerOffConfirmState()) return;
    const typed = document.getElementById('powerOffNameInput').value.trim();
    _powerOffModal.hide();
    await runRepeaterAction('poweroff', typed);
}

async function runRepeaterAction(action, confirmName) {
    if (_actionPending) return;
    if (action === 'reboot' && !window.confirm(
            t('rptmgmt.confirm.reboot', {
                name: (_repeater && _repeater.name) || t('rptmgmt.this_repeater'),
            }))) {
        return;
    }

    const row = document.querySelector(`.action-row[data-action="${action}"]`);
    const btn = row ? row.querySelector('.action-btn') : null;
    const resultEl = row ? row.querySelector('.action-result') : null;
    _actionPending = true;
    document.querySelectorAll('.action-row .action-btn').forEach(b => { b.disabled = true; });
    const btnLabel = btn ? btn.innerHTML : '';
    if (btn) btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    if (resultEl) resultEl.classList.add('d-none');

    let data = null;
    try {
        const body = { action };
        if (confirmName) body.confirm_name = confirmName;
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: t('rptmgmt.request_failed') };
    }

    _actionPending = false;
    document.querySelectorAll('.action-row .action-btn').forEach(b => { b.disabled = false; });
    if (btn) btn.innerHTML = btnLabel;

    if (resultEl) {
        resultEl.classList.remove('d-none', 'text-success', 'text-danger');
        if (data && data.success) {
            resultEl.classList.add(data.ok ? 'text-success' : 'text-danger');
            const elapsed = data.elapsed_ms != null ? ` (${(data.elapsed_ms / 1000).toFixed(1)} s)` : '';
            resultEl.textContent = (data.reply || t('rptmgmt.done')) + elapsed;
        } else {
            resultEl.classList.add('text-danger');
            resultEl.textContent = (data && data.error) || t('rptmgmt.action_failed');
        }
    }
    if (!data || !data.success) {
        showNotification((data && data.error) || t('rptmgmt.action_failed'), 'danger');
    }
}

// ================================================================
// Login flow
// ================================================================

async function fetchRepeater() {
    const response = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}`);
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || t('rptmgmt.load_failed'));
    }
    _repeater = data.repeater;
    _session = data.session;
}

async function doLogin(password, save) {
    const name = (_repeater && _repeater.name) || t('rptmgmt.login.repeater_fallback');
    showLoading(t('rptmgmt.login.progress', { name }));

    let data = null;
    try {
        const body = {};
        if (password) {
            body.password = password;
            body.save = !!save;
        }
        const response = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        data = await response.json();
    } catch (e) {
        console.error('Login request failed:', e);
        data = { success: false, error: t('rptmgmt.login_request_failed') };
    }

    if (data && data.success) {
        _session = {
            logged_in: true,
            is_admin: !!data.is_admin,
            permissions: data.permissions
        };
        const role = data.is_admin ? 'ADMIN' : 'GUEST';
        showNotification(t('rptmgmt.login.logged_in', { role }), 'success');
        showPanel();
    } else {
        const error = (data && data.error) || t('rptmgmt.login.failed');
        openPasswordModal(error);
    }
}

function openPasswordModal(errorHint = '') {
    // Keep the loading screen behind the modal but stop the spinner text
    showLoading(t('rptmgmt.login.waiting'));

    const name = (_repeater && _repeater.name) || _pubkey.substring(0, 12);
    document.getElementById('passwordModalTitle').textContent = t('rptmgmt.login.modal_title', { name });
    const info = document.getElementById('passwordModalInfo');
    info.innerHTML = errorHint
        ? `<span class="text-danger">${esc(errorHint)}</span><br>${tHtml('rptmgmt.login.retry_hint')}`
        : tHtml('rptmgmt.login.prompt');
    const input = document.getElementById('passwordInput');
    input.value = '';
    input.type = 'password';
    document.getElementById('savePasswordCheck').checked = true;

    _passwordModal.show();
    setTimeout(() => input.focus(), 300);
}

async function submitPasswordModal() {
    const input = document.getElementById('passwordInput');
    const password = input.value;
    if (!password) {
        showNotification(t('rptmgmt.login.empty_password'), 'warning');
        return;
    }
    const save = document.getElementById('savePasswordCheck').checked;
    _passwordModal.hide();
    await doLogin(password, save);
}

async function logout() {
    const logoutBtn = document.getElementById('logoutBtn');
    logoutBtn.disabled = true;
    try {
        const response = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/logout`, { method: 'POST' });
        const data = await response.json();
        if (!data.success) {
            showNotification(data.error || t('rptmgmt.logout_failed'), 'danger');
            logoutBtn.disabled = false;
            return;
        }
    } catch (e) {
        console.error('Logout failed:', e);
    }
    goBackToList();
}

// ================================================================
// Init
// ================================================================

async function init() {
    const params = new URLSearchParams(window.location.search);
    _pubkey = (params.get('pubkey') || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(_pubkey)) {
        showError(t('rptmgmt.invalid_pubkey'));
        return;
    }

    showLoading(t('common.loading'));
    try {
        await fetchRepeater();
    } catch (e) {
        showError(e.message);
        return;
    }

    if (!_repeater.on_device) {
        showError(t('rptmgmt.not_on_device'));
        return;
    }

    if (_session && _session.logged_in) {
        showPanel();
    } else if (_repeater.password_set) {
        // Saved password: log in automatically (e.g. after app restart)
        await doLogin(null, false);
    } else {
        openPasswordModal();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    _passwordModal = new bootstrap.Modal(document.getElementById('passwordModal'));
    _powerOffModal = new bootstrap.Modal(document.getElementById('powerOffModal'));
    _nbModal = new bootstrap.Modal(document.getElementById('neighborModal'));

    loadUiSettings();

    document.getElementById('backBtn').addEventListener('click', goBackToList);
    document.getElementById('errorBackBtn').addEventListener('click', goBackToList);
    document.getElementById('errorRetryBtn').addEventListener('click', init);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('paneBackBtn').addEventListener('click', showToolsGrid);

    document.getElementById('passwordSubmitBtn').addEventListener('click', submitPasswordModal);
    document.getElementById('passwordCancelBtn').addEventListener('click', () => {
        _passwordModal.hide();
        goBackToList();
    });
    document.getElementById('passwordInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitPasswordModal();
        }
    });
    document.getElementById('togglePasswordBtn').addEventListener('click', () => {
        const input = document.getElementById('passwordInput');
        input.type = input.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('locMapUseBtn').addEventListener('click', applyLocationFromMap);

    document.getElementById('powerOffConfirmBtn').addEventListener('click', submitPowerOffModal);
    document.getElementById('powerOffNameInput').addEventListener('input', updatePowerOffConfirmState);
    document.getElementById('powerOffNameInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitPowerOffModal();
        }
    });

    document.getElementById('neighborRemoveBtn').addEventListener('click', submitNeighborRemove);

    document.getElementById('copyPubkeyBtn').addEventListener('click', async () => {
        try {
            await copyTextToClipboard(_repeater ? _repeater.public_key : _pubkey);
            showNotification(t('rptmgmt.pubkey_copied'), 'info');
        } catch (e) {
            showNotification(t('common.copy_failed'), 'warning');
        }
    });

    init();
});
