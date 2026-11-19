# Icon sources

The editable originals the PNGs beside them were rendered from. They arrived as
a zip at the repository root, which is a strange thing to keep in a source tree,
so the sources are here and the zip is gone.

| SVG | renders to | used for |
| --- | --- | --- |
| `icon-full.svg` | `../icon.png` (1024², full bleed) | the app icon, and `play-store-icon.png` at 512² |
| `adaptive-foreground.svg` | `../adaptive-icon-foreground.png` (1024², transparent) | the Android adaptive icon's foreground |
| `adaptive-monochrome.svg` | `../adaptive-icon-monochrome.png` (1024², white on transparent) | the Android 13+ themed icon, tinted to the wallpaper |
| `splash-icon.svg` | `../splash-icon.png` (1024², transparent) | the native splash |

The mark sits inside the 66/108 safe zone, so every launcher mask — circle,
squircle, rounded square — keeps the whole book and its ribbon.

Colours: background `#1B1410`, amber `#E8A23A`, paper `#EFE3CC`, ribbon
`#C8402F`.

**The PNGs are not simply these re-rendered.** The adaptive foreground and
monochrome were re-centred after the kit was made (`460a9c2`), so the files in
`assets/` are ahead of these sources. Re-render from here and you will undo
that; adjust the SVG to match first.
