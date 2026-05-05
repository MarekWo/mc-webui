/**
 * mc-webui Console - Chat-style meshcli interface
 *
 * Provides interactive command console for meshcli via WebSocket.
 * Commands are sent to meshcore-bridge and responses are displayed
 * in a chat-like format.
 */

let socket = null;
let isConnected = false;
let commandHistory = [];      // Local session history (for arrow keys)
let serverHistory = [];       // Server-persisted history (for dropdown)
let historyIndex = -1;
let pendingCommandDiv = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async function() {
    console.log('Console page initialized');
    loadServerHistory();
    await loadOutputHistory();
    connectWebSocket();
    setupInputHandlers();
    setupHistoryDropdown();
    setupClearOutputButton();
});

/**
 * Connect to WebSocket server (proxied through main Flask app)
 */
function connectWebSocket() {
    updateStatus('connecting');

    // Connect to same origin - WebSocket is proxied through main Flask app
    const wsUrl = window.location.origin;

    console.log('Connecting to WebSocket:', wsUrl);

    try {
        socket = io(wsUrl + '/console', {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            timeout: 20000
        });

        // Connection events
        socket.on('connect', () => {
            console.log('WebSocket connected');
            isConnected = true;
            updateStatus('connected');
            enableInput(true);
        });

        socket.on('disconnect', (reason) => {
            console.log('WebSocket disconnected:', reason);
            isConnected = false;
            updateStatus('disconnected');
            enableInput(false);
            addMessage('Disconnected', 'error');

            // Clear pending command indicator
            if (pendingCommandDiv) {
                pendingCommandDiv.classList.remove('pending');
                pendingCommandDiv = null;
            }
        });

        socket.on('connect_error', (error) => {
            console.error('WebSocket connection error:', error);
            updateStatus('disconnected');
        });

        // Console events from server
        socket.on('console_status', (data) => {
            console.log('Console status:', data);
            if (data.message) {
                addMessage(data.message, 'system');
            }
        });

        socket.on('command_response', (data) => {
            console.log('Command response:', data);

            // Clear pending indicator
            if (pendingCommandDiv) {
                pendingCommandDiv.classList.remove('pending');
                pendingCommandDiv = null;
            }

            // Display response
            if (data.success) {
                const output = data.output || '(no output)';
                addMessage(output, 'response');
            } else {
                addMessage(`Error: ${data.error}`, 'error');
            }
            scrollToBottom();
        });

    } catch (error) {
        console.error('Failed to create WebSocket connection:', error);
        updateStatus('disconnected');
        addMessage('Failed to connect: ' + error.message, 'error');
    }
}

/**
 * Setup input form handlers
 */
function setupInputHandlers() {
    const form = document.getElementById('consoleForm');
    const input = document.getElementById('commandInput');

    // Form submit
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        sendCommand();
    });

    // Command history navigation with arrow keys
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            navigateHistory(-1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            navigateHistory(1);
        }
    });
}

/**
 * Send command to meshcli
 */
function sendCommand() {
    const input = document.getElementById('commandInput');
    const command = input.value.trim();

    if (!command || !isConnected) {
        return;
    }

    // Add to local history (avoid duplicates at end)
    if (commandHistory.length === 0 || commandHistory[commandHistory.length - 1] !== command) {
        commandHistory.push(command);
        // Limit history size
        if (commandHistory.length > 100) {
            commandHistory.shift();
        }
    }
    historyIndex = commandHistory.length;

    // Save to server history (async, don't wait)
    saveToServerHistory(command);

    // Show command in chat with pending indicator
    pendingCommandDiv = addMessage(command, 'command pending');

    // Send to server
    socket.emit('send_command', { command: command });

    // Clear input
    input.value = '';
    scrollToBottom();
}

/**
 * Navigate command history
 * @param {number} direction -1 for older, 1 for newer
 */
function navigateHistory(direction) {
    const input = document.getElementById('commandInput');

    if (commandHistory.length === 0) {
        return;
    }

    historyIndex += direction;

    // Clamp to valid range
    if (historyIndex < 0) {
        historyIndex = 0;
    }
    if (historyIndex >= commandHistory.length) {
        historyIndex = commandHistory.length;
        input.value = '';
        return;
    }

    input.value = commandHistory[historyIndex];

    // Move cursor to end
    setTimeout(() => {
        input.selectionStart = input.selectionEnd = input.value.length;
    }, 0);
}

/**
 * Add message to console display
 * @param {string} text Message text
 * @param {string} type Message type: 'command', 'response', 'error', 'system'
 *                     (may include extra modifier classes like 'command pending')
 * @param {boolean} persist Whether to save to the persistent transcript (default true)
 * @returns {HTMLElement} The created message div
 */
function addMessage(text, type, persist = true) {
    const container = document.getElementById('consoleMessages');
    const div = document.createElement('div');
    div.className = `console-message ${type}`;
    div.textContent = text;
    container.appendChild(div);
    if (persist) {
        const baseType = (type || '').split(' ')[0];
        saveOutputEntry(baseType, text);
    }
    return div;
}

/**
 * Scroll messages container to bottom
 */
function scrollToBottom() {
    const container = document.getElementById('consoleMessages');
    // Use setTimeout to ensure DOM is updated
    setTimeout(() => {
        container.scrollTop = container.scrollHeight;
    }, 10);
}

/**
 * Update connection status indicator
 * @param {string} status 'connected', 'disconnected', or 'connecting'
 */
function updateStatus(status) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');

    if (!dot || !text) return;

    dot.className = `status-dot ${status}`;

    switch (status) {
        case 'connected':
            text.textContent = 'Connected';
            text.className = 'text-success';
            break;
        case 'disconnected':
            text.textContent = 'Disconnected';
            text.className = 'text-danger';
            break;
        case 'connecting':
            text.textContent = 'Connecting...';
            text.className = 'text-warning';
            break;
    }
}

/**
 * Enable or disable input controls
 * @param {boolean} enabled
 */
function enableInput(enabled) {
    const input = document.getElementById('commandInput');
    const btn = document.getElementById('sendBtn');
    const historyBtn = document.getElementById('historyBtn');

    if (input) {
        input.disabled = !enabled;
        if (enabled) {
            input.focus();
        }
    }

    if (btn) {
        btn.disabled = !enabled;
    }

    if (historyBtn) {
        historyBtn.disabled = !enabled;
    }
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
    if (socket) {
        socket.disconnect();
    }
});


// ============================================================
// Server-side command history
// ============================================================

/**
 * Load command history from server
 */
async function loadServerHistory() {
    try {
        const response = await fetch('/api/console/history');
        const data = await response.json();
        if (data.success && data.commands) {
            serverHistory = data.commands;
            // Also populate local history for arrow key navigation
            commandHistory = [...serverHistory];
            historyIndex = commandHistory.length;
            console.log(`Loaded ${serverHistory.length} commands from server history`);
        }
    } catch (error) {
        console.error('Failed to load server history:', error);
    }
}

/**
 * Save command to server history
 * @param {string} command Command to save
 */
async function saveToServerHistory(command) {
    try {
        const response = await fetch('/api/console/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: command })
        });
        const data = await response.json();
        if (data.success && data.commands) {
            serverHistory = data.commands;
        }
    } catch (error) {
        console.error('Failed to save to server history:', error);
    }
}

/**
 * Setup history dropdown button and menu
 */
function setupHistoryDropdown() {
    const historyBtn = document.getElementById('historyBtn');
    const historyMenu = document.getElementById('historyMenu');

    if (!historyBtn || !historyMenu) return;

    // Toggle dropdown on button click
    historyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleHistoryDropdown();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!historyMenu.contains(e.target) && e.target !== historyBtn) {
            historyMenu.classList.remove('show');
        }
    });

    // Close dropdown on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            historyMenu.classList.remove('show');
        }
    });
}

/**
 * Toggle history dropdown visibility
 */
function toggleHistoryDropdown() {
    const historyMenu = document.getElementById('historyMenu');
    if (!historyMenu) return;

    if (historyMenu.classList.contains('show')) {
        historyMenu.classList.remove('show');
    } else {
        populateHistoryDropdown();
        historyMenu.classList.add('show');
    }
}

/**
 * Populate history dropdown with commands
 */
function populateHistoryDropdown() {
    const historyMenu = document.getElementById('historyMenu');
    if (!historyMenu) return;

    historyMenu.innerHTML = '';

    if (serverHistory.length === 0) {
        historyMenu.innerHTML = '<div class="history-empty">No commands in history</div>';
        return;
    }

    // Show most recent first (reversed)
    const reversedHistory = [...serverHistory].reverse();

    reversedHistory.forEach((cmd) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'history-item';
        item.textContent = cmd;
        item.title = cmd;
        item.addEventListener('click', () => selectHistoryItem(cmd));
        historyMenu.appendChild(item);
    });
}

/**
 * Select a command from history dropdown
 * @param {string} command Command to select
 */
function selectHistoryItem(command) {
    const input = document.getElementById('commandInput');
    const historyMenu = document.getElementById('historyMenu');

    if (input) {
        input.value = command;
        input.focus();
        // Move cursor to end
        setTimeout(() => {
            input.selectionStart = input.selectionEnd = input.value.length;
        }, 0);
    }

    if (historyMenu) {
        historyMenu.classList.remove('show');
    }
}


// ============================================================
// Persistent console output transcript
// ============================================================

/**
 * Load persisted output entries and render them as historic (faded) items,
 * followed by a divider marking the start of the current session.
 */
async function loadOutputHistory() {
    try {
        const response = await fetch('/api/console/output');
        const data = await response.json();
        if (!data.success || !Array.isArray(data.entries) || data.entries.length === 0) {
            return;
        }
        const container = document.getElementById('consoleMessages');
        if (!container) return;
        for (const entry of data.entries) {
            const div = document.createElement('div');
            div.className = `console-message ${entry.type} historic`;
            div.textContent = entry.text;
            container.appendChild(div);
        }
        const divider = document.createElement('hr');
        divider.className = 'history-divider';
        container.appendChild(divider);
    } catch (error) {
        console.error('Failed to load output history:', error);
    }
}

/**
 * POST a single transcript entry to the server (fire-and-forget).
 */
function saveOutputEntry(type, text) {
    try {
        fetch('/api/console/output', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, text })
        }).catch(err => console.error('Failed to persist output entry:', err));
    } catch (error) {
        console.error('Failed to persist output entry:', error);
    }
}

/**
 * Clear the persisted transcript and the current display.
 */
async function clearOutputHistory() {
    try {
        await fetch('/api/console/output', { method: 'DELETE' });
    } catch (error) {
        console.error('Failed to clear output history:', error);
    }
    const container = document.getElementById('consoleMessages');
    if (container) {
        container.innerHTML = '';
    }
}

/**
 * Wire the trash button next to the history dropdown.
 */
function setupClearOutputButton() {
    const btn = document.getElementById('clearOutputBtn');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        clearOutputHistory();
    });
}
