const { ipcRenderer, contextBridge } = require('electron');

let isInternalNavigation = false;

// App version, for the startup splash overlay and (via 'return-settings') the Settings screen footer.
// Fetched once per page load; cheap sendSync, same pattern as get-feature-flags below.
let appVersion = '';
try {
    appVersion = ipcRenderer.sendSync('get-app-version') || '';
} catch (e) {
    console.error('[htpc-yt] could not read app version', e);
}

contextBridge.exposeInMainWorld('electronAPI', {
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
    allowNav: () => { isInternalNavigation = true; }
});

ipcRenderer.on('force-allow-nav', () => {
    isInternalNavigation = true;
});

window.addEventListener('DOMContentLoaded', () => {
    // If we are on the settings page, exit page or chrome://gpu (--debug-gpu), do not inject the mouse shield
    if (window.location.protocol === 'chrome:' || window.location.href.includes('settings.html') || window.location.href.includes('exit.html')) {
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

    // Startup version overlay: sits on top of the page (over YouTube TV's own loading splash) for
    // the first few seconds, matching roughly how long the startup sound plays, then fades away.
    if (appVersion) {
        const splash = document.createElement('div');
        splash.id = 'startup-version-overlay';
        splash.textContent = 'Ver. ' + appVersion;
        splash.style.position = 'fixed';
        splash.style.bottom = '10px';
        splash.style.left = '10px';
        splash.style.zIndex = '2147483648'; // Above the mouse shield
        splash.style.color = '#fff';
        splash.style.fontSize = '13px';
        splash.style.fontFamily = 'Roboto, Arial, sans-serif';
        splash.style.pointerEvents = 'none';
        splash.style.textShadow = '1px 1px 2px #000';
        document.body.appendChild(splash);

        // No opacity/transition here on purpose: animating opacity promotes this element to its
        // own GPU compositing layer, which on weaker/older GPUs (see hardwareDecoding/lowMemoryMode
        // in settings.ini) can clash with the hardware video-overlay plane and paint as a solid
        // black bar instead of blending through. A hard removal avoids that layer entirely.
        setTimeout(() => { splash.remove(); }, 4000);
    }
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

// ============================================================================
// YouTube TV main-world hooks
// ----------------------------------------------------------------------------
// The features ported from VacuumTube (https://github.com/shy1132/VacuumTube, MIT, (c) 2025-2026 shy)
// work by changing objects that YouTube's own scripts use (window.environment, JSON.parse, ...).
// This preload runs in an isolated world, so installHtpcHooks() is executed in the PAGE'S main
// world with contextBridge.executeInMainWorld (synchronous, so it runs before YouTube's scripts).
//
// RULES for installHtpcHooks:
//  - it is serialised with toString(), so it must be fully self-contained (no preload variables)
//  - keep it between the MAINWORLD markers: test/mainworld.test.js extracts it from this file
//  - it must never throw into the page; every hook guards itself
// ============================================================================

const onYouTubeTv = window.location.protocol === 'https:' &&
    window.location.host === 'www.youtube.com' &&
    (window.location.pathname === '/tv' || window.location.pathname.startsWith('/tv/'));

if (onYouTubeTv) {
    let featureFlags = {};
    try {
        featureFlags = ipcRenderer.sendSync('get-feature-flags') || {};
    } catch (e) {
        console.error('[htpc-yt] could not read feature flags', e);
    }

    try {
        contextBridge.executeInMainWorld({ func: installHtpcHooks, args: [featureFlags] });
    } catch (e) {
        console.error('[htpc-yt] could not install main-world hooks', e);
    }

    // High Contrast Text Mode ON (the default) = keep YouTube's own black boxes, so nothing is injected.
    // OFF = replace them with an outline. Only an explicit `false` counts, so a failed flag read
    // (featureFlags = {}) leaves YouTube untouched.
    if (featureFlags.highContrastText === false) {
        applyOutlinedText();
    }
}

// Outlined text (the "High Contrast Text Mode = OFF" look)
// ----------------------------------------------------------------------------
// YouTube TV draws a black box behind text on the paused/controls overlay. With High Contrast Text
// Mode ON that is left exactly as YouTube draws it (it is the higher-contrast look). With the mode
// OFF, applyOutlinedText() below removes those boxes and gives the text an outline instead.
// Subtitles/captions are deliberately NOT touched: the viewer's own caption settings in YouTube
// (custom colours, background, opacity) keep working.
//
// The boxes are YouTube TV rules that set a dark `background-color` together with `display: inline`
// (a black highlight behind the text). The full list below was collected from YouTube TV's own
// stylesheet with a console script that walks document.styleSheets for exactly that signature:
//      `.app-quality-root .SK1srf .WVWtef, .app-quality-root .SK1srf .niS3yd`  (WVWtef = video title)
//      `.app-quality-root .V7jTHe, .app-quality-root .g6XRz`                   (g6XRz = elapsed time + chapter name)
//      `.app-quality-root .boSXqb .y98TDb`                                     (y98TDb = channel info line, e.g. "2 yr ago")
//      `.app-quality-root .boSXqb .QFqCxd::before`                             (pseudo-element: background cleared only)
//      `.app-quality-root .UGcxnc .Dc2Zic .JkDfAc, .UGcxnc .dxLAmd, .UGcxnc .sjENQb`  (18 text elements on the paused screen)
//      `.app-quality-root .h3b7fd .RRJiYc`, `.app-quality-root .kNZkff .v63BTe`,
//      `.app-quality-root .x5zrbb`, `.daL9I`
// A stylesheet rule using !important beats both a normal rule and an inline style, so plain CSS is
// enough (no main-world hook needed). The text keeps its legibility from a solid outline (stacked
// text-shadows) instead of the box.
// NOTE: all of these are YouTube's generated class names and may change when YouTube redeploys.
// If a box comes back, inspect it (--devtools) and add its selector to OUTLINED_TEXT_ELEMENTS
// (element that holds text) or OUTLINED_BOX_ONLY (box with no text of its own).
function applyOutlinedText() {
    // Kept inside the function: it is called above this point in the file, and a top-level
    // const would still be uninitialised at that moment.

    // Elements in the controls overlay / menus that hold text on a black highlight:
    // box removed, and the element plus its children get the outline.
    const OUTLINED_TEXT_ELEMENTS = [
        // video title (and its sibling text)
        '.app-quality-root .SK1srf .WVWtef',
        '.app-quality-root .SK1srf .niS3yd',
        // channel info line under the title (e.g. "2 yr ago")
        '.app-quality-root .boSXqb .y98TDb',
        // elapsed time and chapter name
        '.app-quality-root .V7jTHe',
        '.app-quality-root .g6XRz',
        'span[idomkey="elapsedTime"]',
        // other text-highlight groups found by scanning the stylesheet
        '.app-quality-root .UGcxnc .Dc2Zic .JkDfAc',
        '.app-quality-root .UGcxnc .dxLAmd',
        '.app-quality-root .UGcxnc .sjENQb',
        '.app-quality-root .h3b7fd .RRJiYc',
        '.app-quality-root .kNZkff .v63BTe',
        '.app-quality-root .x5zrbb',
        '.daL9I'
    ];
    // Boxes with no text of their own (a text-shadow would do nothing): background cleared only.
    const OUTLINED_BOX_ONLY = [
        '.app-quality-root .boSXqb .QFqCxd::before'
    ];

    const BOX_SELECTORS = [...OUTLINED_TEXT_ELEMENTS, ...OUTLINED_BOX_ONLY];
    // Elements whose text gets the outline (children inherit it, but say so explicitly)
    const TEXT_SELECTORS = OUTLINED_TEXT_ELEMENTS.flatMap(sel => [sel, sel + ' *']);
    const OUTLINE =
        '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, ' +
        '0 0 4px #000, 0 0 8px rgba(0, 0, 0, 0.9)';

    const install = () => {
        if (document.getElementById('htpc-outlined-text')) return;
        const style = document.createElement('style');
        style.id = 'htpc-outlined-text';
        // One rule per selector: a comma list is dropped whole if any single selector is invalid,
        // so this keeps one bad/changed selector from disabling the rest.
        const boxRules = BOX_SELECTORS.map(sel =>
            sel + ' {\n' +
            '    background: transparent !important;\n' +
            '    background-color: transparent !important;\n' +
            '    box-shadow: none !important;\n' +
            '}\n');
        const textRules = TEXT_SELECTORS.map(sel =>
            sel + ' {\n' +
            '    text-shadow: ' + OUTLINE + ' !important;\n' +
            '}\n');
        style.textContent = boxRules.join('') + textRules.join('');
        // documentElement (not head) so it survives if the page rebuilds <head>
        (document.documentElement || document.head).appendChild(style);
    };
    if (document.documentElement) install();
    // Re-check once the DOM is ready in case the early append was discarded
    window.addEventListener('DOMContentLoaded', install);
}

// MAINWORLD-BEGIN
function installHtpcHooks(cfg) {
    // Debug marker: type __htpcYT in DevTools (--devtools) to see what was applied
    const htpc = { version: 1, flags: cfg, applied: [], stats: {} };
    Object.defineProperty(window, '__htpcYT', { value: htpc, configurable: true });

    function deepMerge(target, updates) {
        for (const key of Object.keys(updates)) {
            const value = updates[key];
            if (value && typeof value === 'object' && !Array.isArray(value) &&
                target[key] && typeof target[key] === 'object') {
                deepMerge(target[key], value);
            } else {
                target[key] = value;
            }
        }
        return target;
    }

    // ---- Low Memory Mode (VacuumTube: modules/low-memory-mode.js + util/configOverrides.js) ----
    // YouTube TV exposes its runtime switches on window.environment. Once that object exists, turn on
    // its memory-saving switch. Polling is how VacuumTube does it too; gives up after 30 s.
    if (cfg.lowMemoryMode) {
        let giveUp = null;
        const timer = setInterval(() => {
            try {
                if (!window.environment) return;
                clearInterval(timer);
                clearTimeout(giveUp);
                deepMerge(window.environment, { feature_switches: { enable_memory_saving_mode: true } });
                htpc.applied.push('lowMemoryMode');
            } catch (e) {
                clearInterval(timer);
                clearTimeout(giveUp);
                console.error('[htpc-yt] lowMemoryMode failed', e);
            }
        }, 4);
        giveUp = setTimeout(() => clearInterval(timer), 30000);
    }

    // ---- Unlock Resolution (VacuumTube: modules/h5vcc/index.js) ----
    // h5vcc is the host API that YouTube TV looks for on consoles / smart TVs (Cobalt). YouTube asks
    // system.getVideoContainerSizeOverride() how big the video area may be and caps the quality to it.
    // Answering 7680x4320 removes the monitor-size cap. Only defined when the option is on, so with it
    // off the page sees exactly what it saw before this feature existed.
    if (cfg.unlockResolution) {
        try {
            const UNLOCKED_SIZE = '7680x4320';
            const existing = window.h5vcc;
            if (existing && typeof existing === 'object') {
                existing.system = existing.system || {};
                existing.system.getVideoContainerSizeOverride = () => UNLOCKED_SIZE;
            } else {
                // No-op stand-in for VacuumTube's DIAL (cast discovery) server: it only has to exist so
                // that YouTube's own `new h5vcc.dial.DialServer(...)` does not throw.
                class DialServerStub {
                    constructor(appName) { this.appName = appName; }
                    onGet() {}
                    onPost() {}
                    onDelete() {}
                }
                Object.defineProperty(window, 'h5vcc', {
                    value: {
                        dial: { DialServer: DialServerStub },
                        runtime: { initialDeepLink: '' },
                        system: { getVideoContainerSizeOverride: () => UNLOCKED_SIZE }
                    },
                    configurable: true,
                    writable: true,
                    enumerable: true
                });
            }
            htpc.applied.push('unlockResolution');
        } catch (e) {
            console.error('[htpc-yt] unlockResolution failed', e);
        }
    }

    // ---- JSON hook engine (VacuumTube: util/jsonModifiers.js) ----
    // A single JSON.parse wrapper that runs every registered modifier over each parsed object.
    // Installed only if at least one modifier below registers itself, so with every JSON-based
    // feature off, JSON.parse is never touched. removeSuperResolution and Ad Block's video/shorts
    // filters are the modifiers that register here.
    const jsonMods = [];
    const origJsonParse = JSON.parse;
    function installJsonHook() {
        JSON.parse = function () {
            let json = origJsonParse.apply(this, arguments);
            if (json && typeof json === 'object') {
                for (const mod of jsonMods) {
                    try { json = mod(json) || json; } catch (e) { console.error('[htpc-yt] json modifier failed', e); }
                }
            }
            return json;
        };
    }

    // ---- Remove Super Resolution (VacuumTube: modules/remove-super-resolution.js) ----
    // YouTube's "Super resolution" quality tier is an AI-upscaled format, not a genuinely higher-res
    // source. Such formats carry a marker in streamingData.adaptiveFormats[i].xtags: a base64 protobuf
    // tag list with key "sr", value 1. VacuumTube matches the one known base64 string exactly; this
    // also decodes the tag so a format carrying it alongside other tags is still caught.
    if (cfg.removeSuperResolution) {
        const SR_TAG_BYTES = [0x0a, 0x02, 0x73, 0x72, 0x12, 0x01, 0x31]; // protobuf: key "sr", value 1
        const SR_TAG_STR = SR_TAG_BYTES.map((b) => String.fromCharCode(b)).join('');
        function hasSuperResolutionTag(xtags) {
            if (!xtags) return false;
            if (xtags === 'CgcKAnNyEgEx') return true; // VacuumTube's known exact marker
            try { return atob(xtags).indexOf(SR_TAG_STR) !== -1; } catch (e) { return false; }
        }
        jsonMods.push(function (json) {
            const formats = json && json.streamingData && json.streamingData.adaptiveFormats;
            if (!Array.isArray(formats)) return json;
            const before = formats.length;
            json.streamingData.adaptiveFormats = formats.filter((f) => !hasSuperResolutionTag(f && f.xtags));
            const removed = before - json.streamingData.adaptiveFormats.length;
            htpc.stats.superResRemoved = (htpc.stats.superResRemoved || 0) + removed;
            return json;
        });
        htpc.applied.push('removeSuperResolution');
    }

    // ---- Max Video Resolution (HTPC-YT own feature; driven by the Resolution row in Settings) ----
    // cfg.maxVideoHeight is the selected resolution's height in pixels (0 / missing = no ceiling).
    // Every video format taller than that is dropped from streamingData.adaptiveFormats and
    // streamingData.formats, so it cannot be picked in the quality menu and Auto quality cannot
    // switch up to it. Audio formats carry no size and are always kept.
    // A format's tier is the number in its qualityLabel ("1080p60" -> 1080, "2160p60 HDR" -> 2160),
    // i.e. exactly what the quality menu shows, which also keeps portrait and ultrawide videos in the
    // tier YouTube files them under. Without a label it falls back to the shorter side of width x height.
    // Independent of Unlock Resolution: that only stops YouTube capping quality to the monitor size,
    // this is the user's own ceiling on top of it.
    if (typeof cfg.maxVideoHeight === 'number' && cfg.maxVideoHeight > 0) {
        const maxHeight = cfg.maxVideoHeight;
        function formatTier(f) {
            if (!f || typeof f !== 'object') return 0;
            const m = typeof f.qualityLabel === 'string' && f.qualityLabel.match(/^(\d{3,4})p/);
            if (m) return Number(m[1]);
            const w = Number(f.width);
            const h = Number(f.height);
            return w > 0 && h > 0 ? Math.min(w, h) : 0;
        }
        function capFormats(list) {
            if (!Array.isArray(list)) return list;
            const kept = list.filter((f) => !(formatTier(f) > maxHeight));
            if (kept.length === list.length) return list;
            // Never hand YouTube a response with no video left in it: better an uncapped video than a broken one
            if (!kept.some((f) => formatTier(f) > 0)) return list;
            return kept;
        }
        jsonMods.push(function (json) {
            const streamingData = json && json.streamingData;
            if (!streamingData || typeof streamingData !== 'object') return json;
            for (const key of ['adaptiveFormats', 'formats']) {
                const before = streamingData[key];
                const after = capFormats(before);
                if (after !== before) {
                    htpc.stats.formatsCapped = (htpc.stats.formatsCapped || 0) + (before.length - after.length);
                    streamingData[key] = after;
                }
            }
            return json;
        });
        htpc.applied.push('maxVideoResolution');
    }

    // ---- Ad Block (VacuumTube: modules/adblock.js + util/jsonModifiers.js + util/xhrModifiers.js) ----
    // Three independent filters. Video ads and Shorts ads plug into the JSON.parse hook above. Home/
    // search feed ads live in an XHR response body, so this patches the responseText/response getters
    // on XMLHttpRequest.prototype instead of VacuumTube's full constructor replacement — a deliberate
    // simplification (see Stage 5 plan / backlog FT-42 for the fallback if it misses feed ads that the
    // constructor swap would have caught, e.g. if YouTube TV switches those requests to fetch()).
    if (cfg.adBlock) {
        // Video ads: empty adPlacements / adSlots wherever they appear in a parsed response.
        jsonMods.push(function (json) {
            if (json && Array.isArray(json.adPlacements) && json.adPlacements.length) {
                htpc.stats.adPlacementsRemoved = (htpc.stats.adPlacementsRemoved || 0) + json.adPlacements.length;
                json.adPlacements = [];
            }
            if (json && Array.isArray(json.adSlots) && json.adSlots.length) {
                htpc.stats.adSlotsRemoved = (htpc.stats.adSlotsRemoved || 0) + json.adSlots.length;
                json.adSlots = [];
            }
            return json;
        });

        // Shorts ads: drop entries flagged as ads on their reelWatchEndpoint.
        jsonMods.push(function (json) {
            if (json && Array.isArray(json.entries)) {
                const before = json.entries.length;
                json.entries = json.entries.filter((e) => !(e && e.command && e.command.reelWatchEndpoint &&
                    e.command.reelWatchEndpoint.adClientParams && e.command.reelWatchEndpoint.adClientParams.isAd));
                htpc.stats.shortsAdsRemoved = (htpc.stats.shortsAdsRemoved || 0) + (before - json.entries.length);
            }
            return json;
        });

        // Home/search feed ads: same shape VacuumTube filters, run against the raw XHR body below.
        function filterFeed(pathname, json) {
            let changed = false;
            function stripAdSlots(items) {
                const before = items.length;
                const kept = items.filter((i) => !(i && i.adSlotRenderer));
                if (kept.length !== before) changed = true;
                return kept;
            }
            if (pathname.indexOf('/youtubei/v1/browse') === 0) {
                const c = json && json.contents;
                const home = c && c.tvBrowseRenderer && c.tvBrowseRenderer.content &&
                    c.tvBrowseRenderer.content.tvSurfaceContentRenderer &&
                    c.tvBrowseRenderer.content.tvSurfaceContentRenderer.content &&
                    c.tvBrowseRenderer.content.tvSurfaceContentRenderer.content.sectionListRenderer;
                if (home && Array.isArray(home.contents)) {
                    const before = home.contents.length;
                    home.contents = home.contents.filter((r) => !(r && (r.adSlotRenderer || r.promoShelfRenderer ||
                        (r.shelfRenderer && r.shelfRenderer.tvhtml5Metadata && r.shelfRenderer.tvhtml5Metadata.hideLogo))));
                    if (home.contents.length !== before) changed = true;
                    for (const feed of home.contents) {
                        const h = feed && feed.shelfRenderer && feed.shelfRenderer.content && feed.shelfRenderer.content.horizontalListRenderer;
                        if (h && Array.isArray(h.items)) h.items = stripAdSlots(h.items);
                    }
                }
            } else if (pathname.indexOf('/youtubei/v1/search') === 0) {
                const search = json && json.contents && json.contents.sectionListRenderer;
                if (search && Array.isArray(search.contents)) {
                    for (const feed of search.contents) {
                        const h = feed && feed.shelfRenderer && feed.shelfRenderer.content && feed.shelfRenderer.content.horizontalListRenderer;
                        if (h && Array.isArray(h.items)) h.items = stripAdSlots(h.items);
                    }
                }
            }
            if (changed) htpc.stats.feedAdsRemoved = (htpc.stats.feedAdsRemoved || 0) + 1;
            return changed;
        }

        try {
            const proto = XMLHttpRequest.prototype;
            const origOpen = proto.open;
            proto.open = function (method, url) {
                try { this.__htpcUrl = new URL(url, location.href).pathname; } catch (e) { this.__htpcUrl = ''; }
                this.__htpcFiltered = undefined; // per-request cache, cleared on every new open()
                return origOpen.apply(this, arguments);
            };

            const textDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
            const respDesc = Object.getOwnPropertyDescriptor(proto, 'response');

            function isFeedUrl(pathname) {
                return !!pathname && (pathname.indexOf('/youtubei/v1/browse') === 0 || pathname.indexOf('/youtubei/v1/search') === 0);
            }

            // Runs the feed filter at most once per request (readyState 4, text/'' responseType only),
            // caching the result. Returns null if there was nothing to change or it wasn't a feed URL.
            function getFiltered(xhr) {
                if (xhr.__htpcFiltered !== undefined) return xhr.__htpcFiltered;
                if (!textDesc || xhr.readyState !== 4 || (xhr.responseType !== '' && xhr.responseType !== 'text') || !isFeedUrl(xhr.__htpcUrl)) {
                    return undefined; // not ready / not a feed request yet: don't cache, re-check next access
                }
                let result = null;
                try {
                    const text = textDesc.get.call(xhr);
                    const json = origJsonParse(text);
                    result = filterFeed(xhr.__htpcUrl, json) ? JSON.stringify(json) : null;
                } catch (e) {
                    result = null;
                }
                xhr.__htpcFiltered = result;
                return result;
            }

            if (textDesc && textDesc.get) {
                Object.defineProperty(proto, 'responseText', {
                    configurable: true,
                    get: function () {
                        const filtered = getFiltered(this);
                        return filtered != null ? filtered : textDesc.get.call(this);
                    }
                });
            }
            if (respDesc && respDesc.get) {
                Object.defineProperty(proto, 'response', {
                    configurable: true,
                    get: function () {
                        const filtered = getFiltered(this);
                        return filtered != null ? filtered : respDesc.get.call(this);
                    }
                });
            }
        } catch (e) {
            console.error('[htpc-yt] adBlock XHR hook failed', e);
        }

        htpc.applied.push('adBlock');
    }

    if (jsonMods.length) installJsonHook();
}
// MAINWORLD-END
