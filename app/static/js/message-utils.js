/**
 * Message Content Processing Utilities
 * Handles mention badges, URL links, and image previews
 */

/**
 * Detect whether the primary input is touch-based (phones/tablets), as opposed
 * to a device with a precise pointer (mouse/trackpad). Used to decide whether
 * Enter should send a message or just insert a newline.
 * @returns {boolean}
 */
function isTouchPrimaryDevice() {
    return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Process message content to handle mentions, URLs, images and share cards
 * @param {string} content - Raw message content
 * @param {object} [options] - { isOwn: boolean } — whether we sent this message.
 *                             Only affects share cards (own ones get a "you
 *                             shared this" header instead of an action button).
 * @returns {string} - Processed HTML content
 */
function processMessageContent(content, options) {
    if (!content) return '';

    // Check if content (minus mentions) is emoji-only BEFORE any processing
    const emojiOnlyInfo = checkEmojiOnlyContent(content);

    // Lift share tokens out of the text BEFORE escaping. They cannot survive
    // the passes below: escaping turns the '&' of a channel URI into '&amp;',
    // processChannelLinks would eat a '#channel' name, processMentions an '@'
    // in a contact name, and processQuotes collides with the token's closing
    // '>'. Each token leaves behind a private-use-area placeholder that no
    // pattern here can match, and the finished card HTML is spliced back in
    // last — see restoreShareCards().
    const shareExtract = extractShareTokens(content, options);

    // First escape HTML to prevent XSS
    let processed = escapeHtml(shareExtract.text);

    // Process in order:
    // 1. Convert @[Username] mentions to badges
    processed = processMentions(processed);

    // 2. Convert #channel to clickable links (only in channel context)
    processed = processChannelLinks(processed);

    // 3. Convert »quoted text« to styled quotes
    processed = processQuotes(processed);

    // 4. Convert URLs to links (and images to thumbnails)
    processed = processUrls(processed);

    // 5. If emoji-only, enlarge the emoji
    if (emojiOnlyInfo.isEmojiOnly) {
        processed = enlargeEmoji(processed, emojiOnlyInfo.hasMention);
    }

    // 6. Swap the placeholders for the pre-built card markup. Last, because
    //    this output is trusted HTML and must not be escaped again.
    processed = restoreShareCards(processed, shareExtract.cards);

    return processed;
}

/**
 * Check if content is emoji-only (excluding @[mentions])
 * @param {string} text - Raw message content
 * @returns {object} - { isEmojiOnly: boolean, hasMention: boolean }
 */
function checkEmojiOnlyContent(text) {
    const hasMention = /@\[[^\]]+\]/.test(text);

    // Remove @[...] patterns
    const withoutMentions = text.replace(/@\[[^\]]+\]/g, '').trim();

    if (!withoutMentions) {
        return { isEmojiOnly: false, hasMention };
    }

    // Check if remaining is only emoji (using Unicode Extended_Pictographic)
    // Matches emoji, modifiers, skin tones, ZWJ sequences, variation selectors, and whitespace
    const emojiRegex = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Emoji_Component}\uFE0F\u200D\s]+$/u;
    const isEmojiOnly = emojiRegex.test(withoutMentions);

    return { isEmojiOnly, hasMention };
}

/**
 * Enlarge emoji in processed HTML
 * @param {string} html - Processed HTML with mention badges
 * @param {boolean} hasMention - Whether content has mentions
 * @returns {string} - HTML with enlarged emoji
 */
function enlargeEmoji(html, hasMention) {
    if (hasMention) {
        // Add line break after mention badge, then wrap emoji in large class
        // Pattern: closing </span> of mention badge, optional whitespace, then emoji
        html = html.replace(
            /(<\/span>)\s*([\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Emoji_Modifier_Base}\p{Emoji_Component}\uFE0F\u200D\s]+)$/u,
            '$1<br><span class="emoji-large">$2</span>'
        );
    } else {
        // Just wrap everything in large emoji class
        html = `<span class="emoji-large">${html}</span>`;
    }
    return html;
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
 * Convert quoted text to styled quote blocks. Two syntaxes are recognised:
 * `>quoted line` (current, also what other MeshCore clients use) and
 * `»quoted text«` (what mc-webui produced before 2.2.0 — still rendered so
 * older messages keep their styling).
 * @param {string} text - HTML-escaped text
 * @returns {string} - Text with styled quotes
 */
function processQuotes(text) {
    // Legacy guillemets: the markers are dropped (styling replaces them) and
    // the pattern eats the space separating quote from reply, hence the <br>.
    const legacyPattern = /»([^«]+)«\s*/g;
    text = text.replace(legacyPattern, (_match, quoted) => {
        return `<span class="quote-text">${quoted}</span><br>`;
    });

    // `>quoted line`. The text arrives HTML-escaped, so a typed '>' shows up as
    // '&gt;' and the '>' of generated tags can never match. Anchored to the
    // start of a line or to a leading @[mention] badge, so "5 &gt; 3" mid
    // sentence is left alone. The trailing newline stays in place — the message
    // containers are pre-wrap and render it as the break.
    const quotePattern = /(^|\n|<\/span>[ \t]*)&gt;[ \t]*([^\n]*)/g;

    return text.replace(quotePattern, (match, prefix, quoted) => {
        if (!quoted.trim()) return match;
        return `${prefix}<span class="quote-text">${quoted}</span>`;
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

    return `<div class="message-image-container"><img src="${escapedUrl}" alt="${tHtml('chat.image_alt')}" class="message-image-thumbnail" data-image-url="${escapedUrl}" loading="lazy" onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'100\\' height=\\'100\\'%3E%3Crect fill=\\'%23ddd\\' width=\\'100\\' height=\\'100\\'/%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' dominant-baseline=\\'middle\\' text-anchor=\\'middle\\' fill=\\'%23999\\'%3EError%3C/text%3E%3C/svg%3E';"><div class="message-image-url"><a href="${escapedUrl}" target="_blank" rel="noopener noreferrer" class="message-link">${url}</a></div></div>`;
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
                    <h5 class="modal-title text-white" id="imagePreviewModalLabel">${tHtml('chat.image_preview')}</h5>
                    <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="${tHtml('common.close')}"></button>
                </div>
                <div class="modal-body text-center p-0">
                    <img id="imagePreviewImg" src="" alt="${tHtml('chat.image_preview_alt')}" class="img-fluid" style="max-height: 80vh; width: auto;">
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
 * Serialize a value as a JS literal safe to splice into an inline event
 * handler attribute.
 *
 * JSON.stringify() alone is not enough. Its output is dropped straight into
 * markup, so a message containing an apostrophe closes the attribute early and
 * a following '<' ends the whole tag — the rest of the button then leaks into
 * the page as visible text (e.g. `title="Quote">` next to a broken icon), and
 * the handler never runs. Escaping both quote characters and the angle
 * brackets keeps the literal intact for the JS parser, which sees the
 * attribute value only after HTML entities are decoded.
 *
 * @param {*} value - Value to pass to the handler
 * @returns {string} - Escaped JSON literal, ready for an attribute
 */
function jsArg(value) {
    return escapeHtmlAttribute(JSON.stringify(value === undefined ? null : value));
}

/* =============================================================================
   Share Cards — contacts, channels and positions shared inside chat messages
   =============================================================================
   Wire formats and their parsing live in share-tokens.js (window.MCShare).
   This section turns a parsed token into card markup and handles the clicks.

   Pages plug in their own environment through window.MCShareHooks, because the
   two chats live in different documents: the channel chat is the top-level
   page, the DM chat is an iframe with no access to the parent's map modal or
   contact caches. Every hook is optional — without them a card still renders,
   it just falls back to the "not known yet" state, which is safe because the
   add endpoints are idempotent.
   ============================================================================= */

// Private-use-area sentinels. Chosen because no pass in processMessageContent
// can match them and escapeHtml() leaves them untouched.
const SHARE_PH_OPEN = '\uE000';
const SHARE_PH_CLOSE = '\uE001';
const SHARE_PH_RE = /\uE000(\d+)\uE001/g;

/** Bootstrap Icons per numeric contact type, plus the two non-contact kinds. */
const SHARE_TYPE_ICONS = {
    1: 'bi-person-fill',
    2: 'bi-broadcast',
    3: 'bi-door-open-fill',
    4: 'bi-thermometer-half'
};

/**
 * Replace every share token with a placeholder and pre-build its card.
 * @param {string} content - Raw, un-escaped message body
 * @param {object} [options] - { isOwn: boolean }
 * @returns {{text: string, cards: string[]}}
 */
function extractShareTokens(content, options) {
    if (typeof MCShare === 'undefined') return { text: content, cards: [] };

    const tokens = MCShare.parse(content);
    if (!tokens.length) return { text: content, cards: [] };

    const ctx = {
        isOwn: !!(options && options.isOwn),
        standalone: MCShare.isTokenOnly(content)
    };

    let text = '';
    let cursor = 0;
    const cards = [];

    tokens.forEach((token, i) => {
        text += content.slice(cursor, token.index);
        text += SHARE_PH_OPEN + i + SHARE_PH_CLOSE;
        cards.push(buildShareCard(token, ctx));
        cursor = token.index + token.length;
    });
    text += content.slice(cursor);

    return { text: text, cards: cards };
}

/**
 * Splice the finished card markup back over its placeholders.
 * @param {string} html - Fully processed (escaped) message HTML
 * @param {string[]} cards - Card markup, indexed by placeholder number
 * @returns {string}
 */
function restoreShareCards(html, cards) {
    if (!cards || !cards.length) return html;
    return html.replace(SHARE_PH_RE, (match, idx) => {
        const card = cards[parseInt(idx, 10)];
        return card === undefined ? match : card;
    });
}

/** Dispatch to the per-kind builder. */
function buildShareCard(token, ctx) {
    switch (token.kind) {
        case 'contact': return buildContactCard(token.data, ctx);
        case 'channel': return buildChannelCard(token.data, ctx);
        case 'location': return buildLocationCard(token.data, ctx);
        default: return escapeHtml(token.raw);
    }
}

/** Read a hook without assuming the page installed it. */
function shareHook(name) {
    const hooks = window.MCShareHooks;
    return (hooks && typeof hooks[name] === 'function') ? hooks[name] : null;
}

/**
 * Node-type label. Spelled out as literal keys rather than a composed
 * 'share.type.' + n, so scripts/i18n_check.py can see which keys are in use.
 */
function shareTypeLabel(type) {
    switch (MCShare.normalizeContactType(type)) {
        case 2:  return t('share.type.2');
        case 3:  return t('share.type.3');
        case 4:  return t('share.type.4');
        default: return t('share.type.1');
    }
}

/** "You shared this …" banner, shown instead of an action on our own messages. */
function shareOwnHeader(key) {
    return `<div class="share-card-own">${tHtml(key)}</div>`;
}

/**
 * Contact card. The action reflects what clicking would actually do, resolved
 * before render so the user is never surprised by the outcome.
 */
function buildContactCard(data, ctx) {
    const pubkey = data.public_key;
    const name = data.name || MCShare.shortPubkey(pubkey);
    const icon = SHARE_TYPE_ICONS[MCShare.normalizeContactType(data.type)] || 'bi-person-fill';

    const attrs = `data-share-kind="contact" data-pubkey="${escapeHtmlAttribute(pubkey)}"` +
                  ` data-name="${escapeHtmlAttribute(data.name || '')}"` +
                  ` data-type="${MCShare.normalizeContactType(data.type)}"`;

    // On our own messages the marker replaces the action: we already have
    // whatever we shared, so there is nothing to add.
    let header = '';
    let footer = '';
    if (ctx.isOwn) {
        header = shareOwnHeader('share.card.you_shared_contact');
    } else {
        const lookup = shareHook('lookupContact');
        const known = lookup ? lookup(pubkey) : null;
        footer = contactCardAction(known, data.name);
    }

    return `<div class="share-card share-card-contact" ${attrs}>` +
             header +
             `<div class="share-card-main">` +
               `<span class="share-card-avatar"><i class="bi ${icon}"></i></span>` +
               `<div class="share-card-info">` +
                 `<div class="share-card-title">${escapeHtml(name)}</div>` +
                 `<div class="share-card-sub">${escapeHtml(shareTypeLabel(data.type))} · <span class="share-card-key">${escapeHtml(MCShare.shortPubkey(pubkey))}</span></div>` +
               `</div>` +
             `</div>` +
             footer +
           `</div>`;
}

/**
 * Decide the contact button from what we already hold. The public key is the
 * identity — a differing name means "rename", never a second contact.
 */
function contactCardAction(known, sharedName) {
    if (!known) {
        return shareCardButton('add-contact', 'share.card.add_contact', 'primary');
    }

    const sameName = (known.name || '') === (sharedName || '');
    if (!sameName && sharedName) {
        // upsert_contact overwrites a non-empty name, so this really is a rename.
        return shareCardButton('add-contact', 'share.card.update_name', 'primary',
                               { name: sharedName });
    }
    if (known.source === 'device') {
        return shareCardButton(null, 'share.card.in_contacts', 'done');
    }
    // Known but cache-only: offer the promotion right here rather than sending
    // the user off to the Contacts panel to do it.
    return shareCardButton('push-contact', 'share.card.push_to_device', 'secondary',
                           null, 'share.card.in_cache');
}

/**
 * Channel card. Joining needs the secret in firmware, so this always targets
 * the device — a cache-only channel could not decrypt anything.
 */
function buildChannelCard(data, ctx) {
    const attrs = `data-share-kind="channel" data-name="${escapeHtmlAttribute(data.name)}"` +
                  ` data-secret="${escapeHtmlAttribute(data.secret || '')}"` +
                  ` data-scope="${escapeHtmlAttribute(data.region_scope || '')}"`;

    // Literal keys on both branches, so scripts/i18n_check.py can see them —
    // a composed key hides the usage and lets a missing translation ship.
    const kindLabel = data.kind === 'hashtag' ? tHtml('share.card.hashtag_channel')
                                              : tHtml('share.card.private_channel');

    // The URI carries the scope as "#pl"; the UI names regions without the hash.
    let scopeRow = '';
    if (data.region_scope) {
        const scope = data.region_scope.replace(/^#/, '');
        scopeRow = `<div class="share-card-sub share-card-scope">` +
                   `<i class="bi bi-arrow-return-right"></i> ${tHtml('share.card.region', { name: scope })}` +
                   `</div>`;
    }

    let header = '';
    let footer = '';
    if (ctx.isOwn) {
        header = shareOwnHeader('share.card.you_shared_channel');
    } else {
        const lookup = shareHook('lookupChannel');
        const known = lookup ? lookup({ name: data.name, secret: data.secret }) : null;
        footer = channelCardAction(known, data);
    }

    return `<div class="share-card share-card-channel" ${attrs}>` +
             header +
             `<div class="share-card-main">` +
               `<span class="share-card-avatar"><i class="bi bi-hash"></i></span>` +
               `<div class="share-card-info">` +
                 `<div class="share-card-title">${escapeHtml(data.name)}</div>` +
                 `<div class="share-card-sub">${kindLabel}</div>` +
                 scopeRow +
               `</div>` +
             `</div>` +
             footer +
           `</div>`;
}

function channelCardAction(known, data) {
    if (!known) {
        return shareCardButton('add-channel', 'share.card.add_channel', 'primary');
    }
    if (known.matched === 'secret') {
        // Same key already in a slot — joining again would just burn a slot.
        return shareCardButton(null, 'share.card.channel_joined', 'done');
    }
    // Name is taken by a different key. Joining would either fail or shadow the
    // existing channel, so refuse and say why instead of silently overwriting.
    return shareCardButton(null, 'share.card.channel_conflict', 'warning');
}

/** Location card. Actions stay available on both sides — you may well want the
 *  map for a position you sent yourself. */
function buildLocationCard(data, ctx) {
    const lat = data.lat;
    const lon = data.lon;
    const coords = MCShare.serializeLocation(lat, lon);
    const attrs = `data-share-kind="location" data-lat="${lat}" data-lon="${lon}"`;

    // Distance and bearing from our own advertised position, when we have one.
    let relRow = '';
    const selfPos = shareHook('selfPosition');
    const self = selfPos ? selfPos() : null;
    if (self && MCShare.isValidLatLon(self.lat, self.lon)) {
        const dist = MCShare.formatDistance(MCShare.distanceMeters(self.lat, self.lon, lat, lon));
        const bearing = MCShare.compassBearing(self.lat, self.lon, lat, lon);
        relRow = `<div class="share-card-sub">${tHtml('share.card.from_you', { distance: dist, bearing: bearing })}</div>`;
    }

    const gLink = `https://www.google.com/maps/search/?api=1&amp;query=${lat},${lon}`;
    const oLink = `https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=15/${lat}/${lon}`;
    let external =
        `<a href="${gLink}" target="_blank" rel="noopener noreferrer" class="share-card-ext" title="${tHtml('share.card.open_google')}"><i class="bi bi-google"></i></a>` +
        `<a href="${oLink}" target="_blank" rel="noopener noreferrer" class="share-card-ext" title="${tHtml('share.card.open_osm')}"><i class="bi bi-globe2"></i></a>`;
    // Apple Maps is only useful on Apple platforms; elsewhere it is dead weight.
    if (/iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent || '')) {
        const aLink = `https://maps.apple.com/?ll=${lat},${lon}&amp;q=${encodeURIComponent(coords)}`;
        external += `<a href="${aLink}" target="_blank" rel="noopener noreferrer" class="share-card-ext" title="${tHtml('share.card.open_apple')}"><i class="bi bi-apple"></i></a>`;
    }

    return `<div class="share-card share-card-location" ${attrs}>` +
             `<div class="share-card-main">` +
               `<span class="share-card-avatar"><i class="bi bi-geo-alt-fill"></i></span>` +
               `<div class="share-card-info">` +
                 `<div class="share-card-title share-card-coords">${escapeHtml(coords)}</div>` +
                 relRow +
               `</div>` +
             `</div>` +
             `<div class="share-card-actions">` +
               `<button type="button" class="share-card-btn share-card-btn-primary" data-share-action="map">` +
                 `<i class="bi bi-map"></i> ${tHtml('share.card.view_on_map')}` +
               `</button>` +
               `<button type="button" class="share-card-btn share-card-btn-icon" data-share-action="copy-coords" title="${tHtml('share.card.copy_coords')}">` +
                 `<i class="bi bi-clipboard"></i>` +
               `</button>` +
               external +
             `</div>` +
           `</div>`;
}

/**
 * Build a card action button.
 * @param {?string} action - data-share-action, or null for a non-clickable state
 * @param {string} labelKey - i18n key for the label
 * @param {string} variant - primary | secondary | done | warning
 * @param {?object} params - i18n params for the label
 * @param {?string} noteKey - optional muted note rendered above the button
 */
function shareCardButton(action, labelKey, variant, params, noteKey) {
    const note = noteKey
        ? `<div class="share-card-note"><i class="bi bi-check-circle-fill"></i> ${tHtml(noteKey)}</div>`
        : '';
    const label = tHtml(labelKey, params || {});

    if (!action) {
        const icon = variant === 'warning' ? 'bi-exclamation-triangle-fill' : 'bi-check-circle-fill';
        return `${note}<div class="share-card-state share-card-state-${variant}">` +
               `<i class="bi ${icon}"></i> ${label}</div>`;
    }

    return `${note}<div class="share-card-actions">` +
           `<button type="button" class="share-card-btn share-card-btn-${variant}" data-share-action="${action}">${label}</button>` +
           `</div>`;
}

// -------------------------------------------------------------- card actions

/**
 * Add or rename a shared contact.
 * Contacts land in the local cache, not the device: shared contacts arrive
 * unsolicited and device contact slots are limited, so promotion stays a
 * deliberate act (the button offers it once the contact is cached).
 */
async function shareCardAddContact(card, btn) {
    const payload = {
        public_key: card.dataset.pubkey,
        name: card.dataset.name || '',
        type: parseInt(card.dataset.type, 10) || 1,
        target: 'cache'
    };

    const data = await shareCardPost('/api/contacts/manual-add', payload, btn);
    if (!data) return;

    showNotification(t(data.updated ? 'share.toast.contact_updated'
                                    : 'share.toast.contact_added',
                       { name: payload.name }), 'success');
    const invalidate = shareHook('onContactsChanged');
    if (invalidate) invalidate();
    shareCardRefresh(card);
}

/** Promote an already-cached shared contact into device memory. */
async function shareCardPushContact(card, btn) {
    const pubkey = card.dataset.pubkey;
    const data = await shareCardPost(`/api/contacts/${pubkey}/push-to-device`, {}, btn);
    if (!data) return;

    showNotification(t('share.toast.contact_pushed', { name: card.dataset.name }), 'success');
    const invalidate = shareHook('onContactsChanged');
    if (invalidate) invalidate();
    shareCardRefresh(card);
}

/**
 * Join a shared channel. Reuses the same endpoint as the #channel links, but
 * passes the secret through: the URI calls it `secret`, the API calls it `key`.
 */
async function shareCardAddChannel(card, btn) {
    const payload = { name: card.dataset.name };
    if (card.dataset.secret) payload.key = card.dataset.secret;

    const data = await shareCardPost('/api/channels/join', payload, btn);
    if (!data) return;

    showNotification(t('channels.toast.joined', { name: payload.name }), 'success');
    if (data.warning) {
        setTimeout(() => showNotification(data.warning, 'warning'), 2000);
    }

    // Carry the shared region scope over, otherwise sends on this channel would
    // use the firmware default and the packets would not match the sender's.
    if (card.dataset.scope) {
        const applyScope = shareHook('applyChannelScope');
        if (applyScope) await applyScope(data.channel, card.dataset.scope);
    }

    const onJoined = shareHook('onChannelJoined');
    if (onJoined) await onJoined(data.channel, payload.name);
    shareCardRefresh(card);
}

/** Open the shared position on the app map. */
function shareCardShowMap(card) {
    const lat = parseFloat(card.dataset.lat);
    const lon = parseFloat(card.dataset.lon);
    const label = MCShare.serializeLocation(lat, lon) || '';

    const openMap = shareHook('openMap');
    if (openMap) {
        openMap(label, lat, lon);
    } else if (typeof window.showContactOnMap === 'function') {
        window.showContactOnMap(label, lat, lon);
    } else {
        showNotification(t('share.toast.map_unavailable'), 'warning');
    }
}

async function shareCardCopyCoords(card) {
    const coords = MCShare.serializeLocation(parseFloat(card.dataset.lat),
                                             parseFloat(card.dataset.lon));
    try {
        await copyTextToClipboard(coords);
        showNotification(t('common.copied'), 'success');
    } catch (e) {
        showNotification(t('contacts.toast.copy_failed'), 'danger');
    }
}

/**
 * POST helper with button busy state. Returns the parsed body on success,
 * null on failure (already reported to the user).
 */
async function shareCardPost(url, payload, btn) {
    if (btn) {
        btn.disabled = true;
        btn.classList.add('loading');
    }
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!data.success) {
            showNotification(data.error || t('share.toast.action_failed'), 'danger');
            return null;
        }
        return data;
    } catch (error) {
        console.error('Share card action failed:', url, error);
        showNotification(t('share.toast.action_failed'), 'danger');
        return null;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('loading');
        }
    }
}

/**
 * Re-resolve a single card's action state after a successful action, so the
 * button reflects reality without waiting for the next full message render.
 */
function shareCardRefresh(card) {
    const kind = card.dataset.shareKind;
    let footer;

    if (kind === 'contact') {
        const lookup = shareHook('lookupContact');
        footer = contactCardAction(lookup ? lookup(card.dataset.pubkey) : null,
                                  card.dataset.name);
    } else if (kind === 'channel') {
        const lookup = shareHook('lookupChannel');
        const known = lookup ? lookup({ name: card.dataset.name, secret: card.dataset.secret }) : null;
        footer = channelCardAction(known, { name: card.dataset.name });
    } else {
        return;
    }

    // Drop the previous action/state/note rows, keep the identity block.
    card.querySelectorAll('.share-card-actions, .share-card-state, .share-card-note')
        .forEach(el => el.remove());
    card.insertAdjacentHTML('beforeend', footer);
}

/**
 * One delegated listener for every card action, matching how channel links and
 * image thumbnails are wired. Guarded so repeated init calls cannot double-fire
 * and send duplicate POSTs.
 */
let _shareCardHandlersInitialized = false;
function initializeShareCardHandlers() {
    if (_shareCardHandlersInitialized) return;
    _shareCardHandlersInitialized = true;

    document.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-share-action]');
        if (!btn) return;

        const card = btn.closest('.share-card');
        if (!card) return;

        e.preventDefault();
        if (btn.classList.contains('loading')) return;

        switch (btn.dataset.shareAction) {
            case 'add-contact':  shareCardAddContact(card, btn); break;
            case 'push-contact': shareCardPushContact(card, btn); break;
            case 'add-channel':  shareCardAddChannel(card, btn); break;
            case 'map':          shareCardShowMap(card); break;
            case 'copy-coords':  shareCardCopyCoords(card); break;
        }
    });
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
    if (typeof selectChannelFromDropdown === 'function') {
        const channels = window._channelDropdownItems || [];
        const ch = channels.find(c => c && c.index === channelIdx);
        const name = (ch && ch.name) || channelName || '';
        selectChannelFromDropdown(channelIdx, name);
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
            showNotification(t('channels.toast.joined', { name: channelName }), 'success');

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
            showNotification(t('channels.toast.join_failed', { error: data.error }), 'danger');
        }
    } catch (error) {
        console.error('Error joining channel via link:', error);
        showNotification(t('channels.toast.join_error'), 'danger');
    }
}

/**
 * Initialize channel link click handlers using event delegation
 */
let _channelLinkHandlersInitialized = false;
function initializeChannelLinkHandlers() {
    // Guard against double registration - otherwise one click fires N handlers
    // and sends N duplicate POSTs to /api/channels/join.
    if (_channelLinkHandlersInitialized) return;
    _channelLinkHandlersInitialized = true;

    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('channel-link')) {
            e.preventDefault();
            // Swallow clicks while this link is already handling a request.
            if (e.target.classList.contains('loading')) return;

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
        initializeShareCardHandlers();
    });
} else {
    // DOM already loaded
    initializeImageHandlers();
    initializeChannelLinkHandlers();
    initializeShareCardHandlers();
}
