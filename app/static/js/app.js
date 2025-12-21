/**
 * mc-webui Frontend Application
 */

// Global state
let lastMessageCount = 0;
let autoRefreshInterval = null;
let isUserScrolling = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    console.log('mc-webui initialized');

    // Load initial messages
    loadMessages();

    // Setup auto-refresh
    setupAutoRefresh();

    // Setup event listeners
    setupEventListeners();

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
        const response = await fetch('/api/messages?limit=100');
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
 * Update character counter
 */
function updateCharCounter() {
    const input = document.getElementById('messageInput');
    const counter = document.getElementById('charCounter');
    const length = input.value.length;
    const maxLength = 200;

    counter.textContent = `${length} / ${maxLength}`;

    // Visual warning when approaching limit
    if (length >= maxLength * 0.9) {
        counter.classList.remove('text-muted', 'text-warning');
        counter.classList.add('text-danger', 'fw-bold');
    } else if (length >= maxLength * 0.75) {
        counter.classList.remove('text-muted', 'text-danger');
        counter.classList.add('text-warning', 'fw-bold');
    } else {
        counter.classList.remove('text-warning', 'text-danger', 'fw-bold');
        counter.classList.add('text-muted');
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
