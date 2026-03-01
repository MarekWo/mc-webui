/**
 * mc-webui Direct Messages JavaScript
 * Full-page DM view functionality
 */

// State variables
let currentConversationId = null;
let currentRecipient = null;
let dmConversations = [];
let contactsList = [];  // List of all contacts from device
let dmLastSeenTimestamps = {};
let autoRefreshInterval = null;
let lastMessageTimestamp = 0;  // Track latest message timestamp for smart refresh

/**
 * Get display-friendly name (truncate full pubkeys to short prefix)
 */
function displayName(name) {
    if (!name) return 'Unknown';
    if (/^[0-9a-f]{64}$/i.test(name)) return name.substring(0, 8) + '...';
    return name;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
    console.log('DM page initialized');

    // Force viewport recalculation on PWA navigation
    // This fixes the bottom bar visibility issue when navigating from main page
    window.scrollTo(0, 0);
    // Trigger resize event to force browser to recalculate viewport height
    window.dispatchEvent(new Event('resize'));
    // Force reflow to ensure proper layout calculation
    document.body.offsetHeight;

    // Load last seen timestamps from server
    await loadDmLastSeenTimestampsFromServer();

    // Setup event listeners
    setupEventListeners();

    // Setup emoji picker
    setupEmojiPicker();

    // Load conversations into dropdown
    await loadConversations();

    // Load connection status
    await loadStatus();

    // Check for initial conversation from URL parameter, or restore last active conversation
    if (window.MC_CONFIG && window.MC_CONFIG.initialConversation) {
        const convId = window.MC_CONFIG.initialConversation;
        // Find the conversation in the list or use the ID directly
        selectConversation(convId);
    } else {
        // Restore last selected conversation from localStorage
        const savedConversation = localStorage.getItem('mc_active_dm_conversation');
        if (savedConversation) {
            selectConversation(savedConversation);
        }
    }

    // Initialize filter functionality
    initializeDmFilter();

    // Initialize FAB toggle
    initializeDmFabToggle();

    // Load auto-retry config
    loadAutoRetryConfig();

    // Setup auto-refresh
    setupAutoRefresh();
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
    }
});

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Conversation selector
    const selector = document.getElementById('dmConversationSelector');
    if (selector) {
        selector.addEventListener('change', function() {
            const convId = this.value;
            if (convId) {
                selectConversation(convId);
            } else {
                clearConversation();
            }
        });
    }

    // Send form
    const sendForm = document.getElementById('dmSendForm');
    if (sendForm) {
        sendForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            await sendMessage();
        });
    }

    // Message input
    const input = document.getElementById('dmMessageInput');
    if (input) {
        input.addEventListener('input', updateCharCounter);

        // Enter key to send
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }

    // Scroll-to-bottom button
    const messagesContainer = document.getElementById('dmMessagesContainer');
    const scrollToBottomBtn = document.getElementById('dmScrollToBottomBtn');
    if (messagesContainer && scrollToBottomBtn) {
        messagesContainer.addEventListener('scroll', function() {
            const isAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop <= messagesContainer.clientHeight + 100;
            if (isAtBottom) {
                scrollToBottomBtn.classList.remove('visible');
            } else {
                scrollToBottomBtn.classList.add('visible');
            }
        });

        scrollToBottomBtn.addEventListener('click', function() {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
            scrollToBottomBtn.classList.remove('visible');
        });
    }
}

/**
 * Load contacts from device
 */
async function loadContacts() {
    try {
        const response = await fetch('/api/contacts');
        const data = await response.json();

        if (data.success) {
            contactsList = data.contacts || [];
            console.log(`[DM] Loaded ${contactsList.length} contacts:`, contactsList);
        } else {
            console.error('[DM] Failed to load contacts:', data.error);
            contactsList = [];
        }
    } catch (error) {
        console.error('[DM] Error loading contacts:', error);
        contactsList = [];
    }
}

/**
 * Load conversations from API
 */
async function loadConversations() {
    try {
        // Load both conversations and contacts in parallel
        const [convResponse, _] = await Promise.all([
            fetch('/api/dm/conversations?days=7'),
            loadContacts()
        ]);

        const convData = await convResponse.json();

        if (convData.success) {
            dmConversations = convData.conversations || [];
            populateConversationSelector();

            // Check for new DM notifications
            checkDmNotifications(dmConversations);
        } else {
            console.error('Failed to load conversations:', convData.error);
            // Still populate selector with just contacts
            populateConversationSelector();
        }
    } catch (error) {
        console.error('Error loading conversations:', error);
    }
}

/**
 * Populate the conversation selector dropdown
 * Shows both existing conversations and all contacts
 */
function populateConversationSelector() {
    const selector = document.getElementById('dmConversationSelector');
    if (!selector) return;

    // Clear existing options
    selector.innerHTML = '<option value="">Select chat...</option>';

    // Track which names are already in conversations
    const conversationNames = new Set();

    // 1. Add existing conversations (with history)
    if (dmConversations.length > 0) {
        dmConversations.forEach(conv => {
            const opt = document.createElement('option');
            opt.value = conv.conversation_id;

            // Show unread indicator
            const lastSeen = dmLastSeenTimestamps[conv.conversation_id] || 0;
            const isUnread = conv.last_message_timestamp > lastSeen;

            let label = displayName(conv.display_name);
            if (isUnread) {
                label = `* ${label}`;
            }

            opt.textContent = label;
            selector.appendChild(opt);

            // Track this name
            conversationNames.add(conv.display_name);
        });
    }

    // 2. Add separator if we have both conversations and contacts
    if (dmConversations.length > 0 && contactsList.length > 0) {
        const separator = document.createElement('option');
        separator.disabled = true;
        separator.textContent = '--- Available contacts ---';
        selector.appendChild(separator);
    }

    // 3. Add all contacts from device (skip those already in conversations)
    if (contactsList.length > 0) {
        contactsList.forEach(contactName => {
            // Skip if already in conversations
            if (conversationNames.has(contactName)) {
                return;
            }

            const opt = document.createElement('option');
            // Create conversation_id as name_<contactName>
            opt.value = `name_${contactName}`;
            opt.textContent = contactName;
            selector.appendChild(opt);
        });
    }

    // Show message if no conversations and no contacts
    if (dmConversations.length === 0 && contactsList.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No contacts available';
        opt.disabled = true;
        selector.appendChild(opt);
    }

    // If we have a current conversation, select it
    if (currentConversationId) {
        selector.value = currentConversationId;
    }
}

/**
 * Select a conversation
 */
async function selectConversation(conversationId) {
    currentConversationId = conversationId;

    // Save to localStorage for next visit
    localStorage.setItem('mc_active_dm_conversation', conversationId);

    // Find the conversation to get recipient name
    const conv = dmConversations.find(c => c.conversation_id === conversationId);
    if (conv && conv.display_name) {
        currentRecipient = conv.display_name;
    } else {
        // Extract name from conversation_id
        if (conversationId.startsWith('name_')) {
            currentRecipient = conversationId.substring(5);
        } else if (conversationId.startsWith('pk_')) {
            currentRecipient = conversationId.substring(3, 11) + '...';
        } else {
            currentRecipient = 'Unknown';
        }
    }

    // Update selector if not already selected
    const selector = document.getElementById('dmConversationSelector');
    if (selector && selector.value !== conversationId) {
        selector.value = conversationId;
    }

    // Enable input
    const input = document.getElementById('dmMessageInput');
    const sendBtn = document.getElementById('dmSendBtn');
    if (input) {
        input.disabled = false;
        input.placeholder = `Message ${displayName(currentRecipient)}...`;
    }
    if (sendBtn) {
        sendBtn.disabled = false;
    }

    // Load messages
    await loadMessages();
}

/**
 * Clear conversation selection
 */
function clearConversation() {
    currentConversationId = null;
    currentRecipient = null;

    // Clear from localStorage
    localStorage.removeItem('mc_active_dm_conversation');

    // Disable input
    const input = document.getElementById('dmMessageInput');
    const sendBtn = document.getElementById('dmSendBtn');
    if (input) {
        input.disabled = true;
        input.placeholder = 'Type a message...';
        input.value = '';
    }
    if (sendBtn) {
        sendBtn.disabled = true;
    }

    // Show empty state
    const container = document.getElementById('dmMessagesList');
    if (container) {
        container.innerHTML = `
            <div class="dm-empty-state">
                <i class="bi bi-envelope"></i>
                <p class="mb-1">Select a conversation</p>
                <small class="text-muted">Choose from the dropdown above or start a new chat from channel messages</small>
            </div>
        `;
    }

    updateCharCounter();
}

/**
 * Load messages for current conversation
 */
async function loadMessages() {
    if (!currentConversationId) return;

    const container = document.getElementById('dmMessagesList');
    if (!container) return;

    container.innerHTML = '<div class="text-center py-4"><div class="spinner-border spinner-border-sm"></div></div>';

    try {
        const response = await fetch(`/api/dm/messages?conversation_id=${encodeURIComponent(currentConversationId)}&limit=100`);
        const data = await response.json();

        if (data.success) {
            displayMessages(data.messages);

            // Update recipient if we got a better name
            if (data.display_name && data.display_name !== 'Unknown') {
                currentRecipient = data.display_name;
                const input = document.getElementById('dmMessageInput');
                if (input) {
                    input.placeholder = `Message ${displayName(currentRecipient)}...`;
                }
            }

            // Mark as read
            if (data.messages && data.messages.length > 0) {
                const latestTs = Math.max(...data.messages.map(m => m.timestamp));
                markAsRead(currentConversationId, latestTs);
            }

            updateLastRefresh();
        } else {
            container.innerHTML = '<div class="text-center text-danger py-4">Error loading messages</div>';
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        container.innerHTML = '<div class="text-center text-danger py-4">Failed to load messages</div>';
    }
}

/**
 * Display messages in the container
 */
function displayMessages(messages) {
    const container = document.getElementById('dmMessagesList');
    if (!container) return;

    if (!messages || messages.length === 0) {
        container.innerHTML = `
            <div class="dm-empty-state">
                <i class="bi bi-chat-dots"></i>
                <p>No messages yet</p>
                <small class="text-muted">Send a message to start the conversation</small>
            </div>
        `;
        lastMessageTimestamp = 0;
        return;
    }

    // Update last message timestamp for smart refresh
    lastMessageTimestamp = Math.max(...messages.map(m => m.timestamp));

    container.innerHTML = '';

    messages.forEach(msg => {
        const div = document.createElement('div');
        div.className = `dm-message ${msg.is_own ? 'own' : 'other'}`;

        // Status icon for own messages
        let statusIcon = '';
        if (msg.is_own) {
            if (msg.status === 'delivered') {
                let title = 'Delivered';
                if (msg.delivery_snr !== null && msg.delivery_snr !== undefined) {
                    title += `, SNR: ${msg.delivery_snr.toFixed(1)} dB`;
                }
                if (msg.delivery_route) title += ` (${msg.delivery_route})`;
                statusIcon = `<i class="bi bi-check2 dm-status delivered" title="${title}"></i>`;
            } else if (msg.status === 'pending') {
                statusIcon = '<i class="bi bi-clock dm-status pending" title="Sending..."></i>';
            } else {
                // No ACK received — show clickable "?" with explanation
                statusIcon = `<span class="dm-status-unknown" onclick="showDeliveryInfo(this)"><i class="bi bi-question-circle dm-status unknown"></i></span>`;
            }
        }

        // Metadata for incoming messages
        let meta = '';
        if (!msg.is_own) {
            const parts = [];
            if (msg.snr !== null && msg.snr !== undefined) {
                parts.push(`SNR: ${msg.snr.toFixed(1)}`);
            }
            if (parts.length > 0) {
                meta = `<div class="dm-meta">${parts.join(' | ')}</div>`;
            }
        }

        // Resend button for own messages
        const resendBtn = msg.is_own ? `
            <div class="dm-actions">
                <button class="btn btn-outline-secondary btn-sm dm-action-btn" onclick='resendMessage(${JSON.stringify(msg.content)})' title="Resend">
                    <i class="bi bi-arrow-repeat"></i>
                </button>
            </div>
        ` : '';

        div.innerHTML = `
            <div class="d-flex justify-content-between align-items-center" style="font-size: 0.7rem;">
                <span class="text-muted">${formatTime(msg.timestamp)}</span>
                ${statusIcon}
            </div>
            <div>${processMessageContent(msg.content)}</div>
            ${meta}
            ${resendBtn}
        `;

        container.appendChild(div);
    });

    // Scroll to bottom
    const scrollContainer = document.getElementById('dmMessagesContainer');
    if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }

    // Re-apply filter if active
    clearDmFilterState();
}

/**
 * Send a message
 */
async function sendMessage() {
    const input = document.getElementById('dmMessageInput');
    if (!input) return;

    const text = input.value.trim();
    if (!text || !currentRecipient) return;

    const sendBtn = document.getElementById('dmSendBtn');
    if (sendBtn) sendBtn.disabled = true;

    try {
        const response = await fetch('/api/dm/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: currentRecipient,
                text: text
            })
        });

        const data = await response.json();

        if (data.success) {
            input.value = '';
            updateCharCounter();
            showNotification('Message sent', 'success');

            // Reload messages to show sent message + ACK delivery status
            // Extended delays to cover auto-retry window (retries happen in background)
            const ackRefreshDelays = [2000, 8000, 20000, 40000, 60000];
            let ackRefreshIdx = 0;
            const scheduleAckRefresh = () => {
                if (ackRefreshIdx >= ackRefreshDelays.length) return;
                const delay = ackRefreshDelays[ackRefreshIdx++];
                setTimeout(async () => {
                    await loadMessages();
                    const ownMsgs = document.querySelectorAll('#dmMessagesList .dm-message.own');
                    const lastOwn = ownMsgs.length > 0 ? ownMsgs[ownMsgs.length - 1] : null;
                    const delivered = lastOwn && lastOwn.querySelector('.dm-status.delivered');
                    if (!delivered) scheduleAckRefresh();
                }, delay);
            };
            scheduleAckRefresh();
        } else {
            showNotification('Failed to send: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error sending message:', error);
        showNotification('Failed to send message', 'danger');
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        input.focus();
    }
}

/**
 * Setup intelligent auto-refresh
 * Only refreshes UI when new messages arrive
 */
function setupAutoRefresh() {
    const checkInterval = 10000; // 10 seconds

    autoRefreshInterval = setInterval(async () => {
        // Reload conversations to update unread indicators
        await loadConversations();

        // Update connection status
        await loadStatus();

        // If viewing a conversation, check for new messages
        if (currentConversationId) {
            await checkForNewMessages();
        }
    }, checkInterval);

    console.log('Intelligent auto-refresh enabled');
}

/**
 * Check for new messages without full reload
 * Only reloads UI when new messages are detected
 */
async function checkForNewMessages() {
    if (!currentConversationId) return;

    try {
        // Fetch only to check for updates
        const response = await fetch(`/api/dm/messages?conversation_id=${encodeURIComponent(currentConversationId)}&limit=1`);
        const data = await response.json();

        if (data.success && data.messages && data.messages.length > 0) {
            const latestTs = data.messages[data.messages.length - 1].timestamp;

            // Only reload if there are newer messages
            if (latestTs > lastMessageTimestamp) {
                console.log('New DM messages detected, refreshing...');
                await loadMessages();
            }
        }
    } catch (error) {
        console.error('Error checking for new messages:', error);
    }
}

/**
 * Update character counter (counts UTF-8 bytes, limit is 150)
 */
function updateCharCounter() {
    const input = document.getElementById('dmMessageInput');
    const counter = document.getElementById('dmCharCounter');
    if (!input || !counter) return;

    const encoder = new TextEncoder();
    const byteLength = encoder.encode(input.value).length;
    const maxBytes = 150;
    counter.textContent = byteLength;

    // Visual warning when approaching limit
    if (byteLength >= maxBytes * 0.9) {
        counter.classList.add('text-danger');
        counter.classList.remove('text-warning', 'text-muted');
    } else if (byteLength >= maxBytes * 0.75) {
        counter.classList.remove('text-danger', 'text-muted');
        counter.classList.add('text-warning');
    } else {
        counter.classList.remove('text-danger', 'text-warning');
        counter.classList.add('text-muted');
    }
}

/**
 * Resend a message (paste content back to input)
 * @param {string} content - Message content to resend
 */
function resendMessage(content) {
    const input = document.getElementById('dmMessageInput');
    if (!input) return;
    input.value = content;
    updateCharCounter();
    input.focus();
}

/**
 * Show delivery info popup (mobile-friendly, same pattern as showPathPopup)
 */
function showDeliveryInfo(element) {
    const existing = document.querySelector('.dm-delivery-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.className = 'dm-delivery-popup';
    popup.textContent = 'Delivery unknown \u2014 no ACK received. Message may still have been delivered.';
    element.style.position = 'relative';
    element.appendChild(popup);

    const dismiss = () => popup.remove();
    setTimeout(dismiss, 5000);
    document.addEventListener('click', function handler(e) {
        if (!element.contains(e.target)) {
            dismiss();
            document.removeEventListener('click', handler);
        }
    });
}

/**
 * Setup emoji picker
 */
function setupEmojiPicker() {
    const emojiBtn = document.getElementById('dmEmojiBtn');
    const emojiPickerPopup = document.getElementById('dmEmojiPickerPopup');
    const messageInput = document.getElementById('dmMessageInput');

    if (!emojiBtn || !emojiPickerPopup || !messageInput) {
        console.log('Emoji picker elements not found');
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

    // Insert emoji into input when selected
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
 * Mark conversation as read
 */
async function markAsRead(conversationId, timestamp) {
    dmLastSeenTimestamps[conversationId] = timestamp;
    await saveDmReadStatus(conversationId, timestamp);

    // Update dropdown to remove unread indicator
    populateConversationSelector();
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
 * Update status indicator
 */
function updateStatus(status) {
    const statusEl = document.getElementById('dmStatusText');
    if (!statusEl) return;

    const icons = {
        connected: '<i class="bi bi-circle-fill status-connected"></i> Connected',
        disconnected: '<i class="bi bi-circle-fill status-disconnected"></i> Disconnected',
        connecting: '<i class="bi bi-circle-fill status-connecting"></i> Connecting...'
    };

    statusEl.innerHTML = icons[status] || icons.connecting;
}

/**
 * Update last refresh time
 */
function updateLastRefresh() {
    const el = document.getElementById('dmLastRefresh');
    if (el) {
        el.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
    }
}

/**
 * Format timestamp to readable time
 */
function formatTime(timestamp) {
    if (!timestamp) return '';

    const date = new Date(timestamp * 1000);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
               ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Show a toast notification
 */
function showNotification(message, type = 'info') {
    const toastEl = document.getElementById('notificationToast');
    if (!toastEl) return;

    const toastBody = toastEl.querySelector('.toast-body');
    if (toastBody) {
        toastBody.textContent = message;
    }

    // Update toast header color based on type
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

    const toast = new bootstrap.Toast(toastEl, {
        autohide: true,
        delay: 1500
    });
    toast.show();
}

// ============================================================================
// PWA Notifications for DM
// ============================================================================

/**
 * Track previous DM unread for notifications
 */
let previousDmTotalUnread = 0;

/**
 * Check if we should send DM notification
 */
function checkDmNotifications(conversations) {
    // Only check if notifications are enabled
    // areNotificationsEnabled is defined in app.js and should be available globally
    if (typeof areNotificationsEnabled === 'undefined' || !areNotificationsEnabled()) {
        return;
    }

    if (document.visibilityState !== 'hidden') {
        return;
    }

    // Calculate total DM unread
    const currentDmTotalUnread = conversations.reduce((sum, conv) => sum + conv.unread_count, 0);

    // Detect increase
    if (currentDmTotalUnread > previousDmTotalUnread) {
        const delta = currentDmTotalUnread - previousDmTotalUnread;

        try {
            const notification = new Notification('mc-webui', {
                body: `New private messages: ${delta}`,
                icon: '/static/images/android-chrome-192x192.png',
                badge: '/static/images/android-chrome-192x192.png',
                tag: 'mc-webui-dm',
                requireInteraction: false,
                silent: false
            });

            notification.onclick = function() {
                window.focus();
                notification.close();
            };
        } catch (error) {
            console.error('Error sending DM notification:', error);
        }
    }

    previousDmTotalUnread = currentDmTotalUnread;
}

// =============================================================================
// DM Chat Filter Functionality
// =============================================================================

// Filter state
let dmFilterActive = false;
let currentDmFilterQuery = '';
let originalDmMessageContents = new Map();

/**
 * Initialize DM FAB toggle (collapse/expand)
 */
function initializeDmFabToggle() {
    const toggle = document.getElementById('dmFabToggle');
    const container = document.getElementById('dmFabContainer');
    if (!toggle || !container) return;

    toggle.addEventListener('click', () => {
        container.classList.toggle('collapsed');
        const isCollapsed = container.classList.contains('collapsed');
        toggle.title = isCollapsed ? 'Show buttons' : 'Hide buttons';
    });
}

/**
 * Initialize DM filter functionality
 */
function initializeDmFilter() {
    const filterFab = document.getElementById('dmFilterFab');
    const filterBar = document.getElementById('dmFilterBar');
    const filterInput = document.getElementById('dmFilterInput');
    const filterClearBtn = document.getElementById('dmFilterClearBtn');
    const filterCloseBtn = document.getElementById('dmFilterCloseBtn');

    if (!filterFab || !filterBar) return;

    // Open filter bar when FAB clicked
    filterFab.addEventListener('click', () => {
        openDmFilterBar();
    });

    // Filter as user types (debounced)
    let filterTimeout = null;
    filterInput.addEventListener('input', () => {
        clearTimeout(filterTimeout);
        filterTimeout = setTimeout(() => {
            applyDmFilter(filterInput.value);
        }, 150);
    });

    // Clear filter
    filterClearBtn.addEventListener('click', () => {
        filterInput.value = '';
        applyDmFilter('');
        filterInput.focus();
    });

    // Close filter bar
    filterCloseBtn.addEventListener('click', () => {
        closeDmFilterBar();
    });

    // Keyboard shortcuts
    filterInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeDmFilterBar();
        }
    });

    // Global keyboard shortcut: Ctrl+F to open filter
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            openDmFilterBar();
        }
    });
}

/**
 * Open the DM filter bar
 */
function openDmFilterBar() {
    const filterBar = document.getElementById('dmFilterBar');
    const filterInput = document.getElementById('dmFilterInput');

    filterBar.classList.add('visible');
    dmFilterActive = true;

    setTimeout(() => {
        filterInput.focus();
    }, 100);
}

/**
 * Close the DM filter bar and reset filter
 */
function closeDmFilterBar() {
    const filterBar = document.getElementById('dmFilterBar');
    const filterInput = document.getElementById('dmFilterInput');

    filterBar.classList.remove('visible');
    dmFilterActive = false;

    filterInput.value = '';
    applyDmFilter('');
}

/**
 * Apply filter to DM messages
 * @param {string} query - Search query
 */
function applyDmFilter(query) {
    currentDmFilterQuery = query.trim();
    const container = document.getElementById('dmMessagesList');
    const messages = container.querySelectorAll('.dm-message');
    const matchCountEl = document.getElementById('dmFilterMatchCount');

    // Remove any existing no-matches message
    const existingNoMatches = container.querySelector('.filter-no-matches');
    if (existingNoMatches) {
        existingNoMatches.remove();
    }

    if (!currentDmFilterQuery) {
        messages.forEach(msg => {
            msg.classList.remove('filter-hidden');
            restoreDmOriginalContent(msg);
        });
        matchCountEl.textContent = '';
        return;
    }

    let matchCount = 0;

    messages.forEach((msg, index) => {
        // Get text content from DM message
        const text = getDmMessageText(msg);

        if (FilterUtils.textMatches(text, currentDmFilterQuery)) {
            msg.classList.remove('filter-hidden');
            matchCount++;
            highlightDmMessageContent(msg, index);
        } else {
            msg.classList.add('filter-hidden');
            restoreDmOriginalContent(msg);
        }
    });

    matchCountEl.textContent = `${matchCount} / ${messages.length}`;

    if (matchCount === 0 && messages.length > 0) {
        const noMatchesDiv = document.createElement('div');
        noMatchesDiv.className = 'filter-no-matches';
        noMatchesDiv.innerHTML = `
            <i class="bi bi-search"></i>
            <p>No messages match "${escapeHtml(currentDmFilterQuery)}"</p>
        `;
        container.appendChild(noMatchesDiv);
    }
}

/**
 * Get text content from a DM message
 * DM structure: timestamp div, then content div, then meta/actions
 * @param {HTMLElement} msgEl - DM message element
 * @returns {string} - Text content
 */
function getDmMessageText(msgEl) {
    // The message content is in a div that is not the timestamp row, meta, or actions
    const children = msgEl.children;
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        // Skip timestamp row (has d-flex class), meta, and actions
        if (!child.classList.contains('d-flex') &&
            !child.classList.contains('dm-meta') &&
            !child.classList.contains('dm-actions')) {
            return child.textContent || '';
        }
    }
    return '';
}

/**
 * Highlight matching text in a DM message
 * @param {HTMLElement} msgEl - DM message element
 * @param {number} index - Message index for tracking
 */
function highlightDmMessageContent(msgEl, index) {
    const msgId = 'dm_msg_' + index;

    // Find content div (not timestamp, not meta, not actions)
    const children = Array.from(msgEl.children);
    for (const child of children) {
        if (!child.classList.contains('d-flex') &&
            !child.classList.contains('dm-meta') &&
            !child.classList.contains('dm-actions')) {

            if (!originalDmMessageContents.has(msgId)) {
                originalDmMessageContents.set(msgId, child.innerHTML);
            }

            const originalHtml = originalDmMessageContents.get(msgId);
            child.innerHTML = FilterUtils.highlightMatches(originalHtml, currentDmFilterQuery);
            break;
        }
    }
}

/**
 * Restore original DM message content
 * @param {HTMLElement} msgEl - DM message element
 */
function restoreDmOriginalContent(msgEl) {
    const container = document.getElementById('dmMessagesList');
    const messages = Array.from(container.querySelectorAll('.dm-message'));
    const index = messages.indexOf(msgEl);
    const msgId = 'dm_msg_' + index;

    if (!originalDmMessageContents.has(msgId)) return;

    const children = Array.from(msgEl.children);
    for (const child of children) {
        if (!child.classList.contains('d-flex') &&
            !child.classList.contains('dm-meta') &&
            !child.classList.contains('dm-actions')) {
            child.innerHTML = originalDmMessageContents.get(msgId);
            break;
        }
    }
}

/**
 * Clear DM filter state when messages are reloaded
 */
function clearDmFilterState() {
    originalDmMessageContents.clear();

    if (dmFilterActive && currentDmFilterQuery) {
        setTimeout(() => {
            applyDmFilter(currentDmFilterQuery);
        }, 50);
    }
}

// =============================================================================
// Auto-retry configuration
// =============================================================================

/**
 * Load auto-retry config from bridge and sync toggle state
 */
async function loadAutoRetryConfig() {
    const toggle = document.getElementById('dmAutoRetryToggle');
    if (!toggle) return;

    try {
        const response = await fetch('/api/dm/auto_retry');
        const data = await response.json();
        if (data.success) {
            toggle.checked = data.enabled;
        }
    } catch (e) {
        console.debug('Failed to load auto-retry config:', e);
    }

    // Setup change handler
    toggle.addEventListener('change', async function() {
        try {
            const response = await fetch('/api/dm/auto_retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: this.checked })
            });
            const data = await response.json();
            if (data.success) {
                showNotification(
                    data.enabled ? 'Auto Retry enabled' : 'Auto Retry disabled',
                    'info'
                );
            }
        } catch (e) {
            console.error('Failed to update auto-retry config:', e);
            // Revert toggle on error
            this.checked = !this.checked;
        }
    });
}
