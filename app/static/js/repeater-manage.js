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
    body.innerHTML = `
        <div class="text-center text-muted py-4">
            <i class="bi ${tool.icon}" style="font-size: 2rem;"></i>
            <p class="mt-2 mb-0">The <strong>${esc(tool.title)}</strong> tool is coming in a later stage.</p>
        </div>
    `;
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
