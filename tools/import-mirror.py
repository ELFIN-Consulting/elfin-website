"""Einmal-Import: WordPress-Spiegel von elfin-consulting.com -> bereinigte statische Seiten in site/.

Aufruf (aus dem Repo-Root):  python -I tools/import-mirror.py <mirror-ordner>
  <mirror-ordner> = C:/dev/web/_mirror-elfin-consulting  (raw/ = Original-HTML, site/ = Dateien)

Was passiert:
  - Seiten aus raw/ lesen (Original-HTML mit absoluten URLs), Eventin-Reste auslassen.
  - Tracking entfernen: Google Tag Manager, Consent-Mode, Cookiebot, reCAPTCHA.
  - WordPress-/Plugin-Ballast entfernen: WP Rocket (Lazyload, Preload), WPML-Cookie, Eventin,
    Feeds/oEmbed/REST-Links, Generator-Tags, Werbekommentare.
  - Lazy-Bilder auf das Original-<img> zurueckstellen (aus dem <noscript>), Hintergrundbilder fest einbinden.
  - Eigene URLs auf root-relative Pfade umstellen (Canonical, og:* und JSON-LD bleiben absolut).
  - Alle referenzierten Dateien (Bilder, Fonts, JS, PDFs) aus site/ kopieren, grosse Fotos neu komprimieren.

Danach ist site/ die Quelle: Aenderungen an der Website passieren dort, nicht mehr in WordPress.
"""

import json
import re
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

MIRROR = Path(sys.argv[1] if len(sys.argv) > 1 else "C:/dev/web/_mirror-elfin-consulting")
RAW, FILES = MIRROR / "raw", MIRROR / "site"
OUT = Path("site")
ORIGIN = "https://elfin-consulting.com"
SKIP = ("events/", "events-2/", "etn_category/", "wp-content/")
FALLBACK_404 = MIRROR / "raw404"  # live geholte 404-Seiten (en.html, de.html)

missing: set[str] = set()
assets: set[str] = set()


# --- Bereinigung -------------------------------------------------------------

SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script>\s*", re.S)
DROP_SCRIPT_IDS = re.compile(
    r"^(Cookiebot|CookieDeclaration|wpml-cookie-js(-extra)?|rocket-.*|rocket_lazyload_css-js-.*"
    r"|etn-.*|eventin-.*|avia_google_recaptcha_front_script-js-extra)$"
)
DROP_SCRIPT_BODY = ("const rocket_pairs", "googletagmanager.com", "gtag(", "window.lazyLoadOptions", "function lazyLoadThumb")
DROP_SCRIPT_SRC = ("lazyload.min.js", "html5shiv.js")


def drop_scripts(html: str, keep_wp_i18n: bool) -> str:
    def repl(m: re.Match) -> str:
        attrs, body = m.group(1), m.group(2)
        sid = re.search(r'\bid="([^"]+)"', attrs)
        sid = sid.group(1) if sid else ""
        src = re.search(r'\bsrc="([^"]+)"', attrs)
        src = src.group(1) if src else ""
        if sid and DROP_SCRIPT_IDS.match(sid):
            return ""
        if sid in ("wp-hooks-js", "wp-i18n-js", "wp-i18n-js-after") and not keep_wp_i18n:
            return ""
        if 'type="speculationrules"' in attrs:
            return ""
        if src and any(s in src for s in DROP_SCRIPT_SRC):
            return ""
        if not src and any(s in body for s in DROP_SCRIPT_BODY):
            return ""
        if sid == "avia-footer-scripts-js-extra":
            rest = re.sub(r"var AviaReCAPTCHA_front = \{.*?\};", "", body, flags=re.S)
            rest = re.sub(r"//# sourceURL=\S+", "", rest).strip()
            if rest:
                raise SystemExit("avia-footer-scripts-js-extra enthaelt mehr als reCAPTCHA - pruefen")
            return ""
        if sid == "contact-form-7-js-before":
            m2 = m.group(0).replace(r"https:\/\/elfin-consulting.com\/wp-json\/", r"\/wp-json\/")
            return m2.replace('"cached": 1', '"cached": 0')
        return m.group(0)

    return SCRIPT_RE.sub(repl, html)


def background_images(html: str) -> str:
    """WP Rocket laedt CSS-Hintergruende per JS (rocket_pairs). Wir binden sie fest ein."""
    rules: list[str] = []
    # "exclusion" = Bilder oberhalb der Falz (sofort geladen), "nostyle" = Fallback ohne JS
    for sid in ("wpr-lazyload-bg-exclusion", "wpr-lazyload-bg-container", "wpr-lazyload-bg-nostyle"):
        m = re.search(rf'(?:<noscript>)?<style id="{sid}">(.*?)</style>(?:</noscript>)?\s*', html, re.S)
        if m:
            rules += re.findall(r"[^{}]+\{[^{}]*\}", m.group(1))
            html = html.replace(m.group(0), "", 1)
    decoder = json.JSONDecoder()
    for name in ("rocket_pairs", "rocket_excluded_pairs"):
        m = re.search(rf"const {name} = ", html)
        if m:
            rules += [p["style"] for p in decoder.raw_decode(html, m.end())[0] if p.get("style")]
    css = "".join(dict.fromkeys(r.strip() for r in rules))  # doppelte Regeln einmal
    if not css:
        return html
    return html.replace("</head>", f'<style id="background-images">{css}</style>\n</head>', 1)


def lazy_media(html: str) -> str:
    """<img data-lazy-src ...><noscript><img ...></noscript> -> das Original aus dem <noscript>."""
    pair = re.compile(
        r"<(img|iframe)\b[^>]*\bdata-lazy-src=[^>]*>(?:</iframe>)?\s*<noscript>\s*(<(?:img|iframe)\b.*?)</noscript>",
        re.S,
    )
    html = pair.sub(lambda m: m.group(2), html)
    html = re.sub(r'<noscript><style id="rocket-lazyload-nojs-css">.*?</style></noscript>\s*', "", html, flags=re.S)
    html = re.sub(r'<style id="rocket-lazyload-inline-css">.*?</style>\s*', "", html, flags=re.S)
    # Hintergrundbilder per data-bg (Masonry) -> Inline-Style wie im Original-Enfold-Markup
    def bg(m: re.Match) -> str:
        tag = re.sub(r"\s*rocket-lazyload", "", m.group(0).replace(m.group(1), ""))
        return re.sub(r'style="([^"]*)"', lambda s: f'style="{s.group(1)}background-image: url({m.group(2)});"', tag, count=1)

    html = re.sub(r'<[a-z]+\b[^>]*?(\s*data-bg="([^"]+)")[^>]*>', bg, html)
    if "data-lazy-src" in html or "data-bg=" in html:
        raise SystemExit("data-lazy-src uebrig - Muster pruefen")
    return html


HEAD_LINK_DROP = re.compile(
    r"<link\b[^>]*(?:data-rocket-prefetch|rel=['\"](?:EditURI|shortlink|pingback|profile|https://api\.w\.org/)['\"]"
    r"|application/rss\+xml|json\+oembed|xml\+oembed|type=\"application/json\""
    r"|/plugins/wp-event-solution/|/plugins/f12-cf7-doubleoptin/)[^>]*>\s*"
)
COMMENT_DROP = re.compile(
    r"<!--(?:\[if lt IE 9\].*?<!\[endif\]|\s*This site is optimized with the Yoast.*?|\s*/ Yoast SEO plugin\.\s*"
    r"|\s*Double Opt-in Powered By.*?|\s*This website is like a Rocket.*?|\s*Debugging Info for Theme support.*?"
    r"|\s*To speed up the rendering.*?)-->\s*",
    re.S,
)


def clean_head(html: str) -> str:
    html = HEAD_LINK_DROP.sub("", html)
    html = re.sub(r'<meta name="generator"[^>]*>\s*', "", html)
    html = COMMENT_DROP.sub("", html)
    html = re.sub(r"<noscript><iframe[^>]*googletagmanager[^>]*>.*?</noscript>\s*", "", html, flags=re.S)
    return html


def clean_forms(html: str) -> str:
    # reCAPTCHA-Feld und "Formular deaktiviert"-Hinweis (Cookiebot) entfernen
    html = re.sub(r"<div id='avia_\d+_\d+' class='av-recaptcha-area.*?</div></div>", "", html, flags=re.S)
    html = re.sub(r'<div class="avia-disabled-form">.*?</div>', "", html, flags=re.S)
    html = re.sub(r'(<body\b[^>]*class="[^"]*?)\s*av-recaptcha-enabled', r"\1", html)
    if "class='av-recaptcha-area" in html or "AviaReCAPTCHA_front =" in html:
        raise SystemExit("reCAPTCHA-Reste - pruefen")
    return html


# --- URLs --------------------------------------------------------------------

KEEP_ABSOLUTE = re.compile(
    r'<link rel="canonical"[^>]*>|<meta property="og:[^>]*>|<meta name="twitter:[^>]*>'
    r'|<script type="application/ld\+json".*?</script>',
    re.S,
)
OWN_URL = re.compile(r"https?:(?:\\?/){2}(?:www\.)?elfin-consulting\.com(?=[\\/\"'\s)?#]|$)")


def relativize(html: str) -> str:
    keep: list[str] = []

    def stash(m: re.Match) -> str:
        keep.append(m.group(0))
        return f"\x00{len(keep) - 1}\x00"

    html = KEEP_ABSOLUTE.sub(stash, html)
    html = OWN_URL.sub("", html)
    html = re.sub(r"\x00(\d+)\x00", lambda m: keep[int(m.group(1))], html)
    return html


ASSET_RE = re.compile(r"""(?:(?<=["'(\s,=])|^)(/(?:wp-content|wp-includes)/[^"'()\s,<>\\]+)""")


def collect_assets(text: str) -> None:
    for m in ASSET_RE.finditer(text.replace("\\/", "/")):
        path = unquote(urlsplit(m.group(1).replace("&#038;", "&").replace("&amp;", "&")).path)
        if path.endswith("/"):
            continue
        assets.add(path)


# --- Seiten ------------------------------------------------------------------


def convert(html: str) -> str:
    html = background_images(html)  # liest rocket_pairs, also vor drop_scripts
    html = drop_scripts(html, keep_wp_i18n="contact-form-7-js" in html)
    html = lazy_media(html)
    html = clean_head(html)
    html = clean_forms(html)
    html = relativize(html)
    html = re.sub(r"\n{3,}", "\n\n", html)
    return html


def pages():
    for f in sorted(RAW.rglob("index.html")):
        rel = f.relative_to(RAW).as_posix()
        if not rel.startswith(SKIP):
            yield rel, f.read_text(encoding="utf-8")
    for lang, target in (("en", "404.html"), ("de", "de/404.html")):
        src = FALLBACK_404 / f"{lang}.html"
        if src.exists():
            yield target, src.read_text(encoding="utf-8")


def copy_asset(path: str) -> None:
    rel = path.lstrip("/")
    src = FILES / rel
    if not src.exists():
        # der Spiegel hat Query-Strings in den Dateinamen kodiert (ec.min.js?v=... -> ec.min__q<hash>.js)
        cands = list(src.parent.glob(f"{src.stem}__q*{src.suffix}")) if src.parent.exists() else []
        if not cands:
            missing.add(path)
            return
        src = cands[0]
    dst = OUT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        shutil.copy2(src, dst)


def optimize_images() -> None:
    """Grosse Fotos neu komprimieren (WordPress hat sie fast unkomprimiert abgelegt).

    JPEG > 300 KB: Qualitaet 80, progressiv. Deckende PNG-Fotos > 300 KB werden zu JPEG,
    die Verweise in HTML/CSS werden umgeschrieben. Abmessungen bleiben gleich (srcset passt weiter).
    """
    import io

    from PIL import Image

    def jpeg(im: Image.Image) -> bytes:
        buf = io.BytesIO()
        im.convert("RGB").save(
            buf, "JPEG", quality=80, optimize=True, progressive=True, icc_profile=im.info.get("icc_profile")
        )
        return buf.getvalue()

    before = after = 0
    renamed: dict[str, str] = {}
    for f in sorted((OUT / "wp-content/uploads").rglob("*")):
        size = f.stat().st_size if f.is_file() else 0
        if size < 300_000 or f.suffix.lower() not in (".jpg", ".jpeg", ".png"):
            continue
        with Image.open(f) as im:
            im.load()
            if f.suffix.lower() == ".png":
                if im.mode in ("RGBA", "LA", "P") and im.convert("RGBA").getextrema()[3][0] < 255:
                    continue  # echte Transparenz: PNG bleiben lassen
                target = f.with_suffix(".jpg")
                if target.exists():
                    target = f.with_name(f"{f.stem}-png.jpg")
            else:
                target = f
            data = jpeg(im)
        if len(data) > size * 0.85:
            continue
        before += size
        after += len(data)
        target.write_bytes(data)
        if target != f:
            f.unlink()
            renamed["/" + f.relative_to(OUT).as_posix()] = "/" + target.relative_to(OUT).as_posix()

    if renamed:
        # Pfade kommen normal und JSON-escaped vor (\/wp-content\/...)
        mapping = dict(renamed)
        mapping.update({k.replace("/", "\\/"): v.replace("/", "\\/") for k, v in renamed.items()})
        pattern = re.compile("|".join(re.escape(k) for k in sorted(mapping, key=len, reverse=True)))
        for doc in list(OUT.rglob("*.html")) + list(OUT.rglob("*.css")):
            text = doc.read_text(encoding="utf-8")
            new = pattern.sub(lambda m: mapping[m.group(0)], text)
            if new != text:
                doc.write_text(new, encoding="utf-8", newline="\n")
    print(f"Bilder: {before / 1e6:.0f} MB -> {after / 1e6:.0f} MB, {len(renamed)} PNG-Fotos zu JPEG")


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    n = 0
    for rel, html in pages():
        out = convert(html)
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(out, encoding="utf-8", newline="\n")
        collect_assets(OWN_URL.sub("", out))  # auch og:image/JSON-LD-Bilder mitnehmen
        n += 1

    # Assets rekursiv: JS/CSS koennen weitere Dateien nachladen
    done: set[str] = set()
    while assets - done:
        for path in sorted(assets - done):
            done.add(path)
            copy_asset(path)
            dst = OUT / path.lstrip("/")
            if dst.suffix in (".css", ".js") and dst.exists():
                text = relativize(dst.read_text(encoding="utf-8", errors="replace"))
                if dst.suffix == ".css":
                    dst.write_text(text, encoding="utf-8", newline="\n")
                collect_assets(text)

    print(f"{n} Seiten, {len(done) - len(missing)} Dateien kopiert")
    optimize_images()
    if missing:
        print(f"{len(missing)} fehlen im Spiegel:")
        for p in sorted(missing):
            print("  ", p)


if __name__ == "__main__":
    main()
