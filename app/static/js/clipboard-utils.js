/**
 * Clipboard helper shared by every entry point.
 *
 * navigator.clipboard exists only in a secure context — HTTPS, or http://localhost.
 * Opening mc-webui over plain HTTP on a LAN address (http://192.168.1.50:5000) is not
 * one, so the API is simply undefined there and every copy button silently does
 * nothing. This falls back to the pre-Clipboard-API textarea trick, which still works.
 *
 * Returns a Promise, so it is a drop-in replacement for navigator.clipboard.writeText().
 */
function copyTextToClipboard(text) {
    if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
        // Even in a secure context this can reject (permissions, unfocused document),
        // so keep the fallback on that path too.
        return navigator.clipboard.writeText(text).catch(() => legacyClipboardWrite(text));
    }
    return legacyClipboardWrite(text);
}

/**
 * Copy via a temporary textarea and document.execCommand('copy').
 * Deprecated, but the only option outside a secure context.
 */
function legacyClipboardWrite(text) {
    return new Promise((resolve, reject) => {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        // Off-screen but still selectable — display:none would make select() a no-op.
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.setAttribute('readonly', '');
        document.body.appendChild(textArea);

        try {
            textArea.select();
            textArea.setSelectionRange(0, textArea.value.length);  // iOS needs the range
            if (document.execCommand('copy')) {
                resolve();
            } else {
                reject(new Error('execCommand("copy") returned false'));
            }
        } catch (err) {
            reject(err);
        } finally {
            document.body.removeChild(textArea);
        }
    });
}
