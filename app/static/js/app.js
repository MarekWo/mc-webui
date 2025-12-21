/**
 * mc-webui Frontend Application
 */

// Global state
let lastMessageCount = 0;
let autoRefreshInterval = null;
let isUserScrolling = false;
let currentArchiveDate = null;  // Current selected archive date (null = live)

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log('mc-webui initialized');

    // Load archive list
    loadArchiveList();

    // Load initial messages
    loadMessages();

    // Setup auto-refresh
    setupAutoRefresh();

    // Setup event listeners
    setupEventListeners();

    // Setup emoji picker
    setupEmojiPicker();

    // Load device status
    loadStatus();
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
    document.getElementById('refreshBtn').addEventListener('click', function() {
        loadMessages();
    });

    // Date selector (archive selection)
    document.getElementById('dateSelector').addEventListener('change', function(e) {
        currentArchiveDate = e.target.value || null;
        loadMessages();
    });

    // Cleanup contacts button
    document.getElementById('cleanupBtn').addEventListener('click', function() {
        cleanupContacts();
    });

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
}

/**
 * Load messages from API
 */
async function loadMessages() {
    try {
        // Build URL with appropriate parameters
        let url = '/api/messages?limit=500';

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
        ${!msg.is_own ? `<button class="btn btn-outline-secondary btn-sm btn-reply" onclick="replyTo('${escapeHtml(msg.sender)}')">
            <i class="bi bi-reply"></i> Reply
        </button>` : ''}
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
            body: JSON.stringify({ text: text })
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
 * Setup auto-refresh
 */
function setupAutoRefresh() {
    const interval = window.MC_CONFIG?.refreshInterval || 60000;

    autoRefreshInterval = setInterval(() => {
        loadMessages();
    }, interval);

    console.log(`Auto-refresh enabled: every ${interval / 1000}s`);
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
    const maxBytes = 200;

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
