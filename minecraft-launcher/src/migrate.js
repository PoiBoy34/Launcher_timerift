// ===========================================================================
// migrate.js — reprise des données de l'ancien launcher multi-packs.
// Electron range userData dans un dossier nommé d'après l'application : après
// le rebranding, l'ancien dossier (instances, mondes, Java, session MS)
// deviendrait invisible. On le rapatrie une seule fois, silencieusement.
// ===========================================================================
const fs = require('fs');
const path = require('path');

module.exports = function migrate(app, oldNames, moveList, copyList) {
    try {
        const newDir = app.getPath('userData');
        const parent = path.dirname(newDir);

        for (const oldName of oldNames) {
            const oldDir = path.join(parent, oldName);
            if (path.resolve(oldDir) === path.resolve(newDir)) continue;
            if (!fs.existsSync(oldDir)) continue;

            for (const rel of moveList) {
                const src = path.join(oldDir, rel);
                const dst = path.join(newDir, rel);
                if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                try {
                    fs.renameSync(src, dst);                    // même disque : instantané
                } catch (e) {
                    fs.cpSync(src, dst, { recursive: true });   // disques différents
                    fs.rmSync(src, { recursive: true, force: true });
                }
                console.log('[Migration] ' + rel + ' repris depuis ' + oldName);
            }

            for (const rel of copyList) {
                const src = path.join(oldDir, rel);
                const dst = path.join(newDir, rel);
                if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.copyFileSync(src, dst);   // copie : l'ancien launcher garde sa session
                console.log('[Migration] ' + rel + ' copié depuis ' + oldName);
            }
        }
    } catch (e) {
        // Best-effort : la migration ne doit jamais empêcher le démarrage.
    }
};
