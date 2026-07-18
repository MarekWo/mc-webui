// My Repeaters panel
// - saved repeater list merged with device truth (GET /api/repeaters)
// - add-repeater picker (device contacts of type REP only)
// - password set / login (password persisted server-side)
// - path editor (same /api/contacts/<pk>/paths endpoints as the DM panel)

// ================================================================
// UI settings + toast (same behavior as dm.js)
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

// ================================================================
// Helpers
// ================================================================

function esc(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Never';
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

// ================================================================
// State
// ================================================================

let myRepeaters = [];          // rows from GET /api/repeaters
let _deviceRepeaters = null;   // device contacts of type REP (add picker)
let _repeatersCache = null;    // /api/contacts/repeaters (path hop picker)
let _loginPubkey = null;       // pubkey with login in progress
let _passwordCtx = null;       // {mode: 'set'|'login', pubkey, name}
let _removeCtx = null;         // {pubkey, name}
let _pathPubkey = null;        // pubkey whose paths are being edited
let _passwordModal = null;
let _addRepeaterModal = null;
let _pathModal = null;
let _addPathModal = null;
let _removeModal = null;

function findRepeater(pubkey) {
    return myRepeaters.find(r => r.public_key === pubkey) || null;
}

// ================================================================
// Repeater list
// ================================================================

async function loadRepeaters(forceRefresh = false) {
    const listEl = document.getElementById('repeaterList');
    try {
        const url = forceRefresh ? '/api/repeaters?refresh=true' : '/api/repeaters';
        const response = await fetch(url);
        const data = await response.json();
        if (!data.success) {
            listEl.innerHTML = `<div class="text-danger small">${esc(data.error || 'Failed to load repeaters')}</div>`;
            return;
        }
        myRepeaters = data.repeaters || [];
        renderRepeaterRows();
    } catch (e) {
        console.error('Failed to load repeaters:', e);
        listEl.innerHTML = '<div class="text-danger small">Failed to load repeaters</div>';
    }
}

function renderRepeaterRows() {
    const listEl = document.getElementById('repeaterList');
    const emptyEl = document.getElementById('emptyState');
    const countEl = document.getElementById('repeaterCount');

    if (countEl) {
        countEl.textContent = myRepeaters.length
            ? `${myRepeaters.length} repeater${myRepeaters.length === 1 ? '' : 's'}`
            : '';
    }

    listEl.innerHTML = '';
    if (!myRepeaters.length) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    myRepeaters.forEach(r => {
        const row = document.createElement('div');
        row.className = 'repeater-row' + (r.on_device ? '' : ' rpt-offline');
        row.dataset.pubkey = r.public_key;

        const isLoggingIn = _loginPubkey === r.public_key;
        const icon = isLoggingIn
            ? '<span class="spinner-border spinner-border-sm text-success" role="status"></span>'
            : '<i class="bi bi-diagram-3 text-success fs-4"></i>';

        const roleInfo = r.last_login_at
            ? ` · last login: ${esc(r.last_login_role || '?')}`
            : '';
        const statusLine = isLoggingIn
            ? '<span class="text-primary">Logging in… (may take up to 60 s on flood paths)</span>'
            : (r.on_device
                ? `<span class="rpt-path font-monospace">${esc(r.path_or_mode || '—')}</span>${roleInfo}`
                : '<span class="text-warning">Not stored on the device</span>');

        row.innerHTML = `
            <div class="d-flex align-items-center gap-2">
                <span class="rpt-icon flex-shrink-0">${icon}</span>
                <div class="flex-grow-1 rpt-main">
                    <div class="fw-semibold text-truncate">${esc(r.name || r.public_key.substring(0, 12))}</div>
                    <small class="text-muted d-block text-truncate">${statusLine}</small>
                </div>
                <div class="btn-group btn-group-sm flex-shrink-0">
                    <button type="button" class="btn btn-outline-secondary" data-action="path"
                            title="Set path" ${r.on_device ? '' : 'disabled'}>
                        <i class="bi bi-signpost-split"></i>
                    </button>
                    <button type="button" class="btn btn-outline-secondary" data-action="password"
                            title="${r.password_set ? 'Change password' : 'Set password'}">
                        <i class="bi bi-key${r.password_set ? '-fill' : ''}"></i>
                    </button>
                    <button type="button" class="btn btn-outline-danger" data-action="remove" title="Remove from list">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        `;

        row.querySelector('.rpt-main').addEventListener('click', () => onRepeaterClick(r.public_key));
        row.querySelector('[data-action="path"]').addEventListener('click', (e) => {
            e.stopPropagation();
            openPathModal(r.public_key);
        });
        row.querySelector('[data-action="password"]').addEventListener('click', (e) => {
            e.stopPropagation();
            openPasswordModal('set', r.public_key);
        });
        row.querySelector('[data-action="remove"]').addEventListener('click', (e) => {
            e.stopPropagation();
            openRemoveModal(r.public_key);
        });

        listEl.appendChild(row);
    });
}

// ================================================================
// Login flow
// ================================================================

function onRepeaterClick(pubkey) {
    const r = findRepeater(pubkey);
    if (!r) return;
    if (!r.on_device) {
        showNotification('This repeater is not stored on the device — it cannot be managed', 'warning');
        return;
    }
    if (_loginPubkey) {
        showNotification('Another login is already in progress', 'warning');
        return;
    }
    if (!r.password_set) {
        openPasswordModal('login', pubkey);
        return;
    }
    doLogin(pubkey, null, false);
}

async function doLogin(pubkey, password, save) {
    const r = findRepeater(pubkey);
    if (!r) return;

    _loginPubkey = pubkey;
    renderRepeaterRows();

    let data = null;
    try {
        const body = {};
        if (password) {
            body.password = password;
            body.save = !!save;
        }
        const response = await fetch(`/api/repeaters/${encodeURIComponent(pubkey)}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        data = await response.json();
    } catch (e) {
        console.error('Login request failed:', e);
        data = { success: false, error: 'Login request failed' };
    }

    _loginPubkey = null;

    if (data && data.success) {
        const role = data.is_admin ? 'ADMIN' : 'GUEST';
        showNotification(`Logged in to ${r.name || 'repeater'} as ${role}`, 'success');
        window.location.href = `/repeaters/manage?pubkey=${encodeURIComponent(pubkey)}`;
        return;
    } else {
        await loadRepeaters();
        const error = (data && data.error) || 'Login failed';
        showNotification(error, 'danger');
        // Offer a retry with password correction (wrong password and
        // unreachable repeater are indistinguishable at protocol level).
        openPasswordModal('login', pubkey, error);
    }
}

// ================================================================
// Password modal (set password / login prompt)
// ================================================================

function openPasswordModal(mode, pubkey, errorHint = '') {
    const r = findRepeater(pubkey);
    if (!r) return;
    _passwordCtx = { mode, pubkey };

    const title = document.getElementById('passwordModalTitle');
    const info = document.getElementById('passwordModalInfo');
    const submitBtn = document.getElementById('passwordSubmitBtn');
    const input = document.getElementById('passwordInput');
    const saveWrap = document.getElementById('savePasswordWrap');
    const saveCheck = document.getElementById('savePasswordCheck');

    const name = r.name || r.public_key.substring(0, 12);
    if (mode === 'set') {
        title.textContent = `Set password — ${name}`;
        info.textContent = 'The password is stored in the app database and used to log in to this repeater without asking again.';
        submitBtn.textContent = 'Save';
        saveWrap.style.display = 'none';
    } else {
        title.textContent = `Log in — ${name}`;
        info.innerHTML = errorHint
            ? `<span class="text-danger">${esc(errorHint)}</span><br>Check the password and try again.`
            : 'Enter the repeater password to log in.';
        submitBtn.textContent = 'Log in';
        saveWrap.style.display = '';
        saveCheck.checked = true;
    }
    input.value = '';
    input.type = 'password';

    _passwordModal.show();
    setTimeout(() => input.focus(), 300);
}

async function submitPasswordModal() {
    if (!_passwordCtx) return;
    const { mode, pubkey } = _passwordCtx;
    const input = document.getElementById('passwordInput');
    const saveCheck = document.getElementById('savePasswordCheck');
    const password = input.value;

    if (!password) {
        showNotification('Password cannot be empty', 'warning');
        return;
    }

    _passwordModal.hide();

    if (mode === 'set') {
        try {
            const response = await fetch(`/api/repeaters/${encodeURIComponent(pubkey)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await response.json();
            if (data.success) {
                showNotification('Password saved', 'success');
                await loadRepeaters();
            } else {
                showNotification(data.error || 'Failed to save password', 'danger');
            }
        } catch (e) {
            showNotification('Failed to save password', 'danger');
        }
    } else {
        doLogin(pubkey, password, saveCheck.checked);
    }
}

// ================================================================
// Remove modal
// ================================================================

function openRemoveModal(pubkey) {
    const r = findRepeater(pubkey);
    if (!r) return;
    _removeCtx = { pubkey };
    document.getElementById('removeRepeaterName').textContent = r.name || r.public_key.substring(0, 12);
    _removeModal.show();
}

async function confirmRemoveRepeater() {
    if (!_removeCtx) return;
    const { pubkey } = _removeCtx;
    _removeModal.hide();
    try {
        const response = await fetch(`/api/repeaters/${encodeURIComponent(pubkey)}`, { method: 'DELETE' });
        const data = await response.json();
        if (data.success) {
            showNotification('Repeater removed from list', 'info');
            await loadRepeaters();
        } else {
            showNotification(data.error || 'Failed to remove repeater', 'danger');
        }
    } catch (e) {
        showNotification('Failed to remove repeater', 'danger');
    }
}

// ================================================================
// Add repeater picker (device contacts of type REP)
// ================================================================

async function openAddRepeaterModal() {
    _addRepeaterModal.show();
    const listEl = document.getElementById('deviceRptList');
    listEl.innerHTML = '<div class="text-muted small p-3">Loading device contacts...</div>';
    document.getElementById('deviceRptSearch').value = '';

    try {
        const response = await fetch('/api/contacts/detailed');
        const data = await response.json();
        if (!data.success) {
            listEl.innerHTML = `<div class="text-danger small p-3">${esc(data.error || 'Failed to load device contacts')}</div>`;
            return;
        }
        _deviceRepeaters = (data.contacts || [])
            .filter(c => c.type === 2)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        renderDeviceRepeaterList();
    } catch (e) {
        console.error('Failed to load device contacts:', e);
        listEl.innerHTML = '<div class="text-danger small p-3">Failed to load device contacts</div>';
    }
}

function renderDeviceRepeaterList() {
    const listEl = document.getElementById('deviceRptList');
    const countEl = document.getElementById('deviceRptCount');
    const searchVal = (document.getElementById('deviceRptSearch').value || '').toLowerCase().trim();

    const addedKeys = new Set(myRepeaters.map(r => r.public_key));
    let items = _deviceRepeaters || [];
    if (searchVal) {
        items = items.filter(c => (c.name || '').toLowerCase().includes(searchVal));
    }

    if (countEl) countEl.textContent = `${(_deviceRepeaters || []).length} repeaters on device`;

    if (!items.length) {
        listEl.innerHTML = '<div class="text-muted small p-3">No repeaters found on the device.</div>';
        return;
    }

    listEl.innerHTML = '';
    items.forEach(c => {
        const added = addedKeys.has(c.public_key.toLowerCase());
        const item = document.createElement('div');
        item.className = 'device-rpt-item' + (added ? ' added' : '');
        item.innerHTML = `
            <i class="bi bi-diagram-3 text-success"></i>
            <div class="flex-grow-1" style="min-width: 0;">
                <div class="text-truncate">${esc(c.name || c.public_key_prefix)}</div>
                <small class="text-muted font-monospace">${esc(c.public_key_prefix)} · ${esc(c.path_or_mode || '')}</small>
            </div>
            ${added
                ? '<span class="badge bg-secondary flex-shrink-0">Added</span>'
                : '<i class="bi bi-plus-circle text-success flex-shrink-0"></i>'}
        `;
        if (!added) {
            item.addEventListener('click', () => addRepeater(c));
        }
        listEl.appendChild(item);
    });
}

async function addRepeater(contact) {
    try {
        const response = await fetch('/api/repeaters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_key: contact.public_key })
        });
        const data = await response.json();
        if (data.success) {
            showNotification(`${contact.name || 'Repeater'} added`, 'success');
            await loadRepeaters();
            renderDeviceRepeaterList();
        } else {
            showNotification(data.error || 'Failed to add repeater', 'danger');
        }
    } catch (e) {
        showNotification('Failed to add repeater', 'danger');
    }
}

// ================================================================
// Path management (adapted from the DM panel; same REST endpoints)
// ================================================================

function openPathModal(pubkey) {
    const r = findRepeater(pubkey);
    if (!r) return;
    _pathPubkey = pubkey;
    document.getElementById('pathModalName').textContent = r.name || pubkey.substring(0, 12);
    document.getElementById('pathModalCurrent').textContent = r.path_or_mode || '—';
    _pathModal.show();
    renderPathList(pubkey);
}

async function refreshDevicePathDisplay() {
    // Path applied/reset on device — the server invalidated the contacts
    // cache, so a plain reload picks up the fresh out_path.
    await loadRepeaters();
    const r = findRepeater(_pathPubkey);
    const el = document.getElementById('pathModalCurrent');
    if (el && r) el.textContent = r.path_or_mode || '—';
}

async function renderPathList(pubkey) {
    const listEl = document.getElementById('pathList');
    if (!listEl) return;

    listEl.innerHTML = '<div class="text-muted small">Loading...</div>';

    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths`);
        const data = await response.json();
        if (!data.success || !data.paths.length) {
            listEl.innerHTML = '<div class="text-muted small mb-2">No paths configured. Use + to add.</div>';
            return;
        }

        listEl.innerHTML = '';
        data.paths.forEach((path, index) => {
            const item = document.createElement('div');
            item.className = 'path-list-item' + (path.is_primary ? ' primary' : '');

            const chunk = path.hash_size * 2;
            const hops = [];
            for (let i = 0; i < path.path_hex.length; i += chunk) {
                hops.push(path.path_hex.substring(i, i + chunk).toUpperCase());
            }
            const pathDisplay = hops.join('→');
            const hashLabel = path.hash_size + 'B';

            item.innerHTML = `
                <span class="path-hex" title="${esc(path.path_hex)}">${esc(pathDisplay)}</span>
                <span class="badge bg-secondary">${hashLabel}</span>
                ${path.label ? `<span class="path-label" title="${esc(path.label)}">${esc(path.label)}</span>` : ''}
                <span class="path-actions">
                    <button class="btn btn-link p-0 ${path.is_primary ? 'text-warning' : 'text-muted'}"
                            title="${path.is_primary ? 'Primary path' : 'Set as primary'}"
                            data-action="primary" data-id="${path.id}">
                        <i class="bi bi-star${path.is_primary ? '-fill' : ''}"></i>
                    </button>
                    <button class="btn btn-link p-0 text-primary"
                            title="Set as device path"
                            data-action="apply" data-id="${path.id}">
                        <i class="bi bi-upload"></i>
                    </button>
                    ${index > 0 ? `<button class="btn btn-link p-0 text-muted" title="Move up" data-action="up" data-id="${path.id}" data-index="${index}"><i class="bi bi-chevron-up"></i></button>` : ''}
                    ${index < data.paths.length - 1 ? `<button class="btn btn-link p-0 text-muted" title="Move down" data-action="down" data-id="${path.id}" data-index="${index}"><i class="bi bi-chevron-down"></i></button>` : ''}
                    <button class="btn btn-link p-0 text-danger" title="Delete" data-action="delete" data-id="${path.id}">
                        <i class="bi bi-trash"></i>
                    </button>
                </span>
            `;
            listEl.appendChild(item);
        });

        listEl.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const pathId = parseInt(btn.dataset.id);

                if (action === 'primary') {
                    await setPathPrimary(pubkey, pathId);
                } else if (action === 'apply') {
                    await applyPathToDevice(pubkey, pathId);
                } else if (action === 'delete') {
                    await deletePathItem(pubkey, pathId);
                } else if (action === 'up' || action === 'down') {
                    await movePathItem(pubkey, data.paths, parseInt(btn.dataset.index), action);
                }
            });
        });
    } catch (e) {
        listEl.innerHTML = '<div class="text-danger small">Failed to load paths</div>';
        console.error('Failed to load paths:', e);
    }
}

async function setPathPrimary(pubkey, pathId) {
    try {
        await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/${pathId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_primary: true })
        });
        await renderPathList(pubkey);
    } catch (e) {
        console.error('Failed to set primary path:', e);
    }
}

async function applyPathToDevice(pubkey, pathId) {
    try {
        const response = await fetch(
            `/api/contacts/${encodeURIComponent(pubkey)}/paths/${pathId}/apply`,
            { method: 'POST' }
        );
        const data = await response.json();
        if (data.success) {
            showNotification('Device path updated', 'info');
            await refreshDevicePathDisplay();
        } else {
            showNotification(data.error || 'Failed to set device path', 'danger');
        }
    } catch (e) {
        console.error('Failed to apply path to device:', e);
        showNotification('Failed to set device path', 'danger');
    }
}

async function deletePathItem(pubkey, pathId) {
    try {
        await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/${pathId}`, {
            method: 'DELETE'
        });
        await renderPathList(pubkey);
    } catch (e) {
        console.error('Failed to delete path:', e);
    }
}

async function movePathItem(pubkey, paths, currentIndex, direction) {
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= paths.length) return;

    const ids = paths.map(p => p.id);
    [ids[currentIndex], ids[newIndex]] = [ids[newIndex], ids[currentIndex]];

    try {
        await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path_ids: ids })
        });
        await renderPathList(pubkey);
    } catch (e) {
        console.error('Failed to reorder paths:', e);
    }
}

// ---------------- Add Path modal ----------------

function openAddPathModal() {
    document.getElementById('pathHexInput').value = '';
    document.getElementById('pathLabelInput').value = '';
    document.getElementById('pathUniquenessWarning').style.display = 'none';
    document.getElementById('repeaterPicker').style.display = 'none';
    _addPathModal.show();
}

async function saveNewPath() {
    const pubkey = _pathPubkey;
    if (!pubkey) return;
    const pathHex = document.getElementById('pathHexInput').value.replace(/[,\s→]/g, '').trim();
    const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked').value);
    const label = document.getElementById('pathLabelInput').value.trim();

    if (!pathHex) {
        showNotification('Path hex is required', 'danger');
        return;
    }

    const chunk = hashSize * 2;
    const hops = [];
    for (let i = 0; i < pathHex.length; i += chunk) {
        hops.push(pathHex.substring(i, i + chunk).toLowerCase());
    }
    if (hashSize === 1) {
        const adjDupes = hops.filter((h, i) => i > 0 && hops[i - 1] === h);
        if (adjDupes.length > 0) {
            showNotification(`Adjacent duplicate hop(s): ${[...new Set(adjDupes)].map(d => d.toUpperCase()).join(', ')}`, 'danger');
            return;
        }
    } else {
        const dupes = hops.filter((h, i) => hops.indexOf(h) !== i);
        if (dupes.length > 0) {
            showNotification(`Duplicate hop(s): ${[...new Set(dupes)].map(d => d.toUpperCase()).join(', ')}`, 'danger');
            return;
        }
    }

    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path_hex: pathHex, hash_size: hashSize, label: label })
        });
        const data = await response.json();
        if (data.success) {
            _addPathModal.hide();
            await renderPathList(pubkey);
            showNotification('Path added', 'info');
        } else {
            showNotification(data.error || 'Failed to add path', 'danger');
        }
    } catch (e) {
        showNotification('Failed to add path', 'danger');
    }
}

async function resetPathToFlood() {
    const pubkey = _pathPubkey;
    if (!pubkey) return;
    if (!confirm('Reset device path to FLOOD?\n\nThis resets the path on the device only. Your configured paths will be kept.')) {
        return;
    }
    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/reset_flood`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            showNotification('Device path reset to FLOOD', 'info');
            await refreshDevicePathDisplay();
        } else {
            showNotification(data.error || 'Reset failed', 'danger');
        }
    } catch (e) {
        showNotification('Reset failed', 'danger');
    }
}

async function clearAllPaths() {
    const pubkey = _pathPubkey;
    if (!pubkey) return;
    if (!confirm('Clear all configured paths?\n\nThis will delete all paths from the database. The device path will not be changed.')) {
        return;
    }
    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/clear`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            await renderPathList(pubkey);
            showNotification(`${data.paths_deleted || 0} path(s) cleared`, 'info');
        } else {
            showNotification(data.error || 'Clear failed', 'danger');
        }
    } catch (e) {
        showNotification('Clear failed', 'danger');
    }
}

// ---------------- Hop picker (repeater list) ----------------

async function toggleHopPicker() {
    const picker = document.getElementById('repeaterPicker');
    if (picker.style.display === 'none') {
        picker.style.display = '';
        await loadHopPicker();
    } else {
        picker.style.display = 'none';
    }
}

async function loadHopPicker() {
    const listEl = document.getElementById('repeaterList2');
    if (!listEl) return;

    if (!_repeatersCache) {
        try {
            const response = await fetch('/api/contacts/repeaters');
            const data = await response.json();
            if (data.success) {
                _repeatersCache = data.repeaters;
            }
        } catch (e) {
            listEl.innerHTML = '<div class="text-danger small p-2">Failed to load repeaters</div>';
            return;
        }
    }

    renderHopPickerList(listEl, _repeatersCache);
}

function getRepeaterSearchMode() {
    const checked = document.querySelector('input[name="repeaterSearchMode"]:checked');
    return checked ? checked.value : 'name';
}

function renderHopPickerList(listEl, repeaters) {
    const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked').value);
    const hexInput = document.getElementById('pathHexInput');
    const searchVal = (document.getElementById('repeaterSearch')?.value || '').toLowerCase().trim();
    const searchMode = getRepeaterSearchMode();
    const prefixLen = hashSize * 2;

    const filtered = repeaters.filter(r => {
        if (!searchVal) return true;
        if (searchMode === 'id') {
            const idPrefix = r.public_key.substring(0, prefixLen).toLowerCase();
            return idPrefix.startsWith(searchVal.substring(0, prefixLen));
        }
        return r.name.toLowerCase().includes(searchVal);
    });

    if (!filtered.length) {
        listEl.innerHTML = '<div class="text-muted small p-2">No repeaters found</div>';
        return;
    }

    listEl.innerHTML = '';
    filtered.forEach(rpt => {
        const prefix = rpt.public_key.substring(0, hashSize * 2).toUpperCase();
        const samePrefix = repeaters.filter(r =>
            r.public_key.substring(0, hashSize * 2).toLowerCase() === prefix.toLowerCase()
        ).length;

        const item = document.createElement('div');
        item.className = 'repeater-picker-item';
        item.innerHTML = `
            <span class="badge ${samePrefix > 1 ? 'bg-warning text-dark' : 'bg-success'}">${esc(prefix)}</span>
            <span class="flex-grow-1 text-truncate">${esc(rpt.name)}</span>
            ${samePrefix > 1 ? '<i class="bi bi-exclamation-triangle text-warning" title="' + samePrefix + ' repeaters share this prefix"></i>' : ''}
        `;
        item.addEventListener('click', () => {
            appendHopToPathInput(prefix.toLowerCase(), hashSize);
        });
        listEl.appendChild(item);
    });
}

function getCurrentPathHops(hashSize) {
    const hexInput = document.getElementById('pathHexInput');
    if (!hexInput) return [];
    const rawHex = hexInput.value.replace(/[,\s→]/g, '').trim().toLowerCase();
    const chunk = hashSize * 2;
    const hops = [];
    for (let i = 0; i < rawHex.length; i += chunk) {
        hops.push(rawHex.substring(i, i + chunk));
    }
    return hops;
}

function appendHopToPathInput(prefixLc, hashSize) {
    const existingHops = getCurrentPathHops(hashSize);
    if (hashSize === 1) {
        if (existingHops.length > 0 && existingHops[existingHops.length - 1] === prefixLc) {
            showNotification(`${prefixLc.toUpperCase()} cannot be adjacent to itself`, 'warning');
            return false;
        }
    } else {
        if (existingHops.includes(prefixLc)) {
            showNotification(`${prefixLc.toUpperCase()} is already in the path`, 'warning');
            return false;
        }
    }

    const hexInput = document.getElementById('pathHexInput');
    const current = hexInput.value.replace(/[,\s→]/g, '').trim();
    const newVal = current + prefixLc;
    const chunk = hashSize * 2;
    const parts = [];
    for (let i = 0; i < newVal.length; i += chunk) {
        parts.push(newVal.substring(i, i + chunk));
    }
    hexInput.value = parts.join(',');

    if (_repeatersCache) {
        checkUniquenessWarning(_repeatersCache, hashSize);
    }
    return true;
}

function checkUniquenessWarning(repeaters, hashSize) {
    const warningEl = document.getElementById('pathUniquenessWarning');
    if (!warningEl) return;

    const hexInput = document.getElementById('pathHexInput');
    const rawHex = hexInput.value.replace(/[,\s→]/g, '').trim();
    const chunk = hashSize * 2;
    const hops = [];
    for (let i = 0; i < rawHex.length; i += chunk) {
        hops.push(rawHex.substring(i, i + chunk).toLowerCase());
    }

    const ambiguous = hops.filter(hop => {
        const count = repeaters.filter(r =>
            r.public_key.substring(0, chunk).toLowerCase() === hop
        ).length;
        return count > 1;
    });

    if (ambiguous.length > 0) {
        warningEl.textContent = `⚠ Ambiguous prefix(es): ${ambiguous.map(h => h.toUpperCase()).join(', ')}. Consider using a larger hash size.`;
        warningEl.style.display = '';
    } else {
        warningEl.style.display = 'none';
    }
}

// ---------------- Repeater map picker ----------------

let _rptMap = null;
let _rptMapMarkers = null;
let _rptMapSelectedRepeater = null;

function openRepeaterMapPicker() {
    _rptMapSelectedRepeater = null;

    const modalEl = document.getElementById('repeaterMapModal');
    if (!modalEl) return;

    const addBtn = document.getElementById('rptMapAddBtn');
    const selectedLabel = document.getElementById('rptMapSelected');
    if (addBtn) addBtn.disabled = true;
    if (selectedLabel) selectedLabel.textContent = 'Click a repeater on the map';

    const modal = new bootstrap.Modal(modalEl);

    const onShown = async function () {
        // Raise backdrop z-index so it covers the modals behind
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops.length > 0) {
            backdrops[backdrops.length - 1].style.zIndex = '1075';
        }

        if (!_rptMap) {
            _rptMap = L.map('rptLeafletMap').setView([52.0, 19.0], 6);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
            }).addTo(_rptMap);
            _rptMapMarkers = L.layerGroup().addTo(_rptMap);
        }
        _rptMap.invalidateSize();
        await loadRepeaterMapMarkers();
        modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    const cachedSwitch = document.getElementById('rptMapCachedSwitch');
    if (cachedSwitch) {
        cachedSwitch.onchange = () => loadRepeaterMapMarkers();
    }

    if (addBtn) {
        addBtn.onclick = () => {
            if (!_rptMapSelectedRepeater) return;
            const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked').value);
            const prefix = _rptMapSelectedRepeater.public_key.substring(0, hashSize * 2).toLowerCase();
            if (appendHopToPathInput(prefix, hashSize)) {
                _rptMapSelectedRepeater = null;
                addBtn.disabled = true;
                if (selectedLabel) selectedLabel.textContent = 'Click a repeater on the map';
            }
        };
    }

    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
}

async function loadRepeaterMapMarkers() {
    if (!_rptMapMarkers) return;
    _rptMapMarkers.clearLayers();

    const cachedSwitch = document.getElementById('rptMapCachedSwitch');
    const showCached = cachedSwitch && cachedSwitch.checked;
    const countEl = document.getElementById('rptMapCount');
    const addBtn = document.getElementById('rptMapAddBtn');
    const selectedLabel = document.getElementById('rptMapSelected');

    _rptMapSelectedRepeater = null;
    if (addBtn) addBtn.disabled = true;
    if (selectedLabel) selectedLabel.textContent = 'Click a repeater on the map';

    if (!_repeatersCache) {
        try {
            const response = await fetch('/api/contacts/repeaters');
            const data = await response.json();
            if (data.success) _repeatersCache = data.repeaters;
        } catch (e) {
            if (countEl) countEl.textContent = 'Failed to load';
            return;
        }
    }

    let repeaters = (_repeatersCache || []).filter(r =>
        r.adv_lat && r.adv_lon && (r.adv_lat !== 0 || r.adv_lon !== 0)
    );

    if (!showCached) {
        // Non-cached: only repeaters that are on the device
        try {
            const response = await fetch('/api/contacts/detailed');
            const data = await response.json();
            if (data.success && data.contacts) {
                const deviceKeys = new Set(data.contacts
                    .filter(c => c.type === 2)
                    .map(c => c.public_key.toLowerCase()));
                repeaters = repeaters.filter(r => deviceKeys.has(r.public_key.toLowerCase()));
            }
        } catch (e) { /* show all on error */ }
    }

    if (countEl) countEl.textContent = `${repeaters.length} repeaters`;

    const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked')?.value || '1');
    const bounds = [];

    repeaters.forEach(rpt => {
        const prefix = rpt.public_key.substring(0, hashSize * 2).toUpperCase();
        const lastSeen = rpt.last_advert ? formatRelativeTime(rpt.last_advert) : '';

        const marker = L.circleMarker([rpt.adv_lat, rpt.adv_lon], {
            radius: 10,
            fillColor: '#4CAF50',
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        }).addTo(_rptMapMarkers);

        marker.bindPopup(
            `<b>${esc(rpt.name)}</b><br>` +
            `<code>${esc(prefix)}</code>` +
            (lastSeen ? `<br><small class="text-muted">Last seen: ${lastSeen}</small>` : '')
        );

        marker.on('click', () => {
            _rptMapSelectedRepeater = rpt;
            const addBtn2 = document.getElementById('rptMapAddBtn');
            const selectedLabel2 = document.getElementById('rptMapSelected');
            if (addBtn2) addBtn2.disabled = false;
            if (selectedLabel2) {
                selectedLabel2.innerHTML = `<code>${esc(prefix)}</code> ${esc(rpt.name)}`;
            }
        });

        bounds.push([rpt.adv_lat, rpt.adv_lon]);
    });

    if (bounds.length > 0) {
        _rptMap.fitBounds(bounds, { padding: [20, 20] });
    }
}

// ================================================================
// Init
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
    _passwordModal = new bootstrap.Modal(document.getElementById('passwordModal'));
    _addRepeaterModal = new bootstrap.Modal(document.getElementById('addRepeaterModal'));
    _pathModal = new bootstrap.Modal(document.getElementById('pathModal'));
    _addPathModal = new bootstrap.Modal(document.getElementById('addPathModal'));
    _removeModal = new bootstrap.Modal(document.getElementById('removeRepeaterModal'));

    loadUiSettings();
    loadRepeaters();

    document.getElementById('addRepeaterBtn').addEventListener('click', openAddRepeaterModal);
    document.getElementById('refreshBtn').addEventListener('click', () => loadRepeaters(true));
    document.getElementById('deviceRptSearch').addEventListener('input', renderDeviceRepeaterList);

    document.getElementById('passwordSubmitBtn').addEventListener('click', submitPasswordModal);
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

    document.getElementById('removeRepeaterConfirmBtn').addEventListener('click', confirmRemoveRepeater);

    // Path editor
    document.getElementById('addPathBtn').addEventListener('click', openAddPathModal);
    document.getElementById('savePathBtn').addEventListener('click', saveNewPath);
    document.getElementById('clearPathsBtn').addEventListener('click', clearAllPaths);
    document.getElementById('resetFloodBtn').addEventListener('click', resetPathToFlood);
    document.getElementById('pickRepeaterBtn').addEventListener('click', toggleHopPicker);
    document.getElementById('pickRepeaterMapBtn').addEventListener('click', openRepeaterMapPicker);
    document.getElementById('repeaterSearch').addEventListener('input', () => {
        const listEl = document.getElementById('repeaterList2');
        if (listEl && _repeatersCache) renderHopPickerList(listEl, _repeatersCache);
    });
    document.querySelectorAll('input[name="repeaterSearchMode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const listEl = document.getElementById('repeaterList2');
            if (listEl && _repeatersCache) renderHopPickerList(listEl, _repeatersCache);
        });
    });
    document.querySelectorAll('input[name="pathHashSize"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const listEl = document.getElementById('repeaterList2');
            if (listEl && _repeatersCache) renderHopPickerList(listEl, _repeatersCache);
        });
    });

    // Raise backdrop when Add Path modal opens above the Paths modal
    document.getElementById('addPathModal').addEventListener('shown.bs.modal', () => {
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops.length > 1) {
            backdrops[backdrops.length - 1].style.zIndex = '1060';
        }
    });
});
