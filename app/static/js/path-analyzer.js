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
let paFilters = { hops: 'any', token: '', sender: '' };

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
    if (paFilters.token) {
        const t = paFilters.token;
        const ok = msg.echoView.some(e => e.tokens.some(tok => tok.startsWith(t)));
        if (!ok) return false;
    }
    if (paFilters.sender) {
        if (!(msg.sender || '').toLowerCase().includes(paFilters.sender)) return false;
    }
    return true;
}

function paFiltersActive() {
    return paFilters.hops !== 'any' || paFilters.token !== '' || paFilters.sender !== '';
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

function paBuildEchoLine(echo) {
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

        const tdEchoes = document.createElement('td');
        tdEchoes.className = 'text-end';
        tdEchoes.textContent = msg.echoView.length;
        tr.appendChild(tdEchoes);

        body.appendChild(tr);

        if (msg.echoView.length > 0) {
            const detailTr = document.createElement('tr');
            detailTr.className = 'd-none';
            const detailTd = document.createElement('td');
            detailTd.className = 'pa-echo-cell';
            detailTd.colSpan = 8;
            for (const echo of msg.echoView) {
                detailTd.appendChild(paBuildEchoLine(echo));
            }
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
        paRenderTable();
    }
}

// ================================================================
// Filters
// ================================================================

function paReadFilters() {
    paFilters.hops = document.getElementById('paHopsFilter').value;
    // Normalize token input to hex characters only (matches chip display casing)
    paFilters.token = document.getElementById('paTokenFilter').value
        .replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    paFilters.sender = document.getElementById('paSenderFilter').value.trim().toLowerCase();
    document.getElementById('paClearFiltersBtn').classList.toggle('d-none', !paFiltersActive());
}

function paApplyFilters() {
    paReadFilters();
    if (paMessages.length > 0) {
        paRenderTable();
    }
}

function paClearFilters() {
    document.getElementById('paHopsFilter').value = 'any';
    document.getElementById('paTokenFilter').value = '';
    document.getElementById('paSenderFilter').value = '';
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
    document.getElementById('paTokenFilter').addEventListener('input', debouncedApply);
    document.getElementById('paSenderFilter').addEventListener('input', debouncedApply);
    document.getElementById('paClearFiltersBtn').addEventListener('click', paClearFilters);

    paLoadMessages();
});
