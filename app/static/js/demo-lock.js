/**
 * Demo mode — the visible half of the guard.
 *
 * The server already refuses these actions (app/demo_guard.py); this file exists
 * so a visitor sees *why* a control does nothing instead of clicking it and
 * getting an error. Greying out rather than hiding is deliberate: the instance
 * is shared to show mc-webui off, and a feature nobody can see is a feature
 * nobody is impressed by.
 *
 * Loaded from _head_i18n.html, so it runs on all eight entry points including
 * the six fullscreen iframes — the console among them, which is the one page
 * where hiding the controls would matter most.
 *
 * Marking things up:
 *   data-demo-lock            disable every control inside (or the element
 *                             itself, when it is a control)
 *   data-demo-lock="hide"     remove it from the page instead
 *   data-demo-lock-exempt     leave this subtree alone
 *
 * Anything rendered later by JS is caught by a MutationObserver, because most of
 * the dangerous buttons in this app (channel delete, region delete, repeater
 * actions) are written into a list long after DOMContentLoaded.
 */

(function () {
    'use strict';

    const CFG = window.MC_DEMO || {};
    const LOCK_CLASS = 'demo-locked';
    const CONTROLS = 'input, select, textarea, button, a.btn, [contenteditable="true"]';

    /** Locked = demo is on and this visitor has not proved they are the operator. */
    function isLocked() {
        return !!CFG.enabled && !CFG.unlocked;
    }

    function tr(key, fallback) {
        const value = typeof window.t === 'function' ? window.t(key) : key;
        // A missing key resolves to the key itself; prefer readable English to that.
        return value === key ? fallback : value;
    }

    // ============================================================
    // Applying the lock
    // ============================================================

    function lockControl(el) {
        if (el.dataset.demoLocked === '1') return;
        el.dataset.demoLocked = '1';

        if ('disabled' in el) {
            el.disabled = true;
        }
        el.classList.add(LOCK_CLASS);
        el.setAttribute('aria-disabled', 'true');
        // Keep the original tooltip recoverable, in case the page is unlocked
        // later without a reload.
        if (el.title) el.dataset.demoTitle = el.title;
        el.title = tr('demo.locked_title', 'Disabled in demo mode');

        // A disabled <a> still navigates, and a disabled element still fires
        // click handlers bound to an ancestor — so refuse the event outright.
        if (!el.dataset.demoBound) {
            el.dataset.demoBound = '1';
            el.addEventListener('click', swallow, true);
        }
    }

    function swallow(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        notifyBlocked();
    }

    function applyTo(container) {
        if (container.dataset.demoLock === 'hide') {
            container.remove();
            return;
        }

        if (container.matches(CONTROLS)) {
            lockControl(container);
        }
        container.querySelectorAll(CONTROLS).forEach(function (el) {
            if (el.closest('[data-demo-lock-exempt]')) return;
            lockControl(el);
        });

        container.classList.add('demo-locked-region');
    }

    function apply(root) {
        (root || document).querySelectorAll('[data-demo-lock]').forEach(applyTo);
    }

    // ============================================================
    // Telling the visitor why
    // ============================================================

    let lastNotice = 0;

    function notifyBlocked() {
        // Several handlers can fire for one click; one message per second is plenty.
        const now = Date.now();
        if (now - lastNotice < 1000) return;
        lastNotice = now;

        const message = tr('demo.blocked_toast',
            'This instance runs in demo mode — the action is disabled.');

        if (typeof window.showNotification === 'function') {
            window.showNotification(message, 'warning');
        } else if (typeof window.showToast === 'function') {
            window.showToast(message, 'warning');
        } else {
            console.info('[demo] ' + message);
        }
    }

    // ============================================================
    // The server is the real guard — report what it refuses
    // ============================================================

    /**
     * A stale page, an un-marked control or a direct call can still reach a
     * locked endpoint. The server answers 403 demo_locked; turn that into the
     * same message rather than whatever "failed" text the caller would show.
     */
    function interceptFetch() {
        const original = window.fetch;
        if (!original || original.__demoWrapped) return;

        const wrapped = function (input, init) {
            return original.call(this, input, init).then(function (response) {
                if (response.status === 403) {
                    // Peek without consuming: the caller still needs the body.
                    response.clone().json().then(function (body) {
                        if (body && body.error === 'demo_locked') notifyBlocked();
                    }).catch(function () { /* not JSON — not ours */ });
                }
                return response;
            });
        };
        wrapped.__demoWrapped = true;
        window.fetch = wrapped;
    }

    // ============================================================
    // Unlocking
    // ============================================================

    /** Trade the code for the cookie. Resolves true when the page should reload. */
    window.demoUnlock = function (code) {
        return fetch('/api/demo/unlock', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code }),
        }).then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (data) { return !!(data && data.success); });
    };

    /** Drop the cookie and go back to being a visitor. */
    window.demoLock = function () {
        return fetch('/api/demo/lock', { method: 'POST' })
            .then(function () { return true; })
            .catch(function () { return false; });
    };

    window.demoIsLocked = isLocked;

    // ============================================================
    // The unlock box in Settings
    // ============================================================

    /**
     * Wired whenever demo mode is on at all — not only while locked — because
     * the "lock again" button exists precisely in the unlocked state, which the
     * lock pass below returns early from.
     */
    function wireUnlockBox() {
        const input = document.getElementById('demoUnlockInput');
        const unlockBtn = document.getElementById('demoUnlockBtn');
        const lockBtn = document.getElementById('demoLockBtn');
        const hint = document.getElementById('demoUnlockHint');

        if (unlockBtn && input) {
            const submit = function () {
                const code = input.value.trim();
                if (!code) return;

                unlockBtn.disabled = true;
                window.demoUnlock(code).then(function (ok) {
                    if (ok) {
                        // Every locked control on every open page was rendered
                        // for a visitor; a reload is the honest way to redraw.
                        window.location.reload();
                        return;
                    }
                    unlockBtn.disabled = false;
                    input.value = '';
                    input.classList.add('is-invalid');
                    if (hint) {
                        hint.textContent = tr('demo.unlock_bad', 'That code was not accepted.');
                        hint.classList.add('text-danger');
                    }
                });
            };

            unlockBtn.addEventListener('click', submit);
            input.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    submit();
                }
            });
        }

        if (lockBtn) {
            lockBtn.addEventListener('click', function () {
                lockBtn.disabled = true;
                window.demoLock().then(function () { window.location.reload(); });
            });
        }
    }

    // ============================================================
    // Start
    // ============================================================

    function start() {
        if (!CFG.enabled) return;

        wireUnlockBox();

        if (!isLocked()) return;

        document.documentElement.classList.add('demo-mode-locked');
        apply(document);

        // Dangerous controls are routinely rendered into a list after load.
        const observer = new MutationObserver(function (mutations) {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches && node.matches('[data-demo-lock]')) applyTo(node);
                    if (node.querySelectorAll) apply(node);
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        interceptFetch();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
