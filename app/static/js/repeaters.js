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

// 'AB→CD→EF' offers the browser no line-break opportunity, so a multi-hop path
// runs off a narrow screen. A zero-width space after each arrow lets it wrap by
// hop. Apply after esc() — the result is HTML.
const RPT_ZWSP = String.fromCharCode(0x200B);

function wrapPath(s) {
    return String(s ?? '').replaceAll('→', '→' + RPT_ZWSP);
}

// Relative time comes from datetime-utils.js as formatTimeAgo(). The local copy this
// replaced also had a "Never" branch for a falsy timestamp, which was unreachable — the
// single call site already guards it. contacts.js and dm.js have since been folded in
// the same way, so this is now the only implementation.

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
            listEl.innerHTML = `<div class="text-danger small">${esc(data.error || t('repeaters.load_failed'))}</div>`;
            return;
        }
        myRepeaters = data.repeaters || [];
        renderRepeaterRows();
    } catch (e) {
        console.error('Failed to load repeaters:', e);
        listEl.innerHTML = `<div class="text-danger small">${tHtml('repeaters.load_failed')}</div>`;
    }
}

function renderRepeaterRows() {
    const listEl = document.getElementById('repeaterList');
    const emptyEl = document.getElementById('emptyState');
    const countEl = document.getElementById('repeaterCount');

    if (countEl) {
        countEl.textContent = myRepeaters.length ? tn('repeaters.count', myRepeaters.length) : '';
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

        // The path line wraps (no text-truncate) so a long path stays readable
        // on a phone; the other two variants are short and stay on one line.
        const statusLine = isLoggingIn
            ? `<small class="text-muted d-block text-truncate"><span class="text-primary">${tHtml('repeaters.row.logging_in')}</span></small>`
            : (r.on_device
                ? `<small class="text-muted d-block"><span class="rpt-path font-monospace">${wrapPath(esc(r.path_or_mode || '—'))}</span></small>`
                : `<small class="text-muted d-block text-truncate"><span class="text-warning">${tHtml('repeaters.row.not_on_device')}</span></small>`);
        // "last login" goes on its own line so a long path keeps the full row
        // width to itself (on narrow phones it otherwise gets truncated hard).
        const roleLine = (r.on_device && !isLoggingIn && r.last_login_at)
            ? `<small class="text-muted d-block text-truncate">${tHtml('repeaters.row.last_login', { role: r.last_login_role || '?' })}</small>`
            : '';

        row.innerHTML = `
            <div class="d-flex align-items-center gap-2">
                <span class="rpt-icon flex-shrink-0">${icon}</span>
                <div class="flex-grow-1 rpt-main">
                    <div class="fw-semibold text-truncate">${esc(r.name || r.public_key.substring(0, 12))}</div>
                    ${statusLine}
                    ${roleLine}
                </div>
                <div class="btn-group btn-group-sm flex-shrink-0">
                    <button type="button" class="btn btn-outline-secondary" data-action="path"
                            title="${tHtml('repeaters.row.set_path_title')}" ${r.on_device ? '' : 'disabled'}>
                        <i class="bi bi-signpost-split"></i>
                    </button>
                    <button type="button" class="btn btn-outline-secondary" data-action="password"
                            title="${tHtml(r.password_set ? 'repeaters.password.change_title' : 'repeaters.password.set_title')}">
                        <i class="bi bi-key${r.password_set ? '-fill' : ''}"></i>
                    </button>
                    <button type="button" class="btn btn-outline-danger" data-action="remove" title="${tHtml('repeaters.row.remove_title')}">
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
        showNotification(t('repeaters.toast.not_on_device'), 'warning');
        return;
    }
    if (_loginPubkey) {
        showNotification(t('repeaters.toast.login_in_progress'), 'warning');
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
        data = { success: false, error: t('rptmgmt.login_request_failed') };
    }

    _loginPubkey = null;

    if (data && data.success) {
        const role = data.is_admin ? 'ADMIN' : 'GUEST';
        showNotification(t('repeaters.toast.logged_in', { name: r.name || t('repeaters.term'), role }), 'success');
        window.location.href = `/repeaters/manage?pubkey=${encodeURIComponent(pubkey)}`;
        return;
    } else {
        await loadRepeaters();
        const error = (data && data.error) || t('repeaters.toast.login_failed');
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
        title.textContent = `${t('repeaters.password.set_title')} — ${name}`;
        info.textContent = t('repeaters.password.set_info');
        submitBtn.textContent = t('common.save');
        saveWrap.style.display = 'none';
    } else {
        title.textContent = `${t('repeaters.password.login_title')} — ${name}`;
        // errorHint comes from the backend and stays English; only the advice around it
        // is translated.
        info.innerHTML = errorHint
            ? `<span class="text-danger">${esc(errorHint)}</span><br>${tHtml('repeaters.password.retry_hint')}`
            : tHtml('repeaters.password.login_info');
        submitBtn.textContent = t('repeaters.password.login_btn');
        saveWrap.style.display = '';
        saveCheck.checked = true;
    }
    input.value = '';
    input.type = 'password';

    // Login retry for a repeater with a saved password: the failure is most
    // likely a connection problem (a wrong stored password and an unreachable
    // repeater look identical), so prefill the saved password rather than make
    // the user retype a correct one.
    if (mode === 'login' && r.password_set) {
        fetch(`/api/repeaters/${encodeURIComponent(pubkey)}/password`)
            .then(resp => resp.json())
            .then(data => {
                if (data && data.success && data.password
                        && _passwordCtx && _passwordCtx.mode === 'login'
                        && _passwordCtx.pubkey === pubkey) {
                    input.value = data.password;
                }
            })
            .catch(() => {});
    }

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
        showNotification(t('repeaters.toast.password_empty'), 'warning');
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
                showNotification(t('repeaters.toast.password_saved'), 'success');
                await loadRepeaters();
            } else {
                showNotification(data.error || t('repeaters.toast.password_save_failed'), 'danger');
            }
        } catch (e) {
            showNotification(t('repeaters.toast.password_save_failed'), 'danger');
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
    document.getElementById('removeRepeaterQuestion').innerHTML = tHtml('repeaters.remove.question', {
        name: r.name || r.public_key.substring(0, 12)
    });
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
            showNotification(t('repeaters.toast.removed'), 'info');
            await loadRepeaters();
        } else {
            showNotification(data.error || t('repeaters.toast.remove_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('repeaters.toast.remove_failed'), 'danger');
    }
}

// ================================================================
// Add repeater picker (device contacts of type REP)
// ================================================================

async function openAddRepeaterModal() {
    _addRepeaterModal.show();
    const listEl = document.getElementById('deviceRptList');
    listEl.innerHTML = `<div class="text-muted small p-3">${tHtml('repeaters.add_loading')}</div>`;
    document.getElementById('deviceRptSearch').value = '';

    try {
        const response = await fetch('/api/contacts/detailed');
        const data = await response.json();
        if (!data.success) {
            listEl.innerHTML = `<div class="text-danger small p-3">${esc(data.error || t('repeaters.toast.contacts_load_failed'))}</div>`;
            return;
        }
        _deviceRepeaters = (data.contacts || [])
            .filter(c => c.type === 2)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        renderDeviceRepeaterList();
    } catch (e) {
        console.error('Failed to load device contacts:', e);
        listEl.innerHTML = `<div class="text-danger small p-3">${tHtml('repeaters.toast.contacts_load_failed')}</div>`;
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

    if (countEl) countEl.textContent = tn('repeaters.on_device_count', (_deviceRepeaters || []).length);

    if (!items.length) {
        listEl.innerHTML = `<div class="text-muted small p-3">${tHtml('repeaters.add_none_found')}</div>`;
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
                <small class="text-muted font-monospace rpt-path-wrap">${esc(c.public_key_prefix)} · ${wrapPath(esc(c.path_or_mode || ''))}</small>
            </div>
            ${added
                ? `<span class="badge bg-secondary flex-shrink-0">${tHtml('repeaters.added_badge')}</span>`
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
            showNotification(t('repeaters.toast.added', { name: contact.name || t('repeaters.term') }), 'success');
            await loadRepeaters();
            renderDeviceRepeaterList();
        } else {
            showNotification(data.error || t('repeaters.toast.add_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('repeaters.toast.add_failed'), 'danger');
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
    document.getElementById('pathModalCurrent').textContent = wrapPath(r.path_or_mode || '—');
    _pathModal.show();
    renderPathList(pubkey);
}

async function refreshDevicePathDisplay() {
    // Path applied/reset on device — the server invalidated the contacts
    // cache, so a plain reload picks up the fresh out_path.
    await loadRepeaters();
    const r = findRepeater(_pathPubkey);
    const el = document.getElementById('pathModalCurrent');
    if (el && r) el.textContent = wrapPath(r.path_or_mode || '—');
}

async function renderPathList(pubkey) {
    const listEl = document.getElementById('pathList');
    if (!listEl) return;

    listEl.innerHTML = `<div class="text-muted small">${tHtml('common.loading')}</div>`;

    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths`);
        const data = await response.json();
        if (!data.success || !data.paths.length) {
            listEl.innerHTML = `<div class="text-muted small mb-2">${tHtml('repeaters.paths.none')}</div>`;
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
                            title="${tHtml(path.is_primary ? 'repeaters.paths.is_primary_title' : 'repeaters.paths.set_primary_title')}"
                            data-action="primary" data-id="${path.id}">
                        <i class="bi bi-star${path.is_primary ? '-fill' : ''}"></i>
                    </button>
                    <button class="btn btn-link p-0 text-primary"
                            title="${tHtml('repeaters.paths.apply_title')}"
                            data-action="apply" data-id="${path.id}">
                        <i class="bi bi-upload"></i>
                    </button>
                    ${index > 0 ? `<button class="btn btn-link p-0 text-muted" title="${tHtml('common.move_up')}" data-action="up" data-id="${path.id}" data-index="${index}"><i class="bi bi-chevron-up"></i></button>` : ''}
                    ${index < data.paths.length - 1 ? `<button class="btn btn-link p-0 text-muted" title="${tHtml('common.move_down')}" data-action="down" data-id="${path.id}" data-index="${index}"><i class="bi bi-chevron-down"></i></button>` : ''}
                    <button class="btn btn-link p-0 text-danger" title="${tHtml('common.delete')}" data-action="delete" data-id="${path.id}">
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
        listEl.innerHTML = `<div class="text-danger small">${tHtml('repeaters.paths.load_failed')}</div>`;
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
            showNotification(t('repeaters.toast.path_updated'), 'info');
            await refreshDevicePathDisplay();
        } else {
            showNotification(data.error || t('repeaters.toast.path_set_failed'), 'danger');
        }
    } catch (e) {
        console.error('Failed to apply path to device:', e);
        showNotification(t('repeaters.toast.path_set_failed'), 'danger');
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
        showNotification(t('repeaters.toast.path_hex_required'), 'danger');
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
            showNotification(tn('repeaters.toast.adjacent_dupes', [...new Set(adjDupes)].length,
                { hops: [...new Set(adjDupes)].map(d => d.toUpperCase()).join(', ') }), 'danger');
            return;
        }
    } else {
        const dupes = hops.filter((h, i) => hops.indexOf(h) !== i);
        if (dupes.length > 0) {
            showNotification(tn('repeaters.toast.dupes', [...new Set(dupes)].length,
                { hops: [...new Set(dupes)].map(d => d.toUpperCase()).join(', ') }), 'danger');
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
            showNotification(t('repeaters.toast.path_added'), 'info');
        } else {
            showNotification(data.error || t('repeaters.toast.path_add_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('repeaters.toast.path_add_failed'), 'danger');
    }
}

async function resetPathToFlood() {
    const pubkey = _pathPubkey;
    if (!pubkey) return;
    if (!confirm(t('repeaters.confirm.reset_flood'))) {
        return;
    }
    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/reset_flood`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            showNotification(t('repeaters.toast.reset_flood_done'), 'info');
            await refreshDevicePathDisplay();
        } else {
            showNotification(data.error || t('repeaters.toast.reset_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('repeaters.toast.reset_failed'), 'danger');
    }
}

async function setPathDirect() {
    const pubkey = _pathPubkey;
    if (!pubkey) return;
    if (!confirm(t('repeaters.confirm.set_direct'))) {
        return;
    }
    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/set_direct`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            showNotification(t('repeaters.toast.set_direct_done'), 'info');
            await refreshDevicePathDisplay();
        } else {
            showNotification(data.error || t('repeaters.toast.set_direct_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('repeaters.toast.set_direct_failed'), 'danger');
    }
}

async function clearAllPaths() {
    const pubkey = _pathPubkey;
    if (!pubkey) return;
    if (!confirm(t('repeaters.confirm.clear_paths'))) {
        return;
    }
    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/clear`, {
            method: 'POST'
        });
        const data = await response.json();
        if (data.success) {
            await renderPathList(pubkey);
            showNotification(tn('repeaters.toast.paths_cleared', data.paths_deleted || 0), 'info');
        } else {
            showNotification(data.error || t('repeaters.toast.clear_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('repeaters.toast.clear_failed'), 'danger');
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
            listEl.innerHTML = `<div class="text-danger small p-2">${tHtml('repeaters.load_failed')}</div>`;
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
        listEl.innerHTML = `<div class="text-muted small p-2">${tHtml('repeaters.picker.none')}</div>`;
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
            ${samePrefix > 1 ? `<i class="bi bi-exclamation-triangle text-warning" title="${tn('repeaters.picker.shared_prefix', samePrefix)}"></i>` : ''}
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
            showNotification(t('repeaters.toast.hop_adjacent_self', { hop: prefixLc.toUpperCase() }), 'warning');
            return false;
        }
    } else {
        if (existingHops.includes(prefixLc)) {
            showNotification(t('repeaters.toast.hop_already_used', { hop: prefixLc.toUpperCase() }), 'warning');
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
        warningEl.textContent = tn('repeaters.toast.ambiguous_prefix', ambiguous.length,
        { hops: ambiguous.map(h => h.toUpperCase()).join(', ') });
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
    if (selectedLabel) selectedLabel.textContent = t('repeaters.map.hint');

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
                if (selectedLabel) selectedLabel.textContent = t('repeaters.map.hint');
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
    if (selectedLabel) selectedLabel.textContent = t('repeaters.map.hint');

    if (!_repeatersCache) {
        try {
            const response = await fetch('/api/contacts/repeaters');
            const data = await response.json();
            if (data.success) _repeatersCache = data.repeaters;
        } catch (e) {
            if (countEl) countEl.textContent = t('common.load_failed');
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
        const lastSeen = rpt.last_advert ? formatTimeAgo(rpt.last_advert) : '';

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
            (lastSeen ? `<br><small class="text-muted">${tHtml('repeaters.map.last_seen', { time: lastSeen })}</small>` : '')
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
    document.getElementById('setDirectBtn').addEventListener('click', setPathDirect);
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
