// ===========================================================================
// modSync.js — Synchronisation des contenus (mods, datapacks, shaders, RP)
// v2 : téléchargements avec timeout + retries + repli DoH (voir netUtils.js)
// ===========================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchJSON, downloadFile } = require('./netUtils');

function getCatalogUrl() {
    return "https://raw.githubusercontent.com/PoiBoy34/Launcher_timerift/main/catalog.json?t=" + Date.now();
}

function getUrl(baseUrl) {
    return baseUrl + (baseUrl.includes('?') ? '&' : '?') + 't=' + Date.now();
}

function sha1File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function fetchCatalog() {
    return await fetchJSON(getCatalogUrl());
}

async function syncFiles(manifestUrl, destDir, label, onStatus, onProgress) {
    onStatus("Récupération " + label + "...");
    const manifest = await fetchJSON(getUrl(manifestUrl));

    fs.mkdirSync(destDir, { recursive: true });

    // Nettoyage des fichiers hors manifest.
    // On lit le dossier UNE fois (l'ancienne version relisait à chaque itération).
    const dirContents = fs.readdirSync(destDir);
    const expectedFiles = new Set(manifest.files.map(f => f.name));
    const partSet = new Set(dirContents.filter(f => f.includes('.part')));
    for (const existing of dirContents) {
        if (existing.includes('.part')) continue;
        // Fichier assemblé depuis des .partXX : on le garde.
        if (partSet.has(existing + '.part00')) continue;
        if (!expectedFiles.has(existing)) {
            try {
                fs.unlinkSync(path.join(destDir, existing));
                onStatus("Supprimé : " + existing);
            } catch (e) {
                onStatus("Impossible de supprimer " + existing + " : " + e.message);
            }
        }
    }

    for (let i = 0; i < manifest.files.length; i++) {
        const file = manifest.files[i];
        const destPath = path.join(destDir, file.name);

        let needsDownload = true;
        if (fs.existsSync(destPath)) {
            onStatus("Vérification : " + file.name);
            try {
                const localSha1 = await sha1File(destPath);
                if (localSha1 === file.sha1) needsDownload = false;
            } catch (e) { /* fichier illisible → on retélécharge */ }
        }

        if (needsDownload) {
            onStatus(label + " (" + (i + 1) + "/" + manifest.files.length + ") : " + file.name);
            await downloadFile(file.url, destPath, (received, total) => {
                onProgress(file.name, received, total);
            });
            // Vérification d'intégrité post-téléchargement : un fichier corrompu
            // (coupure réseau, proxy) ne doit jamais rester dans le dossier mods.
            if (file.sha1) {
                const gotSha1 = await sha1File(destPath);
                if (gotSha1 !== file.sha1) {
                    fs.unlinkSync(destPath);
                    throw new Error("Fichier corrompu après téléchargement : " + file.name +
                        " (sha1 attendu " + file.sha1 + ", obtenu " + gotSha1 + ")");
                }
            }
            onStatus("OK : " + file.name);
        } else {
            onStatus("À jour : " + file.name);
        }
    }

    onStatus(label + " synchronisés ✓");
    return manifest;
}

async function syncMods(manifestUrl, modsDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, modsDir, "Mods", onStatus, onProgress);
}

async function syncDatapacks(manifestUrl, datapacksDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, datapacksDir, "Datapacks", onStatus, onProgress);
}

async function syncShaderpacks(manifestUrl, shaderpacksDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, shaderpacksDir, "Shaders", onStatus, onProgress);
}

async function syncResourcepacks(manifestUrl, resourcepacksDir, onStatus, onProgress) {
    return await syncFiles(manifestUrl, resourcepacksDir, "Resource Packs", onStatus, onProgress);
}

module.exports = { fetchCatalog, syncMods, syncDatapacks, syncShaderpacks, syncResourcepacks };
