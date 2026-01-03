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

// Sort state (for existing page)
let sortBy = 'last_advert'; // 'name' or 'last_advert'
let sortOrder = 'desc'; // 'asc' or 'desc'

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
}

async function loadContactCounts() {
    try {
        // Fetch pending count
        const pendingResp = await fetch('/api/contacts/pending');
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

    // Load pending contacts
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

    // Type filter checkboxes - filter on change
    ['typeFilterCLI', 'typeFilterREP', 'typeFilterROOM', 'typeFilterSENS'].forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                applyPendingFilters();
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

    // Load existing contacts
    loadExistingContacts();

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

    // Type filter
    const typeFilter = document.getElementById('typeFilter');
    if (typeFilter) {
        typeFilter.addEventListener('change', () => {
            applySortAndFilters();
        });
    }

    // Sort buttons
    const sortByName = document.getElementById('sortByName');
    if (sortByName) {
        sortByName.addEventListener('click', () => {
            handleSortChange('name');
        });
    }

    const sortByLastAdvert = document.getElementById('sortByLastAdvert');
    if (sortByLastAdvert) {
        sortByLastAdvert.addEventListener('click', () => {
            handleSortChange('last_advert');
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
        const response = await fetch('/api/contacts/pending');
        const data = await response.json();

        if (loadingEl) loadingEl.style.display = 'none';

        if (data.success) {
            pendingContacts = data.pending || [];

            if (pendingContacts.length === 0) {
                // Show empty state
                if (emptyEl) emptyEl.style.display = 'block';
                if (countBadge) countBadge.style.display = 'none';
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
    actionsDiv.className = 'd-flex gap-2 flex-wrap mt-2';

    // Approve button
    const approveBtn = document.createElement('button');
    approveBtn.className = 'btn btn-success btn-action flex-grow-1';
    approveBtn.innerHTML = '<i class="bi bi-check-circle"></i> Approve';
    approveBtn.onclick = () => approveContact(contact, index);

    actionsDiv.appendChild(approveBtn);

    // Map button (only if GPS coordinates available)
    if (contact.adv_lat && contact.adv_lon && (contact.adv_lat !== 0 || contact.adv_lon !== 0)) {
        const mapBtn = document.createElement('button');
        mapBtn.className = 'btn btn-outline-primary btn-action';
        mapBtn.innerHTML = '<i class="bi bi-geo-alt"></i> Map';
        mapBtn.onclick = () => openGoogleMaps(contact.adv_lat, contact.adv_lon);
        actionsDiv.appendChild(mapBtn);
    }

    // Copy key button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-outline-secondary btn-action';
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

    // Get selected types
    const selectedTypes = [];
    if (document.getElementById('typeFilterCLI')?.checked) selectedTypes.push('CLI');
    if (document.getElementById('typeFilterREP')?.checked) selectedTypes.push('REP');
    if (document.getElementById('typeFilterROOM')?.checked) selectedTypes.push('ROOM');
    if (document.getElementById('typeFilterSENS')?.checked) selectedTypes.push('SENS');

    // Filter contacts
    filteredPendingContacts = pendingContacts.filter(contact => {
        // Type filter
        if (selectedTypes.length > 0 && !selectedTypes.includes(contact.type_label)) {
            return false;
        }

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
    const counterEl = document.getElementById('contactsCounter');

    // Show loading state
    if (loadingEl) loadingEl.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    if (listEl) listEl.innerHTML = '';
    if (errorEl) errorEl.style.display = 'none';

    try {
        const response = await fetch('/api/contacts/detailed');
        const data = await response.json();

        if (loadingEl) loadingEl.style.display = 'none';

        if (data.success) {
            existingContacts = data.contacts || [];
            filteredContacts = [...existingContacts];

            // Update counter badge (in navbar)
            updateCounter(data.count, data.limit);

            if (existingContacts.length === 0) {
                // Show empty state
                if (emptyEl) emptyEl.style.display = 'block';
            } else {
                // Apply filters and sort
                applySortAndFilters();
            }
        } else {
            console.error('Failed to load existing contacts:', data.error);
            if (errorEl) {
                const errorMsg = document.getElementById('existingErrorMessage');
                if (errorMsg) errorMsg.textContent = data.error || 'Failed to load contacts';
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

function updateCounter(count, limit) {
    const counterEl = document.getElementById('contactsCounter');
    if (!counterEl) return;

    counterEl.textContent = `${count} / ${limit}`;
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

    // Update UI to reflect current sort
    updateSortUI();
}

function handleSortChange(newSortBy) {
    if (sortBy === newSortBy) {
        // Toggle order
        sortOrder = sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        // Change sort field
        sortBy = newSortBy;
        // Set default order for new field
        sortOrder = newSortBy === 'name' ? 'asc' : 'desc';
    }

    console.log('Sort changed to:', { sortBy, sortOrder });

    // Update URL parameters
    updateURLWithSortParams();

    // Update UI
    updateSortUI();

    // Re-apply filters and sort
    applySortAndFilters();
}

function updateURLWithSortParams() {
    const url = new URL(window.location);
    url.searchParams.set('sort', sortBy);
    url.searchParams.set('order', sortOrder);
    window.history.replaceState({}, '', url);
}

function updateSortUI() {
    // Update sort button active states and icons
    const sortButtons = document.querySelectorAll('.sort-btn');

    sortButtons.forEach(btn => {
        const btnSort = btn.dataset.sort;
        const icon = btn.querySelector('i');

        if (btnSort === sortBy) {
            // Active button
            btn.classList.add('active');
            if (icon) {
                icon.className = sortOrder === 'asc' ? 'bi bi-sort-up' : 'bi bi-sort-down';
            }
        } else {
            // Inactive button
            btn.classList.remove('active');
            if (icon) {
                icon.className = 'bi bi-sort-down'; // Default icon
            }
        }
    });
}

function applySortAndFilters() {
    const searchInput = document.getElementById('searchInput');
    const typeFilter = document.getElementById('typeFilter');

    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
    const selectedType = typeFilter ? typeFilter.value : 'ALL';

    // First, filter contacts
    filteredContacts = existingContacts.filter(contact => {
        // Type filter
        if (selectedType !== 'ALL' && contact.type_label !== selectedType) {
            return false;
        }

        // Search filter (name or public_key_prefix)
        if (searchTerm) {
            const nameMatch = contact.name.toLowerCase().includes(searchTerm);
            const keyMatch = contact.public_key_prefix.toLowerCase().includes(searchTerm);
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

    // Contact info row (name + type badge)
    const infoRow = document.createElement('div');
    infoRow.className = 'contact-info-row';

    const nameDiv = document.createElement('div');
    nameDiv.className = 'contact-name flex-grow-1';
    nameDiv.textContent = contact.name;

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

    // Public key row
    const keyDiv = document.createElement('div');
    keyDiv.className = 'contact-key';
    keyDiv.textContent = contact.public_key_prefix;
    keyDiv.title = 'Public Key Prefix';

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

    // Action buttons
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'd-flex gap-2 mt-2';

    // Copy key button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-sm btn-outline-secondary';
    copyBtn.innerHTML = '<i class="bi bi-clipboard"></i> Copy Key';
    copyBtn.onclick = () => copyContactKey(contact.public_key_prefix, copyBtn);

    actionsDiv.appendChild(copyBtn);

    // Map button (only if GPS coordinates available)
    if (contact.adv_lat && contact.adv_lon && (contact.adv_lat !== 0 || contact.adv_lon !== 0)) {
        const mapBtn = document.createElement('button');
        mapBtn.className = 'btn btn-sm btn-outline-primary';
        mapBtn.innerHTML = '<i class="bi bi-geo-alt"></i> Map';
        mapBtn.onclick = () => openGoogleMaps(contact.adv_lat, contact.adv_lon);
        actionsDiv.appendChild(mapBtn);
    }

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-sm btn-outline-danger';
    deleteBtn.innerHTML = '<i class="bi bi-trash"></i> Delete';
    deleteBtn.onclick = () => showDeleteModal(contact);

    actionsDiv.appendChild(deleteBtn);

    // Assemble card
    card.appendChild(infoRow);
    card.appendChild(keyDiv);
    card.appendChild(lastAdvertDiv);
    if (pathDiv) card.appendChild(pathDiv);
    card.appendChild(actionsDiv);

    return card;
}

function copyContactKey(publicKeyPrefix, buttonEl) {
    navigator.clipboard.writeText(publicKeyPrefix).then(() => {
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

        showToast('Key copied to clipboard', 'info');
    }).catch(err => {
        console.error('Failed to copy:', err);
        showToast('Failed to copy to clipboard', 'danger');
    });
}

function openGoogleMaps(lat, lon) {
    // Create Google Maps URL with coordinates
    const mapsUrl = `https://www.google.com/maps?q=${lat},${lon}`;

    // Open in new tab
    window.open(mapsUrl, '_blank');
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
