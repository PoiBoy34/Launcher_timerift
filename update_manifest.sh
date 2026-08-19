#!/bin/bash

# À lancer depuis la RACINE du repo (là où se trouvent catalog.json et modpacks/).
if [ ! -d "modpacks" ]; then
  echo "❌ Dossier 'modpacks/' introuvable. Lance ce script depuis la racine du repo."
  exit 1
fi

echo "Démarrage de la mise à jour des manifests..."

for modpack_dir in modpacks/*/; do
  MODPACK_NAME=$(basename "$modpack_dir")
  echo "----------------------------------------"
  echo "📦 Traitement du modpack : $MODPACK_NAME"

  generate_manifest() {
    local FOLDER_NAME=$1
    local MANIFEST_NAME=$2
    local TARGET_DIR="modpacks/$MODPACK_NAME/$FOLDER_NAME"
    local MANIFEST_FILE="modpacks/$MODPACK_NAME/$MANIFEST_NAME"
    local BASE_URL="https://raw.githubusercontent.com/PoiBoy34/Launcher_timerift/main/modpacks/$MODPACK_NAME/$FOLDER_NAME"

    # Si le dossier n'existe pas, on ignore
    if [ ! -d "$TARGET_DIR" ]; then
      return
    fi

    echo "⚙️ Génération de $MANIFEST_NAME..."
    echo '{
  "version": "1.0.0",
  "files": [' > "$MANIFEST_FILE"

    local FIRST_FILE=true

    # =====================================================================
    # OVERRIDES PAR PACK : gros fichiers hébergés sur une RELEASE GitHub
    # (à utiliser pour tout fichier > 100 Mo, que GitHub refuse dans le repo).
    # Sinon, préfère découper le .jar en .part00/.part01 dans le dossier :
    # le script les listera et le launcher les réassemble tout seul.
    # ---------------------------------------------------------------------
    # 3. (Time Rift) ajoute ici tes overrides si un jar dépasse 100 Mo, ex. :
    # if [ "$FOLDER_NAME" = "mods" ] && [ "$MODPACK_NAME" = "Time-Rift-Universe" ]; then
    #   ... même format {name,url,sha1} pointant vers une release ...
    # fi
    # =====================================================================

    # 4. Boucle sur les fichiers locaux du dossier (jars, zips, .part00/.part01, ...)
    shopt -s nullglob
    for filepath in "$TARGET_DIR"/*; do
      if [ -f "$filepath" ]; then
        local filename=$(basename "$filepath")
        local hash=$(sha1sum "$filepath" | awk '{print $1}')

        # Sécurité : encodage des caractères spéciaux dans l'URL
        local url_filename=${filename// /%20}
        url_filename=${url_filename//\[/%5B}
        url_filename=${url_filename//\]/%5D}
        url_filename=${url_filename//\(/%28}
        url_filename=${url_filename//\)/%29}
        url_filename=${url_filename//\'/%27}

        if [ "$FIRST_FILE" = true ]; then
          FIRST_FILE=false
        else
          echo "    ," >> "$MANIFEST_FILE"
        fi

        echo '    {
      "name": "'"$filename"'",
      "url": "'"$BASE_URL"'/'"$url_filename"'",
      "sha1": "'"$hash"'"
    }' >> "$MANIFEST_FILE"
        echo " -> Ajouté : $filename"
      fi
    done
    shopt -u nullglob

    echo '  ]
}' >> "$MANIFEST_FILE"
  }

  generate_manifest "mods" "manifest.json"
  generate_manifest "datapacks" "datapacks_manifest.json"
  generate_manifest "shaderpacks" "shaderpacks_manifest.json"
  generate_manifest "resourcepacks" "resourcepacks_manifest.json"

  # ---------------------------------------------------------------------
  # defaults.zip : on calcule son sha1 et on l'écrit dans catalog.json
  # (le launcher vérifie ce defaults_sha1 pour réinstaller les configs).
  # ---------------------------------------------------------------------
  DEFAULTS_FILE="modpacks/$MODPACK_NAME/defaults.zip"
  if [ -f "$DEFAULTS_FILE" ]; then
    DEFAULTS_SHA1=$(sha1sum "$DEFAULTS_FILE" | awk '{print $1}')
    echo "🔑 defaults.zip sha1 : $DEFAULTS_SHA1"

    if [ -f "catalog.json" ] && command -v python3 >/dev/null 2>&1; then
      python3 - "$MODPACK_NAME" "$DEFAULTS_SHA1" <<'PYEOF'
import json, sys
pack_folder, sha1 = sys.argv[1], sys.argv[2]
with open('catalog.json', encoding='utf-8') as f:
    data = json.load(f)
needle = '/modpacks/%s/' % pack_folder
changed = False
for p in data.get('modpacks', []):
    if needle in p.get('defaults_url', ''):
        p['defaults_sha1'] = sha1
        changed = True
if changed:
    with open('catalog.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print("   -> catalog.json mis à jour (defaults_sha1)")
else:
    print("   -> aucun pack du catalog ne correspond à ce dossier, colle le sha1 à la main")
PYEOF
    else
      echo "   (python3 absent ou catalog.json introuvable — colle le sha1 dans catalog.json à la main)"
    fi
  fi

  echo "✅ Modpack $MODPACK_NAME à jour"
done

echo "----------------------------------------"
echo "🚀 Tous les manifests ont été mis à jour avec succès !"
