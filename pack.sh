#!/bin/bash
# Prepara lo zip da caricare su extensions.gnome.org (https://extensions.gnome.org/upload/).
# Le traduzioni si compilano da po/ e lo schema si aggiunge in chiaro: GNOME 45+
# lo compila da sé, quindi niente gschemas.compiled nel pacchetto.
#   ./pack.sh        crea barretta@andreafontana.it.shell-extension.zip qui
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

UUID=barretta@andreafontana.it
gnome-extensions pack --force --out-dir=. \
    --extra-source=tray.js \
    --extra-source=icons \
    --podir=../po \
    --schema="schemas/org.gnome.shell.extensions.barretta.gschema.xml" \
    "$UUID"

ZIP="$UUID.shell-extension.zip"
VERSION=$(python3 -c "import json; print(json.load(open('$UUID/metadata.json'))['version'])")
echo "Pronto: $ZIP (versione $VERSION, $(du -h "$ZIP" | cut -f1), $(unzip -l "$ZIP" | grep -c '\.mo$') lingue)"
echo "Per un aggiornamento, prima alza \"version\" in $UUID/metadata.json."
