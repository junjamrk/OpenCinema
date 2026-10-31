#!/usr/bin/env python3
"""Generate the OpenCinema brand vectors.

Outputs (next to this script):
  logo.svg       light lockup, mark + wordmark, transparent background
  logoDark.svg   same lockup for dark surfaces
  markLogo.svg   mark only

The wordmark is Inter SemiBold shaped with HarfBuzz and written as outlined
paths, so the SVGs need no fonts installed. Rasterise with rasterize.mjs.

  python3 assets/brand/buildLogo.py            # write the three SVGs
  python3 assets/brand/buildLogo.py --sheet X  # write a variant sheet to X
"""
from __future__ import annotations

import argparse
import pathlib

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

HERE = pathlib.Path(__file__).resolve().parent
FONT = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"
GRAPHITE = "#101315"
PAPER = "#F7F7F4"
MINT = "#4FDBC8"
TEXT = "OpenCinema"
TRACKING_EM = -0.032


def shape_wordmark(size: float):
    """Return (glyph path list, advance width, cap height) at `size` px."""
    blob = hb.Blob.from_file_path(FONT)
    face = hb.Face(blob)
    font = hb.Font(face)
    upem = face.upem
    font.scale = (upem, upem)
    buf = hb.Buffer()
    buf.add_str(TEXT)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})

    tt = TTFont(FONT)
    glyph_set = tt.getGlyphSet()
    order = tt.getGlyphOrder()
    cap_height = tt["OS/2"].sCapHeight * size / upem
    scale = size / upem
    tracking = TRACKING_EM * size

    x = 0.0
    paths: list[str] = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        pen = SVGPathPen(glyph_set, ntos=lambda v: f"{v:.2f}")
        # Font units point up; SVG points down. Baseline at y = 0.
        tpen = TransformPen(pen, (scale, 0, 0, -scale, x + pos.x_offset * scale, -pos.y_offset * scale))
        glyph_set[name].draw(tpen)
        paths.append(pen.getCommands())
        x += pos.x_advance * scale + tracking
    return paths, x - tracking, cap_height


def mark_svg(x: float, y: float, size: float, stroke: str, dot: str, variant: str = "a") -> str:
    """Rounded frame open on the right, a mint port in the opening.

    Drawn in a 100-unit box and scaled to `size`. Variants are kept for the
    design sheet; production uses variant "a".
    """
    s = size / 100.0
    if variant == "d":
        width, radius, dot_r = 16.0, 30.0, 8.0
    else:
        width, radius, dot_r = 14.0, 30.0, 9.0
    inset = width / 2
    r = radius - inset  # centre-line corner radius
    lo, hi = inset, 100 - inset
    if variant == "c":
        # Opening at the top-right corner, port in the corner.
        d = (
            f"M{hi} {lo + r + 18} L{hi} {hi - r} A{r} {r} 0 0 1 {hi - r} {hi} "
            f"L{lo + r} {hi} A{r} {r} 0 0 1 {lo} {hi - r} L{lo} {lo + r} "
            f"A{r} {r} 0 0 1 {lo + r} {lo} L{hi - r - 18} {lo}"
        )
        dot_cx, dot_cy = hi - 4, lo + 4
    else:
        # Right side is only the two corner arcs; the straight part is the opening.
        d = (
            f"M{hi} {hi - r} A{r} {r} 0 0 1 {hi - r} {hi} L{lo + r} {hi} "
            f"A{r} {r} 0 0 1 {lo} {hi - r} L{lo} {lo + r} A{r} {r} 0 0 1 {lo + r} {lo} "
            f"L{hi - r} {lo} A{r} {r} 0 0 1 {hi} {lo + r}"
        )
        dot_cx, dot_cy = (hi + dot_r if variant == "b" else hi), 50.0
    return (
        f'<g transform="translate({x:.2f} {y:.2f}) scale({s:.5f})">'
        f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{width}" stroke-linecap="round"/>'
        f'<circle cx="{dot_cx}" cy="{dot_cy}" r="{dot_r}" fill="{dot}"/></g>'
    )


def lockup_svg(width: int, height: int, ink: str, variant: str = "a", margin: float = 150.0) -> str:
    """Mark + wordmark centred in a width × height canvas, transparent background."""
    # Fit: mark height = 1.3 × cap height; gap = 0.42 × mark height.
    probe_paths, probe_adv, probe_cap = shape_wordmark(100.0)
    cap_per_px = probe_cap / 100.0
    adv_per_px = probe_adv / 100.0

    def total_width(font_px: float) -> float:
        cap = cap_per_px * font_px
        mark = 1.3 * cap
        return mark + 0.42 * mark + adv_per_px * font_px

    font_px = (width - 2 * margin) / total_width(1.0)
    paths, adv, cap = shape_wordmark(font_px)
    mark = 1.3 * cap
    gap = 0.42 * mark
    content_w = mark + gap + adv
    x0 = (width - content_w) / 2
    cap_center_y = height / 2
    baseline = cap_center_y + cap / 2
    mark_y = cap_center_y - mark / 2
    glyphs = "".join(f'<path d="{d}"/>' for d in paths if d)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
        f'role="img" aria-labelledby="title desc"><title id="title">OpenCinema</title>'
        f'<desc id="desc">A rounded frame open on the right with a mint port in the opening, beside the OpenCinema wordmark.</desc>'
        f"{mark_svg(x0, mark_y, mark, ink, MINT, variant)}"
        f'<g fill="{ink}" transform="translate({x0 + mark + gap:.2f} {baseline:.2f})">{glyphs}</g></svg>\n'
    )


def mark_only_svg(size: int, ink: str, variant: str = "a") -> str:
    inner = size * 0.70
    pad = (size - inner) / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}" '
        f'role="img" aria-labelledby="title"><title id="title">OpenCinema symbol</title>'
        f"{mark_svg(pad, pad, inner, ink, MINT, variant)}</svg>\n"
    )


def write_sheet(path: pathlib.Path) -> None:
    rows = []
    for variant in "abcd":
        rows.append(f'<div class="row"><span class="tag">variant {variant}</span>{lockup_svg(1536, 400, GRAPHITE, variant, 60)}</div>')
    rows.append(f'<div class="row dark"><span class="tag">variant a · dark</span>{lockup_svg(1536, 400, PAPER, "a", 60)}</div>')
    rows.append(
        '<div class="row marks">' + "".join(f'<div>{mark_only_svg(220, GRAPHITE, v)}</div>' for v in "abcd") + "</div>"
    )
    html = (
        "<!doctype html><meta charset=utf-8><style>body{margin:0;background:#F7F7F4;font:600 20px/1 'JetBrains Mono'}"
        ".row{position:relative;width:1536px;height:400px}.row.dark{background:#121316}.row.marks{display:flex;gap:40px;padding:40px;height:300px;background:#fff}"
        ".tag{position:absolute;left:24px;top:16px;color:#4FDBC8}</style>" + "".join(rows)
    )
    path.write_text(html)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", help="write an HTML variant sheet to this path instead of the brand files")
    ap.add_argument("--variant", default="a")
    args = ap.parse_args()
    if args.sheet:
        write_sheet(pathlib.Path(args.sheet))
        return
    (HERE / "logo.svg").write_text(lockup_svg(3072, 800, GRAPHITE, args.variant))
    (HERE / "logoDark.svg").write_text(lockup_svg(3072, 800, PAPER, args.variant))
    (HERE / "markLogo.svg").write_text(mark_only_svg(1024, GRAPHITE, args.variant))
    print("wrote logo.svg logoDark.svg markLogo.svg")


if __name__ == "__main__":
    main()
