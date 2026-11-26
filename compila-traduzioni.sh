#!/bin/bash
# Aggiorna il modello delle traduzioni e compila po/*.po in barretta@andreafontana.it/locale.
#   ./compila-traduzioni.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --add-comments=Translators \
    --package-name=barretta -o po/barretta.pot barretta@andreafontana.it/extension.js

rm -rf barretta@andreafontana.it/locale
for po in po/*.po; do
    lang=$(basename "$po" .po)
    # Allinea al modello: testi nuovi vuoti, testi tolti commentati.
    msgmerge --quiet --update --backup=none "$po" po/barretta.pot
    mkdir -p "barretta@andreafontana.it/locale/$lang/LC_MESSAGES"
    msgfmt --check -o "barretta@andreafontana.it/locale/$lang/LC_MESSAGES/barretta.mo" "$po"
done
echo "Compilate $(ls po/*.po | wc -l) lingue in barretta@andreafontana.it/locale/"
