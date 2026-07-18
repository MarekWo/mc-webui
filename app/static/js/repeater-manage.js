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

const TOOLS = [
    { key: 'status',    icon: 'bi-bar-chart-line', title: 'Status',
      desc: 'Battery, radio and packet statistics', adminOnly: false },
    { key: 'telemetry', icon: 'bi-activity',       title: 'Telemetry',
      desc: 'Sensor channels (Cayenne LPP)', adminOnly: false },
    { key: 'neighbors', icon: 'bi-people',         title: 'Neighbors',
      desc: 'Zero-hop repeaters heard', adminOnly: false },
    { key: 'cli',       icon: 'bi-terminal',       title: 'CLI',
      desc: 'Send text commands to the repeater', adminOnly: true },
    { key: 'settings',  icon: 'bi-gear',           title: 'Settings',
      desc: 'Configure repeater parameters', adminOnly: true },
    { key: 'actions',   icon: 'bi-lightning',      title: 'Actions',
      desc: 'Advert, clock sync, reboot', adminOnly: true },
];

// ================================================================
// State
// ================================================================

let _pubkey = null;
let _repeater = null;   // merged entry from GET /api/repeaters/<pk>
let _session = null;    // {logged_in, is_admin, ...}
let _passwordModal = null;

// ================================================================
// State screens
// ================================================================

function showLoading(text) {
    document.getElementById('loadingState').style.display = '';
    document.getElementById('loadingText').textContent = text || 'Loading…';
    document.getElementById('errorState').style.display = 'none';
    document.getElementById('panelContent').style.display = 'none';
}

function showError(text) {
    document.getElementById('loadingState').style.display = 'none';
    document.getElementById('errorState').style.display = '';
    document.getElementById('errorText').textContent = text || 'Something went wrong.';
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
    document.getElementById('rptPath').textContent = r.path_or_mode || '—';

    const loc = (r.adv_lat != null && r.adv_lon != null && (r.adv_lat !== 0 || r.adv_lon !== 0))
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
                 ${locked ? 'title="Admin login required"' : ''}>
                <div class="tool-icon ${tool.key}"><i class="bi ${tool.icon}"></i></div>
                <div class="flex-grow-1" style="min-width: 0;">
                    <h6>${esc(tool.title)}${locked ? ' <i class="bi bi-lock-fill small text-muted"></i>' : ''}</h6>
                    <p class="tool-desc">${esc(tool.desc)}</p>
                </div>
                <i class="bi bi-chevron-right text-muted"></i>
            </div>
        `;
        const tile = col.querySelector('.tool-tile');
        tile.addEventListener('click', () => {
            if (locked) {
                showNotification('Admin login required for this tool', 'warning');
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
    document.getElementById('paneTitle').textContent = tool.title;

    const body = document.getElementById('paneBody');
    if (tool.key === 'status') {
        renderStatusPane(body);
        return;
    }
    if (tool.key === 'telemetry') {
        renderTelemetryPane(body);
        return;
    }
    body.innerHTML = `
        <div class="text-center text-muted py-4">
            <i class="bi ${tool.icon}" style="font-size: 2rem;"></i>
            <p class="mt-2 mb-0">The <strong>${esc(tool.title)}</strong> tool is coming in a later stage.</p>
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

function fmtInt(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US');
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
            <button type="button" class="btn btn-sm btn-outline-secondary" id="statusRefreshBtn" title="Refresh status">
                <i class="bi bi-arrow-clockwise"></i> Refresh
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
        if (secs < 2) label.textContent = 'Updated just now';
        else if (secs < 60) label.textContent = `Updated ${secs}s ago`;
        else label.textContent = `Updated ${fmtDuration(secs)} ago`;
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
            <p class="mt-2 mb-0">Requesting status from the repeater…</p>
        </div>
    `;

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/status`);
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: 'Request failed' };
    }
    if (btn) btn.disabled = false;

    if (!data || !data.success) {
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-2">${esc((data && data.error) || 'Failed to get status')}</p>
                <button type="button" class="btn btn-sm btn-primary" id="statusRetryBtn">
                    <i class="bi bi-arrow-clockwise"></i> Try again
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

    const system = statusSection('System Information', [
        ['Battery', batStr],
        ['Uptime', fmtDuration(s.uptime)],
        ['Clock', '<span id="statusClock" class="text-muted">…</span>'],
        ['Queue length', fmtInt(s.tx_queue_len)],
        ['Debug / error events', fmtInt(s.full_evts)],
    ]);
    const radio = statusSection('Radio Statistics', [
        ['Last RSSI', s.last_rssi != null ? `${s.last_rssi} dBm` : '—'],
        ['Last SNR', s.last_snr != null ? `${s.last_snr} dB` : '—'],
        ['Noise floor', s.noise_floor != null ? `${s.noise_floor} dBm` : '—'],
        ['TX airtime', fmtDuration(s.airtime)],
        ['RX airtime', fmtDuration(s.rx_airtime)],
    ]);
    const packets = statusSection('Packet Statistics', [
        ['Sent', `${fmtInt(s.nb_sent)} <span class="text-muted small">(flood ${fmtInt(s.sent_flood)} · direct ${fmtInt(s.sent_direct)})</span>`],
        ['Received', `${fmtInt(s.nb_recv)} <span class="text-muted small">(flood ${fmtInt(s.recv_flood)} · direct ${fmtInt(s.recv_direct)})</span>`],
        ['Duplicates', `<span class="text-muted small">flood</span> ${fmtInt(s.flood_dups)} · <span class="text-muted small">direct</span> ${fmtInt(s.direct_dups)}`],
        ...(s.recv_errors != null ? [['RX errors', fmtInt(s.recv_errors)]] : []),
        ['Channel utilization', util],
    ]);

    container.innerHTML = system + radio + packets;
}

// ================================================================
// Telemetry tool
// ================================================================

// Cayenne LPP type name -> {unit, decimals, icon}
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
            <button type="button" class="btn btn-sm btn-outline-secondary" id="telemetryRefreshBtn" title="Refresh telemetry">
                <i class="bi bi-arrow-clockwise"></i> Refresh
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
        if (secs < 2) label.textContent = 'Updated just now';
        else if (secs < 60) label.textContent = `Updated ${secs}s ago`;
        else label.textContent = `Updated ${fmtDuration(secs)} ago`;
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
            <p class="mt-2 mb-0">Requesting telemetry from the repeater…<br>
            <span class="small">Multi-hop paths can take up to a minute.</span></p>
        </div>
    `;

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/telemetry`);
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: 'Request failed' };
    }
    if (btn) btn.disabled = false;

    if (!data || !data.success) {
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-2">${esc((data && data.error) || 'Failed to get telemetry')}</p>
                <button type="button" class="btn btn-sm btn-primary" id="telemetryRetryBtn">
                    <i class="bi bi-arrow-clockwise"></i> Try again
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
        container.innerHTML = '<div class="text-muted text-center py-4">No telemetry data reported.</div>';
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
            const disp = LPP_DISPLAY[entry.type] || { unit: '', icon: 'bi-activity' };
            const label = esc(entry.type.charAt(0).toUpperCase() + entry.type.slice(1));
            const value = fmtLppValue(entry.type, entry.value);
            return `
                <tr>
                    <td class="text-muted"><i class="bi ${disp.icon} me-1"></i>${label}</td>
                    <td class="text-end fw-medium">${value}${disp.unit ? ' ' + disp.unit : ''}</td>
                </tr>
            `;
        }).join('');
        // Channel 1 carries the repeater's own vitals (battery, MCU temp)
        const chLabel = ch === 1 ? `Channel ${ch} <span class="text-muted fw-normal">· device</span>` : `Channel ${ch}`;
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
            el.textContent = d.toLocaleString();
        } else {
            el.className = '';
            el.innerHTML = `<button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="clockRetryBtn">fetch</button>`;
            const b = document.getElementById('clockRetryBtn');
            if (b) b.addEventListener('click', loadClock);
        }
    } catch (e) {
        el.className = '';
        el.innerHTML = `<button type="button" class="btn btn-link btn-sm p-0 align-baseline" id="clockRetryBtn">fetch</button>`;
        const b = document.getElementById('clockRetryBtn');
        if (b) b.addEventListener('click', loadClock);
    }
}

// ================================================================
// Login flow
// ================================================================

async function fetchRepeater() {
    const response = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}`);
    const data = await response.json();
    if (!data.success) {
        throw new Error(data.error || 'Failed to load repeater');
    }
    _repeater = data.repeater;
    _session = data.session;
}

async function doLogin(password, save) {
    const name = (_repeater && _repeater.name) || 'repeater';
    showLoading(`Logging in to ${name}… (may take up to 60 s on flood paths)`);

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
        data = { success: false, error: 'Login request failed' };
    }

    if (data && data.success) {
        _session = {
            logged_in: true,
            is_admin: !!data.is_admin,
            permissions: data.permissions
        };
        const role = data.is_admin ? 'ADMIN' : 'GUEST';
        showNotification(`Logged in as ${role}`, 'success');
        showPanel();
    } else {
        const error = (data && data.error) || 'Login failed';
        openPasswordModal(error);
    }
}

function openPasswordModal(errorHint = '') {
    // Keep the loading screen behind the modal but stop the spinner text
    showLoading('Waiting for password…');

    const name = (_repeater && _repeater.name) || _pubkey.substring(0, 12);
    document.getElementById('passwordModalTitle').textContent = `Log in — ${name}`;
    const info = document.getElementById('passwordModalInfo');
    info.innerHTML = errorHint
        ? `<span class="text-danger">${esc(errorHint)}</span><br>Check the password and try again.`
        : 'Enter the repeater password to log in.';
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
        showNotification('Password cannot be empty', 'warning');
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
            showNotification(data.error || 'Logout failed', 'danger');
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
        showError('Invalid repeater public key in URL.');
        return;
    }

    showLoading('Loading…');
    try {
        await fetchRepeater();
    } catch (e) {
        showError(e.message);
        return;
    }

    if (!_repeater.on_device) {
        showError('This repeater is not stored on the device — it cannot be managed.');
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

    document.getElementById('copyPubkeyBtn').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(_repeater ? _repeater.public_key : _pubkey);
            showNotification('Public key copied', 'info');
        } catch (e) {
            showNotification('Copy failed', 'warning');
        }
    });

    init();
});
