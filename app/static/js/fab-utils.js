// =============================================================================
// FAB Container — Drag-and-Drop & Customization Utilities
// =============================================================================

/**
 * Make a FAB container draggable via its toggle button.
 * Short click = toggle collapse, drag = reposition.
 * Position is persisted to localStorage.
 *
 * @param {string} containerId  - e.g. 'fabContainer' or 'dmFabContainer'
 * @param {string} toggleId     - e.g. 'fabToggle' or 'dmFabToggle'
 * @param {string} storageKey   - localStorage key for position
 */
function initFabDrag(containerId, toggleId, storageKey) {
    const container = document.getElementById(containerId);
    const toggle = document.getElementById(toggleId);
    if (!container || !toggle) return;

    const DRAG_THRESHOLD = 5; // px – movement before drag starts
    let dragging = false;
    let startX, startY, origLeft, origTop;
    let didDrag = false;

    // --- Restore saved position ---
    restoreFabPosition(container, storageKey);

    // --- Pointer events on toggle ---
    toggle.addEventListener('pointerdown', onPointerDown);

    function onPointerDown(e) {
        // Only primary button
        if (e.button !== 0) return;

        e.preventDefault();
        toggle.setPointerCapture(e.pointerId);

        const rect = container.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        origLeft = rect.left;
        origTop = rect.top;
        dragging = false;
        didDrag = false;

        toggle.addEventListener('pointermove', onPointerMove);
        toggle.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!dragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
            dragging = true;
            didDrag = true;
            // Switch container to left/top positioning for drag
            container.style.right = 'auto';
        }

        if (dragging) {
            const newLeft = origLeft + dx;
            const newTop = origTop + dy;
            container.style.left = newLeft + 'px';
            container.style.top = newTop + 'px';
        }
    }

    function onPointerUp(e) {
        toggle.removeEventListener('pointermove', onPointerMove);
        toggle.removeEventListener('pointerup', onPointerUp);

        if (didDrag) {
            // Clamp to viewport
            clampFabPosition(container);
            // Save
            saveFabPosition(container, storageKey);
        }
        // If it was not a drag, let the click event fire naturally (toggle collapse)
        // If it was a drag, suppress the click
        if (didDrag) {
            toggle.addEventListener('click', suppressClick, {once: true, capture: true});
        }
    }

    function suppressClick(e) {
        e.stopImmediatePropagation();
        e.preventDefault();
    }
}

function clampFabPosition(container) {
    const rect = container.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left;
    let top = rect.top;

    // Keep at least 20px of the container visible on each edge
    if (left + rect.width < 20) left = 20 - rect.width;
    if (left > vw - 20) left = vw - 20;
    if (top < 0) top = 0;
    if (top > vh - 20) top = vh - 20;

    container.style.left = left + 'px';
    container.style.top = top + 'px';
}

function saveFabPosition(container, storageKey) {
    const rect = container.getBoundingClientRect();
    localStorage.setItem(storageKey, JSON.stringify({
        left: rect.left,
        top: rect.top
    }));
}

function restoreFabPosition(container, storageKey) {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;

    try {
        const pos = JSON.parse(saved);
        container.style.right = 'auto';
        container.style.left = pos.left + 'px';
        container.style.top = pos.top + 'px';
        // Re-clamp in case viewport changed
        clampFabPosition(container);
    } catch (e) {
        localStorage.removeItem(storageKey);
    }
}

// =============================================================================
// FAB Size & Spacing — apply from localStorage
// =============================================================================

/**
 * Apply saved FAB appearance settings (size, gap).
 * Called on page load from both main and DM pages.
 */
function applyFabAppearance() {
    const size = localStorage.getItem('mc-webui-fab-size');
    const gap = localStorage.getItem('mc-webui-fab-gap');

    if (size) {
        document.documentElement.style.setProperty('--fab-custom-size', size + 'px');
    }
    if (gap) {
        document.documentElement.style.setProperty('--fab-custom-gap', gap + 'px');
    }
}

// Auto-apply on load
document.addEventListener('DOMContentLoaded', applyFabAppearance);
