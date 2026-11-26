#!/bin/bash
# Installa (o aggiorna) Barretta nelle estensioni GNOME dell'utente.
# Non la attiva: su Wayland GNOME vede un'estensione nuova solo dopo
# logout e login. Poi: gnome-extensions enable barretta@andreafontana.it
set -euo pipefail

UUID=barretta@andreafontana.it
SRC="$(dirname "$(readlink -f "$0")")/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

[ -f "$SRC/metadata.json" ] || { echo "Non trovo $SRC" >&2; exit 1; }

mkdir -p "$DEST"
# Copia esatta: i file tolti dal progetto spariscono anche dall'installazione.
rsync -a --delete --exclude 'schemas/gschemas.compiled' "$SRC/" "$DEST/"
glib-compile-schemas "$DEST/schemas"

echo "Installata in $DEST"
if gnome-extensions info "$UUID" >/dev/null 2>&1; then
    echo "GNOME la conosce già: per caricare la nuova versione serve un logout e login."
else
    echo "Fai logout e login, poi attivala con:"
    echo "  gnome-extensions enable $UUID"
fi
