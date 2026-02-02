/**
 * Message Content Processing Utilities
 * Handles mention badges, URL links, and image previews
 */

/**
 * Process message content to handle mentions, URLs, and images
 * @param {string} content - Raw message content
 * @returns {string} - Processed HTML content
 */
function processMessageContent(content) {
    if (!content) return '';

    // First escape HTML to prevent XSS
    let processed = escapeHtml(content);

    // Process in order:
    // 1. Convert @[Username] mentions to badges
    processed = processMentions(processed);

    // 2. Convert #channel to clickable links (only in channel context)
    processed = processChannelLinks(processed);

    // 3. Convert »quoted text« to styled quotes
    processed = processQuotes(processed);

    // 4. Convert URLs to links (and images to thumbnails)
    processed = processUrls(processed);

    return processed;
}

/**
 * Convert @[Username] mentions to styled badges
 * @param {string} text - HTML-escaped text
 * @returns {string} - Text with mention badges
 */
function processMentions(text) {
    // Match @[Username] pattern
    // Note: text is already HTML-escaped, so we match escaped brackets
    const mentionPattern = /@\[([^\]]+)\]/g;

    return text.replace(mentionPattern, (_match, username) => {
        // Create badge similar to Android Meshcore app
        return `<span class="mention-badge">@${username}</span>`;
    });
}

/**
 * Convert #channelname to clickable channel links
 * Only active in channel context (when availableChannels exists)
 * @param {string} text - HTML-escaped text
 * @returns {string} - Text with channel links
 */
function processChannelLinks(text) {
    // Only process in channel context (app.js provides availableChannels)
    // In DM context (dm.js), availableChannels is undefined
    if (typeof availableChannels === 'undefined') {
        return text;
    }

    // Match #channelname pattern
    // Valid: alphanumeric, underscore, hyphen
    // Must be at least 2 characters after #
    // Must be preceded by whitespace, start of string, or punctuation
    const channelPattern = /(^|[\s.,!?:;()\[\]])#([a-zA-Z0-9_-]{2,})/g;

    return text.replace(channelPattern, (_match, prefix, channelName) => {
        const escapedName = escapeHtmlAttribute(channelName);
        return `${prefix}<a href="#" class="channel-link" data-channel-name="${escapedName}">#${channelName}</a>`;
    });
}

/**
 * Convert »quoted text« to styled quote blocks
 * @param {string} text - HTML-escaped text
 * @returns {string} - Text with styled quotes
 */
function processQuotes(text) {
    // Match »...« pattern (guillemets)
    const quotePattern = /»([^«]+)«/g;

    return text.replace(quotePattern, (_match, quoted) => {
        // Display without guillemets (styling is enough) + line break after
        return `<span class="quote-text">${quoted}</span><br>`;
    });
}

/**
 * Convert URLs to clickable links and images to thumbnails
 * @param {string} text - HTML-escaped text
 * @returns {string} - Text with links and image thumbnails
 */
function processUrls(text) {
    // URL regex pattern (handles http:// and https://)
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/g;

    return text.replace(urlPattern, (url) => {
        // Check if URL is an image
        if (isImageUrl(url)) {
            return createImageThumbnail(url);
        } else {
            return createLink(url);
        }
    });
}

/**
 * Check if URL points to an image
 * @param {string} url - URL to check
 * @returns {boolean} - True if URL is an image
 */
function isImageUrl(url) {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const urlLower = url.toLowerCase();
    return imageExtensions.some(ext => urlLower.endsWith(ext));
}

/**
 * Create a clickable link
 * @param {string} url - URL to link to
 * @returns {string} - HTML link element
 */
function createLink(url) {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="message-link">${url}</a>`;
}

/**
 * Create an image thumbnail with click-to-expand
 * @param {string} url - Image URL
 * @returns {string} - HTML image thumbnail
 */
function createImageThumbnail(url) {
    // Escape URL for use in HTML attributes
    const escapedUrl = escapeHtmlAttribute(url);

    return `<div class="message-image-container"><img src="${escapedUrl}" alt="Image" class="message-image-thumbnail" data-image-url="${escapedUrl}" loading="lazy" onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100\\' height=\\'100\\'%3E%3Crect fill=\\'%23ddd\\' width=\\'100\\' height=\\'100\\'/%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' dominant-baseline=\\'middle\\' text-anchor=\\'middle\\' fill=\\'%23999\\'%3EError%3C/text%3E%3C/svg%3E';"><div class="message-image-url"><a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="message-link">${url}</a></div></div>`;
}

/**
 * Show image in modal
 * @param {string} url - Image URL to display
 */
function showImageModal(url) {
    // Create modal if it doesn't exist
    let modal = document.getElementById('imagePreviewModal');

    if (!modal) {
        modal = createImageModal();
        document.body.appendChild(modal);
    }

    // Set image source
    const img = modal.querySelector('#imagePreviewImg');
    if (img) {
        img.src = url;
    }

    // Show modal using Bootstrap
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
}

/**
 * Create image preview modal element
 * @returns {HTMLElement} - Modal element
 */
function createImageModal() {
    const modal = document.createElement('div');
    modal.id = 'imagePreviewModal';
    modal.className = 'modal fade';
    modal.tabIndex = -1;
    modal.setAttribute('aria-labelledby', 'imagePreviewModalLabel');
    modal.setAttribute('aria-hidden', 'true');

    modal.innerHTML = `
        <div class="modal-dialog modal-dialog-centered modal-xl">
            <div class="modal-content bg-dark">
                <div class="modal-header border-0">
                    <h5 class="modal-title text-white" id="imagePreviewModalLabel">Image Preview</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body text-center p-0">
                    <img id="imagePreviewImg" src="" alt="Preview" class="img-fluid" style="max-height: 80vh; width: auto;">
                </div>
            </div>
        </div>
    `;

    return modal;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Escape HTML attribute to prevent XSS in attributes
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text safe for HTML attributes
 */
function escapeHtmlAttribute(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Initialize image click handlers using event delegation
 * This should be called after DOM content is loaded
 */
function initializeImageHandlers() {
    // Use event delegation on document to handle dynamically added images
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('message-image-thumbnail')) {
            const url = e.target.getAttribute('data-image-url');
            if (url) {
                showImageModal(url);
            }
        }
    });
}

/**
 * Handle channel link click - switch to or join channel
 * @param {string} channelName - Channel name without # prefix
 */
async function handleChannelLinkClick(channelName) {
    // Normalize name (add # if not present for comparison)
    const normalizedName = channelName.startsWith('#') ? channelName : '#' + channelName;

    // Check if channel exists in availableChannels
    const existingChannel = availableChannels.find(
        ch => ch.name.toLowerCase() === normalizedName.toLowerCase()
    );

    if (existingChannel) {
        switchToChannel(existingChannel.index, existingChannel.name);
    } else {
        await joinAndSwitchToChannel(normalizedName);
    }
}

/**
 * Switch to an existing channel via the channel selector
 * @param {number} channelIdx - Channel index
 * @param {string} channelName - Channel name for notification
 */
function switchToChannel(channelIdx, channelName) {
    const selector = document.getElementById('channelSelector');
    if (selector) {
        selector.value = channelIdx;
        // Trigger change event to update state and load messages
        selector.dispatchEvent(new Event('change'));
    }
}

/**
 * Join a channel via API when clicking channel link, then switch to it
 * @param {string} channelName - Channel name (with #)
 */
async function joinAndSwitchToChannel(channelName) {
    try {
        const response = await fetch('/api/channels/join', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name: channelName })
        });

        const data = await response.json();

        if (data.success) {
            showNotification(`Joined channel "${channelName}"!`, 'success');

            // Show warning if applicable (e.g., exceeding channel limit)
            if (data.warning) {
                setTimeout(() => {
                    showNotification(data.warning, 'warning');
                }, 2000);
            }

            // Reload channels and switch to new channel
            await loadChannels();
            switchToChannel(data.channel.index, channelName);
        } else {
            showNotification('Failed to join channel: ' + data.error, 'danger');
        }
    } catch (error) {
        console.error('Error joining channel via link:', error);
        showNotification('Failed to join channel', 'danger');
    }
}

/**
 * Initialize channel link click handlers using event delegation
 */
function initializeChannelLinkHandlers() {
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('channel-link')) {
            e.preventDefault();

            const channelName = e.target.getAttribute('data-channel-name');
            if (channelName) {
                // Add loading state
                e.target.classList.add('loading');

                handleChannelLinkClick(channelName).finally(() => {
                    e.target.classList.remove('loading');
                });
            }
        }
    });
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        initializeImageHandlers();
        initializeChannelLinkHandlers();
    });
} else {
    // DOM already loaded
    initializeImageHandlers();
    initializeChannelLinkHandlers();
}
