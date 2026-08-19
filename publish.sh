#!/usr/bin/env bash
# ===========================================================================
# publish.sh — à lancer après avoir ajouté / retiré / mis à jour des fichiers
# dans modpacks/<pack>/mods (ou datapacks, shaderpacks, resourcepacks).
#
#     ./publish.sh                      # message de commit par défaut
#     ./publish.sh "ajout de Create"    # message personnalisé
#
# Il régénère les manifests (sha1 + URL de chaque fichier) puis pousse.
# Les joueurs récupèrent la mise à jour au lancement suivant, sans
# réinstaller le launcher.
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")"

# GitHub refuse tout fichier de plus de 100 Mo dans un dépôt.
BIG=$(find modpacks -type f -size +99M 2>/dev/null || true)
if [ -n "$BIG" ]; then
    echo "❌ Fichiers trop gros pour GitHub (>99 Mo) :"
    echo "$BIG" | sed 's/^/   /'
    echo
    echo "Découpe-les — le launcher réassemble les .partXX tout seul :"
    echo '   split -b 90M -d -a 2 "modpacks/PACK/mods/gros.jar" "modpacks/PACK/mods/gros.jar.part"'
    echo '   rm "modpacks/PACK/mods/gros.jar"'
    echo "…puis relance ./publish.sh"
    exit 1
fi

./update_manifest.sh

if git diff --quiet && git diff --cached --quiet; then
    echo "Rien de nouveau à publier."
    exit 0
fi

git add -A
echo
git status --short
git commit -q -m "${1:-modpack : mise à jour du contenu}"
git push
echo
echo "✅ Publié. Les joueurs l'auront au prochain lancement du launcher."
