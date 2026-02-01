/**
 * Chat Filter Utilities
 * Handles message filtering with diacritic-insensitive search and text highlighting
 */

/**
 * Diacritic normalization map for Polish and common accented characters
 * Maps accented characters to their base forms
 */
const DIACRITIC_MAP = {
    'ą': 'a', 'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a',
    'ć': 'c', 'č': 'c', 'ç': 'c',
    'ę': 'e', 'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
    'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
    'ł': 'l',
    'ń': 'n', 'ñ': 'n',
    'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o', 'ő': 'o', 'ø': 'o',
    'ś': 's', 'š': 's', 'ß': 'ss',
    'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ű': 'u',
    'ý': 'y', 'ÿ': 'y',
    'ź': 'z', 'ż': 'z', 'ž': 'z'
};

/**
 * Normalize text by removing diacritics and converting to lowercase
 * @param {string} text - Text to normalize
 * @returns {string} - Normalized text
 */
function normalizeText(text) {
    if (!text) return '';

    let normalized = text.toLowerCase();

    // Replace diacritics using map
    for (const [diacritic, base] of Object.entries(DIACRITIC_MAP)) {
        normalized = normalized.split(diacritic).join(base);
    }

    return normalized;
}

/**
 * Check if text matches search query (diacritic-insensitive, case-insensitive)
 * @param {string} text - Text to search in
 * @param {string} query - Search query
 * @returns {boolean} - True if text contains query
 */
function textMatches(text, query) {
    if (!query) return true;
    if (!text) return false;

    const normalizedText = normalizeText(text);
    const normalizedQuery = normalizeText(query);

    return normalizedText.includes(normalizedQuery);
}

/**
 * Find all match positions in original text for highlighting
 * Uses normalized comparison but returns positions in original text
 * @param {string} originalText - Original text
 * @param {string} query - Search query
 * @returns {Array<{start: number, end: number}>} - Array of match positions
 */
function findMatchPositions(originalText, query) {
    if (!query || !originalText) return [];

    const normalizedText = normalizeText(originalText);
    const normalizedQuery = normalizeText(query);
    const positions = [];

    let index = 0;
    while ((index = normalizedText.indexOf(normalizedQuery, index)) !== -1) {
        positions.push({
            start: index,
            end: index + normalizedQuery.length
        });
        index += 1;
    }

    return positions;
}

/**
 * Highlight matching text in HTML content
 * Preserves existing HTML structure while highlighting text nodes
 * @param {string} htmlContent - HTML content to highlight
 * @param {string} query - Search query
 * @returns {string} - HTML with highlighted matches
 */
function highlightMatches(htmlContent, query) {
    if (!query || !htmlContent) return htmlContent;

    // Create a temporary div to work with the DOM
    const temp = document.createElement('div');
    temp.innerHTML = htmlContent;

    // Process text nodes recursively
    highlightTextNodes(temp, query);

    return temp.innerHTML;
}

/**
 * Recursively highlight text in text nodes
 * @param {Node} node - DOM node to process
 * @param {string} query - Search query
 */
function highlightTextNodes(node, query) {
    if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        const positions = findMatchPositions(text, query);

        if (positions.length > 0) {
            // Create a document fragment with highlighted text
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;

            positions.forEach(pos => {
                // Add text before match
                if (pos.start > lastIndex) {
                    fragment.appendChild(
                        document.createTextNode(text.substring(lastIndex, pos.start))
                    );
                }

                // Add highlighted match
                const span = document.createElement('span');
                span.className = 'filter-highlight';
                span.textContent = text.substring(pos.start, pos.end);
                fragment.appendChild(span);

                lastIndex = pos.end;
            });

            // Add remaining text
            if (lastIndex < text.length) {
                fragment.appendChild(
                    document.createTextNode(text.substring(lastIndex))
                );
            }

            // Replace the text node with the fragment
            node.parentNode.replaceChild(fragment, node);
        }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Skip certain elements that shouldn't be highlighted
        const skipTags = ['SCRIPT', 'STYLE', 'BUTTON', 'INPUT', 'TEXTAREA'];
        if (!skipTags.includes(node.tagName)) {
            // Process child nodes (copy to array first since we may modify)
            const children = Array.from(node.childNodes);
            children.forEach(child => highlightTextNodes(child, query));
        }
    }
}

/**
 * Get plain text content from a message element
 * @param {HTMLElement} messageEl - Message element
 * @param {string} contentSelector - CSS selector for content element
 * @returns {string} - Plain text content
 */
function getMessageText(messageEl, contentSelector) {
    const contentEl = messageEl.querySelector(contentSelector);
    return contentEl ? contentEl.textContent : '';
}

// Export functions for use in other modules
window.FilterUtils = {
    normalizeText,
    textMatches,
    findMatchPositions,
    highlightMatches,
    highlightTextNodes,
    getMessageText
};
