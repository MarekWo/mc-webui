/**
 * mc-webui Frontend Application
 */

// Global state
let lastMessageCount = 0;
let autoRefreshInterval = null;
let isUserScrolling = false;
let currentArchiveDate = null;  // Current selected archive date (null = live)
let currentChannelIdx = 0;  // Current active channel (0 = Public)
let availableChannels = [];  // List of channels from API
let lastSeenTimestamps = {};  // Track last seen message timestamp per channel
let unreadCounts = {};  // Track unread message counts per channel

// DM state (for badge updates on main page)
let dmLastSeenTimestamps = {};  // Track last seen DM timestamp per conversation
let dmUnreadCounts = {};  // Track unread DM counts per conversation

// Map state (Leaflet)
let leafletMap = null;
let markersGroup = null;
let contactsGeoCache = {};  // { 'contactName': { lat, lon }, ... }
let allContactsWithGps = [];  // Cached contacts for map filtering

// Contact type colors for map markers
const CONTACT_TYPE_COLORS = {
    1: '#2196F3',  // CLI - blue
    2: '#4CAF50',  // REP - green
    3: '#9C27B0',  // ROOM - purple
    4: '#FF9800'   // SENS - orange
};

const CONTACT_TYPE_NAMES = {
    1: 'CLI',
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
 * Get selected contact types from map filter checkboxes
 */
function getSelectedMapTypes() {
    const types = [];
    if (document.getElementById('mapFilterCLI')?.checked) types.push(1);
    if (document.getElementById('mapFilterREP')?.checked) types.push(2);
    if (document.getElementById('mapFilterROOM')?.checked) types.push(3);
    if (document.getElementById('mapFilterSENS')?.checked) types.push(4);
    return types;
}

/**
 * Update map markers based on current filter selection
 */
function updateMapMarkers() {
    if (!leafletMap || !markersGroup) return;

    markersGroup.clearLayers();
    const selectedTypes = getSelectedMapTypes();

    const filteredContacts = allContactsWithGps.filter(c => selectedTypes.includes(c.type));

    if (filteredContacts.length === 0) {
        leafletMap.setView([52.0, 19.0], 6);
        return;
    }

    const bounds = [];
    filteredContacts.forEach(c => {
        const color = CONTACT_TYPE_COLORS[c.type] || '#2196F3';
        const typeName = CONTACT_TYPE_NAMES[c.type] || 'Unknown';

        L.circleMarker([c.adv_lat, c.adv_lon], {
            radius: 10,
            fillColor: color,
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        })
            .addTo(markersGroup)
            .bindPopup(`<b>${c.name}</b><br><span class="text-muted">${typeName}</span>`);

        bounds.push([c.adv_lat, c.adv_lon]);
    });

    if (bounds.length === 1) {
        leafletMap.setView(bounds[0], 13);
    } else {
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
            const response = await fetch('/api/contacts/detailed');
            const data = await response.json();

            if (data.success && data.contacts) {
                allContactsWithGps = data.contacts.filter(c =>
                    c.adv_lat && c.adv_lon && (c.adv_lat !== 0 || c.adv_lon !== 0)
                );

                updateMapMarkers();
            }
        } catch (err) {
            console.error('Error loading contacts for map:', err);
        }

        leafletMap.invalidateSize();
        modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    // Setup filter checkbox listeners
    ['mapFilterCLI', 'mapFilterREP', 'mapFilterROOM', 'mapFilterSENS'].forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.onchange = updateMapMarkers;
        }
    });

    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
}

/**
 * Load contacts geo cache for message map buttons
 */
async function loadContactsGeoCache() {
    try {
        const response = await fetch('/api/contacts/detailed');
        const data = await response.json();

        if (data.success && data.contacts) {
            contactsGeoCache = {};
            data.contacts.forEach(c => {
                if (c.adv_lat && c.adv_lon && (c.adv_lat !== 0 || c.adv_lon !== 0)) {
                    contactsGeoCache[c.name] = { lat: c.adv_lat, lon: c.adv_lon };
                }
            });
            console.log(`Loaded geo cache for ${Object.keys(contactsGeoCache).length} contacts`);
        }
    } catch (err) {
        console.error('Error loading contacts geo cache:', err);
    }
}

// Initialize on page load
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

    // Setup auto-refresh immediately after messages are displayed
    // Don't wait for geo cache - it's not needed for auto-refresh
    setupAutoRefresh();

    console.log(`[init] UI ready in ${(performance.now() - initStart).toFixed(0)}ms`);

    // DEFERRED: Check for updates AFTER messages are displayed
    // This updates the unread badges without blocking initial load
    checkForUpdates();  // No await - runs in background

    // Geo cache loads in background - Map buttons will work once it completes
    // No need to await - just let it finish whenever
    geoCachePromise.then(() => {
        console.log(`[init] Geo cache loaded in ${(performance.now() - initStart).toFixed(0)}ms`);
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

    // Track user scrolling
    const container = document.getElementById('messagesContainer');
    container.addEventListener('scroll', function() {
        const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 100;
        isUserScrolling = !isAtBottom;
    });

    // Load device info when settings modal opens
    const settingsModal = document.getElementById('settingsModal');
    settingsModal.addEventListener('show.bs.modal', function() {
        loadDeviceInfo();
    });

    // Channel selector
    document.getElementById('channelSelector').addEventListener('change', function(e) {
        currentChannelIdx = parseInt(e.target.value);
        localStorage.setItem('mc_active_channel', currentChannelIdx);
        loadMessages();

        // Show notification only if we have a valid selection
        const selectedOption = e.target.options[e.target.selectedIndex];
        if (selectedOption) {
            const channelName = selectedOption.text;
            showNotification(`Switched to channel: ${channelName}`, 'info');
        }
    });

    // Channels modal - load channels when opened
    const channelsModal = document.getElementById('channelsModal');
    channelsModal.addEventListener('show.bs.modal', function() {
        loadChannelsList();
    });

    // Create channel form
    document.getElementById('createChannelForm').addEventListener('submit', async function(e) {
        e.preventDefault();

        const name = document.getElementById('newChannelName').value.trim();

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
                showNotification(`Channel "${name}" created!`, 'success');

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
        }
    });

    // Join channel form
    document.getElementById('joinChannelFormSubmit').addEventListener('submit', async function(e) {
        e.preventDefault();

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
                showNotification(`Joined channel "${name}"!`, 'success');

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

        const response = await fetch(url);
        const data = await response.json();

        if (data.success) {
            displayMessages(data.messages);
            updateStatus('connected');
            updateLastRefresh();
        } else {
            showNotification('Error loading messages: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        updateStatus('disconnected');
        showNotification('Failed to load messages', 'danger');
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

    // Render each message
    messages.forEach(msg => {
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
}

/**
 * Create message DOM element
 */
function createMessageElement(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.is_own ? 'own' : 'other'}`;

    const time = formatTime(msg.timestamp);

    let metaInfo = '';
    if (msg.snr !== undefined && msg.snr !== null) {
        metaInfo += `SNR: ${msg.snr.toFixed(1)} dB`;
    }
    if (msg.path_len !== undefined && msg.path_len !== null) {
        metaInfo += ` | Hops: ${msg.path_len}`;
    }

    div.innerHTML = `
        <div class="message-header">
            <span class="message-sender">${escapeHtml(msg.sender)}</span>
            <span class="message-time">${time}</span>
        </div>
        <p class="message-content">${processMessageContent(msg.content)}</p>
        ${metaInfo ? `<div class="message-meta">${metaInfo}</div>` : ''}
        ${!msg.is_own ? `
            <div class="mt-1 d-flex gap-1">
                <button class="btn btn-outline-secondary btn-msg-action" onclick="replyTo('${escapeHtml(msg.sender)}')" title="Reply">
                    <i class="bi bi-reply"></i>
                </button>
                ${contactsGeoCache[msg.sender] ? `
                    <button class="btn btn-outline-primary btn-msg-action" onclick="showContactOnMap('${escapeHtml(msg.sender)}', ${contactsGeoCache[msg.sender].lat}, ${contactsGeoCache[msg.sender].lon})" title="Show on map">
                        <i class="bi bi-geo-alt"></i>
                    </button>
                ` : ''}
            </div>
        ` : ''}
    `;

    return div;
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
            input.value = '';
            updateCharCounter();
            showNotification('Message sent', 'success');

            // Reload messages after short delay
            setTimeout(() => loadMessages(), 1000);
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
 * Load device information
 */
async function loadDeviceInfo() {
    const infoEl = document.getElementById('deviceInfo');
    infoEl.innerHTML = '<div class="spinner-border spinner-border-sm"></div> Loading...';

    try {
        const response = await fetch('/api/device/info');
        const data = await response.json();

        if (data.success) {
            infoEl.innerHTML = `<pre class="mb-0">${escapeHtml(data.info)}</pre>`;
        } else {
            infoEl.innerHTML = `<span class="text-danger">Error: ${escapeHtml(data.error)}</span>`;
        }
    } catch (error) {
        infoEl.innerHTML = '<span class="text-danger">Failed to load device info</span>';
    }
}

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

/**
 * Setup intelligent auto-refresh
 * Checks for updates regularly but only refreshes UI when new messages arrive
 */
function setupAutoRefresh() {
    // Check every 10 seconds for new messages (lightweight check)
    const checkInterval = 10000;

    autoRefreshInterval = setInterval(async () => {
        // Don't check for updates when viewing archives
        if (currentArchiveDate) {
            return;
        }

        await checkForUpdates();
        await checkDmUpdates();  // Also check for DM updates
        await updatePendingContactsBadge();  // Also check for pending contacts
    }, checkInterval);

    console.log(`Intelligent auto-refresh enabled: checking every ${checkInterval / 1000}s`);
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
    // Calculate current totals
    const currentTotalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);

    // Get DM unread count from badge
    const dmBadge = document.querySelector('.fab-badge-dm');
    const currentDmUnread = dmBadge ? parseInt(dmBadge.textContent) || 0 : 0;

    // Get pending contacts count from badge
    const pendingBadge = document.querySelector('.fab-badge-pending');
    const currentPendingCount = pendingBadge ? parseInt(pendingBadge.textContent) || 0 : 0;

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

    // Calculate total unread
    const channelUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);

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

    const toast = new bootstrap.Toast(toastEl, {
        autohide: true,
        delay: 1500
    });
    toast.show();
}

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

    // When viewing live messages, use relative time
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        // Today - show time only
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        // Yesterday
        return 'Yesterday ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
        // Older - show date and time
        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
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
    const maxBytes = 140;

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
            console.log('Loaded channel read status from server:', lastSeenTimestamps);
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
            // Update unread counts
            data.channels.forEach(channel => {
                unreadCounts[channel.index] = channel.unread_count;
            });

            // Update UI badges
            updateUnreadBadges();

            // Check if we should send browser notification
            checkAndNotify();

            // If current channel has updates, refresh the view
            const currentChannelUpdate = data.channels.find(ch => ch.index === currentChannelIdx);
            if (currentChannelUpdate && currentChannelUpdate.has_updates) {
                console.log(`New messages detected on channel ${currentChannelIdx}, refreshing...`);
                await loadMessages();
            }
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
    // Update channel selector options
    const selector = document.getElementById('channelSelector');
    if (selector) {
        Array.from(selector.options).forEach(option => {
            const channelIdx = parseInt(option.value);
            const unreadCount = unreadCounts[channelIdx] || 0;

            // Get base channel name (remove existing badge if any)
            let channelName = option.textContent.replace(/\s*\(\d+\)$/, '');

            // Add badge if there are unread messages and it's not the current channel
            if (unreadCount > 0 && channelIdx !== currentChannelIdx) {
                option.textContent = `${channelName} (${unreadCount})`;
            } else {
                option.textContent = channelName;
            }
        });
    }

    // Update notification bell
    const totalUnread = Object.values(unreadCounts).reduce((sum, count) => sum + count, 0);
    updateNotificationBell(totalUnread);

    // Update app icon badge
    updateAppBadge();
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
 * Fallback: ensure Public channel exists in dropdown even if API fails
 */
function ensurePublicChannel() {
    const selector = document.getElementById('channelSelector');
    if (!selector || selector.options.length === 0) {
        console.log('[ensurePublicChannel] Adding fallback Public channel');
        availableChannels = [{index: 0, name: 'Public', key: ''}];
        populateChannelSelector(availableChannels);
    }
}

/**
 * Populate channel selector dropdown
 */
function populateChannelSelector(channels) {
    const selector = document.getElementById('channelSelector');
    if (!selector) {
        console.error('[populateChannelSelector] Channel selector element not found');
        return;
    }

    // Validate input
    if (!channels || !Array.isArray(channels) || channels.length === 0) {
        console.warn('[populateChannelSelector] Invalid channels array, using fallback');
        channels = [{index: 0, name: 'Public', key: ''}];
    }

    // Remove all options - we'll rebuild everything from API data
    while (selector.options.length > 0) {
        selector.remove(0);
    }

    // Add all channels from API (including Public at index 0)
    channels.forEach(channel => {
        if (channel && typeof channel.index !== 'undefined' && channel.name) {
            const option = document.createElement('option');
            option.value = channel.index;
            option.textContent = channel.name;
            selector.appendChild(option);
        } else {
            console.warn('[populateChannelSelector] Skipping invalid channel:', channel);
        }
    });

    // Restore selection (use currentChannelIdx from global state)
    selector.value = currentChannelIdx;

    // If the saved channel doesn't exist, fall back to Public (0)
    if (selector.value !== currentChannelIdx.toString()) {
        console.log(`[populateChannelSelector] Channel ${currentChannelIdx} not found, falling back to Public`);
        currentChannelIdx = 0;
        selector.value = 0;
        localStorage.setItem('mc_active_channel', '0');
    }

    console.log(`[populateChannelSelector] Loaded ${channels.length} channels, active: ${currentChannelIdx}`);
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

        item.innerHTML = `
            <div>
                <strong>${escapeHtml(channel.name)}</strong>
                <br>
                <small class="text-muted font-monospace">${channel.key}</small>
            </div>
            <div class="btn-group btn-group-sm">
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
 * @returns {Array<number>} Array of contact types (default: [1] for CLI only)
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
    // Default: CLI only (most common use case)
    return [1];
}

