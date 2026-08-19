const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getCatalog:        () => ipcRenderer.invoke('get-catalog'),
    getLauncherVersion:() => ipcRenderer.invoke('get-launcher-version'),
    getSystemInfo:     () => ipcRenderer.invoke('get-system-info'),
    getServerStatus:   (packData) => ipcRenderer.invoke('get-server-status', packData),
    loginMicrosoft:    () => ipcRenderer.send('login-microsoft'),
    autoLogin:         () => ipcRenderer.send('auto-login'),
    logout:            () => ipcRenderer.invoke('logout'),
    launchGame:        (packData) => ipcRenderer.send('launch-game', packData),
    syncNow:           (packData) => ipcRenderer.send('sync-now', packData),
    openFolder:        (type, packId) => ipcRenderer.send('open-folder', type, packId),
    resetDefaults:     (packId) => ipcRenderer.send('reset-defaults', packId),
    checkUpdate:       () => ipcRenderer.send('check-update'),
    downloadUpdate:    () => ipcRenderer.send('download-update'),
    installUpdate:     () => ipcRenderer.send('install-update'),

    // --- Diagnostic & support -------------------------------------------
    getDiagnostics:    (packData) => ipcRenderer.invoke('get-diagnostics', packData),
    saveDiagnostics:   (packData) => ipcRenderer.invoke('save-diagnostics', packData),
    openLogsFolder:    () => ipcRenderer.send('open-logs-folder'),
    testVoiceChat:     (packData) => ipcRenderer.invoke('test-voicechat', packData),

    onAuthSuccess:        (cb) => ipcRenderer.on('auth-success',         (_, d) => cb(d)),
    onAuthError:          (cb) => ipcRenderer.on('auth-error',           (_, d) => cb(d)),
    onAuthMissing:        (cb) => ipcRenderer.on('auth-missing',         () => cb()),
    onSyncStatus:         (cb) => ipcRenderer.on('sync-status',          (_, d) => cb(d)),
    onSyncProgress:       (cb) => ipcRenderer.on('sync-progress',        (_, d) => cb(d)),
    onSyncDone:           (cb) => ipcRenderer.on('sync-done',            () => cb()),
    onLaunchError:        (cb) => ipcRenderer.on('launch-error',         (_, d) => cb(d)),
    onDefaultsReset:      (cb) => ipcRenderer.on('defaults-reset',       () => cb()),

    // --- Cycle de vie du jeu ---------------------------------------------
    onGameLaunching:      (cb) => ipcRenderer.on('game-launching',       (_, d) => cb(d)),
    onGameStarted:        (cb) => ipcRenderer.on('game-started',         (_, d) => cb(d)),
    onGameClosed:         (cb) => ipcRenderer.on('game-closed',          (_, d) => cb(d)),
    onRamClamped:         (cb) => ipcRenderer.on('ram-clamped',          (_, d) => cb(d)),

    onUpdateAvailable:    (cb) => ipcRenderer.on('update-available',     (_, d) => cb(d)),
    onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', () => cb()),
    onUpdateProgress:     (cb) => ipcRenderer.on('update-progress',      (_, d) => cb(d)),
    onUpdateDownloaded:   (cb) => ipcRenderer.on('update-downloaded',    () => cb()),
    onUpdateError:        (cb) => ipcRenderer.on('update-error',         (_, d) => cb(d))
});
