// ===========================================================================
// TimeRift-Launcher — process principal Electron
// v2 : logs persistants + rapport de diagnostic, test voice chat,
//      réseau durci (timeouts/retries/DoH), auth Microsoft robuste.
// ===========================================================================
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const cp = require('child_process');
const log = require('electron-log');
const AdmZip = require('adm-zip');
const tar = require('tar');
const { Client } = require('minecraft-launcher-core');
const { Auth } = require('msmc');
const { fetchCatalog, syncMods, syncDatapacks, syncShaderpacks, syncResourcepacks } = require('./modSync');
const { fetchWithRedirect, dnsDiagnostic, safeLookup } = require('./netUtils');
const { pingServer } = require('./mcPing');
require('./migrate')(app, ['SUS-Launcher','sus-launcher'], ['instances/pack_timerift','java/jre17'], ['msmc-auth.json']);

// --- HACK/PATCH : Corriger les bugs internes de minecraft-launcher-core ---
const origSpawn = cp.spawn;
let activeForgeVersionForPatch = null;

cp.spawn = function(command, args, options) {
    if (args && Array.isArray(args)) {
        // 1. Corriger le bug du "version.json" de Forge 1.20.1 qui force 47.4.0
        const fmlIdx = args.indexOf('--fml.forgeVersion');
        if (fmlIdx !== -1 && activeForgeVersionForPatch) {
            args[fmlIdx + 1] = activeForgeVersionForPatch;
        }

        // 2. Corriger le crash Java 17/21 (InaccessibleObjectException)
        // On trouve où commence la classe principale pour insérer les arguments JVM juste avant
        const mainClassIdx = args.findIndex(a => a && !a.startsWith('-') && (a.includes('.Main') || a.includes('ClientMain') || a === 'net.minecraft.client.main.Main'));

        if (mainClassIdx !== -1 && !args.some(a => a.includes('java.lang.invoke=ALL-UNNAMED'))) {
            const jvmArgs = [
                '--add-modules', 'jdk.incubator.vector',
                '--add-exports', 'java.base/sun.security.util=ALL-UNNAMED',
                '--add-opens', 'java.base/java.util.jar=ALL-UNNAMED',
                '--add-opens', 'java.base/java.lang.invoke=ALL-UNNAMED',
                '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
                '--add-opens', 'java.base/java.net=ALL-UNNAMED',
                '--add-opens', 'java.base/java.nio=ALL-UNNAMED',
                '--add-opens', 'java.base/java.util=ALL-UNNAMED',
                '--add-opens', 'java.base/java.util.concurrent.atomic=ALL-UNNAMED'
            ];
            args.splice(mainClassIdx, 0, ...jvmArgs);
        }
    }
    return origSpawn.call(this, command, args, options);
};
const spawn = cp.spawn; // Pour le test voicechat qui utilise spawn
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Logs : tout (launcher + sortie Minecraft) part dans un fichier rotatif.
// C'est la matière première du bouton "Copier le rapport".
// ---------------------------------------------------------------------------
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 Mo puis rotation
log.transports.file.level = 'info';
Object.assign(console, log.functions); // console.log/error → fichier + terminal

// Tampon circulaire de la sortie Minecraft (pour le rapport, sans relire le disque)
const MC_BUFFER_MAX = 400;
const mcOutputBuffer = [];
function pushMcLine(line) {
    const clean = String(line).trimEnd();
    if (!clean) return;
    mcOutputBuffer.push(clean);
    if (mcOutputBuffer.length > MC_BUFFER_MAX) mcOutputBuffer.shift();
}

process.on('uncaughtException', (err) => {
    log.error('[FATAL]', err);
});
process.on('unhandledRejection', (reason) => {
    log.error('[UNHANDLED REJECTION]', reason);
});

// ---------------------------------------------------------------------------
// Instance unique : deux launchers ouverts = deux jeux + fichiers verrouillés.
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
    app.exit(0);   // exit(0) et pas quit() : quit() laisse le reste du module s'exécuter
}
app.on('second-instance', () => {
    // La fenêtre peut avoir été détruite : sans ce garde, un second lancement
    // plantait et donnait l'impression que le launcher "ne démarre pas".
    if (currentWindow && !currentWindow.isDestroyed()) {
        if (currentWindow.isMinimized()) currentWindow.restore();
        currentWindow.show();
        currentWindow.focus();
    } else {
        createWindow();
    }
});

const launcher = new Client();
let mcToken = null;
let mcTokenTimestamp = 0;      // pour rafraîchir un token trop vieux avant lancement
let currentWindow = null;
let isLaunching = false;       // anti double-clic sur JOUER
let lastSelectedPackName = ''; // contexte pour le rapport de diagnostic

let gameStarted = false;       // le jeu est-il réellement affiché ?
let gameStartTime = 0;
let gameStartTimer = null;     // repli si aucune ligne de démarrage n'est détectée
let isAuthenticating = false;  // anti double-clic sur CONNEXION

const TOKEN_MAX_AGE_MS = 50 * 60 * 1000; // les tokens MC expirent ~1h ; marge de sécurité

// Envoi sûr vers le renderer : la fenêtre peut avoir été fermée entre-temps.
function sendToWindow(channel, payload) {
    try {
        if (currentWindow && !currentWindow.isDestroyed()) {
            currentWindow.webContents.send(channel, payload);
        }
    } catch (e) { /* fenêtre en cours de destruction */ }
}

// ---------------------------------------------------------------------------
// RAM : allouer plus que la mémoire physique fait planter la JVM au démarrage
// avec un message incompréhensible. On plafonne systématiquement.
// ---------------------------------------------------------------------------
function ramLimits() {
    const totalGb = os.totalmem() / (1024 * 1024 * 1024);
    // On laisse 2 Go au système et au launcher lui-même.
    const maxSafe = Math.max(2, Math.min(32, Math.floor(totalGb - 2)));
    const recommended = Math.max(2, Math.min(8, Math.floor(totalGb / 2)));
    return { totalGb: Math.round(totalGb * 10) / 10, maxSafe, recommended };
}

function clampRam(requested) {
    const { maxSafe, totalGb } = ramLimits();
    const asked = parseInt(requested) || 4;
    const ram = Math.max(2, Math.min(asked, maxSafe));
    return { ram, asked, clamped: ram !== asked, maxSafe, totalGb };
}

// Espace disque : un téléchargement de mods qui remplit le disque laisse des
// fichiers tronqués et un jeu qui ne démarre plus.
function freeSpaceGb(dir) {
    try {
        let probe = dir;
        while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
        const st = fs.statfsSync(probe);
        return (st.bavail * st.bsize) / (1024 * 1024 * 1024);
    } catch (e) {
        return null;   // système de fichiers exotique : on ne bloque pas
    }
}

// Traduit les erreurs techniques en langage compréhensible par un joueur.
function humanizeError(err) {
    const msg = String(err && err.message ? err.message : err);
    if (/ENOSPC|no space left/i.test(msg))
        return "Disque plein. Libère de la place puis relance.";
    if (/EACCES|EPERM|operation not permitted/i.test(msg))
        return "Accès refusé à un fichier du jeu. Ferme Minecraft s'il tourne déjà, " +
               "et vérifie que ton antivirus ne bloque pas le dossier du launcher.";
    if (/EBUSY|resource busy|locked/i.test(msg))
        return "Un fichier du jeu est verrouillé. Ferme Minecraft puis réessaie.";
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Invalid IP|Résolution impossible/i.test(msg))
        return "Impossible de joindre le serveur de téléchargement. Vérifie ta connexion " +
               "Internet, ou configure les DNS 1.1.1.1 et 8.8.8.8 dans Windows.";
    if (/ETIMEDOUT|Timeout réseau|Transfert bloqué/i.test(msg))
        return "La connexion est trop lente ou coupée. Réessaie, le téléchargement " +
               "reprend là où il s'est arrêté.";
    if (/Fichier corrompu/i.test(msg))
        return msg + " — relance simplement, le fichier sera retéléchargé.";
    if (/Installer Forge introuvable/i.test(msg))
        return "La version de Forge du modpack est introuvable. Préviens l'admin du serveur.";
    if (/Java|jre|jdk/i.test(msg))
        return "Problème avec Java : " + msg + ". Va dans Paramètres → Diagnostic pour " +
               "envoyer le rapport.";
    return msg;
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = log;

autoUpdater.on('update-available', (info) => {
    if (currentWindow) currentWindow.webContents.send('update-available', { version: info.version });
});
autoUpdater.on('update-not-available', () => {
    if (currentWindow) currentWindow.webContents.send('update-not-available');
});
autoUpdater.on('download-progress', (progress) => {
    if (currentWindow) currentWindow.webContents.send('update-progress', { pct: Math.round(progress.percent) });
});
autoUpdater.on('update-downloaded', () => {
    if (currentWindow) currentWindow.webContents.send('update-downloaded');
});
autoUpdater.on('error', (err) => {
    const msg = String(err && err.message ? err.message : err);
    // Aucune release publiée sur le dépôt : ce n'est pas une panne, juste
    // "rien à télécharger". Inutile d'alarmer le joueur.
    if (/404|Cannot find latest|latest\.yml/i.test(msg)) {
        log.info('[Updater] aucune release publiée pour le moment');
        sendToWindow('update-not-available');
        return;
    }
    log.error('[Updater]', msg);
    sendToWindow('update-error', msg);
});

launcher.on('debug', (e) => { log.info('[MC]', e); pushMcLine('[debug] ' + e); });
launcher.on('data',  (e) => { pushMcLine(e); detectGameStarted(e); });
launcher.on('close', (code) => {
    const durationMs = gameStartTime ? Date.now() - gameStartTime : 0;
    log.info('[MC] Jeu fermé, code', code, '- durée', Math.round(durationMs / 1000) + 's');
    pushMcLine('[launcher] Jeu fermé avec le code ' + code);
    isLaunching = false;
    gameStarted = false;
    gameStartTime = 0;
    if (gameStartTimer) { clearTimeout(gameStartTimer); gameStartTimer = null; }
    sendToWindow('game-closed', {
        code,
        durationMs,
        // Un code non nul juste après le démarrage = crash. Fermé normalement
        // par le joueur, Minecraft renvoie 0.
        crashed: code !== 0 && code !== null,
        hint: crashHint(code, durationMs)
    });
});

// --- Détection « le jeu est réellement affiché » ---------------------------
// MCLC rend la main dès que le process Java est lancé, or il se passe 20 à 60
// secondes avant que la fenêtre apparaisse. On guette les lignes que Minecraft
// écrit quand il est vraiment prêt, pour ne pas laisser le launcher afficher
// « synchronisation » alors que le jeu tourne.
const GAME_READY_PATTERNS = [
    /Setting user:/i,
    /Sound engine started/i,
    /Backend library: LWJGL/i,
    /OpenAL initialized/i,
    /Created:.*minecraft:textures/i,
    /Narrator library for x64 successfully loaded/i
];

function detectGameStarted(line) {
    if (gameStarted || !isLaunching) return;
    const text = String(line);
    if (GAME_READY_PATTERNS.some(re => re.test(text))) markGameStarted();
}

function markGameStarted() {
    if (gameStarted) return;
    gameStarted = true;
    gameStartTime = Date.now();
    if (gameStartTimer) { clearTimeout(gameStartTimer); gameStartTimer = null; }
    log.info('[MC] Jeu démarré');
    sendToWindow('game-started', {});
}

function crashHint(code, durationMs) {
    if (code === 0 || code === null) return null;
    if (durationMs > 0 && durationMs < 25000) {
        return "Le jeu s'est arrêté tout de suite. C'est presque toujours un mod " +
               "en conflit ou trop peu de RAM. Ouvre Paramètres → Diagnostic → " +
               "Copier le rapport et envoie-le sur Discord.";
    }
    return "Le jeu s'est fermé avec le code " + code + ". Si ce n'était pas volontaire, " +
           "envoie le rapport de diagnostic sur Discord.";
}
launcher.on('error', (e) => {
    log.error('[MC ERREUR]', e);
    pushMcLine('[erreur] ' + e);
    isLaunching = false;
    if (currentWindow) currentWindow.webContents.send('launch-error', String(e));
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1080, height: 700,
        minWidth: 900, minHeight: 600,
        backgroundColor: '#06060f',   // évite le flash blanc au démarrage
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
                                  contextIsolation: true,
                                  nodeIntegration: false,
                                  spellcheck: false
        }
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.on('render-process-gone', (_e, details) => {
        log.error('[Renderer] process perdu :', JSON.stringify(details));
    });
    // Les liens externes s'ouvrent dans le navigateur, pas dans le launcher.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.on('closed', () => { if (currentWindow === win) currentWindow = null; });
    win.loadFile(path.join(__dirname, 'index.html'));
    currentWindow = win;
    return win;
}

app.whenReady().then(() => {
    const { totalGb } = ramLimits();
    log.info('=== TimeRift-Launcher v' + app.getVersion() + ' démarré (' + process.platform + ' ' +
             os.release() + ', ' + totalGb + ' Go RAM) ===');
    createWindow();
    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(err => log.error('[Updater check]', err.message));
    }, 3000);
});

// Sans ce handler, fermer la fenêtre laissait le process en vie : le verrou
// d'instance unique bloquait alors tout nouveau lancement, et le launcher
// "ne démarrait plus" jusqu'au redémarrage du PC.
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('check-update', () => {
    autoUpdater.checkForUpdates().catch(err => log.error('[Updater]', err.message));
});
ipcMain.on('download-update', () => {
    autoUpdater.downloadUpdate().catch(err => log.error('[Updater]', err.message));
});
ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
});

ipcMain.handle('get-catalog', async () => {
    try {
        const catalog = await fetchCatalog();
        return { success: true, catalog };
    } catch (err) {
        log.error('[Catalog]', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-launcher-version', () => app.getVersion());

// Le renderer en a besoin pour borner le curseur de RAM sur la machine réelle.
ipcMain.handle('get-system-info', () => {
    const limits = ramLimits();
    return {
        totalRamGb: limits.totalGb,
        maxRamGb: limits.maxSafe,
        recommendedRamGb: limits.recommended,
        platform: process.platform,
        cpuCount: os.cpus().length,
        freeDiskGb: Math.round((freeSpaceGb(app.getPath('userData')) || 0) * 10) / 10
    };
});

// État du serveur multijoueur (affiché sur l'accueil).
ipcMain.handle('get-server-status', async (event, packData) => {
    const pack = packData || {};
    const target = pack.server_host || '';
    if (!target) return { online: false, error: 'aucun serveur configuré' };
    const [host, portStr] = target.split(':');
    try {
        const res = await pingServer(host, parseInt(portStr || '25565'));
        return { ...res, host, port: parseInt(portStr || '25565') };
    } catch (err) {
        return { online: false, error: err.message };
    }
});

// Déconnexion : indispensable quand une session Microsoft se retrouve coincée.
ipcMain.handle('logout', () => {
    try {
        const p = authFilePath();
        if (fs.existsSync(p)) fs.unlinkSync(p);
        mcToken = null;
        mcTokenTimestamp = 0;
        log.info('[Auth] Session supprimée à la demande du joueur');
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// ---------------------------------------------------------------------------
// Auth Microsoft — durcie.
// ---------------------------------------------------------------------------
function authFilePath() {
    return path.join(app.getPath('userData'), 'msmc-auth.json');
}

function readSavedAuth() {
    const p = authFilePath();
    if (!fs.existsSync(p)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return (data && data.refresh_token) ? data : null;
    } catch (e) {
        log.error('[Auth] Fichier auth corrompu, suppression :', e.message);
        try { fs.unlinkSync(p); } catch (e2) {}
        return null;
    }
}

function saveAuth(msToken) {
    try {
        if (msToken && msToken.refresh_token) {
            fs.writeFileSync(authFilePath(), JSON.stringify(msToken));
        }
    } catch (e) {
        log.error('[Auth] Sauvegarde impossible :', e.message);
    }
}

function isNetworkError(err) {
    return /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|socket hang up|getaddrinfo/i
        .test(String(err && err.message ? err.message : err));
}

// Une session peut être refusée définitivement (mot de passe changé, accès
// révoqué) : dans ce cas on efface le fichier, sinon le joueur reste bloqué
// sur "erreur de connexion" à chaque démarrage sans jamais pouvoir se
// reconnecter proprement.
function isRevokedSession(err) {
    return /invalid_grant|invalid_token|unauthorized|expired|AADSTS/i
        .test(String(err && err.message ? err.message : err));
}

async function refreshFromSaved() {
    const saved = readSavedAuth();
    if (!saved) throw new Error('Aucune session sauvegardée');

    let lastErr;
    // Deux tentatives : un timeout réseau isolé ne doit pas déconnecter le joueur.
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const authManager = new Auth('select_account');
            const xboxManager = await authManager.refresh(saved.refresh_token);
            mcToken = await xboxManager.getMinecraft();
            mcTokenTimestamp = Date.now();
            saveAuth(xboxManager.msToken);
            return mcToken;
        } catch (err) {
            lastErr = err;
            if (isRevokedSession(err)) {
                try { fs.unlinkSync(authFilePath()); } catch (e) {}
                log.info('[Auth] Session révoquée, fichier supprimé');
                break;
            }
            if (attempt < 2 && isNetworkError(err)) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            break;
        }
    }
    throw lastErr;
}

ipcMain.on('auto-login', async (event) => {
    try {
        const token = await refreshFromSaved();
        event.sender.send('auth-success', { name: token.profile.name });
    } catch (err) {
        // Panne réseau ≠ session expirée : dans le premier cas la session est
        // toujours bonne, on propose de réessayer au lieu d'imposer une
        // reconnexion Microsoft complète.
        if (isNetworkError(err) && readSavedAuth()) {
            log.info('[AutoLogin] Réseau indisponible :', err.message);
            event.sender.send('auth-error', {
                message: 'Pas de connexion Internet — impossible de vérifier ta session.',
                    retryable: true
            });
        } else {
            log.info('[AutoLogin] Session absente ou expirée :', err.message);
            event.sender.send('auth-missing');
        }
    }
});

ipcMain.on('login-microsoft', async (event) => {
    // Un double-clic ouvrait deux fenêtres Microsoft, dont l'une restait
    // bloquée : c'est la panne de login la plus fréquente.
    if (isAuthenticating) {
        log.info('[Login] Connexion déjà en cours, clic ignoré');
        return;
    }
    isAuthenticating = true;
    try {
        const authManager = new Auth('select_account');
        const xboxManager = await authManager.launch('electron');
        mcToken = await xboxManager.getMinecraft();
        mcTokenTimestamp = Date.now();
        saveAuth(xboxManager.msToken);
        log.info('[Login] Connecté :', mcToken.profile.name);
        event.sender.send('auth-success', { name: mcToken.profile.name });
    } catch (err) {
        log.error('[Login]', err.message);
        const raw = String(err.message || err);
        let message = raw;
        if (/cancel|closed|user closed/i.test(raw)) {
            message = 'Connexion annulée.';
        } else if (isNetworkError(err)) {
            message = 'Problème réseau pendant la connexion Microsoft. Vérifie ta connexion, ' +
                      'ou configure les DNS 1.1.1.1 et 8.8.8.8, puis réessaie.';
        } else if (/does not own|not own minecraft|entitlement/i.test(raw)) {
            message = 'Ce compte Microsoft ne possède pas Minecraft Java Edition. ' +
                      'Vérifie que tu utilises le bon compte.';
        } else if (/child|profile/i.test(raw)) {
            message = 'Ce compte est un compte enfant sans profil Minecraft, ou son profil ' +
                      "n'est pas encore créé. Ouvre minecraft.net une fois avec ce compte.";
        }
        event.sender.send('auth-error', { message });
    } finally {
        isAuthenticating = false;
    }
});

ipcMain.on('open-folder', (event, type, packId) => {
    if (!packId) return;
    const baseDir = path.join(app.getPath('userData'), 'instances', packId);
    const dirs = {
        mods:          path.join(baseDir, 'mods'),
           datapacks:     path.join(baseDir, 'datapacks'),
           shaderpacks:   path.join(baseDir, 'shaderpacks'),
           resourcepacks: path.join(baseDir, 'resourcepacks'),
           screenshots:   path.join(baseDir, 'screenshots'),
           game:          baseDir
    };
    const target = dirs[type] || dirs.game;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    shell.openPath(target);
});

ipcMain.on('reset-defaults', (event, packId) => {
    if (!packId) return;
    const gameDir = path.join(app.getPath('userData'), 'instances', packId);
    const markerPath = path.join(gameDir, '.defaults_installed');
    if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
        log.info('[MC] Marker defaults supprimé pour ' + packId);
    }
    event.sender.send('defaults-reset');
});

// ---------------------------------------------------------------------------
// DIAGNOSTIC : rapport de logs + tests réseau
// ---------------------------------------------------------------------------
function tail(filePath, maxLines) {
    try {
        if (!fs.existsSync(filePath)) return '(fichier absent)';
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        return lines.slice(-maxLines).join('\n');
    } catch (e) {
        return '(illisible : ' + e.message + ')';
    }
}

function findLatestGameLog(packId) {
    if (!packId) return null;
    const p = path.join(app.getPath('userData'), 'instances', packId, 'logs', 'latest.log');
    return fs.existsSync(p) ? p : null;
}

async function buildDiagnosticReport(packData) {
    const lines = [];
    const pack = packData || {};
    lines.push('===== RAPPORT TIMERIFT-LAUNCHER =====');
    lines.push('Date          : ' + new Date().toISOString());
    lines.push('Launcher      : v' + app.getVersion());
    lines.push('OS            : ' + process.platform + ' ' + os.release() + ' (' + process.arch + ')');
    lines.push('RAM machine   : ' + Math.round(os.totalmem() / 1024 / 1024 / 1024) + ' Go');
    lines.push('Modpack       : ' + (pack.name || lastSelectedPackName || '(aucun)'));
    lines.push('Connecté      : ' + (mcToken ? mcToken.profile.name : 'non'));
    lines.push('');

    lines.push('--- Tests DNS (système vs Cloudflare/Google) ---');
    const hostsToTest = [
        'raw.githubusercontent.com',
        pack.server_host ? pack.server_host.split(':')[0] : 'timerift.mekhorizon.org',
        (pack.voice_test || 'taken-gig.nyc.at.playit.plus:1088').split(':')[0]
    ];
    for (const h of [...new Set(hostsToTest)]) {
        try {
            const d = await dnsDiagnostic(h);
            lines.push(h + ' → système: ' + (d.system || ('ÉCHEC ' + d.systemError)) +
            ' | DoH: ' + (d.doh || ('ÉCHEC ' + d.dohError)));
        } catch (e) {
            lines.push(h + ' → erreur test : ' + e.message);
        }
    }
    lines.push('');

    lines.push('--- Dernières lignes du log launcher ---');
    lines.push(tail(log.transports.file.getFile().path, 120));
    lines.push('');

    lines.push('--- Sortie Minecraft (session en cours) ---');
    lines.push(mcOutputBuffer.length ? mcOutputBuffer.slice(-150).join('\n') : '(aucune session lancée)');
    lines.push('');

    const gameLog = findLatestGameLog(pack.id);
    if (gameLog) {
        lines.push('--- instances/' + pack.id + '/logs/latest.log (fin) ---');
        lines.push(tail(gameLog, 150));
    }

    lines.push('===== FIN DU RAPPORT =====');
    return lines.join('\n');
}

ipcMain.handle('get-diagnostics', async (event, packData) => {
    try {
        const report = await buildDiagnosticReport(packData);
        clipboard.writeText(report);
        return { success: true, report };
    } catch (err) {
        log.error('[Diag]', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('save-diagnostics', async (event, packData) => {
    try {
        const report = await buildDiagnosticReport(packData);
        const { filePath } = await dialog.showSaveDialog(currentWindow, {
            title: 'Enregistrer le rapport',
            defaultPath: path.join(app.getPath('desktop'), 'timerift-launcher-rapport.txt'),
                filters: [{ name: 'Texte', extensions: ['txt'] }]
        });
        if (!filePath) return { success: false, error: 'annulé' };
        fs.writeFileSync(filePath, report);
        return { success: true, path: filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('open-logs-folder', () => {
    shell.openPath(path.dirname(log.transports.file.getFile().path));
});

// ---------------------------------------------------------------------------
// TEST VOICE CHAT
// ---------------------------------------------------------------------------
function tcpTest(host, port, timeoutMs = 6000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const socket = net.createConnection({ host, port, lookup: safeLookup, timeout: timeoutMs });
        socket.on('connect', () => { socket.destroy(); resolve({ ok: true, ms: Date.now() - started }); });
        socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout' }); });
        socket.on('error', (e) => { resolve({ ok: false, error: e.code || e.message }); });
    });
}

function findSvcBinary() {
    const exe = process.platform === 'win32' ? 'svc.exe' : 'svc';
    const candidates = [
        path.join(process.resourcesPath || '', 'bin', exe),
        path.join(app.getAppPath(), 'bin', exe),
        path.join(app.getPath('userData'), 'bin', exe)
    ];
    return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

function svcPing(binPath, host, port) {
    return new Promise((resolve) => {
        const SVC_ARGS = ['ping', host, '-p', String(port)];
        let output = '';
        let child;
        try {
            child = spawn(binPath, SVC_ARGS, { timeout: 20000 });
        } catch (e) {
            resolve({ ran: false, ok: false, output: 'Lancement impossible : ' + e.message });
            return;
        }
        child.stdout.on('data', d => output += d);
        child.stderr.on('data', d => output += d);
        child.on('error', (e) => resolve({ ran: false, ok: false, output: String(e.message) }));
        child.on('close', (code) => {
            resolve({ ran: true, ok: code === 0, output: output.trim() });
        });
    });
}

ipcMain.handle('test-voicechat', async (event, packData) => {
    const pack = packData || {};
    const voiceTarget = pack.voice_test || 'taken-gig.nyc.at.playit.plus:1088';
    const [voiceHost, voicePortStr] = voiceTarget.split(':');
    const voicePort = parseInt(voicePortStr || '24454');
    const mcTarget = pack.server_host || 'timerift.mekhorizon.org:25565';
    const [mcHost, mcPortStr] = mcTarget.split(':');
    const mcPort = parseInt(mcPortStr || '25565');

    const result = { voiceTarget, steps: [] };
    log.info('[VoiceTest] Démarrage pour', voiceTarget);

    const d = await dnsDiagnostic(voiceHost);
    if (d.system) {
        result.steps.push({ id: 'dns', ok: true, detail: 'DNS OK → ' + d.system });
    } else if (d.doh) {
        result.steps.push({
            id: 'dns', ok: false, warn: true,
            detail: 'TON DNS EST CASSÉ : le système ne résout pas ' + voiceHost +
            ' (' + d.systemError + ') mais Cloudflare/Google y arrivent (' + d.doh + '). ' +
            'Configure 1.1.1.1 et 8.8.8.8 dans tes paramètres réseau Windows.'
        });
    } else {
        result.steps.push({
            id: 'dns', ok: false,
            detail: 'Résolution impossible partout (' + (d.systemError || '?') + '). Pas de connexion Internet ?'
        });
    }

    const tcp = await tcpTest(mcHost, mcPort);
    result.steps.push({
        id: 'tcp', ok: tcp.ok,
        detail: tcp.ok ? ('Serveur Minecraft joignable (' + tcp.ms + ' ms)')
        : ('Serveur Minecraft injoignable en TCP : ' + tcp.error)
    });

    const bin = findSvcBinary();
    if (bin) {
        const ping = await svcPing(bin, voiceHost, voicePort);
        result.steps.push({
            id: 'udp', ok: ping.ok,
            detail: ping.ok ? ('Voice chat UDP OK — ' + ping.output)
            : ('Voice chat UDP en échec — ' + (ping.output || 'aucune réponse') +
            '. Si le DNS et le TCP sont OK, ton réseau (pare-feu, école, 4G, VPN) bloque probablement l\'UDP.')
        });
    } else {
        result.steps.push({
            id: 'udp', ok: null,
            detail: 'Test UDP indisponible (binaire svc non embarqué dans cette version du launcher).'
        });
    }

    log.info('[VoiceTest] Résultat :', JSON.stringify(result));
    return result;
});

// ---------------------------------------------------------------------------
// Assemblage des mods splittés (.partXX)
// ---------------------------------------------------------------------------
function assembleParts(modsDir, baseName, onStatus) {
    return new Promise((resolve, reject) => {
        const finalPath = path.join(modsDir, baseName);
        const writeStream = fs.createWriteStream(finalPath);
        let idx = 0;
        function writeNext() {
            const partPath = path.join(modsDir, `${baseName}.part${String(idx).padStart(2, '0')}`);
            if (!fs.existsSync(partPath)) { writeStream.end(); return; }
            const data = fs.readFileSync(partPath);
            const canContinue = writeStream.write(data);
            idx++;
            if (canContinue) { writeNext(); }
            else { writeStream.once('drain', writeNext); }
        }
        writeStream.on('finish', () => { onStatus('Assemblé : ' + baseName); resolve(); });
        writeStream.on('error', reject);
        writeNext();
    });
}

async function setupFabric(gameDir, mcVersion, loaderVersion) {
    const customName = `fabric-loader-${loaderVersion}-${mcVersion}`;
    const versionDir = path.join(gameDir, 'versions', customName);
    const jsonFile = path.join(versionDir, `${customName}.json`);
    if (fs.existsSync(jsonFile)) return customName;

    fs.mkdirSync(versionDir, { recursive: true });
    const url = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
    const res = await fetchWithRedirect(url);
    if (res.statusCode !== 200) throw new Error(`Fabric profile HTTP ${res.statusCode}`);
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(jsonFile);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
    });
    log.info('[MC] Profil Fabric installé : ' + customName);
    return customName;
}

function cleanOldForge(gameDir, mcVersion, oldForgeVersion, onStatus) {
    if (onStatus) onStatus("Nettoyage de l'ancienne version de Forge (" + oldForgeVersion + ")...");
    log.info('[MC] Purge Forge ' + oldForgeVersion + ' avant réinstallation');

    const versionsDir = path.join(gameDir, 'versions');
    if (fs.existsSync(versionsDir)) {
        try {
            fs.rmSync(versionsDir, { recursive: true, force: true });
            log.info('[MC] Supprimé versions/ (profils régénérés au prochain lancement)');
        } catch (e) { log.error('[MC] Purge versions/ : ' + e.message); }
    }

    const forgeLibs = path.join(gameDir, 'libraries', 'net', 'minecraftforge');
    if (fs.existsSync(forgeLibs)) {
        try {
            fs.rmSync(forgeLibs, { recursive: true, force: true });
            log.info('[MC] Supprimé libraries/net/minecraftforge');
        } catch (e) { log.error('[MC] Purge libs Forge : ' + e.message); }
    }

    const cacheDir = path.join(gameDir, 'cache');
    if (fs.existsSync(cacheDir)) {
        try {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            log.info('[MC] Supprimé cache/ (cache MCLC)');
        } catch (e) { log.error('[MC] Purge cache/ : ' + e.message); }
    }

    // LE FIX PRINCIPAL : MCLC/ForgeWrapper génère un version.json dans
    // <gameDir>/forge/<mcVersion>/version.json, indexé par la version
    // MINECRAFT uniquement (pas par la version Forge !). Sans cette purge,
    // un changement de loader_version dans le catalog continue de lancer
    // l'ANCIEN Forge (c'était la vraie origine du "--fml.forgeVersion 47.4.0
    // forcé" que le monkey-patch de cp.spawn essayait de contourner).
    const forgeJsonCacheDir = path.join(gameDir, 'forge');
    if (fs.existsSync(forgeJsonCacheDir)) {
        try {
            fs.rmSync(forgeJsonCacheDir, { recursive: true, force: true });
            log.info('[MC] Supprimé forge/ (version.json ForgeWrapper mis en cache par MCLC)');
        } catch (e) { log.error('[MC] Purge forge/ : ' + e.message); }
    }

    try {
        for (const f of fs.readdirSync(gameDir)) {
            if (/^forge-.*-installer\.jar$/.test(f)) {
                try { fs.unlinkSync(path.join(gameDir, f)); } catch (e) {}
            }
        }
    } catch (e) {}
}

async function setupForge(gameDir, mcVersion, forgeVersion, onStatus) {
    fs.mkdirSync(gameDir, { recursive: true });

    const fmlLoaderDir = path.join(gameDir, 'libraries', 'net', 'minecraftforge', 'fmlloader');
    const expectedFmlDir = path.join(fmlLoaderDir, `${mcVersion}-${forgeVersion}`);
    let correctFmlPresent = false;
    try {
        correctFmlPresent = fs.existsSync(expectedFmlDir) &&
        fs.readdirSync(expectedFmlDir).some(f => f.endsWith('.jar'));
    } catch (e) {}

    let anyForgeInstalled = false;
    try {
        anyForgeInstalled = fs.existsSync(fmlLoaderDir) && fs.readdirSync(fmlLoaderDir).length > 0;
    } catch (e) {}
    if (!anyForgeInstalled) {
        const versionsDir = path.join(gameDir, 'versions');
        try {
            anyForgeInstalled = fs.existsSync(versionsDir) && fs.readdirSync(versionsDir).length > 0;
        } catch (e) {}
    }

    const markerPath = path.join(gameDir, '.forge_version');

    // Détection du cache MCLC périmé. Attention : vérifier seulement la
    // présence de libraries/.../fmlloader/<mc>-<forge attendu>/ ne suffit pas,
    // car après un lancement raté en "version mixte", l'installer (lancé par
    // ForgeWrapper) a déjà créé ce dossier alors que forge/<mc>/version.json
    // pointe toujours vers l'ancienne version → l'instance reste cassée pour
    // toujours. On vérifie donc le CONTENU du cache.
    let mclcCacheStale = false;
    const mclcForgeJson = path.join(gameDir, 'forge', mcVersion, 'version.json');
    if (fs.existsSync(mclcForgeJson)) {
        try {
            const cached = JSON.parse(fs.readFileSync(mclcForgeJson, 'utf8'));
            const gameArgs = (cached.arguments && cached.arguments.game) || [];
            const idx = gameArgs.indexOf('--fml.forgeVersion');
            mclcCacheStale = (idx === -1) || (gameArgs[idx + 1] !== forgeVersion);
        } catch (e) { mclcCacheStale = true; }
    }

    if (mclcCacheStale || (anyForgeInstalled && !correctFmlPresent)) {
        cleanOldForge(gameDir, mcVersion, 'périmée', onStatus);
        try { fs.unlinkSync(markerPath); } catch (e) {}
        correctFmlPresent = false; // tout vient d'être purgé : réinstallation obligatoire
    }

    const installerName = `forge-${mcVersion}-${forgeVersion}-installer.jar`;
    const installerPath = path.join(gameDir, installerName);

    if (correctFmlPresent &&
        fs.existsSync(installerPath) && fs.statSync(installerPath).size > 0) {
        return installerPath;
        }

        const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/` +
        `${mcVersion}-${forgeVersion}/forge-${mcVersion}-${forgeVersion}-installer.jar`;
    if (onStatus) onStatus("Téléchargement de Forge " + forgeVersion + "...");
    const res = await fetchWithRedirect(url);
    if (res.statusCode !== 200) {
        throw new Error(`Installer Forge introuvable (HTTP ${res.statusCode}) pour ${mcVersion}-${forgeVersion}`);
    }
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(installerPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', (err) => { fs.unlink(installerPath, () => {}); reject(err); });
    });
    log.info('[MC] Installer Forge téléchargé : ' + installerName);

    try { fs.writeFileSync(markerPath, forgeVersion); } catch (e) {}

    return installerPath;
}

async function setupServersDat(gameDir, fileUrl) {
    if (!fileUrl) return;
    const serversDatPath = path.join(gameDir, 'servers.dat');
    if (fs.existsSync(serversDatPath)) return;
    try {
        const res = await fetchWithRedirect(fileUrl + '?t=' + Date.now());
        if (res.statusCode !== 200) return;
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(serversDatPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        });
    } catch (err) {
        log.error('[MC] Erreur servers.dat :', err.message);
    }
}

async function setupDefaults(gameDir, defaultsUrl) {
    if (!defaultsUrl) return;
    const markerPath = path.join(gameDir, '.defaults_installed');
    if (fs.existsSync(markerPath)) return;

    log.info('[MC] Installation des configs par défaut (keybinds, minimap)...');
    fs.mkdirSync(gameDir, { recursive: true });
    const zipPath = path.join(gameDir, '_defaults.zip');
    try {
        const res = await fetchWithRedirect(defaultsUrl + '?t=' + Date.now());
        if (res.statusCode !== 200) {
            log.error('[MC] defaults.zip HTTP ' + res.statusCode);
            return;
        }
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(zipPath);
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
            file.on('error', reject);
        });
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(gameDir, true);
        fs.unlinkSync(zipPath);
        fs.writeFileSync(markerPath, new Date().toISOString());
        log.info('[MC] Configs par défaut installées');
    } catch (err) {
        log.error('[MC] Erreur defaults :', err.message);
    }
}

function activateResourcepacks(gameDir, resourcepacksDir, loader) {
    if (!fs.existsSync(resourcepacksDir)) return;
    const optionsPath = path.join(gameDir, 'options.txt');
    const installedRPs = fs.readdirSync(resourcepacksDir).filter(f => f.endsWith('.zip'));
    const packs = ['"vanilla"'];
    if (loader === 'fabric') packs.push('"fabric"');
    for (const rp of installedRPs) packs.push(`"file/${rp}"`);
    const resourcePacksLine = 'resourcePacks:[' + packs.join(',') + ']';

    let optionsContent = '';
    if (fs.existsSync(optionsPath)) {
        optionsContent = fs.readFileSync(optionsPath, 'utf8');
        if (optionsContent.includes('resourcePacks:')) {
            optionsContent = optionsContent.replace(/resourcePacks:\[.*?\]/, resourcePacksLine);
        } else {
            optionsContent += '\n' + resourcePacksLine + '\n';
        }
    } else {
        optionsContent = resourcePacksLine + '\n';
    }
    fs.writeFileSync(optionsPath, optionsContent);
    log.info('[MC] options.txt mis à jour avec ' + installedRPs.length + ' resource packs');
}

// ---------------------------------------------------------------------------
// Java 17/21 portable (Temurin), dynamique selon la version MC
// ---------------------------------------------------------------------------
function findJavaBinary(dir) {
    const exe = process.platform === 'win32' ? 'javaw.exe' : 'java';
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of entries) {
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) stack.push(full);
            else if (ent.name === exe && path.basename(cur) === 'bin') return full;
        }
    }
    return null;
}

async function downloadToFile(url, destPath) {
    const res = await fetchWithRedirect(url);
    if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
    });
}

async function setupJava(mcVersion, onStatus) {
    const majorVersion = parseInt(mcVersion.split('.')[1]);
    const javaMajor = majorVersion >= 20 && majorVersion < 21 ? '17' : '21';

    const javaRoot = path.join(app.getPath('userData'), 'java', `jre${javaMajor}`);
    const existing = findJavaBinary(javaRoot);
    if (existing && fs.existsSync(existing)) return existing;

    const platform = process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
    const ext = platform === 'windows' ? 'zip' : 'tar.gz';
    const url = `https://api.adoptium.net/v3/binary/latest/${javaMajor}/ga/${platform}/${arch}/jre/hotspot/normal/eclipse`;

    fs.mkdirSync(javaRoot, { recursive: true });
    const archivePath = path.join(javaRoot, `jre${javaMajor}.${ext}`);

    if (onStatus) onStatus(`Téléchargement de Java ${javaMajor} (une seule fois)...`);
    await downloadToFile(url, archivePath);

    if (onStatus) onStatus(`Installation de Java ${javaMajor}...`);
    if (ext === 'zip') {
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(javaRoot, true);
    } else {
        await tar.x({ file: archivePath, cwd: javaRoot });
    }
    fs.unlinkSync(archivePath);

    const bin = findJavaBinary(javaRoot);
    if (!bin) throw new Error("binaire Java introuvable après extraction");
    if (process.platform !== 'win32') {
        try { fs.chmodSync(bin, 0o755); } catch (e) {}
    }
    log.info(`[MC] Java ${javaMajor} prêt : ${bin}`);
    return bin;
}

// Un JRE extrait à moitié (coupure réseau, antivirus) se traduit sinon par un
// crash Java incompréhensible. On le vérifie avant de lancer le jeu.
function javaWorks(binPath) {
    try {
        const probe = binPath.replace(/javaw\.exe$/i, 'java.exe');
        const res = cp.spawnSync(probe, ['-version'], { timeout: 15000, windowsHide: true });
        return res.status === 0 || /version/i.test(String(res.stderr || '') + String(res.stdout || ''));
    } catch (e) {
        return false;
    }
}

async function setupJavaChecked(mcVersion, onStatus) {
    let bin = await setupJava(mcVersion, onStatus);
    if (bin && !javaWorks(bin)) {
        log.error('[MC] Java installé mais non fonctionnel, réinstallation');
        if (onStatus) onStatus('Java abîmé, réinstallation...');
        // Même règle que setupJava, sinon on purge le mauvais dossier.
        const mcMinor = parseInt(mcVersion.split('.')[1]);
        const javaMajor = mcMinor >= 20 && mcMinor < 21 ? '17' : '21';
        const javaRoot = path.join(app.getPath('userData'), 'java', `jre${javaMajor}`);
        try { fs.rmSync(javaRoot, { recursive: true, force: true }); } catch (e) {}
        bin = await setupJava(mcVersion, onStatus);
        if (bin && !javaWorks(bin)) throw new Error('Java ne fonctionne pas après réinstallation');
    }
    return bin;
}

// ---------------------------------------------------------------------------
// Synchronisation complète d'un pack
// ---------------------------------------------------------------------------
async function syncAllContent(event, packData, gameDir) {
    // Un disque plein en cours de téléchargement laisse des .jar tronqués et
    // un jeu qui ne démarre plus. On prévient avant, pas après.
    const free = freeSpaceGb(gameDir);
    if (free !== null) {
        if (free < 1) {
            throw new Error('Disque plein : il reste ' + free.toFixed(1) +
                            ' Go, il en faut au moins 3 pour installer le modpack.');
        }
        if (free < 3) {
            event.sender.send('sync-status', {
                message: 'Attention : il ne reste que ' + free.toFixed(1) + ' Go de libre.'
            });
        }
    }

    const modsDir          = path.join(gameDir, 'mods');
    const datapacksDir     = path.join(gameDir, 'datapacks');
    const shaderpacksDir   = path.join(gameDir, 'shaderpacks');
    const resourcepacksDir = path.join(gameDir, 'resourcepacks');

    const statusCb = (msg) => event.sender.send('sync-status', { message: msg });
    const progressCb = (fileName, received, total) => event.sender.send('sync-progress', {
        fileName, pct: Math.round((received / total) * 100)
    });

    await syncMods(packData.manifest_url, modsDir, statusCb, progressCb);

    if (packData.datapacks_manifest_url) {
        try { await syncDatapacks(packData.datapacks_manifest_url, datapacksDir, statusCb, progressCb); }
        catch (err) { statusCb("Avertissement datapacks : " + err.message); }
    }
    if (packData.shaderpacks_manifest_url) {
        try { await syncShaderpacks(packData.shaderpacks_manifest_url, shaderpacksDir, statusCb, progressCb); }
        catch (err) { statusCb("Avertissement shaders : " + err.message); }
    }
    if (packData.resourcepacks_manifest_url) {
        try { await syncResourcepacks(packData.resourcepacks_manifest_url, resourcepacksDir, statusCb, progressCb); }
        catch (err) { statusCb("Avertissement RP : " + err.message); }
    }

    const allFiles = fs.readdirSync(modsDir);
    for (const part00 of allFiles.filter(f => f.endsWith('.part00'))) {
        const baseName = part00.replace('.part00', '');
        const finalPath = path.join(modsDir, baseName);
        const partPaths = allFiles
        .filter(f => f.startsWith(baseName + '.part'))
        .map(f => path.join(modsDir, f));
        const totalPartsSize = partPaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
        if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size !== totalPartsSize) {
            statusCb('Assemblage : ' + baseName + '...');
            await assembleParts(modsDir, baseName, statusCb);
        }
    }
}

ipcMain.on('sync-now', async (event, packData) => {
    if (!packData || !packData.id) return;
    const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
    try {
        if (packData.defaults_url) {
            event.sender.send('sync-status', { message: "Installation des configurations..." });
            await setupDefaults(gameDir, packData.defaults_url);
        }
        await syncAllContent(event, packData, gameDir);
        const loader = (packData.loader || 'fabric').toLowerCase();
        activateResourcepacks(gameDir, path.join(gameDir, 'resourcepacks'), loader);
        event.sender.send('sync-status', { message: "Synchronisation terminée ✓" });
    } catch (err) {
        log.error('[SyncNow]', err.message);
        event.sender.send('sync-status', { message: "Erreur : " + humanizeError(err) });
    } finally {
        event.sender.send('sync-done');
    }
});

// ---------------------------------------------------------------------------
// Lancement du jeu
// ---------------------------------------------------------------------------
ipcMain.on('launch-game', async (event, packData) => {
    if (isLaunching) {
        event.sender.send('sync-status', { message: "Lancement déjà en cours..." });
        return;
    }
    if (!mcToken) {
        event.sender.send('launch-error', "Lancement impossible : pas de token");
        return;
    }
    isLaunching = true;
    lastSelectedPackName = packData.name || packData.id || '';

    try {
        if (Date.now() - mcTokenTimestamp > TOKEN_MAX_AGE_MS) {
            event.sender.send('sync-status', { message: "Rafraîchissement de la session Microsoft..." });
            try {
                await refreshFromSaved();
            } catch (e) {
                log.error('[Launch] Refresh token échoué :', e.message);
                isLaunching = false;
                event.sender.send('auth-missing');
                event.sender.send('launch-error', "Session Microsoft expirée, reconnecte-toi.");
                return;
            }
        }

        // Plafonnement RAM : demander plus que la mémoire physique fait échouer
        // la JVM au démarrage avec un message que personne ne comprend.
        const ramInfo = clampRam(packData.ram);
        const ram = ramInfo.ram;
        if (ramInfo.clamped) {
            log.info('[MC] RAM demandée ' + ramInfo.asked + ' Go → ramenée à ' + ram + ' Go');
            event.sender.send('sync-status', {
                message: 'RAM ramenée à ' + ram + ' Go (ta machine a ' + ramInfo.totalGb + ' Go).'
            });
            event.sender.send('ram-clamped', { asked: ramInfo.asked, used: ram, maxRamGb: ramInfo.maxSafe, totalRamGb: ramInfo.totalGb });
        }
        const gameDir = path.join(app.getPath('userData'), 'instances', packData.id);
        const modsDir = path.join(gameDir, 'mods');
        const resourcepacksDir = path.join(gameDir, 'resourcepacks');

        if (packData.defaults_url) {
            event.sender.send('sync-status', { message: "Installation des configurations..." });
            await setupDefaults(gameDir, packData.defaults_url);
        }

        const autoSync = packData.autoSync !== false;
        let modsPresent = false;
        try {
            modsPresent = fs.existsSync(modsDir) &&
            fs.readdirSync(modsDir).some(f => f.endsWith('.jar') || f.endsWith('.part00'));
        } catch (e) {}

        const doSync = autoSync || !modsPresent;
        if (doSync) {
            await syncAllContent(event, packData, gameDir);
        } else {
            event.sender.send('sync-status', { message: "Mode libre : mods gérés manuellement, synchronisation ignorée" });
        }

        event.sender.send('sync-status', { message: "Configuration serveur multijoueur..." });
        await setupServersDat(gameDir, packData.servers_dat_url);

        const loader = (packData.loader || 'fabric').toLowerCase();
        event.sender.send('sync-status', { message: "Activation des resource packs..." });
        activateResourcepacks(gameDir, resourcepacksDir, loader);

        let javaPath = null;
        try {
            javaPath = await setupJavaChecked(packData.minecraft, (msg) => event.sender.send('sync-status', { message: msg }));
        } catch (err) {
            log.error('[MC] Java auto indisponible :', err.message);
            event.sender.send('sync-status', { message: "Java auto indisponible, utilisation du Java système..." });
        }

        let opts;
        if (loader === 'forge') {
            const forgeVersion = packData.loader_version || "47.4.10";

            // On arme notre patch avec la VRAIE version Forge voulue pour qu'il écrase le faux 47.4.0
            activeForgeVersionForPatch = forgeVersion;

            event.sender.send('sync-status', { message: "Installation de Forge " + forgeVersion + "..." });
            const forgeInstaller = await setupForge(
                gameDir, packData.minecraft, forgeVersion,
                (msg) => event.sender.send('sync-status', { message: msg })
            );
            opts = {
                authorization: mcToken.mclc(),
           root: gameDir,
           version: { number: packData.minecraft, type: "release" },
           forge: forgeInstaller,
               memory: { max: ram + "G", min: "2G" }
            };
        } else {
            activeForgeVersionForPatch = null;
            const loaderVersion = packData.loader_version || "0.18.4";
            event.sender.send('sync-status', { message: "Installation de Fabric..." });
            const fabricVersion = await setupFabric(gameDir, packData.minecraft, loaderVersion);
            opts = {
                authorization: mcToken.mclc(),
           root: gameDir,
           version: { number: packData.minecraft, type: "release", custom: fabricVersion },
           memory: { max: ram + "G", min: "2G" }
            };
        }
        if (javaPath) opts.javaPath = javaPath;

        event.sender.send('sync-status', { message: "Démarrage de Minecraft..." });
        event.sender.send('game-launching', { ram });

        const proc = await launcher.launch(opts);
        if (!proc) throw new Error("Minecraft n'a pas pu être démarré (aucun process créé).");

        // Le jeu doit survivre à la fermeture du launcher.
        try { proc.unref(); } catch (e) {}

        // Repli : si aucune ligne de démarrage connue n'apparaît (langue,
        // version, mod de log exotique), on considère le jeu lancé au bout
        // de 90 s plutôt que de laisser le launcher figé sur « démarrage ».
        if (gameStartTimer) clearTimeout(gameStartTimer);
        gameStartTimer = setTimeout(() => {
            if (isLaunching && !gameStarted) markGameStarted();
        }, 90000);
    } catch (err) {
        log.error('[Launch]', err);
        isLaunching = false;
        gameStarted = false;
        if (gameStartTimer) { clearTimeout(gameStartTimer); gameStartTimer = null; }
        event.sender.send('launch-error', humanizeError(err));
    }
});
