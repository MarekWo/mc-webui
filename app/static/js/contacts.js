/**
 * Contact Management UI - Multi-Page Version
 *
 * Features:
 * - Manual contact approval toggle (persistent across restarts)
 * - Pending contacts list with approve/copy actions
 * - Existing contacts list with search, filter, and sort
 * - Three dedicated pages: manage, pending, existing
 * - Auto-refresh on page load
 * - Mobile-first design
 */

// =============================================================================
// Global Navigation Helper
// =============================================================================

/**
 * Global navigation function - cleans up DOM before navigation
 * This prevents viewport issues when navigating between pages
 */
window.navigateTo = function(url) {
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
// State Management
// =============================================================================

let currentPage = null; // 'manage', 'pending', 'existing'
let manualApprovalEnabled = false;
let pendingContacts = [];
let filteredPendingContacts = []; // Filtered pending contacts (for pending page filtering)
let existingContacts = [];
let filteredContacts = [];
let contactToDelete = null;
let protectedContacts = []; // List of protected public_keys

// Sort state (for existing page)
let sortBy = 'last_advert'; // 'name' or 'last_advert'
let sortOrder = 'desc'; // 'asc' or 'desc'

// Auto-cleanup state
let autoCleanupSettings = null;
let cleanupSaveDebounceTimer = null;
let cleanupTimezone = 'local'; // Timezone from server (e.g., 'Europe/Warsaw')

// Map state (Leaflet)
let leafletMap = null;
let markersGroup = null;

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

// Make showContactOnMap available globally
window.showContactOnMap = showContactOnMap;

// =============================================================================
// Initialization
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    console.log('Contact Management UI initialized');

    // Initialize Bootstrap tooltips
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });

    // Detect current page
    detectCurrentPage();

    // Initialize page-specific functionality
    initializePage();
});

function detectCurrentPage() {
    if (document.getElementById('managePageContent')) {
        currentPage = 'manage';
    } else if (document.getElementById('pendingPageContent')) {
        currentPage = 'pending';
    } else if (document.getElementById('existingPageContent')) {
        currentPage = 'existing';
    }
    console.log('Current page:', currentPage);
}

function initializePage() {
    switch (currentPage) {
        case 'manage':
            initManagePage();
            break;
        case 'pending':
            initPendingPage();
            break;
        case 'existing':
            initExistingPage();
            break;
        default:
            console.warn('Unknown page type');
    }
}

// =============================================================================
// Management Page Initialization
// =============================================================================

function initManagePage() {
    console.log('Initializing Management page...');

    // Load settings for manual approval toggle
    loadSettings();

    // Load contact counts for badges
    loadContactCounts();

    // Load cleanup settings (populates form and auto-cleanup status)
    loadCleanupSettings();

    // Attach event listeners for manage page
    attachManageEventListeners();
}

function attachManageEventListeners() {
    // Manual approval toggle
    const approvalSwitch = document.getElementById('manualApprovalSwitch');
    if (approvalSwitch) {
        approvalSwitch.addEventListener('change', handleApprovalToggle);
    }

    // Cleanup preview button
    const cleanupPreviewBtn = document.getElementById('cleanupPreviewBtn');
    if (cleanupPreviewBtn) {
        cleanupPreviewBtn.addEventListener('click', handleCleanupPreview);
    }

    // Cleanup confirm button (in modal)
    const confirmCleanupBtn = document.getElementById('confirmCleanupBtn');
    if (confirmCleanupBtn) {
        confirmCleanupBtn.addEventListener('click', handleCleanupConfirm);
    }

    // Auto-cleanup toggle
    const autoCleanupSwitch = document.getElementById('autoCleanupSwitch');
    if (autoCleanupSwitch) {
        autoCleanupSwitch.addEventListener('change', handleAutoCleanupToggle);
    }

    // Debounced auto-save for cleanup filter inputs
    const cleanupNameFilter = document.getElementById('cleanupNameFilter');
    if (cleanupNameFilter) {
        cleanupNameFilter.addEventListener('input', debouncedSaveCleanupCriteria);
    }

    const cleanupDays = document.getElementById('cleanupDays');
    if (cleanupDays) {
        cleanupDays.addEventListener('input', debouncedSaveCleanupCriteria);
    }

    // Type filter checkboxes
    document.querySelectorAll('.cleanup-type-filter').forEach(cb => {
        cb.addEventListener('change', debouncedSaveCleanupCriteria);
    });

    // Date field radio buttons
    document.querySelectorAll('input[name="cleanupDateField"]').forEach(radio => {
        radio.addEventListener('change', debouncedSaveCleanupCriteria);
    });

    // Cleanup hour selector (only saves when auto-cleanup is enabled)
    const cleanupHour = document.getElementById('cleanupHour');
    if (cleanupHour) {
        cleanupHour.addEventListener('change', () => {
            // Only save if auto-cleanup is enabled
            if (autoCleanupSettings && autoCleanupSettings.enabled) {
                saveCleanupSettings(true);
            }
        });
    }
}

async function loadContactCounts() {
    try {
        // Get saved type filter from localStorage
        const savedTypes = loadPendingTypeFilter();

        // Build query string with types parameter
        const params = new URLSearchParams();
        savedTypes.forEach(type => params.append('types', type));

        // Fetch pending count (with type filter)
        const pendingResp = await fetch(`/api/contacts/pending?${params.toString()}`);
        const pendingData = await pendingResp.json();

        const pendingBadge = document.getElementById('pendingBadge');
        if (pendingBadge && pendingData.success) {
            const count = pendingData.pending?.length || 0;
            pendingBadge.textContent = count;
            pendingBadge.classList.remove('spinner-border', 'spinner-border-sm');
        }

        // Fetch existing count
        const existingResp = await fetch('/api/contacts/detailed');
        const existingData = await existingResp.json();

        const existingBadge = document.getElementById('existingBadge');
        if (existingBadge && existingData.success) {
            const count = existingData.count || 0;
            const limit = existingData.limit || 350;
            existingBadge.textContent = `${count} / ${limit}`;
            existingBadge.classList.remove('spinner-border', 'spinner-border-sm');

            // Apply counter color coding
            existingBadge.classList.remove('counter-ok', 'counter-warning', 'counter-alarm');
            if (count >= 340) {
                existingBadge.classList.add('counter-alarm');
            } else if (count >= 300) {
                existingBadge.classList.add('counter-warning');
            } else {
                existingBadge.classList.add('counter-ok');
            }
        }
    } catch (error) {
        console.error('Error loading contact counts:', error);
    }
}

// =============================================================================
// Auto-Cleanup Settings Management
// =============================================================================

/**
 * Load cleanup settings from server and apply to UI.
 */
async function loadCleanupSettings() {
    const statusText = document.getElementById('autoCleanupStatusText');
    if (statusText) statusText.textContent = 'Loading...';

    try {
        const response = await fetch('/api/contacts/cleanup-settings');
        const data = await response.json();

        if (data.success) {
            autoCleanupSettings = data.settings;
            cleanupTimezone = data.timezone || 'local';
            applyCleanupSettingsToUI(autoCleanupSettings);
            console.log('Loaded cleanup settings:', autoCleanupSettings, 'timezone:', cleanupTimezone);
        } else {
            console.error('Failed to load cleanup settings:', data.error);
            if (statusText) statusText.textContent = 'Error loading settings';
        }
    } catch (error) {
        console.error('Error loading cleanup settings:', error);
        if (statusText) statusText.textContent = 'Network error';
    }
}

/**
 * Apply cleanup settings to form inputs.
 * @param {Object} settings - Cleanup settings object
 */
function applyCleanupSettingsToUI(settings) {
    // Name filter
    const nameInput = document.getElementById('cleanupNameFilter');
    if (nameInput) {
        nameInput.value = settings.name_filter || '';
    }

    // Days
    const daysInput = document.getElementById('cleanupDays');
    if (daysInput) {
        daysInput.value = settings.days || 0;
    }

    // Date field
    const dateFieldValue = settings.date_field || 'last_advert';
    const dateRadio = document.querySelector(`input[name="cleanupDateField"][value="${dateFieldValue}"]`);
    if (dateRadio) {
        dateRadio.checked = true;
    }

    // Contact types
    const types = settings.types || [1, 2, 3, 4];
    document.querySelectorAll('.cleanup-type-filter').forEach(cb => {
        cb.checked = types.includes(parseInt(cb.value));
    });

    // Auto-cleanup switch and status
    const autoCleanupSwitch = document.getElementById('autoCleanupSwitch');
    const statusText = document.getElementById('autoCleanupStatusText');
    const hourSelect = document.getElementById('cleanupHour');
    const timezoneLabel = document.getElementById('cleanupTimezoneLabel');

    if (autoCleanupSwitch) {
        autoCleanupSwitch.checked = settings.enabled || false;
    }

    // Hour selector
    const hour = settings.hour !== undefined ? settings.hour : 1;
    if (hourSelect) {
        hourSelect.value = hour;
        hourSelect.disabled = !settings.enabled;
    }

    // Display timezone next to hour selector
    if (timezoneLabel) {
        timezoneLabel.textContent = `(${cleanupTimezone})`;
    }

    if (statusText) {
        if (settings.enabled) {
            const hourStr = hour.toString().padStart(2, '0');
            statusText.textContent = `Enabled (runs daily at ${hourStr}:00 ${cleanupTimezone})`;
            statusText.classList.remove('text-muted');
            statusText.classList.add('text-success');
        } else {
            statusText.textContent = 'Disabled';
            statusText.classList.remove('text-success');
            statusText.classList.add('text-muted');
        }
    }
}

/**
 * Handle auto-cleanup toggle change.
 * Validates criteria before enabling.
 */
async function handleAutoCleanupToggle(event) {
    const enabled = event.target.checked;
    const statusText = document.getElementById('autoCleanupStatusText');
    const hourSelect = document.getElementById('cleanupHour');

    // Validate before enabling
    if (enabled) {
        const criteria = collectCleanupCriteria();

        // Check if days > 0
        if (criteria.days <= 0) {
            showToast('Set "Days of Inactivity" > 0 before enabling auto-cleanup', 'warning');
            event.target.checked = false;
            return;
        }

        // Check if at least one type is selected
        if (criteria.types.length === 0) {
            showToast('Select at least one contact type before enabling auto-cleanup', 'warning');
            event.target.checked = false;
            return;
        }
    }

    // Enable/disable hour selector
    if (hourSelect) {
        hourSelect.disabled = !enabled;
    }

    // Update status text while saving
    if (statusText) {
        statusText.textContent = 'Saving...';
        statusText.classList.remove('text-success', 'text-muted');
    }

    // Save settings with new enabled state
    const success = await saveCleanupSettings(enabled);

    if (!success) {
        // Revert switch and hour selector on failure
        event.target.checked = !enabled;
        if (hourSelect) {
            hourSelect.disabled = enabled;
        }
    }
}

/**
 * Debounced save for cleanup criteria changes.
 * Only saves criteria, does not change enabled state.
 */
function debouncedSaveCleanupCriteria() {
    // Clear existing timer
    if (cleanupSaveDebounceTimer) {
        clearTimeout(cleanupSaveDebounceTimer);
    }

    // Set new timer (500ms debounce)
    cleanupSaveDebounceTimer = setTimeout(() => {
        // Only save if auto-cleanup settings have been loaded
        if (autoCleanupSettings !== null) {
            // Preserve current enabled state
            saveCleanupSettings(autoCleanupSettings.enabled);
        }
    }, 500);
}

/**
 * Save cleanup settings to server.
 * @param {boolean} enabled - Whether auto-cleanup should be enabled
 * @returns {Promise<boolean>} True if save was successful
 */
async function saveCleanupSettings(enabled) {
    const criteria = collectCleanupCriteria();
    const statusText = document.getElementById('autoCleanupStatusText');
    const hourSelect = document.getElementById('cleanupHour');
    const hour = hourSelect ? parseInt(hourSelect.value) : 1;

    const settings = {
        enabled: enabled,
        types: criteria.types,
        date_field: criteria.date_field,
        days: criteria.days,
        name_filter: criteria.name_filter,
        hour: hour
    };

    try {
        const response = await fetch('/api/contacts/cleanup-settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(settings)
        });

        const data = await response.json();

        if (data.success) {
            autoCleanupSettings = data.settings;
            // Update timezone if provided in response
            if (data.timezone) {
                cleanupTimezone = data.timezone;
            }

            // Update status text
            if (statusText) {
                if (data.settings.enabled) {
                    const savedHour = data.settings.hour !== undefined ? data.settings.hour : 1;
                    const hourStr = savedHour.toString().padStart(2, '0');
                    statusText.textContent = `Enabled (runs daily at ${hourStr}:00 ${cleanupTimezone})`;
                    statusText.classList.remove('text-muted');
                    statusText.classList.add('text-success');
                } else {
                    statusText.textContent = 'Disabled';
                    statusText.classList.remove('text-success');
                    statusText.classList.add('text-muted');
                }
            }

            console.log('Cleanup settings saved:', data.settings);
            return true;
        } else {
            console.error('Failed to save cleanup settings:', data.error);
            showToast('Failed to save settings: ' + data.error, 'danger');

            // Restore previous status
            if (statusText && autoCleanupSettings) {
                if (autoCleanupSettings.enabled) {
                    const prevHour = autoCleanupSettings.hour !== undefined ? autoCleanupSettings.hour : 1;
                    const hourStr = prevHour.toString().padStart(2, '0');
                    statusText.textContent = `Enabled (runs daily at ${hourStr}:00 ${cleanupTimezone})`;
                } else {
                    statusText.textContent = 'Disabled';
                }
            }

            return false;
        }
    } catch (error) {
        console.error('Error saving cleanup settings:', error);
        showToast('Network error saving settings', 'danger');

        if (statusText) {
            statusText.textContent = 'Save failed';
        }

        return false;
    }
}

// Global variable to store preview contacts
let cleanupPreviewContacts = [];

function collectCleanupCriteria() {
    /**
     * Collect cleanup filter criteria from form inputs.
     *
     * Returns:
     *   Object with criteria: {name_filter, types, date_field, days}
     */
    // Name filter
    const nameFilter = document.getElementById('cleanupNameFilter')?.value?.trim() || '';

    // Selected types (checked checkboxes)
    const typeCheckboxes = document.querySelectorAll('.cleanup-type-filter:checked');
    const types = Array.from(typeCheckboxes).map(cb => parseInt(cb.value));

    // Date field (radio button)
    const dateFieldRadio = document.querySelector('input[name="cleanupDateField"]:checked');
    const dateField = dateFieldRadio?.value || 'last_advert';

    // Days of inactivity
    const days = parseInt(document.getElementById('cleanupDays')?.value) || 0;

    return {
        name_filter: nameFilter,
        types: types,
        date_field: dateField,
        days: days
    };
}

async function handleCleanupPreview() {
    const previewBtn = document.getElementById('cleanupPreviewBtn');
    if (!previewBtn) return;

    // Collect filter criteria
    const criteria = collectCleanupCriteria();

    // Validate: at least one type must be selected
    if (criteria.types.length === 0) {
        showToast('Please select at least one contact type', 'warning');
        return;
    }

    // Disable button during preview
    const originalHTML = previewBtn.innerHTML;
    previewBtn.disabled = true;
    previewBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Loading...';

    try {
        const response = await fetch('/api/contacts/preview-cleanup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(criteria)
        });

        const data = await response.json();

        if (data.success) {
            cleanupPreviewContacts = data.contacts || [];

            if (cleanupPreviewContacts.length === 0) {
                showToast('No contacts match the selected criteria', 'info');
                return;
            }

            // Populate modal with preview
            populateCleanupModal(cleanupPreviewContacts);

            // Show modal
            const modal = new bootstrap.Modal(document.getElementById('cleanupConfirmModal'));
            modal.show();
        } else {
            showToast('Preview failed: ' + (data.error || 'Unknown error'), 'danger');
        }
    } catch (error) {
        console.error('Error during cleanup preview:', error);
        showToast('Network error during preview', 'danger');
    } finally {
        // Re-enable button
        previewBtn.disabled = false;
        previewBtn.innerHTML = originalHTML;
    }
}

function populateCleanupModal(contacts) {
    /**
     * Populate cleanup confirmation modal with list of contacts.
     */
    const countEl = document.getElementById('cleanupContactCount');
    const listEl = document.getElementById('cleanupContactList');

    if (countEl) {
        countEl.textContent = contacts.length;
    }

    if (listEl) {
        listEl.innerHTML = '';

        contacts.forEach(contact => {
            const item = document.createElement('div');
            item.className = 'list-group-item';

            // Format last seen time
            const lastSeenTimestamp = contact.last_advert || 0;
            const lastSeenText = lastSeenTimestamp > 0 ? formatRelativeTime(lastSeenTimestamp) : 'Never';

            item.innerHTML = `
                <div class="d-flex justify-content-between align-items-start">
                    <div>
                        <strong>${escapeHtml(contact.name)}</strong>
                        <br>
                        <small class="text-muted">
                            Type: <span class="badge bg-secondary">${contact.type_label}</span>
                            | Last advert: ${lastSeenText}
                        </small>
                    </div>
                </div>
            `;

            listEl.appendChild(item);
        });
    }
}

function escapeHtml(text) {
    /**
     * Escape HTML special characters to prevent XSS.
     */
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

async function handleCleanupConfirm() {
    const confirmBtn = document.getElementById('confirmCleanupBtn');
    const modal = bootstrap.Modal.getInstance(document.getElementById('cleanupConfirmModal'));

    if (!confirmBtn) return;

    // Collect criteria again (in case user changed filters)
    const criteria = collectCleanupCriteria();

    // Disable button during cleanup
    const originalHTML = confirmBtn.innerHTML;
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Deleting...';

    try {
        const response = await fetch('/api/contacts/cleanup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(criteria)
        });

        const data = await response.json();

        if (data.success) {
            // Hide modal first
            if (modal) modal.hide();

            // Show success message
            let message = `Cleanup completed: ${data.deleted_count} deleted`;
            if (data.failed_count > 0) {
                message += `, ${data.failed_count} failed`;
            }

            showToast(message, data.failed_count > 0 ? 'warning' : 'success');

            // Show failures if any
            if (data.failures && data.failures.length > 0) {
                console.error('Cleanup failures:', data.failures);
                // Optionally show detailed failure list to user
            }

            // Reload contact counts
            loadContactCounts();

            // Clear preview
            cleanupPreviewContacts = [];
        } else {
            showToast('Cleanup failed: ' + (data.error || 'Unknown error'), 'danger');
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
        showToast('Network error during cleanup', 'danger');
    } finally {
        // Re-enable button
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = originalHTML;
    }
}

// =============================================================================
// Pending Page Initialization
// =============================================================================

function initPendingPage() {
    console.log('Initializing Pending page...');

    // Load saved type filter and set badges
    const savedTypes = loadPendingTypeFilter();
    setTypeFilterBadges(savedTypes);

    // Load pending contacts (will use filter from badges)
    loadPendingContacts();

    // Attach event listeners for pending page
    attachPendingEventListeners();
}

function attachPendingEventListeners() {
    // Refresh button
    const refreshBtn = document.getElementById('refreshPendingBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadPendingContacts();
        });
    }

    // Search input - filter on typing
    const searchInput = document.getElementById('pendingSearchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            applyPendingFilters();
        });
    }

    // Type filter badges - toggle on click, save to localStorage and reload
    ['typeFilterCLI', 'typeFilterREP', 'typeFilterROOM', 'typeFilterSENS'].forEach(id => {
        const badge = document.getElementById(id);
        if (badge) {
            badge.addEventListener('click', () => {
                // Toggle active state
                badge.classList.toggle('active');

                // Save selected types to localStorage
                const selectedTypes = getSelectedTypes();
                savePendingTypeFilter(selectedTypes);

                // Reload contacts from API with new filter
                loadPendingContacts();
            });
        }
    });

    // Add Filtered button - show batch approval modal
    const addFilteredBtn = document.getElementById('addFilteredBtn');
    if (addFilteredBtn) {
        addFilteredBtn.addEventListener('click', () => {
            showBatchApprovalModal();
        });
    }

    // Confirm Batch Approval button - approve all filtered contacts
    const confirmBatchBtn = document.getElementById('confirmBatchApprovalBtn');
    if (confirmBatchBtn) {
        confirmBatchBtn.addEventListener('click', () => {
            batchApproveContacts();
        });
    }
}

// =============================================================================
// Existing Page Initialization
// =============================================================================

function initExistingPage() {
    console.log('Initializing Existing page...');

    // Parse sort parameters from URL
    parseSortParamsFromURL();

    // Load protected contacts first, then load existing contacts
    loadProtectedContacts().then(() => {
        loadExistingContacts();
    });

    // Attach event listeners for existing page
    attachExistingEventListeners();
}

function attachExistingEventListeners() {
    // Refresh button
    const refreshBtn = document.getElementById('refreshExistingBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadExistingContacts();
        });
    }

    // Search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            applySortAndFilters();
        });
    }

    // Source filter (device / cache only)
    const sourceFilter = document.getElementById('sourceFilter');
    if (sourceFilter) {
        sourceFilter.addEventListener('change', () => {
            applySortAndFilters();
        });
    }

    // Type filter
    const typeFilter = document.getElementById('typeFilter');
    if (typeFilter) {
        typeFilter.addEventListener('change', () => {
            applySortAndFilters();
        });
    }

    // Sort dropdown
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            const lastUnderscore = sortSelect.value.lastIndexOf('_');
            sortBy = sortSelect.value.substring(0, lastUnderscore);
            sortOrder = sortSelect.value.substring(lastUnderscore + 1);
            updateURLWithSortParams();
            applySortAndFilters();
        });
    }

    // Delete confirmation button
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', () => {
            confirmDelete();
        });
    }
}

// =============================================================================
// Settings Management (shared)
// =============================================================================

async function loadSettings() {
    try {
        const response = await fetch('/api/device/settings');
        const data = await response.json();

        if (data.success) {
            manualApprovalEnabled = data.settings.manual_add_contacts || false;
            updateApprovalUI(manualApprovalEnabled);
        } else {
            console.error('Failed to load settings:', data.error);
            showToast('Failed to load settings', 'danger');
        }
    } catch (error) {
        console.error('Error loading settings:', error);
        showToast('Network error loading settings', 'danger');
    }
}

async function handleApprovalToggle(event) {
    const enabled = event.target.checked;

    try {
        const response = await fetch('/api/device/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                manual_add_contacts: enabled
            })
        });

        const data = await response.json();

        if (data.success) {
            manualApprovalEnabled = enabled;
            updateApprovalUI(enabled);
            showToast(
                enabled ? 'Manual approval enabled' : 'Manual approval disabled',
                'success'
            );
        } else {
            console.error('Failed to update setting:', data.error);
            showToast('Failed to update setting: ' + data.error, 'danger');

            // Revert toggle on failure
            event.target.checked = !enabled;
        }
    } catch (error) {
        console.error('Error updating setting:', error);
        showToast('Network error updating setting', 'danger');

        // Revert toggle on failure
        event.target.checked = !enabled;
    }
}

function updateApprovalUI(enabled) {
    const switchEl = document.getElementById('manualApprovalSwitch');
    const labelEl = document.getElementById('switchLabel');

    if (switchEl) {
        switchEl.checked = enabled;
    }

    if (labelEl) {
        labelEl.textContent = enabled
            ? 'Manual approval enabled'
            : 'Automatic approval (default)';
    }
}

// =============================================================================
// Protected Contacts Management
// =============================================================================

/**
 * Load protected contacts list from server.
 * Called on page load to populate local state.
 */
async function loadProtectedContacts() {
    try {
        const response = await fetch('/api/contacts/protected');
        const data = await response.json();

        if (data.success) {
            protectedContacts = data.protected_contacts || [];
            console.log('Loaded protected contacts:', protectedContacts.length);
        } else {
            console.error('Failed to load protected contacts:', data.error);
        }
    } catch (error) {
        console.error('Error loading protected contacts:', error);
    }
}

/**
 * Toggle protection status for a contact.
 * @param {string} publicKey - Full public key of contact
 * @param {HTMLElement} buttonEl - Button element for visual feedback
 */
async function toggleContactProtection(publicKey, buttonEl) {
    const originalHTML = buttonEl.innerHTML;
    buttonEl.disabled = true;
    buttonEl.innerHTML = '<i class="bi bi-hourglass-split"></i>';

    try {
        const response = await fetch(`/api/contacts/${encodeURIComponent(publicKey)}/protect`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const data = await response.json();

        if (data.success) {
            // Update local state
            const pkLower = publicKey.toLowerCase();
            if (data.protected) {
                if (!protectedContacts.includes(pkLower)) {
                    protectedContacts.push(pkLower);
                }
            } else {
                protectedContacts = protectedContacts.filter(pk => pk !== pkLower);
            }

            // Update UI
            updateProtectionUI(publicKey, data.protected, buttonEl);

            showToast(data.message, 'success');
        } else {
            showToast('Failed to update protection: ' + data.error, 'danger');
            buttonEl.innerHTML = originalHTML;
            buttonEl.disabled = false;
        }
    } catch (error) {
        console.error('Error toggling protection:', error);
        showToast('Network error', 'danger');
        buttonEl.innerHTML = originalHTML;
        buttonEl.disabled = false;
    }
}

/**
 * Update UI elements based on protection status.
 * @param {string} publicKey - Public key of contact
 * @param {boolean} isProtected - New protection status
 * @param {HTMLElement} buttonEl - Protect button element
 */
function updateProtectionUI(publicKey, isProtected, buttonEl) {
    const cardEl = buttonEl.closest('.existing-contact-card');

    // Update button appearance
    buttonEl.disabled = false;
    if (isProtected) {
        buttonEl.innerHTML = '<i class="bi bi-lock-fill"></i> Protected';
        buttonEl.classList.remove('btn-outline-warning');
        buttonEl.classList.add('btn-warning');
    } else {
        buttonEl.innerHTML = '<i class="bi bi-shield"></i> Protect';
        buttonEl.classList.remove('btn-warning');
        buttonEl.classList.add('btn-outline-warning');
    }

    // Update card lock indicator
    const nameDiv = cardEl.querySelector('.contact-name');
    let lockIcon = cardEl.querySelector('.protection-indicator');

    if (isProtected) {
        if (!lockIcon && nameDiv) {
            const indicator = document.createElement('span');
            indicator.className = 'protection-indicator ms-2';
            indicator.innerHTML = '<i class="bi bi-lock-fill text-warning" title="Protected contact"></i>';
            nameDiv.appendChild(indicator);
        }
    } else {
        if (lockIcon) lockIcon.remove();
    }

    // Enable/disable delete button
    const deleteBtn = cardEl.querySelector('.btn-outline-danger');
    if (deleteBtn) {
        deleteBtn.disabled = isProtected;
        deleteBtn.title = isProtected ? 'Cannot delete protected contact' : '';
    }
}

/**
 * Check if a contact is protected.
 * @param {string} publicKey - Public key to check
 * @returns {boolean} True if protected
 */
function isContactProtected(publicKey) {
    return protectedContacts.includes(publicKey.toLowerCase());
}

// =============================================================================
// Pending Type Filter (localStorage persistence)
// =============================================================================

/**
 * Save pending contacts type filter to localStorage.
 * This allows the filter to persist across page reloads and be used
 * in different parts of the app (Pending page, Contact Management badge, etc.)
 *
 * @param {Array<number>} types - Array of contact types to filter (1=CLI, 2=REP, 3=ROOM, 4=SENS)
 */
function savePendingTypeFilter(types) {
    try {
        localStorage.setItem('pendingContactsTypeFilter', JSON.stringify(types));
        console.log('Pending type filter saved:', types);
    } catch (e) {
        console.error('Failed to save pending type filter to localStorage:', e);
    }
}

/**
 * Load pending contacts type filter from localStorage.
 *
 * @returns {Array<number>} Array of contact types (default: [1] for CLI only)
 */
function loadPendingTypeFilter() {
    try {
        const stored = localStorage.getItem('pendingContactsTypeFilter');
        if (stored) {
            const types = JSON.parse(stored);
            // Validate: must be array of valid types
            if (Array.isArray(types) && types.every(t => [1, 2, 3, 4].includes(t))) {
                console.log('Pending type filter loaded:', types);
                return types;
            }
        }
    } catch (e) {
        console.error('Failed to load pending type filter from localStorage:', e);
    }
    // Default: CLI only (most common use case)
    return [1];
}

/**
 * Set type filter badges based on types array.
 * @param {Array<number>} types - Array of contact types (1=CLI, 2=REP, 3=ROOM, 4=SENS)
 */
function setTypeFilterBadges(types) {
    const badges = {
        1: document.getElementById('typeFilterCLI'),
        2: document.getElementById('typeFilterREP'),
        3: document.getElementById('typeFilterROOM'),
        4: document.getElementById('typeFilterSENS')
    };

    // Set badges based on types array
    for (const [type, badge] of Object.entries(badges)) {
        if (badge) {
            if (types.includes(parseInt(type))) {
                badge.classList.add('active');
            } else {
                badge.classList.remove('active');
            }
        }
    }
}

/**
 * Get currently selected contact types from badges.
 * @returns {Array<number>} Array of selected types
 */
function getSelectedTypes() {
    const types = [];
    if (document.getElementById('typeFilterCLI')?.classList.contains('active')) types.push(1);
    if (document.getElementById('typeFilterREP')?.classList.contains('active')) types.push(2);
    if (document.getElementById('typeFilterROOM')?.classList.contains('active')) types.push(3);
    if (document.getElementById('typeFilterSENS')?.classList.contains('active')) types.push(4);
    return types;
}

// =============================================================================
// Pending Contacts Management
// =============================================================================

async function loadPendingContacts() {
    const loadingEl = document.getElementById('pendingLoading');
    const emptyEl = document.getElementById('pendingEmpty');
    const listEl = document.getElementById('pendingList');
    const errorEl = document.getElementById('pendingError');
    const countBadge = document.getElementById('pendingCountBadge');

    // Show loading state
    if (loadingEl) loadingEl.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    if (listEl) listEl.innerHTML = '';
    if (errorEl) errorEl.style.display = 'none';
    if (countBadge) countBadge.style.display = 'none';

    try {
        // Get selected types from checkboxes
        const selectedTypes = getSelectedTypes();

        // Build query string with types parameter
        const params = new URLSearchParams();
        selectedTypes.forEach(type => params.append('types', type));

        const response = await fetch(`/api/contacts/pending?${params.toString()}`);
        const data = await response.json();

        if (loadingEl) loadingEl.style.display = 'none';

        if (data.success) {
            pendingContacts = data.pending || [];

            if (pendingContacts.length === 0) {
                // Show empty state
                if (emptyEl) emptyEl.style.display = 'block';
                if (countBadge) countBadge.style.display = 'none';

                // Reset filtered count badge when no contacts match type filter
                const filteredCountBadge = document.getElementById('filteredCountBadge');
                if (filteredCountBadge) filteredCountBadge.textContent = '0';
                filteredPendingContacts = [];
            } else {
                // Initialize filtered list and apply filters (default: CLI only)
                filteredPendingContacts = [...pendingContacts];
                applyPendingFilters();

                // Update count badge (in navbar)
                if (countBadge) {
                    countBadge.textContent = pendingContacts.length;
                    countBadge.style.display = 'inline-block';
                }
            }
        } else {
            console.error('Failed to load pending contacts:', data.error);
            if (errorEl) {
                const errorMsg = document.getElementById('pendingErrorMessage');
                if (errorMsg) errorMsg.textContent = data.error || 'Failed to load pending contacts';
                errorEl.style.display = 'block';
            }
        }
    } catch (error) {
        console.error('Error loading pending contacts:', error);
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            const errorMsg = document.getElementById('pendingErrorMessage');
            if (errorMsg) errorMsg.textContent = 'Network error: ' + error.message;
            errorEl.style.display = 'block';
        }
    }
}

function renderPendingList(contacts) {
    const listEl = document.getElementById('pendingList');
    if (!listEl) return;

    listEl.innerHTML = '';

    // Show "no filtered results" message if filters eliminate all contacts
    if (contacts.length === 0 && pendingContacts.length > 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.innerHTML = `
            <i class="bi bi-funnel"></i>
            <p class="mb-0">No contacts match filters</p>
            <small class="text-muted">Try changing your filter criteria</small>
        `;
        listEl.appendChild(emptyDiv);
        return;
    }

    contacts.forEach((contact, index) => {
        const card = createContactCard(contact, index);
        listEl.appendChild(card);
    });
}

function createContactCard(contact, index) {
    const card = document.createElement('div');
    card.className = 'pending-contact-card';
    card.id = `contact-${index}`;

    // Contact info row (name + type badge)
    const infoRow = document.createElement('div');
    infoRow.className = 'contact-info-row';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'contact-name flex-grow-1';
    nameDiv.textContent = contact.name;

    const typeBadge = document.createElement('span');
    typeBadge.className = 'badge type-badge';
    typeBadge.textContent = contact.type_label || 'CLI';

    // Color-code by type (same as existing contacts)
    switch (contact.type_label) {
        case 'CLI':
            typeBadge.classList.add('bg-primary');
            break;
        case 'REP':
            typeBadge.classList.add('bg-success');
            break;
        case 'ROOM':
            typeBadge.classList.add('bg-info');
            break;
        case 'SENS':
            typeBadge.classList.add('bg-warning', 'text-dark');
            break;
        default:
            typeBadge.classList.add('bg-secondary');
    }

    infoRow.appendChild(nameDiv);
    infoRow.appendChild(typeBadge);

    // Public key row (use prefix for display)
    const keyDiv = document.createElement('div');
    keyDiv.className = 'contact-key';
    keyDiv.textContent = contact.public_key_prefix || contact.public_key.substring(0, 12);
    keyDiv.title = 'Public Key Prefix';

    // Last advert (optional - show if available)
    let lastAdvertDiv = null;
    if (contact.last_advert) {
        lastAdvertDiv = document.createElement('div');
        lastAdvertDiv.className = 'text-muted small';
        const relativeTime = formatRelativeTime(contact.last_advert);
        lastAdvertDiv.textContent = `Last seen: ${relativeTime}`;
    }

    // Action buttons
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'd-flex gap-2 mt-2';

    // Approve button
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-sm btn-success';
    approveBtn.innerHTML = '<i class="bi bi-check-circle"></i> Approve';
    approveBtn.onclick = () => approveContact(contact, index);

    actionsDiv.appendChild(approveBtn);

    // Map button (only if GPS coordinates available)
    if (contact.adv_lat && contact.adv_lon && (contact.adv_lat !== 0 || contact.adv_lon !== 0)) {
        const mapBtn = document.createElement('button');
        mapBtn.className = 'btn btn-sm btn-outline-primary';
        mapBtn.innerHTML = '<i class="bi bi-geo-alt"></i> Map';
        mapBtn.onclick = () => window.showContactOnMap(contact.name, contact.adv_lat, contact.adv_lon);
        actionsDiv.appendChild(mapBtn);
    }

    // Copy key button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-sm btn-outline-secondary';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy Key';
    copyBtn.onclick = () => copyPublicKey(contact.public_key, copyBtn);

    actionsDiv.appendChild(copyBtn);

    // Assemble card
    card.appendChild(infoRow);
    card.appendChild(keyDiv);
    if (lastAdvertDiv) card.appendChild(lastAdvertDiv);
    card.appendChild(actionsDiv);

    return card;
}

async function approveContact(contact, index) {
    const cardEl = document.getElementById(`contact-${index}`);

    // Disable buttons during approval
    if (cardEl) {
        const buttons = cardEl.querySelectorAll('button');
        buttons.forEach(btn => btn.disabled = true);
    }

    try {
        const response = await fetch('/api/contacts/pending/approve', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                public_key: contact.public_key  // ALWAYS use full public_key (works for CLI, ROOM, etc.)
            })
        });

        const data = await response.json();

        if (data.success) {
            showToast(`Approved: ${contact.name}`, 'success');

            // Remove from list with animation
            if (cardEl) {
                cardEl.style.opacity = '0';
                cardEl.style.transition = 'opacity 0.3s';
                setTimeout(() => {
                    cardEl.remove();

                    // Reload pending list to update count
                    loadPendingContacts();
                }, 300);
            }
        } else {
            console.error('Failed to approve contact:', data.error);
            showToast('Failed to approve: ' + data.error, 'danger');

            // Re-enable buttons
            if (cardEl) {
                const buttons = cardEl.querySelectorAll('button');
                buttons.forEach(btn => btn.disabled = false);
            }
        }
    } catch (error) {
        console.error('Error approving contact:', error);
        showToast('Network error: ' + error.message, 'danger');

        // Re-enable buttons
        if (cardEl) {
            const buttons = cardEl.querySelectorAll('button');
            buttons.forEach(btn => btn.disabled = false);
        }
    }
}

function copyPublicKey(publicKey, buttonEl) {
    navigator.clipboard.writeText(publicKey).then(() => {
        // Visual feedback
        const originalHTML = buttonEl.innerHTML;
        buttonEl.innerHTML = '<i class="bi bi-check"></i> Copied!';
        buttonEl.classList.remove('btn-outline-secondary');
        buttonEl.classList.add('btn-success');

        setTimeout(() => {
            buttonEl.innerHTML = originalHTML;
            buttonEl.classList.remove('btn-success');
            buttonEl.classList.add('btn-outline-secondary');
        }, 2000);

        showToast('Public key copied to clipboard', 'info');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('Failed to copy to clipboard', 'danger');
    });
}

// =============================================================================
// Pending Page - Filtering and Batch Approval
// =============================================================================

function applyPendingFilters() {
    const searchInput = document.getElementById('pendingSearchInput');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

    // Apply search filter locally (type filter already applied by API)
    filteredPendingContacts = pendingContacts.filter(contact => {
        // Search filter (name or public_key_prefix)
        if (searchTerm) {
            const nameMatch = contact.name.toLowerCase().includes(searchTerm);
            const keyMatch = (contact.public_key_prefix || contact.public_key).toLowerCase().includes(searchTerm);
            return nameMatch || keyMatch;
        }

        return true;
    });

    // Update filtered count badge
    const countBadge = document.getElementById('filteredCountBadge');
    if (countBadge) {
        countBadge.textContent = filteredPendingContacts.length;
    }

    // Render filtered list
    renderPendingList(filteredPendingContacts);
}

function showBatchApprovalModal() {
    if (filteredPendingContacts.length === 0) {
        showToast('No contacts to approve', 'warning');
        return;
    }

    const modal = new bootstrap.Modal(document.getElementById('batchApprovalModal'));
    const countEl = document.getElementById('batchApprovalCount');
    const listEl = document.getElementById('batchApprovalList');

    // Update count
    if (countEl) countEl.textContent = filteredPendingContacts.length;

    // Populate list
    if (listEl) {
        listEl.innerHTML = '';
        filteredPendingContacts.forEach(contact => {
            const item = document.createElement('div');
            item.className = 'list-group-item d-flex justify-content-between align-items-center';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = contact.name;

            const typeBadge = document.createElement('span');
            typeBadge.className = 'badge';
            typeBadge.textContent = contact.type_label;

            switch (contact.type_label) {
                case 'CLI':
                    typeBadge.classList.add('bg-primary');
                    break;
                case 'REP':
                    typeBadge.classList.add('bg-success');
                    break;
                case 'ROOM':
                    typeBadge.classList.add('bg-info');
                    break;
                case 'SENS':
                    typeBadge.classList.add('bg-warning', 'text-dark');
                    break;
                default:
                    typeBadge.classList.add('bg-secondary');
            }

            item.appendChild(nameSpan);
            item.appendChild(typeBadge);
            listEl.appendChild(item);
        });
    }

    modal.show();
}

async function batchApproveContacts() {
    const modal = bootstrap.Modal.getInstance(document.getElementById('batchApprovalModal'));
    const confirmBtn = document.getElementById('confirmBatchApprovalBtn');

    if (confirmBtn) confirmBtn.disabled = true;

    let successCount = 0;
    let failedCount = 0;
    const failures = [];

    // Approve contacts one by one (sequential HTTP requests)
    for (let i = 0; i < filteredPendingContacts.length; i++) {
        const contact = filteredPendingContacts[i];

        // Update button with progress
        if (confirmBtn) {
            confirmBtn.innerHTML = `<i class="bi bi-hourglass-split"></i> Approving ${i + 1}/${filteredPendingContacts.length}...`;
        }

        try {
            const response = await fetch('/api/contacts/pending/approve', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    public_key: contact.public_key
                })
            });

            const data = await response.json();

            if (data.success) {
                successCount++;
            } else {
                failedCount++;
                failures.push({ name: contact.name, error: data.error });
            }
        } catch (error) {
            failedCount++;
            failures.push({ name: contact.name, error: error.message });
        }
    }

    // Close modal
    if (modal) modal.hide();

    // Show result
    if (successCount > 0 && failedCount === 0) {
        showToast(`Successfully approved ${successCount} contact${successCount !== 1 ? 's' : ''}`, 'success');
    } else if (successCount > 0 && failedCount > 0) {
        showToast(`Approved ${successCount}, failed ${failedCount}. Check console for details.`, 'warning');
        console.error('Failed approvals:', failures);
    } else {
        showToast(`Failed to approve contacts. Check console for details.`, 'danger');
        console.error('Failed approvals:', failures);
    }

    // Reload pending list
    loadPendingContacts();

    // Re-enable button
    if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="bi bi-check-circle-fill"></i> Approve All';
    }
}

// =============================================================================
// Toast Notifications
// =============================================================================

function showToast(message, type = 'info') {
    const toastEl = document.getElementById('contactToast');
    if (!toastEl) return;

    const bodyEl = toastEl.querySelector('.toast-body');
    if (!bodyEl) return;

    // Set message and style
    bodyEl.textContent = message;

    // Apply color based on type
    toastEl.classList.remove('bg-success', 'bg-danger', 'bg-info', 'bg-warning');
    toastEl.classList.remove('text-white');

    if (type === 'success' || type === 'danger' || type === 'warning') {
        toastEl.classList.add(`bg-${type}`, 'text-white');
    } else if (type === 'info') {
        toastEl.classList.add('bg-info', 'text-white');
    }

    // Show toast
    const toast = new bootstrap.Toast(toastEl, {
        autohide: true,
        delay: 1500
    });
    toast.show();
}

// =============================================================================
// Existing Contacts Management
// =============================================================================

async function loadExistingContacts() {
    const loadingEl = document.getElementById('existingLoading');
    const emptyEl = document.getElementById('existingEmpty');
    const listEl = document.getElementById('existingList');
    const errorEl = document.getElementById('existingError');

    // Show loading state
    if (loadingEl) loadingEl.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    if (listEl) listEl.innerHTML = '';
    if (errorEl) errorEl.style.display = 'none';

    try {
        // Fetch device contacts and cached contacts in parallel
        const [deviceResponse, cacheResponse] = await Promise.all([
            fetch('/api/contacts/detailed'),
            fetch('/api/contacts/cached?format=full')
        ]);
        const deviceData = await deviceResponse.json();
        const cacheData = await cacheResponse.json();

        if (loadingEl) loadingEl.style.display = 'none';

        if (deviceData.success) {
            const deviceContacts = deviceData.contacts || [];
            const cachedContacts = (cacheData.success && cacheData.contacts) ? cacheData.contacts : [];

            // Mark device contacts
            const deviceKeySet = new Set(deviceContacts.map(c => c.public_key));
            deviceContacts.forEach(c => { c.on_device = true; });

            // Add cache-only contacts (not on device)
            const cacheOnlyContacts = cachedContacts
                .filter(c => !deviceKeySet.has(c.public_key))
                .map(c => ({
                    name: c.name || 'Unknown',
                    public_key: c.public_key,
                    public_key_prefix: c.public_key_prefix || c.public_key.substring(0, 12),
                    type_label: '',
                    last_seen: c.last_seen || 0,
                    on_device: false,
                    source: c.source || 'cache'
                }));

            existingContacts = [...deviceContacts, ...cacheOnlyContacts];
            filteredContacts = [...existingContacts];

            // Update counter badge
            updateCounter(deviceData.count, deviceData.limit, cachedContacts.length);

            if (existingContacts.length === 0) {
                if (emptyEl) emptyEl.style.display = 'block';
            } else {
                applySortAndFilters();
            }
        } else {
            console.error('Failed to load existing contacts:', deviceData.error);
            if (errorEl) {
                const errorMsg = document.getElementById('existingErrorMessage');
                if (errorMsg) errorMsg.textContent = deviceData.error || 'Failed to load contacts';
                errorEl.style.display = 'block';
            }
        }
    } catch (error) {
        console.error('Error loading existing contacts:', error);
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            const errorMsg = document.getElementById('existingErrorMessage');
            if (errorMsg) errorMsg.textContent = 'Network error: ' + error.message;
            errorEl.style.display = 'block';
        }
    }
}

function updateCounter(count, limit, totalKnown) {
    const counterEl = document.getElementById('contactsCounter');
    if (!counterEl) return;

    let text = `${count} / ${limit}`;
    if (totalKnown && totalKnown > count) {
        text += ` (${totalKnown} known)`;
    }
    counterEl.textContent = text;
    counterEl.style.display = 'inline-block';

    // Remove all counter classes
    counterEl.classList.remove('counter-ok', 'counter-warning', 'counter-alarm');

    // Apply appropriate class based on count
    if (count >= 340) {
        counterEl.classList.add('counter-alarm');
    } else if (count >= 300) {
        counterEl.classList.add('counter-warning');
    } else {
        counterEl.classList.add('counter-ok');
    }
}

// =============================================================================
// Sorting Functionality (Existing Page)
// =============================================================================

function parseSortParamsFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    sortBy = urlParams.get('sort') || 'last_advert';
    sortOrder = urlParams.get('order') || 'desc';

    console.log('Parsed sort params:', { sortBy, sortOrder });

    // Update sort dropdown to reflect current sort
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) {
        sortSelect.value = `${sortBy}_${sortOrder}`;
    }
}

function updateURLWithSortParams() {
    const url = new URL(window.location);
    url.searchParams.set('sort', sortBy);
    url.searchParams.set('order', sortOrder);
    window.history.replaceState({}, '', url);
}

function applySortAndFilters() {
    const searchInput = document.getElementById('searchInput');
    const typeFilter = document.getElementById('typeFilter');
    const sourceFilter = document.getElementById('sourceFilter');

    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const selectedType = typeFilter ? typeFilter.value : 'ALL';
    const selectedSource = sourceFilter ? sourceFilter.value : 'ALL';

    // First, filter contacts
    filteredContacts = existingContacts.filter(contact => {
        // Source filter
        if (selectedSource === 'DEVICE' && !contact.on_device) return false;
        if (selectedSource === 'CACHE' && contact.on_device) return false;

        // Type filter (cache-only contacts have no type_label)
        if (selectedType !== 'ALL') {
            if (!contact.type_label || contact.type_label !== selectedType) {
                return false;
            }
        }

        // Search filter (name or public_key_prefix)
        if (searchTerm) {
            const nameMatch = contact.name.toLowerCase().includes(searchTerm);
            const keyMatch = (contact.public_key_prefix || '').toLowerCase().includes(searchTerm);
            return nameMatch || keyMatch;
        }

        return true;
    });

    // Then, sort filtered contacts
    filteredContacts.sort((a, b) => {
        if (sortBy === 'name') {
            const comparison = a.name.localeCompare(b.name);
            return sortOrder === 'asc' ? comparison : -comparison;
        } else if (sortBy === 'last_advert') {
            const aTime = a.last_seen || 0;
            const bTime = b.last_seen || 0;
            return sortOrder === 'desc' ? bTime - aTime : aTime - bTime;
        }
        return 0;
    });

    // Render sorted and filtered contacts
    renderExistingList(filteredContacts);
}

function renderExistingList(contacts) {
    const listEl = document.getElementById('existingList');
    const emptyEl = document.getElementById('existingEmpty');

    if (!listEl) return;

    listEl.innerHTML = '';

    if (contacts.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    contacts.forEach((contact, index) => {
        const card = createExistingContactCard(contact, index);
        listEl.appendChild(card);
    });
}

/**
 * Format Unix timestamp as relative time ("5 minutes ago", "2 hours ago", etc.)
 */
function formatRelativeTime(timestamp) {
    if (!timestamp) return 'Never';

    const now = Math.floor(Date.now() / 1000); // Current time in Unix seconds
    const diffSeconds = now - timestamp;

    if (diffSeconds < 0) return 'Just now'; // Future timestamp (clock skew)

    // Less than 1 minute
    if (diffSeconds < 60) {
        return 'Just now';
    }

    // Less than 1 hour
    if (diffSeconds < 3600) {
        const minutes = Math.floor(diffSeconds / 60);
        return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    }

    // Less than 1 day
    if (diffSeconds < 86400) {
        const hours = Math.floor(diffSeconds / 3600);
        return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    }

    // Less than 30 days
    if (diffSeconds < 2592000) {
        const days = Math.floor(diffSeconds / 86400);
        return `${days} day${days !== 1 ? 's' : ''} ago`;
    }

    // Less than 1 year
    if (diffSeconds < 31536000) {
        const months = Math.floor(diffSeconds / 2592000);
        return `${months} month${months !== 1 ? 's' : ''} ago`;
    }

    // More than 1 year
    const years = Math.floor(diffSeconds / 31536000);
    return `${years} year${years !== 1 ? 's' : ''} ago`;
}

/**
 * Get activity status indicator based on last_advert timestamp
 * Returns: { icon: string, color: string, title: string }
 */
function getActivityStatus(timestamp) {
    if (!timestamp) {
        return {
            icon: '⚫',
            color: '#6c757d',
            title: 'Never seen'
        };
    }

    const now = Math.floor(Date.now() / 1000);
    const diffSeconds = now - timestamp;

    // Active (< 5 minutes)
    if (diffSeconds < 300) {
        return {
            icon: '🟢',
            color: '#28a745',
            title: 'Active (advert received recently)'
        };
    }

    // Recent (< 1 hour)
    if (diffSeconds < 3600) {
        return {
            icon: '🟡',
            color: '#ffc107',
            title: 'Recent activity'
        };
    }

    // Inactive (> 1 hour)
    return {
        icon: '🔴',
        color: '#dc3545',
        title: 'Inactive'
    };
}

function createExistingContactCard(contact, index) {
    const card = document.createElement('div');
    card.className = 'existing-contact-card';
    card.id = `existing-contact-${index}`;

    // Check if contact is protected
    const isProtected = contact.is_protected || isContactProtected(contact.public_key);

    // Contact info row (name + type badge)
    const infoRow = document.createElement('div');
    infoRow.className = 'contact-info-row';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'contact-name flex-grow-1';
    nameDiv.textContent = contact.name;

    // Add protection indicator if protected
    if (isProtected) {
        const lockIndicator = document.createElement('span');
        lockIndicator.className = 'protection-indicator ms-2';
        lockIndicator.innerHTML = '<i class="bi bi-lock-fill text-warning" title="Protected contact"></i>';
        nameDiv.appendChild(lockIndicator);
    }

    // Type badge (or "Cache only" badge for non-device contacts)
    if (contact.on_device === false) {
        const cacheBadge = document.createElement('span');
        cacheBadge.className = 'badge type-badge bg-secondary';
        cacheBadge.textContent = 'Cache';
        cacheBadge.title = 'Not on device - known from adverts';
        infoRow.appendChild(nameDiv);
        infoRow.appendChild(cacheBadge);
    } else {
        const typeBadge = document.createElement('span');
        typeBadge.className = 'badge type-badge';
        typeBadge.textContent = contact.type_label;

        // Color-code by type
        switch (contact.type_label) {
            case 'CLI':
                typeBadge.classList.add('bg-primary');
                break;
            case 'REP':
                typeBadge.classList.add('bg-success');
                break;
            case 'ROOM':
                typeBadge.classList.add('bg-info');
                break;
            case 'SENS':
                typeBadge.classList.add('bg-warning');
                break;
            default:
                typeBadge.classList.add('bg-secondary');
        }

        infoRow.appendChild(nameDiv);
        infoRow.appendChild(typeBadge);
    }

    // Public key row (clickable to copy)
    const keyDiv = document.createElement('div');
    keyDiv.className = 'contact-key clickable-key';
    keyDiv.textContent = contact.public_key_prefix;
    keyDiv.title = 'Click to copy';
    keyDiv.onclick = () => copyToClipboard(contact.public_key_prefix, keyDiv);

    // Last advert row (with activity status indicator)
    const lastAdvertDiv = document.createElement('div');
    lastAdvertDiv.className = 'text-muted small d-flex align-items-center gap-1';
    lastAdvertDiv.style.marginBottom = '0.25rem';

    if (contact.last_seen) {
        const status = getActivityStatus(contact.last_seen);
        const relativeTime = formatRelativeTime(contact.last_seen);

        const statusIcon = document.createElement('span');
        statusIcon.textContent = status.icon;
        statusIcon.style.fontSize = '0.9rem';
        statusIcon.title = status.title;

        const timeText = document.createElement('span');
        timeText.textContent = `Last advert: ${relativeTime}`;

        lastAdvertDiv.appendChild(statusIcon);
        lastAdvertDiv.appendChild(timeText);
    } else {
        // No last_seen data available
        const statusIcon = document.createElement('span');
        statusIcon.textContent = '⚫';
        statusIcon.style.fontSize = '0.9rem';

        const timeText = document.createElement('span');
        timeText.textContent = 'Last advert: Unknown';

        lastAdvertDiv.appendChild(statusIcon);
        lastAdvertDiv.appendChild(timeText);
    }

    // Path/mode (optional)
    let pathDiv = null;
    if (contact.path_or_mode && contact.path_or_mode !== 'Flood') {
        pathDiv = document.createElement('div');
        pathDiv.className = 'text-muted small';
        pathDiv.textContent = `Path: ${contact.path_or_mode}`;
    }

    // Action buttons (only for device contacts)
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'd-flex gap-2 mt-2';

    if (contact.on_device !== false) {
        // Map button (only if GPS coordinates available)
        if (contact.adv_lat && contact.adv_lon && (contact.adv_lat !== 0 || contact.adv_lon !== 0)) {
            const mapBtn = document.createElement('button');
            mapBtn.className = 'btn btn-sm btn-outline-primary';
            mapBtn.innerHTML = '<i class="bi bi-geo-alt"></i> Map';
            mapBtn.onclick = () => window.showContactOnMap(contact.name, contact.adv_lat, contact.adv_lon);
            actionsDiv.appendChild(mapBtn);
        }

        // Protect button
        const protectBtn = document.createElement('button');
        protectBtn.className = isProtected ? 'btn btn-sm btn-warning' : 'btn btn-sm btn-outline-warning';
        protectBtn.innerHTML = isProtected
            ? '<i class="bi bi-lock-fill"></i> Protected'
            : '<i class="bi bi-shield"></i> Protect';
        protectBtn.onclick = () => toggleContactProtection(contact.public_key, protectBtn);
        actionsDiv.appendChild(protectBtn);

        // Delete button (disabled if protected)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-sm btn-outline-danger';
        deleteBtn.innerHTML = '<i class="bi bi-trash"></i> Delete';
        deleteBtn.onclick = () => showDeleteModal(contact);
        deleteBtn.disabled = isProtected;
        if (isProtected) {
            deleteBtn.title = 'Cannot delete protected contact';
        }

        actionsDiv.appendChild(deleteBtn);
    }

    // Assemble card
    card.appendChild(infoRow);
    card.appendChild(keyDiv);
    card.appendChild(lastAdvertDiv);
    if (pathDiv) card.appendChild(pathDiv);
    card.appendChild(actionsDiv);

    return card;
}

/**
 * Copy text to clipboard with fallback for HTTP contexts.
 * @param {string} text - Text to copy
 * @param {HTMLElement} element - Element for visual feedback
 */
function copyToClipboard(text, element) {
    const originalText = element.textContent;

    // Try modern clipboard API first (requires HTTPS)
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showCopyFeedback(element, originalText);
        }).catch(() => {
            // Fallback to legacy method
            legacyCopy(text, element, originalText);
        });
    } else {
        // Fallback for HTTP contexts
        legacyCopy(text, element, originalText);
    }
}

/**
 * Legacy copy method using execCommand (works on HTTP).
 */
function legacyCopy(text, element, originalText) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();

    try {
        document.execCommand('copy');
        showCopyFeedback(element, originalText);
    } catch (err) {
        console.error('Failed to copy:', err);
        showToast('Failed to copy', 'danger');
    }

    document.body.removeChild(textArea);
}

/**
 * Show visual feedback after successful copy.
 */
function showCopyFeedback(element, originalText) {
    element.textContent = 'Copied!';
    element.classList.add('copied');

    setTimeout(() => {
        element.textContent = originalText;
        element.classList.remove('copied');
    }, 1500);

    showToast('Key copied to clipboard', 'info');
}

function showDeleteModal(contact) {
    contactToDelete = contact;

    // Set modal content
    const modalNameEl = document.getElementById('deleteContactName');
    const modalKeyEl = document.getElementById('deleteContactKey');

    if (modalNameEl) modalNameEl.textContent = contact.name;
    if (modalKeyEl) modalKeyEl.textContent = contact.public_key_prefix;

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('deleteContactModal'));
    modal.show();
}

async function confirmDelete() {
    if (!contactToDelete) return;

    const modal = bootstrap.Modal.getInstance(document.getElementById('deleteContactModal'));
    const confirmBtn = document.getElementById('confirmDeleteBtn');

    // Disable button during deletion
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<i class="bi bi-hourglass-split"></i> Deleting...';
    }

    try {
        // Use contact name for deletion (meshcli remove_contact only works with name)
        const selector = contactToDelete.name;

        const response = await fetch('/api/contacts/delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                selector: selector
            })
        });

        const data = await response.json();

        if (data.success) {
            showToast(`Deleted: ${contactToDelete.name}`, 'success');

            // Hide modal
            if (modal) modal.hide();

            // Reload contacts list
            setTimeout(() => loadExistingContacts(), 500);
        } else {
            console.error('Failed to delete contact:', data.error);
            showToast('Failed to delete: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error deleting contact:', error);
        showToast('Network error: ' + error.message, 'danger');
    } finally {
        // Re-enable button
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = '<i class="bi bi-trash"></i> Delete Contact';
        }
        contactToDelete = null;
    }
}
