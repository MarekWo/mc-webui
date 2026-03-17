/**
 * mc-webui Direct Messages JavaScript
 * Full-page DM view functionality
 */

// State variables
let currentConversationId = null;
let currentRecipient = null;
let dmConversations = [];
let contactsList = [];  // List of detailed contact objects from device
let contactsMap = {};   // Map of public_key -> contact object
let dmLastSeenTimestamps = {};
let autoRefreshInterval = null;
let lastMessageTimestamp = 0;  // Track latest message timestamp for smart refresh
let chatSocket = null;  // SocketIO connection to /chat namespace

/**
 * Get display-friendly name (truncate full pubkeys to short prefix)
 */
function displayName(name) {
    if (!name) return 'Unknown';
    if (/^[0-9a-f]{12,64}$/i.test(name)) return name.substring(0, 8) + '...';
    return name;
}

/**
 * Check if a string looks like a hex pubkey (not a real name)
 */
function isPubkey(name) {
    return !name || /^[0-9a-f]{8,64}$/i.test(name) || /^[0-9a-f]{6,}\.\.\./i.test(name);
}

/**
 * Resolve the best display name for a conversation ID.
 * Priority: contactsList (device) > conversations API > pubkey fallback.
 */
function resolveConversationName(conversationId) {
    // Try device contacts first (most reliable source of names)
    const contact = findCurrentContactByConvId(conversationId);
    if (contact && contact.name && !isPubkey(contact.name)) return contact.name;

    // Try conversations list
    let conv = dmConversations.find(c => c.conversation_id === conversationId);
    if (!conv && conversationId && conversationId.startsWith('pk_')) {
        const prefix = conversationId.substring(3);
        conv = dmConversations.find(c =>
            c.conversation_id.startsWith('pk_') &&
            (c.conversation_id.substring(3).startsWith(prefix) || prefix.startsWith(c.conversation_id.substring(3)))
        );
    }
    if (conv && conv.display_name && !isPubkey(conv.display_name)) return conv.display_name;

    // Fallback
    if (conversationId && conversationId.startsWith('name_')) return conversationId.substring(5);
    if (conversationId && conversationId.startsWith('pk_')) return conversationId.substring(3, 11) + '...';
    return 'Unknown';
}

/**
 * Connect to SocketIO /chat namespace for real-time DM and ACK updates
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
        console.log('DM: SocketIO connected to /chat');
        updateStatus('connected');
    });

    chatSocket.on('disconnect', () => {
        console.log('DM: SocketIO disconnected');
    });

    // Real-time new DM message
    chatSocket.on('new_message', (data) => {
        if (data.type !== 'dm') return;

        const msgPubkey = data.contact_pubkey || '';
        const currentPubkey = currentConversationId ? currentConversationId.replace('pk_', '') : '';

        if (currentPubkey && msgPubkey.startsWith(currentPubkey)) {
            // Message is for current conversation — reload messages
            loadMessages();
        } else {
            // Message is for a different conversation — refresh conversation list
            loadConversations();
        }
    });

    // Real-time ACK delivery confirmation
    chatSocket.on('ack', (data) => {
        if (!data.expected_ack) return;

        // Find message with matching expected_ack in DOM and update status
        const msgElements = document.querySelectorAll('#dmMessagesList .dm-message.own');
        msgElements.forEach(el => {
            const statusEl = el.querySelector(`.dm-status[data-ack="${data.expected_ack}"]`);
            if (statusEl) {
                statusEl.className = 'bi bi-check2 dm-status delivered';
                const tooltip = [];
                if (data.snr != null) tooltip.push(`SNR: ${data.snr}`);
                if (data.route_type) tooltip.push(`Route: ${data.route_type}`);
                statusEl.title = tooltip.length > 0 ? tooltip.join(', ') : 'Delivered';
            }
        });
    });

    // Real-time device status
    chatSocket.on('device_status', (data) => {
        updateStatus(data.connected ? 'connected' : 'disconnected');
    });
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

    // Connect SocketIO for real-time updates
    connectChatSocket();

    // Setup auto-refresh (fallback, 60s interval since SocketIO handles primary updates)
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
    // Searchable contact input
    const searchInput = document.getElementById('dmContactSearchInput');
    const contactDropdown = document.getElementById('dmContactDropdown');
    const searchWrapper = document.getElementById('dmContactSearchWrapper');

    if (searchInput && contactDropdown) {
        searchInput.addEventListener('focus', () => {
            renderDropdownItems(searchInput.value);
            contactDropdown.style.display = 'block';
        });

        searchInput.addEventListener('input', () => {
            renderDropdownItems(searchInput.value);
            contactDropdown.style.display = 'block';
        });

        // Prevent dropdown mousedown from stealing focus/closing dropdown
        contactDropdown.addEventListener('mousedown', (e) => {
            e.preventDefault();
        });

        // Close dropdown when clicking outside the wrapper
        document.addEventListener('mousedown', (e) => {
            if (searchWrapper && !searchWrapper.contains(e.target)) {
                contactDropdown.style.display = 'none';
            }
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                contactDropdown.style.display = 'none';
                searchInput.blur();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const active = contactDropdown.querySelector('.dm-contact-item.active');
                const target = active || contactDropdown.querySelector('.dm-contact-item');
                if (target) target.click();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const items = Array.from(contactDropdown.querySelectorAll('.dm-contact-item'));
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

    // Clear search button
    const clearBtn = document.getElementById('dmClearSearchBtn');
    if (clearBtn && searchInput && contactDropdown) {
        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            renderDropdownItems('');
            contactDropdown.style.display = 'block';
            searchInput.focus();
        });
    }

    // Contact info button
    const infoBtn = document.getElementById('dmContactInfoBtn');
    if (infoBtn) {
        infoBtn.addEventListener('click', () => {
            const modal = new bootstrap.Modal(document.getElementById('dmContactInfoModal'));
            populateContactInfoModal();
            modal.show();
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
        const response = await fetch('/api/contacts/detailed');
        const data = await response.json();

        if (data.success) {
            contactsList = (data.contacts || []).sort((a, b) =>
                (a.name || '').localeCompare(b.name || ''));
            contactsMap = {};
            contactsList.forEach(c => {
                if (c.public_key) contactsMap[c.public_key] = c;
            });
            console.log(`[DM] Loaded ${contactsList.length} device contacts`);
        } else {
            console.error('[DM] Failed to load contacts:', data.error);
            contactsList = [];
            contactsMap = {};
        }
    } catch (error) {
        console.error('[DM] Error loading contacts:', error);
        contactsList = [];
        contactsMap = {};
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
 * Populate the searchable conversation dropdown data.
 * Two sections: recent conversations (by recency) + device contacts (alphabetical).
 */
function populateConversationSelector() {
    // Build conversation entries with contact data
    const convPubkeyPrefixes = new Set();
    const conversations = dmConversations.map(conv => {
        // Extract pubkey prefix from conversation_id
        let pkPrefix = '';
        if (conv.conversation_id.startsWith('pk_')) {
            pkPrefix = conv.conversation_id.substring(3);
        }
        convPubkeyPrefixes.add(pkPrefix);

        const lastSeen = dmLastSeenTimestamps[conv.conversation_id] || 0;
        const isUnread = conv.last_message_timestamp > lastSeen;

        // Find matching device contact
        const contact = pkPrefix
            ? contactsList.find(c => c.public_key && c.public_key.startsWith(pkPrefix))
            : contactsList.find(c => c.name === conv.display_name);

        return {
            conversationId: conv.conversation_id,
            name: conv.display_name,
            isUnread,
            contact: contact || null,
        };
    });

    // Device contacts without existing conversations
    const contacts = contactsList.filter(c => {
        const prefix = (c.public_key_prefix || c.public_key?.substring(0, 12) || '');
        return !convPubkeyPrefixes.has(prefix);
    });

    window._dmDropdownItems = { conversations, contacts };
    renderDropdownItems('');

    // Update search input if conversation is selected — re-resolve name in case contacts loaded
    if (currentConversationId) {
        const bestName = resolveConversationName(currentConversationId);
        if (!isPubkey(bestName)) currentRecipient = bestName;
        const input = document.getElementById('dmContactSearchInput');
        if (input) input.value = displayName(currentRecipient);
    }
}

/**
 * Render dropdown items filtered by search query.
 */
function renderDropdownItems(query) {
    const dropdown = document.getElementById('dmContactDropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';

    const q = query.toLowerCase().trim();
    // If query looks like a pubkey hex, don't filter — show all items instead
    const qIsPubkey = /^[0-9a-f]{6,}\.{0,3}$/i.test(q);
    const { conversations = [], contacts = [] } = window._dmDropdownItems || {};

    const filteredConvs = (q && !qIsPubkey)
        ? conversations.filter(item => (item.name || '').toLowerCase().includes(q))
        : conversations;

    const filteredContacts = (q && !qIsPubkey)
        ? contacts.filter(c => (c.name || '').toLowerCase().includes(q))
        : contacts;

    if (filteredConvs.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'dm-dropdown-separator';
        sep.textContent = 'Recent conversations';
        dropdown.appendChild(sep);

        filteredConvs.forEach(item => {
            dropdown.appendChild(createDropdownItem(
                item.name, item.conversationId, item.isUnread, item.contact));
        });
    }

    if (filteredContacts.length > 0) {
        const sep = document.createElement('div');
        sep.className = 'dm-dropdown-separator';
        sep.textContent = 'Contacts';
        dropdown.appendChild(sep);

        filteredContacts.forEach(contact => {
            const prefix = contact.public_key_prefix || contact.public_key?.substring(0, 12) || '';
            const convId = `pk_${prefix}`;
            dropdown.appendChild(createDropdownItem(
                contact.name, convId, false, contact));
        });
    }

    if (filteredConvs.length === 0 && filteredContacts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dm-dropdown-separator text-center';
        empty.textContent = q ? 'No matches' : 'No contacts available';
        dropdown.appendChild(empty);
    }
}

/**
 * Create a single dropdown item element.
 */
function createDropdownItem(name, conversationId, isUnread, contact) {
    const el = document.createElement('div');
    el.className = 'dm-contact-item';

    if (isUnread) {
        const dot = document.createElement('span');
        dot.style.cssText = 'color: #0d6efd; font-weight: bold;';
        dot.textContent = '*';
        el.appendChild(dot);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'contact-name';
    nameSpan.textContent = displayName(name);
    el.appendChild(nameSpan);

    if (contact && contact.type_label) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        const colors = { CLI: 'bg-primary', REP: 'bg-success', ROOM: 'bg-info', SENS: 'bg-warning' };
        badge.classList.add(colors[contact.type_label] || 'bg-secondary');
        badge.textContent = contact.type_label;
        el.appendChild(badge);
    }

    el.addEventListener('click', () => selectConversationFromDropdown(conversationId, name));
    return el;
}

/**
 * Handle selection from the searchable dropdown.
 */
async function selectConversationFromDropdown(conversationId, name) {
    const dropdown = document.getElementById('dmContactDropdown');
    if (dropdown) dropdown.style.display = 'none';
    await selectConversation(conversationId);
    // Override search input with the known name (selectConversation may not resolve it)
    const input = document.getElementById('dmContactSearchInput');
    if (input && name) input.value = displayName(name);
    if (name && !isPubkey(name)) currentRecipient = name;
    // Move focus to message input for immediate typing
    const msgInput = document.getElementById('dmMessageInput');
    if (msgInput && !msgInput.disabled) msgInput.focus();
}

/**
 * Select a conversation
 */
async function selectConversation(conversationId) {
    currentConversationId = conversationId;

    // Save to localStorage for next visit
    localStorage.setItem('mc_active_dm_conversation', conversationId);

    // Upgrade to full conversation_id if prefix match found
    if (conversationId.startsWith('pk_')) {
        const prefix = conversationId.substring(3);
        const conv = dmConversations.find(c =>
            c.conversation_id.startsWith('pk_') &&
            (c.conversation_id.substring(3).startsWith(prefix) || prefix.startsWith(c.conversation_id.substring(3)))
        );
        if (conv) {
            conversationId = conv.conversation_id;
            currentConversationId = conversationId;
            localStorage.setItem('mc_active_dm_conversation', conversationId);
        }
    }

    // Resolve name: prefer device contacts over backend data
    currentRecipient = resolveConversationName(conversationId);

    // Update search input
    const searchInput = document.getElementById('dmContactSearchInput');
    if (searchInput) searchInput.value = displayName(currentRecipient);

    // Show clear button and enable info button
    const clearBtn = document.getElementById('dmClearSearchBtn');
    if (clearBtn) clearBtn.style.display = '';
    const infoBtn = document.getElementById('dmContactInfoBtn');
    if (infoBtn) infoBtn.disabled = false;

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

    // Reset search input, hide clear button, disable info button
    const searchInput = document.getElementById('dmContactSearchInput');
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('dmClearSearchBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    const infoBtn = document.getElementById('dmContactInfoBtn');
    if (infoBtn) infoBtn.disabled = true;

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
 * Find contact object matching a conversation ID.
 */
function findCurrentContactByConvId(convId) {
    if (!convId) return null;
    let pkPrefix = '';
    if (convId.startsWith('pk_')) {
        pkPrefix = convId.substring(3);
    }
    if (pkPrefix) {
        return contactsList.find(c => c.public_key && c.public_key.startsWith(pkPrefix)) || null;
    }
    // Fallback: match by name
    if (convId.startsWith('name_')) {
        const name = convId.substring(5);
        return contactsList.find(c => c.name === name) || null;
    }
    return null;
}

/**
 * Find current contact from contactsList.
 */
function findCurrentContact() {
    return findCurrentContactByConvId(currentConversationId);
}

/**
 * Minimal relative time formatter.
 */
function formatRelativeTimeDm(timestamp) {
    if (!timestamp) return 'Never';
    const diff = Math.floor(Date.now() / 1000) - timestamp;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

/**
 * Populate the Contact Info modal body.
 */
function populateContactInfoModal() {
    const body = document.getElementById('dmContactInfoBody');
    if (!body) return;

    const contact = findCurrentContact();
    if (!contact) {
        body.innerHTML = '<p class="text-muted">No contact information available.</p>';
        return;
    }

    body.innerHTML = '';

    // Name + type badge
    const nameRow = document.createElement('div');
    nameRow.className = 'd-flex align-items-center gap-2 mb-3';
    const nameEl = document.createElement('h6');
    nameEl.className = 'mb-0';
    nameEl.textContent = contact.name;
    nameRow.appendChild(nameEl);

    if (contact.type_label) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        const colors = { CLI: 'bg-primary', REP: 'bg-success', ROOM: 'bg-info', SENS: 'bg-warning' };
        badge.classList.add(colors[contact.type_label] || 'bg-secondary');
        badge.textContent = contact.type_label;
        nameRow.appendChild(badge);
    }
    body.appendChild(nameRow);

    // Public key
    const keyDiv = document.createElement('div');
    keyDiv.className = 'text-muted small font-monospace mb-2';
    keyDiv.style.cursor = 'pointer';
    keyDiv.textContent = contact.public_key_prefix || contact.public_key?.substring(0, 12) || '';
    keyDiv.title = 'Click to copy full public key';
    keyDiv.onclick = () => {
        const pk = contact.public_key || contact.public_key_prefix || '';
        navigator.clipboard.writeText(pk).then(() => {
            showNotification('Public key copied', 'info');
        }).catch(() => {});
    };
    body.appendChild(keyDiv);

    // Last advert
    if (contact.last_seen || contact.last_advert) {
        const ts = contact.last_seen || contact.last_advert;
        const diff = Math.floor(Date.now() / 1000) - ts;
        let icon = '🔴';
        if (diff < 300) icon = '🟢';
        else if (diff < 3600) icon = '🟡';
        const div = document.createElement('div');
        div.className = 'small mb-2';
        div.textContent = `${icon} Last advert: ${formatRelativeTimeDm(ts)}`;
        body.appendChild(div);
    }

    // Path/route
    if (contact.path_or_mode) {
        const div = document.createElement('div');
        div.className = 'small mb-2';
        const mode = contact.path_or_mode;
        if (mode === 'Flood') {
            div.innerHTML = '<i class="bi bi-broadcast"></i> Flood';
        } else if (mode === 'Direct') {
            div.innerHTML = '<i class="bi bi-arrow-right-short"></i> Direct';
        } else {
            const hops = mode.split('→').length;
            div.innerHTML = `<i class="bi bi-signpost-split"></i> ${mode} <span class="text-muted">(${hops} hops)</span>`;
        }
        body.appendChild(div);
    }

    // GPS
    if (contact.adv_lat && contact.adv_lon && (contact.adv_lat !== 0 || contact.adv_lon !== 0)) {
        const div = document.createElement('div');
        div.className = 'small mb-2';
        div.innerHTML = `<i class="bi bi-geo-alt"></i> ${contact.adv_lat.toFixed(4)}, ${contact.adv_lon.toFixed(4)}`;
        body.appendChild(div);
    }
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

            // Update recipient if backend has a better (non-pubkey) name
            if (data.display_name && !isPubkey(data.display_name)) {
                currentRecipient = data.display_name;
            }
            // Always update placeholder with best known name
            const msgInput = document.getElementById('dmMessageInput');
            if (msgInput) {
                msgInput.placeholder = `Message ${displayName(currentRecipient)}...`;
            }
            // Keep search input in sync
            const searchInput = document.getElementById('dmContactSearchInput');
            if (searchInput && !isPubkey(currentRecipient)) {
                searchInput.value = displayName(currentRecipient);
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
            const ackAttr = msg.expected_ack ? ` data-ack="${msg.expected_ack}"` : '';
            if (msg.status === 'delivered') {
                let title = 'Delivered';
                if (msg.delivery_snr !== null && msg.delivery_snr !== undefined) {
                    title += `, SNR: ${msg.delivery_snr.toFixed(1)} dB`;
                }
                if (msg.delivery_route) title += ` (${msg.delivery_route})`;
                statusIcon = `<i class="bi bi-check2 dm-status delivered"${ackAttr} title="${title}"></i>`;
            } else if (msg.status === 'pending') {
                statusIcon = `<i class="bi bi-clock dm-status pending"${ackAttr} title="Sending..."></i>`;
            } else {
                // No ACK received — show clickable "?" with explanation
                statusIcon = `<span class="dm-status-unknown" onclick="showDeliveryInfo(this)"><i class="bi bi-question-circle dm-status unknown"${ackAttr}></i></span>`;
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

            // Reload messages once to show sent message
            // ACK delivery updates arrive via SocketIO in real-time
            await loadMessages();
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
    const checkInterval = 60000; // 60 seconds (SocketIO handles real-time updates)

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
