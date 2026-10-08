#!/usr/bin/env python3
"""
local server for m's games and stuff.

it rescans games/ on every request, so while you're building the site:
    drag a game html (and its picture) into games/  ->  refresh the page

    python serve.py            # then open http://127.0.0.1:8123
    python serve.py --open     # same, and pops the browser open
    python serve.py 9000       # a different port

a hosted copy has no server behind it, so there the list comes from games.json,
which build_games.py writes (and .github/workflows does automatically on push).
"""

import json
import os
import sys
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from build_games import ROOT, GAMES_DIR, scan, write_manifest


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    @staticmethod
    def is_manifest(path):
        return path.split("?")[0].split("#")[0] in ("/games.json", "/games.json/")

    def send_manifest(self, body_only=False):
        data = write_manifest_json()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not body_only:
            self.wfile.write(data)

    def do_GET(self):
        if self.is_manifest(self.path):
            return self.send_manifest()
        return super().do_GET()

    def do_HEAD(self):
        if self.is_manifest(self.path):
            return self.send_manifest(body_only=True)
        return super().do_HEAD()

    def end_headers(self):
        # never cache, so a refresh always sees a freshly dropped-in game
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet: the useful output is the scan, not every asset fetch


def write_manifest_json():
    """in-memory scan + refresh the on-disk copy, returned as json bytes"""
    games = scan()
    data = (json.dumps(games, indent=2) + "\n").encode("utf-8")
    try:
        write_manifest(games)
    except OSError:
        pass
    return data


def main():
    args = sys.argv[1:]
    open_browser = "--open" in args
    ports = [a for a in args if a.isdigit()]
    port = int(ports[0]) if ports else 8123

    games = scan()
    print(f"m's games and stuff -> http://127.0.0.1:{port}")
    print(f"watching {os.path.relpath(GAMES_DIR, ROOT)}{os.sep} - {len(games)} game(s):")
    for g in games:
        print(f"  {g['name']:<28} {g['game']}  {'+ ' + g['img'] if g['img'] else '(no picture)'}")
    print("\npress ctrl+c to stop")

    if open_browser:
        webbrowser.open(f"http://127.0.0.1:{port}/")

    with ThreadingHTTPServer(("127.0.0.1", port), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
