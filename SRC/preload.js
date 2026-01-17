const { ipcRenderer, contextBridge } = require('electron');

let isInternalNavigation = false;

contextBridge.exposeInMainWorld('electronAPI', {
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
    allowNav: () => { isInternalNavigation = true; }
});

ipcRenderer.on('force-allow-nav', () => {
    isInternalNavigation = true;
});

window.addEventListener('DOMContentLoaded', () => {
    // If we are on the settings page or exit page, do not inject the mouse shield
    if (window.location.href.includes('settings.html') || window.location.href.includes('exit.html')) {
        return;
    }

    // Inject CSS for Mouse Shield
    const style = document.createElement('style');
    style.textContent = `
        /* Mouse Shield to block interaction but hide cursor via inheritance or explicit rule */
        #mouse-shield {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 2147483647;
            cursor: none !important;
            background: transparent;
        }
    `;
    document.head.appendChild(style);

    // Create Mouse Shield
    const mouseShield = document.createElement('div');
    mouseShield.id = 'mouse-shield';
    // Prevent focus stealing or any default behavior
    mouseShield.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    mouseShield.addEventListener('mouseup', (e) => { e.preventDefault(); e.stopPropagation(); });
    mouseShield.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
    mouseShield.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
    mouseShield.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); });
    document.body.appendChild(mouseShield);
});

// Intercept window unload (Close, Back-exit, Refresh)
window.addEventListener('beforeunload', (e) => {
    // If this is an authorized internal navigation (via menu buttons), allow it.
    if (isInternalNavigation) {
        return; // Allow unload
    }

    // Prevent the window from closing immediately
    // Setting this value tells Electron/Chrome to stop the unload
    e.returnValue = false;
    
    // Ask Main process what to do (using IPC to break out of synchronous block)
    // We use setTimeout to ensure it runs after the 'returnValue' locking takes effect
    setTimeout(() => {
        if (window.electronAPI) {
            window.electronAPI.send('renderer-check-close'); 
        } else {
             // Fallback if contextBridge failed
             const { ipcRenderer } = require('electron');
             ipcRenderer.send('renderer-check-close');
        }
    }, 0);
});

// URL Overlay Logic
let urlOverlay = null;

function createUrlOverlay() {
    if (urlOverlay) return;
    urlOverlay = document.createElement('div');
    urlOverlay.id = 'debug-url-overlay';
    urlOverlay.style.position = 'fixed';
    urlOverlay.style.bottom = '10px';
    urlOverlay.style.left = '10px';
    urlOverlay.style.zIndex = '2147483648'; // Above mouse shield
    urlOverlay.style.color = 'rgba(255, 255, 255, 0.4)';
    urlOverlay.style.fontSize = '12px';
    urlOverlay.style.fontFamily = 'monospace';
    urlOverlay.style.pointerEvents = 'none';
    urlOverlay.style.textShadow = '1px 1px 2px #000';
    urlOverlay.style.whiteSpace = 'nowrap';
    document.body.appendChild(urlOverlay);
    updateUrlOverlay();
}

function updateUrlOverlay() {
    if (urlOverlay) {
        urlOverlay.textContent = window.location.href;
    }
}

ipcRenderer.on('configure-overlay', (event, config) => {
    if (config.showUrl) {
        if (!urlOverlay) createUrlOverlay();
        urlOverlay.style.display = 'block';
        updateUrlOverlay();
    } else if (urlOverlay) {
        urlOverlay.style.display = 'none';
    }
});

// Hook into history API for SPA updates
const originalPushState = history.pushState;
history.pushState = function(...args) {
    originalPushState.apply(this, args);
    updateUrlOverlay();
};

const originalReplaceState = history.replaceState;
history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    updateUrlOverlay();
};

window.addEventListener('popstate', updateUrlOverlay);
window.addEventListener('hashchange', updateUrlOverlay);
