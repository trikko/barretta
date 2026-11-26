#!/usr/bin/env python3
"""Genera le icone dei badge di notifica (1-9 e +) per la barra.

Le cifre sono tracciate a mano su una griglia 16x16, poi ogni simbolo viene
renderizzato in grande, si misura dove cade davvero l'inchiostro bianco e lo
si sposta finché il suo centro coincide con quello del cerchio. Così il
centraggio non dipende né dal font né dall'arrotondamento.

Uso: python3 genera-badge.py   (scrive barretta@andreafontana.it/icons/ e badge-anteprima.png)
"""
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "barretta@andreafontana.it" / "icons"
RED = "#e01b24"
STROKE = 1.75
BIG = 800  # px di render per la misura (50 px per unità della griglia)

# Cifre disegnate in un riquadro x 5.5-10.5, y 4.25-11.75 (centro 8,8).
GLYPHS = {
    "1": '<path d="M6.6 5.7 L8.6 4.25 L8.6 11.75"/>',
    "2": '<path d="M5.7 6.1 C5.7 4.95 6.7 4.25 8 4.25 C9.4 4.25 10.3 5.1 10.3 6.2 '
         'C10.3 7.3 9.5 8 8.5 8.8 L5.6 11.75 L10.5 11.75"/>',
    "3": '<path d="M5.8 5 C6.3 4.5 7.1 4.25 8 4.25 C9.4 4.25 10.3 5 10.3 6 '
         'C10.3 7.1 9.4 7.9 7.9 7.9 C9.6 7.9 10.5 8.8 10.5 9.9 '
         'C10.5 11.1 9.4 11.75 8 11.75 C7 11.75 6.1 11.4 5.6 10.8"/>',
    "4": '<path d="M9.4 11.75 L9.4 4.25 L5.4 9.6 L10.7 9.6"/>',
    "5": '<path d="M10.2 4.25 L6.2 4.25 L5.9 7.8 C6.5 7.4 7.2 7.2 8 7.2 '
         'C9.5 7.2 10.5 8.2 10.5 9.5 C10.5 10.8 9.4 11.75 8 11.75 '
         'C7 11.75 6.1 11.4 5.6 10.8"/>',
    "6": '<path d="M9.9 4.6 C9.4 4.4 8.8 4.25 8.2 4.25 C6.5 4.25 5.5 5.9 5.5 8.3 '
         'C5.5 10.4 6.5 11.75 8 11.75 C9.5 11.75 10.5 10.7 10.5 9.4 '
         'C10.5 8.1 9.5 7.1 8.1 7.1 C7 7.1 6 7.7 5.55 8.6"/>',
    "7": '<path d="M5.5 4.25 L10.5 4.25 L7.4 11.75"/>',
    "8": '<ellipse cx="8" cy="6.1" rx="2.05" ry="1.85"/>'
         '<ellipse cx="8" cy="9.85" rx="2.45" ry="1.9"/>',
    # Il 9 è il 6 ruotato: stesse curve, stesso peso.
    "9": '<g transform="rotate(180 8 8)"><path d="M9.9 4.6 C9.4 4.4 8.8 4.25 8.2 4.25 '
         'C6.5 4.25 5.5 5.9 5.5 8.3 C5.5 10.4 6.5 11.75 8 11.75 C9.5 11.75 10.5 10.7 10.5 9.4 '
         'C10.5 8.1 9.5 7.1 8.1 7.1 C7 7.1 6 7.7 5.55 8.6"/></g>',
    "plus": '<path d="M8 4.9 L8 11.1 M4.9 8 L11.1 8"/>',
}


def svg(glyph, dx=0.0, dy=0.0):
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">'
        f'<circle cx="8" cy="8" r="8" fill="{RED}"/>'
        f'<g transform="translate({dx:.3f} {dy:.3f})" fill="none" stroke="#ffffff" '
        f'stroke-width="{STROKE}" stroke-linecap="round" stroke-linejoin="round">'
        f'{glyph}</g></svg>\n'
    )


def render(text, size):
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = Path(tmp) / "b.svg", Path(tmp) / "b.png"
        src.write_text(text)
        subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), "-o", str(dst), str(src)],
                       check=True)
        return Image.open(dst).convert("RGBA")


def ink_center(img):
    """Centro del riquadro che contiene i pixel bianchi (il simbolo)."""
    px = img.load()
    w, h = img.size
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 0 and min(r, g, b) > 160:
                xs.append(x)
                ys.append(y)
    return (min(xs) + max(xs) + 1) / 2, (min(ys) + max(ys) + 1) / 2


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    unit = BIG / 16
    for name, glyph in GLYPHS.items():
        dx = dy = 0.0
        for _ in range(3):  # due-tre giri bastano per arrivare sotto 1/100 di pixel
            cx, cy = ink_center(render(svg(glyph, dx, dy), BIG))
            dx -= (cx - BIG / 2) / unit
            dy -= (cy - BIG / 2) / unit
        final = svg(glyph, dx, dy)
        (OUT / f"badge-{name}.svg").write_text(final)
        cx, cy = ink_center(render(final, BIG))
        print(f"{name:>4}: scarto finale x={(cx - BIG / 2) / unit:+.3f} y={(cy - BIG / 2) / unit:+.3f} "
              f"(unità della griglia da 16)")

    # Anteprima: in grande e alle dimensioni reali (15, 22, 30 px).
    names = list(GLYPHS)
    sheet = Image.new("RGBA", (len(names) * 90 + 10, 200), (31, 31, 31, 255))
    for i, name in enumerate(names):
        text = (OUT / f"badge-{name}.svg").read_text()
        sheet.alpha_composite(render(text, 80), (10 + i * 90, 10))
        x = 10 + i * 90
        for size, y in ((15, 110), (22, 135), (30, 165)):
            sheet.alpha_composite(render(text, size), (x + (80 - size) // 2, y))
    sheet.save(HERE / "badge-anteprima.png")
    print("anteprima:", HERE / "badge-anteprima.png")


if __name__ == "__main__":
    main()
