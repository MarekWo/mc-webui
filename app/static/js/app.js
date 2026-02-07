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

// Mentions autocomplete state
let mentionsCache = [];              // Cached contact list
let mentionsCacheTimestamp = 0;      // Cache timestamp
let mentionStartPos = -1;            // Position of @ in textarea
let mentionSelectedIndex = 0;        // Currently highlighted item
let isMentionMode = false;           // Is mention dropdown active

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
 * Get selected contact types from map filter badges
 */
function getSelectedMapTypes() {
    const types = [];
    if (document.getElementById('mapFilterCLI')?.classList.contains('active')) types.push(1);
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

    // Setup filter badge listeners
    ['mapFilterCLI', 'mapFilterREP', 'mapFilterROOM', 'mapFilterSENS'].forEach(id => {
        const badge = document.getElementById(id);
        if (badge) {
            badge.onclick = () => {
                badge.classList.toggle('active');
                updateMapMarkers();
            };
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

    // Initialize filter functionality
    initializeFilter();

    // Setup auto-refresh immediately after messages are displayed
    // Don't wait for geo cache - it's not needed for auto-refresh
    setupAutoRefresh();

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

    // Re-apply filter if active
    clearFilterState();
}

/**
 * Create message DOM element
 */
function createMessageElement(msg) {
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${msg.is_own ? 'own' : 'other'}`;

    const time = formatTime(msg.timestamp);

    let metaInfo = '';
    if (msg.snr !== undefined && msg.snr !== null) {
        metaInfo += `SNR: ${msg.snr.toFixed(1)} dB`;
    }
    if (msg.path_len !== undefined && msg.path_len !== null) {
        metaInfo += ` | Hops: ${msg.path_len}`;
    }
    if (msg.path) {
        const segments = msg.path.match(/.{1,2}/g) || [];
        const fullPath = segments.join(' \u2192 ');
        const shortPath = segments.length > 4
            ? `${segments[0]}\u2192...\u2192${segments[segments.length - 1]}`
            : segments.join('\u2192');
        metaInfo += ` | <span class="path-info" title="Path: ${fullPath}">Route: ${shortPath}</span>`;
    }

    if (msg.is_own) {
        // Own messages: right-aligned, no avatar
        // Echo badge shows unique repeaters that heard the message + their path codes
        const echoPaths = [...new Set((msg.echo_paths || []).map(p => p.substring(0, 2)))];
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

            // Reload messages after short delay to show sent message
            setTimeout(() => loadMessages(), 1000);
            // Reload again to catch echo counts (echoes typically arrive within 5-30 seconds)
            setTimeout(() => loadMessages(), 6000);
            setTimeout(() => loadMessages(), 15000);
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
 * Quote a user's message
 * @param {string} username - Username to mention
 * @param {string} content - Original message content to quote
 */
function quoteTo(username, content) {
    const input = document.getElementById('messageInput');
    const maxQuoteBytes = 20;

    // Calculate UTF-8 byte length
    const encoder = new TextEncoder();
    const contentBytes = encoder.encode(content);

    let quotedText;
    if (contentBytes.length <= maxQuoteBytes) {
        quotedText = content;
    } else {
        // Truncate to ~maxQuoteBytes, being careful with multi-byte characters
        let truncated = '';
        let byteCount = 0;
        for (const char of content) {
            const charBytes = encoder.encode(char).length;
            if (byteCount + charBytes > maxQuoteBytes) break;
            truncated += char;
            byteCount += charBytes;
        }
        quotedText = truncated + '...';
    }

    input.value = `@[${username}] »${quotedText}« `;
    updateCharCounter();
    input.focus();
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

        // Parse JSON from the info string
        let info;
        try {
            // Extract JSON part (skip the header lines like "MarWoj|*...")
            const jsonMatch = data.info.match(/\{[\s\S]*\}/);
            info = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        } catch (e) {
            container.innerHTML = `<pre class="mb-0 small">${escapeHtml(data.info)}</pre>`;
            return;
        }

        if (!info) {
            container.innerHTML = `<pre class="mb-0 small">${escapeHtml(data.info)}</pre>`;
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
        const response = await fetch('/api/contacts');
        const data = await response.json();

        if (data.success && data.contacts) {
            mentionsCache = data.contacts;
            mentionsCacheTimestamp = now;
            console.log(`[mentions] Cached ${mentionsCache.length} contacts`);
        }
    } catch (error) {
        console.error('[mentions] Error loading contacts:', error);
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

    // Filter as user types (debounced)
    let filterTimeout = null;
    filterInput.addEventListener('input', () => {
        clearTimeout(filterTimeout);
        filterTimeout = setTimeout(() => {
            applyFilter(filterInput.value);
        }, 150);
    });

    // Clear filter
    filterClearBtn.addEventListener('click', () => {
        filterInput.value = '';
        applyFilter('');
        filterInput.focus();
    });

    // Close filter bar
    filterCloseBtn.addEventListener('click', () => {
        closeFilterBar();
    });

    // Keyboard shortcuts
    filterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeFilterBar();
        }
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

