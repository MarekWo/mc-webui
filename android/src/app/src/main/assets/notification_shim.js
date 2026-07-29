/*
 * Web Notifications API for Android's WebView, which ships none of its own.
 *
 * Without this, `window.Notification` is undefined, mc-webui detects that and
 * greys its notification toggle out as "Unavailable". Here we put back just
 * enough of the standard API for the page to use unchanged - every call ends
 * up at the native notification manager through `__mcNotifyBridge`.
 *
 * Runs at document start, before any of the page's own scripts.
 */
(function () {
    'use strict';

    var bridge = window.__mcNotifyBridge;
    // No bridge means an older wrapper: leave Notification undefined so the
    // page falls back to "Unavailable" rather than failing halfway through
    if (!bridge) return;

    /** Pending requestPermission() promises, by callback id. */
    var pending = {};
    var nextCallbackId = 0;

    /** Notifications still on screen, so a tap can find its onclick handler. */
    var live = {};
    var nextTag = 0;

    /** Called from Kotlin once the Android permission dialog is answered. */
    window.__mcNotifyResolve = function (callbackId, permission) {
        var resolve = pending[callbackId];
        if (!resolve) return;
        delete pending[callbackId];
        resolve(permission);
    };

    /** Called from Kotlin when the user taps a notification. */
    window.__mcNotifyClicked = function (tag) {
        var notification = live[tag];
        if (!notification || typeof notification.onclick !== 'function') return;
        try {
            notification.onclick.call(notification);
        } catch (e) {
            console.error('mc-webui: notification onclick failed', e);
        }
    };

    function McNotification(title, options) {
        options = options || {};
        this.title = String(title == null ? '' : title);
        this.body = String(options.body == null ? '' : options.body);
        this.icon = options.icon;
        this.badge = options.badge;
        this.silent = !!options.silent;
        this.requireInteraction = !!options.requireInteraction;
        // A tag replaces the previous notification with the same name, so an
        // untagged one needs its own id rather than silently replacing another
        this.tag = options.tag ? String(options.tag) : 'mc-auto-' + (nextTag++);

        this.onclick = null;
        this.onclose = null;
        this.onerror = null;
        this.onshow = null;

        live[this.tag] = this;
        try {
            bridge.notify(this.tag, this.title, this.body, this.silent);
        } catch (e) {
            console.error('mc-webui: native notify failed', e);
        }
    }

    McNotification.prototype.close = function () {
        delete live[this.tag];
        try {
            bridge.close(this.tag);
        } catch (e) {
            console.error('mc-webui: native close failed', e);
        }
    };

    // Read straight from Android every time - the user can revoke the
    // permission in system settings while the page stays open
    Object.defineProperty(McNotification, 'permission', {
        get: function () {
            try {
                return bridge.getPermission();
            } catch (e) {
                return 'denied';
            }
        }
    });

    McNotification.requestPermission = function (legacyCallback) {
        var promise = new Promise(function (resolve) {
            var id = String(nextCallbackId++);
            pending[id] = resolve;
            try {
                bridge.requestPermission(id);
            } catch (e) {
                delete pending[id];
                resolve('denied');
            }
        });
        // The pre-promise signature is still allowed by the spec
        if (typeof legacyCallback === 'function') promise.then(legacyCallback);
        return promise;
    };

    // Notification actions need a service worker, which WebView cannot do
    McNotification.maxActions = 0;

    window.Notification = McNotification;
})();
