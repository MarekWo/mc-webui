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

// DM state (for badge updates on main page)
let dmLastSeenTimestamps = {};  // Track last seen DM timestamp per conversation
let dmUnreadCounts = {};  // Track unread DM counts per conversation

// Map state (Leaflet)
let leafletMap = null;
let markersGroup = null;
let contactsGeoCache = {};  // { 'contactName': { lat, lon }, ... }
let contactsPubkeyMap = {};  // { 'contactName': 'full_pubkey', ... }
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
            .bindPopup(`<b>${_selfInfo.name || 'This device'}</b><br><span class="text-muted">Own device</span>`);
        bounds.push([_selfInfo.adv_lat, _selfInfo.adv_lon]);
    }

    filteredContacts.forEach(c => {
        const color = CONTACT_TYPE_COLORS[c.type] || '#2196F3';
        const typeName = CONTACT_TYPE_NAMES[c.type] || 'Unknown';
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
            .bindPopup(`<b>${c.name}</b><br><span class="text-muted">${typeName}</span>${lastSeen ? `<br><small class="text-muted">Last seen: ${lastSeen}</small>` : ''}`);

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
            .bindPopup(`<b>${c.name}</b><br><span class="text-muted">${c.type_label || 'Cache'} (cached)</span>${lastSeen ? `<br><small class="text-muted">Last seen: ${lastSeen}</small>` : ''}`);

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
    document.getElementById('mapModalTitle').textContent = 'All Contacts';

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
        // Load detailed (device) and cached contacts in parallel
        const [detailedResp, cachedResp] = await Promise.all([
            fetch('/api/contacts/detailed'),
            fetch('/api/contacts/cached?format=full')
        ]);
        const detailedData = await detailedResp.json();
        const cachedData = await cachedResp.json();

        contactsGeoCache = {};
        contactsPubkeyMap = {};

        // Process device contacts
        if (detailedData.success && detailedData.contacts) {
            detailedData.contacts.forEach(c => {
                if (c.adv_lat && c.adv_lon && (c.adv_lat !== 0 || c.adv_lon !== 0)) {
                    contactsGeoCache[c.name] = { lat: c.adv_lat, lon: c.adv_lon };
                }
                if (c.name && c.public_key) {
                    contactsPubkeyMap[c.name] = c.public_key;
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
            });
        }

        console.log(`Loaded geo cache for ${Object.keys(contactsGeoCache).length} contacts, pubkey map for ${Object.keys(contactsPubkeyMap).length}`);
    } catch (err) {
        console.error('Error loading contacts geo cache:', err);
    }
}

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
    chatSocket = io(wsUrl + '/chat', {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000,
    });

    chatSocket.on('connect', () => {
        console.log('SocketIO connected to /chat');
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
    chatSocket.on('echo', (data) => {
        if (currentArchiveDate) return;  // Don't refresh archive view
        // Debounce: wait for echoes to settle, then update affected messages
        if (echoRefreshTimer) clearTimeout(echoRefreshTimer);
        echoRefreshTimer = setTimeout(() => {
            echoRefreshTimer = null;
            refreshMessagesMeta();
        }, 2000);
    });

    // Real-time pending contact — update badge (unless suppressed by user setting)
    chatSocket.on('pending_contact', () => {
        if (window.contactsSettings?.suppress_advert_notifications) return;
        updatePendingContactsBadge();
    });

    // Real-time device status
    chatSocket.on('device_status', (data) => {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
            statusEl.className = data.connected ? 'connection-status connected' : 'connection-status disconnected';
            statusEl.textContent = data.connected ? 'Connected' : 'Disconnected';
        }
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

    // Initialize FAB toggle
    initializeFabToggle();

    // Connect SocketIO for real-time updates
    connectChatSocket();

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
document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
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
    }
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

    // Handle Enter key (send) vs Shift+Enter (new line)
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
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

    // Manual refresh button
    document.getElementById('refreshBtn').addEventListener('click', async function() {
        await loadMessages();
        await checkForUpdates();

        // Close offcanvas menu after refresh
        const offcanvas = bootstrap.Offcanvas.getInstance(document.getElementById('mainMenu'));
        if (offcanvas) {
            offcanvas.hide();
        }
    });

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

    // Channel selector (custom searchable picker, visible on mobile)
    const channelInput = document.getElementById('channelSelectorInput');
    const channelDropdown = document.getElementById('channelSelectorDropdown');
    const channelWrapper = document.getElementById('channelSelectorWrapper');

    if (channelInput && channelDropdown) {
        channelInput.addEventListener('focus', () => {
            channelInput.value = '';
            renderChannelDropdownItems('');
            channelDropdown.style.display = 'block';
        });

        channelInput.addEventListener('input', () => {
            renderChannelDropdownItems(channelInput.value);
            channelDropdown.style.display = 'block';
        });

        // Prevent dropdown mousedown from stealing focus/closing dropdown
        channelDropdown.addEventListener('mousedown', (e) => {
            e.preventDefault();
        });

        // Close dropdown when clicking outside the wrapper
        document.addEventListener('mousedown', (e) => {
            if (channelWrapper && !channelWrapper.contains(e.target)) {
                if (channelDropdown.style.display !== 'none') {
                    channelDropdown.style.display = 'none';
                    updateChannelInputDisplay();
                }
            }
        });

        channelInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                channelDropdown.style.display = 'none';
                updateChannelInputDisplay();
                channelInput.blur();
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
                    ? `Channel "${name}" already exists.`
                    : `Channel "${name}" created!`;
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
                showNotification('Failed to create channel: ' + data.error, 'danger');
            }
        } catch (error) {
            showNotification('Failed to create channel', 'danger');
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
            showNotification('Channel key is required for channels not starting with #', 'warning');
            return;
        }

        // Validate key format if provided
        if (key && !/^[a-f0-9]{32}$/.test(key)) {
            showNotification('Invalid key format. Must be 32 hex characters.', 'warning');
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
                    ? `Already joined channel "${name}".`
                    : `Joined channel "${name}"!`;
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
                showNotification('Failed to join channel: ' + data.error, 'danger');
            }
        } catch (error) {
            showNotification('Failed to join channel', 'danger');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });

    // Scan QR button (placeholder)
    document.getElementById('scanQRBtn').addEventListener('click', function() {
        showNotification('QR scanning feature coming soon! For now, manually enter the channel details.', 'info');
    });

    // Network Commands: Advert button
    document.getElementById('advertBtn').addEventListener('click', async function() {
        await executeSpecialCommand('advert');
    });

    // Network Commands: Flood Advert button (with confirmation)
    document.getElementById('floodadvBtn').addEventListener('click', async function() {
        if (!confirm('Flood Advertisement uses high airtime and should only be used for network recovery.\n\nAre you sure you want to proceed?')) {
            return;
        }
        await executeSpecialCommand('floodadv');
    });

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
            updateStatus('connected');
            updateLastRefresh();
        } else {
            showNotification('Error loading messages: ' + data.error, 'danger');
            clearLoadingSpinner();
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        updateStatus('disconnected');
        clearLoadingSpinner();
        if (error.name === 'AbortError') {
            showNotification('Loading messages timed out — retrying...', 'warning');
            setTimeout(loadMessages, 2000);
        } else {
            showNotification('Failed to load messages', 'danger');
        }
    }
}

function clearLoadingSpinner() {
    const container = document.getElementById('messagesList');
    if (container && container.querySelector('.spinner-border')) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="bi bi-exclamation-triangle"></i>
                <p>Could not load messages</p>
                <small>Will retry automatically</small>
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

    // Clear loading spinner
    container.innerHTML = '';

    if (messages.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="bi bi-chat-dots"></i>
                <p>No messages yet</p>
                <small>Send a message to get started!</small>
            </div>
        `;
        return;
    }

    // Render each message (skip blocked senders client-side as extra safety)
    messages.forEach(msg => {
        if (!msg.is_own && blockedContactNames.has(msg.sender)) return;
        const messageEl = createMessageElement(msg);
        container.appendChild(messageEl);
    });

    // Auto-scroll to bottom if user wasn't scrolling
    if (wasAtBottom) {
        scrollToBottom();
    }

    lastMessageCount = messages.length;

    // Mark current channel as read (update last seen timestamp to latest message)
    if (messages.length > 0 && !currentArchiveDate) {
        const latestTimestamp = Math.max(...messages.map(m => m.timestamp));
        markChannelAsRead(currentChannelIdx, latestTimestamp);
    }

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
        analyzer_url: data.analyzer_url || null,
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

/**
 * Refresh metadata (SNR, hops, route, analyzer) for messages missing it.
 * Fetches /api/messages/<id>/meta for each incomplete message, updates DOM in-place.
 */
async function refreshMessagesMeta() {
    const container = document.getElementById('messagesList');
    if (!container) return;

    // Find message wrappers that don't have full metadata yet
    const wrappers = container.querySelectorAll('.message-wrapper[data-msg-id]');
    for (const wrapper of wrappers) {
        // Skip messages that already have meta info with route/analyzer data
        const metaEl = wrapper.querySelector('.message-meta');
        const actionsEl = wrapper.querySelector('.message-actions');
        const hasRoute = metaEl && metaEl.querySelector('.path-info');
        const hasAnalyzer = actionsEl && actionsEl.querySelector('[title="View in Analyzer"]');
        if (hasRoute && hasAnalyzer) continue;

        const msgId = wrapper.dataset.msgId;
        if (!msgId || msgId.startsWith('_pending_')) continue;

        try {
            const resp = await fetch(`/api/messages/${msgId}/meta`);
            const meta = await resp.json();
            if (!meta.success) continue;

            updateMessageMetaDOM(wrapper, meta);
        } catch (e) {
            console.error(`Error fetching meta for msg #${msgId}:`, e);
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
        metaParts.push(`Hops: ${hopCount}`);
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
        const routeLabel = paths.length > 1 ? `Route (${paths.length})` : 'Route';
        metaParts.push(`<span class="path-info" onclick="showPathsPopup(this, '${pathsData}')">${routeLabel}: ${shortPath}</span>`);
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
        if (meta.analyzer_url) {
            const actionsEl = msgDiv.querySelector('.message-actions');
            if (actionsEl && !actionsEl.querySelector('[title="View in Analyzer"]')) {
                const ignoreBtn = actionsEl.querySelector('[title^="Ignore"]');
                const analyzerBtn = document.createElement('button');
                analyzerBtn.className = 'btn btn-outline-secondary btn-msg-action';
                analyzerBtn.setAttribute('onclick', `window.open('${meta.analyzer_url}', 'meshcore-analyzer')`);
                analyzerBtn.title = 'View in Analyzer';
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
                badge.title = `Heard by ${echoCount} repeater(s): ${echoPaths.join(', ')}`;
                badge.innerHTML = `<i class="bi bi-broadcast"></i> ${echoCount}${pathDisplay}`;
            }
        }

        // Add analyzer button
        if (meta.analyzer_url) {
            const actionsEl = msgDiv.querySelector('.message-actions');
            if (actionsEl && !actionsEl.querySelector('[title="View in Analyzer"]')) {
                const resendBtn = actionsEl.querySelector('[title="Resend"]');
                const analyzerBtn = document.createElement('button');
                analyzerBtn.className = 'btn btn-outline-secondary btn-msg-action';
                analyzerBtn.setAttribute('onclick', `window.open('${meta.analyzer_url}', 'meshcore-analyzer')`);
                analyzerBtn.title = 'View in Analyzer';
                analyzerBtn.innerHTML = '<i class="bi bi-clipboard-data"></i>';
                actionsEl.insertBefore(analyzerBtn, resendBtn);
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
        metaParts.push(`Hops: ${msgHopCount}`);
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
        const routeLabel = msg.paths.length > 1 ? `Route (${msg.paths.length})` : 'Route';
        metaParts.push(`<span class="path-info" onclick="showPathsPopup(this, '${pathsData}')">${routeLabel}: ${shortPath}</span>`);
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
            ? `<span class="echo-badge" title="Heard by ${echoCount} repeater(s): ${echoPaths.join(', ')}">
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
                    <div class="message-content">${processMessageContent(msg.content)}</div>
                    <div class="message-actions justify-content-end">
                        ${echoDisplay}
                        ${msg.analyzer_url ? `
                            <button class="btn btn-outline-secondary btn-msg-action" onclick="window.open('${msg.analyzer_url}', 'meshcore-analyzer')" title="View in Analyzer">
                                <i class="bi bi-clipboard-data"></i>
                            </button>
                        ` : ''}
                        <button class="btn btn-outline-secondary btn-msg-action" onclick='resendMessage(${JSON.stringify(msg.content)})' title="Resend">
                            <i class="bi bi-arrow-repeat"></i>
                        </button>
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
                    <div class="message-content">${processMessageContent(msg.content)}</div>
                    ${metaInfo ? `<div class="message-meta">${metaInfo}</div>` : ''}
                    <div class="message-actions">
                        <button class="btn btn-outline-secondary btn-msg-action" onclick="replyTo('${escapeHtml(msg.sender)}')" title="Reply">
                            <i class="bi bi-reply"></i>
                        </button>
                        <button class="btn btn-outline-secondary btn-msg-action" onclick='quoteTo(${JSON.stringify(msg.sender)}, ${JSON.stringify(msg.content)})' title="Quote">
                            <i class="bi bi-quote"></i>
                        </button>
                        ${contactsGeoCache[msg.sender] ? `
                            <button class="btn btn-outline-secondary btn-msg-action" onclick="showContactOnMap('${escapeHtml(msg.sender)}', ${contactsGeoCache[msg.sender].lat}, ${contactsGeoCache[msg.sender].lon})" title="Show on map">
                                <i class="bi bi-geo-alt"></i>
                            </button>
                        ` : ''}
                        ${msg.analyzer_url ? `
                            <button class="btn btn-outline-secondary btn-msg-action" onclick="window.open('${msg.analyzer_url}', 'meshcore-analyzer')" title="View in Analyzer">
                                <i class="bi bi-clipboard-data"></i>
                            </button>
                        ` : ''}
                        ${contactsPubkeyMap[msg.sender] && !isContactProtectedByName(msg.sender) ? `
                            <button class="btn btn-outline-secondary btn-msg-action" onclick="ignoreContactFromChat('${contactsPubkeyMap[msg.sender]}')" title="Ignore ${escapeHtml(msg.sender)}">
                                <i class="bi bi-eye-slash"></i>
                            </button>
                        ` : ''}
                        ${!isContactProtectedByName(msg.sender) ? `
                        <button class="btn btn-outline-danger btn-msg-action" onclick="blockContactFromChat('${escapeHtml(msg.sender)}')" title="Block ${escapeHtml(msg.sender)}">
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
            showNotification('Message sent', 'success');

            // Replace optimistic ID with real DB id so echo WebSocket updates work
            if (data.id) {
                const wrapper = document.querySelector(`.message-wrapper[data-msg-id="${optimisticId}"]`);
                if (wrapper) wrapper.dataset.msgId = data.id;
            }
            // Use server timestamp to prevent poll-triggered reload due to clock skew
            if (data.timestamp) {
                markChannelAsRead(currentChannelIdx, data.timestamp);
            }
        } else {
            showNotification('Failed to send: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error sending message:', error);
        showNotification('Failed to send message', 'danger');
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
 * Insert a quote into the message input.
 */
function insertQuote(username, quotedText) {
    const input = document.getElementById('messageInput');
    input.value = `@[${username}] »${quotedText}« `;
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
 * Resend a message (paste content back to input)
 * @param {string} content - Message content to resend
 */
function resendMessage(content) {
    const input = document.getElementById('messageInput');
    input.value = content;
    updateCharCounter();
    input.focus();
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
            showNotification('Failed: ' + data.error, 'danger');
        }
    } catch (err) {
        showNotification('Network error', 'danger');
    }
}

async function blockContactFromChat(senderName) {
    if (!confirm(`Block ${senderName}? Their messages will be hidden from chat.`)) return;
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
            showNotification('Failed: ' + data.error, 'danger');
        }
    } catch (err) {
        console.error('Error blocking contact from chat:', err);
        showNotification('Network error', 'danger');
    }
}

/**
 * Show paths popup on tap (mobile-friendly, shows all routes)
 */
function showPathsPopup(element, encodedPaths) {
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
        entry.innerHTML = `${fullRoute}<span class="path-detail">SNR: ${snr} | Hops: ${hops}</span>`;
        entry.title = 'Tap to copy route';
        entry.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(commaRoute).then(() => {
                const orig = entry.innerHTML;
                entry.innerHTML = '<span style="opacity:0.8">Copied!</span>';
                setTimeout(() => { entry.innerHTML = orig; }, 1000);
            });
        });
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
 * Load connection status
 */
async function loadStatus() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();

        if (data.success) {
            updateStatus(data.connected ? 'connected' : 'disconnected');
        }
    } catch (error) {
        console.error('Error loading status:', error);
        updateStatus('disconnected');
    }
}

/**
 * Copy text to clipboard with visual feedback
 */
async function copyToClipboard(text, btnElement) {
    try {
        await navigator.clipboard.writeText(text);
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
    container.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div> Loading...</div>';

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
            container.innerHTML = `<div class="alert alert-warning mb-0">No device info available</div>`;
            return;
        }

        // Type mapping
        const typeNames = { 1: 'Companion', 2: 'Repeater', 3: 'Room Server', 4: 'Sensor' };
        const typeName = typeNames[info.adv_type] || `Unknown (${info.adv_type})`;

        // Shorten public key for display
        const pubKey = info.public_key || '';
        const shortKey = pubKey.length > 12 ? `${pubKey.slice(0, 6)}...${pubKey.slice(-6)}` : pubKey;

        // Location
        const hasLocation = info.adv_lat && info.adv_lon && (info.adv_lat !== 0 || info.adv_lon !== 0);
        const coords = hasLocation ? `${info.adv_lat.toFixed(6)}, ${info.adv_lon.toFixed(6)}` : 'Not available';

        // Build table rows
        const rows = [
            { label: 'Name', value: escapeHtml(info.name || 'Unknown'), copyValue: info.name },
            { label: 'Type', value: typeName },
            { label: 'Public Key', value: `<code class="small">${escapeHtml(shortKey)}</code>`, copyValue: pubKey },
            { label: 'Location', value: coords, showMap: hasLocation, lat: info.adv_lat, lon: info.adv_lon, name: info.name },
            { label: 'TX Power', value: `${info.tx_power || 0} / ${info.max_tx_power || 0} dBm` },
            { label: 'Frequency', value: `${info.radio_freq || 0} MHz` },
            { label: 'Bandwidth', value: `${info.radio_bw || 0} kHz` },
            { label: 'Spreading Factor', value: info.radio_sf || 0 },
            { label: 'Coding Rate', value: `4/${info.radio_cr || 0}` },
            { label: 'Multi Acks', value: info.multi_acks ? 'Enabled' : 'Disabled' },
            { label: 'Location Sharing', value: info.adv_loc_policy ? 'Enabled' : 'Disabled' },
            { label: 'Manual Add Contacts', value: info.manual_add_contacts ? 'Yes' : 'No' }
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
                html += ` <button class="btn btn-link btn-sm p-0 ms-1" onclick="copyToClipboard('${escapeHtml(row.copyValue)}', this)" title="Copy to clipboard"><i class="bi bi-clipboard"></i></button>`;
            }

            // Map button
            if (row.showMap) {
                html += ` <button class="btn btn-link btn-sm p-0 ms-1" onclick="showContactOnMap('${escapeHtml(row.name)}', ${row.lat}, ${row.lon})" title="Show on map"><i class="bi bi-geo-alt"></i></button>`;
            }

            html += '</td>';
            html += '</tr>';
        }

        html += '</tbody></table>';
        container.innerHTML = html;

    } catch (error) {
        console.error('Error loading device info:', error);
        container.innerHTML = '<div class="alert alert-danger mb-0">Failed to load device info</div>';
    }
}

/**
 * Load device statistics (Stats tab in Device modal)
 */
async function loadDeviceStats() {
    const container = document.getElementById('deviceStatsContent');
    if (!container) return;

    container.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div> Loading...</div>';

    try {
        const response = await fetch('/api/device/stats');
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(data.error)}</div>`;
            return;
        }

        const stats = data.stats || {};
        const bat = data.battery || {};
        let html = '<table class="table table-sm mb-0"><tbody>';

        // Battery (from dedicated get_bat or from core stats)
        if (bat && typeof bat === 'object' && bat.voltage) {
            html += `<tr><td class="text-muted">Battery</td><td>${bat.voltage}V</td></tr>`;
        } else if (stats.core && stats.core.battery_mv) {
            html += `<tr><td class="text-muted">Battery</td><td>${(stats.core.battery_mv / 1000).toFixed(2)}V</td></tr>`;
        }

        // Core stats
        if (stats.core) {
            const c = stats.core;
            if (c.uptime !== undefined) {
                const d = Math.floor(c.uptime / 86400);
                const h = Math.floor((c.uptime % 86400) / 3600);
                const m = Math.floor((c.uptime % 3600) / 60);
                html += `<tr><td class="text-muted">Uptime</td><td>${d}d ${h}h ${m}m</td></tr>`;
            }
            if (c.queue_length !== undefined)
                html += `<tr><td class="text-muted">Queue</td><td>${c.queue_length}</td></tr>`;
            if (c.errors !== undefined)
                html += `<tr><td class="text-muted">Errors</td><td>${c.errors}</td></tr>`;
        }

        // Radio stats
        if (stats.radio) {
            const r = stats.radio;
            if (r.tx_air_time !== undefined)
                html += `<tr><td class="text-muted">TX Air Time</td><td>${r.tx_air_time.toFixed(1)} min</td></tr>`;
            if (r.rx_air_time !== undefined)
                html += `<tr><td class="text-muted">RX Air Time</td><td>${r.rx_air_time.toFixed(1)} min</td></tr>`;
        }

        // Packet stats
        if (stats.packets) {
            const p = stats.packets;
            if (p.sent !== undefined)
                html += `<tr><td class="text-muted">Packets TX</td><td>${p.sent.toLocaleString()}</td></tr>`;
            if (p.received !== undefined)
                html += `<tr><td class="text-muted">Packets RX</td><td>${p.received.toLocaleString()}</td></tr>`;
        }

        // DB stats (included in same response)
        if (data.db_stats) {
            const db = data.db_stats;
            if (db.contacts !== undefined)
                html += `<tr><td class="text-muted">Contacts (DB)</td><td>${db.contacts}</td></tr>`;
            if (db.channel_messages !== undefined)
                html += `<tr><td class="text-muted">Channel Msgs</td><td>${db.channel_messages.toLocaleString()}</td></tr>`;
            if (db.direct_messages !== undefined)
                html += `<tr><td class="text-muted">Direct Msgs</td><td>${db.direct_messages.toLocaleString()}</td></tr>`;
            if (db.db_size_bytes !== undefined) {
                const sizeMB = (db.db_size_bytes / (1024 * 1024)).toFixed(1);
                html += `<tr><td class="text-muted">DB Size</td><td>${sizeMB} MB</td></tr>`;
            }
        }

        html += '</tbody></table>';

        if (html === '<table class="table table-sm mb-0"><tbody></tbody></table>') {
            container.innerHTML = '<div class="text-center text-muted py-3">No statistics available</div>';
        } else {
            container.innerHTML = html;
        }

    } catch (error) {
        console.error('Error loading device stats:', error);
        container.innerHTML = '<div class="alert alert-danger mb-0">Failed to load stats</div>';
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

    container.innerHTML = '<div class="text-center py-3"><div class="spinner-border spinner-border-sm"></div> Loading...</div>';

    try {
        const response = await fetch('/api/device/info');
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(data.error)}</div>`;
            return;
        }

        const info = data.info;
        if (!info || !info.public_key || !info.name) {
            container.innerHTML = '<div class="alert alert-warning mb-0">Device info not available</div>';
            return;
        }

        const contactType = info.adv_type || 1;
        const uri = `meshcore://contact/add?name=${encodeURIComponent(info.name)}&public_key=${info.public_key}&type=${contactType}`;

        const typeNames = { 1: 'Companion', 2: 'Repeater', 3: 'Room Server', 4: 'Sensor' };

        let html = '<div class="text-center">';
        html += '<p class="text-muted small mb-3">Share this QR code or URI so others can add your device as a contact.</p>';
        html += '<div id="shareQrCode" class="d-inline-block mb-3"></div>';
        html += '<div class="mb-2"><strong>' + escapeHtml(info.name) + '</strong></div>';
        html += '<div class="text-muted small mb-3">' + escapeHtml(typeNames[contactType] || 'Unknown') + '</div>';
        html += '</div>';

        html += '<div class="mb-3">';
        html += '<label class="form-label text-muted small">Contact URI:</label>';
        html += '<div class="input-group">';
        html += '<input type="text" class="form-control form-control-sm font-monospace" value="' + escapeHtml(uri) + '" readonly id="shareUriInput">';
        html += '<button class="btn btn-outline-secondary btn-sm" onclick="copyToClipboard(document.getElementById(\'shareUriInput\').value, this)" title="Copy URI"><i class="bi bi-clipboard"></i></button>';
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
        container.innerHTML = '<div class="alert alert-danger mb-0">Failed to load device info</div>';
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
        showNotification('Device name cannot be empty', 'danger');
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
            showNotification('Public info saved', 'success');
            _selfInfo = null;
            if (phmSel) phmSel.dataset.initial = phmSel.value;
        } else {
            showNotification(data.error || 'Failed to save', 'danger');
        }
    } catch (e) {
        showNotification('Failed to save public info', 'danger');
    }
}

async function saveDeviceRadioSettings() {
    const freq = parseFloat(document.getElementById('settRadioFreq').value);
    const bw = parseFloat(document.getElementById('settRadioBw').value);
    const sf = parseInt(document.getElementById('settRadioSf').value, 10);
    const cr = parseInt(document.getElementById('settRadioCr').value, 10);
    const txPower = parseInt(document.getElementById('settRadioTxPower').value, 10);

    if (isNaN(freq) || freq < 100 || freq > 1000) {
        showNotification('Invalid frequency', 'danger');
        return;
    }
    if (isNaN(sf) || sf < 5 || sf > 12) {
        showNotification('Spreading factor must be 5-12', 'danger');
        return;
    }
    if (isNaN(cr) || cr < 5 || cr > 8) {
        showNotification('Coding rate must be 5-8', 'danger');
        return;
    }
    if (isNaN(txPower) || txPower < 0 || txPower > 30) {
        showNotification('TX power must be 0-30 dBm', 'danger');
        return;
    }

    if (!confirm('Changing radio settings will disconnect from the mesh network. Continue?')) return;

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
            showNotification('Radio settings saved', 'success');
        } else {
            showNotification(data.error || 'Failed to save', 'danger');
        }
    } catch (e) {
        showNotification('Failed to save radio settings', 'danger');
    }
}

function populateRadioPresets() {
    const select = document.getElementById('settRadioPreset');
    if (!select) return;
    select.innerHTML = '<option value="">Load preset...</option>';
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
    if (label) label.textContent = 'Click on the map to select coordinates';

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
            showNotification(`Invalid value for ${el.previousElementSibling?.textContent || key}`, 'danger');
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
            showNotification('Settings saved', 'success');
        } else {
            const err = await resp.json();
            showNotification(err.error || 'Failed to save', 'danger');
        }
    } catch (e) {
        showNotification('Failed to save settings', 'danger');
    }
}

// --- UI (Interface) Settings ---

const UI_SETTINGS_DEFAULTS = {
    toast_timeout_sec: 2,
    toast_no_autoclose: false,
    toast_position: 'top-left'
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
    const t = document.getElementById('settToastTimeout');
    if (t) t.value = data.toast_timeout_sec ?? UI_SETTINGS_DEFAULTS.toast_timeout_sec;
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
        showNotification('Invalid auto-close duration', 'danger');
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
            showNotification('Settings saved', 'success');
        } else {
            const err = await resp.json();
            showNotification(err.error || 'Failed to save', 'danger');
        }
    } catch (e) {
        showNotification('Failed to save settings', 'danger');
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
            showNotification(`Invalid value for ${el.previousElementSibling?.textContent || key}`, 'danger');
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
            showNotification('Settings saved', 'success');
        } else {
            const err = await resp.json();
            showNotification(err.error || 'Failed to save', 'danger');
        }
    } catch (e) {
        showNotification('Failed to save settings', 'danger');
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

    if (!confirm(`Remove all contacts inactive for more than ${hours} hours?`)) {
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
            showNotification('Cleanup failed: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error cleaning contacts:', error);
        showNotification('Cleanup failed', 'danger');
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
            showNotification(data.message || `${command} sent successfully`, 'success');
        } else {
            showNotification(`Command failed: ${data.error}`, 'danger');
        }

        // Close offcanvas menu after command execution
        const offcanvas = bootstrap.Offcanvas.getInstance(document.getElementById('mainMenu'));
        if (offcanvas) {
            offcanvas.hide();
        }

    } catch (error) {
        console.error(`Error executing ${command}:`, error);
        showNotification(`Failed to execute ${command}`, 'danger');
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
        showNotification('Notifications are not supported in this browser', 'warning');
        return false;
    }

    try {
        const permission = await Notification.requestPermission();

        if (permission === 'granted') {
            localStorage.setItem('mc_notifications_enabled', 'true');
            updateNotificationToggleUI();
            showNotification('Notifications enabled', 'success');
            return true;
        } else if (permission === 'denied') {
            localStorage.setItem('mc_notifications_enabled', 'false');
            updateNotificationToggleUI();
            showNotification('Notifications blocked. Change browser settings to enable them.', 'warning');
            return false;
        }
    } catch (error) {
        console.error('Error requesting notification permission:', error);
        showNotification('Error enabling notifications', 'danger');
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
        statusBadge.textContent = 'Unavailable';
        toggleBtn.disabled = true;
    } else if (permission === 'denied') {
        statusBadge.className = 'badge bg-danger';
        statusBadge.textContent = 'Blocked';
        toggleBtn.disabled = false;
    } else if (permission === 'granted' && isEnabled) {
        statusBadge.className = 'badge bg-success';
        statusBadge.textContent = 'Enabled';
        toggleBtn.disabled = false;
    } else {
        // permission === 'default' OR (permission === 'granted' AND !isEnabled)
        statusBadge.className = 'badge bg-secondary';
        statusBadge.textContent = 'Disabled';
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
            showNotification('Notifications disabled', 'info');
        } else {
            // Turn ON
            localStorage.setItem('mc_notifications_enabled', 'true');
            updateNotificationToggleUI();
            showNotification('Notifications enabled', 'success');
        }
    } else if (permission === 'denied') {
        // Blocked - show help message
        showNotification('Notifications are blocked. Change browser settings: Settings → Site Settings → Notifications', 'warning');
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
            showNotification(data.error || 'Failed to save setting', 'danger');
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
        showNotification('Network error saving setting', 'danger');
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
        parts.push(`${channelCount} ${channelCount === 1 ? 'channel' : 'channels'}`);
    }
    if (dmCount > 0) {
        parts.push(`${dmCount} ${dmCount === 1 ? 'private message' : 'private messages'}`);
    }
    if (pendingCount > 0) {
        parts.push(`${pendingCount} ${pendingCount === 1 ? 'pending contact' : 'pending contacts'}`);
    }

    if (parts.length === 0) return;

    message = `New: ${parts.join(', ')}`;

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
        connected: '<i class="bi bi-circle-fill status-connected"></i> Connected',
        disconnected: '<i class="bi bi-circle-fill status-disconnected"></i> Disconnected',
        connecting: '<i class="bi bi-circle-fill status-connecting"></i> Connecting...'
    };

    statusEl.innerHTML = icons[status] || icons.connecting;
}

/**
 * Update last refresh timestamp
 */
function updateLastRefresh() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString();
    document.getElementById('lastRefresh').textContent = `Updated: ${timeStr}`;
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
                        updateLinkContainer.innerHTML = `<a href="#" onclick="openUpdateModal('${newVersion}', '${githubUrl}'); return false;" class="text-success" title="Click to update"><i class="bi bi-arrow-up-circle-fill"></i> Update now</a>`;
                        updateLinkContainer.classList.remove('d-none');
                    }
                } else {
                    // Show link to GitHub (no remote update available)
                    if (updateLinkContainer) {
                        updateLinkContainer.innerHTML = `<a href="${githubUrl}" target="_blank" class="text-success" title="Update available: ${newVersion}"><i class="bi bi-arrow-up-circle-fill"></i> Update available</a>`;
                        updateLinkContainer.classList.remove('d-none');
                    }
                }
                icon.className = 'bi bi-check-circle-fill text-success';
                showNotification(`Update available: ${data.latest_date}+${data.latest_commit}`, 'success');
            } else {
                // Up to date
                icon.className = 'bi bi-check-circle text-success';
                showNotification('You are running the latest version', 'success');
                // Reset icon after 3 seconds
                setTimeout(() => {
                    icon.className = 'bi bi-arrow-repeat';
                }, 3000);
            }
        } else {
            // Error
            icon.className = 'bi bi-exclamation-triangle text-warning';
            showNotification(data.error || 'Failed to check for updates', 'warning');
            setTimeout(() => {
                icon.className = 'bi bi-arrow-repeat';
            }, 3000);
        }
    } catch (error) {
        console.error('Error checking for updates:', error);
        icon.className = 'bi bi-exclamation-triangle text-danger';
        showNotification('Network error checking for updates', 'danger');
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
    document.getElementById('updateMessage').textContent = `New version available: ${newVersion}`;

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
    document.getElementById('updateProgressMessage').textContent = 'Starting update...';

    try {
        // Trigger update
        const response = await fetch('/api/updater/trigger', { method: 'POST' });
        const data = await response.json();

        if (!data.success) {
            showUpdateResult(false, data.error || 'Failed to start update');
            return;
        }

        document.getElementById('updateProgressMessage').textContent = 'Update started. Waiting for server to restart...';

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
                        showUpdateResult(true, `Updated to ${newVersion}`);
                        return;
                    }
                }
            } catch (e) {
                // Server not responding yet - this is expected during restart
                document.getElementById('updateProgressMessage').textContent =
                    `Rebuilding containers... (${attempts}/${maxAttempts})`;
            }

            if (attempts < maxAttempts) {
                setTimeout(pollForCompletion, pollInterval);
            } else {
                showUpdateResult(false, 'Update timed out. Please check server manually.');
            }
        };

        // Start polling after a short delay
        setTimeout(pollForCompletion, 3000);

    } catch (error) {
        console.error('Update error:', error);
        showUpdateResult(false, 'Network error during update');
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

/**
 * Format timestamp
 */
function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);

    // When viewing archive, always show full date + time
    if (currentArchiveDate) {
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // When viewing live messages, compare calendar dates
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === now.toDateString()) {
        // Today - show time only
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (date.toDateString() === yesterday.toDateString()) {
        // Yesterday
        return 'Yesterday ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
        // Older - show date and time
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

/**
 * Format a unix timestamp as relative time (e.g., "5 min ago", "2h ago")
 */
function formatTimeAgo(timestamp) {
    const now = Math.floor(Date.now() / 1000);
    const diff = now - timestamp;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(timestamp * 1000).toLocaleDateString();
}

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
        option.textContent = `${archive.date} (${archive.message_count} msgs)`;
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
    return `${day}.${month}`;
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
            console.log('Loaded channel read status from server:', lastSeenTimestamps, 'muted:', [...mutedChannels]);
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
            const name = channel ? channel.name : `Channel ${idx}`;
            unreadChannels.push({ idx, count, name });
        }
    }

    if (unreadChannels.length === 0) return;

    // Show confirmation dialog with list of unread channels
    const channelList = unreadChannels.map(ch => `  - ${ch.name} (${ch.count})`).join('\n');
    if (!confirm(`Mark all messages as read?\n\nUnread channels:\n${channelList}`)) return;

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

            // Update UI badges
            updateUnreadBadges();

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

    // Save data for the mobile dropdown
    window._channelDropdownItems = channels;

    // Pre-render dropdown contents (still hidden) and update input display
    renderChannelDropdownItems('');
    updateChannelInputDisplay();

    console.log(`[populateChannelSelector] Loaded ${channels.length} channels, active: ${currentChannelIdx}`);

    // Also populate sidebar (lg+ screens)
    populateChannelSidebar();
}

/**
 * Render channel items into the mobile dropdown, optionally filtered by query.
 */
function renderChannelDropdownItems(query) {
    const dropdown = document.getElementById('channelSelectorDropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '';

    const channels = window._channelDropdownItems || [];
    const q = (query || '').toLowerCase().trim();

    const filtered = q
        ? channels.filter(c => c && c.name && c.name.toLowerCase().includes(q))
        : channels;

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'channel-selector-item text-muted';
        empty.style.cursor = 'default';
        empty.textContent = q ? 'No matches' : 'No channels';
        dropdown.appendChild(empty);
        return;
    }

    filtered.forEach(channel => {
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

    const input = document.getElementById('channelSelectorInput');
    const dropdown = document.getElementById('channelSelectorDropdown');
    if (input) {
        input.value = name;
        input.blur();
    }
    if (dropdown) dropdown.style.display = 'none';

    loadMessages();
    updateChannelSidebarActive();
    showNotification(`Switched to channel: ${name}`, 'info');
}

/**
 * Sync mobile selector input value with the currently active channel name.
 */
function updateChannelInputDisplay() {
    const input = document.getElementById('channelSelectorInput');
    if (!input) return;
    const channels = window._channelDropdownItems || [];
    const current = channels.find(c => c && c.index === currentChannelIdx);
    input.value = current ? current.name : 'Public';
}

/**
 * Load channels list in management modal
 */
async function loadChannelsList() {
    const listEl = document.getElementById('channelsList');
    listEl.innerHTML = '<div class="text-center text-muted py-3"><div class="spinner-border spinner-border-sm"></div> Loading...</div>';

    try {
        const response = await fetch('/api/channels');
        const data = await response.json();

        if (data.success) {
            displayChannelsList(data.channels);
        } else {
            listEl.innerHTML = '<div class="alert alert-danger">Error loading channels</div>';
        }
    } catch (error) {
        listEl.innerHTML = '<div class="alert alert-danger">Failed to load channels</div>';
    }
}

/**
 * Display channels in management modal
 */
function displayChannelsList(channels) {
    const listEl = document.getElementById('channelsList');

    if (channels.length === 0) {
        listEl.innerHTML = '<div class="text-muted text-center py-3">No channels configured</div>';
        return;
    }

    listEl.innerHTML = '';

    channels.forEach(channel => {
        const item = document.createElement('div');
        item.className = 'list-group-item d-flex justify-content-between align-items-center';

        const isPublic = channel.index === 0;

        const isMuted = mutedChannels.has(channel.index);
        item.innerHTML = `
            <div>
                <strong>${escapeHtml(channel.name)}</strong>
            </div>
            <div class="btn-group btn-group-sm">
                <button class="btn ${isMuted ? 'btn-secondary' : 'btn-outline-secondary'}"
                        onclick="toggleChannelMute(${channel.index})"
                        title="${isMuted ? 'Unmute notifications' : 'Mute notifications'}">
                    <i class="bi ${isMuted ? 'bi-bell-slash' : 'bi-bell'}"></i>
                </button>
                <button class="btn btn-outline-primary" onclick="shareChannel(${channel.index})" title="Share">
                    <i class="bi bi-share"></i>
                </button>
                ${!isPublic ? `
                    <button class="btn btn-outline-danger" onclick="deleteChannel(${channel.index})" title="Delete">
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

    const channels = availableChannels.length > 0
        ? availableChannels
        : [{index: 0, name: 'Public', key: ''}];

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
    const input = document.getElementById('channelSelectorInput');
    if (dropdown && dropdown.style.display !== 'none') {
        renderChannelDropdownItems(input ? input.value : '');
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
            showNotification('Failed to update mute state', 'danger');
        }
    } catch (error) {
        showNotification('Failed to update mute state', 'danger');
    }
}

/**
 * Delete channel
 */
async function deleteChannel(index) {
    const channel = availableChannels.find(ch => ch.index === index);
    if (!channel) return;

    if (!confirm(`Remove channel "${channel.name}"?`)) {
        return;
    }

    try {
        const response = await fetch(`/api/channels/${index}`, {
            method: 'DELETE'
        });

        const data = await response.json();

        if (data.success) {
            showNotification(`Channel "${channel.name}" removed`, 'success');

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
            showNotification('Failed to remove channel: ' + data.error, 'danger');
        }
    } catch (error) {
        showNotification('Failed to remove channel', 'danger');
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
            document.getElementById('shareChannelName').textContent = `Channel: ${data.qr_data.name}`;
            document.getElementById('shareChannelQR').src = data.qr_image;
            document.getElementById('shareChannelKey').value = data.qr_data.key;

            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('shareChannelModal'));
            modal.show();
        } else {
            showNotification('Failed to generate QR code: ' + data.error, 'danger');
        }
    } catch (error) {
        showNotification('Failed to generate QR code', 'danger');
    }
}

/**
 * Copy channel key to clipboard
 */
async function copyChannelKey() {
    const input = document.getElementById('shareChannelKey');
    try {
        // Use modern Clipboard API
        await navigator.clipboard.writeText(input.value);
        showNotification('Channel key copied to clipboard!', 'success');
    } catch (error) {
        // Fallback for older browsers
        input.select();
        try {
            document.execCommand('copy');
            showNotification('Channel key copied to clipboard!', 'success');
        } catch (fallbackError) {
            showNotification('Failed to copy to clipboard', 'danger');
        }
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
    // Update menu badge
    const menuBadge = document.getElementById('dmMenuBadge');
    if (menuBadge) {
        if (totalUnread > 0) {
            menuBadge.textContent = totalUnread > 99 ? '99+' : totalUnread;
            menuBadge.style.display = 'inline-block';
        } else {
            menuBadge.style.display = 'none';
        }
    }

    // Update FAB badge (green badge on Direct Messages button)
    updateFabBadge('.fab-dm', 'fab-badge-dm', totalUnread);
}

/**
 * Update pending contacts badge on Contact Management FAB button
 * Fetches count from API using type filter from localStorage
 */
async function updatePendingContactsBadge() {
    try {
        // Suppress: hide FAB badge entirely, skip browser notification path
        if (window.contactsSettings?.suppress_advert_notifications) {
            updateFabBadge('.fab-contacts', 'fab-badge-pending', 0);
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
            // Update FAB badge (orange badge on Contact Management button)
            updateFabBadge('.fab-contacts', 'fab-badge-pending', count);

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
        list.innerHTML = '<div class="mentions-empty">No contacts found</div>';
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

function initializeFabToggle() {
    const toggle = document.getElementById('fabToggle');
    const container = document.getElementById('fabContainer');
    if (!toggle || !container) return;

    // Restore collapsed state
    if (localStorage.getItem('mc-webui-fab-collapsed') === '1') {
        container.classList.add('collapsed');
        toggle.title = 'Show buttons';
    }

    toggle.addEventListener('click', () => {
        container.classList.toggle('collapsed');
        const isCollapsed = container.classList.contains('collapsed');
        toggle.title = isCollapsed ? 'Show buttons' : 'Hide buttons';
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
            <p>No messages match "${escapeHtml(currentFilterQuery)}"</p>
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
        list.innerHTML = '<div class="mentions-empty">No contacts found</div>';
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
        container.innerHTML = '<div class="text-center text-muted py-4"><p>Type at least 2 characters to search</p></div>';
        return;
    }

    container.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm"></div> Searching...</div>';

    try {
        const response = await fetch(`/api/messages/search?q=${encodeURIComponent(query)}&limit=50`);
        const data = await response.json();

        if (!data.success) {
            container.innerHTML = `<div class="alert alert-danger">${escapeHtml(data.error)}</div>`;
            return;
        }

        if (data.results.length === 0) {
            container.innerHTML = `<div class="text-center text-muted py-4"><i class="bi bi-inbox" style="font-size: 2rem;"></i><p class="mt-2">No results for "${escapeHtml(query)}"</p></div>`;
            return;
        }

        container.innerHTML = `<div class="text-muted small mb-2">${data.count} result${data.count !== 1 ? 's' : ''}</div>`;

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
                            <span class="text-muted small">${r.direction === 'out' ? '(sent)' : '(received)'}</span>
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
        container.innerHTML = '<div class="alert alert-danger">Search failed. Please try again.</div>';
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
    document.getElementById('backupModal')?.addEventListener('shown.bs.modal', loadBackupList);
}

async function loadBackupList() {
    const container = document.getElementById('backupList');
    const statusEl = document.getElementById('backupAutoStatus');
    if (!container) return;

    container.innerHTML = '<div class="text-center text-muted py-3"><div class="spinner-border spinner-border-sm"></div> Loading...</div>';

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
                ? `Auto: daily at ${String(data.backup_hour).padStart(2, '0')}:00, keep ${data.retention_days}d`
                : 'Auto-backup disabled';
        }

        if (data.backups.length === 0) {
            container.innerHTML = '<div class="text-center text-muted py-3"><i class="bi bi-inbox"></i><p class="mt-2 mb-0">No backups yet</p></div>';
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
                <a href="/api/backup/download?file=${encodeURIComponent(b.filename)}" class="btn btn-sm btn-outline-primary" title="Download">
                    <i class="bi bi-download"></i>
                </a>
            `;
            list.appendChild(item);
        });

        container.innerHTML = '';
        container.appendChild(list);

    } catch (error) {
        console.error('Error loading backups:', error);
        container.innerHTML = '<div class="alert alert-danger">Failed to load backups</div>';
    }
}

async function createBackup() {
    const btn = document.getElementById('createBackupBtn');
    if (!btn) return;

    btn.disabled = true;
    btn.innerHTML = '<div class="spinner-border spinner-border-sm"></div> Creating...';

    try {
        const response = await fetch('/api/backup/create', { method: 'POST' });
        const data = await response.json();

        if (data.success) {
            showNotification(`Backup created: ${data.filename}`, 'success');
            loadBackupList();
        } else {
            showNotification('Backup failed: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error creating backup:', error);
        showNotification('Backup failed', 'danger');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-plus-circle"></i> Create Backup';
    }
}

document.addEventListener('DOMContentLoaded', initializeBackup);

