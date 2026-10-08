#!/usr/bin/env python3
"""
writes games.json - the list of games the hub page reads.

the whole workflow:
    drag a game html (and optionally a picture) into games/
    run this
    refresh

    python build_games.py

naming: a game's picture is just an image next to it with the same name, e.g.
games/snake.html + games/snake.png. any of these work: png jpg jpeg webp gif avif svg
a file starting with "_" is ignored (handy for templates).
"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(ROOT, "games")
MANIFEST = os.path.join(ROOT, "games.json")

GAME_EXTS = (".html", ".htm")
IMAGE_EXTS = ("png", "jpg", "jpeg", "webp", "gif", "avif", "svg")


def pretty(base):
    """geometry-dash / geometry_dash / GeometryDash -> 'geometry dash'"""
    return re.sub(r"[-_\s]+", " ", base).strip().lower()


def scan():
    """every game in games/, alphabetical, each with its picture if it has one"""
    games = []
    if not os.path.isdir(GAMES_DIR):
        return games

    files = os.listdir(GAMES_DIR)
    by_lower = {f.lower(): f for f in files}

    for filename in sorted(files):
        base, ext = os.path.splitext(filename)
        if ext.lower() not in GAME_EXTS:
            continue
        if base.startswith("_") or base.lower() == "index":
            continue

        img = None
        for wanted in IMAGE_EXTS:
            actual = by_lower.get(f"{base.lower()}.{wanted}")
            if actual:
                img = f"games/{actual}"
                break

        games.append({
            "slug": base,
            "name": pretty(base),
            "game": f"games/{filename}",
            "img": img,
        })

    games.sort(key=lambda g: g["name"])
    return games


def write_manifest(games=None):
    """scan (or use the list passed in) and save games.json"""
    if games is None:
        games = scan()
    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(games, fh, indent=2)
        fh.write("\n")
    return games


def main():
    games = write_manifest()
    print(f"wrote {os.path.relpath(MANIFEST, ROOT)} - {len(games)} game(s), alphabetical")
    for g in games:
        print(f"  {g['name']:<28} {g['game']}  {'+ ' + g['img'] if g['img'] else '(no picture)'}")
    if not games:
        print("  (nothing yet - drop a .html file into games/ and run this again)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
