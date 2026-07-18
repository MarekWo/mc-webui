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
            <div class="cli-line meta">Commands go to ${esc(_repeater ? _repeater.name : 'the repeater')}. One command at a time — replies travel over the mesh.</div>
        </div>
        <div class="d-flex flex-wrap gap-1 mt-2">${chips}</div>
        <form id="cliForm" class="d-flex gap-2 mt-2">
            <input type="text" id="cliInput" class="form-control form-control-sm font-monospace"
                   placeholder="Enter command (e.g. get name)" autocomplete="off"
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
    const pendingLine = cliAppend('meta cli-pending', 'Waiting for reply…');

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/cli`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        });
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: 'Request failed' };
    }

    if (pendingLine) pendingLine.remove();
    if (data && data.success) {
        cliAppend('reply', data.output || '(empty reply)');
        if (data.elapsed_ms != null) {
            cliAppend('meta', `(${(data.elapsed_ms / 1000).toFixed(1)} s)`);
        }
    } else {
        cliAppend('error', (data && data.error) || 'Command failed');
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

function renderNeighborsPane(body) {
    _neighborsView = 'list';
    _nbMap = null;   // pane body was rebuilt; force map re-init
    body.innerHTML = `
        <div class="d-flex align-items-center gap-2 mb-2 flex-wrap">
            <span class="text-muted small flex-grow-1" id="neighborsCount"></span>
            <div class="btn-group btn-group-sm" role="group" id="neighborsViewToggle" style="display: none;">
                <button type="button" class="btn btn-outline-secondary active" id="nbListBtn">
                    <i class="bi bi-list-ul"></i> List
                </button>
                <button type="button" class="btn btn-outline-secondary" id="nbMapBtn">
                    <i class="bi bi-map"></i> Map
                </button>
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="neighborsRefreshBtn" title="Refresh neighbours">
                <i class="bi bi-arrow-clockwise"></i> Refresh
            </button>
        </div>
        <div id="neighborsContainer"></div>
        <div id="neighborsMapWrap" style="display: none;">
            <div id="nbLeafletMap" style="height: 420px; width: 100%;" class="rounded border"></div>
            <div class="small text-muted mt-1" id="nbMapNote"></div>
        </div>
    `;
    body.querySelector('#neighborsRefreshBtn').addEventListener('click', loadNeighbors);
    body.querySelector('#nbListBtn').addEventListener('click', () => setNeighborsView('list'));
    body.querySelector('#nbMapBtn').addEventListener('click', () => setNeighborsView('map'));
    loadNeighbors();
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
            <p class="mt-2 mb-0">Requesting neighbours from the repeater…<br>
            <span class="small">Long lists are fetched in pages and can take a while.</span></p>
        </div>
    `;

    let data = null;
    try {
        const resp = await fetch(`/api/repeaters/${encodeURIComponent(_pubkey)}/neighbours`);
        data = await resp.json();
    } catch (e) {
        data = { success: false, error: 'Request failed' };
    }
    if (btn) btn.disabled = false;

    if (!data || !data.success) {
        const countEl = document.getElementById('neighborsCount');
        if (countEl) countEl.textContent = '';
        container.innerHTML = `
            <div class="text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 2rem;"></i>
                <p class="mt-2 mb-2">${esc((data && data.error) || 'Failed to get neighbours')}</p>
                <button type="button" class="btn btn-sm btn-primary" id="neighborsRetryBtn">
                    <i class="bi bi-arrow-clockwise"></i> Try again
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
        let label = `${data.total} neighbor${data.total === 1 ? '' : 's'}`;
        if (data.fetched < data.total) label += ` (showing ${data.fetched})`;
        countEl.textContent = label;
    }

    // Map view is offered when the repeater or any neighbour has a position
    const mappable = entries.some(n => n.lat != null && n.lon != null)
        || (_repeater && _repeater.adv_lat && _repeater.adv_lon);
    if (toggle) toggle.style.display = mappable ? '' : 'none';

    if (!entries.length) {
        container.innerHTML = '<div class="text-muted text-center py-4">No neighbours reported yet.<br><small>Neighbours are learned from zero-hop repeater adverts.</small></div>';
        return;
    }

    const rows = entries.map(n => `
        <tr>
            <td class="text-truncate" style="max-width: 220px;">
                ${n.name ? esc(n.name) : `<span class="font-monospace text-muted">[${esc(n.pubkey_prefix)}]</span>`}
                ${n.lat != null ? '<i class="bi bi-geo-alt text-muted small ms-1" title="Position known"></i>' : ''}
            </td>
            <td class="text-muted text-nowrap">${fmtHeardAgo(n.secs_ago)}</td>
            <td class="text-end text-nowrap fw-medium">${n.snr != null ? n.snr + ' dB' : '—'}</td>
        </tr>
    `).join('');
    container.innerHTML = `
        <table class="table table-sm align-middle mb-0">
            <thead><tr class="small text-muted">
                <th class="fw-normal">Repeater</th>
                <th class="fw-normal">Heard</th>
                <th class="fw-normal text-end">SNR</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function fmtHeardAgo(secs) {
    if (secs == null) return '—';
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`;
    return `${Math.floor(secs / 86400)}d ${Math.floor((secs % 86400) / 3600)}h ago`;
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
    }
    _nbMapLayers.clearLayers();

    const hasCenter = _repeater && _repeater.adv_lat && _repeater.adv_lon;
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
        centerMarker.bindPopup(`<b>${esc(_repeater.name || 'This repeater')}</b><br>managed repeater`);
        bounds.push(center);
    }

    let placed = 0;
    let skipped = 0;
    (data.entries || []).forEach(n => {
        if (n.lat == null || n.lon == null) { skipped++; return; }
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
            `Heard: ${fmtHeardAgo(n.secs_ago)}`
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
        if (bounds.length > 0) {
            _nbMap.fitBounds(bounds, { padding: [30, 30] });
        }
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
// Settings tool
// ================================================================

// Sections and fields mirror _REPEATER_SETTINGS_FIELDS in api.py.
// Values travel as raw CLI strings (`get X` → `> value`, `set X value`).
const SETTINGS_SECTIONS = [
    { key: 'basic', title: 'Basic', icon: 'bi-tag', fields: [
        { key: 'name', label: 'Repeater name', type: 'text' },
        { key: 'password', label: 'Admin password', type: 'password', writeOnly: true,
          help: 'Write-only — the current password is never shown. Changing it does not log out already active sessions.' },
        { key: 'guest.password', label: 'Guest password', type: 'text',
          help: 'Password for read-only guest logins.' },
    ]},
    { key: 'radio', title: 'Radio', icon: 'bi-broadcast',
      note: 'Frequency, bandwidth, SF and CR are applied after a reboot. TX power applies immediately.',
      fields: [
        { key: 'radio', label: 'Radio parameters', type: 'radio4' },
        { key: 'tx', label: 'TX power (dBm)', type: 'number', min: 0, max: 30, step: 1 },
        { key: 'radio.rxgain', label: 'RX boosted gain', type: 'onoff' },
    ]},
    { key: 'location', title: 'Location', icon: 'bi-geo-alt', fields: [
        { key: 'lat', label: 'Latitude', type: 'text' },
        { key: 'lon', label: 'Longitude', type: 'text' },
    ]},
    { key: 'features', title: 'Features', icon: 'bi-toggles', fields: [
        { key: 'repeat', label: 'Repeat packets', type: 'onoff' },
        { key: 'allow.read.only', label: 'Allow read-only (guest) access', type: 'onoff' },
        { key: 'multi.acks', label: 'Send multiple ACKs', type: 'zeroone' },
    ]},
    { key: 'network', title: 'Network health', icon: 'bi-heart-pulse', fields: [
        { key: 'loop.detect', label: 'Loop detection', type: 'select',
          options: ['off', 'minimal', 'moderate', 'strict'] },
        { key: 'dutycycle', label: 'Duty cycle (%)', type: 'number', min: 1, max: 100, step: 1 },
    ]},
    { key: 'advert', title: 'Advertisement', icon: 'bi-megaphone', fields: [
        { key: 'advert.interval', label: 'Local advert interval (minutes)', type: 'number', min: 0, max: 240, step: 1,
          help: 'Firmware accepts 60–240 minutes, or 0 to disable.' },
        { key: 'flood.advert.interval', label: 'Flood advert interval (hours)', type: 'number', min: 0, step: 1 },
        { key: 'flood.max', label: 'Max flood hops', type: 'number', min: 0, max: 64, step: 1 },
    ]},
    { key: 'operator', title: 'Operator info', icon: 'bi-person-vcard', fields: [
        { key: 'owner.info', label: 'Owner info', type: 'textarea',
          help: 'Free-form operator / contact info shown to clients. Multiple lines allowed.' },
    ]},
    { key: 'advanced', title: 'Advanced', icon: 'bi-sliders', fields: [
        { key: 'path.hash.mode', label: 'Path hash mode (0–2)', type: 'number', min: 0, max: 2, step: 1 },
        { key: 'txdelay', label: 'TX delay factor (0–2)', type: 'number', min: 0, max: 2, step: 'any' },
        { key: 'direct.txdelay', label: 'Direct TX delay factor (0–2)', type: 'number', min: 0, max: 2, step: 'any' },
        { key: 'int.thresh', label: 'Interference threshold', type: 'number', step: 1 },
        { key: 'agc.reset.interval', label: 'AGC reset interval', type: 'number', min: 0, step: 4,
          help: 'Multiple of 4; 0 disables periodic AGC resets.' },
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
                       placeholder="(unchanged)" autocomplete="new-password">`;
    }
    if (f.type === 'radio4') {
        const subs = [
            ['Frequency (MHz)', 'any'],
            ['Bandwidth (kHz)', 'any'],
            ['Spreading factor', '1'],
            ['Coding rate', '1'],
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
            <label class="form-label small fw-semibold mb-1">${esc(f.label)} <span class="sf-badge ms-1"></span></label>
            ${settingsControlHtml(f)}
            <div class="sf-msg small text-danger d-none"></div>
            ${f.help ? `<div class="form-text small mb-0">${esc(f.help)}</div>` : ''}
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
                    <i class="bi ${sec.icon} me-2"></i>${esc(sec.title)}
                    <span class="badge bg-warning text-dark ms-2 sec-dirty-badge d-none"></span>
                </button>
            </h2>
            <div id="secCollapse-${sec.key}" class="accordion-collapse collapse">
                <div class="accordion-body pt-2">
                    ${sec.note ? `<div class="small text-muted mb-2"><i class="bi bi-info-circle me-1"></i>${esc(sec.note)}</div>` : ''}
                    <div class="sec-status small text-muted mb-2 d-none"></div>
                    <div class="sec-reboot alert alert-warning py-1 px-2 small d-none mb-2">
                        <i class="bi bi-arrow-clockwise me-1"></i>Some changes take effect after a reboot — use Actions → Reboot.
                    </div>
                    <div class="sec-fields">${sec.fields.map(settingsFieldHtml).join('')}</div>
                    <div class="d-flex align-items-center gap-2 mt-3">
                        <button type="button" class="btn btn-sm btn-outline-secondary sec-refresh">
                            <i class="bi bi-arrow-clockwise"></i> Refresh
                        </button>
                        <button type="button" class="btn btn-sm btn-success sec-apply" disabled>
                            <i class="bi bi-check-lg"></i> Apply
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');

    body.innerHTML = `
        <p class="text-muted small mb-2">
            Settings are read live from the repeater. Expand a section to load it —
            every field is one mesh round-trip, so a section can take a few seconds.
        </p>
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
    msg.textContent = '';
    if (kind === 'pending') {
        badge.innerHTML = '<span class="spinner-border spinner-border-sm text-muted"></span>';
    } else if (kind === 'ok') {
        badge.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i>';
    } else if (kind === 'reboot') {
        badge.innerHTML = '<span class="badge bg-warning text-dark">reboot required</span>';
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
    applyBtn.innerHTML = `<i class="bi bi-check-lg"></i> Apply${count ? ` (${count})` : ''}`;
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
    statusEl.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>' +
        'Reading from repeater… (one mesh round-trip per field)';
    item.querySelector('.sec-refresh').disabled = true;
    item.querySelector('.sec-apply').disabled = true;
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
        data = { success: false, error: 'Request failed' };
    }

    st.loading = false;
    item.querySelector('.sec-refresh').disabled = false;

    if (!data || !data.success) {
        statusEl.classList.remove('text-muted');
        statusEl.classList.add('text-danger');
        statusEl.textContent = (data && data.error) || 'Failed to read settings';
        updateSectionDirty(secKey);
        return;
    }

    const values = data.values || {};
    const errors = data.errors || {};
    st.loaded = {};
    let errCount = 0;
    sec.fields.forEach(f => {
        if (f.writeOnly) return;
        if (f.key in values) {
            setSettingsFieldValue(item, f, values[f.key]);
            disableSettingsField(item, f, false);
            // Baseline = the value as the control round-trips it, so
            // firmware formatting quirks never show up as dirty fields.
            st.loaded[f.key] = getSettingsFieldValue(item, f);
            setFieldBadge(item, f.key, 'clear');
        } else {
            errCount++;
            disableSettingsField(item, f, true);
            setFieldBadge(item, f.key, 'error', errors[f.key] || 'Failed to read');
        }
    });
    st.loadedOnce = true;

    if (errCount) {
        statusEl.classList.remove('text-muted');
        statusEl.classList.add('text-danger');
        statusEl.textContent = `${errCount} field${errCount > 1 ? 's' : ''} failed to load — Refresh retries the whole section.`;
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
        showNotification(`"${emptyKey}" cannot be empty`, 'warning');
        return;
    }

    if ('radio' in dirty && !window.confirm(
        `Change radio parameters to ${dirty.radio}?\n\n` +
        'Wrong values can make the repeater unreachable over the mesh. ' +
        'The change takes effect after a reboot.')) {
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
        data = { success: false, error: 'Request failed' };
    }

    st.applying = false;
    item.querySelector('.sec-refresh').disabled = false;

    if (!data || !data.success) {
        keys.forEach(k => setFieldBadge(item, k, 'error'));
        showNotification((data && data.error) || 'Failed to apply settings', 'danger');
        updateSectionDirty(secKey);
        return;
    }

    const results = data.results || {};
    let okCount = 0, failCount = 0, rebootCount = 0;
    for (const f of sec.fields) {
        if (!(f.key in dirty)) continue;
        const res = results[f.key] || { status: 'failed', error: 'No result' };
        if (res.status === 'ok' || res.status === 'reboot_required') {
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
            setFieldBadge(item, f.key, 'error', res.error || res.reply || 'Failed');
        }
    }

    if (rebootCount) item.querySelector('.sec-reboot').classList.remove('d-none');
    updateSectionDirty(secKey);

    if (failCount === 0) {
        showNotification(rebootCount ? 'Applied — reboot required for some changes' : 'Settings applied', 'success');
    } else {
        showNotification(`${failCount} setting${failCount > 1 ? 's' : ''} failed to apply`, 'danger');
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
            showNotification('Saved password updated to the new one', 'success');
        }
    } catch (e) {
        console.error('Failed to update saved password:', e);
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
