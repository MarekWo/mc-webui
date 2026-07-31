/**
 * Shared date/time and number formatting.
 *
 * Policy: numeric formatting follows the BROWSER locale, only the words are translated.
 *
 * That split is deliberate. Tying the clock to the UI language would flip a Polish
 * operator to "09:53 AM" the moment they switched the interface to English, and mesh
 * operators want 24-hour time regardless of what language the menus are in. The browser
 * locale already reflects how the user wants dates and numbers written, so leave it
 * alone and translate only "Yesterday", "just now" and friends.
 *
 * Loaded via _head_i18n.html on every page, after the translation runtime.
 */

/** HH:MM in the browser's locale. */
function formatClock(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a unix timestamp as today / yesterday / an older date.
 *
 * @param {number} timestamp - unix seconds
 * @param {Object} [opts]
 * @param {boolean} [opts.absolute] - always show the full date, never today/yesterday
 * @param {'full'|'short'} [opts.dateStyle] - how older dates are written
 * @returns {string}
 */
function formatTimestamp(timestamp, opts) {
    if (!timestamp) return '';
    const { absolute = false, dateStyle = 'full' } = opts || {};

    const date = new Date(timestamp * 1000);
    const longDate = () => (dateStyle === 'short'
        ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
        : date.toLocaleDateString());

    if (absolute) return `${longDate()} ${formatClock(date)}`;

    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === now.toDateString()) {
        return formatClock(date);
    }
    if (date.toDateString() === yesterday.toDateString()) {
        return `${t('common.yesterday')} ${formatClock(date)}`;
    }
    return `${longDate()} ${formatClock(date)}`;
}

/**
 * Format a unix timestamp as relative time ("5 min ago", "2h ago").
 *
 * @param {number} timestamp - unix seconds
 * @param {Object} [opts]
 * @param {boolean} [opts.long] - spell out the units and keep counting in months and
 *   years past a week, instead of falling back to a date. Contact lists want this: a
 *   stale advert reads better as "3 months ago" than as a date nobody recognises.
 * @returns {string}
 */
function formatTimeAgo(timestamp, opts) {
    if (!timestamp) return t('common.never');
    const long = !!(opts && opts.long);
    const diff = Math.floor(Date.now() / 1000) - timestamp;

    // A future timestamp means clock skew between us and the sender, not a real value.
    if (diff < 60) return t('common.just_now');

    if (diff < 3600) {
        return long ? tn('common.minutes_ago_long', Math.floor(diff / 60))
                    : t('common.minutes_ago', { count: Math.floor(diff / 60) });
    }
    if (diff < 86400) {
        return long ? tn('common.hours_ago_long', Math.floor(diff / 3600))
                    : t('common.hours_ago', { count: Math.floor(diff / 3600) });
    }
    if (long) {
        if (diff < 2592000) return tn('common.days_ago_long', Math.floor(diff / 86400));
        if (diff < 31536000) return tn('common.months_ago', Math.floor(diff / 2592000));
        return tn('common.years_ago', Math.floor(diff / 31536000));
    }
    if (diff < 604800) return tn('common.days_ago', Math.floor(diff / 86400));
    return new Date(timestamp * 1000).toLocaleDateString();
}

/**
 * Thousands-separated integer in the browser's locale, em dash for missing values.
 * @param {number|null} n
 * @returns {string}
 */
function formatInt(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString();
}

window.formatClock = formatClock;
window.formatTimestamp = formatTimestamp;
window.formatTimeAgo = formatTimeAgo;
window.formatInt = formatInt;
