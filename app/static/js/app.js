/**
 * mc-webui Frontend Application
 */

// Global state
let lastMessageCount = 0;
let isUserScrolling = false;
let currentArchiveDate = null;  // Current selected archive date (null = live)
let currentChannelIdx = 0;  // Current active channel (0 = Public)
let availableChannels = [];  // List of channels from API
let lastSeenTimestamps = {};  // Track last seen message timestamp per channel
let unreadCounts = {};  // Track unread message counts per channel
let channelLastMessages = {};  // channel_idx -> {preview, timestamp}
let mutedChannels = new Set();  // Channel indices with muted notifications
let favoriteChannels = new Set();  // Channel indices marked as favorites (always shown above non-favorites)

// "New messages" divider state.
// unreadAnchorTs freezes the last-seen timestamp as it was when the channel was
// opened, because displayMessages() marks the channel read on every render and
// would otherwise erase the boundary before it can be drawn. It is recomputed
// only on a channel switch, so re-renders (resync, geo-cache reload) keep the
// divider in place instead of making it vanish a second after arriving.
let unreadAnchorTs = null;
let renderedChannelIdx = null;  // Channel that displayMessages last rendered

// DM state (for badge updates on main page)
let dmLastSeenTimestamps = {};  // Track last seen DM timestamp per conversation
let dmUnreadCounts = {};  // Track unread DM counts per conversation

// Map state (Leaflet)
let leafletMap = null;
let markersGroup = null;
let contactsGeoCache = {};  // { 'contactName': { lat, lon }, ... }
let contactsPubkeyMap = {};  // { 'contactName': 'full_pubkey', ... }
let contactsByPubkey = {};  // { 'full_pubkey': { name, source }, ... } — share cards
let blockedContactNames = new Set();  // Names of blocked contacts
let protectedContactPubkeys = new Set();  // Pubkeys of protected contacts
let allContactsWithGps = [];  // Device contacts for map filtering
let allCachedContactsWithGps = [];  // Cache-only contacts for map
let _selfInfo = null;  // Own device info (for map marker)

// SocketIO state
let chatSocket = null;  // SocketIO connection to /chat namespace

// Mentions autocomplete state
let mentionsCache = [];              // Cached contact list
let mentionsCacheTimestamp = 0;      // Cache timestamp
let mentionStartPos = -1;            // Position of @ in textarea
let mentionSelectedIndex = 0;        // Currently highlighted item
let isMentionMode = false;           // Is mention dropdown active

// Contact type colors for map markers
const CONTACT_TYPE_COLORS = {
    1: '#2196F3',  // COM - blue
    2: '#4CAF50',  // REP - green
    3: '#9C27B0',  // ROOM - purple
    4: '#FF9800'   // SENS - orange
};

const CONTACT_TYPE_NAMES = {
    1: 'COM',
    2: 'REP',
    3: 'ROOM',
    4: 'SENS'
};

/**
 * Global navigation function - closes offcanvas and cleans up before navigation
 * This prevents Bootstrap backdrop/body classes from persisting after page change
 */
window.navigateTo = function(url) {
    // Close offcanvas if open
    const offcanvasEl = document.getElementById('mainMenu');
    if (offcanvasEl) {
        const offcanvas = bootstrap.Offcanvas.getInstance(offcanvasEl);
        if (offcanvas) {
            offcanvas.hide();
        }
    }

    // Remove any lingering Bootstrap classes/backdrops
    document.body.classList.remove('modal-open', 'offcanvas-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';

    // Remove any backdrops
    const backdrops = document.querySelectorAll('.offcanvas-backdrop, .modal-backdrop');
    backdrops.forEach(backdrop => backdrop.remove());

    // Navigate after cleanup
    setTimeout(() => {
        window.location.href = url;
    }, 100);
};

// =============================================================================
// Leaflet Map Functions
// =============================================================================

/**
 * Initialize Leaflet map (called once on first modal open)
 */
function initLeafletMap() {
    if (leafletMap) return;

    leafletMap = L.map('leafletMap').setView([52.0, 19.0], 6);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(leafletMap);

    markersGroup = L.layerGroup().addTo(leafletMap);
}

/**
 * Show single contact on map
 */
function showContactOnMap(name, lat, lon) {
    const modalEl = document.getElementById('mapModal');
    const modal = new bootstrap.Modal(modalEl);
    document.getElementById('mapModalTitle').textContent = name;

    // Hide type filter panel for single contact view
    const filterPanel = document.getElementById('mapTypeFilter');
    if (filterPanel) filterPanel.classList.add('d-none');

    const onShown = function() {
        initLeafletMap();
        markersGroup.clearLayers();

        L.marker([lat, lon])
            .addTo(markersGroup)
            .bindPopup(`<b>${name}</b>`)
            .openPopup();

        leafletMap.setView([lat, lon], 13);
        leafletMap.invalidateSize();

        modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
}

// Make showContactOnMap available globally (for contacts.js)
window.showContactOnMap = showContactOnMap;

/**
 * Get selected contact types from map filter badges
 */
function getSelectedMapTypes() {
    const types = [];
    if (document.getElementById('mapFilterCOM')?.classList.contains('active')) types.push(1);
    if (document.getElementById('mapFilterREP')?.classList.contains('active')) types.push(2);
    if (document.getElementById('mapFilterROOM')?.classList.contains('active')) types.push(3);
    if (document.getElementById('mapFilterSENS')?.classList.contains('active')) types.push(4);
    return types;
}

/**
 * Update map markers based on current filter selection
 */
function updateMapMarkers() {
    if (!leafletMap || !markersGroup) return;

    markersGroup.clearLayers();
    const selectedTypes = getSelectedMapTypes();
    const showCached = document.getElementById('mapCachedSwitch')?.checked || false;

    // Device contacts filtered by type
    const deviceKeySet = new Set(allContactsWithGps.map(c => c.public_key));
    const filteredContacts = allContactsWithGps.filter(c => selectedTypes.includes(c.type));

    // Cache-only contacts (not on device) filtered by type
    const TYPE_LABEL_TO_NUM = { 'COM': 1, 'REP': 2, 'ROOM': 3, 'SENS': 4 };
    let cachedFiltered = [];
    if (showCached) {
        cachedFiltered = allCachedContactsWithGps
            .filter(c => !deviceKeySet.has(c.public_key))
            .filter(c => {
                const typeNum = TYPE_LABEL_TO_NUM[c.type_label];
                return typeNum ? selectedTypes.includes(typeNum) : false;
            });
    }

    const allFiltered = [...filteredContacts, ...cachedFiltered];

    if (allFiltered.length === 0) {
        leafletMap.setView([52.0, 19.0], 6);
        return;
    }

    const bounds = [];

    // Add own device marker (star shape, distinct from contacts)
    if (_selfInfo && _selfInfo.adv_lat && _selfInfo.adv_lon && (_selfInfo.adv_lat !== 0 || _selfInfo.adv_lon !== 0)) {
        const ownIcon = L.divIcon({
            html: '<i class="bi bi-star-fill" style="color: #dc3545; font-size: 20px; text-shadow: 0 0 3px #fff;"></i>',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
            className: 'own-device-marker'
        });
        L.marker([_selfInfo.adv_lat, _selfInfo.adv_lon], { icon: ownIcon })
            .addTo(markersGroup)
            .bindPopup(`<b>${_selfInfo.name || t('map.this_device')}</b><br><span class="text-muted">${tHtml('map.own_device')}</span>`);
        bounds.push([_selfInfo.adv_lat, _selfInfo.adv_lon]);
    }

    filteredContacts.forEach(c => {
        const color = CONTACT_TYPE_COLORS[c.type] || '#2196F3';
        const typeName = CONTACT_TYPE_NAMES[c.type] || t('common.unknown');
        const lastSeen = c.last_advert ? formatTimeAgo(c.last_advert) : '';

        L.circleMarker([c.adv_lat, c.adv_lon], {
            radius: 10,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        })
            .addTo(markersGroup)
            .bindPopup(`<b>${c.name}</b><br><span class="text-muted">${typeName}</span>${lastSeen ? `<br><small class="text-muted">${tHtml('repeaters.map.last_seen', { time: lastSeen })}</small>` : ''}`);

        bounds.push([c.adv_lat, c.adv_lon]);
    });

    cachedFiltered.forEach(c => {
        const typeNum = TYPE_LABEL_TO_NUM[c.type_label] || 1;
        const color = CONTACT_TYPE_COLORS[typeNum] || '#2196F3';
        const lastSeen = c.last_advert ? formatTimeAgo(c.last_advert) : '';

        L.circleMarker([c.adv_lat, c.adv_lon], {
            radius: 8,
            fillColor: color,
            color: '#999',
            weight: 1,
            opacity: 0.8,
            fillOpacity: 0.5
        })
            .addTo(markersGroup)
            .bindPopup(`<b>${c.name}</b><br><span class="text-muted">${tHtml('map.cached_label', { type: c.type_label || t('map.cache') })}</span>${lastSeen ? `<br><small class="text-muted">${tHtml('repeaters.map.last_seen', { time: lastSeen })}</small>` : ''}`);

        bounds.push([c.adv_lat, c.adv_lon]);
    });

    if (bounds.length === 1) {
        leafletMap.setView(bounds[0], 13);
    } else if (bounds.length > 1) {
        leafletMap.fitBounds(bounds, { padding: [20, 20] });
    }
}

/**
 * Show all contacts with GPS on map
 */
async function showAllContactsOnMap() {
    const modalEl = document.getElementById('mapModal');
    const modal = new bootstrap.Modal(modalEl);
    document.getElementById('mapModalTitle').textContent = t('map.all_contacts');

    // Show type filter panel
    const filterPanel = document.getElementById('mapTypeFilter');
    if (filterPanel) filterPanel.classList.remove('d-none');

    const onShown = async function() {
        initLeafletMap();
        markersGroup.clearLayers();

        try {
            // Fetch device info, device contacts, and cached contacts in parallel
            const [deviceInfoResp, deviceResp, cachedResp] = await Promise.all([
                fetch('/api/device/info'),
                fetch('/api/contacts/detailed'),
                fetch('/api/contacts/cached?format=full')
            ]);
            const deviceInfoData = await deviceInfoResp.json();
            const deviceData = await deviceResp.json();
            const cachedData = await cachedResp.json();

            // Use self info for own device marker
            if (deviceInfoData.success && deviceInfoData.info) {
                _selfInfo = deviceInfoData.info;
            }

            if (deviceData.success && deviceData.contacts) {
                allContactsWithGps = deviceData.contacts.filter(c =>
                    c.adv_lat && c.adv_lon && (c.adv_lat !== 0 || c.adv_lon !== 0)
                );
            }

            if (cachedData.success && cachedData.contacts) {
                allCachedContactsWithGps = cachedData.contacts.filter(c =>
                    c.adv_lat && c.adv_lon && (c.adv_lat !== 0 || c.adv_lon !== 0)
                );
            }

            updateMapMarkers();
        } catch (err) {
            console.error('Error loading contacts for map:', err);
        }

        leafletMap.invalidateSize();
        modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    // Setup filter badge listeners
    ['mapFilterCOM', 'mapFilterREP', 'mapFilterROOM', 'mapFilterSENS'].forEach(id => {
        const badge = document.getElementById(id);
        if (badge) {
            badge.onclick = () => {
                badge.classList.toggle('active');
                updateMapMarkers();
            };
        }
    });

    // Setup cached switch listener
    const cachedSwitch = document.getElementById('mapCachedSwitch');
    if (cachedSwitch) {
        cachedSwitch.onchange = () => updateMapMarkers();
    }

    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
}

/**
 * Load contacts geo cache for message map buttons
 */
async function loadContactsGeoCache() {
    try {
        // Load detailed (device) and cached contacts in parallel, plus our own
        // device info. The latter used to be fetched only when the map modal
        // opened, which left _selfInfo null on a fresh page — and the share
        // cards need our position at render time to show distance and bearing.
        const [detailedResp, cachedResp, deviceInfoResp] = await Promise.all([
            fetch('/api/contacts/detailed'),
            fetch('/api/contacts/cached?format=full'),
            fetch('/api/device/info')
        ]);
        const detailedData = await detailedResp.json();
        const cachedData = await cachedResp.json();

        // /api/device/info answers 503 while the device is offline — that is not
        // an error here, it just means we cannot offer distances yet.
        if (deviceInfoResp.ok) {
            const deviceInfoData = await deviceInfoResp.json();
            if (deviceInfoData.success && deviceInfoData.info) {
                _selfInfo = deviceInfoData.info;
            }
        }

        contactsGeoCache = {};
        contactsPubkeyMap = {};
        contactsByPubkey = {};

        // Process device contacts
        if (detailedData.success && detailedData.contacts) {
            detailedData.contacts.forEach(c => {
                if (c.adv_lat && c.adv_lon && (c.adv_lat !== 0 || c.adv_lon !== 0)) {
                    contactsGeoCache[c.name] = { lat: c.adv_lat, lon: c.adv_lon };
                }
                if (c.name && c.public_key) {
                    contactsPubkeyMap[c.name] = c.public_key;
                }
                if (c.public_key) {
                    // Everything from /detailed lives in device memory.
                    contactsByPubkey[c.public_key.toLowerCase()] =
                        { name: c.name || '', source: 'device' };
                }
            });
        }

        // Process cached contacts (fills gaps for contacts not on device)
        if (cachedData.success && cachedData.contacts) {
            cachedData.contacts.forEach(c => {
                if (!contactsGeoCache[c.name] && c.adv_lat && c.adv_lon && (c.adv_lat !== 0 || c.adv_lon !== 0)) {
                    contactsGeoCache[c.name] = { lat: c.adv_lat, lon: c.adv_lon };
                }
                if (c.name && c.public_key && !contactsPubkeyMap[c.name]) {
                    contactsPubkeyMap[c.name] = c.public_key;
                }
                // Device entries win: their source decides whether a share card
                // offers "push to device" or reports the contact as already there.
                const pk = (c.public_key || '').toLowerCase();
                if (pk && !contactsByPubkey[pk]) {
                    contactsByPubkey[pk] = { name: c.name || '', source: c.source || 'advert' };
                }
            });
        }

        console.log(`Loaded geo cache for ${Object.keys(contactsGeoCache).length} contacts, pubkey map for ${Object.keys(contactsPubkeyMap).length}`);
    } catch (err) {
        console.error('Error loading contacts geo cache:', err);
    }
}

/* -----------------------------------------------------------------------------
   Share card environment (channel chat)

   message-utils.js renders the cards but knows nothing about this page's state.
   These hooks let it resolve what we already have — so a card says "Already in
   contacts" instead of offering a pointless add — and act on a click.
   The DM iframe installs its own set; see dm.js.
   -------------------------------------------------------------------------- */
window.MCShareHooks = {
    /** @returns {?{name: string, source: string}} */
    lookupContact(pubkey) {
        if (!pubkey) return null;
        return contactsByPubkey[pubkey.toLowerCase()] || null;
    },

    /**
     * Match a shared channel against our slots. The secret is the identity, so
     * it is checked first: the same key under a different name is still the same
     * channel. A name-only match is a conflict, not a match.
     * @returns {?{index: number, name: string, matched: 'secret'|'name'}}
     */
    lookupChannel({ name, secret }) {
        if (!Array.isArray(availableChannels)) return null;

        if (secret) {
            const bySecret = availableChannels.find(
                ch => (ch.key || '').toLowerCase() === secret.toLowerCase());
            if (bySecret) {
                return { index: bySecret.index, name: bySecret.name, matched: 'secret' };
            }
        }

        const byName = availableChannels.find(
            ch => (ch.name || '').toLowerCase() === (name || '').toLowerCase());
        if (byName) {
            // Hashtag channels derive their key from the name, so an equal name
            // with no shared secret is the same channel, not a collision.
            const matched = (!secret && MCShare.channelKindOf(name) === 'hashtag')
                ? 'secret' : 'name';
            return { index: byName.index, name: byName.name, matched };
        }
        return null;
    },

    /** Our own advertised position, or null when unset (firmware reports 0,0). */
    selfPosition() {
        if (!_selfInfo) return null;
        const lat = _selfInfo.adv_lat;
        const lon = _selfInfo.adv_lon;
        if (!MCShare.isValidLatLon(lat, lon)) return null;
        return { lat, lon };
    },

    openMap(label, lat, lon) {
        showContactOnMap(label, lat, lon);
    },

    onContactsChanged() {
        loadContactsGeoCache();
    },

    async onChannelJoined(channel, name) {
        await loadChannels();
        if (channel && typeof channel.index === 'number') {
            switchToChannel(channel.index, name);
        }
    },

    /**
     * Carry a shared channel's region scope over to our own mapping. Without
     * it we would transmit on that channel using the firmware default scope and
     * our packets would not match the sender's.
     *
     * The URI names a region ("#pl"); scopes are stored by region id, so the
     * name has to exist in the local registry. It often will not — the registry
     * starts empty — and inventing a region would mean inventing its 16-byte
     * scope key, which we cannot derive. So we tell the user instead.
     */
    async applyChannelScope(channel, scope) {
        if (!channel || typeof channel.index !== 'number' || !scope) return;
        const wanted = scope.replace(/^#/, '').toLowerCase();

        try {
            const resp = await fetch('/api/regions');
            const data = await resp.json();
            const regions = (data.success && data.regions) || [];
            const region = regions.find(
                r => (r.name || '').replace(/^#/, '').toLowerCase() === wanted);

            if (!region) {
                showNotification(t('share.toast.scope_unknown', { name: wanted }), 'warning');
                return;
            }

            const put = await fetch(`/api/channels/${channel.index}/scope`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ region_id: region.id })
            });
            const putData = await put.json();
            if (putData.success) {
                showNotification(t('share.toast.scope_applied', { name: region.name }), 'success');
            } else {
                showNotification(putData.error || t('share.toast.action_failed'), 'danger');
            }
        } catch (e) {
            console.error('Error applying shared region scope:', e);
            showNotification(t('share.toast.action_failed'), 'danger');
        }
    }
};

async function loadBlockedNames() {
    try {
        const resp = await fetch('/api/contacts/blocked-names');
        const data = await resp.json();
        if (data.success) {
            blockedContactNames = new Set(data.names);
        }
    } catch (err) {
        console.error('Error loading blocked names:', err);
    }
}

async function loadProtectedPubkeys() {
    try {
        const resp = await fetch('/api/contacts/protected');
        const data = await resp.json();
        if (data.success) {
            protectedContactPubkeys = new Set((data.protected_contacts || []).map(pk => pk.toLowerCase()));
        }
    } catch (err) {
        console.error('Error loading protected contacts:', err);
    }
}

function isContactProtectedByName(senderName) {
    const pubkey = contactsPubkeyMap[senderName];
    return pubkey && protectedContactPubkeys.has(pubkey.toLowerCase());
}

// =============================================================================
// Resync after a gap
//
// The chat view is push-driven: messages arrive over the socket and are
// appended one at a time. Whatever the socket misses - Android doze tearing the
// connection down behind a locked screen, a switch between Wi-Fi and mobile -
// is never drawn, and the list silently stops at the last message that got
// through. A browser tab hides this because it reloads the page on resume; the
// Android wrapper keeps the same page alive for days, so the gap stays until
// the app is force-stopped.
//
// So every way back from a gap ends up here: the socket reconnecting, the page
// becoming visible, the heartbeat noticing it was frozen, the Refresh menu
// item, and the wrapper's onResume hook.
// =============================================================================

let chatSocketEverConnected = false;
let resyncInFlight = false;

/** Re-read the message list and badges from the server. */
async function resyncFromServer(reason, { toast = false } = {}) {
    if (resyncInFlight) return;
    resyncInFlight = true;
    console.log(`[resync] refreshing after ${reason}`);
    try {
        // The archive view is a frozen snapshot of one day - reloading it would
        // fight the date the user picked. Its badges still need updating.
        if (!currentArchiveDate) await loadMessages();
        await checkForUpdates();
        loadStatus();
        updatePendingContactsBadge();
        checkDmUpdates();
        if (toast) showNotification(t('chat.toast.refreshed'), 'success');
    } catch (error) {
        console.error('[resync] failed:', error);
        if (toast) showNotification(t('chat.toast.refresh_failed'), 'danger');
    } finally {
        resyncInFlight = false;
    }
}

/**
 * Heartbeat that catches the cases no event announces.
 *
 * A tick arriving far later than scheduled means the page was frozen or
 * throttled - precisely the window in which socket events go missing - so the
 * gap is worth a resync even if the socket claims it never dropped. The same
 * tick nudges a socket still stuck in its reconnect backoff.
 */
function startResyncHeartbeat() {
    const TICK_MS = 20000;
    let lastTickAt = Date.now();

    setInterval(() => {
        const now = Date.now();
        const drift = now - lastTickAt;
        lastTickAt = now;

        if (document.hidden) return;  // visibilitychange covers the way back

        if (drift > TICK_MS * 3) {
            resyncFromServer('timer gap');
            return;
        }
        // connect() during backoff simply retries now instead of later; the
        // 'connect' handler then does the resync
        if (chatSocket && !chatSocket.connected) chatSocket.connect();
    }, TICK_MS);
}

/**
 * Called by the Android wrapper from onResume. The WebView is not guaranteed
 * to fire visibilitychange for an Activity coming back to the foreground, so
 * the wrapper says so itself.
 */
window.__mcAppResumed = function() {
    if (chatSocket && !chatSocket.connected) chatSocket.connect();
    resyncFromServer('app resumed');
};

// Initialize on page load
/**
 * Connect to SocketIO /chat namespace for real-time message updates
 */
function connectChatSocket() {
    if (typeof io === 'undefined') {
        console.warn('SocketIO not available, falling back to polling only');
        return;
    }

    const wsUrl = window.location.origin;
    // Default transports (polling, then upgrade to websocket). Long-polling was
    // pinned in 1d47c9c because werkzeug had no websocket support; python-engineio
    // 4.8.1 pulled in simple-websocket and it does now. Polling holds an HTTP
    // connection open per tab, and browsers only allow six per origin, so three
    // tabs starved every other request of a connection for tens of seconds.
    // Upgrading moves that connection out of the HTTP pool. Where the upgrade is
    // blocked (a proxy that drops Upgrade), the client stays on polling by itself.
    chatSocket = io(wsUrl + '/chat', {
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
    });

    chatSocket.on('connect', () => {
        console.log('SocketIO connected to /chat');
        // Everything pushed while the socket was down is gone for good - only a
        // re-read of the list brings those messages back. Skipped on the very
        // first connect, where DOMContentLoaded has just loaded them anyway.
        if (chatSocketEverConnected) resyncFromServer('socket reconnect');
        chatSocketEverConnected = true;
    });

    chatSocket.on('disconnect', (reason) => {
        console.warn('SocketIO /chat disconnected:', reason);
    });

    chatSocket.on('connect_error', (err) => {
        console.error('SocketIO /chat connect error:', err.message);
    });

    // Real-time new channel message
    chatSocket.on('new_message', (data) => {
        // Filter blocked contacts in real-time
        if (data.type === 'channel' && blockedContactNames.has(data.sender)) return;
        if (data.type === 'dm' && blockedContactNames.has(data.sender)) return;

        if (data.type === 'channel') {
            // Update last-message preview/time for this channel (for sidebar/dropdown)
            if (typeof data.content === 'string' && typeof data.timestamp === 'number') {
                channelLastMessages[data.channel_idx] = {
                    preview: makeChannelPreview(data.content),
                    timestamp: data.timestamp
                };
            }
            // Reorder: move this channel to the top of its tier in sidebar + dropdown
            moveChannelToTopOfTier(data.channel_idx);
            // Update unread count for this channel
            if (data.channel_idx !== currentChannelIdx) {
                unreadCounts[data.channel_idx] = (unreadCounts[data.channel_idx] || 0) + 1;
                updateUnreadBadges();
                checkAndNotify();
            } else if (!currentArchiveDate) {
                // Refresh sidebar preview even for the active channel
                updateChannelSidebarBadges();
                // Skip own messages — already appended optimistically on send
                if (data.is_own) return;
                // Current channel and live view — append message directly (no full reload)
                appendMessageFromSocket(data);
            }
        } else if (data.type === 'dm') {
            // Update DM badge on main page
            checkDmUpdates();
        }
    });

    // Real-time echo data — update metadata for specific messages (no full reload)
    let echoRefreshTimer = null;
    const targetedRefreshIds = new Set();   // msg_ids that must bypass the "already has route" skip
    chatSocket.on('echo', (data) => {
        if (currentArchiveDate) return;  // Don't refresh archive view
        // When the backend tags the echo with a specific msg_id (e.g. echoes
        // arriving after a resend), record it so the debounced refresh
        // re-fetches that message's meta even if its badge is already drawn.
        if (data && typeof data.msg_id === 'number') {
            targetedRefreshIds.add(data.msg_id);
        }
        // Debounce: wait for echoes to settle, then update affected messages
        if (echoRefreshTimer) clearTimeout(echoRefreshTimer);
        echoRefreshTimer = setTimeout(() => {
            echoRefreshTimer = null;
            const ids = Array.from(targetedRefreshIds);
            targetedRefreshIds.clear();
            refreshMessagesMeta(ids);
        }, 2000);
    });

    // Real-time pending contact — update badge (unless suppressed by user setting)
    chatSocket.on('pending_contact', () => {
        if (window.contactsSettings?.suppress_advert_notifications) return;
        updatePendingContactsBadge();
    });

    // Real-time device status
    chatSocket.on('device_status', (data) => {
        updateStatus(data.connected ? 'connected' : 'disconnected');
    });

    // Observer live status (Settings > Observer tab badges + counters)
    chatSocket.on('observer_status', (data) => {
        applyObserverLiveStatus(data || {});
    });
}

document.addEventListener('DOMContentLoaded', async function() {
    console.log('mc-webui initialized');
    const initStart = performance.now();

    // Force viewport recalculation on PWA navigation
    // This fixes the bottom bar visibility issue when navigating from other pages
    window.scrollTo(0, 0);
    // Trigger resize event to force browser to recalculate viewport height
    window.dispatchEvent(new Event('resize'));
    // Force reflow to ensure proper layout calculation
    document.body.offsetHeight;

    // Restore last selected channel from localStorage (sync, fast)
    const savedChannel = localStorage.getItem('mc_active_channel');
    if (savedChannel !== null) {
        currentChannelIdx = parseInt(savedChannel);
    }

    // Setup event listeners and emoji picker early (sync, fast)
    setupEventListeners();
    setupEmojiPicker();

    // OPTIMIZATION: Load timestamps in parallel (both are independent API calls)
    console.log('[init] Loading timestamps in parallel...');
    await Promise.all([
        loadLastSeenTimestampsFromServer(),
        loadDmLastSeenTimestampsFromServer()
    ]);

    // Load channels (required before loading messages)
    // NOTE: checkForUpdates() was removed from loadChannels() to speed up init
    console.log('[init] Loading channels...');
    await loadChannels();
    loadChannelScopes();  // non-blocking, populates status-bar region pill

    // OPTIMIZATION: Load messages immediately, don't wait for geo cache
    // Map buttons will appear once geo cache loads (non-blocking UX improvement)
    console.log('[init] Loading messages (priority) and geo cache (background)...');

    // Start these in parallel - messages are critical, geo cache can load async
    const messagesPromise = loadMessages();
    const geoCachePromise = loadContactsGeoCache();  // Non-blocking, Map buttons update when ready
    const blockedPromise = loadBlockedNames();  // Non-blocking, for real-time filtering
    const protectedPromise = loadProtectedPubkeys();  // Non-blocking, for disabling ignore/block on protected

    // Also start archive list loading in parallel
    loadArchiveList();

    // Wait for messages to display (this is what the user wants to see ASAP)
    await messagesPromise;

    console.log(`[init] Messages loaded in ${(performance.now() - initStart).toFixed(0)}ms`);

    // Initial badge updates (fast, sync-ish)
    updatePendingContactsBadge();
    loadStatus();
    // Re-poll periodically as a fallback to the 'device_status' socket push —
    // a missed/late socket event would otherwise leave the badge stale
    // indefinitely on a long-lived tab.
    setInterval(loadStatus, 60000);

    // Map button in menu
    const mapBtn = document.getElementById('mapBtn');
    if (mapBtn) {
        mapBtn.addEventListener('click', () => {
            // Close offcanvas first
            const offcanvas = bootstrap.Offcanvas.getInstance(document.getElementById('mainMenu'));
            if (offcanvas) offcanvas.hide();
            showAllContactsOnMap();
        });
    }

    // Update notification toggle UI
    updateNotificationToggleUI();

    // Initialize filter functionality
    initializeFilter();

    // Apply Quick Access / Main Menu placements before FAB init so visibility is set early
    applyItemPlacements();
    initializeItemPlacementSettings();

    // Sidebar breakpoint: re-apply (covers no-localStorage case) and wire up settings UI + resize listener
    applySidebarBreakpoint();
    initializeSidebarBreakpointSettings();

    // Initialize FAB toggle
    initializeFabToggle();

    // Connect SocketIO for real-time updates
    connectChatSocket();
    // Safety net for the updates the socket never delivered
    startResyncHeartbeat();

    console.log(`[init] UI ready in ${(performance.now() - initStart).toFixed(0)}ms`);

    // DEFERRED: Check for updates AFTER messages are displayed
    // This updates the unread badges without blocking initial load
    checkForUpdates();  // No await - runs in background

    // Geo cache loads in background - once loaded, re-render messages to show Map buttons
    geoCachePromise.then(() => {
        console.log(`[init] Geo cache loaded in ${(performance.now() - initStart).toFixed(0)}ms, refreshing messages for Map buttons`);
        // Re-render messages now that geo cache is available (Map buttons will appear)
        loadMessages();
    });
});

// Handle page restoration from cache (PWA back/forward navigation)
window.addEventListener('pageshow', function(event) {
    if (event.persisted) {
        // Page was restored from cache, force viewport recalculation
        console.log('Page restored from cache, recalculating viewport');
        window.scrollTo(0, 0);
        window.dispatchEvent(new Event('resize'));
        document.body.offsetHeight;
    }
});

// Handle app returning from background (PWA visibility change)
let hiddenSince = null;
document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
        hiddenSince = Date.now();
        return;
    }

    // App became visible again, force viewport recalculation
    console.log('App became visible, recalculating viewport');
    setTimeout(() => {
        window.scrollTo(0, 0);
        window.dispatchEvent(new Event('resize'));
        document.body.offsetHeight;
    }, 100);

    // Clear app badge when user returns to app
    if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch((error) => {
            console.error('Error clearing app badge on visibility:', error);
        });
    }

    // Anything longer than a glance away is long enough for the socket to have
    // dropped messages, so catch up before the user reads a stale list
    const away = hiddenSince ? Date.now() - hiddenSince : 0;
    hiddenSince = null;
    if (chatSocket && !chatSocket.connected) chatSocket.connect();
    if (away > 10000) resyncFromServer('back from background');
});

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Send message form
    const form = document.getElementById('sendMessageForm');
    const input = document.getElementById('messageInput');

    form.addEventListener('submit', function(e) {
        e.preventDefault();
        sendMessage();
    });

    // Handle Enter key (send) vs Shift+Enter (new line) - desktop only.
    // Touch devices send via the button so an accidental Enter on the virtual
    // keyboard doesn't fire a half-typed message.
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey && !isTouchPrimaryDevice()) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Character counter
    input.addEventListener('input', function() {
        updateCharCounter();
    });

    // Setup mentions autocomplete
    setupMentionsAutocomplete();

    // Check for app updates button
    const checkUpdateBtn = document.getElementById('checkUpdateBtn');
    if (checkUpdateBtn) {
        checkUpdateBtn.addEventListener('click', async function() {
            await checkForAppUpdates();
        });
    }

    // Date selector (archive selection)
    document.getElementById('dateSelector').addEventListener('change', function(e) {
        currentArchiveDate = e.target.value || null;
        loadMessages();

        // Close offcanvas menu after selecting date
        const offcanvas = bootstrap.Offcanvas.getInstance(document.getElementById('mainMenu'));
        if (offcanvas) {
            offcanvas.hide();
        }
    });

    // Cleanup contacts button (only exists on contact management page)
    const cleanupBtn = document.getElementById('cleanupBtn');
    if (cleanupBtn) {
        cleanupBtn.addEventListener('click', function() {
            cleanupContacts();
        });
    }

    // Track user scrolling and show/hide scroll-to-bottom button
    const container = document.getElementById('messagesContainer');
    const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');
    container.addEventListener('scroll', function() {
        const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 100;
        isUserScrolling = !isAtBottom;

        // Show/hide scroll-to-bottom button
        if (scrollToBottomBtn) {
            if (isAtBottom) {
                scrollToBottomBtn.classList.remove('visible');
            } else {
                scrollToBottomBtn.classList.add('visible');
            }
        }
    });

    // Scroll-to-bottom button click handler
    if (scrollToBottomBtn) {
        scrollToBottomBtn.addEventListener('click', function() {
            scrollToBottom();
            scrollToBottomBtn.classList.remove('visible');
        });
    }

    // Load device info when modal opens
    const deviceInfoModal = document.getElementById('deviceInfoModal');
    deviceInfoModal.addEventListener('show.bs.modal', function() {
        loadDeviceInfo();
    });

    // Channel selector (button + dropdown, visible on narrow screens)
    const channelButton = document.getElementById('channelSelectorButton');
    const channelDropdown = document.getElementById('channelSelectorDropdown');
    const channelWrapper = document.getElementById('channelSelectorWrapper');

    if (channelButton && channelDropdown) {
        channelButton.addEventListener('click', () => {
            if (channelDropdown.style.display === 'none') {
                renderChannelDropdownItems();
                setChannelDropdownOpen(true);
            } else {
                setChannelDropdownOpen(false);
            }
        });

        // Prevent dropdown mousedown from stealing focus/closing dropdown
        channelDropdown.addEventListener('mousedown', (e) => {
            e.preventDefault();
        });

        // Close dropdown when clicking outside the wrapper
        document.addEventListener('mousedown', (e) => {
            if (channelWrapper && !channelWrapper.contains(e.target)) {
                setChannelDropdownOpen(false);
            }
        });

        channelButton.addEventListener('keydown', (e) => {
            // Closed: leave Enter/Space alone so they open the dropdown as a
            // plain button activation.
            if (channelDropdown.style.display === 'none') return;

            if (e.key === 'Escape') {
                setChannelDropdownOpen(false);
                channelButton.blur();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const active = channelDropdown.querySelector('.channel-selector-item.active[data-channel-idx]');
                const target = active || channelDropdown.querySelector('.channel-selector-item[data-channel-idx]');
                if (target) target.click();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const items = Array.from(channelDropdown.querySelectorAll('.channel-selector-item[data-channel-idx]'));
                if (items.length === 0) return;
                const activeIdx = items.findIndex(el => el.classList.contains('active'));
                items.forEach(el => el.classList.remove('active'));
                let nextIdx;
                if (e.key === 'ArrowDown') {
                    nextIdx = activeIdx < 0 ? 0 : Math.min(activeIdx + 1, items.length - 1);
                } else {
                    nextIdx = activeIdx <= 0 ? 0 : activeIdx - 1;
                }
                items[nextIdx].classList.add('active');
                items[nextIdx].scrollIntoView({ block: 'nearest' });
            }
        });
    }

    // Channels modal - load channels when opened
    const channelsModal = document.getElementById('channelsModal');
    channelsModal.addEventListener('show.bs.modal', function() {
        loadChannelsList();
    });

    // Create channel form
    document.getElementById('createChannelForm').addEventListener('submit', async function(e) {
        e.preventDefault();

        const submitBtn = this.querySelector('button[type="submit"]');
        if (submitBtn && submitBtn.disabled) return;  // in-flight guard

        const name = document.getElementById('newChannelName').value.trim();

        if (submitBtn) submitBtn.disabled = true;
        try {
            const response = await fetch('/api/channels', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: name })
            });

            const data = await response.json();

            if (data.success) {
                const msg = data.already_existed
                    ? t('channels.toast.exists', { name })
                    : t('channels.toast.created', { name });
                showNotification(msg, data.already_existed ? 'info' : 'success');

                // Show warning if returned (e.g., exceeding soft limit of 7 channels)
                if (data.warning) {
                    setTimeout(() => {
                        showNotification(data.warning, 'warning');
                    }, 2000);  // Show after success message
                }

                document.getElementById('newChannelName').value = '';
                document.getElementById('addChannelForm').classList.remove('show');

                // Reload channels
                await loadChannels();
                loadChannelsList();
            } else {
                showNotification(t('channels.toast.create_failed', { error: data.error }), 'danger');
            }
        } catch (error) {
            showNotification(t('channels.toast.create_error'), 'danger');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });

    // Join channel form
    document.getElementById('joinChannelFormSubmit').addEventListener('submit', async function(e) {
        e.preventDefault();

        const submitBtn = this.querySelector('button[type="submit"]');
        if (submitBtn && submitBtn.disabled) return;  // in-flight guard

        const name = document.getElementById('joinChannelName').value.trim();
        const key = document.getElementById('joinChannelKey').value.trim().toLowerCase();

        // Validate: key is optional for channels starting with #, but required for others
        if (!name.startsWith('#') && !key) {
            showNotification(t('channels.toast.key_required'), 'warning');
            return;
        }

        // Validate key format if provided
        if (key && !/^[a-f0-9]{32}$/.test(key)) {
            showNotification(t('channels.toast.key_invalid'), 'warning');
            return;
        }

        if (submitBtn) submitBtn.disabled = true;
        try {
            const payload = { name: name };
            if (key) {
                payload.key = key;
            }

            const response = await fetch('/api/channels/join', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (data.success) {
                const msg = data.already_existed
                    ? t('channels.toast.already_joined', { name })
                    : t('channels.toast.joined', { name });
                showNotification(msg, data.already_existed ? 'info' : 'success');

                // Show warning if returned (e.g., exceeding soft limit of 7 channels)
                if (data.warning) {
                    setTimeout(() => {
                        showNotification(data.warning, 'warning');
                    }, 2000);  // Show after success message
                }

                document.getElementById('joinChannelName').value = '';
                document.getElementById('joinChannelKey').value = '';
                document.getElementById('joinChannelForm').classList.remove('show');

                // Reload channels
                await loadChannels();
                loadChannelsList();
            } else {
                showNotification(t('channels.toast.join_failed', { error: data.error }), 'danger');
            }
        } catch (error) {
            showNotification(t('channels.toast.join_error'), 'danger');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });

    // Scan QR button (placeholder)
    document.getElementById('scanQRBtn').addEventListener('click', function() {
        showNotification(t('channels.toast.qr_soon'), 'info');
    });

    // Network Commands: Advert button
    document.getElementById('advertBtn').addEventListener('click', async function() {
        await executeSpecialCommand('advert');
    });

    // Network Commands: Flood Advert button (with confirmation)
    document.getElementById('floodadvBtn').addEventListener('click', async function() {
        if (!confirm(t('menu.confirm.flood_advert'))) {
            return;
        }
        await executeSpecialCommand('floodadv');
    });

    // FAB equivalents for menu actions (visible only when item placement = "fab")
    document.getElementById('fab-advert')?.addEventListener('click', async () => {
        await executeSpecialCommand('advert');
    });
    document.getElementById('fab-floodadvert')?.addEventListener('click', async () => {
        if (!confirm(t('menu.confirm.flood_advert'))) {
            return;
        }
        await executeSpecialCommand('floodadv');
    });
    document.getElementById('fab-map')?.addEventListener('click', () => {
        showAllContactsOnMap();
    });

    // Menu equivalent for filter FAB: close offcanvas first, then open filter bar
    document.getElementById('menu-filter')?.addEventListener('click', () => {
        const oc = document.getElementById('mainMenu');
        const inst = bootstrap.Offcanvas.getInstance(oc) || bootstrap.Offcanvas.getOrCreateInstance(oc);
        oc.addEventListener('hidden.bs.offcanvas', () => openFilterBar(), { once: true });
        inst.hide();
    });

    // Manual refresh from the menu
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            if (chatSocket && !chatSocket.connected) chatSocket.connect();
            resyncFromServer('manual refresh', { toast: true });
        });
    }

    // Notification toggle
    const notificationsToggle = document.getElementById('notificationsToggle');
    if (notificationsToggle) {
        notificationsToggle.addEventListener('click', handleNotificationToggle);
    }
}

/**
 * Load messages from API
 */
async function loadMessages() {
    try {
        // Build URL with appropriate parameters
        let url = '/api/messages?limit=500';

        // Add channel filter
        url += `&channel_idx=${currentChannelIdx}`;

        if (currentArchiveDate) {
            // Loading archive
            url += `&archive_date=${currentArchiveDate}`;
        } else {
            // Loading live messages - show last 7 days only
            url += '&days=7';
        }

        // Add timeout to prevent hanging spinner
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await response.json();

        if (data.success) {
            displayMessages(data.messages);
            updateLastRefresh();
            updateRegionIndicator();
        } else {
            showNotification(t('chat.toast.load_error', { error: data.error }), 'danger');
            clearLoadingSpinner();
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        updateStatus('disconnected');
        clearLoadingSpinner();
        if (error.name === 'AbortError') {
            showNotification(t('chat.toast.load_timeout'), 'warning');
            setTimeout(loadMessages, 2000);
        } else {
            showNotification(t('chat.toast.load_failed'), 'danger');
        }
    }
}

function clearLoadingSpinner() {
    const container = document.getElementById('messagesList');
    if (container && container.querySelector('.spinner-border')) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="bi bi-exclamation-triangle"></i>
                <p>${tHtml('chat.error.load_title')}</p>
                <small>${tHtml('chat.error.load_retry')}</small>
            </div>
        `;
    }
}

/**
 * Display messages in the UI
 */
function displayMessages(messages) {
    const container = document.getElementById('messagesList');
    const wasAtBottom = !isUserScrolling;

    // Freeze the unread boundary on channel entry (see unreadAnchorTs).
    if (currentArchiveDate) {
        // Archive is a frozen snapshot of one day — "new since last visit"
        // means nothing there.
        unreadAnchorTs = null;
    } else if (renderedChannelIdx !== currentChannelIdx) {
        const lastSeen = lastSeenTimestamps[currentChannelIdx] || 0;
        // 0 = never visited; every message would be "new", which is noise.
        unreadAnchorTs = lastSeen > 0 ? lastSeen : null;
    }
    renderedChannelIdx = currentArchiveDate ? null : currentChannelIdx;

    // Clear loading spinner
    container.innerHTML = '';

    if (messages.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="bi bi-chat-dots"></i>
                <p>${tHtml('chat.empty.no_messages')}</p>
                <small>${tHtml('chat.empty.no_messages_hint')}</small>
            </div>
        `;
        return;
    }

    // Render each message (skip blocked senders client-side as extra safety),
    // inserting the "New messages" divider before the first unread one.
    let dividerEl = null;
    messages.forEach(msg => {
        if (!msg.is_own && blockedContactNames.has(msg.sender)) return;
        // Own messages can't be the first unread one — we wrote them.
        if (!dividerEl && unreadAnchorTs !== null && !msg.is_own
            && msg.timestamp > unreadAnchorTs) {
            dividerEl = createUnreadDivider();
            container.appendChild(dividerEl);
        }
        const messageEl = createMessageElement(msg);
        container.appendChild(messageEl);
    });

    // Auto-scroll if user wasn't scrolling: to the divider when there is a
    // backlog to catch up on, otherwise to the bottom as before.
    if (wasAtBottom) {
        // A divider in first position means everything loaded is unread — the
        // list already starts there, and scrolling would falsely suggest there
        // is history above it.
        if (dividerEl && dividerEl !== container.firstElementChild) {
            requestAnimationFrame(scrollToUnreadDivider);
        } else {
            scrollToBottom();
        }
    }

    lastMessageCount = messages.length;

    // Mark current channel as read (update last seen timestamp to latest message)
    if (messages.length > 0 && !currentArchiveDate) {
        const latestTimestamp = Math.max(...messages.map(m => m.timestamp));
        markChannelAsRead(currentChannelIdx, latestTimestamp);
    }

    // Backfill raw-resend buttons on own messages — handles the case where
    // displayMessages ran before window.deviceCaps was populated (initial
    // page load race), and the channel-switch case where createMessageElement
    // does render the button but we want belt-and-suspenders for any path
    // (e.g. archive view) that might bypass it.
    injectRawResendButtonsForVisibleMessages();

    // Re-apply filter if active
    clearFilterState();
}

/**
 * Append a single message from SocketIO event (no full reload).
 * Removes the "empty state" placeholder if present.
 */
function appendMessageFromSocket(data) {
    const container = document.getElementById('messagesList');

    // Remove empty-state placeholder if present
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    // Build a msg object compatible with createMessageElement
    const msg = {
        id: data.id || null,
        sender: data.sender || '',
        content: data.content || '',
        timestamp: data.timestamp || Math.floor(Date.now() / 1000),
        is_own: !!data.is_own,
        channel_idx: data.channel_idx,
        snr: data.snr ?? null,
        path_len: data.path_len ?? null,
        hop_count: data.hop_count ?? null,
        path_hash_size: data.path_hash_size ?? 1,
        echo_paths: [],
        echo_snrs: [],
        echo_hash_sizes: [],
        packet_hash: data.packet_hash || null,
        pkt_payload: data.pkt_payload || null,
        txt_type: data.txt_type || 0,
    };

    const messageEl = createMessageElement(msg);
    container.appendChild(messageEl);

    // Auto-scroll to bottom if user wasn't scrolling up
    if (!isUserScrolling) {
        scrollToBottom();
    }

    // Update last message count and read status
    lastMessageCount++;
    markChannelAsRead(currentChannelIdx, msg.timestamp);
}

// Cap on ids per /api/messages/meta request, to keep the query string short.
const META_BATCH_SIZE = 200;

/**
 * Refresh metadata (SNR, hops, route, analyzer) for messages missing it.
 *
 * Every echo triggers a sweep of the whole rendered list, and messages that
 * never gain a route (no repeaters heard them) never stop qualifying — so this
 * must stay cheap. Ids are collected first and resolved with batched
 * /api/messages/meta calls; one request per message used to flood the
 * single-threaded server and hang the UI.
 */
async function refreshMessagesMeta(forceIds = []) {
    const container = document.getElementById('messagesList');
    if (!container) return;

    const forced = new Set((forceIds || []).map(String));

    // Collect message wrappers that don't have full metadata yet
    const pending = new Map();   // msgId -> wrapper
    const wrappers = container.querySelectorAll('.message-wrapper[data-msg-id]');
    for (const wrapper of wrappers) {
        const msgId = wrapper.dataset.msgId;
        if (!msgId || msgId.startsWith('_pending_')) continue;

        // Skip messages that already have meta info with route/analyzer data,
        // unless this msg_id was explicitly forced (e.g. by post-resend echoes
        // that need the existing badge re-fetched to extend the repeater list).
        if (!forced.has(msgId)) {
            const metaEl = wrapper.querySelector('.message-meta');
            const actionsEl = wrapper.querySelector('.message-actions');
            const hasRoute = metaEl && metaEl.querySelector('.path-info');
            const hasAnalyzer = actionsEl && actionsEl.querySelector('.btn-msg-analyzer');
            if (hasRoute && hasAnalyzer) continue;
        }

        pending.set(msgId, wrapper);
    }
    if (pending.size === 0) return;

    const ids = Array.from(pending.keys());
    for (let i = 0; i < ids.length; i += META_BATCH_SIZE) {
        const chunk = ids.slice(i, i + META_BATCH_SIZE);
        try {
            const resp = await fetch(`/api/messages/meta?ids=${chunk.join(',')}`);
            const data = await resp.json();
            if (!data.success || !data.metas) continue;

            for (const [msgId, meta] of Object.entries(data.metas)) {
                const wrapper = pending.get(msgId);
                if (wrapper && meta.success) updateMessageMetaDOM(wrapper, meta);
            }
        } catch (e) {
            console.error('Error fetching message meta batch:', e);
        }
    }
}

/**
 * Update metadata and action buttons in-place for a single message wrapper.
 */
function updateMessageMetaDOM(wrapper, meta) {
    const isOwn = wrapper.classList.contains('own');

    // Build meta info string
    let metaParts = [];
    const displaySnr = (meta.snr !== undefined && meta.snr !== null) ? meta.snr
        : (meta.echo_snrs && meta.echo_snrs.length > 0) ? meta.echo_snrs[0] : null;
    if (displaySnr !== null) {
        metaParts.push(`SNR: ${displaySnr.toFixed(1)} dB`);
    }
    const hopCount = meta.hop_count ?? (meta.path_len !== null && meta.path_len !== undefined ? (meta.path_len & 0x3F) : null);
    if (hopCount !== null) {
        metaParts.push(tHtml('chat.route_hops', { count: hopCount }));
    }

    // Build paths from echo data
    let paths = null;
    if (meta.echo_paths && meta.echo_paths.length > 0) {
        paths = meta.echo_paths.map((p, i) => ({
            path: p,
            snr: meta.echo_snrs ? meta.echo_snrs[i] : null,
            hash_size: meta.echo_hash_sizes ? meta.echo_hash_sizes[i] : (meta.path_hash_size || 1),
        }));
    }
    if (paths && paths.length > 0) {
        const firstPath = paths[0];
        const chunkLen = (firstPath.hash_size || 1) * 2;
        const segments = [];
        if (firstPath.path) {
            for (let i = 0; i < firstPath.path.length; i += chunkLen) {
                segments.push(firstPath.path.substring(i, i + chunkLen).toUpperCase());
            }
        }
        const shortPath = segments.length > 4
            ? `${segments[0]}\u2192...\u2192${segments[segments.length - 1]}`
            : segments.join('\u2192');
        const pathsData = encodeURIComponent(JSON.stringify(paths));
        const routeText = paths.length > 1
            ? tHtml('chat.route_multi', { count: paths.length, route: shortPath })
            : tHtml('chat.route', { route: shortPath });
        metaParts.push(`<span class="path-info" onclick="showPathsPopup(this, '${pathsData}', '${meta.packet_hash || ''}')">${routeText}</span>`);
    }
    const metaInfo = metaParts.join(' | ');

    if (!isOwn) {
        // Update or insert .message-meta div
        const msgDiv = wrapper.querySelector('.message.other');
        if (!msgDiv) return;
        let metaEl = msgDiv.querySelector('.message-meta');
        if (metaInfo) {
            if (!metaEl) {
                metaEl = document.createElement('div');
                metaEl.className = 'message-meta';
                const actionsEl = msgDiv.querySelector('.message-actions');
                msgDiv.insertBefore(metaEl, actionsEl);
            }
            metaEl.innerHTML = metaInfo;
        }

        // Add analyzer button if not already present
        if (meta.packet_hash) {
            const actionsEl = msgDiv.querySelector('.message-actions');
            if (actionsEl && !actionsEl.querySelector('.btn-msg-analyzer')) {
                const ignoreBtn = actionsEl.querySelector('.btn-msg-ignore');
                const analyzerBtn = document.createElement('button');
                analyzerBtn.className = 'btn btn-outline-secondary btn-msg-action btn-msg-analyzer';
                analyzerBtn.setAttribute('onclick', `openMessageAnalyzer('${meta.packet_hash}')`);
                analyzerBtn.title = t('chat.msg.analyzer_title');
                analyzerBtn.innerHTML = '<i class="bi bi-clipboard-data"></i>';
                actionsEl.insertBefore(analyzerBtn, ignoreBtn);
            }
        }
    } else {
        // Own messages: update echo badge and analyzer button
        const msgDiv = wrapper.querySelector('.message.own');
        if (!msgDiv) return;

        // Update echo badge
        if (meta.echo_paths && meta.echo_paths.length > 0) {
            // For own messages path_hash_size is null — use hash_size from echoes
            const echoHashSize = (meta.echo_hash_sizes && meta.echo_hash_sizes.length > 0)
                ? meta.echo_hash_sizes[0] : (meta.path_hash_size || 1);
            const echoPrefixLen = echoHashSize * 2;
            const echoPaths = [...new Set(meta.echo_paths.map(p => p.substring(0, echoPrefixLen).toUpperCase()))];
            const echoCount = echoPaths.length;
            const pathDisplay = echoPaths.length > 0 ? ` (${echoPaths.join(', ')})` : '';
            const actionsEl = msgDiv.querySelector('.message-actions');
            if (actionsEl) {
                let badge = actionsEl.querySelector('.echo-badge');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'echo-badge';
                    actionsEl.insertBefore(badge, actionsEl.firstChild);
                }
                badge.title = tn('chat.msg.echo_title', echoCount, { paths: echoPaths.join(', ') });
                badge.innerHTML = `<i class="bi bi-broadcast"></i> ${echoCount}${pathDisplay}`;
            }
        }

        // Add analyzer button
        if (meta.packet_hash) {
            const actionsEl = msgDiv.querySelector('.message-actions');
            if (actionsEl && !actionsEl.querySelector('.btn-msg-analyzer')) {
                // Anchor the analyzer button before the edit button. Matched on a
                // class, not on the title: titles are translated, and a title
                // selector would silently miss in every language but English.
                const anchor = actionsEl.querySelector('.btn-msg-edit');
                const analyzerBtn = document.createElement('button');
                analyzerBtn.className = 'btn btn-outline-secondary btn-msg-action btn-msg-analyzer';
                analyzerBtn.setAttribute('onclick', `openMessageAnalyzer('${meta.packet_hash}')`);
                analyzerBtn.title = t('chat.msg.analyzer_title');
                analyzerBtn.innerHTML = '<i class="bi bi-clipboard-data"></i>';
                if (anchor) actionsEl.insertBefore(analyzerBtn, anchor);
                else actionsEl.appendChild(analyzerBtn);
            }
        }

        // Add raw-resend button if supported and missing. The initial render
        // path also injects this, but messages loaded from history before
        // window.deviceCaps was populated by loadStatus get it here on the
        // next echo-driven meta refresh.
        const msgId = wrapper.dataset.msgId;
        if (window.deviceCaps?.supports_raw_resend && msgId) {
            const actionsEl = msgDiv.querySelector('.message-actions');
            if (actionsEl && !actionsEl.querySelector('.btn-raw-resend')) {
                const rawBtn = document.createElement('button');
                rawBtn.className = 'btn btn-outline-secondary btn-msg-action btn-raw-resend';
                rawBtn.setAttribute('onclick', `resendChannelMessageRaw(${msgId}, this)`);
                rawBtn.title = t('chat.msg.raw_resend_title');
                rawBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
                actionsEl.appendChild(rawBtn);
            }
        }
    }
}

/**
 * Create message DOM element
 */
function createMessageElement(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${msg.is_own ? 'own' : 'other'}`;
    if (msg.id) wrapper.dataset.msgId = msg.id;
    // Raw resend reads this back to warn before re-broadcasting an old message
    if (msg.timestamp) wrapper.dataset.timestamp = msg.timestamp;

    const time = formatTime(msg.timestamp);

    // Build paths from echo data if not already present
    if (!msg.paths && msg.echo_paths && msg.echo_paths.length > 0) {
        msg.paths = msg.echo_paths.map((p, i) => ({
            path: p,
            snr: msg.echo_snrs ? msg.echo_snrs[i] : null,
            hash_size: msg.echo_hash_sizes ? msg.echo_hash_sizes[i] : (msg.path_hash_size || 1),
        }));
    }

    let metaParts = [];
    // Use message SNR, or fall back to first echo path SNR
    const displaySnr = (msg.snr !== undefined && msg.snr !== null) ? msg.snr
        : (msg.echo_snrs && msg.echo_snrs.length > 0) ? msg.echo_snrs[0] : null;
    if (displaySnr !== null) {
        metaParts.push(`SNR: ${displaySnr.toFixed(1)} dB`);
    }
    const msgHopCount = msg.hop_count ?? (msg.path_len !== null && msg.path_len !== undefined ? (msg.path_len & 0x3F) : null);
    if (msgHopCount !== null) {
        metaParts.push(tHtml('chat.route_hops', { count: msgHopCount }));
    }
    if (msg.paths && msg.paths.length > 0) {
        // Show first path inline (shortest/first arrival)
        const firstPath = msg.paths[0];
        const chunkLen = (firstPath.hash_size || 1) * 2;
        const segments = [];
        if (firstPath.path) {
            for (let i = 0; i < firstPath.path.length; i += chunkLen) {
                segments.push(firstPath.path.substring(i, i + chunkLen).toUpperCase());
            }
        }
        const shortPath = segments.length > 4
            ? `${segments[0]}\u2192...\u2192${segments[segments.length - 1]}`
            : segments.join('\u2192');
        const pathsData = encodeURIComponent(JSON.stringify(msg.paths));
        const routeText = msg.paths.length > 1
            ? tHtml('chat.route_multi', { count: msg.paths.length, route: shortPath })
            : tHtml('chat.route', { route: shortPath });
        metaParts.push(`<span class="path-info" onclick="showPathsPopup(this, '${pathsData}', '${msg.packet_hash || ''}')">${routeText}</span>`);
    }
    const metaInfo = metaParts.join(' | ');

    if (msg.is_own) {
        // Own messages: right-aligned, no avatar
        // Echo badge shows unique repeaters that heard the message + their path codes
        // For own messages path_hash_size is null — use hash_size from echoes
        const echoHS = (msg.echo_hash_sizes && msg.echo_hash_sizes.length > 0)
            ? msg.echo_hash_sizes[0] : (msg.path_hash_size || 1);
        const echoPrefixLen2 = echoHS * 2;
        const echoPaths = [...new Set((msg.echo_paths || []).map(p => p.substring(0, echoPrefixLen2).toUpperCase()))];
        const echoCount = echoPaths.length;
        const pathDisplay = echoPaths.length > 0 ? ` (${echoPaths.join(', ')})` : '';
        const echoDisplay = echoCount > 0
            ? `<span class="echo-badge" title="${escapeHtml(tn('chat.msg.echo_title', echoCount, { paths: echoPaths.join(', ') }))}">
                 <i class="bi bi-broadcast"></i> ${echoCount}${pathDisplay}
               </span>`
            : '';

        wrapper.innerHTML = `
            <div class="message-container">
                <div class="message-footer own">
                    <span class="message-sender own">${escapeHtml(msg.sender)}</span>
                    <span class="message-time">${time}</span>
                </div>
                <div class="message own">
                    <div class="message-content">${processMessageContent(msg.content, { isOwn: true })}</div>
                    <div class="message-actions justify-content-end">
                        ${echoDisplay}
                        ${msg.packet_hash ? `
                            <button class="btn btn-outline-secondary btn-msg-action btn-msg-analyzer" onclick="openMessageAnalyzer('${msg.packet_hash}')" title="${tHtml('chat.msg.analyzer_title')}">
                                <i class="bi bi-clipboard-data"></i>
                            </button>
                        ` : ''}
                        <button class="btn btn-outline-secondary btn-msg-action btn-msg-edit" onclick='resendMessage(${JSON.stringify(msg.content)})' title="${tHtml('chat.edit_title')}">
                            <i class="bi bi-pencil-square"></i>
                        </button>
                        ${window.deviceCaps?.supports_raw_resend && typeof msg.id === 'number' ? `
                            <button class="btn btn-outline-secondary btn-msg-action btn-raw-resend" onclick="resendChannelMessageRaw(${msg.id}, this)" title="${tHtml('chat.msg.raw_resend_title')}">
                                <i class="bi bi-arrow-repeat"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    } else {
        // Other messages: left-aligned with avatar
        const avatar = generateAvatar(msg.sender);

        const avatarStyle = avatar.isEmoji
            ? `border-color: ${avatar.color};`
            : `background-color: ${avatar.color};`;

        wrapper.innerHTML = `
            <div class="message-avatar${avatar.isEmoji ? ' emoji' : ''}" style="${avatarStyle}">
                ${avatar.content}
            </div>
            <div class="message-container">
                <div class="message-sender-row">
                    <span class="message-sender">${escapeHtml(msg.sender)}</span>
                    <span class="message-time">${time}</span>
                </div>
                <div class="message other">
                    <div class="message-content">${processMessageContent(msg.content, { isOwn: false })}</div>
                    ${metaInfo ? `<div class="message-meta">${metaInfo}</div>` : ''}
                    <div class="message-actions">
                        <button class="btn btn-outline-secondary btn-msg-action" onclick="replyTo('${escapeHtml(msg.sender)}')" title="${tHtml('chat.msg.reply_title')}">
                            <i class="bi bi-reply"></i>
                        </button>
                        <button class="btn btn-outline-secondary btn-msg-action" onclick='quoteTo(${JSON.stringify(msg.sender)}, ${JSON.stringify(msg.content)})' title="${tHtml('chat.msg.quote_title')}">
                            <i class="bi bi-quote"></i>
                        </button>
                        ${contactsGeoCache[msg.sender] ? `
                            <button class="btn btn-outline-secondary btn-msg-action" onclick="showContactOnMap('${escapeHtml(msg.sender)}', ${contactsGeoCache[msg.sender].lat}, ${contactsGeoCache[msg.sender].lon})" title="${tHtml('chat.msg.map_title')}">
                                <i class="bi bi-geo-alt"></i>
                            </button>
                        ` : ''}
                        ${msg.packet_hash ? `
                            <button class="btn btn-outline-secondary btn-msg-action btn-msg-analyzer" onclick="openMessageAnalyzer('${msg.packet_hash}')" title="${tHtml('chat.msg.analyzer_title')}">
                                <i class="bi bi-clipboard-data"></i>
                            </button>
                        ` : ''}
                        ${contactsPubkeyMap[msg.sender] && !isContactProtectedByName(msg.sender) ? `
                            <button class="btn btn-outline-secondary btn-msg-action btn-msg-ignore" onclick="ignoreContactFromChat('${contactsPubkeyMap[msg.sender]}')" title="${tHtml('chat.msg.ignore_title', { name: msg.sender })}">
                                <i class="bi bi-eye-slash"></i>
                            </button>
                        ` : ''}
                        ${!isContactProtectedByName(msg.sender) ? `
                        <button class="btn btn-outline-danger btn-msg-action" onclick="blockContactFromChat('${escapeHtml(msg.sender)}')" title="${tHtml('chat.msg.block_title', { name: msg.sender })}">
                            <i class="bi bi-slash-circle"></i>
                        </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    return wrapper;
}

/**
 * Send a message
 */
async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();

    if (!text) return;

    const sendBtn = document.getElementById('sendBtn');
    sendBtn.disabled = true;

    // Optimistic append: show sent message immediately before API round-trip
    input.value = '';
    updateCharCounter();
    // Sending is an explicit "I'm done catching up" — without this, a user who
    // was parked at the unread divider would send into a part of the list they
    // can't see.
    isUserScrolling = false;
    const optimisticId = '_pending_' + Date.now();
    appendMessageFromSocket({
        id: optimisticId,
        sender: window.MC_CONFIG?.deviceName || 'Me',
        content: text,
        timestamp: Math.floor(Date.now() / 1000),
        is_own: true,
        channel_idx: currentChannelIdx,
    });

    try {
        const response = await fetch('/api/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                channel_idx: currentChannelIdx
            })
        });

        const data = await response.json();

        if (data.success) {
            showNotification(t('chat.toast.sent'), 'success');

            // Replace optimistic ID with real DB id so echo WebSocket updates work
            if (data.id) {
                const wrapper = document.querySelector(`.message-wrapper[data-msg-id="${optimisticId}"]`);
                if (wrapper) {
                    wrapper.dataset.msgId = data.id;
                    // Inject the post-send action buttons (analyzer, raw resend)
                    // now — refreshMessagesMeta would otherwise skip this message
                    // until the first echo arrives, which never happens on
                    // channels with no repeaters in range.
                    refreshMessagesMeta([data.id]);
                }
            }
            // Use server timestamp to prevent poll-triggered reload due to clock skew
            if (data.timestamp) {
                markChannelAsRead(currentChannelIdx, data.timestamp);
            }
        } else {
            showNotification(t('chat.toast.send_failed', { error: data.error }), 'danger');
        }
    } catch (error) {
        console.error('Error sending message:', error);
        showNotification(t('chat.toast.send_error'), 'danger');
    } finally {
        sendBtn.disabled = false;
        input.focus();
    }
}

/**
 * Reply to a user
 */
function replyTo(username) {
    const input = document.getElementById('messageInput');
    input.value = `@[${username}] `;
    updateCharCounter();
    input.focus();
}

/**
 * Truncate text to maxBytes UTF-8 bytes, respecting multi-byte characters.
 * @returns {string} truncated text (without "..." suffix)
 */
function truncateToBytes(text, maxBytes) {
    const encoder = new TextEncoder();
    if (encoder.encode(text).length <= maxBytes) return text;
    let truncated = '';
    let byteCount = 0;
    for (const char of text) {
        const charBytes = encoder.encode(char).length;
        if (byteCount + charBytes > maxBytes) break;
        truncated += char;
        byteCount += charBytes;
    }
    return truncated;
}

/**
 * Insert a quote into the message input, leaving the cursor on a fresh line
 * for the reply. Uses the `>` line prefix rather than the guillemets of older
 * versions, so the quote also reads as one in clients that don't style it.
 */
function insertQuote(username, quotedText) {
    const input = document.getElementById('messageInput');
    // One '>' per line — a quoted multi-line message stays fully quoted.
    const quoted = quotedText.split('\n').map(line => `>${line}`).join('\n');
    input.value = `@[${username}] ${quoted}\n`;
    updateCharCounter();
    input.focus();
}

/**
 * Quote a user's message — shows a dialog to choose full or truncated quote.
 * @param {string} username - Username to mention
 * @param {string} content - Original message content to quote
 */
function quoteTo(username, content) {
    const encoder = new TextEncoder();
    const contentBytes = encoder.encode(content).length;
    const maxBytes = chatSettingsCache.quote_max_bytes || CHAT_SETTINGS_DEFAULTS.quote_max_bytes;

    // If message fits within limit, insert directly — no dialog needed
    if (contentBytes <= maxBytes) {
        insertQuote(username, content);
        return;
    }

    // Show quote dialog
    const preview = truncateToBytes(content, 60);
    document.getElementById('quotePreview').textContent =
        preview.length < content.length ? preview + '...' : preview;
    document.getElementById('quoteBytesInput').value = maxBytes;

    const modal = new bootstrap.Modal(document.getElementById('quoteModal'));

    // Clean up old listeners by replacing buttons
    const fullBtn = document.getElementById('quoteFullBtn');
    const truncBtn = document.getElementById('quoteTruncatedBtn');
    const newFullBtn = fullBtn.cloneNode(true);
    const newTruncBtn = truncBtn.cloneNode(true);
    fullBtn.parentNode.replaceChild(newFullBtn, fullBtn);
    truncBtn.parentNode.replaceChild(newTruncBtn, truncBtn);

    newFullBtn.addEventListener('click', () => {
        modal.hide();
        insertQuote(username, content);
    });

    newTruncBtn.addEventListener('click', () => {
        modal.hide();
        const customBytes = parseInt(document.getElementById('quoteBytesInput').value, 10) || maxBytes;
        const truncated = truncateToBytes(content, customBytes);
        insertQuote(username, truncated + '...');
    });

    modal.show();
}

/**
 * Edit-message helper: paste an own message's content back into the composer
 * so the user can tweak it before sending. NOT a true resend — every press
 * produces a new packet hash. The arrow-repeat button next to this one does
 * the actual raw resend (resendChannelMessageRaw).
 * @param {string} content - Message content to paste
 */
function resendMessage(content) {
    const input = document.getElementById('messageInput');
    input.value = content;
    updateCharCounter();
    input.focus();
}

// A resend older than this asks for confirmation first — see the note in
// resendChannelMessageRaw() on why an old packet spreads like a new message.
const RAW_RESEND_STALE_AFTER_SEC = 3600;

/**
 * Raw resend: re-broadcast the exact same packet bytes so repeaters that
 * already forwarded it dedupe via packet-hash, while unreached repeaters
 * pick it up. Backend returns 400 if the message has no raw_packet snapshot
 * (sent before this feature shipped) or if the firmware is too old.
 *
 * @param {number} msgId - channel_messages.id
 * @param {HTMLElement} btn - the clicked button, used to spin the icon during the call
 */
async function resendChannelMessageRaw(msgId, btn) {
    if (!msgId || btn?.dataset.busy === '1') return;

    // Repeaters dedupe a resend through Mesh::hasSeen, but that table only
    // holds recent packet hashes. Once it has aged out nothing suppresses the
    // rebroadcast and the message lands on every node in the channel as new —
    // so confirm before putting an old packet back on the air. An unknown
    // timestamp (optimistic bubble) means the message is fresh: don't ask.
    const sentAt = parseInt(btn?.closest('.message-wrapper')?.dataset.timestamp ?? '', 10);
    if (Number.isFinite(sentAt)
            && (Math.floor(Date.now() / 1000) - sentAt) > RAW_RESEND_STALE_AFTER_SEC
            && !confirm(t('chat.confirm.stale_resend', { age: formatTimeAgo(sentAt, { long: true }) }))) {
        return;
    }

    const icon = btn?.querySelector('i');
    if (btn) {
        btn.dataset.busy = '1';
        btn.disabled = true;
        if (icon) icon.classList.add('spin');
    }
    try {
        const resp = await fetch(`/api/messages/${msgId}/resend`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data.success) {
            showNotification(t('chat.toast.resent', { bytes: data.bytes ?? '?' }), 'info');
        } else {
            showNotification(t('chat.toast.resend_failed', { error: data.error || resp.statusText }), 'danger');
        }
    } catch (err) {
        showNotification(t('chat.toast.resend_network_error', { error: err.message || err }), 'danger');
    } finally {
        if (btn) {
            btn.dataset.busy = '0';
            btn.disabled = false;
            if (icon) icon.classList.remove('spin');
        }
    }
}

async function ignoreContactFromChat(pubkey) {
    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/ignore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ignored: true })
        });
        const data = await response.json();
        if (data.success) {
            showNotification(data.message, 'info');
        } else {
            showNotification(t('common.failed_with', { error: data.error }), 'danger');
        }
    } catch (err) {
        showNotification(t('common.network_error'), 'danger');
    }
}

async function blockContactFromChat(senderName) {
    if (!confirm(t('chat.confirm.block', { name: senderName }))) return;
    try {
        const pubkey = contactsPubkeyMap[senderName];
        let response;
        if (pubkey) {
            // Block by pubkey (known contact)
            response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/block`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blocked: true })
            });
        } else {
            // Block by name (bot/unknown contact)
            response = await fetch('/api/contacts/block-name', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: senderName, blocked: true })
            });
        }
        const data = await response.json();
        if (data.success) {
            showNotification(data.message, 'warning');
            // Update blocked names then reload messages to hide blocked sender
            await loadBlockedNames();
            await loadMessages();
        } else {
            showNotification(t('common.failed_with', { error: data.error }), 'danger');
        }
    } catch (err) {
        console.error('Error blocking contact from chat:', err);
        showNotification(t('common.network_error'), 'danger');
    }
}

/**
 * Show paths popup on tap (mobile-friendly, shows all routes)
 */
function showPathsPopup(element, encodedPaths, packetHash) {
    // Remove any existing popup
    const existing = document.querySelector('.path-popup');
    if (existing) existing.remove();

    const paths = JSON.parse(decodeURIComponent(encodedPaths));

    const popup = document.createElement('div');
    popup.className = 'path-popup';

    paths.forEach((p, i) => {
        const pChunkLen = (p.hash_size || 1) * 2;
        const segments = [];
        if (p.path) {
            for (let j = 0; j < p.path.length; j += pChunkLen) {
                segments.push(p.path.substring(j, j + pChunkLen).toUpperCase());
            }
        }
        const fullRoute = segments.join(' \u2192 ');
        const commaRoute = segments.join(',');
        const snr = p.snr !== null && p.snr !== undefined ? `${p.snr.toFixed(1)} dB` : '?';
        const hops = segments.length;
        const entry = document.createElement('div');
        entry.className = 'path-entry';

        const body = document.createElement('span');
        body.className = 'path-route';
        body.innerHTML = `${fullRoute}<span class="path-detail">SNR: ${snr} | ${tHtml('chat.route_hops', { count: hops })}</span>`;
        entry.appendChild(body);

        const copyBtn = document.createElement('i');
        copyBtn.className = 'bi bi-clipboard path-copy';
        copyBtn.title = t('common.copy_route');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyTextToClipboard(commaRoute).then(() => {
                copyBtn.className = 'bi bi-clipboard-check path-copy';
                setTimeout(() => { copyBtn.className = 'bi bi-clipboard path-copy'; }, 1000);
            });
        });
        entry.appendChild(copyBtn);

        if (packetHash && p.path && segments.length > 0) {
            entry.title = t('chat.route_analyzer_title');
            entry.addEventListener('click', (e) => {
                e.stopPropagation();
                popup.remove();
                openPathInAnalyzer(packetHash, p.path);
            });
        } else {
            // No packet hash (or direct message): keep the copy behavior
            entry.title = t('chat.copy_route_title');
            entry.addEventListener('click', (e) => {
                e.stopPropagation();
                copyTextToClipboard(commaRoute).then(() => {
                    copyBtn.className = 'bi bi-clipboard-check path-copy';
                    setTimeout(() => { copyBtn.className = 'bi bi-clipboard path-copy'; }, 1000);
                });
            });
        }
        popup.appendChild(entry);
    });

    element.style.position = 'relative';
    element.appendChild(popup);

    // Adjust if popup overflows viewport
    const rect = popup.getBoundingClientRect();
    if (rect.left < 4) {
        popup.style.right = 'auto';
        popup.style.left = '0';
    }

    // Auto-dismiss after configured timeout (unless disabled) or on outside tap
    const dismiss = () => popup.remove();
    const cfg = window.chatSettingsCache || {};
    const noAutoclose = !!cfg.path_popup_no_autoclose;
    const timeoutSec = parseInt(cfg.path_popup_timeout_sec, 10);
    if (!noAutoclose) {
        const ms = (isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 8) * 1000;
        setTimeout(dismiss, ms);
    }
    document.addEventListener('click', function handler(e) {
        if (!element.contains(e.target)) {
            dismiss();
            document.removeEventListener('click', handler);
        }
    });
}

/**
 * Open the Path Analyzer modal deep-linked to one message + echo path.
 * The modal's show handler (index.html) reads window.paDeepLink and builds
 * the iframe URL from it.
 */
function openPathInAnalyzer(packetHash, pathHex) {
    const modalEl = document.getElementById('pathAnalyzerModal');
    if (!modalEl) return;
    window.paDeepLink = { hash: packetHash, path: pathHex };
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

/**
 * Load connection status
 */
async function loadStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();

        if (data.success) {
            updateStatus(data.connected ? 'connected' : 'disconnected');
            // Cache device capabilities so the message renderer can decide
            // whether to expose the raw-resend button (firmware ≥1.16 only).
            window.deviceCaps = {
                supports_raw_resend: !!data.supports_raw_resend,
                fw_ver_code: data.fw_ver_code ?? null,
            };
            // loadStatus and loadMessages run in parallel at page init, so
            // any messages rendered before this point missed the deviceCaps
            // check and have no raw-resend button. Walk visible own bubbles
            // and inject the button where it's missing.
            injectRawResendButtonsForVisibleMessages();
            updateDiagRecordingIndicator(!!data.diagnostics_recording);
        }
    } catch (error) {
        console.error('Error loading status:', error);
        updateStatus('disconnected');
    }
}

/**
 * Walk the messagesList and inject the raw-resend button on any own message
 * bubble that's missing it (e.g. rendered before window.deviceCaps was set,
 * or re-rendered by displayMessages on channel switch). Safe to call any
 * time — does nothing when the device doesn't support raw resend.
 */
function injectRawResendButtonsForVisibleMessages() {
    if (!window.deviceCaps?.supports_raw_resend) return;
    const container = document.getElementById('messagesList');
    if (!container) return;
    const wrappers = container.querySelectorAll('.message-wrapper.own[data-msg-id]');
    for (const wrapper of wrappers) {
        const msgId = wrapper.dataset.msgId;
        if (!msgId || msgId.startsWith('_pending_')) continue;
        const actionsEl = wrapper.querySelector('.message-actions');
        if (!actionsEl || actionsEl.querySelector('.btn-raw-resend')) continue;
        const rawBtn = document.createElement('button');
        rawBtn.className = 'btn btn-outline-secondary btn-msg-action btn-raw-resend';
        rawBtn.setAttribute('onclick', `resendChannelMessageRaw(${msgId}, this)`);
        rawBtn.title = t('chat.msg.raw_resend_title');
        rawBtn.innerHTML = '<i class="bi bi-arrow-repeat"></i>';
        actionsEl.appendChild(rawBtn);
    }
}

/**
 * Copy text to clipboard with visual feedback
 */
async function copyToClipboard(text, btnElement) {
    try {
        await copyTextToClipboard(text);
        const icon = btnElement.querySelector('i');
        const originalClass = icon.className;
        icon.className = 'bi bi-check';
        setTimeout(() => { icon.className = originalClass; }, 1500);
    } catch (err) {
        console.error('Failed to copy:', err);
    }
}

/**
 * Load device information
 */
async function loadDeviceInfo() {
    const container = document.getElementById('deviceInfoContent');
    container.innerHTML = `<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div> ${tHtml('common.loading')}</div>`;

    try {
        const response = await fetch('/api/device/info');
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(data.error)}</div>`;
            return;
        }

        // API returns info as a dict directly (v2 DeviceManager)
        const info = data.info;
        if (!info || typeof info !== 'object') {
            container.innerHTML = `<div class="alert alert-warning mb-0">${tHtml('device.info.none')}</div>`;
            return;
        }

        // Type mapping
        const typeNames = { 1: 'Companion', 2: 'Repeater', 3: 'Room Server', 4: 'Sensor' };
        const typeName = typeNames[info.adv_type] || t('device.info.type_unknown', { code: info.adv_type });

        // Shorten public key for display
        const pubKey = info.public_key || '';
        const shortKey = pubKey.length > 12 ? `${pubKey.slice(0, 6)}...${pubKey.slice(-6)}` : pubKey;

        // Location
        const hasLocation = info.adv_lat && info.adv_lon && (info.adv_lat !== 0 || info.adv_lon !== 0);
        const coords = hasLocation ? `${info.adv_lat.toFixed(6)}, ${info.adv_lon.toFixed(6)}` : tHtml('device.info.location_none');

        // Build table rows
        const rows = [
            { label: tHtml('device.info.name'), value: escapeHtml(info.name || t('common.unknown')), copyValue: info.name },
            { label: tHtml('device.info.type'), value: typeName },
            { label: tHtml('device.info.pubkey'), value: `<code class="small">${escapeHtml(shortKey)}</code>`, copyValue: pubKey },
            { label: tHtml('device.info.location'), value: coords, showMap: hasLocation, lat: info.adv_lat, lon: info.adv_lon, name: info.name },
            { label: tHtml('device.info.tx_power'), value: `${info.tx_power || 0} / ${info.max_tx_power || 0} dBm` },
            { label: tHtml('device.info.freq'), value: `${info.radio_freq || 0} MHz` },
            { label: tHtml('device.info.bw'), value: `${info.radio_bw || 0} kHz` },
            { label: tHtml('device.info.sf'), value: info.radio_sf || 0 },
            { label: tHtml('device.info.cr'), value: `4/${info.radio_cr || 0}` },
            { label: tHtml('device.info.multi_acks'), value: tHtml(info.multi_acks ? 'common.enabled' : 'common.disabled') },
            { label: tHtml('device.info.loc_sharing'), value: tHtml(info.adv_loc_policy ? 'common.enabled' : 'common.disabled') },
            { label: tHtml('device.info.manual_add'), value: tHtml(info.manual_add_contacts ? 'common.yes' : 'common.no') }
        ];

        let html = '<table class="table table-sm mb-0">';
        html += '<tbody>';

        for (const row of rows) {
            html += '<tr>';
            html += `<td class="text-muted" style="width: 40%">${row.label}</td>`;
            html += '<td>';
            html += row.value;

            // Copy button
            if (row.copyValue) {
                html += ` <button class="btn btn-link btn-sm p-0 ms-1" onclick="copyToClipboard('${escapeHtml(row.copyValue)}', this)" title="${tHtml('device.info.copy_title')}"><i class="bi bi-clipboard"></i></button>`;
            }

            // Map button
            if (row.showMap) {
                html += ` <button class="btn btn-link btn-sm p-0 ms-1" onclick="showContactOnMap('${escapeHtml(row.name)}', ${row.lat}, ${row.lon})" title="${tHtml('chat.msg.map_title')}"><i class="bi bi-geo-alt"></i></button>`;
            }

            html += '</td>';
            html += '</tr>';
        }

        html += '</tbody></table>';

        // Reboot lives here rather than in a danger zone of its own: it is the
        // only device-level action, and it is only reachable while the device
        // is connected (this branch).
        html += `
            <div class="d-flex align-items-center justify-content-between gap-2 mt-3 pt-3 border-top">
                <div class="small text-muted">${tHtml('device.reboot.hint')}</div>
                <button type="button" class="btn btn-sm btn-outline-danger flex-shrink-0" id="deviceRebootBtn" onclick="rebootDevice()">
                    <i class="bi bi-arrow-clockwise"></i> ${tHtml('device.reboot.btn')}
                </button>
            </div>
        `;

        container.innerHTML = html;

    } catch (error) {
        console.error('Error loading device info:', error);
        container.innerHTML = `<div class="alert alert-danger mb-0">${tHtml('device.info.load_failed')}</div>`;
    }
}

/**
 * Reboot the attached device (Info tab in the Device modal).
 *
 * The firmware acknowledges nothing and the companion link goes down with it,
 * so the button can only report that the command was written. The app
 * reconnects on its own once the device is back.
 */
async function rebootDevice() {
    if (!window.confirm(t('device.reboot.confirm'))) return;

    const btn = document.getElementById('deviceRebootBtn');
    const label = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    }

    let data = null;
    try {
        const response = await fetch('/api/device/reboot', { method: 'POST' });
        data = await response.json();
    } catch (error) {
        console.error('Error rebooting device:', error);
        data = { success: false, error: t('device.reboot.failed') };
    }

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = label;
    }

    if (data && data.success) {
        showNotification(t('device.reboot.sent'), 'warning');
    } else {
        showNotification((data && data.error) || t('device.reboot.failed'), 'danger');
    }
}

/**
 * Duration in seconds -> "6d 14h 46m". A copy of fmtDuration() in repeater-manage.js,
 * which runs in the My Repeaters panel and shares no scope with this file.
 */
function formatStatsDuration(seconds) {
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

/**
 * One titled block of the Stats tab, laid out like the repeater status view.
 * Labels are escaped here, so callers pass t(); values are markup built by the
 * caller and go in as-is.
 */
function deviceStatsSection(title, rows) {
    const body = rows.map(([label, value]) =>
        `<tr><td class="text-muted">${escapeHtml(label)}</td><td class="text-end fw-medium">${value}</td></tr>`
    ).join('');
    return `
        <div class="text-muted text-uppercase small fw-bold mt-3 mb-1">${escapeHtml(title)}</div>
        <table class="table table-sm mb-0"><tbody>${body}</tbody></table>
    `;
}

/**
 * Load device statistics (Stats tab in Device modal).
 *
 * Field names come straight from the firmware payload - the same ones the `stats`
 * console command prints (see app/main.py). They are not the names the repeater
 * status payload uses, even where the value means the same thing.
 */
async function loadDeviceStats() {
    const container = document.getElementById('deviceStatsContent');
    if (!container) return;

    container.innerHTML = `<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div> ${tHtml('common.loading')}</div>`;

    try {
        const response = await fetch('/api/device/stats');
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(data.error)}</div>`;
            return;
        }

        const stats = data.stats || {};
        const core = stats.core || {};
        const radio = stats.radio || {};
        const pkt = stats.packets || {};
        const db = data.db_stats || {};
        const bat = data.battery || {};

        // Battery comes from the dedicated get_bat call, or from core stats when
        // that returned nothing.
        const volts = (bat && bat.voltage) ? Number(bat.voltage).toFixed(2)
            : (core.battery_mv != null ? (core.battery_mv / 1000).toFixed(2) : null);

        // Share of uptime the radio spent transmitting or receiving.
        const util = (radio.tx_air_secs != null && radio.rx_air_secs != null && core.uptime_secs)
            ? (((radio.tx_air_secs + radio.rx_air_secs) / core.uptime_secs) * 100).toFixed(2) + '%'
            : '—';

        // "flood" and "direct" are protocol terms and stay English in every
        // language (see docs/translations.md). The split drops to its own line
        // below sm, where keeping it inline wraps the row label as well.
        const split = (flood, direct) =>
            `<span class="text-muted small d-block d-sm-inline">(flood ${formatInt(flood)} · direct ${formatInt(direct)})</span>`;

        let html = '';

        if (Object.keys(core).length || volts !== null) {
            html += deviceStatsSection(t('rptmgmt.status.system'), [
                [t('device.stats.battery'), volts !== null ? `${volts}V` : '—'],
                [t('device.stats.uptime'), formatStatsDuration(core.uptime_secs)],
                [t('device.stats.queue'), formatInt(core.queue_len)],
                [t('device.stats.errors'), formatInt(core.errors)],
            ]);
        }

        if (Object.keys(radio).length) {
            html += deviceStatsSection(t('rptmgmt.status.radio'), [
                [t('rptmgmt.status.last_rssi'), radio.last_rssi != null ? `${radio.last_rssi} dBm` : '—'],
                [t('rptmgmt.status.last_snr'), radio.last_snr != null ? `${radio.last_snr} dB` : '—'],
                [t('rptmgmt.status.noise'), radio.noise_floor != null ? `${radio.noise_floor} dBm` : '—'],
                [t('device.stats.tx_air'), formatStatsDuration(radio.tx_air_secs)],
                [t('device.stats.rx_air'), formatStatsDuration(radio.rx_air_secs)],
                [t('rptmgmt.status.utilization'), util],
            ]);
        }

        if (Object.keys(pkt).length) {
            const rows = [
                [t('device.stats.packets_tx'), `${formatInt(pkt.sent)} ${split(pkt.flood_tx, pkt.direct_tx)}`],
                [t('device.stats.packets_rx'), `${formatInt(pkt.recv)} ${split(pkt.flood_rx, pkt.direct_rx)}`],
            ];
            if (pkt.recv_errors != null) rows.push([t('rptmgmt.status.rx_errors'), formatInt(pkt.recv_errors)]);
            html += deviceStatsSection(t('rptmgmt.status.packets'), rows);
        }

        if (Object.keys(db).length) {
            html += deviceStatsSection(t('device.stats.database'), [
                [t('device.stats.contacts_db'), formatInt(db.contacts)],
                [t('device.stats.channel_msgs'), formatInt(db.channel_messages)],
                [t('device.stats.direct_msgs'), formatInt(db.direct_messages)],
                [t('device.stats.db_size'), db.db_size_bytes != null
                    ? `${(db.db_size_bytes / (1024 * 1024)).toFixed(1)} MB` : '—'],
            ]);
        }

        if (!html) {
            container.innerHTML = `<div class="text-center text-muted py-3">${tHtml('device.stats.none')}</div>`;
        } else {
            container.innerHTML = html;
        }

    } catch (error) {
        console.error('Error loading device stats:', error);
        container.innerHTML = `<div class="alert alert-danger mb-0">${tHtml('device.stats.load_failed')}</div>`;
    }
}

// Load stats when Stats tab is clicked
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('statsTabBtn')?.addEventListener('shown.bs.tab', loadDeviceStats);
    document.getElementById('shareTabBtn')?.addEventListener('shown.bs.tab', loadDeviceShare);
});

/**
 * Load device share tab - generate QR code and URI for sharing own contact
 */
async function loadDeviceShare() {
    const container = document.getElementById('deviceShareContent');
    if (!container) return;

    container.innerHTML = `<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div> ${tHtml('common.loading')}</div>`;

    try {
        const response = await fetch('/api/device/info');
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(data.error)}</div>`;
            return;
        }

        const info = data.info;
        if (!info || !info.public_key || !info.name) {
            container.innerHTML = `<div class="alert alert-warning mb-0">${tHtml('device.share.unavailable')}</div>`;
            return;
        }

        const contactType = info.adv_type || 1;
        const uri = `meshcore://contact/add?name=${encodeURIComponent(info.name)}&public_key=${info.public_key}&type=${contactType}`;

        const typeNames = { 1: 'Companion', 2: 'Repeater', 3: 'Room Server', 4: 'Sensor' };

        let html = '<div class="text-center">';
        html += `<p class="text-muted small mb-3">${tHtml('device.share.hint')}</p>`;
        html += '<div id="shareQrCode" class="d-inline-block mb-3"></div>';
        html += '<div class="mb-2"><strong>' + escapeHtml(info.name) + '</strong></div>';
        html += '<div class="text-muted small mb-3">' + escapeHtml(typeNames[contactType] || t('common.unknown')) + '</div>';
        html += '</div>';

        html += '<div class="mb-3">';
        html += `<label class="form-label text-muted small">${tHtml('device.share.uri')}</label>`;
        html += '<div class="input-group">';
        html += '<input type="text" class="form-control form-control-sm font-monospace" value="' + escapeHtml(uri) + '" readonly id="shareUriInput">';
        html += '<button class="btn btn-outline-secondary btn-sm" onclick="copyToClipboard(document.getElementById(\'shareUriInput\').value, this)" title="' + tHtml('device.share.copy_uri') + '"><i class="bi bi-clipboard"></i></button>';
        html += '</div>';
        html += '</div>';

        container.innerHTML = html;

        // Generate QR code
        const qrContainer = document.getElementById('shareQrCode');
        if (qrContainer && typeof QRCode !== 'undefined') {
            new QRCode(qrContainer, {
                text: uri,
                width: 200,
                height: 200,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        }

    } catch (error) {
        console.error('Error loading device share:', error);
        container.innerHTML = `<div class="alert alert-danger mb-0">${tHtml('device.info.load_failed')}</div>`;
    }
}

// =============================================================================
// Device Settings (Settings Modal - Device Tab)
// =============================================================================

const RADIO_PRESETS = [
    { label: 'Australia',               freq: 915.800, bw: 250,  sf: 10, cr: 5 },
    { label: 'Australia (Narrow)',      freq: 916.575, bw: 62.5, sf: 7,  cr: 8 },
    { label: 'Australia: SA, WA',       freq: 923.125, bw: 62.5, sf: 8,  cr: 8 },
    { label: 'Australia: QLD',          freq: 923.125, bw: 62.5, sf: 8,  cr: 5 },
    { label: 'EU/UK (Narrow)',          freq: 869.618, bw: 62.5, sf: 8,  cr: 8 },
    { label: 'EU/UK (Deprecated)',      freq: 869.525, bw: 250,  sf: 11, cr: 5 },
    { label: 'Czech Republic (Narrow)', freq: 869.432, bw: 62.5, sf: 7,  cr: 8 },
    { label: 'EU 433MHz (Long Range)',  freq: 433.650, bw: 250,  sf: 11, cr: 5 },
    { label: 'New Zealand',             freq: 917.375, bw: 250,  sf: 11, cr: 5 },
    { label: 'New Zealand (Narrow)',    freq: 917.375, bw: 62.5, sf: 7,  cr: 5 },
    { label: 'Portugal 433',            freq: 433.375, bw: 62.5, sf: 9,  cr: 6 },
    { label: 'Portugal 868',            freq: 869.618, bw: 62.5, sf: 7,  cr: 6 },
    { label: 'Switzerland',             freq: 869.618, bw: 62.5, sf: 8,  cr: 8 },
    { label: 'USA/Canada (Recommended)', freq: 910.525, bw: 62.5, sf: 7, cr: 5 },
    { label: 'Vietnam (Narrow)',        freq: 920.250, bw: 62.5, sf: 8,  cr: 5 },
    { label: 'Vietnam (Deprecated)',    freq: 920.250, bw: 250,  sf: 11, cr: 5 },
];

async function loadDeviceConfig() {
    try {
        const resp = await fetch('/api/device/config');
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.success) return;
        const c = data.config;

        // Public Info
        document.getElementById('settDeviceName').value = c.name || '';
        document.getElementById('settDeviceLat').value = c.lat || '';
        document.getElementById('settDeviceLon').value = c.lon || '';
        document.getElementById('settDeviceAdvertLoc').checked = !!c.advert_loc_policy;
        const phmSel = document.getElementById('settDevicePathHashMode');
        if (phmSel) {
            const phm = (c.path_hash_mode === 0 || c.path_hash_mode === 1 || c.path_hash_mode === 2)
                ? String(c.path_hash_mode) : '0';
            phmSel.value = phm;
            phmSel.dataset.initial = phm;
        }

        // Radio
        document.getElementById('settRadioFreq').value = c.radio_freq || '';
        // Match bandwidth to closest option
        const bwSelect = document.getElementById('settRadioBw');
        if (bwSelect && c.radio_bw) {
            const bwVal = parseFloat(c.radio_bw);
            let bestOpt = bwSelect.options[0];
            let bestDiff = Infinity;
            for (const opt of bwSelect.options) {
                const diff = Math.abs(parseFloat(opt.value) - bwVal);
                if (diff < bestDiff) { bestDiff = diff; bestOpt = opt; }
            }
            bwSelect.value = bestOpt.value;
        }
        document.getElementById('settRadioSf').value = c.radio_sf || '';
        document.getElementById('settRadioCr').value = c.radio_cr || '';
        document.getElementById('settRadioTxPower').value = c.tx_power || '';

        // Reset preset dropdown
        document.getElementById('settRadioPreset').value = '';
    } catch (e) {
        console.error('Failed to load device config:', e);
    }
}

async function saveDevicePublicInfo() {
    const name = document.getElementById('settDeviceName').value.trim();
    if (!name) {
        showNotification(t('settings.device.toast.name_empty'), 'danger');
        document.getElementById('settDeviceName').focus();
        return;
    }

    const lat = parseFloat(document.getElementById('settDeviceLat').value) || 0;
    const lon = parseFloat(document.getElementById('settDeviceLon').value) || 0;
    const advertLoc = document.getElementById('settDeviceAdvertLoc').checked;

    const phmSel = document.getElementById('settDevicePathHashMode');
    const payload = {
        name: name,
        lat: lat,
        lon: lon,
        advert_loc_policy: advertLoc
    };
    if (phmSel && phmSel.value !== phmSel.dataset.initial) {
        payload.path_hash_mode = parseInt(phmSel.value, 10);
    }

    try {
        const resp = await fetch('/api/device/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await resp.json();
        if (data.success) {
            showNotification(t('settings.device.toast.info_saved'), 'success');
            _selfInfo = null;
            if (phmSel) phmSel.dataset.initial = phmSel.value;
        } else {
            showNotification(data.error || t('common.save_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('settings.device.toast.info_save_failed'), 'danger');
    }
}

async function saveDeviceRadioSettings() {
    const freq = parseFloat(document.getElementById('settRadioFreq').value);
    const bw = parseFloat(document.getElementById('settRadioBw').value);
    const sf = parseInt(document.getElementById('settRadioSf').value, 10);
    const cr = parseInt(document.getElementById('settRadioCr').value, 10);
    const txPower = parseInt(document.getElementById('settRadioTxPower').value, 10);

    if (isNaN(freq) || freq < 100 || freq > 1000) {
        showNotification(t('settings.device.toast.freq_invalid'), 'danger');
        return;
    }
    if (isNaN(sf) || sf < 5 || sf > 12) {
        showNotification(t('settings.device.toast.sf_invalid'), 'danger');
        return;
    }
    if (isNaN(cr) || cr < 5 || cr > 8) {
        showNotification(t('settings.device.toast.cr_invalid'), 'danger');
        return;
    }
    if (isNaN(txPower) || txPower < 0 || txPower > 30) {
        showNotification(t('settings.device.toast.tx_invalid'), 'danger');
        return;
    }

    if (!confirm(t('settings.device.confirm.radio'))) return;

    try {
        const resp = await fetch('/api/device/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                radio_freq: freq,
                radio_bw: bw,
                radio_sf: sf,
                radio_cr: cr,
                tx_power: txPower
            })
        });
        const data = await resp.json();
        if (data.success) {
            showNotification(t('settings.device.toast.radio_saved'), 'success');
        } else {
            showNotification(data.error || t('common.save_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('settings.device.toast.radio_save_failed'), 'danger');
    }
}

function populateRadioPresets() {
    const select = document.getElementById('settRadioPreset');
    if (!select) return;
    select.innerHTML = `<option value="">${tHtml('settings.device.load_preset')}</option>`;
    RADIO_PRESETS.forEach((preset, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = `${preset.label} — ${preset.freq} / SF${preset.sf} / BW${preset.bw} / CR${preset.cr}`;
        select.appendChild(opt);
    });
}

function applyRadioPreset(idx) {
    const preset = RADIO_PRESETS[idx];
    if (!preset) return;
    document.getElementById('settRadioFreq').value = preset.freq;
    document.getElementById('settRadioBw').value = preset.bw;
    document.getElementById('settRadioSf').value = preset.sf;
    document.getElementById('settRadioCr').value = preset.cr;
}

// --- Coordinate Map Picker ---

let _coordPickerMap = null;
let _coordPickerMarker = null;
let _coordPickerLatLng = null;

function openCoordPicker() {
    _coordPickerLatLng = null;

    const modalEl = document.getElementById('coordPickerModal');
    if (!modalEl) return;

    const confirmBtn = document.getElementById('coordPickerConfirmBtn');
    const label = document.getElementById('coordPickerLabel');
    if (confirmBtn) confirmBtn.disabled = true;
    if (label) label.textContent = t('coord.hint');

    const modal = new bootstrap.Modal(modalEl);

    const onShown = function () {
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops.length > 0) {
            backdrops[backdrops.length - 1].style.zIndex = '1075';
        }

        if (!_coordPickerMap) {
            _coordPickerMap = L.map('coordPickerMap').setView([52.0, 19.0], 6);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
            }).addTo(_coordPickerMap);

            _coordPickerMap.on('click', function (e) {
                _coordPickerLatLng = e.latlng;
                if (_coordPickerMarker) {
                    _coordPickerMarker.setLatLng(e.latlng);
                } else {
                    _coordPickerMarker = L.marker(e.latlng).addTo(_coordPickerMap);
                }
                if (label) label.textContent = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
                if (confirmBtn) confirmBtn.disabled = false;
            });
        }

        _coordPickerMap.invalidateSize();

        // Center on current lat/lon if set
        const curLat = parseFloat(document.getElementById('settDeviceLat').value);
        const curLon = parseFloat(document.getElementById('settDeviceLon').value);
        if (!isNaN(curLat) && !isNaN(curLon) && (curLat !== 0 || curLon !== 0)) {
            _coordPickerMap.setView([curLat, curLon], 13);
            if (_coordPickerMarker) {
                _coordPickerMarker.setLatLng([curLat, curLon]);
            } else {
                _coordPickerMarker = L.marker([curLat, curLon]).addTo(_coordPickerMap);
            }
            _coordPickerLatLng = { lat: curLat, lng: curLon };
            if (label) label.textContent = `${curLat.toFixed(6)}, ${curLon.toFixed(6)}`;
            if (confirmBtn) confirmBtn.disabled = false;
        } else {
            // Remove old marker if coords are empty
            if (_coordPickerMarker) {
                _coordPickerMap.removeLayer(_coordPickerMarker);
                _coordPickerMarker = null;
            }
            _coordPickerMap.setView([52.0, 19.0], 6);
        }

        modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
}

// =============================================================================
// Settings Modal
// =============================================================================

// --- Chat Settings ---

const CHAT_SETTINGS_DEFAULTS = {
    quote_max_bytes: 20,
    path_popup_timeout_sec: 8,
    path_popup_no_autoclose: false
};

const CHAT_SETTINGS_INT_FIELDS = {
    quote_max_bytes: 'settQuoteMaxBytes',
    path_popup_timeout_sec: 'settPathPopupTimeout'
};

const CHAT_SETTINGS_BOOL_FIELDS = {
    path_popup_no_autoclose: 'settPathPopupNoAutoclose'
};

let chatSettingsCache = { ...CHAT_SETTINGS_DEFAULTS };
window.chatSettingsCache = chatSettingsCache;

function populateChatSettingsForm(data) {
    for (const [key, elId] of Object.entries(CHAT_SETTINGS_INT_FIELDS)) {
        const el = document.getElementById(elId);
        if (el) el.value = data[key] ?? CHAT_SETTINGS_DEFAULTS[key];
    }
    for (const [key, elId] of Object.entries(CHAT_SETTINGS_BOOL_FIELDS)) {
        const el = document.getElementById(elId);
        if (el) el.checked = !!(data[key] ?? CHAT_SETTINGS_DEFAULTS[key]);
    }
}

async function loadChatSettings() {
    try {
        const resp = await fetch('/api/chat/settings');
        if (resp.ok) {
            const data = await resp.json();
            chatSettingsCache = { ...CHAT_SETTINGS_DEFAULTS, ...data };
            window.chatSettingsCache = chatSettingsCache;
            populateChatSettingsForm(chatSettingsCache);
        }
    } catch (e) {
        console.error('Failed to load chat settings:', e);
    }
}

async function saveChatSettings() {
    const payload = {};
    for (const [key, elId] of Object.entries(CHAT_SETTINGS_INT_FIELDS)) {
        const el = document.getElementById(elId);
        const val = parseInt(el.value, 10);
        if (isNaN(val) || val < parseInt(el.min) || val > parseInt(el.max)) {
            showNotification(t('settings.toast.invalid_value', { field: el.previousElementSibling?.textContent || key }), 'danger');
            el.focus();
            return;
        }
        payload[key] = val;
    }
    for (const [key, elId] of Object.entries(CHAT_SETTINGS_BOOL_FIELDS)) {
        const el = document.getElementById(elId);
        if (el) payload[key] = !!el.checked;
    }
    try {
        const resp = await fetch('/api/chat/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (resp.ok) {
            const data = await resp.json();
            chatSettingsCache = { ...CHAT_SETTINGS_DEFAULTS, ...data };
            window.chatSettingsCache = chatSettingsCache;
            showNotification(t('settings.toast.saved'), 'success');
        } else {
            const err = await resp.json();
            showNotification(err.error || t('common.save_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('settings.toast.save_failed'), 'danger');
    }
}

// --- UI (Interface) Settings ---

const UI_SETTINGS_DEFAULTS = {
    toast_timeout_sec: 2,
    toast_no_autoclose: false,
    toast_position: 'top-left',
    language: 'en'
};

const TOAST_POSITION_CLASSES = {
    'top-left':     ['top-0', 'start-0'],
    'top-right':    ['top-0', 'end-0'],
    'bottom-left':  ['bottom-0', 'start-0'],
    'bottom-right': ['bottom-0', 'end-0'],
    'center':       ['top-50', 'start-50', 'translate-middle']
};

const ALL_POSITION_CLASSES = ['top-0', 'top-50', 'start-0', 'start-50', 'bottom-0', 'end-0', 'translate-middle'];

let uiSettingsCache = { ...UI_SETTINGS_DEFAULTS };
window.uiSettingsCache = uiSettingsCache;

function applyToastPosition(position) {
    const classes = TOAST_POSITION_CLASSES[position] || TOAST_POSITION_CLASSES['top-left'];
    document.querySelectorAll('[data-toast-container]').forEach(el => {
        ALL_POSITION_CLASSES.forEach(c => el.classList.remove(c));
        classes.forEach(c => el.classList.add(c));
    });
}
window.applyToastPosition = applyToastPosition;

function populateUiSettingsForm(data) {
    // Not `t` — that would shadow the global translation helper for this whole function.
    const timeout = document.getElementById('settToastTimeout');
    if (timeout) timeout.value = data.toast_timeout_sec ?? UI_SETTINGS_DEFAULTS.toast_timeout_sec;
    const noClose = document.getElementById('settToastNoAutoclose');
    if (noClose) noClose.checked = !!(data.toast_no_autoclose ?? UI_SETTINGS_DEFAULTS.toast_no_autoclose);
    const pos = document.getElementById('settToastPosition');
    if (pos) pos.value = data.toast_position ?? UI_SETTINGS_DEFAULTS.toast_position;
}

async function loadUiSettings() {
    try {
        const resp = await fetch('/api/ui/settings');
        if (resp.ok) {
            const data = await resp.json();
            uiSettingsCache = { ...UI_SETTINGS_DEFAULTS, ...data };
            window.uiSettingsCache = uiSettingsCache;
            applyToastPosition(uiSettingsCache.toast_position);
            populateUiSettingsForm(uiSettingsCache);
        }
    } catch (e) {
        console.error('Failed to load UI settings:', e);
    }
}

async function saveUiSettings() {
    const timeoutEl = document.getElementById('settToastTimeout');
    const timeout = parseFloat(timeoutEl.value);
    if (isNaN(timeout) || timeout < 1 || timeout > 60) {
        showNotification(t('settings.iface.toast.autoclose_invalid'), 'danger');
        timeoutEl.focus();
        return;
    }
    const payload = {
        toast_timeout_sec: timeout,
        toast_no_autoclose: !!document.getElementById('settToastNoAutoclose').checked,
        toast_position: document.getElementById('settToastPosition').value
    };
    try {
        const resp = await fetch('/api/ui/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (resp.ok) {
            const data = await resp.json();
            uiSettingsCache = { ...UI_SETTINGS_DEFAULTS, ...data };
            window.uiSettingsCache = uiSettingsCache;
            applyToastPosition(uiSettingsCache.toast_position);
            showNotification(t('settings.toast.saved'), 'success');
        } else {
            const err = await resp.json();
            showNotification(err.error || t('common.save_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('settings.toast.save_failed'), 'danger');
    }
}

// --- UI Language ---

/**
 * Switch the interface language.
 *
 * The cookie is what the server reads when rendering, and same-origin iframes send it
 * automatically — so reloading the top-level page is all the propagation needed. The
 * existing modal-open wiring in index.html re-assigns every iframe src, and each one
 * then renders in the new language. The POST additionally makes this the server-wide
 * default for browsers that have no cookie of their own.
 */
async function changeLanguage(code) {
    if (!code || code === window.MC_LANG) return;

    document.cookie = `mc_lang=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Lax`;

    try {
        await fetch('/api/ui/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: code })
        });
    } catch (e) {
        // The cookie is already set, so the reload still switches this browser.
        console.error('Failed to save server default language:', e);
    }

    location.reload();
}

/**
 * Re-scan the translations folder without restarting the app.
 *
 * Catalogs are fingerprinted with stat() on every render, so a dropped-in file is
 * normally live on the next refresh already. This covers network filesystems whose
 * mtime granularity is too coarse for that to be noticed.
 */
async function reloadTranslations() {
    try {
        const resp = await fetch('/api/i18n/reload', { method: 'POST' });
        const data = await resp.json();
        if (resp.ok && data.success) {
            const names = Object.values(data.languages || {}).join(', ');
            showNotification(t('settings.appear.toast.reloaded', { names }), 'success');
            setTimeout(() => location.reload(), 800);
        } else {
            showNotification(data.error || t('settings.appear.toast.reload_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('settings.appear.toast.reload_failed'), 'danger');
    }
}

// --- DM Retry Settings ---

const DM_RETRY_DEFAULTS = {
    direct_max_retries: 3,
    direct_flood_retries: 1,
    flood_max_retries: 3,
    direct_interval: 30,
    flood_interval: 60,
    grace_period: 60
};

const DM_RETRY_FIELDS = {
    direct_max_retries: 'settDirectMaxRetries',
    direct_flood_retries: 'settDirectFloodRetries',
    flood_max_retries: 'settFloodMaxRetries',
    direct_interval: 'settDirectInterval',
    flood_interval: 'settFloodInterval',
    grace_period: 'settGracePeriod'
};

function populateDmRetryForm(data) {
    for (const [key, elId] of Object.entries(DM_RETRY_FIELDS)) {
        const el = document.getElementById(elId);
        if (el) el.value = data[key] ?? DM_RETRY_DEFAULTS[key];
    }
}

async function loadDmRetrySettings() {
    try {
        const resp = await fetch('/api/dm/auto_retry');
        if (resp.ok) {
            const data = await resp.json();
            populateDmRetryForm(data);
        }
    } catch (e) {
        console.error('Failed to load DM retry settings:', e);
    }
}

async function saveDmRetrySettings() {
    const payload = {};
    for (const [key, elId] of Object.entries(DM_RETRY_FIELDS)) {
        const el = document.getElementById(elId);
        const val = parseInt(el.value, 10);
        if (isNaN(val) || val < parseInt(el.min) || val > parseInt(el.max)) {
            showNotification(t('settings.toast.invalid_value', { field: el.previousElementSibling?.textContent || key }), 'danger');
            el.focus();
            return;
        }
        payload[key] = val;
    }
    try {
        const resp = await fetch('/api/dm/auto_retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (resp.ok) {
            showNotification(t('settings.toast.saved'), 'success');
        } else {
            const err = await resp.json();
            showNotification(err.error || t('common.save_failed'), 'danger');
        }
    } catch (e) {
        showNotification(t('settings.toast.save_failed'), 'danger');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
        settingsModal.addEventListener('show.bs.modal', () => {
            loadDeviceConfig();
            loadDmRetrySettings();
            loadChatSettings();
            loadUiSettings();
            loadContactsSettings();
            loadRegions();
            loadAnalyzers();
            loadObserverTab();
            loadDiagnosticsTab();
        });
        settingsModal.addEventListener('shown.bs.modal', () => {
            settingsModal.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
                bootstrap.Tooltip.getOrCreateInstance(el);
            });
        });
    }

    // Contacts tab toggle handlers
    document.getElementById('settManualApproval')?.addEventListener('change', (e) => {
        saveContactsSetting('manual_add_contacts', e.target.checked, e.target);
    });
    document.getElementById('settSuppressAdvertNotifs')?.addEventListener('change', (e) => {
        saveContactsSetting('suppress_advert_notifications', e.target.checked, e.target);
    });
    document.getElementById('settAutoIgnoreAdverts')?.addEventListener('change', (e) => {
        saveContactsSetting('auto_ignore_new_adverts', e.target.checked, e.target);
    });

    // Initial load so suppress flag is available before user opens Settings
    loadContactsSettings();

    // Regions tab: region registry
    const addRegionForm = document.getElementById('addRegionForm');
    if (addRegionForm) {
        addRegionForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('newRegionName');
            const name = (input?.value || '').trim();
            if (!name) return;
            addRegion(name, input);
        });
    }

    // Region picker (per-channel): Save button
    const regionPickerSaveBtn = document.getElementById('regionPickerSaveBtn');
    if (regionPickerSaveBtn) {
        regionPickerSaveBtn.addEventListener('click', () => saveChannelScope());
    }

    // Status-bar region pill: click to open picker for current channel
    const regionIndicator = document.getElementById('regionIndicator');
    if (regionIndicator) {
        regionIndicator.addEventListener('click', () => openRegionPicker(currentChannelIdx));
    }

    // Analyzer tab: add button + edit form submit
    const addAnalyzerBtn = document.getElementById('addAnalyzerBtn');
    if (addAnalyzerBtn) {
        addAnalyzerBtn.addEventListener('click', () => openAnalyzerEditModal(null));
    }
    const analyzerEditForm = document.getElementById('analyzerEditForm');
    if (analyzerEditForm) {
        analyzerEditForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveAnalyzerFromForm();
        });
    }

    // Observer tab: settings + broker add/edit form
    document.getElementById('observerEnabledToggle')?.addEventListener('change', (e) => {
        saveObserverSettings({ enabled: e.target.checked });
    });
    document.getElementById('observerIataInput')?.addEventListener('change', (e) => {
        const iata = (e.target.value || '').trim();
        if (iata && !/^[A-Za-z]{3}$/.test(iata)) {
            showNotification(t('observer.iata_invalid'), 'warning');
            return;
        }
        saveObserverSettings({ iata });
    });
    document.getElementById('observerAdvertIntervalInput')?.addEventListener('change', (e) => {
        saveObserverSettings({ advert_interval_hours: parseInt(e.target.value || '0', 10) || 0 });
    });
    document.getElementById('addObserverBrokerBtn')?.addEventListener('click', () => {
        openObserverBrokerModal(null);
    });
    document.getElementById('observerBrokerEditForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        saveObserverBrokerFromForm();
    });

    // Preload analyzers so the first click on a chart icon doesn't need a round-trip.
    loadAnalyzers();

    const dmRetryForm = document.getElementById('dmRetrySettingsForm');
    if (dmRetryForm) {
        dmRetryForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveDmRetrySettings();
        });
    }

    document.getElementById('settingsResetBtn')?.addEventListener('click', () => {
        populateDmRetryForm(DM_RETRY_DEFAULTS);
    });

    const chatSettingsForm = document.getElementById('chatSettingsForm');
    if (chatSettingsForm) {
        chatSettingsForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveChatSettings();
        });
    }

    document.getElementById('chatSettingsResetBtn')?.addEventListener('click', () => {
        populateChatSettingsForm(CHAT_SETTINGS_DEFAULTS);
    });

    const uiSettingsForm = document.getElementById('uiSettingsForm');
    if (uiSettingsForm) {
        uiSettingsForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveUiSettings();
        });
    }

    document.getElementById('uiSettingsResetBtn')?.addEventListener('click', () => {
        populateUiSettingsForm(UI_SETTINGS_DEFAULTS);
    });

    document.getElementById('settLanguage')?.addEventListener('change', (e) => {
        changeLanguage(e.target.value);
    });

    document.getElementById('reloadTranslationsBtn')?.addEventListener('click', reloadTranslations);

    // --- Device Settings ---
    const devicePublicInfoForm = document.getElementById('devicePublicInfoForm');
    if (devicePublicInfoForm) {
        devicePublicInfoForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveDevicePublicInfo();
        });
    }

    const deviceRadioForm = document.getElementById('deviceRadioForm');
    if (deviceRadioForm) {
        deviceRadioForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveDeviceRadioSettings();
        });
    }

    populateRadioPresets();
    document.getElementById('settRadioPreset')?.addEventListener('change', (e) => {
        const idx = parseInt(e.target.value, 10);
        if (!isNaN(idx)) applyRadioPreset(idx);
    });

    document.getElementById('settDevicePickMapBtn')?.addEventListener('click', () => {
        openCoordPicker();
    });

    document.getElementById('coordPickerConfirmBtn')?.addEventListener('click', () => {
        if (_coordPickerLatLng) {
            document.getElementById('settDeviceLat').value = _coordPickerLatLng.lat.toFixed(6);
            document.getElementById('settDeviceLon').value = _coordPickerLatLng.lng.toFixed(6);
        }
        bootstrap.Modal.getInstance(document.getElementById('coordPickerModal'))?.hide();
    });

    // Load settings caches on startup (for quote dialog, path popup, toast behavior)
    loadChatSettings();
    loadUiSettings();
});

/**
 * Cleanup inactive contacts
 */
async function cleanupContacts() {
    const hours = parseInt(document.getElementById('inactiveHours').value);

    if (!confirm(t('contacts.cleanup.confirm', { hours }))) {
        return;
    }

    const btn = document.getElementById('cleanupBtn');
    btn.disabled = true;

    try {
        const response = await fetch('/api/contacts/cleanup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ hours: hours })
        });

        const data = await response.json();

        if (data.success) {
            showNotification(data.message, 'success');
        } else {
            showNotification(t('contacts.cleanup.failed', { error: data.error }), 'danger');
        }
    } catch (error) {
        console.error('Error cleaning contacts:', error);
        showNotification(t('contacts.cleanup.error'), 'danger');
    } finally {
        btn.disabled = false;
    }
}

/**
 * Execute a special device command (advert, floodadv, etc.)
 */
async function executeSpecialCommand(command) {
    // Get button element to disable during execution
    const btnId = command === 'advert' ? 'advertBtn' : 'floodadvBtn';
    const btn = document.getElementById(btnId);

    if (btn) {
        btn.disabled = true;
    }

    try {
        const response = await fetch('/api/device/command', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ command: command })
        });

        const data = await response.json();

        if (data.success) {
            showNotification(data.message || t('device.cmd.sent', { command }), 'success');
        } else {
            showNotification(t('device.cmd.failed', { error: data.error }), 'danger');
        }

        // Close offcanvas menu after command execution
        const offcanvas = bootstrap.Offcanvas.getInstance(document.getElementById('mainMenu'));
        if (offcanvas) {
            offcanvas.hide();
        }

    } catch (error) {
        console.error(`Error executing ${command}:`, error);
        showNotification(t('device.cmd.exec_failed', { command }), 'danger');
    } finally {
        if (btn) {
            btn.disabled = false;
        }
    }
}

// ============================================================================
// PWA Notifications
// ============================================================================

/**
 * Request notification permission from user
 * Stores result in localStorage
 */
async function requestNotificationPermission() {
    if (!('Notification' in window)) {
        showNotification(t('settings.notif.toast.unsupported'), 'warning');
        return false;
    }

    try {
        const permission = await Notification.requestPermission();

        if (permission === 'granted') {
            localStorage.setItem('mc_notifications_enabled', 'true');
            updateNotificationToggleUI();
            showNotification(t('settings.notif.toast.enabled'), 'success');
            return true;
        } else if (permission === 'denied') {
            localStorage.setItem('mc_notifications_enabled', 'false');
            updateNotificationToggleUI();
            showNotification(t('settings.notif.toast.denied'), 'warning');
            return false;
        }
    } catch (error) {
        console.error('Error requesting notification permission:', error);
        showNotification(t('settings.notif.toast.error'), 'danger');
        return false;
    }
}

/**
 * Check current notification permission status
 */
function getNotificationPermission() {
    if (!('Notification' in window)) {
        return 'unsupported';
    }
    return Notification.permission;
}

/**
 * Check if notifications are enabled by user
 */
function areNotificationsEnabled() {
    return localStorage.getItem('mc_notifications_enabled') === 'true' &&
           getNotificationPermission() === 'granted';
}

/**
 * Update notification toggle button UI
 */
function updateNotificationToggleUI() {
    const toggleBtn = document.getElementById('notificationsToggle');
    const statusBadge = document.getElementById('notificationStatus');

    if (!toggleBtn || !statusBadge) return;

    const permission = getNotificationPermission();
    const isEnabled = localStorage.getItem('mc_notifications_enabled') === 'true';

    if (permission === 'unsupported') {
        statusBadge.className = 'badge bg-secondary';
        statusBadge.textContent = t('settings.notif.unavailable');
        toggleBtn.disabled = true;
    } else if (permission === 'denied') {
        statusBadge.className = 'badge bg-danger';
        statusBadge.textContent = t('settings.notif.blocked');
        toggleBtn.disabled = false;
    } else if (permission === 'granted' && isEnabled) {
        statusBadge.className = 'badge bg-success';
        statusBadge.textContent = t('common.enabled');
        toggleBtn.disabled = false;
    } else {
        // permission === 'default' OR (permission === 'granted' AND !isEnabled)
        statusBadge.className = 'badge bg-secondary';
        statusBadge.textContent = t('common.disabled');
        toggleBtn.disabled = false;
    }
}

/**
 * Handle notification toggle button click
 */
async function handleNotificationToggle() {
    const permission = getNotificationPermission();

    if (permission === 'granted') {
        // Permission granted - toggle between enabled/disabled
        const isCurrentlyEnabled = localStorage.getItem('mc_notifications_enabled') === 'true';

        if (isCurrentlyEnabled) {
            // Turn OFF
            localStorage.setItem('mc_notifications_enabled', 'false');
            updateNotificationToggleUI();
            showNotification(t('settings.notif.toast.disabled'), 'info');
        } else {
            // Turn ON
            localStorage.setItem('mc_notifications_enabled', 'true');
            updateNotificationToggleUI();
            showNotification(t('settings.notif.toast.enabled'), 'success');
        }
    } else if (permission === 'denied') {
        // Blocked - show help message
        showNotification(t('settings.notif.toast.blocked_help'), 'warning');
    } else {
        // Not yet requested - ask for permission
        await requestNotificationPermission();
    }
}

// =============================================================================
// Contacts Settings (Settings modal → Contacts tab)
// =============================================================================

window.contactsSettings = {
    manual_add_contacts: false,
    suppress_advert_notifications: false,
    auto_ignore_new_adverts: false,
};

async function loadContactsSettings() {
    try {
        const resp = await fetch('/api/contacts/settings');
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.success) return;
        const s = data.settings || {};
        window.contactsSettings = {
            manual_add_contacts: !!s.manual_add_contacts,
            suppress_advert_notifications: !!s.suppress_advert_notifications,
            auto_ignore_new_adverts: !!s.auto_ignore_new_adverts,
        };
        const m = document.getElementById('settManualApproval');
        const s1 = document.getElementById('settSuppressAdvertNotifs');
        const s2 = document.getElementById('settAutoIgnoreAdverts');
        if (m) m.checked = window.contactsSettings.manual_add_contacts;
        if (s1) s1.checked = window.contactsSettings.suppress_advert_notifications;
        if (s2) s2.checked = window.contactsSettings.auto_ignore_new_adverts;
        applyContactsSettingsEnableState(window.contactsSettings.manual_add_contacts);
        // If suppress was just turned on while page open, clear the FAB badge now
        if (window.contactsSettings.suppress_advert_notifications) {
            updateFabBadge('.fab-contacts', 'fab-badge-pending', 0);
        }
    } catch (e) {
        console.error('Error loading contacts settings:', e);
    }
}

function applyContactsSettingsEnableState(manualOn) {
    const s1 = document.getElementById('settSuppressAdvertNotifs');
    const s2 = document.getElementById('settAutoIgnoreAdverts');
    const l1 = document.getElementById('settSuppressAdvertNotifsLabel');
    const l2 = document.getElementById('settAutoIgnoreAdvertsLabel');
    [s1, s2].forEach(el => {
        if (!el) return;
        el.disabled = !manualOn;
    });
    [l1, l2].forEach(el => {
        if (!el) return;
        el.classList.toggle('text-muted', !manualOn);
    });
}

async function saveContactsSetting(key, value, inputEl) {
    try {
        const resp = await fetch('/api/contacts/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            if (inputEl) inputEl.checked = !value;
            showNotification(data.error || t('settings.toast.setting_save_failed'), 'danger');
            return;
        }
        window.contactsSettings[key] = !!value;
        if (key === 'manual_add_contacts') {
            applyContactsSettingsEnableState(!!value);
        }
        if (key === 'suppress_advert_notifications' && value) {
            updateFabBadge('.fab-contacts', 'fab-badge-pending', 0);
        }
        if (key === 'suppress_advert_notifications' && !value) {
            // Re-fetch real count when re-enabling notifications
            updatePendingContactsBadge();
        }
    } catch (e) {
        console.error('Error saving contacts setting:', e);
        if (inputEl) inputEl.checked = !value;
        showNotification(t('settings.toast.setting_network_error'), 'danger');
    }
}

// ================================================================
// Region Registry (Settings > Channels)
// ================================================================

// Mirrors the firmware RegionMap::is_name_char rule: '-', '$', '#',
// digits, or any byte >= 'A'. UTF-8 bytes >= 0x80 pass via byte >= 'A'.
function isValidRegionName(name) {
    if (!name || typeof name !== 'string') return false;
    const bytes = new TextEncoder().encode(name);
    if (bytes.length === 0 || bytes.length > 30) return false;
    for (const b of bytes) {
        if (b === 0x2d || b === 0x24 || b === 0x23) continue;  // - $ #
        if (b >= 0x30 && b <= 0x39) continue;                   // digits
        if (b >= 0x41) continue;                                // >= 'A'
        return false;
    }
    return true;
}

async function loadRegions() {
    const listEl = document.getElementById('regionsList');
    if (!listEl) return;
    try {
        const resp = await fetch('/api/regions');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        window.regionRegistry = data.regions || [];
        renderRegionsList();
    } catch (e) {
        console.error('Error loading regions:', e);
        listEl.innerHTML = `<div class="text-center text-danger small py-2">${tHtml('settings.regions.load_failed')}</div>`;
    }
}

function renderRegionsList() {
    const listEl = document.getElementById('regionsList');
    if (!listEl) return;
    const regions = window.regionRegistry || [];
    if (regions.length === 0) {
        listEl.innerHTML = `<div class="text-center text-muted small py-3">${tHtml('settings.regions.empty')}</div>`;
        return;
    }
    const noDefault = !regions.some(r => r.is_default);
    const noneRow = `
        <div class="list-group-item d-flex align-items-center gap-2 py-2">
            <div class="form-check mb-0">
                <input class="form-check-input" type="radio" name="regionDefault"
                       id="regionDefault_none" ${noDefault ? 'checked' : ''}
                       onchange="clearDefaultRegion()">
            </div>
            <div class="flex-grow-1 text-muted">
                <i class="bi bi-dash-circle"></i> ${tHtml('settings.regions.none_row')}
            </div>
        </div>
    `;
    const regionRows = regions.map(r => {
        const isDefault = r.is_default ? 'checked' : '';
        const keyShort = (r.key_hex || '').slice(0, 8) + '…';
        return `
            <div class="list-group-item d-flex align-items-center gap-2 py-2">
                <div class="form-check mb-0">
                    <input class="form-check-input" type="radio" name="regionDefault"
                           id="regionDefault_${r.id}" ${isDefault}
                           onchange="setDefaultRegion(${r.id})">
                </div>
                <div class="flex-grow-1">
                    <div><strong>${escapeHtml(r.name)}</strong></div>
                    <code class="small text-muted" title="${escapeHtml(r.key_hex)}">${keyShort}</code>
                </div>
                <button type="button" class="btn btn-sm btn-outline-danger"
                        onclick="deleteRegion(${r.id}, '${escapeHtml(r.name).replace(/'/g, "\\'")}')"
                        title="${tHtml('settings.regions.delete_title')}">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `;
    }).join('');
    listEl.innerHTML = noneRow + regionRows;
}

async function addRegion(name, inputEl) {
    if (!isValidRegionName(name)) {
        showNotification(t('settings.regions.toast.name_invalid'), 'warning');
        return;
    }
    try {
        const resp = await fetch('/api/regions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('settings.regions.toast.add_failed'), 'danger');
            return;
        }
        if (inputEl) inputEl.value = '';
        await loadRegions();
    } catch (e) {
        console.error('Error adding region:', e);
        showNotification(t('settings.regions.toast.add_error'), 'danger');
    }
}

async function deleteRegion(id, name) {
    if (!confirm(t('settings.regions.confirm.delete', { name }))) return;
    try {
        const resp = await fetch(`/api/regions/${id}`, { method: 'DELETE' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('settings.regions.toast.delete_failed'), 'danger');
            return;
        }
        await loadRegions();
    } catch (e) {
        console.error('Error deleting region:', e);
        showNotification(t('settings.regions.toast.delete_error'), 'danger');
    }
}

async function setDefaultRegion(id) {
    try {
        const resp = await fetch(`/api/regions/${id}/default`, { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('settings.regions.toast.default_failed'), 'danger');
            await loadRegions();  // snap UI back to server truth
            return;
        }
        if (data.warning) {
            showNotification(data.warning, 'warning');
        }
        // Update the local cache in place so radio stays checked without flicker.
        (window.regionRegistry || []).forEach(r => { r.is_default = (r.id === id) ? 1 : 0; });
    } catch (e) {
        console.error('Error setting default region:', e);
        showNotification(t('settings.regions.toast.default_error'), 'danger');
        await loadRegions();
    }
}

async function clearDefaultRegion() {
    try {
        const resp = await fetch('/api/regions/default', { method: 'DELETE' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('settings.regions.toast.clear_failed'), 'danger');
            await loadRegions();  // snap UI back to server truth
            return;
        }
        if (data.warning) {
            showNotification(data.warning, 'warning');
        }
        (window.regionRegistry || []).forEach(r => { r.is_default = 0; });
    } catch (e) {
        console.error('Error clearing default region:', e);
        showNotification(t('settings.regions.toast.clear_error'), 'danger');
        await loadRegions();
    }
}

// ================================================================
// Analyzers (Settings > Analyzer + group chat View in Analyzer button)
// ================================================================

const ANALYZER_PLACEHOLDER = '{packetHash}';
window.analyzerCache = window.analyzerCache || {
    analyzers: [],
    loaded: false,
};

function substituteAnalyzerUrl(template, packetHash) {
    return (template || '').replaceAll(ANALYZER_PLACEHOLDER, packetHash || '');
}

// Bootstrap stacks modal backdrops at z-index 1050 by default, which sits
// below an already-open modal (1055). Bump the latest backdrop above the
// underlying modal so our stacked dialog actually dims the page.
function _bumpAnalyzerBackdrop() {
    const backdrops = document.querySelectorAll('.modal-backdrop');
    if (backdrops.length > 0) {
        backdrops[backdrops.length - 1].style.zIndex = '1075';
    }
}

async function loadAnalyzers() {
    try {
        const resp = await fetch('/api/analyzers');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        window.analyzerCache.analyzers = data.analyzers || [];
        window.analyzerCache.loaded = true;
        renderAnalyzersList();
    } catch (e) {
        console.error('Error loading analyzers:', e);
        const listEl = document.getElementById('analyzersList');
        if (listEl) {
            listEl.innerHTML = `<div class="text-center text-danger small py-2">${tHtml('analyzer.load_failed')}</div>`;
        }
    }
}

function renderAnalyzersList() {
    const listEl = document.getElementById('analyzersList');
    if (!listEl) return;
    const analyzers = window.analyzerCache.analyzers || [];

    if (analyzers.length === 0) {
        listEl.innerHTML =
            `<div class="text-center text-muted small py-3">${tHtml('analyzer.empty')}</div>`;
        return;
    }

    const rows = analyzers.map(a => {
        const disabled = !!a.is_disabled;
        const enabled = !disabled;
        const isDefault = !!a.is_default;
        const starIcon = isDefault ? 'bi-star-fill text-warning' : 'bi-star';
        const disabledBadge = disabled
            ? `<span class="badge bg-secondary ms-1">${tHtml('common.disabled')}</span>` : '';
        const nameClass = disabled ? 'text-muted text-decoration-line-through' : '';
        const safeName = escapeHtml(a.name);
        return `
            <div class="list-group-item d-flex align-items-center gap-2 py-2">
                <button type="button" class="btn btn-link p-0 text-decoration-none"
                        onclick="toggleAnalyzerDefault(${a.id}, ${isDefault})"
                        title="${tHtml(isDefault ? 'analyzer.clear_default_title' : 'analyzer.set_default_title')}">
                    <i class="bi ${starIcon}"></i>
                </button>
                <div class="flex-grow-1" style="min-width: 0;">
                    <div class="${nameClass}"><strong>${safeName}</strong>${disabledBadge}</div>
                    <code class="small text-muted text-break" style="word-break: break-all;">${escapeHtml(a.url_template)}</code>
                </div>
                <div class="form-check form-switch mb-0" title="${tHtml(enabled ? 'common.enabled' : 'common.disabled')}">
                    <input class="form-check-input" type="checkbox"
                           id="analyzerEnabled_${a.id}" ${enabled ? 'checked' : ''}
                           onchange="toggleAnalyzerDisabled(${a.id}, !this.checked)">
                </div>
                <button type="button" class="btn btn-sm btn-outline-secondary"
                        onclick="openAnalyzerEditModal(${a.id})" title="${tHtml('common.edit')}">
                    <i class="bi bi-pencil"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-danger"
                        onclick="deleteAnalyzer(${a.id}, '${safeName.replace(/'/g, "\\'")}')" title="${tHtml('common.delete')}">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `;
    }).join('');

    listEl.innerHTML = rows;
}

function openAnalyzerEditModal(id) {
    const modalEl = document.getElementById('analyzerEditModal');
    if (!modalEl) return;
    const titleEl = document.getElementById('analyzerEditModalTitle');
    const idEl = document.getElementById('analyzerEditId');
    const nameEl = document.getElementById('analyzerEditName');
    const urlEl = document.getElementById('analyzerEditUrl');
    const enabledEl = document.getElementById('analyzerEditEnabled');
    const errorEl = document.getElementById('analyzerEditError');

    errorEl.classList.add('d-none');
    errorEl.textContent = '';

    if (id) {
        const a = (window.analyzerCache.analyzers || []).find(x => x.id === id);
        if (!a) return;
        titleEl.textContent = t('analyzer.edit');
        idEl.value = String(a.id);
        nameEl.value = a.name || '';
        urlEl.value = a.url_template || '';
        enabledEl.checked = !a.is_disabled;
    } else {
        titleEl.textContent = t('analyzer.add');
        idEl.value = '';
        nameEl.value = '';
        urlEl.value = '';
        enabledEl.checked = true;
    }

    modalEl.addEventListener('shown.bs.modal', _bumpAnalyzerBackdrop, { once: true });
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

async function saveAnalyzerFromForm() {
    const idEl = document.getElementById('analyzerEditId');
    const nameEl = document.getElementById('analyzerEditName');
    const urlEl = document.getElementById('analyzerEditUrl');
    const enabledEl = document.getElementById('analyzerEditEnabled');
    const errorEl = document.getElementById('analyzerEditError');

    const id = idEl.value ? parseInt(idEl.value, 10) : null;
    const name = (nameEl.value || '').trim();
    const url_template = (urlEl.value || '').trim();
    const is_disabled = !enabledEl.checked;

    if (!name) {
        showAnalyzerFormError(t('analyzer.name_required'));
        return;
    }
    if (!url_template.startsWith('http://') && !url_template.startsWith('https://')) {
        showAnalyzerFormError(t('analyzer.url_invalid'));
        return;
    }
    if (!url_template.includes(ANALYZER_PLACEHOLDER)) {
        showAnalyzerFormError(t('analyzer.url_placeholder_missing', { placeholder: ANALYZER_PLACEHOLDER }));
        return;
    }

    try {
        const url = id ? `/api/analyzers/${id}` : '/api/analyzers';
        const method = id ? 'PUT' : 'POST';
        const body = id ? { name, url_template, is_disabled } : { name, url_template };
        const resp = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showAnalyzerFormError(data.error || t('analyzer.toast.save_failed'));
            return;
        }
        // If creating a new analyzer with disabled=true, push the flag in a follow-up PUT.
        if (!id && is_disabled && data.analyzer) {
            await fetch(`/api/analyzers/${data.analyzer.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_disabled: true }),
            });
        }
        errorEl.classList.add('d-none');
        bootstrap.Modal.getInstance(document.getElementById('analyzerEditModal'))?.hide();
        await loadAnalyzers();
    } catch (e) {
        console.error('Error saving analyzer:', e);
        showAnalyzerFormError(t('analyzer.toast.save_error'));
    }
}

function showAnalyzerFormError(msg) {
    const errorEl = document.getElementById('analyzerEditError');
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.remove('d-none');
}

async function deleteAnalyzer(id, name) {
    if (!confirm(t('analyzer.confirm.delete', { name }))) return;
    try {
        const resp = await fetch(`/api/analyzers/${id}`, { method: 'DELETE' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('analyzer.toast.delete_failed'), 'danger');
            return;
        }
        await loadAnalyzers();
    } catch (e) {
        console.error('Error deleting analyzer:', e);
        showNotification(t('analyzer.toast.delete_error'), 'danger');
    }
}

async function toggleAnalyzerDefault(id, currentlyDefault) {
    try {
        const url = currentlyDefault ? '/api/analyzers/default' : `/api/analyzers/${id}/default`;
        const method = currentlyDefault ? 'DELETE' : 'POST';
        const resp = await fetch(url, { method });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('analyzer.toast.default_failed'), 'danger');
            await loadAnalyzers();
            return;
        }
        await loadAnalyzers();
    } catch (e) {
        console.error('Error toggling analyzer default:', e);
        showNotification(t('analyzer.toast.default_error'), 'danger');
        await loadAnalyzers();
    }
}

async function toggleAnalyzerDisabled(id, disabled) {
    try {
        const resp = await fetch(`/api/analyzers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_disabled: !!disabled }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('analyzer.toast.update_failed'), 'danger');
            await loadAnalyzers();
            return;
        }
        await loadAnalyzers();
    } catch (e) {
        console.error('Error toggling analyzer disabled:', e);
        showNotification(t('analyzer.toast.update_error'), 'danger');
        await loadAnalyzers();
    }
}

function getEnabledCustomAnalyzers() {
    return (window.analyzerCache.analyzers || []).filter(a => !a.is_disabled);
}

async function ensureAnalyzersLoaded() {
    if (!window.analyzerCache.loaded) {
        await loadAnalyzers();
    }
}

async function openMessageAnalyzer(packetHash) {
    if (!packetHash) return;
    await ensureAnalyzersLoaded();

    const enabled = getEnabledCustomAnalyzers();

    // Nothing enabled — user has deliberately turned everything off or deleted it.
    if (enabled.length === 0) {
        showNotification(t('analyzer.toast.none_configured'), 'warning');
        return;
    }

    // Default exists and is enabled — open it directly.
    const defaultRow = enabled.find(a => a.is_default);
    if (defaultRow) {
        window.open(substituteAnalyzerUrl(defaultRow.url_template, packetHash), 'meshcore-analyzer');
        return;
    }

    // Only one enabled analyzer — open it directly, no need to ask.
    if (enabled.length === 1) {
        window.open(substituteAnalyzerUrl(enabled[0].url_template, packetHash), 'meshcore-analyzer');
        return;
    }

    // Multiple enabled, no default — show chooser.
    openAnalyzerChooser(packetHash, enabled);
}

function openAnalyzerChooser(packetHash, enabled) {
    const modalEl = document.getElementById('analyzerChooserModal');
    const listEl = document.getElementById('analyzerChooserList');
    if (!modalEl || !listEl) return;

    const sorted = (enabled || []).slice().sort((a, b) =>
        (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );

    listEl.innerHTML = sorted.map(a => `
        <button type="button" class="list-group-item list-group-item-action"
                data-url="${escapeHtml(substituteAnalyzerUrl(a.url_template, packetHash))}">
            <i class="bi bi-clipboard-data"></i> ${escapeHtml(a.name)}
        </button>
    `).join('');

    const modal = bootstrap.Modal.getOrCreateInstance(modalEl);

    listEl.querySelectorAll('button[data-url]').forEach(btn => {
        btn.addEventListener('click', () => {
            window.open(btn.getAttribute('data-url'), 'meshcore-analyzer');
            modal.hide();
        }, { once: true });
    });

    modalEl.addEventListener('shown.bs.modal', _bumpAnalyzerBackdrop, { once: true });
    modal.show();
}

// ================================================================
// Observer (Settings > Observer): MQTT packet capture
// ================================================================

window.observerCache = window.observerCache || {
    status: null,
    brokers: [],
};

async function loadObserverTab() {
    try {
        const resp = await fetch('/api/observer/status');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        window.observerCache.status = data.status;
        window.observerCache.brokers = data.status.brokers || [];
        renderObserverSettings(data.status);
        renderObserverBrokers();
        renderObserverStatusLine(data.status);
    } catch (e) {
        console.error('Error loading observer status:', e);
        const listEl = document.getElementById('observerBrokersList');
        if (listEl) {
            listEl.innerHTML = `<div class="text-center text-danger small py-2">${tHtml('observer.load_failed')}</div>`;
        }
    }
}

function renderObserverSettings(status) {
    const s = status.settings || {};
    const enabledEl = document.getElementById('observerEnabledToggle');
    const iataEl = document.getElementById('observerIataInput');
    const advertEl = document.getElementById('observerAdvertIntervalInput');
    if (enabledEl) enabledEl.checked = !!s.enabled;
    // Don't clobber a field the user is typing in
    if (iataEl && document.activeElement !== iataEl) iataEl.value = (s.iata || '').toUpperCase();
    if (advertEl && document.activeElement !== advertEl) advertEl.value = s.advert_interval_hours || 0;
}

function renderObserverStatusLine(status) {
    const el = document.getElementById('observerStatusLine');
    if (!el || !status) return;
    if (!status.enabled) {
        el.innerHTML = tHtml('observer.off');
        return;
    }
    const state = status.running
        ? `<span class="badge bg-success">${tHtml('observer.state.running')}</span>`
        : `<span class="badge bg-warning text-dark">${tHtml('observer.state.waiting')}</span> ${escapeHtml(status.reason || '')}`;
    el.innerHTML = `${state} &mdash; ` + tHtml('observer.counters', {
        seen: status.packets_seen ?? 0,
        published: status.packets_published ?? 0,
    });
}

function observerBrokerBadgeParts(b) {
    if (b.connected) return { cls: 'bg-success', txt: tHtml('observer.state.connected'), title: '' };
    if (b.last_error) return { cls: 'bg-danger', txt: tHtml('observer.state.error'), title: b.last_error };
    return { cls: 'bg-secondary', txt: tHtml('observer.state.offline'), title: '' };
}

function renderObserverBrokers() {
    const listEl = document.getElementById('observerBrokersList');
    if (!listEl) return;
    const brokers = window.observerCache.brokers || [];

    if (brokers.length === 0) {
        listEl.innerHTML =
            `<div class="text-center text-muted small py-3">${tHtml('observer.empty')}</div>`;
        return;
    }

    const rows = brokers.map(b => {
        const enabled = !b.is_disabled;
        const nameClass = enabled ? '' : 'text-muted text-decoration-line-through';
        const safeName = escapeHtml(b.name);
        const tlsBadge = b.use_tls ? '<span class="badge bg-info text-dark ms-1">TLS</span>' : '';
        const badge = b.is_disabled
            ? `<span class="badge bg-secondary ms-1">${tHtml('common.disabled')}</span>`
            : (() => {
                const p = observerBrokerBadgeParts(b);
                return `<span class="badge ${p.cls} ms-1" id="observerBrokerBadge_${b.id}" title="${escapeHtml(p.title)}">${p.txt}</span>`;
            })();
        const userInfo = b.username ? `${escapeHtml(b.username)}@` : '';
        return `
            <div class="list-group-item d-flex align-items-center gap-2 py-2">
                <div class="flex-grow-1" style="min-width: 0;">
                    <div class="${nameClass}"><strong>${safeName}</strong>${tlsBadge}${badge}</div>
                    <code class="small text-muted text-break" style="word-break: break-all;">${userInfo}${escapeHtml(b.host)}:${b.port}</code>
                </div>
                <div class="form-check form-switch mb-0" title="${tHtml(enabled ? 'common.enabled' : 'common.disabled')}">
                    <input class="form-check-input" type="checkbox" ${enabled ? 'checked' : ''}
                           onchange="toggleObserverBrokerDisabled(${b.id}, !this.checked)">
                </div>
                <button type="button" class="btn btn-sm btn-outline-secondary"
                        onclick="openObserverBrokerModal(${b.id})" title="${tHtml('common.edit')}">
                    <i class="bi bi-pencil"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-danger"
                        onclick="deleteObserverBroker(${b.id}, '${safeName.replace(/'/g, "\\'")}')" title="${tHtml('common.delete')}">
                    <i class="bi bi-trash"></i>
                </button>
            </div>
        `;
    }).join('');

    listEl.innerHTML = rows;
}

// Live updates pushed by the backend (observer_status socket event).
// Payload has no settings/broker rows — only counters + per-client state.
function applyObserverLiveStatus(live) {
    renderObserverStatusLine({ ...live, settings: undefined });
    (live.brokers || []).forEach(b => {
        const badge = document.getElementById(`observerBrokerBadge_${b.id}`);
        if (!badge) return;
        const p = observerBrokerBadgeParts(b);
        badge.className = `badge ${p.cls} ms-1`;
        badge.textContent = p.txt;
        badge.title = p.title;
    });
}

function openObserverBrokerModal(id) {
    const modalEl = document.getElementById('observerBrokerEditModal');
    if (!modalEl) return;
    const titleEl = document.getElementById('observerBrokerEditModalTitle');
    const idEl = document.getElementById('observerBrokerEditId');
    const nameEl = document.getElementById('observerBrokerEditName');
    const hostEl = document.getElementById('observerBrokerEditHost');
    const portEl = document.getElementById('observerBrokerEditPort');
    const userEl = document.getElementById('observerBrokerEditUsername');
    const passEl = document.getElementById('observerBrokerEditPassword');
    const passHintEl = document.getElementById('observerBrokerPasswordHint');
    const tlsEl = document.getElementById('observerBrokerEditTls');
    const tlsVerifyEl = document.getElementById('observerBrokerEditTlsVerify');
    const enabledEl = document.getElementById('observerBrokerEditEnabled');
    const errorEl = document.getElementById('observerBrokerEditError');

    errorEl.classList.add('d-none');
    errorEl.textContent = '';
    passEl.value = '';

    if (id) {
        const b = (window.observerCache.brokers || []).find(x => x.id === id);
        if (!b) return;
        titleEl.textContent = t('observer.edit_broker');
        idEl.value = String(b.id);
        nameEl.value = b.name || '';
        hostEl.value = b.host || '';
        portEl.value = b.port || 1883;
        userEl.value = b.username || '';
        tlsEl.checked = !!b.use_tls;
        tlsVerifyEl.checked = !!b.tls_verify;
        enabledEl.checked = !b.is_disabled;
        passHintEl.classList.toggle('d-none', !b.has_password);
    } else {
        titleEl.textContent = t('observer.add_broker');
        idEl.value = '';
        nameEl.value = '';
        hostEl.value = '';
        portEl.value = 1883;
        userEl.value = '';
        tlsEl.checked = false;
        tlsVerifyEl.checked = true;
        enabledEl.checked = true;
        passHintEl.classList.add('d-none');
    }

    modalEl.addEventListener('shown.bs.modal', _bumpAnalyzerBackdrop, { once: true });
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function showObserverBrokerFormError(msg) {
    const errorEl = document.getElementById('observerBrokerEditError');
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.remove('d-none');
}

async function saveObserverBrokerFromForm() {
    const id = document.getElementById('observerBrokerEditId').value
        ? parseInt(document.getElementById('observerBrokerEditId').value, 10) : null;
    const name = (document.getElementById('observerBrokerEditName').value || '').trim();
    const host = (document.getElementById('observerBrokerEditHost').value || '').trim();
    const port = parseInt(document.getElementById('observerBrokerEditPort').value || '1883', 10);
    const username = (document.getElementById('observerBrokerEditUsername').value || '').trim();
    const password = document.getElementById('observerBrokerEditPassword').value;
    const use_tls = document.getElementById('observerBrokerEditTls').checked;
    const tls_verify = document.getElementById('observerBrokerEditTlsVerify').checked;
    const is_disabled = !document.getElementById('observerBrokerEditEnabled').checked;

    if (!name) { showObserverBrokerFormError(t('observer.name_required')); return; }
    if (!host) { showObserverBrokerFormError(t('observer.host_required')); return; }
    if (!(port >= 1 && port <= 65535)) { showObserverBrokerFormError(t('observer.port_invalid')); return; }

    const body = { name, host, port, username, use_tls, tls_verify, is_disabled };
    // Edit mode: an empty password field means "keep the stored password"
    if (!id || password !== '') body.password = password;

    try {
        const url = id ? `/api/observer/brokers/${id}` : '/api/observer/brokers';
        const resp = await fetch(url, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showObserverBrokerFormError(data.error || t('observer.toast.save_failed'));
            return;
        }
        bootstrap.Modal.getInstance(document.getElementById('observerBrokerEditModal'))?.hide();
        // Reload once now and once after the reconnect settles
        await loadObserverTab();
        setTimeout(loadObserverTab, 1500);
    } catch (e) {
        console.error('Error saving observer broker:', e);
        showObserverBrokerFormError(t('observer.toast.save_error'));
    }
}

async function deleteObserverBroker(id, name) {
    if (!confirm(t('observer.confirm.delete', { name }))) return;
    try {
        const resp = await fetch(`/api/observer/brokers/${id}`, { method: 'DELETE' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('observer.toast.delete_failed'), 'danger');
            return;
        }
        await loadObserverTab();
    } catch (e) {
        console.error('Error deleting observer broker:', e);
        showNotification(t('observer.toast.delete_error'), 'danger');
    }
}

async function toggleObserverBrokerDisabled(id, disabled) {
    try {
        const resp = await fetch(`/api/observer/brokers/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_disabled: !!disabled }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('observer.toast.update_failed'), 'danger');
        }
    } catch (e) {
        console.error('Error toggling observer broker:', e);
        showNotification(t('observer.toast.update_error'), 'danger');
    }
    await loadObserverTab();
    setTimeout(loadObserverTab, 1500);
}

async function saveObserverSettings(patch) {
    try {
        const resp = await fetch('/api/observer/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('observer.toast.settings_failed'), 'danger');
            await loadObserverTab();
            return;
        }
        // The reload runs on a backend thread; refresh after it settles
        setTimeout(loadObserverTab, 1500);
    } catch (e) {
        console.error('Error saving observer settings:', e);
        showNotification(t('observer.toast.settings_error'), 'danger');
    }
}

// ================================================================
// Diagnostics (Settings > Diagnostics) — support capture
// ================================================================

window.diagCache = { status: null, captures: [], upload: null, options: null };
let _diagPollTimer = null;

function diagFormatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function diagFormatDuration(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function loadDiagnosticsTab() {
    try {
        const resp = await fetch('/api/diagnostics/status');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Failed');
        window.diagCache = {
            status: data.status,
            captures: data.captures || [],
            upload: data.upload || {},
            options: data.options || {},
        };
        renderDiagnostics();
        syncDiagPolling();
    } catch (e) {
        console.error('Error loading diagnostics status:', e);
        const listEl = document.getElementById('diagCapturesList');
        if (listEl) {
            listEl.innerHTML = `<div class="text-center text-danger small py-2">${tHtml('diag.load_failed')}</div>`;
        }
    }
}

function renderDiagnostics() {
    const { status, options, upload } = window.diagCache;
    const recording = !!(status && status.recording);

    document.getElementById('diagIdleControls')?.classList.toggle('d-none', recording);
    document.getElementById('diagRecordingControls')?.classList.toggle('d-none', !recording);
    updateDiagRecordingIndicator(recording);

    const durationEl = document.getElementById('diagDurationSelect');
    if (durationEl && !durationEl.options.length && options?.durations) {
        durationEl.innerHTML = options.durations.map(min =>
            `<option value="${min}"${min === options.default_duration_min ? ' selected' : ''}>` +
            `${tHtml('diag.minutes', { n: min })}</option>`).join('');
    }

    if (recording) renderDiagLiveCounters(status);
    renderDiagCaptures();

    const urlEl = document.getElementById('diagUploadUrlInput');
    const hintEl = document.getElementById('diagTokenHint');
    if (urlEl && document.activeElement !== urlEl) urlEl.value = upload?.url || '';
    if (hintEl) {
        hintEl.textContent = upload?.has_token
            ? t('diag.token_set') : t('diag.token_missing');
    }
}

function renderDiagLiveCounters(status) {
    const el = document.getElementById('diagLiveCounters');
    if (el) {
        el.innerHTML = tHtml('diag.counters', {
            elapsed: diagFormatDuration(status.elapsed_sec),
            total: diagFormatDuration(status.max_seconds),
            events: formatInt(status.events || 0),
            size: diagFormatBytes(status.bytes || 0),
        }) + (status.dropped ? ` <span class="text-warning">${tHtml('diag.dropped', { n: status.dropped })}</span>` : '');
    }
    const bar = document.getElementById('diagProgressBar');
    if (bar && status.max_seconds) {
        // Whichever cap fills first is the one worth showing.
        const byTime = status.elapsed_sec / status.max_seconds;
        const bySize = status.max_bytes ? (status.bytes / status.max_bytes) : 0;
        bar.style.width = `${Math.min(100, Math.max(byTime, bySize) * 100).toFixed(1)}%`;
    }
}

function updateDiagRecordingIndicator(recording) {
    const el = document.getElementById('diagRecordingIndicator');
    if (el) el.classList.toggle('d-none', !recording);
}

function renderDiagCaptures() {
    const listEl = document.getElementById('diagCapturesList');
    if (!listEl) return;
    const captures = window.diagCache.captures || [];

    if (captures.length === 0) {
        listEl.innerHTML = `<div class="text-center text-muted small py-3">${tHtml('diag.no_captures')}</div>`;
        return;
    }

    listEl.innerHTML = captures.map(c => {
        const safeId = escapeHtml(c.id);
        const shared = c.shared_url
            ? `<div class="small"><a href="${escapeHtml(c.shared_url)}" target="_blank" rel="noopener"
                   class="text-break">${escapeHtml(c.shared_url)}</a></div>`
            : '';
        return `
            <div class="list-group-item py-2">
                <div class="d-flex align-items-center gap-2">
                    <div class="flex-grow-1" style="min-width: 0;">
                        <div class="small"><strong>${escapeHtml(formatTimestamp(c.created_at, { absolute: true }))}</strong></div>
                        <div class="small text-muted">${diagFormatBytes(c.size_bytes)}</div>
                        ${shared}
                    </div>
                    <a class="btn btn-sm btn-outline-secondary" title="${tHtml('diag.download')}"
                       href="/api/diagnostics/captures/${encodeURIComponent(c.id)}/download">
                        <i class="bi bi-download"></i>
                    </a>
                    <button type="button" class="btn btn-sm btn-outline-primary" title="${tHtml('diag.upload')}"
                            onclick="uploadDiagnosticCapture('${safeId}', this)">
                        <i class="bi bi-cloud-upload"></i>
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-danger" title="${tHtml('common.delete')}"
                            onclick="deleteDiagnosticCapture('${safeId}')">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>`;
    }).join('');
}

function syncDiagPolling() {
    const recording = !!window.diagCache.status?.recording;
    const modalOpen = document.getElementById('settingsModal')?.classList.contains('show');
    if (recording && modalOpen) {
        if (!_diagPollTimer) _diagPollTimer = setInterval(loadDiagnosticsTab, 2000);
    } else {
        stopDiagPolling();
    }
}

function stopDiagPolling() {
    if (_diagPollTimer) {
        clearInterval(_diagPollTimer);
        _diagPollTimer = null;
    }
}

async function startDiagnosticCapture() {
    const btn = document.getElementById('diagStartBtn');
    if (btn) btn.disabled = true;
    try {
        const resp = await fetch('/api/diagnostics/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                duration_min: parseInt(document.getElementById('diagDurationSelect')?.value, 10) || undefined,
                debug_logs: !!document.getElementById('diagDebugLogsToggle')?.checked,
                note: document.getElementById('diagNoteInput')?.value || '',
            }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('diag.toast.start_failed'), 'danger');
            return;
        }
        showNotification(t('diag.toast.started'), 'info');
        await loadDiagnosticsTab();
    } catch (e) {
        console.error('Error starting capture:', e);
        showNotification(t('diag.toast.start_failed'), 'danger');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function stopDiagnosticCapture() {
    const btn = document.getElementById('diagStopBtn');
    if (btn) btn.disabled = true;
    stopDiagPolling();  // the stop request blocks until the zip is written
    try {
        const resp = await fetch('/api/diagnostics/stop', { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('diag.toast.stop_failed'), 'danger');
        } else {
            showNotification(t('diag.toast.stopped'), 'info');
        }
        await loadDiagnosticsTab();
    } catch (e) {
        console.error('Error stopping capture:', e);
        showNotification(t('diag.toast.stop_failed'), 'danger');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function uploadDiagnosticCapture(captureId, btn) {
    if (!window.diagCache.upload?.has_token) {
        showNotification(t('diag.toast.no_token'), 'danger');
        return;
    }
    if (!confirm(t('diag.confirm.upload'))) return;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
    }
    try {
        const resp = await fetch(`/api/diagnostics/captures/${encodeURIComponent(captureId)}/upload`,
                                 { method: 'POST' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('diag.toast.upload_failed'), 'danger');
        } else {
            showNotification(t('diag.toast.uploaded'), 'info');
        }
        await loadDiagnosticsTab();
    } catch (e) {
        console.error('Error uploading capture:', e);
        showNotification(t('diag.toast.upload_failed'), 'danger');
        await loadDiagnosticsTab();
    }
}

async function deleteDiagnosticCapture(captureId) {
    if (!confirm(t('diag.confirm.delete'))) return;
    try {
        const resp = await fetch(`/api/diagnostics/captures/${encodeURIComponent(captureId)}`,
                                 { method: 'DELETE' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('diag.toast.delete_failed'), 'danger');
            return;
        }
        await loadDiagnosticsTab();
    } catch (e) {
        console.error('Error deleting capture:', e);
        showNotification(t('diag.toast.delete_failed'), 'danger');
    }
}

async function saveDiagnosticsUploadSettings() {
    const urlEl = document.getElementById('diagUploadUrlInput');
    const tokenEl = document.getElementById('diagUploadTokenInput');
    const payload = { url: urlEl?.value || '' };
    // Absent key keeps the stored token; the field is blank on every load
    // because the API never hands the token back.
    if (tokenEl && tokenEl.value) payload.token = tokenEl.value;
    try {
        const resp = await fetch('/api/diagnostics/upload-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('diag.toast.settings_failed'), 'danger');
            return;
        }
        if (tokenEl) tokenEl.value = '';
        showNotification(t('diag.toast.settings_saved'), 'info');
        await loadDiagnosticsTab();
    } catch (e) {
        console.error('Error saving diagnostics settings:', e);
        showNotification(t('diag.toast.settings_failed'), 'danger');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('diagStartBtn')?.addEventListener('click', startDiagnosticCapture);
    document.getElementById('diagStopBtn')?.addEventListener('click', stopDiagnosticCapture);
    document.getElementById('diagSaveUploadBtn')?.addEventListener('click', saveDiagnosticsUploadSettings);
    document.getElementById('settingsModal')?.addEventListener('hidden.bs.modal', stopDiagPolling);
});

// ================================================================
// Per-channel region picker (Manage Channels > row > pin icon)
// ================================================================

let _regionPickerChannelIdx = null;
let _regionPickerPending = null;  // region_id chosen in the radio list, null = "none"

async function openRegionPicker(channelIdx) {
    _regionPickerChannelIdx = channelIdx;

    // Ensure the registry is loaded (it may not be if user never opened Settings).
    if (!Array.isArray(window.regionRegistry)) {
        await loadRegions();
    }

    const ch = (availableChannels || []).find(c => c.index === channelIdx);
    const nameEl = document.getElementById('regionPickerChannelName');
    if (nameEl) nameEl.textContent = ch ? ch.name : `Channel ${channelIdx}`;

    const currentScope = (window.channelScopes || {})[String(channelIdx)];
    _regionPickerPending = currentScope ? currentScope.region_id : null;

    renderRegionPickerList();

    const modalEl = document.getElementById('regionPickerModal');
    // Stacked-modal fix: when opened on top of Manage Channels, bump z-index so
    // the new backdrop dims the channels modal underneath instead of sliding behind it.
    // Bootstrap reuses the same backdrop element across show/hide cycles, so we must
    // also reset its inline z-index on hide — otherwise the next non-stacked open
    // inherits z-index 1065 and the backdrop ends up above the modal, blocking clicks.
    let bumpedBackdrop = null;
    const onShown = () => {
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops.length > 1) {
            modalEl.style.zIndex = '1075';
            bumpedBackdrop = backdrops[backdrops.length - 1];
            bumpedBackdrop.style.zIndex = '1065';
        }
    };
    const onHidden = () => {
        modalEl.style.zIndex = '';
        if (bumpedBackdrop) {
            bumpedBackdrop.style.zIndex = '';
            bumpedBackdrop = null;
        }
        modalEl.removeEventListener('shown.bs.modal', onShown);
        modalEl.removeEventListener('hidden.bs.modal', onHidden);
    };
    modalEl.addEventListener('shown.bs.modal', onShown);
    modalEl.addEventListener('hidden.bs.modal', onHidden);
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

function renderRegionPickerList() {
    const listEl = document.getElementById('regionPickerList');
    if (!listEl) return;
    const regions = window.regionRegistry || [];

    if (regions.length === 0) {
        listEl.innerHTML = `
            <div class="text-center py-4 text-muted">
                <i class="bi bi-pin-map fs-3 d-block mb-2"></i>
                <p class="mb-2">${tHtml('settings.regions.picker_empty')}</p>
                <button type="button" class="btn btn-sm btn-primary" id="pickerManageRegionsBtn">
                    <i class="bi bi-gear"></i> ${tHtml('settings.regions.picker_manage')}
                </button>
            </div>
        `;
        document.getElementById('pickerManageRegionsBtn')?.addEventListener('click', () => {
            bootstrap.Modal.getOrCreateInstance(document.getElementById('regionPickerModal')).hide();
            const settingsModal = document.getElementById('settingsModal');
            bootstrap.Modal.getOrCreateInstance(settingsModal).show();
            // Activate the Channels tab after the modal is shown.
            settingsModal.addEventListener('shown.bs.modal', function onceShown() {
                settingsModal.removeEventListener('shown.bs.modal', onceShown);
                const btn = document.querySelector('[data-bs-target="#tabSettingsRegions"]');
                if (btn) bootstrap.Tab.getOrCreateInstance(btn).show();
            });
        });
        return;
    }

    const rows = [`
        <label class="list-group-item d-flex align-items-center gap-2">
            <input type="radio" name="regionPickerChoice" value="" class="form-check-input mt-0"
                   ${_regionPickerPending === null ? 'checked' : ''}>
            <span class="text-muted"><i class="bi bi-dash-circle"></i> ${tHtml('settings.regions.none_row')}</span>
        </label>
    `];
    for (const r of regions) {
        rows.push(`
            <label class="list-group-item d-flex align-items-center gap-2">
                <input type="radio" name="regionPickerChoice" value="${r.id}" class="form-check-input mt-0"
                       ${_regionPickerPending === r.id ? 'checked' : ''}>
                <span class="flex-grow-1">
                    <strong>${escapeHtml(r.name)}</strong>
                    ${r.is_default ? `<span class="badge bg-secondary ms-1">${tHtml('settings.regions.is_default')}</span>` : ''}
                </span>
            </label>
        `);
    }
    listEl.innerHTML = rows.join('');

    // Track selection so Save knows what to send.
    listEl.querySelectorAll('input[name="regionPickerChoice"]').forEach(el => {
        el.addEventListener('change', (e) => {
            const v = e.target.value;
            _regionPickerPending = v === '' ? null : parseInt(v, 10);
        });
    });
}

async function loadChannelScopes() {
    try {
        const resp = await fetch('/api/channels/scopes');
        if (!resp.ok) return;
        const data = await resp.json();
        if (data && data.success) {
            window.channelScopes = data.scopes || {};
            updateRegionIndicator();
        }
    } catch (e) {
        console.error('Error loading channel scopes:', e);
    }
}

function updateRegionIndicator() {
    const el = document.getElementById('regionIndicator');
    const nameEl = document.getElementById('regionIndicatorName');
    if (!el || !nameEl) return;
    const scope = (window.channelScopes || {})[String(currentChannelIdx)];
    el.classList.remove('d-none');
    if (scope && scope.name) {
        nameEl.textContent = scope.name;
        el.classList.remove('bg-light', 'text-secondary', 'border');
        el.classList.add('bg-info', 'text-dark');
        el.title = t('chat.region_title');
    } else {
        nameEl.textContent = t('chat.region_none');
        el.classList.remove('bg-info', 'text-dark');
        el.classList.add('bg-light', 'text-secondary', 'border');
        el.title = t('chat.region_set_title');
    }
}

async function saveChannelScope() {
    if (_regionPickerChannelIdx === null) return;
    const idx = _regionPickerChannelIdx;
    const regionId = _regionPickerPending;
    try {
        const resp = await fetch(`/api/channels/${idx}/scope`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ region_id: regionId }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.success) {
            showNotification(data.error || t('settings.regions.toast.scope_failed'), 'danger');
            return;
        }
        // Update the local cache + re-render the channels list.
        if (!window.channelScopes) window.channelScopes = {};
        if (regionId === null) {
            delete window.channelScopes[String(idx)];
        } else {
            window.channelScopes[String(idx)] = data.scope;
        }
        bootstrap.Modal.getOrCreateInstance(document.getElementById('regionPickerModal')).hide();
        if (typeof availableChannels !== 'undefined' && availableChannels.length) {
            displayChannelsList(availableChannels);
        }
        // PR #5 will also refresh the status-bar indicator here.
        if (typeof updateRegionIndicator === 'function') {
            updateRegionIndicator(currentChannelIdx);
        }
    } catch (e) {
        console.error('Error saving channel scope:', e);
        showNotification(t('settings.regions.toast.scope_error'), 'danger');
    }
}

/**
 * Send browser notification when new messages arrive
 * @param {number} channelCount - Number of channels with new messages
 * @param {number} dmCount - Number of DMs with new messages
 * @param {number} pendingCount - Number of pending contacts
 */
function sendBrowserNotification(channelCount, dmCount, pendingCount) {
    // Only send if enabled and app is hidden
    if (!areNotificationsEnabled() || document.visibilityState !== 'hidden') {
        return;
    }

    let message = '';
    const parts = [];

    if (channelCount > 0) {
        parts.push(tn('notify.channels', channelCount));
    }
    if (dmCount > 0) {
        parts.push(tn('notify.dms', dmCount));
    }
    if (pendingCount > 0) {
        parts.push(tn('notify.pending', pendingCount));
    }

    if (parts.length === 0) return;

    message = t('notify.new', { parts: parts.join(', ') });

    try {
        const notification = new Notification('mc-webui', {
            body: message,
            icon: '/static/images/android-chrome-192x192.png',
            badge: '/static/images/android-chrome-192x192.png',
            tag: 'mc-webui-updates', // Prevents spam - replaces previous notification
            requireInteraction: false, // Auto-dismiss after ~5s
            silent: false
        });

        // Click handler - bring app to focus
        notification.onclick = function() {
            window.focus();
            notification.close();
        };

    } catch (error) {
        console.error('Error sending notification:', error);
    }
}

/**
 * Track previous counts to detect NEW messages (not just unread)
 */
let previousTotalUnread = 0;
let previousDmUnread = 0;
let previousPendingCount = 0;

/**
 * Check if we should send notification based on count changes
 */
function checkAndNotify() {
    // Calculate current totals (exclude muted channels)
    let currentTotalUnread = 0;
    for (const [idx, count] of Object.entries(unreadCounts)) {
        if (!mutedChannels.has(parseInt(idx))) {
            currentTotalUnread += count;
        }
    }

    // Get DM unread count from badge
    const dmBadge = document.querySelector('.fab-badge-dm');
    const currentDmUnread = dmBadge ? parseInt(dmBadge.textContent) || 0 : 0;

    // Get pending contacts count from badge (forced to 0 when notifications are suppressed)
    const pendingBadge = document.querySelector('.fab-badge-pending');
    const rawPendingCount = pendingBadge ? parseInt(pendingBadge.textContent) || 0 : 0;
    const currentPendingCount = window.contactsSettings?.suppress_advert_notifications
        ? 0 : rawPendingCount;

    // Detect increases (new messages/contacts)
    const channelIncrease = currentTotalUnread > previousTotalUnread;
    const dmIncrease = currentDmUnread > previousDmUnread;
    const pendingIncrease = currentPendingCount > previousPendingCount;

    // Send notification if ANY category increased
    if (channelIncrease || dmIncrease || pendingIncrease) {
        const channelDelta = channelIncrease ? (currentTotalUnread - previousTotalUnread) : 0;
        const dmDelta = dmIncrease ? (currentDmUnread - previousDmUnread) : 0;
        const pendingDelta = pendingIncrease ? (currentPendingCount - previousPendingCount) : 0;

        sendBrowserNotification(channelDelta, dmDelta, pendingDelta);
    }

    // Update previous counts
    previousTotalUnread = currentTotalUnread;
    previousDmUnread = currentDmUnread;
    previousPendingCount = currentPendingCount;
}

/**
 * Update app icon badge (Android/Desktop)
 * Shows total unread count across channels + DMs + pending
 */
function updateAppBadge() {
    if (!('setAppBadge' in navigator)) {
        // Badge API not supported
        return;
    }

    // Calculate total unread (exclude muted channels)
    let channelUnread = 0;
    for (const [idx, count] of Object.entries(unreadCounts)) {
        if (!mutedChannels.has(parseInt(idx))) {
            channelUnread += count;
        }
    }

    const dmBadge = document.querySelector('.fab-badge-dm');
    const dmUnread = dmBadge ? parseInt(dmBadge.textContent) || 0 : 0;

    const pendingBadge = document.querySelector('.fab-badge-pending');
    const pendingUnread = pendingBadge ? parseInt(pendingBadge.textContent) || 0 : 0;

    const totalUnread = channelUnread + dmUnread + pendingUnread;

    if (totalUnread > 0) {
        navigator.setAppBadge(totalUnread).catch((error) => {
            console.error('Error setting app badge:', error);
        });
    } else {
        navigator.clearAppBadge().catch((error) => {
            console.error('Error clearing app badge:', error);
        });
    }
}

/**
 * Update connection status indicator
 */
function updateStatus(status) {
    const statusEl = document.getElementById('statusText');

    const icons = {
        connected: `<i class="bi bi-circle-fill status-connected"></i> ${tHtml('common.connected')}`,
        disconnected: `<i class="bi bi-circle-fill status-disconnected"></i> ${tHtml('common.disconnected')}`,
        connecting: `<i class="bi bi-circle-fill status-connecting"></i> ${tHtml('common.connecting')}`
    };

    statusEl.innerHTML = icons[status] || icons.connecting;
}

/**
 * Update last refresh timestamp
 */
function updateLastRefresh() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    document.getElementById('lastRefresh').textContent = t('chat.updated', { time: timeStr });
}

/**
 * Show notification toast
 */
function showNotification(message, type = 'info') {
    const toastEl = document.getElementById('notificationToast');
    const toastBody = toastEl.querySelector('.toast-body');

    toastBody.textContent = message;
    toastEl.className = `toast bg-${type} text-white`;

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

/**
 * Check for app updates from GitHub
 */
async function checkForAppUpdates() {
    const btn = document.getElementById('checkUpdateBtn');
    const icon = document.getElementById('checkUpdateIcon');
    const versionText = document.getElementById('versionText');

    if (!btn || !icon) return;

    // Show loading state
    btn.disabled = true;
    icon.className = 'bi bi-arrow-repeat spin';

    try {
        const response = await fetch('/api/check-update');
        const data = await response.json();

        if (data.success) {
            if (data.update_available) {
                // Check if remote update is available
                const updaterStatus = await fetch('/api/updater/status').then(r => r.json()).catch(() => ({ available: false }));

                const updateLinkContainer = document.getElementById('updateLinkContainer');
                const newVersion = `${data.latest_date}+${data.latest_commit}`;
                const githubUrl = data.github_url;
                if (updaterStatus.available) {
                    // Show "Update Now" link below version
                    if (updateLinkContainer) {
                        updateLinkContainer.innerHTML = `<a href="#" onclick="openUpdateModal('${newVersion}', '${githubUrl}'); return false;" class="text-success" title="${tHtml('update.link_now_title')}"><i class="bi bi-arrow-up-circle-fill"></i> ${tHtml('update.link_now')}</a>`;
                        updateLinkContainer.classList.remove('d-none');
                    }
                } else {
                    // Show link to GitHub (no remote update available)
                    if (updateLinkContainer) {
                        updateLinkContainer.innerHTML = `<a href="${githubUrl}" target="_blank" class="text-success" title="${tHtml('update.link_available_title', { version: newVersion })}"><i class="bi bi-arrow-up-circle-fill"></i> ${tHtml('update.link_available')}</a>`;
                        updateLinkContainer.classList.remove('d-none');
                    }
                }
                icon.className = 'bi bi-check-circle-fill text-success';
                showNotification(t('update.toast.available', { version: `${data.latest_date}+${data.latest_commit}` }), 'success');
            } else {
                // Up to date
                icon.className = 'bi bi-check-circle text-success';
                showNotification(t('update.toast.latest'), 'success');
                // Reset icon after 3 seconds
                setTimeout(() => {
                    icon.className = 'bi bi-arrow-repeat';
                }, 3000);
            }
        } else {
            // Error
            icon.className = 'bi bi-exclamation-triangle text-warning';
            showNotification(data.error || t('update.toast.check_failed'), 'warning');
            setTimeout(() => {
                icon.className = 'bi bi-arrow-repeat';
            }, 3000);
        }
    } catch (error) {
        console.error('Error checking for updates:', error);
        icon.className = 'bi bi-exclamation-triangle text-danger';
        showNotification(t('update.toast.check_error'), 'danger');
        setTimeout(() => {
            icon.className = 'bi bi-arrow-repeat';
        }, 3000);
    } finally {
        btn.disabled = false;
    }
}

// Store update info for modal
let pendingUpdateVersion = null;

/**
 * Open update modal and prepare for remote update
 */
function openUpdateModal(newVersion, githubUrl) {
    pendingUpdateVersion = newVersion;

    // Close offcanvas menu
    const offcanvas = bootstrap.Offcanvas.getInstance(document.getElementById('mainMenu'));
    if (offcanvas) offcanvas.hide();

    // Reset modal state
    document.getElementById('updateStatus').classList.remove('d-none');
    document.getElementById('updateProgress').classList.add('d-none');
    document.getElementById('updateResult').classList.add('d-none');
    document.getElementById('updateCancelBtn').classList.remove('d-none');
    document.getElementById('updateConfirmBtn').classList.remove('d-none');
    document.getElementById('updateReloadBtn').classList.add('d-none');
    document.getElementById('updateMessage').textContent = t('update.new_version', { version: newVersion });

    // Set up "What's new" link
    const whatsNewEl = document.getElementById('updateWhatsNew');
    if (whatsNewEl && githubUrl) {
        const link = whatsNewEl.querySelector('a');
        if (link) link.href = githubUrl;
        whatsNewEl.classList.remove('d-none');
    }

    // Hide spinner, show message
    document.querySelector('#updateStatus .spinner-border').classList.add('d-none');

    // Setup confirm button
    document.getElementById('updateConfirmBtn').onclick = performRemoteUpdate;

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('updateModal'));
    modal.show();
}

/**
 * Perform remote update via webhook
 */
async function performRemoteUpdate() {
    const currentVersion = document.getElementById('versionText')?.textContent?.split(' ')[0] || '';

    // Show progress state
    document.getElementById('updateStatus').classList.add('d-none');
    document.getElementById('updateProgress').classList.remove('d-none');
    document.getElementById('updateCancelBtn').classList.add('d-none');
    document.getElementById('updateConfirmBtn').classList.add('d-none');
    document.getElementById('updateProgressMessage').textContent = t('update.starting');

    try {
        // Trigger update
        const response = await fetch('/api/updater/trigger', { method: 'POST' });
        const data = await response.json();

        if (!data.success) {
            showUpdateResult(false, data.error || t('update.start_failed'));
            return;
        }

        document.getElementById('updateProgressMessage').textContent = t('update.waiting');

        // Poll for server to come back up with new version
        let attempts = 0;
        const maxAttempts = 60; // 2 minutes max
        const pollInterval = 2000; // 2 seconds

        const pollForCompletion = async () => {
            attempts++;

            try {
                const versionResponse = await fetch('/api/version', {
                    cache: 'no-store',
                    headers: { 'Cache-Control': 'no-cache' }
                });

                if (versionResponse.ok) {
                    const versionData = await versionResponse.json();
                    const newVersion = versionData.version;

                    // Check if version changed
                    if (newVersion !== currentVersion) {
                        showUpdateResult(true, t('update.done', { version: newVersion }));
                        return;
                    }
                }
            } catch (e) {
                // Server not responding yet - this is expected during restart
                document.getElementById('updateProgressMessage').textContent =
                    t('update.rebuilding', { attempt: attempts, max: maxAttempts });
            }

            if (attempts < maxAttempts) {
                setTimeout(pollForCompletion, pollInterval);
            } else {
                showUpdateResult(false, t('update.timed_out'));
            }
        };

        // Start polling after a short delay
        setTimeout(pollForCompletion, 3000);

    } catch (error) {
        console.error('Update error:', error);
        showUpdateResult(false, t('update.network_error'));
    }
}

/**
 * Show update result in modal
 */
function showUpdateResult(success, message) {
    document.getElementById('updateProgress').classList.add('d-none');
    document.getElementById('updateResult').classList.remove('d-none');

    const icon = document.getElementById('updateResultIcon');
    const msg = document.getElementById('updateResultMessage');

    if (success) {
        icon.className = 'bi bi-check-circle-fill text-success fs-1 mb-3 d-block';
        msg.className = 'mb-0 text-success';
        document.getElementById('updateReloadBtn').classList.remove('d-none');
    } else {
        icon.className = 'bi bi-x-circle-fill text-danger fs-1 mb-3 d-block';
        msg.className = 'mb-0 text-danger';
        document.getElementById('updateCancelBtn').classList.remove('d-none');
        document.getElementById('updateCancelBtn').textContent = 'Close';
    }

    msg.textContent = message;
}

// Make openUpdateModal globally accessible
window.openUpdateModal = openUpdateModal;

/**
 * Scroll to bottom of messages
 */
function scrollToBottom() {
    const container = document.getElementById('messagesContainer');
    container.scrollTop = container.scrollHeight;
}

// Breathing room above the divider, so the last already-read message stays
// visible as context instead of being cut off at the viewport edge.
const UNREAD_DIVIDER_SCROLL_MARGIN = 48;

/**
 * Build the "New messages" divider that separates read from unread.
 */
function createUnreadDivider() {
    const divider = document.createElement('div');
    divider.className = 'unread-divider';
    divider.id = 'unreadDivider';
    divider.innerHTML = `<span>${tHtml('chat.unread_divider')}</span>`;
    return divider;
}

/**
 * Scroll the channel view to the first unread message.
 * Falls back to the bottom if the divider isn't there.
 */
function scrollToUnreadDivider() {
    const container = document.getElementById('messagesContainer');
    const divider = document.getElementById('unreadDivider');
    if (!container || !divider) {
        scrollToBottom();
        return;
    }
    // Measured against the viewport rather than offsetTop: neither the scroll
    // container nor the list is a positioned ancestor, so offsetTop would be
    // relative to something else entirely.
    const delta = divider.getBoundingClientRect().top
        - container.getBoundingClientRect().top;
    // When the unread messages all fit on screen the browser clamps this to
    // the maximum, landing on the bottom — which is what we want anyway.
    container.scrollTop = Math.max(
        0,
        container.scrollTop + delta - UNREAD_DIVIDER_SCROLL_MARGIN
    );
}

/**
 * Format a message timestamp.
 * Archive views always show the full date, since "Today" is meaningless there.
 */
function formatTime(timestamp) {
    return formatTimestamp(timestamp, { absolute: !!currentArchiveDate });
}

// formatTimeAgo() comes from datetime-utils.js.

/**
 * Update character counter (counts UTF-8 bytes, not characters)
 */
function updateCharCounter() {
    const input = document.getElementById('messageInput');
    const counter = document.getElementById('charCounter');

    // Count UTF-8 bytes, not Unicode characters
    const encoder = new TextEncoder();
    const byteLength = encoder.encode(input.value).length;
    const maxBytes = 135;

    counter.textContent = `${byteLength} / ${maxBytes}`;

    // Visual warning when approaching limit
    if (byteLength >= maxBytes * 0.9) {
        counter.classList.remove('text-muted', 'text-warning');
        counter.classList.add('text-danger', 'fw-bold');
    } else if (byteLength >= maxBytes * 0.75) {
        counter.classList.remove('text-muted', 'text-danger');
        counter.classList.add('text-warning', 'fw-bold');
    } else {
        counter.classList.remove('text-warning', 'text-danger', 'fw-bold');
        counter.classList.add('text-muted');
    }
}

/**
 * Load list of available archives
 */
async function loadArchiveList() {
    try {
        const response = await fetch('/api/archives');
        const data = await response.json();

        if (data.success) {
            populateDateSelector(data.archives);
        } else {
            console.error('Error loading archives:', data.error);
        }
    } catch (error) {
        console.error('Error loading archive list:', error);
    }
}

/**
 * Populate the date selector dropdown with archive dates
 */
function populateDateSelector(archives) {
    const selector = document.getElementById('dateSelector');

    // Keep the "Today (Live)" option
    // Remove all other options
    while (selector.options.length > 1) {
        selector.remove(1);
    }

    // Add archive dates
    archives.forEach(archive => {
        const option = document.createElement('option');
        option.value = archive.date;
        option.textContent = t('menu.archive_option', { date: archive.date, count: archive.message_count });
        selector.appendChild(option);
    });

    console.log(`Loaded ${archives.length} archives`);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format a Unix timestamp for the channel list: HH:MM if today, DD.MM otherwise.
 */
function formatChannelTime(unixTimestamp) {
    if (!unixTimestamp) return '';
    const d = new Date(unixTimestamp * 1000);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}.${month}.${d.getFullYear()}`;
}

/**
 * Mirror of backend _make_preview: strip @[name] mention syntax, truncate to 60 chars with ellipsis.
 */
function makeChannelPreview(text, maxLen = 60) {
    if (!text) return '';
    const stripped = text.replace(/@\[([^\]]+)\]/g, '$1');
    if (stripped.length > maxLen) return stripped.slice(0, maxLen) + '…';
    return stripped;
}

// =============================================================================
// Avatar Generation Functions
// =============================================================================

/**
 * Generate a consistent color based on string hash
 * @param {string} str - Input string (username)
 * @returns {string} HSL color string
 */
function getAvatarColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    // Generate hue from hash (0-360), keep saturation and lightness fixed for readability
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 45%)`;
}

/**
 * Extract first emoji from a string
 * @param {string} str - Input string
 * @returns {string|null} First emoji found or null
 */
function extractFirstEmoji(str) {
    // Regex to match emojis (including compound emojis with ZWJ sequences)
    const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/u;
    const match = str.match(emojiRegex);
    return match ? match[0] : null;
}

/**
 * Get initials from a username
 * @param {string} name - Username
 * @returns {string} 1-2 character initials
 */
function getInitials(name) {
    // Remove emojis first
    const cleanName = name.replace(/(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu, '').trim();

    if (!cleanName) return '?';

    // Split by common separators (space, underscore, dash)
    const parts = cleanName.split(/[\s_\-]+/).filter(p => p.length > 0);

    if (parts.length >= 2) {
        // Two or more words: use first letter of first two words
        return (parts[0][0] + parts[1][0]).toUpperCase();
    } else if (parts.length === 1) {
        // Single word: use first letter only
        return parts[0][0].toUpperCase();
    }

    return '?';
}

/**
 * Generate avatar HTML for a username
 * @param {string} name - Username
 * @returns {object} { content: string, color: string }
 */
function generateAvatar(name) {
    const emoji = extractFirstEmoji(name);
    const color = getAvatarColor(name);

    if (emoji) {
        return { content: emoji, color: color, isEmoji: true };
    } else {
        return { content: getInitials(name), color: color, isEmoji: false };
    }
}

/**
 * Load last seen timestamps from server
 */
async function loadLastSeenTimestampsFromServer() {
    try {
        const response = await fetch('/api/read_status');
        const data = await response.json();

        if (data.success && data.channels) {
            // Convert string keys to integers for channel indices
            lastSeenTimestamps = {};
            for (const [key, value] of Object.entries(data.channels)) {
                lastSeenTimestamps[parseInt(key)] = value;
            }
            // Load muted channels
            if (data.muted_channels) {
                mutedChannels = new Set(data.muted_channels);
            }
            // Load favorite channels
            if (data.favorite_channels) {
                favoriteChannels = new Set(data.favorite_channels);
            }
            console.log('Loaded channel read status from server:', lastSeenTimestamps, 'muted:', [...mutedChannels], 'favorites:', [...favoriteChannels]);
        } else {
            console.warn('Failed to load read status from server, using empty state');
            lastSeenTimestamps = {};
        }
    } catch (error) {
        console.error('Error loading read status from server:', error);
        lastSeenTimestamps = {};
    }
}

/**
 * Save channel read status to server
 */
async function saveChannelReadStatus(channelIdx, timestamp) {
    try {
        const response = await fetch('/api/read_status/mark_read', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'channel',
                channel_idx: channelIdx,
                timestamp: timestamp
            })
        });

        const data = await response.json();

        if (!data.success) {
            console.error('Failed to save channel read status:', data.error);
        }
    } catch (error) {
        console.error('Error saving channel read status:', error);
    }
}

/**
 * Update last seen timestamp for current channel
 */
async function markChannelAsRead(channelIdx, timestamp) {
    lastSeenTimestamps[channelIdx] = timestamp;
    unreadCounts[channelIdx] = 0;
    await saveChannelReadStatus(channelIdx, timestamp);
    updateUnreadBadges();
}

/**
 * Mark all channels as read (bell icon click)
 */
async function markAllChannelsRead() {
    // Build list of channels with unread messages
    const unreadChannels = [];
    for (const [idx, count] of Object.entries(unreadCounts)) {
        if (count > 0) {
            const channel = availableChannels.find(ch => ch.index === parseInt(idx));
            const name = channel ? channel.name : t('chat.unnamed_channel', { index: idx });
            unreadChannels.push({ idx, count, name });
        }
    }

    if (unreadChannels.length === 0) return;

    // Show confirmation dialog with list of unread channels
    const channelList = unreadChannels.map(ch => `  - ${ch.name} (${ch.count})`).join('\n');
    if (!confirm(t('chat.confirm.mark_all_read', { channels: channelList }))) return;

    // Collect latest timestamps
    const now = Math.floor(Date.now() / 1000);
    const timestamps = {};

    for (const { idx } of unreadChannels) {
        timestamps[idx] = now;
        lastSeenTimestamps[parseInt(idx)] = now;
        unreadCounts[idx] = 0;
    }

    // Update UI immediately
    updateUnreadBadges();

    // Save to server
    try {
        await fetch('/api/read_status/mark_all_read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channels: timestamps })
        });
    } catch (error) {
        console.error('Error marking all as read:', error);
    }
}

/**
 * Check for new messages across all channels
 */
async function checkForUpdates() {
    // Don't check if channels aren't loaded yet
    if (!availableChannels || availableChannels.length === 0) {
        console.log('[checkForUpdates] Skipping - channels not loaded yet');
        return;
    }

    try {
        // Build query with last seen timestamps
        const lastSeenParam = encodeURIComponent(JSON.stringify(lastSeenTimestamps));

        // Add timeout to prevent hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        const response = await fetch(`/api/messages/updates?last_seen=${lastSeenParam}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`[checkForUpdates] HTTP ${response.status}: ${response.statusText}`);
            return;
        }

        const data = await response.json();

        if (data.success && data.channels) {
            // Update unread counts and last-message preview/time
            data.channels.forEach(channel => {
                unreadCounts[channel.index] = channel.unread_count;
                if (channel.last_message_preview !== undefined) {
                    channelLastMessages[channel.index] = {
                        preview: channel.last_message_preview,
                        timestamp: channel.last_message_time
                    };
                }
            });

            // Sync muted channels from server
            if (data.muted_channels) {
                mutedChannels = new Set(data.muted_channels);
            }
            // Sync favorite channels from server
            if (data.favorite_channels) {
                favoriteChannels = new Set(data.favorite_channels);
            }

            // Update UI badges
            updateUnreadBadges();

            // Re-render channel lists now that we have last-message timestamps
            // (initial paint runs before checkForUpdates returns, so the first
            // sort would otherwise be all-zeros).
            populateChannelSelector(availableChannels);

            // Check if we should send browser notification
            checkAndNotify();
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('[checkForUpdates] Request timeout after 15s');
        } else {
            console.error('[checkForUpdates] Error:', error.message || error);
        }
    }
}

/**
 * Update unread badges on channel selector and notification bell
 */
function updateUnreadBadges() {
    // Update notification bell (exclude muted channels)
    let totalUnread = 0;
    for (const [idx, count] of Object.entries(unreadCounts)) {
        if (!mutedChannels.has(parseInt(idx))) {
            totalUnread += count;
        }
    }
    updateNotificationBell(totalUnread);

    // Update app icon badge
    updateAppBadge();

    // Update channel sidebar badges (lg+ screens)
    updateChannelSidebarBadges();
}

/**
 * Update notification bell icon with unread count
 */
function updateNotificationBell(count) {
    const bellContainer = document.getElementById('notificationBell');
    if (!bellContainer) return;

    const bellIcon = bellContainer.querySelector('i');
    let badge = bellContainer.querySelector('.notification-badge');

    if (count > 0) {
        // Show badge
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'notification-badge';
            bellContainer.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'inline-block';

        // Animate bell icon
        if (bellIcon) {
            bellIcon.classList.add('bell-ring');
            setTimeout(() => bellIcon.classList.remove('bell-ring'), 1000);
        }
    } else {
        // Hide badge
        if (badge) {
            badge.style.display = 'none';
        }
    }
}

/**
 * Update FAB button badge (universal function for all FAB badges)
 * @param {string} fabSelector - CSS selector for FAB button (e.g., '.fab-dm', '.fab-contacts')
 * @param {string} badgeClass - Badge class name (e.g., 'fab-badge-dm', 'fab-badge-pending')
 * @param {number} count - Number to display (0 = hide badge)
 */
function updateFabBadge(fabSelector, badgeClass, count) {
    const fabButton = document.querySelector(fabSelector);
    if (!fabButton) return;

    let badge = fabButton.querySelector(`.${badgeClass}`);

    if (count > 0) {
        // Show badge
        if (!badge) {
            badge = document.createElement('span');
            badge.className = `fab-badge ${badgeClass}`;
            fabButton.appendChild(badge);
        }
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'inline-block';
    } else {
        // Hide badge
        if (badge) {
            badge.style.display = 'none';
        }
    }
}

/**
 * Setup emoji picker
 */
function setupEmojiPicker() {
    const emojiBtn = document.getElementById('emojiBtn');
    const emojiPickerPopup = document.getElementById('emojiPickerPopup');
    const messageInput = document.getElementById('messageInput');

    if (!emojiBtn || !emojiPickerPopup || !messageInput) {
        console.error('Emoji picker elements not found');
        return;
    }

    // Create emoji-picker element
    const picker = document.createElement('emoji-picker');
    // Use local emoji data instead of CDN
    picker.dataSource = '/static/vendor/emoji-picker-element-data/en/emojibase/data.json';
    emojiPickerPopup.appendChild(picker);

    // Toggle emoji picker on button click
    emojiBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        emojiPickerPopup.classList.toggle('hidden');
    });

    // Insert emoji into textarea when selected
    picker.addEventListener('emoji-click', function(event) {
        const emoji = event.detail.unicode;
        const cursorPos = messageInput.selectionStart;
        const textBefore = messageInput.value.substring(0, cursorPos);
        const textAfter = messageInput.value.substring(messageInput.selectionEnd);

        // Insert emoji at cursor position
        messageInput.value = textBefore + emoji + textAfter;

        // Update cursor position (after emoji)
        const newCursorPos = cursorPos + emoji.length;
        messageInput.setSelectionRange(newCursorPos, newCursorPos);

        // Update character counter
        updateCharCounter();

        // Focus back on input
        messageInput.focus();

        // Hide picker after selection
        emojiPickerPopup.classList.add('hidden');
    });

    // Close emoji picker when clicking outside
    document.addEventListener('click', function(e) {
        if (!emojiPickerPopup.contains(e.target) && e.target !== emojiBtn && !emojiBtn.contains(e.target)) {
            emojiPickerPopup.classList.add('hidden');
        }
    });
}

/**
 * Load list of available channels
 */
async function loadChannels() {
    try {
        console.log('[loadChannels] Fetching channels from API...');

        // Add timeout to prevent hanging
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

        const response = await fetch('/api/channels', {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        console.log('[loadChannels] API response:', data);

        if (data.success && data.channels && data.channels.length > 0) {
            availableChannels = data.channels;
            console.log('[loadChannels] Channels loaded:', availableChannels.length);
            populateChannelSelector(data.channels);
            // NOTE: checkForUpdates() is now called separately after messages are displayed
            // to avoid blocking the initial page load
        } else {
            console.error('[loadChannels] Error loading channels:', data.error || 'No channels returned');
            // Fallback: ensure at least Public channel exists
            ensurePublicChannel();
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('[loadChannels] Request timeout after 10s');
        } else {
            console.error('[loadChannels] Exception:', error.message || error);
        }
        // Fallback: ensure at least Public channel exists
        ensurePublicChannel();
    }
}

/**
 * Fallback: ensure Public channel exists in selector data even if API fails
 */
function ensurePublicChannel() {
    const items = window._channelDropdownItems;
    if (!items || items.length === 0) {
        console.log('[ensurePublicChannel] Adding fallback Public channel');
        availableChannels = [{index: 0, name: 'Public', key: ''}];
        populateChannelSelector(availableChannels);
    }
}

/**
 * Sort a channel array by (favorite-first, latest-message-desc, original-index).
 * Returns a new array; does not mutate the input. Channels with no recorded
 * last message fall to the bottom of their tier in original order (stable sort).
 */
function sortedChannelsByFavoriteAndActivity(channels) {
    return channels
        .map((ch, i) => ({
            ch,
            i,
            fav: favoriteChannels.has(ch.index) ? 0 : 1,
            ts: (channelLastMessages[ch.index] && channelLastMessages[ch.index].timestamp) || 0
        }))
        .sort((a, b) => (a.fav - b.fav) || (b.ts - a.ts) || (a.i - b.i))
        .map(x => x.ch);
}

/**
 * Populate channel selector data (for both mobile dropdown and wide-screen sidebar)
 */
function populateChannelSelector(channels) {
    // Validate input
    if (!channels || !Array.isArray(channels) || channels.length === 0) {
        console.warn('[populateChannelSelector] Invalid channels array, using fallback');
        channels = [{index: 0, name: 'Public', key: ''}];
    }

    // If the saved channel doesn't exist in the list, fall back to Public (0)
    if (!channels.some(c => c && c.index === currentChannelIdx)) {
        console.log(`[populateChannelSelector] Channel ${currentChannelIdx} not found, falling back to Public`);
        currentChannelIdx = 0;
        localStorage.setItem('mc_active_channel', '0');
    }

    // Save data for the mobile dropdown (sorted by favorite + latest activity)
    window._channelDropdownItems = sortedChannelsByFavoriteAndActivity(channels);

    // Pre-render dropdown contents (still hidden) and update the button label
    renderChannelDropdownItems();
    updateChannelInputDisplay();

    console.log(`[populateChannelSelector] Loaded ${channels.length} channels, active: ${currentChannelIdx}`);

    // Also populate sidebar (lg+ screens)
    populateChannelSidebar();
}

/**
 * Render channel items into the mobile dropdown.
 */
function renderChannelDropdownItems() {
    const dropdown = document.getElementById('channelSelectorDropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';

    const channels = window._channelDropdownItems || [];

    if (channels.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'channel-selector-item text-muted';
        empty.style.cursor = 'default';
        empty.textContent = t('channels.dropdown.none');
        dropdown.appendChild(empty);
        return;
    }

    channels.forEach(channel => {
        if (!channel || typeof channel.index === 'undefined' || !channel.name) return;

        const item = document.createElement('div');
        item.className = 'channel-selector-item';
        item.dataset.channelIdx = channel.index;

        if (channel.index === currentChannelIdx) {
            item.classList.add('active');
        }
        if (mutedChannels.has(channel.index)) {
            item.classList.add('muted');
        }
        if (favoriteChannels.has(channel.index)) {
            item.classList.add('is-favorite');
        }

        // Top row: name + time + unread badge
        const topRow = document.createElement('div');
        topRow.className = 'channel-item-top';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'channel-name';
        nameSpan.textContent = channel.name;
        topRow.appendChild(nameSpan);

        const lastMsg = channelLastMessages[channel.index];
        if (lastMsg && lastMsg.timestamp) {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'channel-last-time';
            timeSpan.textContent = formatChannelTime(lastMsg.timestamp);
            topRow.appendChild(timeSpan);
        }

        const unread = unreadCounts[channel.index] || 0;
        if (unread > 0 && channel.index !== currentChannelIdx && !mutedChannels.has(channel.index)) {
            const badge = document.createElement('span');
            badge.className = 'sidebar-unread-badge';
            badge.textContent = unread;
            topRow.appendChild(badge);
        }

        item.appendChild(topRow);

        // Preview row (CSS clamps to 1 line for .channel-selector-item)
        if (lastMsg && lastMsg.preview) {
            const preview = document.createElement('div');
            preview.className = 'channel-item-preview';
            preview.textContent = lastMsg.preview;
            item.appendChild(preview);
        }

        item.addEventListener('click', () => {
            selectChannelFromDropdown(channel.index, channel.name);
        });

        dropdown.appendChild(item);
    });
}

/**
 * Switch to a channel via the mobile dropdown (closes dropdown, syncs state).
 */
function selectChannelFromDropdown(idx, name) {
    currentChannelIdx = idx;
    localStorage.setItem('mc_active_channel', currentChannelIdx);

    const button = document.getElementById('channelSelectorButton');
    if (button) {
        button.textContent = name;
        button.blur();
    }
    setChannelDropdownOpen(false);

    loadMessages();
    updateChannelSidebarActive();
    showNotification(t('channels.toast.switched', { name }), 'info');
}

/**
 * Show or hide the mobile channel dropdown, keeping aria-expanded in sync.
 */
function setChannelDropdownOpen(open) {
    const dropdown = document.getElementById('channelSelectorDropdown');
    const button = document.getElementById('channelSelectorButton');
    if (dropdown) dropdown.style.display = open ? 'block' : 'none';
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * Sync the mobile selector button label with the currently active channel name.
 */
function updateChannelInputDisplay() {
    const button = document.getElementById('channelSelectorButton');
    if (!button) return;
    const channels = window._channelDropdownItems || [];
    const current = channels.find(c => c && c.index === currentChannelIdx);
    button.textContent = current ? current.name : 'Public';
}

/**
 * Load channels list in management modal
 */
async function loadChannelsList() {
    const listEl = document.getElementById('channelsList');
    listEl.innerHTML = `<div class="text-center text-muted py-3"><div class="spinner-border spinner-border-sm"></div> ${tHtml('common.loading')}</div>`;

    try {
        const [chResp, scResp] = await Promise.all([
            fetch('/api/channels'),
            fetch('/api/channels/scopes'),
        ]);
        const data = await chResp.json();
        const scData = await scResp.json().catch(() => ({}));
        window.channelScopes = (scData && scData.success) ? (scData.scopes || {}) : {};

        if (data.success) {
            displayChannelsList(data.channels);
        } else {
            listEl.innerHTML = `<div class="alert alert-danger">${tHtml('channels.list.load_error')}</div>`;
        }
    } catch (error) {
        listEl.innerHTML = `<div class="alert alert-danger">${tHtml('channels.list.load_failed')}</div>`;
    }
}

/**
 * Display channels in management modal
 */
function displayChannelsList(channels) {
    const listEl = document.getElementById('channelsList');

    if (channels.length === 0) {
        listEl.innerHTML = `<div class="text-muted text-center py-3">${tHtml('channels.list.empty')}</div>`;
        return;
    }

    listEl.innerHTML = '';

    channels.forEach(channel => {
        const item = document.createElement('div');
        item.className = 'list-group-item d-flex justify-content-between align-items-center';

        const isPublic = channel.index === 0;

        const isMuted = mutedChannels.has(channel.index);
        const isFavorite = favoriteChannels.has(channel.index);
        const scope = (window.channelScopes || {})[String(channel.index)];
        const hasScope = !!scope;
        const scopeTitle = hasScope
            ? tHtml('channels.scope_title', { name: scope.name })
            : tHtml('channels.scope_set_title');
        item.innerHTML = `
            <div>
                <strong>${escapeHtml(channel.name)}</strong>
                ${hasScope ? `<span class="badge bg-info text-dark ms-2" style="font-size:0.7em;"><i class="bi bi-pin-map"></i> ${escapeHtml(scope.name)}</span>` : ''}
            </div>
            <div class="btn-group btn-group-sm">
                <button class="btn ${isFavorite ? 'btn-warning' : 'btn-outline-warning'}"
                        onclick="toggleChannelFavorite(${channel.index})"
                        title="${tHtml(isFavorite ? 'channels.unfav_title' : 'channels.fav_title')}">
                    <i class="bi ${isFavorite ? 'bi-star-fill' : 'bi-star'}"></i>
                </button>
                <button class="btn ${isMuted ? 'btn-secondary' : 'btn-outline-secondary'}"
                        onclick="toggleChannelMute(${channel.index})"
                        title="${tHtml(isMuted ? 'channels.unmute_title' : 'channels.mute_title')}">
                    <i class="bi ${isMuted ? 'bi-bell-slash' : 'bi-bell'}"></i>
                </button>
                <button class="btn ${hasScope ? 'btn-info' : 'btn-outline-info'}"
                        onclick="openRegionPicker(${channel.index})" title="${scopeTitle}">
                    <i class="bi bi-pin-map"></i>
                </button>
                <button class="btn btn-outline-primary" onclick="shareChannel(${channel.index})" title="${tHtml('common.share')}">
                    <i class="bi bi-share"></i>
                </button>
                ${!isPublic ? `
                    <button class="btn btn-outline-danger" onclick="deleteChannel(${channel.index})" title="${tHtml('common.delete')}">
                        <i class="bi bi-trash"></i>
                    </button>
                ` : ''}
            </div>
        `;

        listEl.appendChild(item);
    });
}

/**
 * Populate channel sidebar (visible on lg+ screens)
 */
function populateChannelSidebar() {
    const list = document.getElementById('channelSidebarList');
    if (!list) return;

    list.innerHTML = '';

    const baseChannels = availableChannels.length > 0
        ? availableChannels
        : [{index: 0, name: 'Public', key: ''}];
    const channels = sortedChannelsByFavoriteAndActivity(baseChannels);

    channels.forEach(channel => {
        if (!channel || typeof channel.index === 'undefined' || !channel.name) return;

        const item = document.createElement('div');
        item.className = 'channel-sidebar-item';
        item.dataset.channelIdx = channel.index;

        if (channel.index === currentChannelIdx) {
            item.classList.add('active');
        }
        if (mutedChannels.has(channel.index)) {
            item.classList.add('muted');
        }
        if (favoriteChannels.has(channel.index)) {
            item.classList.add('is-favorite');
        }

        // Top row: name + time + unread badge
        const topRow = document.createElement('div');
        topRow.className = 'channel-item-top';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'channel-name';
        nameSpan.textContent = channel.name;
        topRow.appendChild(nameSpan);

        const lastMsg = channelLastMessages[channel.index];
        if (lastMsg && lastMsg.timestamp) {
            const timeSpan = document.createElement('span');
            timeSpan.className = 'channel-last-time';
            timeSpan.textContent = formatChannelTime(lastMsg.timestamp);
            topRow.appendChild(timeSpan);
        }

        const unread = unreadCounts[channel.index] || 0;
        if (unread > 0 && channel.index !== currentChannelIdx && !mutedChannels.has(channel.index)) {
            const badge = document.createElement('span');
            badge.className = 'sidebar-unread-badge';
            badge.textContent = unread;
            topRow.appendChild(badge);
        }

        item.appendChild(topRow);

        // Preview row (only if non-empty preview exists)
        if (lastMsg && lastMsg.preview) {
            const preview = document.createElement('div');
            preview.className = 'channel-item-preview';
            preview.textContent = lastMsg.preview;
            item.appendChild(preview);
        }

        item.addEventListener('click', () => {
            currentChannelIdx = channel.index;
            localStorage.setItem('mc_active_channel', currentChannelIdx);
            loadMessages();
            updateChannelSidebarActive();
        });

        list.appendChild(item);
    });
}

/**
 * Update active state on channel sidebar items and sync mobile selector input.
 */
function updateChannelSidebarActive() {
    const list = document.getElementById('channelSidebarList');
    if (list) {
        list.querySelectorAll('.channel-sidebar-item').forEach(item => {
            const idx = parseInt(item.dataset.channelIdx);
            item.classList.toggle('active', idx === currentChannelIdx);
        });
    }

    // Sync mobile selector input with current channel name
    updateChannelInputDisplay();
}

/**
 * Move a channel's <li>/<div> to the top of its tier (favorite or non-favorite)
 * in both the sidebar and the mobile dropdown. Pure DOM move — does not rebuild
 * the list, so the active highlight, scroll, and event listeners survive.
 */
function moveChannelToTopOfTier(channelIdx) {
    const isFav = favoriteChannels.has(channelIdx);
    const idxStr = String(channelIdx);

    const moveIn = (containerId, childClass) => {
        const container = document.getElementById(containerId);
        if (!container) return;
        const item = container.querySelector(`.${childClass}[data-channel-idx="${idxStr}"]`);
        if (!item) return;  // channel not currently rendered (e.g. dropdown filtered)

        if (isFav) {
            if (item !== container.firstElementChild) container.prepend(item);
            return;
        }
        // Non-favorite: insert before the first non-favorite sibling.
        const firstNonFav = container.querySelector(`:scope > .${childClass}:not(.is-favorite)`);
        if (!firstNonFav) {
            // No non-favorite tier yet — append after the favorites block.
            container.appendChild(item);
        } else if (firstNonFav !== item) {
            container.insertBefore(item, firstNonFav);
        }
    };

    moveIn('channelSidebarList', 'channel-sidebar-item');
    moveIn('channelSelectorDropdown', 'channel-selector-item');
}

/**
 * Update unread badges on channel sidebar
 */
function updateChannelSidebarBadges() {
    const list = document.getElementById('channelSidebarList');
    if (!list) return;

    list.querySelectorAll('.channel-sidebar-item').forEach(item => {
        const idx = parseInt(item.dataset.channelIdx);
        const unread = unreadCounts[idx] || 0;
        const isMuted = mutedChannels.has(idx);
        const lastMsg = channelLastMessages[idx];

        // Update muted state
        item.classList.toggle('muted', isMuted);

        const topRow = item.querySelector('.channel-item-top');
        if (!topRow) return;

        // Update or remove time label (insert before badge if present, else append)
        let timeEl = topRow.querySelector('.channel-last-time');
        if (lastMsg && lastMsg.timestamp) {
            if (!timeEl) {
                timeEl = document.createElement('span');
                timeEl.className = 'channel-last-time';
                const badgeEl = topRow.querySelector('.sidebar-unread-badge');
                topRow.insertBefore(timeEl, badgeEl);  // insertBefore(x, null) == appendChild
            }
            timeEl.textContent = formatChannelTime(lastMsg.timestamp);
        } else if (timeEl) {
            timeEl.remove();
        }

        // Update or remove badge
        let badge = topRow.querySelector('.sidebar-unread-badge');
        if (unread > 0 && idx !== currentChannelIdx && !isMuted) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'sidebar-unread-badge';
                topRow.appendChild(badge);
            }
            badge.textContent = unread;
        } else if (badge) {
            badge.remove();
        }

        // Update or remove preview row
        let preview = item.querySelector('.channel-item-preview');
        if (lastMsg && lastMsg.preview) {
            if (!preview) {
                preview = document.createElement('div');
                preview.className = 'channel-item-preview';
                item.appendChild(preview);
            }
            preview.textContent = lastMsg.preview;
        } else if (preview) {
            preview.remove();
        }
    });

    // Re-render mobile dropdown if currently visible (badges/muted state)
    const dropdown = document.getElementById('channelSelectorDropdown');
    if (dropdown && dropdown.style.display !== 'none') {
        renderChannelDropdownItems();
    }
}

/**
 * Toggle mute state for a channel
 */
async function toggleChannelMute(index) {
    const newMuted = !mutedChannels.has(index);

    try {
        const response = await fetch(`/api/channels/${index}/mute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ muted: newMuted })
        });
        const data = await response.json();

        if (data.success) {
            if (newMuted) {
                mutedChannels.add(index);
            } else {
                mutedChannels.delete(index);
            }
            // Refresh modal list and badges
            loadChannelsList();
            updateUnreadBadges();
        } else {
            showNotification(t('channels.toast.mute_failed'), 'danger');
        }
    } catch (error) {
        showNotification(t('channels.toast.mute_failed'), 'danger');
    }
}

/**
 * Toggle favorite state for a channel
 */
async function toggleChannelFavorite(index) {
    const newFavorite = !favoriteChannels.has(index);

    try {
        const response = await fetch(`/api/channels/${index}/favorite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ favorite: newFavorite })
        });
        const data = await response.json();

        if (data.success) {
            if (newFavorite) {
                favoriteChannels.add(index);
            } else {
                favoriteChannels.delete(index);
            }
            // Refresh modal (star icon) and rebuild sidebar/dropdown to apply new tier
            loadChannelsList();
            populateChannelSelector(availableChannels);
        } else {
            showNotification(t('channels.toast.favorite_failed'), 'danger');
        }
    } catch (error) {
        showNotification(t('channels.toast.favorite_failed'), 'danger');
    }
}

/**
 * Delete channel
 */
async function deleteChannel(index) {
    const channel = availableChannels.find(ch => ch.index === index);
    if (!channel) return;

    if (!confirm(t('channels.confirm.remove', { name: channel.name }))) {
        return;
    }

    try {
        const response = await fetch(`/api/channels/${index}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            showNotification(t('channels.toast.removed', { name: channel.name }), 'success');

            // If deleted current channel, switch to Public
            if (currentChannelIdx === index) {
                currentChannelIdx = 0;
                localStorage.setItem('mc_active_channel', '0');
                loadMessages();
            }

            // Reload channels
            await loadChannels();
            loadChannelsList();
        } else {
            showNotification(t('channels.toast.remove_failed', { error: data.error }), 'danger');
        }
    } catch (error) {
        showNotification(t('channels.toast.remove_error'), 'danger');
    }
}

/**
 * Share channel (show QR code)
 */
async function shareChannel(index) {
    try {
        const response = await fetch(`/api/channels/${index}/qr`);
        const data = await response.json();

        if (data.success) {
            // Populate share modal
            document.getElementById('shareChannelName').textContent = t('channels.share_name', { name: data.qr_data.name });
            document.getElementById('shareChannelQR').src = data.qr_image;
            document.getElementById('shareChannelKey').value = data.qr_data.key;

            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('shareChannelModal'));
            modal.show();
        } else {
            showNotification(t('channels.toast.qr_failed', { error: data.error }), 'danger');
        }
    } catch (error) {
        showNotification(t('channels.toast.qr_error'), 'danger');
    }
}

/**
 * Copy channel key to clipboard
 */
async function copyChannelKey() {
    const input = document.getElementById('shareChannelKey');
    try {
        await copyTextToClipboard(input.value);
        showNotification(t('channels.toast.key_copied'), 'success');
    } catch (error) {
        showNotification(t('channels.toast.copy_failed'), 'danger');
    }
}


// =============================================================================
// Direct Messages (DM) Functions
// =============================================================================

/**
 * Load DM last seen timestamps from server
 */
async function loadDmLastSeenTimestampsFromServer() {
    try {
        const response = await fetch('/api/read_status');
        const data = await response.json();

        if (data.success && data.dm) {
            dmLastSeenTimestamps = data.dm;
            console.log('Loaded DM read status from server:', Object.keys(dmLastSeenTimestamps).length, 'conversations');
        } else {
            console.warn('Failed to load DM read status from server, using empty state');
            dmLastSeenTimestamps = {};
        }
    } catch (error) {
        console.error('Error loading DM read status from server:', error);
        dmLastSeenTimestamps = {};
    }
}

/**
 * Save DM read status to server
 */
async function saveDmReadStatus(conversationId, timestamp) {
    try {
        const response = await fetch('/api/read_status/mark_read', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                type: 'dm',
                conversation_id: conversationId,
                timestamp: timestamp
            })
        });

        const data = await response.json();

        if (!data.success) {
            console.error('Failed to save DM read status:', data.error);
        }
    } catch (error) {
        console.error('Error saving DM read status:', error);
    }
}

/**
 * Start DM from channel message (DM button click)
 * Redirects to the full-page DM view
 */
function startDmTo(username) {
    const conversationId = `name_${username}`;
    window.location.href = `/dm?conversation=${encodeURIComponent(conversationId)}`;
}

/**
 * Check for new DMs (called by auto-refresh)
 */
async function checkDmUpdates() {
    try {
        const lastSeenParam = encodeURIComponent(JSON.stringify(dmLastSeenTimestamps));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`/api/dm/updates?last_seen=${lastSeenParam}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) return;

        const data = await response.json();

        if (data.success) {
            // Update unread counts
            dmUnreadCounts = {};
            if (data.conversations) {
                data.conversations.forEach(conv => {
                    dmUnreadCounts[conv.conversation_id] = conv.unread_count;
                });
            }

            // Update badges
            updateDmBadges(data.total_unread || 0);

            // Update app icon badge
            updateAppBadge();
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Error checking DM updates:', error);
        }
    }
}

/**
 * Update DM notification badges
 */
function updateDmBadges(totalUnread) {
    // Update menu badge (legacy element, kept for backwards compat)
    const menuBadge = document.getElementById('dmMenuBadge');
    if (menuBadge) {
        if (totalUnread > 0) {
            menuBadge.textContent = totalUnread > 99 ? '99+' : totalUnread;
            menuBadge.style.display = 'inline-block';
        } else {
            menuBadge.style.display = 'none';
        }
    }

    // Update FAB badge (red badge on Direct Messages FAB)
    updateFabBadge('.fab-dm', 'fab-badge-dm', totalUnread);

    // Update Main Menu copy badge (#menu-dm .menu-badge-dm) — kept in sync regardless of placement
    const menuDmBadge = document.querySelector('#menu-dm .menu-badge-dm');
    if (menuDmBadge) {
        if (totalUnread > 0) {
            menuDmBadge.textContent = totalUnread > 99 ? '99+' : totalUnread;
            menuDmBadge.classList.remove('d-none');
        } else {
            menuDmBadge.classList.add('d-none');
        }
    }
}

/**
 * Update pending contacts badge on Contact Management FAB button
 * Fetches count from API using type filter from localStorage
 */
function setMenuContactsBadge(count) {
    const badge = document.querySelector('#menu-contacts .menu-badge-contacts');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('d-none');
    } else {
        badge.classList.add('d-none');
    }
}

async function updatePendingContactsBadge() {
    try {
        // Suppress: hide FAB badge entirely, skip browser notification path
        if (window.contactsSettings?.suppress_advert_notifications) {
            updateFabBadge('.fab-contacts', 'fab-badge-pending', 0);
            setMenuContactsBadge(0);
            updateAppBadge();
            return;
        }

        // Load type filter from localStorage (uses same function as contacts.js)
        const savedTypes = loadPendingTypeFilter();

        // Build query string with types parameter
        const params = new URLSearchParams();
        savedTypes.forEach(type => params.append('types', type));

        // Fetch pending count with type filter
        const response = await fetch(`/api/contacts/pending?${params.toString()}`);
        if (!response.ok) return;

        const data = await response.json();

        if (data.success) {
            const count = data.pending?.length || 0;
            // Update FAB badge (red badge on Contact Management button)
            updateFabBadge('.fab-contacts', 'fab-badge-pending', count);
            // Update Main Menu copy badge
            setMenuContactsBadge(count);
            // Update app icon badge
            updateAppBadge();
        }
    } catch (error) {
        console.error('Error updating pending contacts badge:', error);
    }
}

/**
 * Load pending contacts type filter from localStorage.
 * This is a duplicate of the function in contacts.js for use in app.js
 * @returns {Array<number>} Array of contact types (default: [1] for COM only)
 */
function loadPendingTypeFilter() {
    try {
        const stored = localStorage.getItem('pendingContactsTypeFilter');
        if (stored) {
            const types = JSON.parse(stored);
            // Validate: must be array of valid types
            if (Array.isArray(types) && types.every(t => [1, 2, 3, 4].includes(t))) {
                return types;
            }
        }
    } catch (e) {
        console.error('Failed to load pending type filter from localStorage:', e);
    }
    // Default: COM only (most common use case)
    return [1];
}

// =============================================================================
// Mentions Autocomplete Functions
// =============================================================================

/**
 * Setup mentions autocomplete functionality
 */
function setupMentionsAutocomplete() {
    const input = document.getElementById('messageInput');
    const popup = document.getElementById('mentionsPopup');

    if (!input || !popup) {
        console.warn('[mentions] Required elements not found');
        return;
    }

    // Track @ trigger on input
    input.addEventListener('input', handleMentionInput);

    // Handle keyboard navigation
    input.addEventListener('keydown', handleMentionKeydown);

    // Close popup on blur (with delay to allow click selection)
    input.addEventListener('blur', function() {
        setTimeout(hideMentionsPopup, 200);
    });

    // Preload contacts on focus
    input.addEventListener('focus', function() {
        loadContactsForMentions();
    });

    // Click outside to close
    document.addEventListener('click', function(e) {
        if (!popup.contains(e.target) && e.target !== input) {
            hideMentionsPopup();
        }
    });

    console.log('[mentions] Autocomplete initialized');
}

/**
 * Handle input event for mention detection
 */
function handleMentionInput(e) {
    const input = e.target;
    const cursorPos = input.selectionStart;
    const text = input.value;

    // Find @ character before cursor
    const textBeforeCursor = text.substring(0, cursorPos);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');

    // Check if we should be in mention mode
    if (lastAtPos >= 0) {
        // Check if there's a space or newline between @ and cursor (mention ended)
        const textAfterAt = textBeforeCursor.substring(lastAtPos + 1);

        // Allow alphanumeric, underscore, dash, emoji, and other non-whitespace chars in username
        // Space or newline ends the mention
        if (!/[\s\n]/.test(textAfterAt)) {
            // We're in mention mode
            mentionStartPos = lastAtPos;
            isMentionMode = true;
            const query = textAfterAt;
            showMentionsPopup(query);
            return;
        }
    }

    // Not in mention mode
    if (isMentionMode) {
        hideMentionsPopup();
    }
}

/**
 * Handle keyboard navigation in mentions popup
 */
function handleMentionKeydown(e) {
    if (!isMentionMode) return;

    const popup = document.getElementById('mentionsPopup');
    const items = popup.querySelectorAll('.mention-item');

    if (items.length === 0) return;

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            mentionSelectedIndex = Math.min(mentionSelectedIndex + 1, items.length - 1);
            updateMentionHighlight(items);
            break;

        case 'ArrowUp':
            e.preventDefault();
            mentionSelectedIndex = Math.max(mentionSelectedIndex - 1, 0);
            updateMentionHighlight(items);
            break;

        case 'Enter':
        case 'Tab':
            if (items.length > 0 && mentionSelectedIndex < items.length) {
                e.preventDefault();
                const selected = items[mentionSelectedIndex];
                if (selected && selected.dataset.contact) {
                    selectMentionContact(selected.dataset.contact);
                }
            }
            break;

        case 'Escape':
            e.preventDefault();
            hideMentionsPopup();
            break;
    }
}

/**
 * Show mentions popup with filtered contacts
 */
function showMentionsPopup(query) {
    const popup = document.getElementById('mentionsPopup');
    const list = document.getElementById('mentionsList');

    // Filter contacts
    const filtered = filterContacts(query);

    if (filtered.length === 0) {
        list.innerHTML = `<div class="mentions-empty">${tHtml('chat.mentions.none')}</div>`;
        popup.classList.remove('hidden');
        return;
    }

    // Reset selection index if out of bounds
    if (mentionSelectedIndex >= filtered.length) {
        mentionSelectedIndex = 0;
    }

    // Build list HTML
    list.innerHTML = filtered.map((contact, index) => {
        const highlighted = index === mentionSelectedIndex ? 'highlighted' : '';
        const escapedName = escapeHtml(contact);
        return `<div class="mention-item ${highlighted}" data-contact="${escapedName}" data-index="${index}">
            <span class="mention-item-name">${escapedName}</span>
        </div>`;
    }).join('');

    // Add click handlers
    list.querySelectorAll('.mention-item').forEach(item => {
        item.addEventListener('click', function() {
            selectMentionContact(this.dataset.contact);
        });
    });

    // Close emoji picker if open (avoid overlapping popups)
    const emojiPopup = document.getElementById('emojiPickerPopup');
    if (emojiPopup && !emojiPopup.classList.contains('hidden')) {
        emojiPopup.classList.add('hidden');
    }

    popup.classList.remove('hidden');
}

/**
 * Hide mentions popup and reset state
 */
function hideMentionsPopup() {
    const popup = document.getElementById('mentionsPopup');
    if (popup) {
        popup.classList.add('hidden');
    }
    isMentionMode = false;
    mentionStartPos = -1;
    mentionSelectedIndex = 0;
}

/**
 * Filter contacts by query (matches any part of name)
 */
function filterContacts(query) {
    if (!mentionsCache || mentionsCache.length === 0) {
        return [];
    }

    const lowerQuery = query.toLowerCase();

    // Filter by any part of the name (not just prefix)
    return mentionsCache.filter(contact =>
        contact.toLowerCase().includes(lowerQuery)
    ).slice(0, 10);  // Limit to 10 results for performance
}

/**
 * Update highlight on mention items
 */
function updateMentionHighlight(items) {
    items.forEach((item, index) => {
        if (index === mentionSelectedIndex) {
            item.classList.add('highlighted');
            // Scroll item into view if needed
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('highlighted');
        }
    });
}

/**
 * Select a contact and insert mention into textarea
 */
function selectMentionContact(contactName) {
    const input = document.getElementById('messageInput');
    const text = input.value;

    // Replace from @ position to cursor with @[contactName]
    const beforeMention = text.substring(0, mentionStartPos);
    const afterCursor = text.substring(input.selectionStart);

    const mention = `@[${contactName}] `;
    input.value = beforeMention + mention + afterCursor;

    // Set cursor position after the mention
    const newCursorPos = mentionStartPos + mention.length;
    input.setSelectionRange(newCursorPos, newCursorPos);

    // Update character counter
    updateCharCounter();

    // Hide popup and reset state
    hideMentionsPopup();

    // Keep focus on input
    input.focus();
}

/**
 * Load contacts for mentions autocomplete (with caching)
 */
async function loadContactsForMentions() {
    const CACHE_TTL = 60000;  // 60 seconds
    const now = Date.now();

    // Return cached if still valid
    if (mentionsCache.length > 0 && (now - mentionsCacheTimestamp) < CACHE_TTL) {
        return;
    }

    try {
        const response = await fetch('/api/contacts/cached');
        const data = await response.json();

        if (data.success && data.contacts) {
            mentionsCache = data.contacts;
            mentionsCacheTimestamp = now;
            console.log(`[mentions] Cached ${mentionsCache.length} contacts from cache`);
        }
    } catch (error) {
        console.error('[mentions] Error loading contacts:', error);
    }
}

// =============================================================================
// FAB Toggle (Collapse/Expand)
// =============================================================================

// =============================================================================
// Item placement (Quick Access vs Main Menu)
// =============================================================================

const ITEM_PLACEMENT_DEFS = {
    filter:      { fab: '#filterFab',       menu: '#menu-filter' },
    search:      { fab: '#globalSearchBtn', menu: '#menu-search' },
    dm:          { fab: '.fab-dm',          menu: '#menu-dm' },
    contacts:    { fab: '.fab-contacts',    menu: '#menu-contacts' },
    settings:    { fab: '.fab-settings',    menu: '#menu-settings' },
    advert:      { fab: '#fab-advert',      menu: '#advertBtn' },
    floodadvert: { fab: '#fab-floodadvert', menu: '#floodadvBtn' },
    map:         { fab: '#fab-map',         menu: '#mapBtn' },
    console:     { fab: '#fab-console',     menu: '#consoleBtn' },
    repeaters:   { fab: '#fab-repeaters',   menu: '#repeatersBtn' },
    pathanalyzer: { fab: '#fab-pathanalyzer', menu: '#pathAnalyzerBtn' },
    deviceinfo:  { fab: '#fab-deviceinfo',  menu: '#deviceInfoBtn' },
    syslog:      { fab: '#fab-syslog',      menu: '#logsBtn' },
};

const ITEM_PLACEMENT_DEFAULTS = {
    filter: 'fab', search: 'fab', dm: 'fab', contacts: 'fab', settings: 'fab',
    advert: 'menu', floodadvert: 'menu', map: 'menu',
    console: 'menu', repeaters: 'menu', pathanalyzer: 'menu', deviceinfo: 'menu', syslog: 'menu'
};

function readItemPlacements() {
    let stored = {};
    try {
        stored = JSON.parse(localStorage.getItem('mc-webui-item-placements') || '{}');
    } catch (e) {
        stored = {};
    }
    return { ...ITEM_PLACEMENT_DEFAULTS, ...stored };
}

function isFabHidden() {
    return localStorage.getItem('mc-webui-fab-hidden') === 'true';
}

function applyItemPlacements() {
    const hidden = isFabHidden();
    const placements = readItemPlacements();
    const fabContainer = document.getElementById('fabContainer');

    if (fabContainer) {
        fabContainer.classList.toggle('d-none', hidden);
    }

    for (const [key, sels] of Object.entries(ITEM_PLACEMENT_DEFS)) {
        const place = hidden ? 'menu' : placements[key];
        const fabEl = document.querySelector(sels.fab);
        const menuEl = document.querySelector(sels.menu);
        if (fabEl) fabEl.classList.toggle('d-none', place !== 'fab');
        if (menuEl) menuEl.classList.toggle('d-none', place !== 'menu');
    }
}

function syncPlacementSettingsUI() {
    const hideCheckbox = document.getElementById('settHideFab');
    if (hideCheckbox) hideCheckbox.checked = isFabHidden();

    const placements = readItemPlacements();
    for (const key of Object.keys(ITEM_PLACEMENT_DEFS)) {
        const radio = document.querySelector(`input[name="place-${key}"][value="${placements[key]}"]`);
        if (radio) radio.checked = true;
    }
    applyPlacementControlsDisabled();
}

function applyPlacementControlsDisabled() {
    const wrap = document.getElementById('fabAppearanceControls');
    if (!wrap) return;
    const disabled = isFabHidden();
    wrap.style.opacity = disabled ? '0.5' : '';
    wrap.style.pointerEvents = disabled ? 'none' : '';
    wrap.querySelectorAll('input, button').forEach(el => {
        el.disabled = disabled;
    });
}

function initializeItemPlacementSettings() {
    const hideCheckbox = document.getElementById('settHideFab');
    if (hideCheckbox) {
        hideCheckbox.addEventListener('change', () => {
            localStorage.setItem('mc-webui-fab-hidden', hideCheckbox.checked ? 'true' : 'false');
            applyPlacementControlsDisabled();
            applyItemPlacements();
        });
    }

    for (const key of Object.keys(ITEM_PLACEMENT_DEFS)) {
        document.querySelectorAll(`input[name="place-${key}"]`).forEach(radio => {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                const placements = readItemPlacements();
                placements[key] = radio.value;
                localStorage.setItem('mc-webui-item-placements', JSON.stringify(placements));
                applyItemPlacements();
            });
        });
    }

    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
        settingsModal.addEventListener('show.bs.modal', syncPlacementSettingsUI);
    }
}

function initializeFabToggle() {
    const toggle = document.getElementById('fabToggle');
    const container = document.getElementById('fabContainer');
    if (!toggle || !container) return;

    // Restore collapsed state
    if (localStorage.getItem('mc-webui-fab-collapsed') === '1') {
        container.classList.add('collapsed');
        toggle.title = t('chat.fab.show');
    }

    toggle.addEventListener('click', () => {
        container.classList.toggle('collapsed');
        const isCollapsed = container.classList.contains('collapsed');
        toggle.title = isCollapsed ? t('chat.fab.show') : t('chat.fab.hide');
        localStorage.setItem('mc-webui-fab-collapsed', isCollapsed ? '1' : '0');
    });

    // Drag-and-drop support
    initFabDrag('fabContainer', 'fabToggle', 'mc-webui-fab-pos');

    // Listen for settings open request from DM iframe
    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'openSettings') {
            const modal = document.getElementById('settingsModal');
            if (modal) {
                const bsModal = bootstrap.Modal.getOrCreateInstance(modal);
                bsModal.show();
            }
        }
    });
}

// =============================================================================
// Sidebar breakpoint (channel/DM list as sidebar vs. dropdown)
// =============================================================================

const SIDEBAR_BREAKPOINT_DEFAULT = 992;
const SIDEBAR_BREAKPOINT_MIN = 600;
const SIDEBAR_BREAKPOINT_MAX = 2000;
const SIDEBAR_BREAKPOINT_KEY = 'mc-webui-sidebar-breakpoint';

function readSidebarBreakpoint() {
    const stored = parseInt(localStorage.getItem(SIDEBAR_BREAKPOINT_KEY), 10);
    if (isNaN(stored) || stored < SIDEBAR_BREAKPOINT_MIN || stored > SIDEBAR_BREAKPOINT_MAX) {
        return SIDEBAR_BREAKPOINT_DEFAULT;
    }
    return stored;
}

function applySidebarBreakpoint() {
    const bp = readSidebarBreakpoint();
    document.documentElement.classList.toggle('layout-wide', window.innerWidth >= bp);
}

let _sidebarBreakpointRaf = null;
function onSidebarBreakpointResize() {
    if (_sidebarBreakpointRaf) return;
    _sidebarBreakpointRaf = requestAnimationFrame(() => {
        _sidebarBreakpointRaf = null;
        applySidebarBreakpoint();
    });
}

function syncSidebarBreakpointUI() {
    const input = document.getElementById('settSidebarBreakpoint');
    if (input) input.value = readSidebarBreakpoint();
}

function initializeSidebarBreakpointSettings() {
    window.addEventListener('resize', onSidebarBreakpointResize);

    const input = document.getElementById('settSidebarBreakpoint');
    if (input) {
        input.addEventListener('input', () => {
            const val = parseInt(input.value, 10);
            if (isNaN(val) || val < SIDEBAR_BREAKPOINT_MIN || val > SIDEBAR_BREAKPOINT_MAX) return;
            localStorage.setItem(SIDEBAR_BREAKPOINT_KEY, String(val));
            applySidebarBreakpoint();
        });
    }

    const resetBtn = document.getElementById('settSidebarBreakpointReset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            localStorage.removeItem(SIDEBAR_BREAKPOINT_KEY);
            if (input) input.value = SIDEBAR_BREAKPOINT_DEFAULT;
            applySidebarBreakpoint();
        });
    }

    const settingsModal = document.getElementById('settingsModal');
    if (settingsModal) {
        settingsModal.addEventListener('show.bs.modal', syncSidebarBreakpointUI);
    }
}

// =============================================================================
// Chat Filter Functionality
// =============================================================================

// Filter state
let filterActive = false;
let currentFilterQuery = '';
let originalMessageContents = new Map();

/**
 * Initialize filter functionality
 */
function initializeFilter() {
    const filterFab = document.getElementById('filterFab');
    const filterBar = document.getElementById('filterBar');
    const filterInput = document.getElementById('filterInput');
    const filterClearBtn = document.getElementById('filterClearBtn');
    const filterCloseBtn = document.getElementById('filterCloseBtn');

    if (!filterFab || !filterBar) return;

    // Open filter bar when FAB clicked
    filterFab.addEventListener('click', () => {
        openFilterBar();
    });

    // "Filter my messages" button - inserts current device name
    const filterMeBtn = document.getElementById('filterMeBtn');
    if (filterMeBtn) {
        filterMeBtn.addEventListener('click', () => {
            const deviceName = window.MC_CONFIG?.deviceName || '';
            if (deviceName) {
                filterInput.value = deviceName;
                applyFilter(deviceName);
                filterInput.focus();
            }
        });
    }

    // Filter as user types (debounced) - also check for @mentions
    let filterTimeout = null;
    filterInput.addEventListener('input', () => {
        // Check for @mention trigger
        if (handleFilterMentionInput(filterInput)) {
            return; // Don't apply filter while picking a mention
        }

        clearTimeout(filterTimeout);
        filterTimeout = setTimeout(() => {
            applyFilter(filterInput.value);
        }, 150);
    });

    // Clear filter
    filterClearBtn.addEventListener('click', () => {
        filterInput.value = '';
        applyFilter('');
        hideFilterMentionsPopup();
        filterInput.focus();
    });

    // Close filter bar
    filterCloseBtn.addEventListener('click', () => {
        closeFilterBar();
    });

    // Keyboard shortcuts (with mentions navigation support)
    filterInput.addEventListener('keydown', (e) => {
        // If filter mentions popup is active, handle navigation
        if (filterMentionActive) {
            if (handleFilterMentionKeydown(e)) return;
        }
        if (e.key === 'Escape') {
            if (filterMentionActive) {
                hideFilterMentionsPopup();
                e.preventDefault();
            } else {
                closeFilterBar();
            }
        }
    });

    // Close filter mentions on blur
    filterInput.addEventListener('blur', () => {
        setTimeout(hideFilterMentionsPopup, 200);
    });

    // Preload contacts when filter bar is focused
    filterInput.addEventListener('focus', () => {
        loadContactsForMentions();
    });

    // Global keyboard shortcut: Ctrl+F to open filter
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            openFilterBar();
        }
    });
}

/**
 * Open the filter bar
 */
function openFilterBar() {
    const filterBar = document.getElementById('filterBar');
    const filterInput = document.getElementById('filterInput');

    filterBar.classList.add('visible');
    filterActive = true;

    // Focus input after animation
    setTimeout(() => {
        filterInput.focus();
    }, 100);
}

/**
 * Close the filter bar and reset filter
 */
function closeFilterBar() {
    const filterBar = document.getElementById('filterBar');
    const filterInput = document.getElementById('filterInput');

    filterBar.classList.remove('visible');
    filterActive = false;
    hideFilterMentionsPopup();

    // Reset filter
    filterInput.value = '';
    applyFilter('');
}

/**
 * Apply filter to messages
 * @param {string} query - Search query
 */
function applyFilter(query) {
    currentFilterQuery = query.trim();
    const container = document.getElementById('messagesList');
    const messages = container.querySelectorAll('.message-wrapper');
    const matchCountEl = document.getElementById('filterMatchCount');

    // The divider marks a position in the full list — meaningless once the
    // list is filtered down to matches.
    const unreadDivider = container.querySelector('.unread-divider');
    if (unreadDivider) {
        unreadDivider.classList.toggle('filter-hidden', !!currentFilterQuery);
    }

    // Remove any existing no-matches message
    const existingNoMatches = container.querySelector('.filter-no-matches');
    if (existingNoMatches) {
        existingNoMatches.remove();
    }

    if (!currentFilterQuery) {
        // No filter - show all messages, restore original content
        messages.forEach(msg => {
            msg.classList.remove('filter-hidden');
            restoreOriginalContent(msg);
        });
        matchCountEl.textContent = '';
        return;
    }

    let matchCount = 0;

    messages.forEach(msg => {
        // Get text content from message
        const text = FilterUtils.getMessageText(msg, '.message-content');
        const senderEl = msg.querySelector('.message-sender');
        const senderText = senderEl ? senderEl.textContent : '';

        // Check if message matches (content or sender)
        const matches = FilterUtils.textMatches(text, currentFilterQuery) ||
                       FilterUtils.textMatches(senderText, currentFilterQuery);

        if (matches) {
            msg.classList.remove('filter-hidden');
            matchCount++;

            // Highlight matches in content
            highlightMessageContent(msg);
        } else {
            msg.classList.add('filter-hidden');
            restoreOriginalContent(msg);
        }
    });

    // Update match count
    matchCountEl.textContent = `${matchCount} / ${messages.length}`;

    // Show no matches message if needed
    if (matchCount === 0 && messages.length > 0) {
        const noMatchesDiv = document.createElement('div');
        noMatchesDiv.className = 'filter-no-matches';
        noMatchesDiv.innerHTML = `
            <i class="bi bi-search"></i>
            <p>${tHtml('chat.filter.no_matches', { query: currentFilterQuery })}</p>
        `;
        container.appendChild(noMatchesDiv);
    }
}

/**
 * Highlight matching text in a message element
 * @param {HTMLElement} messageEl - Message wrapper element
 */
function highlightMessageContent(messageEl) {
    const contentEl = messageEl.querySelector('.message-content');
    if (!contentEl) return;

    // Store original content if not already stored
    const msgId = getMessageId(messageEl);
    if (!originalMessageContents.has(msgId)) {
        originalMessageContents.set(msgId, contentEl.innerHTML);
    }

    // Get original content and apply highlighting
    const originalHtml = originalMessageContents.get(msgId);
    contentEl.innerHTML = FilterUtils.highlightMatches(originalHtml, currentFilterQuery);

    // Also highlight sender name if present
    const senderEl = messageEl.querySelector('.message-sender');
    if (senderEl) {
        const senderMsgId = msgId + '_sender';
        if (!originalMessageContents.has(senderMsgId)) {
            originalMessageContents.set(senderMsgId, senderEl.innerHTML);
        }
        const originalSenderHtml = originalMessageContents.get(senderMsgId);
        senderEl.innerHTML = FilterUtils.highlightMatches(originalSenderHtml, currentFilterQuery);
    }
}

/**
 * Restore original content of a message element
 * @param {HTMLElement} messageEl - Message wrapper element
 */
function restoreOriginalContent(messageEl) {
    const contentEl = messageEl.querySelector('.message-content');
    const senderEl = messageEl.querySelector('.message-sender');
    const msgId = getMessageId(messageEl);

    if (contentEl && originalMessageContents.has(msgId)) {
        contentEl.innerHTML = originalMessageContents.get(msgId);
    }

    if (senderEl && originalMessageContents.has(msgId + '_sender')) {
        senderEl.innerHTML = originalMessageContents.get(msgId + '_sender');
    }
}

/**
 * Generate a unique ID for a message element
 * @param {HTMLElement} messageEl - Message element
 * @returns {string} - Unique identifier
 */
function getMessageId(messageEl) {
    const parent = messageEl.parentNode;
    const children = Array.from(parent.children).filter(el => el.classList.contains('message-wrapper'));
    return 'msg_' + children.indexOf(messageEl);
}

// =============================================================================
// Filter Mentions Autocomplete
// =============================================================================

let filterMentionActive = false;
let filterMentionStartPos = -1;
let filterMentionSelectedIndex = 0;

/**
 * Handle input in filter bar to detect @mention trigger
 * @returns {boolean} true if in mention mode (caller should skip filter apply)
 */
function handleFilterMentionInput(input) {
    const cursorPos = input.selectionStart;
    const text = input.value;
    const textBeforeCursor = text.substring(0, cursorPos);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');

    if (lastAtPos >= 0) {
        const textAfterAt = textBeforeCursor.substring(lastAtPos + 1);
        // No whitespace after @ means we're typing a mention
        if (!/[\s\n]/.test(textAfterAt)) {
            filterMentionStartPos = lastAtPos;
            filterMentionActive = true;
            showFilterMentionsPopup(textAfterAt);
            return true;
        }
    }

    if (filterMentionActive) {
        hideFilterMentionsPopup();
    }
    return false;
}

/**
 * Handle keyboard navigation in filter mentions popup
 * @returns {boolean} true if the key was handled
 */
function handleFilterMentionKeydown(e) {
    const popup = document.getElementById('filterMentionsPopup');
    const items = popup.querySelectorAll('.mention-item');
    if (items.length === 0) return false;

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            filterMentionSelectedIndex = Math.min(filterMentionSelectedIndex + 1, items.length - 1);
            updateFilterMentionHighlight(items);
            return true;
        case 'ArrowUp':
            e.preventDefault();
            filterMentionSelectedIndex = Math.max(filterMentionSelectedIndex - 1, 0);
            updateFilterMentionHighlight(items);
            return true;
        case 'Enter':
        case 'Tab':
            if (items.length > 0 && filterMentionSelectedIndex < items.length) {
                e.preventDefault();
                const selected = items[filterMentionSelectedIndex];
                if (selected && selected.dataset.contact) {
                    selectFilterMentionContact(selected.dataset.contact);
                }
                return true;
            }
            break;
    }
    return false;
}

/**
 * Show filter mentions popup with filtered contacts
 */
function showFilterMentionsPopup(query) {
    const popup = document.getElementById('filterMentionsPopup');
    const list = document.getElementById('filterMentionsList');

    // Ensure contacts are loaded
    loadContactsForMentions();

    const filtered = filterContacts(query);

    if (filtered.length === 0) {
        list.innerHTML = `<div class="mentions-empty">${tHtml('chat.mentions.none')}</div>`;
        popup.classList.remove('hidden');
        return;
    }

    if (filterMentionSelectedIndex >= filtered.length) {
        filterMentionSelectedIndex = 0;
    }

    list.innerHTML = filtered.map((contact, index) => {
        const highlighted = index === filterMentionSelectedIndex ? 'highlighted' : '';
        const escapedName = escapeHtml(contact);
        return `<div class="mention-item ${highlighted}" data-contact="${escapedName}" data-index="${index}">
            <span class="mention-item-name">${escapedName}</span>
        </div>`;
    }).join('');

    list.querySelectorAll('.mention-item').forEach(item => {
        item.addEventListener('click', function() {
            selectFilterMentionContact(this.dataset.contact);
        });
    });

    popup.classList.remove('hidden');
}

/**
 * Hide filter mentions popup
 */
function hideFilterMentionsPopup() {
    const popup = document.getElementById('filterMentionsPopup');
    if (popup) popup.classList.add('hidden');
    filterMentionActive = false;
    filterMentionStartPos = -1;
    filterMentionSelectedIndex = 0;
}

/**
 * Update highlight in filter mentions popup
 */
function updateFilterMentionHighlight(items) {
    items.forEach((item, index) => {
        if (index === filterMentionSelectedIndex) {
            item.classList.add('highlighted');
            item.scrollIntoView({ block: 'nearest' });
        } else {
            item.classList.remove('highlighted');
        }
    });
}

/**
 * Select a contact from filter mentions and insert plain name
 */
function selectFilterMentionContact(contactName) {
    const input = document.getElementById('filterInput');
    const text = input.value;

    // Replace from @ position to cursor with plain contact name
    const beforeMention = text.substring(0, filterMentionStartPos);
    const afterCursor = text.substring(input.selectionStart);

    input.value = beforeMention + contactName + afterCursor;

    // Set cursor position after the name
    const newCursorPos = filterMentionStartPos + contactName.length;
    input.setSelectionRange(newCursorPos, newCursorPos);

    hideFilterMentionsPopup();
    input.focus();

    // Trigger filter with the new value
    applyFilter(input.value);
}

/**
 * Clear filter state when messages are reloaded
 * Called from displayMessages()
 */
function clearFilterState() {
    originalMessageContents.clear();

    // Re-apply filter if active
    if (filterActive && currentFilterQuery) {
        setTimeout(() => {
            applyFilter(currentFilterQuery);
        }, 50);
    }
}

// =============================================================================
// Global Message Search (FTS5)
// =============================================================================

let searchDebounceTimer = null;

function initializeSearch() {
    const input = document.getElementById('searchInput');
    const btn = document.getElementById('searchBtn');
    if (!input || !btn) return;

    // Toggle search help
    const helpBtn = document.getElementById('searchHelpBtn');
    const helpPanel = document.getElementById('searchHelp');
    if (helpBtn && helpPanel) {
        helpBtn.addEventListener('click', () => {
            helpPanel.style.display = helpPanel.style.display === 'none' ? '' : 'none';
        });
    }

    // Search on Enter or button click
    btn.addEventListener('click', () => performSearch(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') performSearch(input.value);
    });

    // Debounced search as user types (300ms)
    input.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
            if (input.value.trim().length >= 2) {
                performSearch(input.value);
            }
        }, 300);
    });

    // Focus input when modal opens
    document.getElementById('searchModal')?.addEventListener('shown.bs.modal', () => {
        input.focus();
    });
}

async function performSearch(query) {
    query = query.trim();
    const container = document.getElementById('searchResults');
    if (!container) return;

    if (query.length < 2) {
        container.innerHTML = `<div class="text-center text-muted py-4"><p>${tHtml('search.min_chars')}</p></div>`;
        return;
    }

    container.innerHTML = `<div class="text-center py-4"><div class="spinner-border spinner-border-sm"></div> ${tHtml('search.searching')}</div>`;

    try {
        const response = await fetch(`/api/messages/search?q=${encodeURIComponent(query)}&limit=50`);
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger">${escapeHtml(data.error)}</div>`;
            return;
        }

        if (data.results.length === 0) {
            container.innerHTML = `<div class="text-center text-muted py-4"><i class="bi bi-inbox" style="font-size: 2rem;"></i><p class="mt-2">${tHtml('search.no_results', { query })}</p></div>`;
            return;
        }

        container.innerHTML = `<div class="text-muted small mb-2">${tn('search.count', data.count)}</div>`;

        const list = document.createElement('div');
        list.className = 'list-group';

        data.results.forEach(r => {
            const item = document.createElement('a');
            item.className = 'list-group-item list-group-item-action';
            item.style.cursor = 'pointer';

            const time = formatTime(r.timestamp);
            const snippet = highlightSearchTerm(escapeHtml(r.content), query);

            if (r.source === 'channel') {
                item.innerHTML = `
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <span class="badge bg-primary me-1">${escapeHtml(r.channel_name || '')}</span>
                            <strong class="small">${r.is_own ? 'You' : escapeHtml(r.sender || '')}</strong>
                        </div>
                        <small class="text-muted">${time}</small>
                    </div>
                    <div class="small mt-1">${snippet}</div>
                `;
                item.addEventListener('click', () => {
                    // Navigate to channel
                    const channels = window._channelDropdownItems || [];
                    const ch = channels.find(c => c && c.index === r.channel_idx);
                    selectChannelFromDropdown(r.channel_idx, ch ? ch.name : (r.channel_name || ''));
                    bootstrap.Modal.getInstance(document.getElementById('searchModal'))?.hide();
                });
            } else {
                item.innerHTML = `
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <span class="badge bg-success me-1">DM</span>
                            <strong class="small">${escapeHtml(r.contact_name || '')}</strong>
                            <span class="text-muted small">${tHtml(r.direction === 'out' ? 'search.dm_sent' : 'search.dm_received')}</span>
                        </div>
                        <small class="text-muted">${time}</small>
                    </div>
                    <div class="small mt-1">${snippet}</div>
                `;
                item.addEventListener('click', () => {
                    // Navigate to DM conversation
                    window.location.href = `/dm?conversation=${encodeURIComponent(r.contact_pubkey)}`;
                });
            }

            list.appendChild(item);
        });

        container.appendChild(list);

    } catch (error) {
        console.error('Search error:', error);
        container.innerHTML = `<div class="alert alert-danger">${tHtml('search.failed')}</div>`;
    }
}

function highlightSearchTerm(html, query) {
    if (!query) return html;
    const normalizedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${normalizedQuery})`, 'gi');
    return html.replace(regex, '<mark>$1</mark>');
}

// Initialize search when DOM is ready
document.addEventListener('DOMContentLoaded', initializeSearch);

// =============================================================================
// Backup Management
// =============================================================================

function initializeBackup() {
    const modal = document.getElementById('backupModal');
    if (!modal) return;
    modal.addEventListener('shown.bs.modal', () => {
        loadBackupList();
        loadDatabaseSize();
    });
}

function _formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '?';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function loadDatabaseSize() {
    const statusEl = document.getElementById('vacuumDbStatus');
    if (!statusEl) return;
    try {
        const response = await fetch('/api/db/size');
        const data = await response.json();
        if (data.success) {
            statusEl.textContent = t('backup.size', { size: _formatBytes(data.size) });
        } else {
            statusEl.textContent = t('backup.size_unknown');
        }
    } catch (error) {
        statusEl.textContent = t('backup.size_unknown');
    }
}

async function optimizeDatabase() {
    const btn = document.getElementById('vacuumDbBtn');
    const statusEl = document.getElementById('vacuumDbStatus');
    if (!btn) return;

    btn.disabled = true;
    btn.innerHTML = `<div class="spinner-border spinner-border-sm"></div> ${tHtml('backup.optimizing')}`;
    if (statusEl) statusEl.textContent = t('backup.vacuum_running');

    const restoreButton = () => {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-arrows-collapse"></i> ${tHtml('backup.optimize_now')}`;
    };

    try {
        const kickoff = await fetch('/api/db/vacuum', { method: 'POST' });
        const kickoffData = await kickoff.json().catch(() => ({}));

        if (!kickoff.ok && kickoff.status !== 409) {
            showNotification(t('backup.optimize_failed', { error: kickoffData.error || `HTTP ${kickoff.status}` }), 'danger');
            loadDatabaseSize();
            restoreButton();
            return;
        }
        // 409 means another VACUUM is already running — we just attach to it.

        // Poll status every 2s. Cap at 10 minutes to avoid an infinite spinner
        // if something goes really wrong on the server side.
        const POLL_INTERVAL_MS = 2000;
        const MAX_POLLS = 300;
        for (let i = 0; i < MAX_POLLS; i++) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            let status;
            try {
                const resp = await fetch('/api/db/vacuum/status');
                status = await resp.json();
            } catch (e) {
                continue;   // transient — try again
            }

            if (status.running) {
                if (statusEl) statusEl.textContent = t('backup.vacuum_running_for', { seconds: status.elapsed_seconds || 0 });
                continue;
            }

            // Done — either success or error.
            if (status.success === true && status.size_after !== undefined) {
                const freed = status.freed > 0
                    ? t('backup.freed', { size: _formatBytes(status.freed) })
                    : t('backup.freed_none');
                showNotification(t('backup.optimized', { freed, seconds: status.elapsed_seconds }), 'success');
                if (statusEl) statusEl.textContent = t('backup.size', { size: _formatBytes(status.size_after) });
            } else if (status.error) {
                showNotification(t('backup.optimize_failed', { error: status.error }), 'danger');
                loadDatabaseSize();
            } else {
                // No result, no error, not running — odd, just refresh size
                loadDatabaseSize();
            }
            restoreButton();
            return;
        }

        showNotification(t('backup.optimize_stuck'), 'warning');
        loadDatabaseSize();
        restoreButton();
    } catch (error) {
        console.error('Error running VACUUM:', error);
        showNotification(t('backup.optimize_error'), 'danger');
        loadDatabaseSize();
        restoreButton();
    }
}

async function loadBackupList() {
    const container = document.getElementById('backupList');
    const statusEl = document.getElementById('backupAutoStatus');
    if (!container) return;

    container.innerHTML = `<div class="text-center text-muted py-3"><div class="spinner-border spinner-border-sm"></div> ${tHtml('common.loading')}</div>`;

    try {
        const response = await fetch('/api/backup/list');
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger">${escapeHtml(data.error)}</div>`;
            return;
        }

        // Show auto-backup status
        if (statusEl) {
            statusEl.textContent = data.auto_backup_enabled
                ? t('backup.auto_on', {
                    time: `${String(data.backup_hour).padStart(2, '0')}:00`,
                    days: data.retention_days,
                })
                : t('backup.auto_off');
        }

        if (data.backups.length === 0) {
            container.innerHTML = `<div class="text-center text-muted py-3"><i class="bi bi-inbox"></i><p class="mt-2 mb-0">${tHtml('backup.empty')}</p></div>`;
            return;
        }

        const list = document.createElement('div');
        list.className = 'list-group';

        data.backups.forEach(b => {
            const item = document.createElement('div');
            item.className = 'list-group-item d-flex justify-content-between align-items-center';
            item.innerHTML = `
                <div>
                    <i class="bi bi-file-earmark-zip"></i>
                    <span class="ms-1">${escapeHtml(b.filename)}</span>
                    <small class="text-muted ms-2">${b.size_display}</small>
                </div>
                <a href="/api/backup/download?file=${encodeURIComponent(b.filename)}" class="btn btn-sm btn-outline-primary" title="${tHtml('backup.download_title')}">
                    <i class="bi bi-download"></i>
                </a>
            `;
            list.appendChild(item);
        });

        container.innerHTML = '';
        container.appendChild(list);

    } catch (error) {
        console.error('Error loading backups:', error);
        container.innerHTML = `<div class="alert alert-danger">${tHtml('backup.load_failed')}</div>`;
    }
}

async function createBackup() {
    const btn = document.getElementById('createBackupBtn');
    if (!btn) return;

    btn.disabled = true;
    btn.innerHTML = `<div class="spinner-border spinner-border-sm"></div> ${tHtml('backup.creating')}`;

    try {
        const response = await fetch('/api/backup/create', { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            showNotification(t('backup.created', { filename: data.filename }), 'success');
            loadBackupList();
        } else {
            showNotification(t('backup.failed', { error: data.error }), 'danger');
        }
    } catch (error) {
        console.error('Error creating backup:', error);
        showNotification(t('backup.error'), 'danger');
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<i class="bi bi-plus-circle"></i> ${tHtml('backup.create')}`;
    }
}

document.addEventListener('DOMContentLoaded', initializeBackup);

