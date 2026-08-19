/**
 * Share Composer — the "+" button next to the message input
 *
 * Lets the user drop a contact, a channel or a position into the message they
 * are writing. The payload is inserted as plain text in the format the official
 * MeshCore app uses (see share-tokens.js), because that is the interop contract
 * — nothing here invents a format.
 *
 * Shared verbatim by the channel chat and the DM panel: the two composers are
 * separate components with different element ids, so everything below resolves
 * whichever one is present in the document.
 *
 * Modals are built in JS rather than added to two templates, following
 * createImageModal() in message-utils.js. That also guarantees both chats get
 * an identical picker.
 */

(function () {
    'use strict';

    // Composer wiring, per page. The byte budgets mirror updateCharCounter() in
    // app.js (135) and dm.js (150) — the mesh packet limits, counted in UTF-8.
    const COMPOSERS = [
        { input: 'messageInput',   button: 'shareBtn',   anchor: 'emojiBtn',   maxBytes: 135 },
        { input: 'dmMessageInput', button: 'dmShareBtn', anchor: 'dmEmojiBtn', maxBytes: 150 }
    ];

    // api.py reports cached contacts with a label instead of the numeric type;
    // the token needs the number back. Label set from CONTACT_TYPE_NAMES.
    const TYPE_BY_LABEL = { COM: 1, REP: 2, ROOM: 3, SENS: 4 };

    const TYPE_ICONS = {
        1: 'bi-person-fill', 2: 'bi-broadcast', 3: 'bi-door-open-fill', 4: 'bi-thermometer-half'
    };

    let _composer = null;   // the active COMPOSERS entry
    let _pickerMap = null;  // Leaflet instance for the location picker
    let _pickerMarker = null;
    let _pickedLatLng = null;

    // ---------------------------------------------------------------- helpers

    function activeComposer() {
        if (_composer) return _composer;
        _composer = COMPOSERS.find(c => document.getElementById(c.input)) || null;
        return _composer;
    }

    function inputEl() {
        const c = activeComposer();
        return c ? document.getElementById(c.input) : null;
    }

    function maxBytes() {
        const c = activeComposer();
        return c ? c.maxBytes : 135;
    }

    function typeLabelToNumber(label) {
        return TYPE_BY_LABEL[(label || '').toUpperCase()] || 1;
    }

    /** Refresh the page's own byte counter after we change the input value. */
    function refreshCounter() {
        if (typeof updateCharCounter === 'function') updateCharCounter();
    }

    // ------------------------------------------------------------- insertion

    /**
     * Insert a token at the caret, padding with spaces so it never fuses with
     * neighbouring words (which would stop it parsing).
     */
    function insertShareToken(token) {
        const input = inputEl();
        if (!input || !token) return;

        const bytes = MCShare.byteLength(token);
        if (bytes > maxBytes()) {
            // Nothing sensible to truncate: shortening a key or a secret
            // destroys it. Say so instead of sending something broken.
            showNotification(t('share.toast.too_long', { bytes: bytes, max: maxBytes() }), 'danger');
            return;
        }

        const value = input.value;
        const start = input.selectionStart ?? value.length;
        const end = input.selectionEnd ?? value.length;

        let before = value.slice(0, start);
        let after = value.slice(end);
        if (before && !/\s$/.test(before)) before += ' ';
        if (after && !/^\s/.test(after)) after = ' ' + after;

        input.value = before + token + after;
        const caret = (before + token).length;
        input.setSelectionRange(caret, caret);
        input.focus();

        refreshCounter();
        updateSharePreview();

        const total = MCShare.byteLength(input.value);
        if (total > maxBytes()) {
            showNotification(t('share.toast.over_budget', { bytes: total, max: maxBytes() }), 'warning');
        }
    }

    // --------------------------------------------------------------- preview

    /**
     * Show the card the message will produce, above the composer, for as long as
     * the input holds a valid token.
     *
     * This is why the token is inserted as plain text rather than held in a
     * protected chip: the format has to stay byte-identical to what the official
     * app sends, and a preview gives the same reassurance without touching it.
     * Break the token by editing and the preview disappears — immediate feedback
     * that the message will not render as a card.
     */
    function updateSharePreview() {
        const input = inputEl();
        if (!input) return;

        let host = document.getElementById('sharePreview');
        const tokens = MCShare.parse(input.value);

        if (!tokens.length) {
            if (host) host.remove();
            return;
        }

        if (!host) {
            host = document.createElement('div');
            host.id = 'sharePreview';
            host.className = 'share-preview';
            // Above the input group, inside the positioned composer container.
            const container = input.closest('.emoji-picker-container') || input.parentElement;
            container.parentElement.insertBefore(host, container);
        }

        // Render through the normal pipeline so the preview cannot drift from
        // what the recipient will actually see.
        host.innerHTML =
            `<div class="share-preview-label">${tHtml('share.preview.label')}</div>` +
            `<div class="share-preview-body">${processMessageContent(input.value, { isOwn: true })}</div>`;
    }

    // ----------------------------------------------------------- modal plumbing

    /**
     * Create (once) and return a Bootstrap modal shell.
     * z-index 1080 matches the other stacked modals in this app; the DM panel is
     * itself inside a modal, so a picker always opens on top of something.
     */
    function ensureModal(id, titleKey, icon) {
        let modal = document.getElementById(id);
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = id;
        modal.className = 'modal fade';
        modal.tabIndex = -1;
        modal.style.zIndex = '1080';
        modal.innerHTML =
            `<div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header py-2">
                        <h6 class="modal-title"><i class="bi ${icon}"></i> ${tHtml(titleKey)}</h6>
                        <button type="button" class="btn-close" data-bs-dismiss="modal"
                                aria-label="${tHtml('common.close')}"></button>
                    </div>
                    <div class="modal-body p-2"></div>
                </div>
            </div>`;
        document.body.appendChild(modal);
        return modal;
    }

    function showModal(modal) {
        bootstrap.Modal.getOrCreateInstance(modal).show();
    }

    function hideModal(modal) {
        bootstrap.Modal.getOrCreateInstance(modal).hide();
    }

    /** A single row in a picker list. */
    function pickerRow({ icon, title, subtitle, badge, dataset }) {
        const attrs = Object.entries(dataset || {})
            .map(([k, v]) => `data-${k}="${escapeHtmlAttribute(String(v))}"`).join(' ');
        return `<button type="button" class="list-group-item list-group-item-action share-pick-row" ${attrs}>
                    <span class="share-pick-icon"><i class="bi ${icon}"></i></span>
                    <span class="share-pick-text">
                        <span class="share-pick-title">${escapeHtml(title)}</span>
                        ${subtitle ? `<span class="share-pick-sub">${escapeHtml(subtitle)}</span>` : ''}
                    </span>
                    ${badge ? `<span class="share-pick-badge">${escapeHtml(badge)}</span>` : ''}
                </button>`;
    }

    // ------------------------------------------------------- contact picker

    /**
     * Every contact we know, device memory and cache alike — the cache is where
     * adverts land, and those are exactly the contacts worth passing on.
     */
    async function fetchAllContacts() {
        const [detailedResp, cachedResp] = await Promise.all([
            fetch('/api/contacts/detailed'),
            fetch('/api/contacts/cached?format=full')
        ]);
        const detailed = await detailedResp.json();
        const cached = await cachedResp.json();

        const byPubkey = new Map();

        if (detailed.success) {
            (detailed.contacts || []).forEach(c => {
                if (!c.public_key) return;
                byPubkey.set(c.public_key.toLowerCase(), {
                    public_key: c.public_key.toLowerCase(),
                    name: c.name || '',
                    type: c.type || 1,
                    onDevice: true
                });
            });
        }
        if (cached.success) {
            (cached.contacts || []).forEach(c => {
                const pk = (c.public_key || '').toLowerCase();
                if (!pk || byPubkey.has(pk)) return;
                byPubkey.set(pk, {
                    public_key: pk,
                    name: c.name || '',
                    // Only the label comes back on this endpoint.
                    type: typeLabelToNumber(c.type_label),
                    onDevice: false
                });
            });
        }

        return [...byPubkey.values()]
            .filter(c => c.name)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Our own identity, shared as a contact. */
    async function fetchSelfContact() {
        const resp = await fetch('/api/device/info');
        if (!resp.ok) return null;
        const data = await resp.json();
        const info = (data.success && data.info) || null;
        if (!info || !info.public_key) return null;
        return {
            public_key: info.public_key.toLowerCase(),
            name: info.name || info.adv_name || '',
            // A companion app normally advertises type 1; trust the device but
            // fall back, matching loadDeviceShare() in app.js.
            type: info.adv_type || 1
        };
    }

    async function openContactPicker() {
        const modal = ensureModal('sharePickContactModal', 'share.pick.contact_title', 'bi-person-plus');
        const body = modal.querySelector('.modal-body');
        body.innerHTML = `<div class="text-center text-muted small py-3">${tHtml('common.loading')}</div>`;
        showModal(modal);

        let self = null;
        let contacts = [];
        try {
            [self, contacts] = await Promise.all([fetchSelfContact(), fetchAllContacts()]);
        } catch (e) {
            console.error('Share: failed to load contacts', e);
            body.innerHTML = `<div class="text-center text-danger small py-3">${tHtml('share.toast.action_failed')}</div>`;
            return;
        }

        body.innerHTML =
            `<input type="search" class="form-control form-control-sm mb-2" id="sharePickSearch"
                    placeholder="${tHtml('share.pick.search_ph')}" autocomplete="off">
             <div class="list-group share-pick-list" id="sharePickList"></div>`;

        const listEl = body.querySelector('#sharePickList');
        const search = body.querySelector('#sharePickSearch');

        /**
         * Render the matching rows, capped.
         *
         * The cache accumulates every advert ever seen — over 1500 contacts on a
         * busy mesh — and rendering them all costs thousands of DOM nodes for a
         * list nobody scrolls to the end of. The cap keeps the picker instant;
         * the search runs over the full set, so nothing is unreachable.
         */
        const RENDER_CAP = 150;
        function renderRows(query) {
            const q = (query || '').trim().toLowerCase();
            const matches = c => !q || c.name.toLowerCase().includes(q) ||
                                 c.public_key.includes(q);

            // "Me" is pinned to the top rather than hidden behind its own menu
            // item: sharing yourself is the commonest case, and it is still just
            // a contact.
            const parts = [];
            if (self && matches(self)) {
                parts.push(pickerRow({
                    icon: TYPE_ICONS[MCShare.normalizeContactType(self.type)] || 'bi-person-fill',
                    title: self.name,
                    subtitle: MCShare.shortPubkey(self.public_key),
                    badge: t('share.pick.me'),
                    dataset: { pubkey: self.public_key, name: self.name, type: self.type }
                }));
            }

            const hits = contacts.filter(matches);
            hits.slice(0, RENDER_CAP).forEach(c => {
                parts.push(pickerRow({
                    icon: TYPE_ICONS[MCShare.normalizeContactType(c.type)] || 'bi-person-fill',
                    title: c.name,
                    subtitle: MCShare.shortPubkey(c.public_key),
                    badge: c.onDevice ? '' : t('share.card.in_cache'),
                    dataset: { pubkey: c.public_key, name: c.name, type: c.type }
                }));
            });

            if (!parts.length) {
                parts.push(`<div class="text-center text-muted small py-3">${tHtml('share.pick.empty')}</div>`);
            } else if (hits.length > RENDER_CAP) {
                parts.push(`<div class="text-center text-muted small py-2">${
                    tHtml('share.pick.truncated', { shown: RENDER_CAP, total: hits.length })}</div>`);
            }

            listEl.innerHTML = parts.join('');
        }

        renderRows('');
        search.addEventListener('input', () => renderRows(search.value));

        // Delegated, so it survives every re-render.
        listEl.addEventListener('click', (e) => {
            const row = e.target.closest('.share-pick-row');
            if (!row) return;
            const token = MCShare.serializeContact({
                public_key: row.dataset.pubkey,
                type: parseInt(row.dataset.type, 10) || 1,
                name: row.dataset.name
            });
            hideModal(modal);
            insertShareToken(token);
        });
    }

    // ------------------------------------------------------- channel picker

    async function openChannelPicker() {
        const modal = ensureModal('sharePickChannelModal', 'share.pick.channel_title', 'bi-hash');
        const body = modal.querySelector('.modal-body');
        body.innerHTML = `<div class="text-center text-muted small py-3">${tHtml('common.loading')}</div>`;
        showModal(modal);

        let channels = [];
        let scopes = {};
        try {
            const [chResp, scResp] = await Promise.all([
                fetch('/api/channels'),
                fetch('/api/channels/scopes')
            ]);
            const chData = await chResp.json();
            const scData = await scResp.json();
            channels = (chData.success && chData.channels) || [];
            scopes = (scData.success && scData.scopes) || {};
        } catch (e) {
            console.error('Share: failed to load channels', e);
            body.innerHTML = `<div class="text-center text-danger small py-3">${tHtml('share.toast.action_failed')}</div>`;
            return;
        }

        body.innerHTML =
            `<div class="list-group share-pick-list">
                ${channels.length
                    ? channels.map(ch => {
                          const scope = scopes[String(ch.index)];
                          return pickerRow({
                              icon: 'bi-hash',
                              title: ch.name,
                              subtitle: MCShare.channelKindOf(ch.name) === 'hashtag'
                                  ? t('share.card.hashtag_channel') : t('share.card.private_channel'),
                              badge: scope && scope.name ? t('share.card.region', { name: scope.name }) : '',
                              dataset: {
                                  name: ch.name,
                                  secret: ch.key || '',
                                  scope: (scope && scope.name) || ''
                              }
                          });
                      }).join('')
                    : `<div class="text-center text-muted small py-3">${tHtml('share.pick.empty')}</div>`}
             </div>`;

        body.querySelectorAll('.share-pick-row').forEach(row => {
            row.addEventListener('click', () => {
                // The scope travels with the channel: without it the recipient
                // would transmit under the firmware default and not be heard.
                const token = MCShare.serializeChannel({
                    name: row.dataset.name,
                    secret: row.dataset.secret,
                    region_scope: row.dataset.scope || null
                });
                if (!token) {
                    showNotification(t('share.toast.channel_unshareable'), 'warning');
                    return;
                }
                hideModal(modal);
                insertShareToken(token);
            });
        });
    }

    // ------------------------------------------------------ location picker

    async function openLocationPicker() {
        const modal = ensureModal('sharePickLocationModal', 'share.pick.location_title', 'bi-geo-alt');
        const body = modal.querySelector('.modal-body');

        // Our own position and an arbitrary point live in one dialog, so both
        // cases stay one action rather than two menu entries.
        let self = null;
        try {
            const resp = await fetch('/api/device/config');
            const data = await resp.json();
            const cfg = (data.success && data.config) || {};
            if (MCShare.isValidLatLon(cfg.lat, cfg.lon)) self = { lat: cfg.lat, lon: cfg.lon };
        } catch (e) {
            console.error('Share: failed to read device position', e);
        }

        _pickedLatLng = null;
        body.innerHTML =
            `${self
                ? `<button type="button" class="btn btn-sm btn-primary w-100 mb-2" id="shareUseOwnPos">
                       <i class="bi bi-crosshair"></i> ${tHtml('share.pick.my_position')}
                       <span class="share-pick-coords">${escapeHtml(MCShare.serializeLocation(self.lat, self.lon))}</span>
                   </button>`
                : `<div class="alert alert-warning py-2 small mb-2">${tHtml('share.pick.no_position')}</div>`}
             <div class="small text-muted mb-1" id="sharePickMapHint">${tHtml('share.pick.map_hint')}</div>
             <div id="sharePickMap" style="height: 300px; width: 100%;"></div>
             <div class="d-flex justify-content-end gap-2 mt-2">
                <button type="button" class="btn btn-sm btn-secondary" data-bs-dismiss="modal">${tHtml('common.cancel')}</button>
                <button type="button" class="btn btn-sm btn-primary" id="sharePickConfirm" disabled>${tHtml('coord.confirm')}</button>
             </div>`;

        if (self) {
            body.querySelector('#shareUseOwnPos').addEventListener('click', () => {
                hideModal(modal);
                insertShareToken(MCShare.serializeLocation(self.lat, self.lon));
            });
        }

        const confirmBtn = body.querySelector('#sharePickConfirm');
        confirmBtn.addEventListener('click', () => {
            if (!_pickedLatLng) return;
            hideModal(modal);
            insertShareToken(MCShare.serializeLocation(_pickedLatLng.lat, _pickedLatLng.lng));
        });

        // Leaflet cannot size itself in a hidden container, so build the map
        // only once the modal is actually on screen.
        modal.addEventListener('shown.bs.modal', function onShown() {
            modal.removeEventListener('shown.bs.modal', onShown);

            _pickerMap = L.map('sharePickMap');
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors',
                maxZoom: 19
            }).addTo(_pickerMap);

            _pickerMap.setView(self ? [self.lat, self.lon] : [52.0, 19.0], self ? 12 : 6);

            _pickerMap.on('click', (e) => {
                _pickedLatLng = e.latlng;
                if (_pickerMarker) _pickerMap.removeLayer(_pickerMarker);
                _pickerMarker = L.marker(e.latlng).addTo(_pickerMap);
                const hint = document.getElementById('sharePickMapHint');
                if (hint) {
                    hint.textContent = MCShare.serializeLocation(e.latlng.lat, e.latlng.lng);
                }
                confirmBtn.disabled = false;
            });

            _pickerMap.invalidateSize();
        });

        // A fresh map each time the dialog opens; keeping a stale instance around
        // breaks after the container is replaced by the next innerHTML write.
        modal.addEventListener('hidden.bs.modal', function onHidden() {
            modal.removeEventListener('hidden.bs.modal', onHidden);
            if (_pickerMap) { _pickerMap.remove(); _pickerMap = null; }
            _pickerMarker = null;
        });

        showModal(modal);
    }

    // ------------------------------------------------------------- share menu

    function buildShareMenu(container) {
        const popup = document.createElement('div');
        popup.id = 'shareMenuPopup';
        popup.className = 'share-menu-popup';
        popup.style.display = 'none';
        popup.innerHTML =
            `<button type="button" class="share-menu-item" data-share-pick="contact">
                <i class="bi bi-person-plus"></i> ${tHtml('share.menu.contact')}
             </button>
             <button type="button" class="share-menu-item" data-share-pick="channel">
                <i class="bi bi-hash"></i> ${tHtml('share.menu.channel')}
             </button>
             <button type="button" class="share-menu-item" data-share-pick="location">
                <i class="bi bi-geo-alt"></i> ${tHtml('share.menu.location')}
             </button>`;
        container.appendChild(popup);

        popup.addEventListener('click', (e) => {
            const item = e.target.closest('[data-share-pick]');
            if (!item) return;
            popup.style.display = 'none';
            switch (item.dataset.sharePick) {
                case 'contact':  openContactPicker(); break;
                case 'channel':  openChannelPicker(); break;
                case 'location': openLocationPicker(); break;
            }
        });

        return popup;
    }

    function initShareComposer() {
        const composer = activeComposer();
        if (!composer) return;

        const input = document.getElementById(composer.input);
        const anchor = document.getElementById(composer.anchor);
        if (!input || !anchor) return;

        // Sit next to the emoji button, inside the same input group.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = composer.button;
        btn.className = 'btn btn-outline-secondary share-composer-btn';
        btn.title = t('share.btn_title');
        btn.innerHTML = '<i class="bi bi-plus-circle"></i>';
        anchor.parentElement.insertBefore(btn, anchor);

        const container = input.closest('.emoji-picker-container') || btn.parentElement;
        const popup = buildShareMenu(container);

        // The DM composer starts disabled until a conversation is picked. Nothing
        // can be inserted into a disabled input, so the button follows its state.
        btn.disabled = input.disabled;
        new MutationObserver(() => { btn.disabled = input.disabled; })
            .observe(input, { attributes: true, attributeFilter: ['disabled'] });

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (input.disabled) return;
            popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
        });

        // Dismiss on an outside click, like the emoji and mentions popups.
        document.addEventListener('click', (e) => {
            if (popup.style.display === 'none') return;
            if (!popup.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
                popup.style.display = 'none';
            }
        });

        // Keep the preview in step with manual edits, so breaking a token by
        // hand visibly removes the card.
        input.addEventListener('input', updateSharePreview);

        // The composer is cleared on send; drop a stale preview with it.
        const form = input.closest('form');
        if (form) form.addEventListener('submit', () => setTimeout(updateSharePreview, 0));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initShareComposer);
    } else {
        initShareComposer();
    }

    // Exposed for the send path and for tests.
    window.MCShareComposer = {
        insertShareToken: insertShareToken,
        updateSharePreview: updateSharePreview,
        openContactPicker: openContactPicker,
        openChannelPicker: openChannelPicker,
        openLocationPicker: openLocationPicker
    };
})();
