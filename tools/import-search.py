"""Einmal-Import der Suchergebnisseite aus WordPress als Vorlage fuer src/search.js.

Aufruf (aus dem Repo-Wurzelordner):
    python -I tools/import-search.py <spiegel>

Erwartet in <spiegel>/search/ die Live-Seiten {en,de}-esg.html (mit Treffern) und
{en,de}-none.html (ohne Treffer), z. B. per curl "https://elfin-consulting.com/?s=esg".
Bereinigt sie mit denselben Schritten wie import-mirror.py und schreibt
src/templates/search.json: je Sprache die Seite mit Platzhaltern und die Texte.
"""

import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("import_mirror", ROOT / "tools/import-mirror.py")
mirror = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mirror)

SEARCH = Path(sys.argv[1]) / "search"
OUT = ROOT / "src/templates/search.json"


def css_blocks(css: str) -> list[str]:
    """Oberste CSS-Ebene in Bloecke teilen (Regeln, @media, @font-face ...)."""
    blocks, depth, start = [], 0, 0
    for i, ch in enumerate(css):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                blocks.append(css[start : i + 1].strip())
                start = i + 1
    return blocks


def merge_used_css(page: str, other: str) -> str:
    """WP Rocket hat nur das CSS der jeweils angezeigten Seite behalten.
    Die Vorlage braucht beides: Trefferliste und "nichts gefunden"."""
    pattern = re.compile(r'(<style id="wpr-usedcss">)(.*?)(</style>)', re.S)
    have = pattern.search(page)
    extra = pattern.search(other)
    if not (have and extra):
        return page  # Suchseiten liefert WP Rocket mit den vollen Stylesheets aus
    known = set(css_blocks(have.group(2)))
    add = "".join(b for b in css_blocks(extra.group(2)) if b not in known)
    return page[: have.end(2)] + add + page[have.end(2) :]


def between(html: str, start: str, end: str) -> tuple[int, int]:
    i = html.index(start)
    return i, html.index(end, i)


def template(lang: str) -> dict:
    hits = (SEARCH / f"{lang}-esg.html").read_text(encoding="utf-8")
    none = (SEARCH / f"{lang}-none.html").read_text(encoding="utf-8")
    # Enfold laedt das Baukasten-CSS jedes Treffers mit; die Trefferliste zeigt nur Titel und Datum
    posts_css = re.compile(r"<link rel='stylesheet' id='avia-single-post-\d+-css'[^>]*>\s*")
    hits = posts_css.sub("", hits)
    page = mirror.convert(merge_used_css(hits, none))
    none = mirror.convert(none)

    # Trefferbereich: von der Ueberschrift bis zum Ende des Inhalts
    head = "<h4 class='extra-mini-title widgettitle'>"
    a, b = between(page, head, "<!--end content-->")
    page = page[:a] + "{{results}}" + page[b:]
    a, b = between(none, "<article class=\"entry entry-content-wrapper clearfix\" id='search-fail'>", "<!--end content-->")
    nothing = none[a:b].strip()

    page = re.sub(r"<title>.*?</title>", "<title>{{title}}</title>", page, count=1)
    page = re.sub(r'(<meta (?:property="og:title"|name="twitter:title") content=")[^"]*', r"\1{{title}}", page)
    # Yoast-Schema der Suchseite (noindex) traegt den Suchbegriff mehrfach, fuer Besucher ohne Wirkung
    page = re.sub(r'<script type="application/ld\+json" class="yoast-schema-graph">.*?</script>\s*', "", page, count=1, flags=re.S)
    page = page.replace('name="s" value="esg"', 'name="s" value="{{query}}"')
    page = page.replace("?s=esg", "?s={{queryUrl}}").replace("/search/esg/", "/search/{{queryUrl}}/")
    page = page.replace("search search-results ", "search {{bodyClass}} ", 1)
    leftover = [m.start() for m in re.finditer(r"\besg\b", page)]
    if leftover:
        raise SystemExit(f"{lang}: Suchbegriff noch an {len(leftover)} Stellen: {page[leftover[0] - 80 : leftover[0] + 40]!r}")

    # Stylesheets/Skripte, die nur die Suchseite nutzt, aus dem Spiegel nach site/ holen (rekursiv wie import-mirror.py)
    mirror.OUT = ROOT / "site"
    mirror.assets.clear()
    mirror.collect_assets(page)
    done: set[str] = set()
    while mirror.assets - done:
        for path in sorted(mirror.assets - done):
            done.add(path)
            dst = mirror.OUT / path.lstrip("/")
            if dst.exists():
                continue
            mirror.copy_asset(path)
            if dst.suffix in (".css", ".js") and dst.exists():
                text = mirror.relativize(dst.read_text(encoding="utf-8", errors="replace"))
                if dst.suffix == ".css":
                    dst.write_text(text, encoding="utf-8", newline="\n")
                mirror.collect_assets(text)
                print(f"  neu in site/: {path}")
    if mirror.missing:
        raise SystemExit(f"{lang}: fehlen im Spiegel: {sorted(mirror.missing)}")

    return {"page": page, "nothing": nothing}


def main() -> None:
    data = {
        "en": {
            **template("en"),
            "title": "You searched for {{query}} - ELFIN Consulting",
            "heading": {"one": "{{n}} search result for: {{query}}", "many": "{{n}} search results for: {{query}}", "none": "Search results for: {{query}}"},
            "months": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
        },
        "de": {
            **template("de"),
            "title": "Du hast nach {{query}} gesucht - ELFIN Consulting",
            "heading": {"one": "{{n}} Suchergebnis für: {{query}}", "many": "{{n}} Suchergebnisse für: {{query}}", "none": "Suchergebnisse für: {{query}}"},
            "months": ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{OUT.relative_to(ROOT)}: {OUT.stat().st_size // 1000} KB")


if __name__ == "__main__":
    main()
