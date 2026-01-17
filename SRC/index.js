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

// Force high-quality rendering and GPU usage
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('high-dpi-support', '1');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Ensures the app renders at the correct device scale factor (useful for 4K screens)
app.commandLine.appendSwitch('force-device-scale-factor', '1'); 

// Set settings.ini path: Next to executable in Prod, or in source root in Dev
const settingsPath = app.isPackaged 
    ? path.join(path.dirname(process.execPath), 'settings.ini') 
    : path.join(__dirname, 'settings.ini');

// Default Settings
const defaultSettings = {
    width: 1920,
    height: 1080,
    fullscreen: true,
    userAgent: 'Mozilla/5.0 (PS4; Leanback Shell) Cobalt/22.2.3-gold Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)',
    inputDebounce: 150,
    showUrl: false
};

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
            if (val === 'true') config[key] = true;
            else if (val === 'false') config[key] = false;
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

ipcMain.on('get-settings', (event) => {
    // Send current settings back to renderer
    event.sender.send('return-settings', loadSettings());
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

        saveSettings(settingsToSave);

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
    const mainWindow = new BrowserWindow({
        width: settings.width,
        height: settings.height,
        fullscreen: settings.fullscreen,
        kiosk: settings.fullscreen, // Enable Kiosk mode if fullscreen is requested
        frame: false, // Frameless for TV feel
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
