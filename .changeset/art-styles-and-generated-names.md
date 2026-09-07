---
"@originals/landing": minor
---

**The demo names what it actually draws.**

The MEDIUM control offered Artwork / Music / Writing / Photograph / Dataset, but the renderer mapped those five labels onto three shapes — and Artwork and Photograph were byte-identical. Picking "Photograph" drew vector orbits. A label the picture cannot keep is worse than no label.

MEDIUM is now STYLE, named for what each one draws: **Orbits**, **Constellation**, **Radial Bars**, **Dot Grid**. Every style renders differently, and a test asserts no two produce the same picture.

The title is now generated too, from the same (style, nonce) seed as the artwork — so one Regenerate moves the name and the picture together, and a visitor lands on a titled piece instead of a placeholder asking them to invent one. A **New name** button re-rolls it; typing your own still works.

The picture is now seeded by style and nonce alone rather than by the title, so typing a name no longer reshuffles the art underneath you. The title still reaches the hashed bytes through the SVG's `<title>` element, so what you type is still what gets signed.

`metadata.json` carries `style` where it carried `medium`. Readers accept either, so assets published before the rename — including the first real mainnet Original — keep rendering their label.
