/**
 * System Log Viewer
 *
 * Real-time log streaming via WebSocket with filtering and search.
 */
(function () {
    'use strict';

    // --- DOM refs ---
    const logEntries = document.getElementById('logEntries');
    const loadingMsg = document.getElementById('loadingMsg');
    const logCount = document.getElementById('logCount');
    const statusDot = document.getElementById('statusDot');
    const pauseBtn = document.getElementById('pauseBtn');
    const pauseIcon = document.getElementById('pauseIcon');
    const clearBtn = document.getElementById('clearBtn');
    const levelFilter = document.getElementById('levelFilter');
    const loggerFilter = document.getElementById('loggerFilter');
    const searchFilter = document.getElementById('searchFilter');
    const resetFilters = document.getElementById('resetFilters');

    // --- State ---
    let paused = false;
    let autoScroll = true;
    let entries = [];       // all received entries
    let displayCount = 0;
    const MAX_DISPLAY = 3000;  // max DOM entries before trimming
    let searchDebounce = null;
    let knownLoggers = new Set();

    // --- Level ordering ---
    const LEVEL_ORDER = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };

    // --- WebSocket ---
    const socket = io('/logs', {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
        setStatus('live');
        // Load initial entries
        loadInitialLogs();
    });

    socket.on('disconnect', () => {
        setStatus('disconnected');
    });

    socket.on('log_entry', (entry) => {
        addEntry(entry);
    });

    // --- Functions ---

    function setStatus(state) {
        statusDot.className = 'status-indicator ' + state;
    }

    function loadInitialLogs() {
        const level = levelFilter.value;
        const params = new URLSearchParams();
        if (level) params.set('level', level);
        params.set('limit', '1000');

        fetch('/api/logs?' + params.toString())
            .then(r => r.json())
            .then(data => {
                if (!data.success) return;
                loadingMsg?.remove();

                // Update logger filter options
                if (data.loggers) {
                    data.loggers.forEach(l => knownLoggers.add(l));
                    updateLoggerOptions();
                }

                // Render entries
                entries = data.entries || [];
                renderAll();
            })
            .catch(err => {
                if (loadingMsg) loadingMsg.textContent = 'Failed to load logs';
                console.error('Failed to load logs:', err);
            });
    }

    function addEntry(entry) {
        entries.push(entry);

        // Track new loggers
        if (!knownLoggers.has(entry.logger)) {
            knownLoggers.add(entry.logger);
            updateLoggerOptions();
        }

        // If paused or filtered out, don't add to DOM
        if (paused) {
            updateCount();
            return;
        }

        if (matchesFilter(entry)) {
            appendEntryDOM(entry);
            trimDOM();
            if (autoScroll) scrollToBottom();
        }
        updateCount();
    }

    function matchesFilter(entry) {
        // Level filter
        const minLevel = levelFilter.value;
        if (minLevel && (LEVEL_ORDER[entry.level] || 0) < (LEVEL_ORDER[minLevel] || 0)) {
            return false;
        }

        // Logger filter
        const loggerVal = loggerFilter.value;
        if (loggerVal && !entry.logger.startsWith(loggerVal)) {
            return false;
        }

        // Search filter
        const search = searchFilter.value.trim().toLowerCase();
        if (search && !entry.message.toLowerCase().includes(search) &&
            !entry.logger.toLowerCase().includes(search)) {
            return false;
        }

        return true;
    }

    function renderAll() {
        logEntries.innerHTML = '';
        displayCount = 0;

        const filtered = entries.filter(e => matchesFilter(e));
        // Only render last MAX_DISPLAY entries
        const toRender = filtered.slice(-MAX_DISPLAY);
        const fragment = document.createDocumentFragment();

        for (const entry of toRender) {
            fragment.appendChild(createEntryElement(entry));
            displayCount++;
        }

        logEntries.appendChild(fragment);
        updateCount();
        scrollToBottom();
    }

    function appendEntryDOM(entry) {
        logEntries.appendChild(createEntryElement(entry));
        displayCount++;
    }

    function createEntryElement(entry) {
        const div = document.createElement('div');
        div.className = 'log-line';

        // Shorten timestamp to HH:MM:SS.mmm
        const ts = entry.timestamp.length > 11 ? entry.timestamp.substring(11) : entry.timestamp;

        // Shorten logger name (remove 'app.' prefix)
        let loggerName = entry.logger;
        if (loggerName.startsWith('app.')) {
            loggerName = loggerName.substring(4);
        }

        // Pad level to 5 chars
        const levelPad = entry.level.padEnd(5);

        // Build the line with color spans
        const search = searchFilter.value.trim().toLowerCase();
        let message = escapeHtml(entry.message);
        if (search) {
            message = highlightSearch(message, search);
        }

        div.innerHTML =
            `<span class="log-ts">${escapeHtml(ts)}</span> ` +
            `<span class="log-level-${entry.level}">${escapeHtml(levelPad)}</span> ` +
            `<span class="log-logger">${escapeHtml(loggerName.padEnd(18).substring(0, 18))}</span> ` +
            `<span class="log-msg-${entry.level}">${message}</span>`;

        return div;
    }

    function trimDOM() {
        while (logEntries.children.length > MAX_DISPLAY) {
            logEntries.removeChild(logEntries.firstChild);
            displayCount--;
        }
    }

    function scrollToBottom() {
        logEntries.scrollTop = logEntries.scrollHeight;
    }

    function updateCount() {
        const total = entries.length;
        const shown = logEntries.children.length;
        logCount.textContent = shown === total
            ? `${total} entries`
            : `${shown} / ${total} entries`;
    }

    function updateLoggerOptions() {
        const current = loggerFilter.value;
        // Group loggers by top-level module
        const sorted = Array.from(knownLoggers).sort();

        loggerFilter.innerHTML = '<option value="">All modules</option>';
        for (const name of sorted) {
            const opt = document.createElement('option');
            opt.value = name;
            // Shorten display
            opt.textContent = name.startsWith('app.') ? name.substring(4) : name;
            if (name === current) opt.selected = true;
            loggerFilter.appendChild(opt);
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function highlightSearch(html, search) {
        if (!search) return html;
        // Case-insensitive highlight (on already-escaped HTML)
        const regex = new RegExp('(' + search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        return html.replace(regex, '<mark>$1</mark>');
    }

    // --- Auto-scroll detection ---
    logEntries.addEventListener('scroll', () => {
        const atBottom = logEntries.scrollHeight - logEntries.scrollTop - logEntries.clientHeight < 50;
        autoScroll = atBottom;
    });

    // --- Controls ---
    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseIcon.className = paused ? 'bi bi-play-fill' : 'bi bi-pause-fill';
        setStatus(paused ? 'paused' : 'live');
        if (!paused) {
            // Resume: re-render to catch up
            renderAll();
        }
    });

    clearBtn.addEventListener('click', () => {
        entries = [];
        logEntries.innerHTML = '';
        displayCount = 0;
        updateCount();
    });

    // Filter handlers
    levelFilter.addEventListener('change', () => renderAll());
    loggerFilter.addEventListener('change', () => renderAll());
    searchFilter.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => renderAll(), 250);
    });
    resetFilters.addEventListener('click', () => {
        levelFilter.value = 'INFO';
        loggerFilter.value = '';
        searchFilter.value = '';
        renderAll();
    });
})();
