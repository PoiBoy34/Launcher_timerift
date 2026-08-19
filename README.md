# TimeRift-Launcher

Launcher Minecraft dédié au modpack **Time Rift Universe** (Minecraft 1.20.1, forge).
Tu l'installes une fois, tu te connectes, tu cliques sur **Jouer** : mods,
configs, resource packs et loader se téléchargent et se mettent à jour tout
seuls.

*(English version below ⬇️)*

## Installation

👉 **https://github.com/PoiBoy34/Launcher_timerift/releases/latest**

### Windows
1. Télécharge **`TimeRift-Launcher-Setup-x.x.x.exe`**
2. Lance-le et suis l'installation
3. Ouvre **TimeRift-Launcher** depuis le menu Démarrer ou le raccourci bureau

### Linux
1. Télécharge **`TimeRift-Launcher-x.x.x.AppImage`**
2. Rends-le exécutable (clic droit → Propriétés → Autoriser l'exécution, ou
   `chmod +x TimeRift-Launcher-*.AppImage`)
3. Double-clique dessus

## ⚠️ « Windows a protégé votre ordinateur » / avertissement du navigateur

C'est **normal et attendu**, ce n'est pas un virus. Windows et Chrome affichent
cet avertissement pour **tout** programme téléchargé qui n'a pas encore été
installé par des milliers de personnes. Le launcher est un projet perso : il
n'a pas encore cette réputation, donc l'alerte apparaît.

**Chrome / Edge** — téléchargement bloqué ou marqué comme « rarement
téléchargé » :
- clique sur la flèche à côté du fichier dans la barre de téléchargements ;
- choisis **Conserver** / **Conserver quand même**.

**Windows SmartScreen** — écran bleu « Windows a protégé votre ordinateur » :
- clique sur **Informations complémentaires** ;
- puis sur **Exécuter quand même**.

**Antivirus (Avast, Norton, McAfee…)** — s'il met le fichier en quarantaine,
c'est un faux positif : restaure-le et ajoute une exception pour le dossier
d'installation.

Tu peux vérifier que ton fichier est bien celui publié ici en comparant son
empreinte SHA-256 avec celle indiquée dans la release :

```powershell
Get-FileHash .\TimeRift-Launcher-Setup-x.x.x.exe -Algorithm SHA256
```

Le code source est entièrement dans ce dépôt, et les exécutables sont
construits automatiquement par GitHub Actions à partir de ce code.

## Comment ça marche

1. **Connecte-toi** avec ton compte Microsoft (bouton en haut à droite).
2. **Clique sur Jouer.**

Le launcher fait le reste :
- il télécharge mods, configs et resource packs du pack ;
- il installe le bon loader et la bonne version de Java ;
- il vérifie chaque fichier (sha1), puis lance le jeu.

Le premier lancement est long (gros téléchargement). Ensuite, seuls les
fichiers manquants ou modifiés sont retéléchargés.

## Mises à jour

Le launcher se met à jour tout seul : quand une nouvelle version sort, une
bannière apparaît en haut de la fenêtre → **Télécharger**, puis
**Installer & redémarrer**. Tu peux aussi vérifier dans
**⚙️ Paramètres → Launcher → Vérifier les mises à jour**.

## Tu utilisais l'ancien launcher SUS-Launcher ?

Installe celui-ci et lance-le **avant** de désinstaller l'ancien : tes mondes,
tes configs, ton Java et ta session Microsoft sont repris automatiquement au
premier démarrage. Une fois que tu as vérifié que tout est là, tu peux
désinstaller l'ancien launcher.

## Besoin d'aide ?

En cas de souci, note le message affiché en bas du launcher, ou utilise
**⚙️ Paramètres → Diagnostic → Copier le rapport** : il contient tout ce qu'il
faut pour comprendre le problème.

---

# TimeRift-Launcher (English)

A Minecraft launcher dedicated to the **Time Rift Universe** modpack (Minecraft 1.20.1,
forge). Install it once, log in, hit **Play** — mods, configs, resource
packs and the loader download and update on their own.

## Installation

👉 **https://github.com/PoiBoy34/Launcher_timerift/releases/latest**

- **Windows**: download **`TimeRift-Launcher-Setup-x.x.x.exe`** and run it.
- **Linux**: download **`TimeRift-Launcher-x.x.x.AppImage`**, `chmod +x` it, run it.

## ⚠️ "Windows protected your PC" / browser warning

This is expected, not a virus. Windows and Chrome warn about **any** downloaded
program that isn't yet installed by thousands of people. This is a small
personal project, so it doesn't have that reputation yet.

- **Chrome / Edge**: click the arrow next to the file → **Keep**.
- **SmartScreen**: click **More info** → **Run anyway**.
- **Antivirus**: false positive — restore the file and whitelist the install
  folder.

You can check your file matches the published one:

```powershell
Get-FileHash .\TimeRift-Launcher-Setup-x.x.x.exe -Algorithm SHA256
```

The full source is in this repository, and the binaries are built from it
automatically by GitHub Actions.

## How it works

Log in with your Microsoft account, click **Play**. The launcher downloads the
mods, installs the right loader and Java version, verifies every file, then
starts the game. First launch is slow, later ones are near-instant.

The launcher updates itself: a banner appears when a new version is out.

## Coming from the old SUS-Launcher?

Install this one and run it **before** uninstalling the old launcher — your
worlds, configs, Java and Microsoft session are migrated automatically on
first start.

---

# Pour le mainteneur

| Chemin | Rôle |
|---|---|
| `catalog.json` | Description du modpack, lue par le launcher |
| `modpacks/Time-Rift-Universe/` | mods, datapacks, shaders, resource packs + manifests |
| `assets/` | Icône et fond du pack |
| `minecraft-launcher/` | Code du launcher (Electron) |
| `update_manifest.sh` | Régénère les manifests (sha1 + URL) |
| `publish.sh` | update_manifest.sh + commit + push, en une commande |

## Ajouter ou mettre à jour des mods

```bash
cp mon-nouveau-mod.jar modpacks/Time-Rift-Universe/mods/
./publish.sh "ajout de mon-nouveau-mod"
```

`update_manifest.sh` recalcule le sha1 et l'URL de **chaque** fichier des
dossiers `mods`, `datapacks`, `shaderpacks` et `resourcepacks`, et met à jour
le `defaults_sha1` du `catalog.json`. Rien d'autre à faire : les joueurs
reçoivent la mise à jour au lancement suivant, et le launcher supprime chez
eux les fichiers qui ne sont plus dans le manifest.

Un fichier de plus de 100 Mo est refusé par GitHub. Découpe-le, le launcher
réassemble les morceaux tout seul :

```bash
split -b 90M -d -a 2 "modpacks/Time-Rift-Universe/mods/gros.jar" \
                     "modpacks/Time-Rift-Universe/mods/gros.jar.part"
rm "modpacks/Time-Rift-Universe/mods/gros.jar"
```

## Publier une version du launcher

Change le numéro de version, pousse un tag : GitHub Actions construit le
`.exe` et l'`.AppImage`, et crée la release.

```bash
cd minecraft-launcher && npm version 2.0.1 --no-git-tag-version && cd ..
git commit -am "launcher 2.0.1" && git push
git tag v2.0.1 && git push --tags
```

La release est créée en **brouillon** : va dans l'onglet Releases et clique sur
*Publish release* pour que les joueurs la reçoivent.
