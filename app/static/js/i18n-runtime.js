/**
 * UI Translation Runtime
 *
 * Reads the catalog that /i18n/<lang>.<hash>.js put on window.MC_I18N. That catalog is
 * already merged over English server-side, so there is no fallback chain here — a key
 * that is missing is genuinely missing everywhere.
 *
 * Must load as a blocking script in <head>, before any script that calls t().
 *
 * Two functions, one rule:
 *   t()     - textContent, .title, .placeholder, alert(), Notification body
 *   tHtml() - anywhere the result lands in innerHTML / insertAdjacentHTML
 *
 * tHtml() escapes the interpolated params, never the catalog value. Markup in the
 * catalog is trusted (the admin installed the file); interpolated data is not.
 */

// Only {word} is a placeholder, so a literal "{" before punctuation survives untouched.
const I18N_PARAM_RE = /\{(\w+)\}/g;

const _pluralRules = {};

function _i18nCatalog() {
    return window.MC_I18N || {};
}

/**
 * Substitute {name} placeholders.
 * An unknown placeholder is left verbatim so it shows up in the UI instead of vanishing.
 */
function _i18nInterpolate(text, params) {
    if (!params || text.indexOf('{') === -1) return text;
    return text.replace(I18N_PARAM_RE, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
    ));
}

function _i18nEscape(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Resolve a key to its raw catalog string.
 * A missing key returns the key itself — unmistakable in the UI, greppable in a screenshot.
 */
function _i18nResolve(key, count) {
    const value = _i18nCatalog()[key];

    if (value === undefined) {
        if (window.MC_I18N_DEBUG) console.warn('Missing translation key:', key);
        return key;
    }
    if (typeof value === 'string') return value;

    const lang = window.MC_LANG || 'en';
    if (!_pluralRules[lang]) {
        try {
            _pluralRules[lang] = new Intl.PluralRules(lang);
        } catch (e) {
            _pluralRules[lang] = new Intl.PluralRules('en');
        }
    }
    const category = _pluralRules[lang].select(count === undefined ? 1 : count);
    return value[category] || value.other || value.one || key;
}

/**
 * Translate. Result is NOT HTML-escaped — use for text sinks only.
 * @param {string} key
 * @param {Object} [params] - values for {name} placeholders
 * @returns {string}
 */
function t(key, params) {
    return _i18nInterpolate(_i18nResolve(key), params);
}

/**
 * Translate for an HTML sink. Catalog markup is preserved, params are escaped.
 * @param {string} key
 * @param {Object} [params]
 * @returns {string}
 */
function tHtml(key, params) {
    const text = _i18nResolve(key);
    if (!params) return text;

    const escaped = {};
    for (const name of Object.keys(params)) {
        escaped[name] = _i18nEscape(params[name]);
    }
    return _i18nInterpolate(text, escaped);
}

/**
 * Translate with a plural form, using the catalog's {one, few, many, other} object.
 * {count} is injected automatically.
 * @param {string} key
 * @param {number} count
 * @param {Object} [params]
 * @returns {string}
 */
function tn(key, count, params) {
    return _i18nInterpolate(_i18nResolve(key, count), Object.assign({ count: count }, params || {}));
}

window.t = t;
window.tHtml = tHtml;
window.tn = tn;
