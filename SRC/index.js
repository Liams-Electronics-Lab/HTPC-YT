const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Configure UserData location to be local to the application
const userDataPath = app.isPackaged 
    ? path.join(path.dirname(process.execPath), 'UserData') 
    : path.join(__dirname, 'UserData');

// Ensure the directory exists (create if not)
if (!fs.existsSync(userDataPath)) {
    try {
        fs.mkdirSync(userDataPath, { recursive: true });
    } catch (e) {
        console.error('Failed to create UserData folder:', e);
    }
}
app.setPath('userData', userDataPath);

// Define portable paths for logs and crash dumps
const logsPath = path.join(userDataPath, 'Logs');
const crashDumpsPath = path.join(userDataPath, 'CrashDumps');
const cachePath = path.join(userDataPath, 'Cache');

app.setPath('logs', logsPath);
app.setPath('crashDumps', crashDumpsPath);

// Force cache location via command line to ensure it stays in UserData
app.commandLine.appendSwitch('disk-cache-dir', cachePath);
app.commandLine.appendSwitch('shader-disk-cache-path', cachePath);

// Set settings.ini path: Next to executable in Prod, or in source root in Dev
const settingsPath = app.isPackaged 
    ? path.join(path.dirname(process.execPath), 'settings.ini') 
    : path.join(__dirname, 'settings.ini');

// Default Settings
const defaultSettings = {
    width: 1920,                // Resolution row in Settings. Window size when fullscreen is off, AND the ceiling for video quality: the height is the highest quality YouTube may play (see getMaxVideoHeight)
    height: 1080,
    fullscreen: true,
    userAgent: 'Mozilla/5.0 (PS4; Leanback Shell) Cobalt/22.2.3-gold Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)',
    inputDebounce: 150,
    showUrl: false,
    hardwareDecoding: true,     // Startup-only: applied by relaunching the app (see apply-settings)
    lowMemoryMode: false,       // Asks YouTube TV for its reduced-memory mode (applied on the next page load)
    unlockResolution: true,     // Lets YouTube offer resolutions above the display size (ini only, no settings-page row)
    removeSuperResolution: false, // Hides YouTube's AI-upscaled "Super resolution" quality tier (applied on the next page load)
    adBlock: true,              // Strips ads from playback, home feed and search (applied on the next page load)
    highContrastText: true      // true = keep YouTube's black boxes behind on-video text; false = remove them and use a text outline instead. Subtitles are never touched (applied on the next page load)
};

// Boolean settings that the settings page may change (anything else in the payload is ignored).
// Add the key here, in defaultSettings, and in settings.html's featureToggles.
const TOGGLE_KEYS = ['hardwareDecoding', 'lowMemoryMode', 'removeSuperResolution', 'adBlock', 'highContrastText'];

function parseIni(data) {
    const config = {};
    const lines = data.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx !== -1) {
            const key = line.substring(0, idx).trim();
            const val = line.substring(idx + 1).trim();
            const lower = val.toLowerCase();
            if (lower === 'true') config[key] = true;
            else if (lower === 'false') config[key] = false;
            else if (!isNaN(Number(val)) && val !== '') config[key] = Number(val);
            else config[key] = val;
        }
    }
    return config;
}

function stringifyIni(obj) {
    return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
}

function loadSettings() {
    try {
        if (fs.existsSync(settingsPath)) {
            const data = fs.readFileSync(settingsPath, 'utf8');
            return { ...defaultSettings, ...parseIni(data) };
        } else {
            // Generate default settings file if it doesn't exist
            saveSettings(defaultSettings);
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
    return defaultSettings;
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(settingsPath, stringifyIni(settings));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
}

// The Resolution row in Settings doubles as the video-quality ceiling: 1080 means nothing above
// 1080p is offered. The preload compares this number against each format's quality label, so any
// height works (720 -> up to 720p, 768 -> up to 720p, 2160 -> up to 2160p). Anything that is not a
// positive number (hand-edited ini, garbage) means "no ceiling" (0) rather than a broken cap.
function getMaxVideoHeight(settings) {
    const h = Number(settings.height);
    return Number.isFinite(h) && h > 0 ? Math.round(h) : 0;
}

// The subset of settings the preload needs *synchronously at document start* to install its
// YouTube TV hooks (see preload.js, installHtpcHooks). Booleans plus the maxVideoHeight number:
// nothing sensitive leaves main.
function getFeatureFlags() {
    const s = loadSettings();
    return {
        maxVideoHeight: getMaxVideoHeight(s),
        lowMemoryMode: !!s.lowMemoryMode,
        unlockResolution: !!s.unlockResolution,
        removeSuperResolution: !!s.removeSuperResolution,
        adBlock: !!s.adBlock,
        highContrastText: !!s.highContrastText,
        appVersion: app.getVersion()
    };
}

// ---- Diagnostic flags (command line only, not stored in settings.ini) ----
// npx electron . --debug-gpu   opens chrome://gpu in a normal window (check "Video Decode")
// npx electron . --devtools    opens detached DevTools next to the app window
const debugGpu = process.argv.includes('--debug-gpu');
const openDevTools = process.argv.includes('--devtools');

// ---- GPU / hardware decoding ----
// These are Chromium startup switches, so they are decided from settings.ini before the app is ready.
// (Ported behavior from VacuumTube src/index.js: off -> disableHardwareAcceleration(), on -> enable video accel features.)
const startupSettings = loadSettings();

function splitList(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

if (!startupSettings.hardwareDecoding) {
    app.disableHardwareAcceleration();
} else {
    // Force high-quality rendering and GPU usage
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');

    // Video accel features (same names VacuumTube uses; unknown names are ignored by Chromium)
    const enableFeatures = new Set(splitList(app.commandLine.getSwitchValue('enable-features')));
    enableFeatures.add('AcceleratedVideoDecoder');
    enableFeatures.add('AcceleratedVideoEncoder');
    app.commandLine.appendSwitch('enable-features', [...enableFeatures].join(','));
}

app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Ensures the app renders at the correct device scale factor (useful for 4K screens)
app.commandLine.appendSwitch('force-device-scale-factor', '1');


let isQuitting = false;

app.on('before-quit', () => {
    isQuitting = true;
});

// Listen for the confirm-exit message from the renderer (preload)
ipcMain.on('confirm-exit', () => {
    app.quit();
});

ipcMain.on('open-settings', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.loadFile(path.join(__dirname, 'settings.html'));
});

ipcMain.on('get-feature-flags', (event) => {
    // sendSync from preload.js: it must be synchronous so hooks are in place before YouTube's scripts run
    event.returnValue = getFeatureFlags();
});

ipcMain.on('get-app-version', (event) => {
    // sendSync from preload.js: needed at document start for the startup version overlay
    event.returnValue = app.getVersion();
});

ipcMain.on('get-settings', (event) => {
    // Send current settings back to renderer (appVersion comes from package.json, not the ini)
    event.sender.send('return-settings', { ...loadSettings(), appVersion: app.getVersion() });
});

ipcMain.on('close-settings', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.loadURL('https://www.youtube.com/tv');
});

ipcMain.on('apply-settings', (event, newSettings) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        // Construct the full settings object by merging with existing
        const currentSettings = loadSettings();
        const settingsToSave = {
            ...currentSettings,
            width: newSettings.resolution.w,
            height: newSettings.resolution.h,
            fullscreen: newSettings.fullscreen,
            showUrl: newSettings.showUrl
        };

        // Feature toggles: only known keys, only real booleans
        const toggles = (newSettings && newSettings.toggles) || {};
        for (const key of TOGGLE_KEYS) {
            if (typeof toggles[key] === 'boolean') settingsToSave[key] = toggles[key];
        }

        saveSettings(settingsToSave);

        // Startup-only settings (Chromium switches) need a fresh process
        if (settingsToSave.hardwareDecoding !== currentSettings.hardwareDecoding) {
            app.relaunch();
            app.exit(0);
            return;
        }

        win.setFullScreen(settingsToSave.fullscreen);
        if (!settingsToSave.fullscreen) {
            win.setSize(settingsToSave.width, settingsToSave.height);
            win.center();
        }
        // After applying, go back to app
        win.loadURL('https://www.youtube.com/tv');
    }
});

ipcMain.on('reset-app', async (event) => {
    // 1. Delete settings.ini
    try {
        if (fs.existsSync(settingsPath)) {
            fs.unlinkSync(settingsPath);
        }
    } catch (e) {
        console.error('Error deleting settings.ini:', e);
    }

    // 2. Clear Session Data
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        try {
            await win.webContents.session.clearStorageData({
                storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
            });
            await win.webContents.session.clearCache();
        } catch (e) {
             console.error('Error clearing session data:', e);
        }
    }
    
    // 3. Restart
    app.relaunch();
    app.exit();
});


// Handle the Renderer's request to check if closing is allowed
ipcMain.on('renderer-check-close', (event) => {
    // If the exit was initiated by the "Exit" menu button/IPC
    if (isQuitting) {
        // Force close, bypassing the 'beforeunload' listener we just triggered
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.destroy();
        app.quit();
        return;
    }

    // Otherwise, it was an external close attempt (Back button, Alt+F4)
    // Redirect to the exit page (acting as a main menu)
    const win = BrowserWindow.fromWebContents(event.sender);
    
    // Validate we are not already on the exit page to avoid loops
    const currentUrl = win.webContents.getURL().toLowerCase();
    if (currentUrl.includes('exit.html')) {
        return; 
    }

    // Tell renderer to unlock navigation protection
    win.webContents.send('force-allow-nav');
    
    // Small delay to ensure renderer processes the unlock before we force navigation
    setTimeout(() => {
        if (win && !win.isDestroyed()) {
            win.loadFile(path.join(__dirname, 'exit.html'));
        }
    }, 100);
});

function playStartupSound() {
    const soundPath = path.join(__dirname, 'load.mp3');
    if (fs.existsSync(soundPath)) {
        const win = new BrowserWindow({ 
            show: false,
            webPreferences: { 
                 webSecurity: false 
            } 
        });
        const fileUrl = 'file:///' + soundPath.replace(/\\/g, '/');
        const html = `
            <html>
                <body>
                    <audio id="player" src="${fileUrl}" autoplay></audio>
                    <script>
                        const player = document.getElementById('player');
                        player.volume = 0.8;
                    </script>
                </body>
            </html>
        `;
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        
        // Destroy after 15 seconds
        setTimeout(() => {
            if (!win.isDestroyed()) win.destroy();
        }, 15000);
    }
}

function createWindow() {
    const settings = loadSettings();
    // --debug-gpu: normal window and free exit, so chrome://gpu can be read and closed
    if (debugGpu) isQuitting = true;
    const mainWindow = new BrowserWindow({
        width: settings.width,
        height: settings.height,
        fullscreen: !debugGpu && settings.fullscreen,
        kiosk: !debugGpu && settings.fullscreen, // Enable Kiosk mode if fullscreen is requested
        frame: debugGpu, // Frameless for TV feel (framed only for --debug-gpu)
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Set a TV user agent to ensure the TV interface is loaded or treated as such
    // Load User Agent from settings
    const tvUserAgent = settings.userAgent;
    mainWindow.webContents.userAgent = tvUserAgent;

    if (openDevTools) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    // Diagnostics: show Chromium's GPU status instead of YouTube TV
    if (debugGpu) {
        mainWindow.loadURL('chrome://gpu');
        return;
    }

    // Directly load YouTube TV. 
    // We rely on the 'close' event handler to show the Exit Menu, rather than history navigation.
    mainWindow.loadURL('https://www.youtube.com/tv');
    
    // Apply overlay settings on startup
    mainWindow.webContents.once('did-finish-load', () => {
         mainWindow.webContents.send('configure-overlay', { showUrl: settings.showUrl });
    });

    // Inject CSS to hide the cursor
    mainWindow.webContents.on('did-finish-load', () => {
        // Only inject cursor hiding on the main YT page or similar, not necessarily exit page if we want explicit mouse support (though app is keyboard driven)
        mainWindow.webContents.insertCSS('body { cursor: none !important; }');
    });

    // Handle standard close events (like Alt+F4)
    mainWindow.on('close', (e) => {
        // Since we are handling everything via 'beforeunload' in renderer + 'renderer-check-close' IPC,
        // we can let this standard event propagate IF isQuitting is true.
        // However, if isQuitting is false, 'beforeunload' should have caught it.
        // If we get here with isQuitting=false, it means 'beforeunload' didn't fire (rare)
        // or we need to block it just in case.
        if (!isQuitting) {
            e.preventDefault();
            
            // Force redirect to exit page if we somehow got here
            const url = mainWindow.webContents.getURL().toLowerCase();
            if (!url.includes('exit.html')) {
                console.log('Force redirecting to Exit Page from close handler');
                mainWindow.webContents.send('force-allow-nav');
                setTimeout(() => {
                     if (mainWindow && !mainWindow.isDestroyed()) {
                         mainWindow.loadFile(path.join(__dirname, 'exit.html'));
                     }
                }, 100);
            }
        }
    });

    ipcMain.on('return-to-tv', () => {
         // Reload settings to ensure any changes (e.g. userAgent) are applied
         const newSettings = loadSettings();
         
         // Apply visual settings
         if (mainWindow) {
             mainWindow.setFullScreen(newSettings.fullscreen);
             if (!newSettings.fullscreen) {
                 mainWindow.setSize(newSettings.width, newSettings.height);
                 mainWindow.center();
             }
             mainWindow.webContents.userAgent = newSettings.userAgent;
             mainWindow.loadURL('https://www.youtube.com/tv');
             
             // Send configuration to renderer once loaded
             mainWindow.webContents.once('did-finish-load', () => {
                 mainWindow.webContents.send('configure-overlay', { showUrl: newSettings.showUrl });
             });
         }
    });

    // Input Debounce Implementation
    // Prevents accidental double-clicks or rapid repetition
    let lastInputTime = 0;
    const debounceDelay = settings.inputDebounce || 150;

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown') {
            const now = Date.now();
            if (now - lastInputTime < debounceDelay) {
                event.preventDefault();
                return;
            }
            lastInputTime = now;

            const url = mainWindow.webContents.getURL().toLowerCase();
            const isExitPage = url.includes('exit.html');

            // ON EXIT PAGE: Strict Locking
            if (isExitPage) {
                if (input.key === 'BrowserBack' || input.key === 'Backspace' || input.key === 'ArrowLeft') {
                    event.preventDefault(); // Dead-end the event
                }
                return;
            }

            // ON YOUTUBE TV: Remap Back to Escape
            if (input.key === 'BrowserBack' || input.key === 'Backspace') {
                const url = mainWindow.webContents.getURL();
                
                // If we are at the root (Startup or Home), Back should open the Exit Menu
                // Checks for .../tv, .../tv/, .../tv#, .../tv/#
                if (/https:\/\/www\.youtube\.com\/tv\/?(#\/?)?$/.test(url)) {
                    event.preventDefault();
                    // Force redirect to Exit
                    mainWindow.webContents.send('force-allow-nav');
                    setTimeout(() => {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.loadFile(path.join(__dirname, 'exit.html'));
                        }
                    }, 100);
                    return;
                }

                event.preventDefault(); // Stop default browser back
                mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
                mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            }
        }
    });

    // Handle Windows App Commands (Multimedia keys, Mouse Back specific events)
    mainWindow.on('app-command', (e, cmd) => {
        if (cmd === 'browser-backward') {
            e.preventDefault(); // Always block the native back command to prevent accidental history nav
            
            const url = mainWindow.webContents.getURL().toLowerCase();
            if (url.includes('exit.html')) {
                // Do nothing on exit page (event is already blocked above)
            } else {
                // Send Escape to app to go back in UI
                mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
                mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
            }
        }
    });

    // Handle navigation events if necessary, though /tv is a SPA
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        // If the app is closing, this might not fire or matter, but if it's running it prevents duplicates.
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const win = windows[0];
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    app.whenReady().then(() => {
        createWindow();
        playStartupSound();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
