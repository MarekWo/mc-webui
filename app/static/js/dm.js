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
            loadPathSection();
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
        const colors = { COM: 'bg-primary', REP: 'bg-success', ROOM: 'bg-info', SENS: 'bg-warning' };
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
        const colors = { COM: 'bg-primary', REP: 'bg-success', ROOM: 'bg-info', SENS: 'bg-warning' };
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

    // Path/route (device path)
    if (contact.path_or_mode) {
        const div = document.createElement('div');
        div.className = 'small mb-2 d-flex align-items-center gap-2';
        const mode = contact.path_or_mode;
        if (mode === 'Flood') {
            div.innerHTML = '<span><i class="bi bi-broadcast"></i> Flood</span>';
        } else if (mode === 'Direct') {
            div.innerHTML = '<span><i class="bi bi-arrow-right-short"></i> Direct</span>';
        } else {
            const hops = mode.split('→').length;
            const outPathLen = contact.out_path_len || 0;
            const hashSize = outPathLen > 0 ? ((outPathLen >> 6) + 1) : 1;
            const hopCount = outPathLen & 0x3F;
            const pathHex = contact.out_path ? contact.out_path.substring(0, hopCount * hashSize * 2) : '';

            div.innerHTML = `
                <span><i class="bi bi-signpost-split"></i> ${mode} <span class="text-muted">(${hops} hops)</span></span>
                ${pathHex ? `<button type="button" class="btn btn-outline-primary btn-sm py-0 px-1"
                    id="dmImportDevicePathBtn" title="Import device path to configured paths"
                    style="font-size: 0.7rem; line-height: 1.3;">
                    <i class="bi bi-download"></i>
                </button>` : ''}
            `;

            if (pathHex) {
                // Defer event attachment to after DOM insertion
                setTimeout(() => {
                    const importBtn = document.getElementById('dmImportDevicePathBtn');
                    if (importBtn) {
                        importBtn.addEventListener('click', async () => {
                            const pubkey = getCurrentContactPubkey();
                            try {
                                const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        path_hex: pathHex,
                                        hash_size: hashSize,
                                        label: 'Device path',
                                        is_primary: true
                                    })
                                });
                                const data = await response.json();
                                if (data.success) {
                                    await renderPathList(pubkey);
                                    showNotification('Device path imported', 'info');
                                } else {
                                    showNotification(data.error || 'Import failed', 'danger');
                                }
                            } catch (e) {
                                showNotification('Import failed', 'danger');
                            }
                        });
                    }
                }, 0);
            }
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

// ================================================================
// Path Management
// ================================================================

let _repeatersCache = null;

/**
 * Get the current contact's full public key for path API calls.
 */
function getCurrentContactPubkey() {
    const contact = findCurrentContact();
    return contact?.public_key || currentConversationId || '';
}

/**
 * Load and display the path section in Contact Info modal.
 */
async function loadPathSection() {
    const section = document.getElementById('dmPathSection');
    const pubkey = getCurrentContactPubkey();
    if (!section || !pubkey) {
        if (section) section.style.display = 'none';
        return;
    }

    section.style.display = '';
    await renderPathList(pubkey);
    await loadNoAutoFloodToggle(pubkey);
    setupPathFormHandlers(pubkey);
}

/**
 * Render the list of configured paths for a contact.
 */
async function renderPathList(pubkey) {
    const listEl = document.getElementById('dmPathList');
    if (!listEl) return;

    listEl.innerHTML = '<div class="text-muted small">Loading...</div>';

    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths`);
        const data = await response.json();
        if (!data.success || !data.paths.length) {
            listEl.innerHTML = '<div class="text-muted small mb-2">No paths configured. Use + to add.</div>';
            return;
        }

        listEl.innerHTML = '';
        data.paths.forEach((path, index) => {
            const item = document.createElement('div');
            item.className = 'path-list-item' + (path.is_primary ? ' primary' : '');

            // Format path hex as hop→hop→hop
            const chunk = path.hash_size * 2;
            const hops = [];
            for (let i = 0; i < path.path_hex.length; i += chunk) {
                hops.push(path.path_hex.substring(i, i + chunk).toUpperCase());
            }
            const pathDisplay = hops.join('→');
            const hashLabel = path.hash_size + 'B';

            item.innerHTML = `
                <span class="path-hex" title="${path.path_hex}">${pathDisplay}</span>
                <span class="badge bg-secondary">${hashLabel}</span>
                ${path.label ? `<span class="path-label" title="${path.label}">${path.label}</span>` : ''}
                <span class="path-actions">
                    <button class="btn btn-link p-0 ${path.is_primary ? 'text-warning' : 'text-muted'}"
                            title="${path.is_primary ? 'Primary path' : 'Set as primary'}"
                            data-action="primary" data-id="${path.id}">
                        <i class="bi bi-star${path.is_primary ? '-fill' : ''}"></i>
                    </button>
                    ${index > 0 ? `<button class="btn btn-link p-0 text-muted" title="Move up" data-action="up" data-id="${path.id}" data-index="${index}"><i class="bi bi-chevron-up"></i></button>` : ''}
                    ${index < data.paths.length - 1 ? `<button class="btn btn-link p-0 text-muted" title="Move down" data-action="down" data-id="${path.id}" data-index="${index}"><i class="bi bi-chevron-down"></i></button>` : ''}
                    <button class="btn btn-link p-0 text-danger" title="Delete" data-action="delete" data-id="${path.id}">
                        <i class="bi bi-trash"></i>
                    </button>
                </span>
            `;
            listEl.appendChild(item);
        });

        // Attach action handlers
        listEl.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const pathId = parseInt(btn.dataset.id);

                if (action === 'primary') {
                    await setPathPrimary(pubkey, pathId);
                } else if (action === 'delete') {
                    await deletePathItem(pubkey, pathId);
                } else if (action === 'up' || action === 'down') {
                    await movePathItem(pubkey, data.paths, parseInt(btn.dataset.index), action);
                }
            });
        });
    } catch (e) {
        listEl.innerHTML = '<div class="text-danger small">Failed to load paths</div>';
        console.error('Failed to load paths:', e);
    }
}

async function setPathPrimary(pubkey, pathId) {
    try {
        await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/${pathId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_primary: true })
        });
        await renderPathList(pubkey);
    } catch (e) {
        console.error('Failed to set primary path:', e);
    }
}

async function deletePathItem(pubkey, pathId) {
    try {
        await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/${pathId}`, {
            method: 'DELETE'
        });
        await renderPathList(pubkey);
    } catch (e) {
        console.error('Failed to delete path:', e);
    }
}

async function movePathItem(pubkey, paths, currentIndex, direction) {
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= paths.length) return;

    // Swap in the IDs array
    const ids = paths.map(p => p.id);
    [ids[currentIndex], ids[newIndex]] = [ids[newIndex], ids[currentIndex]];

    try {
        await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path_ids: ids })
        });
        await renderPathList(pubkey);
    } catch (e) {
        console.error('Failed to reorder paths:', e);
    }
}

/**
 * Setup handlers for the Add Path form.
 */
function setupPathFormHandlers(pubkey) {
    const addBtn = document.getElementById('dmAddPathBtn');
    const saveBtn = document.getElementById('dmSavePathBtn');
    const pickBtn = document.getElementById('dmPickRepeaterBtn');
    const picker = document.getElementById('dmRepeaterPicker');
    const resetFloodBtn = document.getElementById('dmResetFloodBtn');
    const addPathModalEl = document.getElementById('addPathModal');

    if (!addBtn || !addPathModalEl) return;

    const addPathModal = new bootstrap.Modal(addPathModalEl);

    // "+" button opens the Add Path modal
    const newAddBtn = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newAddBtn, addBtn);
    newAddBtn.addEventListener('click', () => {
        document.getElementById('dmPathHexInput').value = '';
        document.getElementById('dmPathLabelInput').value = '';
        document.getElementById('dmPathUniquenessWarning').style.display = 'none';
        if (picker) picker.style.display = 'none';
        addPathModal.show();
    });

    // Raise backdrop when Add Path modal opens (above Contact Info)
    addPathModalEl.addEventListener('shown.bs.modal', () => {
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops.length > 1) {
            backdrops[backdrops.length - 1].style.zIndex = '1060';
        }
    });

    // Save button
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', async () => {
        const pathHex = document.getElementById('dmPathHexInput').value.replace(/[,\s→]/g, '').trim();
        const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked').value);
        const label = document.getElementById('dmPathLabelInput').value.trim();

        if (!pathHex) {
            showNotification('Path hex is required', 'danger');
            return;
        }

        // Check for duplicate hops in manually entered path
        const chunk = hashSize * 2;
        const hops = [];
        for (let i = 0; i < pathHex.length; i += chunk) {
            hops.push(pathHex.substring(i, i + chunk).toLowerCase());
        }
        const dupes = hops.filter((h, i) => hops.indexOf(h) !== i);
        if (dupes.length > 0) {
            showNotification(`Duplicate hop(s): ${[...new Set(dupes)].map(d => d.toUpperCase()).join(', ')}`, 'danger');
            return;
        }

        try {
            const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path_hex: pathHex, hash_size: hashSize, label: label })
            });
            const data = await response.json();
            if (data.success) {
                addPathModal.hide();
                await renderPathList(pubkey);
                showNotification('Path added', 'info');
            } else {
                showNotification(data.error || 'Failed to add path', 'danger');
            }
        } catch (e) {
            showNotification('Failed to add path', 'danger');
        }
    });

    // Repeater picker toggle
    const newPickBtn = pickBtn.cloneNode(true);
    pickBtn.parentNode.replaceChild(newPickBtn, pickBtn);
    newPickBtn.addEventListener('click', () => {
        if (!picker) return;
        if (picker.style.display === 'none') {
            picker.style.display = '';
            loadRepeaterPicker(pubkey);
        } else {
            picker.style.display = 'none';
        }
    });

    // Repeater search filter
    const searchInput = document.getElementById('dmRepeaterSearch');
    if (searchInput) {
        const newSearch = searchInput.cloneNode(true);
        searchInput.parentNode.replaceChild(newSearch, searchInput);
        newSearch.addEventListener('input', () => {
            filterRepeaterList();
        });
    }

    // Repeater map picker button
    const mapBtn = document.getElementById('dmPickRepeaterMapBtn');
    if (mapBtn) {
        const newMapBtn = mapBtn.cloneNode(true);
        mapBtn.parentNode.replaceChild(newMapBtn, mapBtn);
        newMapBtn.addEventListener('click', () => {
            openRepeaterMapPicker();
        });
    }

    // Reset to FLOOD button
    if (resetFloodBtn) {
        const newResetBtn = resetFloodBtn.cloneNode(true);
        resetFloodBtn.parentNode.replaceChild(newResetBtn, resetFloodBtn);
        newResetBtn.addEventListener('click', async () => {
            if (!confirm('Reset to FLOOD?\n\nThis will delete all configured paths and reset the device path to flood mode.')) {
                return;
            }
            try {
                const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/paths/reset_flood`, {
                    method: 'POST'
                });
                const data = await response.json();
                if (data.success) {
                    await renderPathList(pubkey);
                    showNotification('Reset to FLOOD mode', 'info');
                } else {
                    showNotification(data.error || 'Reset failed', 'danger');
                }
            } catch (e) {
                showNotification('Reset failed', 'danger');
            }
        });
    }
}

/**
 * Load repeaters for the picker dropdown.
 */
async function loadRepeaterPicker(pubkey) {
    const listEl = document.getElementById('dmRepeaterList');
    if (!listEl) return;

    if (!_repeatersCache) {
        try {
            const response = await fetch('/api/contacts/repeaters');
            const data = await response.json();
            if (data.success) {
                _repeatersCache = data.repeaters;
            }
        } catch (e) {
            listEl.innerHTML = '<div class="text-danger small p-2">Failed to load repeaters</div>';
            return;
        }
    }

    renderRepeaterList(listEl, _repeatersCache, pubkey);
}

function getRepeaterSearchMode() {
    const checked = document.querySelector('input[name="repeaterSearchMode"]:checked');
    return checked ? checked.value : 'name';
}

function renderRepeaterList(listEl, repeaters, pubkey) {
    const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked').value);
    const hexInput = document.getElementById('dmPathHexInput');
    const searchVal = (document.getElementById('dmRepeaterSearch')?.value || '').toLowerCase().trim();
    const searchMode = getRepeaterSearchMode();
    const prefixLen = hashSize * 2; // hex chars to match for ID mode

    const filtered = repeaters.filter(r => {
        if (!searchVal) return true;
        if (searchMode === 'id') {
            // Match only against the first prefixLen hex chars of public_key
            const idPrefix = r.public_key.substring(0, prefixLen).toLowerCase();
            return idPrefix.startsWith(searchVal.substring(0, prefixLen));
        }
        return r.name.toLowerCase().includes(searchVal);
    });

    if (!filtered.length) {
        listEl.innerHTML = '<div class="text-muted small p-2">No repeaters found</div>';
        return;
    }

    listEl.innerHTML = '';
    filtered.forEach(rpt => {
        const prefix = rpt.public_key.substring(0, hashSize * 2).toUpperCase();
        // Check uniqueness: count repeaters with same prefix
        const samePrefix = repeaters.filter(r =>
            r.public_key.substring(0, hashSize * 2).toLowerCase() === prefix.toLowerCase()
        ).length;

        const item = document.createElement('div');
        item.className = 'repeater-picker-item';
        item.innerHTML = `
            <span class="badge ${samePrefix > 1 ? 'bg-warning text-dark' : 'bg-success'}">${prefix}</span>
            <span class="flex-grow-1 text-truncate">${rpt.name}</span>
            ${samePrefix > 1 ? '<i class="bi bi-exclamation-triangle text-warning" title="' + samePrefix + ' repeaters share this prefix"></i>' : ''}
        `;
        item.addEventListener('click', () => {
            // Check for duplicate hop
            const existingHops = getCurrentPathHops(hashSize);
            if (existingHops.includes(prefix.toLowerCase())) {
                showNotification(`${prefix} is already in the path`, 'warning');
                return;
            }
            // Append hop to path hex input
            const current = hexInput.value.replace(/[,\s→]/g, '').trim();
            const newVal = current + prefix.toLowerCase();
            // Format with commas for readability
            const chunk = hashSize * 2;
            const parts = [];
            for (let i = 0; i < newVal.length; i += chunk) {
                parts.push(newVal.substring(i, i + chunk));
            }
            hexInput.value = parts.join(',');

            // Show uniqueness warning if applicable
            checkUniquenessWarning(repeaters, hashSize);
        });
        listEl.appendChild(item);
    });
}

function filterRepeaterList() {
    if (!_repeatersCache) return;
    const listEl = document.getElementById('dmRepeaterList');
    const pubkey = getCurrentContactPubkey();
    if (listEl) {
        // Filtering is done inside renderRepeaterList based on search input + mode
        renderRepeaterList(listEl, _repeatersCache, pubkey);
    }
}

/**
 * Get the list of hop prefixes currently in the path hex input.
 */
function getCurrentPathHops(hashSize) {
    const hexInput = document.getElementById('dmPathHexInput');
    if (!hexInput) return [];
    const rawHex = hexInput.value.replace(/[,\s→]/g, '').trim().toLowerCase();
    const chunk = hashSize * 2;
    const hops = [];
    for (let i = 0; i < rawHex.length; i += chunk) {
        hops.push(rawHex.substring(i, i + chunk));
    }
    return hops;
}

function checkUniquenessWarning(repeaters, hashSize) {
    const warningEl = document.getElementById('dmPathUniquenessWarning');
    if (!warningEl) return;

    const hexInput = document.getElementById('dmPathHexInput');
    const rawHex = hexInput.value.replace(/[,\s→]/g, '').trim();
    const chunk = hashSize * 2;
    const hops = [];
    for (let i = 0; i < rawHex.length; i += chunk) {
        hops.push(rawHex.substring(i, i + chunk).toLowerCase());
    }

    const ambiguous = hops.filter(hop => {
        const count = repeaters.filter(r =>
            r.public_key.substring(0, chunk).toLowerCase() === hop
        ).length;
        return count > 1;
    });

    if (ambiguous.length > 0) {
        warningEl.textContent = `⚠ Ambiguous prefix(es): ${ambiguous.map(h => h.toUpperCase()).join(', ')}. Consider using a larger hash size.`;
        warningEl.style.display = '';
    } else {
        warningEl.style.display = 'none';
    }
}

// ================================================================
// Repeater Map Picker
// ================================================================

let _rptMap = null;
let _rptMapMarkers = null;
let _rptMapSelectedRepeater = null;

function openRepeaterMapPicker() {
    _rptMapSelectedRepeater = null;

    const modalEl = document.getElementById('repeaterMapModal');
    if (!modalEl) return;

    const addBtn = document.getElementById('rptMapAddBtn');
    const selectedLabel = document.getElementById('rptMapSelected');
    if (addBtn) addBtn.disabled = true;
    if (selectedLabel) selectedLabel.textContent = 'Click a repeater on the map';

    const modal = new bootstrap.Modal(modalEl);

    const onShown = async function () {
        // Raise backdrop z-index so it covers modals behind (Contact Info + Add Path)
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops.length > 0) {
            backdrops[backdrops.length - 1].style.zIndex = '1075';
        }

        // Init map once
        if (!_rptMap) {
            _rptMap = L.map('rptLeafletMap').setView([52.0, 19.0], 6);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>'
            }).addTo(_rptMap);
            _rptMapMarkers = L.layerGroup().addTo(_rptMap);
        }
        _rptMap.invalidateSize();
        await loadRepeaterMapMarkers();
        modalEl.removeEventListener('shown.bs.modal', onShown);
    };

    // Cached toggle
    const cachedSwitch = document.getElementById('rptMapCachedSwitch');
    if (cachedSwitch) {
        cachedSwitch.onchange = () => loadRepeaterMapMarkers();
    }

    // Add button
    if (addBtn) {
        addBtn.onclick = () => {
            if (!_rptMapSelectedRepeater) return;
            const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked').value);
            const prefix = _rptMapSelectedRepeater.public_key.substring(0, hashSize * 2).toLowerCase();
            // Check for duplicate hop
            const existingHops = getCurrentPathHops(hashSize);
            if (existingHops.includes(prefix)) {
                showNotification(`${prefix.toUpperCase()} is already in the path`, 'warning');
                return;
            }
            const hexInput = document.getElementById('dmPathHexInput');
            if (hexInput) {
                const current = hexInput.value.replace(/[,\s→]/g, '').trim();
                const newVal = current + prefix;
                const chunk = hashSize * 2;
                const parts = [];
                for (let i = 0; i < newVal.length; i += chunk) {
                    parts.push(newVal.substring(i, i + chunk));
                }
                hexInput.value = parts.join(',');
                if (_repeatersCache) {
                    checkUniquenessWarning(_repeatersCache, hashSize);
                }
            }
            // Reset selection for next pick
            _rptMapSelectedRepeater = null;
            if (addBtn) addBtn.disabled = true;
            if (selectedLabel) selectedLabel.textContent = 'Click a repeater on the map';
        };
    }

    modalEl.addEventListener('shown.bs.modal', onShown);
    modal.show();
}

async function loadRepeaterMapMarkers() {
    if (!_rptMapMarkers) return;
    _rptMapMarkers.clearLayers();

    const cachedSwitch = document.getElementById('rptMapCachedSwitch');
    const showCached = cachedSwitch && cachedSwitch.checked;
    const countEl = document.getElementById('rptMapCount');
    const addBtn = document.getElementById('rptMapAddBtn');
    const selectedLabel = document.getElementById('rptMapSelected');

    // Reset selection
    _rptMapSelectedRepeater = null;
    if (addBtn) addBtn.disabled = true;
    if (selectedLabel) selectedLabel.textContent = 'Click a repeater on the map';

    // Ensure repeaters cache is loaded
    if (!_repeatersCache) {
        try {
            const response = await fetch('/api/contacts/repeaters');
            const data = await response.json();
            if (data.success) _repeatersCache = data.repeaters;
        } catch (e) {
            if (countEl) countEl.textContent = 'Failed to load';
            return;
        }
    }

    // Filter: only those with GPS
    let repeaters = (_repeatersCache || []).filter(r =>
        r.adv_lat && r.adv_lon && (r.adv_lat !== 0 || r.adv_lon !== 0)
    );

    if (!showCached) {
        // Non-cached: only repeaters that are on the device (have recent advert)
        // Use detailed contacts to check which are on device
        try {
            const response = await fetch('/api/contacts/detailed');
            const data = await response.json();
            if (data.success && data.contacts) {
                const deviceKeys = new Set(data.contacts
                    .filter(c => c.type === 2)
                    .map(c => c.public_key.toLowerCase()));
                repeaters = repeaters.filter(r => deviceKeys.has(r.public_key.toLowerCase()));
            }
        } catch (e) { /* show all on error */ }
    }

    if (countEl) countEl.textContent = `${repeaters.length} repeaters`;

    const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked')?.value || '1');
    const bounds = [];

    repeaters.forEach(rpt => {
        const prefix = rpt.public_key.substring(0, hashSize * 2).toUpperCase();
        const lastSeen = rpt.last_advert ? formatRelativeTimeDm(rpt.last_advert) : '';

        const marker = L.circleMarker([rpt.adv_lat, rpt.adv_lon], {
            radius: 10,
            fillColor: '#4CAF50',
            color: '#fff',
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        }).addTo(_rptMapMarkers);

        marker.bindPopup(
            `<b>${rpt.name}</b><br>` +
            `<code>${prefix}</code>` +
            (lastSeen ? `<br><small class="text-muted">Last seen: ${lastSeen}</small>` : '')
        );

        marker.on('click', () => {
            _rptMapSelectedRepeater = rpt;
            if (addBtn) addBtn.disabled = false;
            if (selectedLabel) {
                selectedLabel.innerHTML = `<code>${prefix}</code> ${rpt.name}`;
            }
        });

        bounds.push([rpt.adv_lat, rpt.adv_lon]);
    });

    if (bounds.length > 0) {
        _rptMap.fitBounds(bounds, { padding: [20, 20] });
    }
}

/**
 * Load and setup the No Auto Flood toggle for current contact.
 */
async function loadNoAutoFloodToggle(pubkey) {
    const toggle = document.getElementById('dmNoAutoFloodToggle');
    if (!toggle || !pubkey) return;

    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/no_auto_flood`);
        const data = await response.json();
        if (data.success) {
            toggle.checked = data.no_auto_flood;
        }
    } catch (e) {
        console.debug('Failed to load no_auto_flood:', e);
    }

    // Replace to avoid duplicate listeners
    const newToggle = toggle.cloneNode(true);
    toggle.parentNode.replaceChild(newToggle, toggle);
    newToggle.id = 'dmNoAutoFloodToggle';

    newToggle.addEventListener('change', async function () {
        try {
            const response = await fetch(`/api/contacts/${encodeURIComponent(pubkey)}/no_auto_flood`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ no_auto_flood: this.checked })
            });
            const data = await response.json();
            if (data.success) {
                showNotification(
                    data.no_auto_flood ? 'No Flood Fallback enabled' : 'No Flood Fallback disabled',
                    'info'
                );
            }
        } catch (e) {
            console.error('Failed to update no_auto_flood:', e);
            this.checked = !this.checked;
        }
    });
}

// Listen for hash size and search mode radio changes
document.addEventListener('change', (e) => {
    if (e.target.name === 'pathHashSize') {
        _repeatersCache = null; // Refresh to recalculate prefixes
        const picker = document.getElementById('dmRepeaterPicker');
        if (picker && picker.style.display !== 'none') {
            loadRepeaterPicker(getCurrentContactPubkey());
        }
        // Clear path hex input when changing hash size
        const hexInput = document.getElementById('dmPathHexInput');
        if (hexInput) hexInput.value = '';
        // Update ID search placeholder with new prefix length
        updateRepeaterSearchPlaceholder();
    }
    if (e.target.name === 'repeaterSearchMode') {
        updateRepeaterSearchPlaceholder();
        const searchInput = document.getElementById('dmRepeaterSearch');
        if (searchInput) searchInput.value = '';
        filterRepeaterList();
    }
});

function updateRepeaterSearchPlaceholder() {
    const searchInput = document.getElementById('dmRepeaterSearch');
    if (!searchInput) return;
    const mode = getRepeaterSearchMode();
    if (mode === 'id') {
        const hashSize = parseInt(document.querySelector('input[name="pathHashSize"]:checked')?.value || '1');
        const chars = hashSize * 2;
        searchInput.placeholder = `Search by first ${chars} hex chars...`;
    } else {
        searchInput.placeholder = 'Search by name...';
    }
}
