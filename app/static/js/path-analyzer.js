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

function paRenderTable() {
    const body = document.getElementById('paTableBody');
    body.innerHTML = '';

    for (const msg of paMessages) {
        const tr = document.createElement('tr');

        const tdTime = document.createElement('td');
        tdTime.className = 'pa-time';
        tdTime.textContent = paFormatTime(msg);
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
        if (msg.packet_hash) {
            const span = document.createElement('span');
            span.className = 'pa-hash';
            span.textContent = msg.packet_hash;
            span.title = 'Click to copy';
            span.addEventListener('click', () => paCopyText(msg.packet_hash, 'Packet hash'));
            tdHash.appendChild(span);
        } else {
            tdHash.innerHTML = '<span class="text-muted small">no path data</span>';
        }
        tr.appendChild(tdHash);

        const tdHops = document.createElement('td');
        tdHops.className = 'text-end';
        tdHops.textContent = (msg.hop_count === null || msg.hop_count === undefined) ? '—' : msg.hop_count;
        tr.appendChild(tdHops);

        const tdEchoes = document.createElement('td');
        tdEchoes.className = 'text-end';
        tdEchoes.textContent = msg.echoes.length;
        tr.appendChild(tdEchoes);

        body.appendChild(tr);
    }

    document.getElementById('paCounter').textContent =
        `${paMessages.length} message${paMessages.length === 1 ? '' : 's'}`;
}

function paSetView(state) {
    document.getElementById('paLoading').classList.toggle('d-none', state !== 'loading');
    document.getElementById('paEmpty').classList.toggle('d-none', state !== 'empty');
    document.getElementById('paTableWrap').classList.toggle('d-none', state !== 'table');
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
    } catch (e) {
        console.error('Failed to load messages:', e);
        showNotification(`Failed to load messages: ${e.message}`, 'danger');
        paMessages = [];
    }

    if (paMessages.length === 0) {
        paSetView('empty');
    } else {
        paRenderTable();
        paSetView('table');
    }
}

// ================================================================
// Init
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
    loadUiSettings();
    document.getElementById('paDaysSelect').addEventListener('change', paLoadMessages);
    document.getElementById('paRefreshBtn').addEventListener('click', paLoadMessages);
    paLoadMessages();
});
