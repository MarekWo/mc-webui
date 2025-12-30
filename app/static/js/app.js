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

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
    console.log('mc-webui initialized');

    // Load last seen timestamps from localStorage
    loadLastSeenTimestamps();
    loadDmLastSeenTimestamps();

    // Restore last selected channel from localStorage
    const savedChannel = localStorage.getItem('mc_active_channel');
    if (savedChannel !== null) {
        currentChannelIdx = parseInt(savedChannel);
    }

    // Setup event listeners (do this early)
    setupEventListeners();

    // Setup emoji picker
    setupEmojiPicker();

    // CRITICAL: Load channels FIRST before anything else
    // This ensures channels are available for checkForUpdates()
    await loadChannels();

    // Now load other data (can run in parallel)
    loadArchiveList();
    loadMessages();
    loadStatus();

    // Setup auto-refresh AFTER channels are loaded
    setupAutoRefresh();
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
        <p class="message-content">${escapeHtml(msg.content)}</p>
        ${metaInfo ? `<div class="message-meta">${metaInfo}</div>` : ''}
        ${!msg.is_own ? `
            <div class="mt-1">
                <button class="btn btn-outline-secondary btn-sm btn-reply" onclick="replyTo('${escapeHtml(msg.sender)}')">
                    <i class="bi bi-reply"></i> Reply
                </button>
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
    }, checkInterval);

    console.log(`Intelligent auto-refresh enabled: checking every ${checkInterval / 1000}s`);
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
    document.getElementById('lastRefresh').textContent = `Last refresh: ${timeStr}`;
}

/**
 * Show notification toast
 */
function showNotification(message, type = 'info') {
    const toastEl = document.getElementById('notificationToast');
    const toastBody = toastEl.querySelector('.toast-body');

    toastBody.textContent = message;
    toastEl.className = `toast bg-${type} text-white`;

    const toast = new bootstrap.Toast(toastEl);
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
 * Load last seen timestamps from localStorage
 */
function loadLastSeenTimestamps() {
    try {
        const saved = localStorage.getItem('mc_last_seen_timestamps');
        if (saved) {
            lastSeenTimestamps = JSON.parse(saved);
            console.log('Loaded last seen timestamps:', lastSeenTimestamps);
        }
    } catch (error) {
        console.error('Error loading last seen timestamps:', error);
        lastSeenTimestamps = {};
    }
}

/**
 * Save last seen timestamps to localStorage
 */
function saveLastSeenTimestamps() {
    try {
        localStorage.setItem('mc_last_seen_timestamps', JSON.stringify(lastSeenTimestamps));
    } catch (error) {
        console.error('Error saving last seen timestamps:', error);
    }
}

/**
 * Update last seen timestamp for current channel
 */
function markChannelAsRead(channelIdx, timestamp) {
    lastSeenTimestamps[channelIdx] = timestamp;
    unreadCounts[channelIdx] = 0;
    saveLastSeenTimestamps();
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

            // Check for unread messages after channels are loaded
            await checkForUpdates();
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
 * Load DM last seen timestamps from localStorage
 */
function loadDmLastSeenTimestamps() {
    try {
        const saved = localStorage.getItem('mc_dm_last_seen_timestamps');
        if (saved) {
            dmLastSeenTimestamps = JSON.parse(saved);
            console.log('Loaded DM last seen timestamps:', Object.keys(dmLastSeenTimestamps).length);
        }
    } catch (error) {
        console.error('Error loading DM last seen timestamps:', error);
        dmLastSeenTimestamps = {};
    }
}

/**
 * Save DM last seen timestamps to localStorage
 */
function saveDmLastSeenTimestamps() {
    try {
        localStorage.setItem('mc_dm_last_seen_timestamps', JSON.stringify(dmLastSeenTimestamps));
    } catch (error) {
        console.error('Error saving DM last seen timestamps:', error);
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

    // Update notification bell (secondary badge)
    const bellContainer = document.getElementById('notificationBell');
    if (!bellContainer) return;

    let dmBadge = bellContainer.querySelector('.notification-badge-dm');

    if (totalUnread > 0) {
        if (!dmBadge) {
            dmBadge = document.createElement('span');
            dmBadge.className = 'notification-badge-dm';
            bellContainer.appendChild(dmBadge);
        }
        dmBadge.textContent = totalUnread > 99 ? '99+' : totalUnread;
        dmBadge.style.display = 'inline-block';

        // Animate bell
        const bellIcon = bellContainer.querySelector('i');
        if (bellIcon) {
            bellIcon.classList.add('bell-ring');
            setTimeout(() => bellIcon.classList.remove('bell-ring'), 1000);
        }
    } else if (dmBadge) {
        dmBadge.style.display = 'none';
    }
}

