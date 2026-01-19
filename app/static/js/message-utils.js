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

    // 2. Convert »quoted text« to styled quotes
    processed = processQuotes(processed);

    // 3. Convert URLs to links (and images to thumbnails)
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
 * Convert »quoted text« to styled quote blocks
 * @param {string} text - HTML-escaped text
 * @returns {string} - Text with styled quotes
 */
function processQuotes(text) {
    // Match »...« pattern (guillemets)
    const quotePattern = /»([^«]+)«/g;

    return text.replace(quotePattern, (_match, quoted) => {
        return `<span class="quote-text">»${quoted}«</span>`;
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

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeImageHandlers);
} else {
    // DOM already loaded
    initializeImageHandlers();
}
