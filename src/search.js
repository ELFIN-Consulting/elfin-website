// Suche wie bei WordPress: /?s=begriff (Englisch) und /de/?s=begriff (Deutsch).
// Die Seite selbst ist die bereinigte Enfold-Suchseite (templates/search.json, erzeugt von
// tools/import-search.py); hier werden nur die Treffer eingesetzt.
//
// Decision: Volltextsuche über die ausgelieferten Seiten, Index im Speicher beim ersten Aufruf.
// Why: ~50 Seiten, ändern sich nur mit einem Deploy (= Neustart); kein Suchdienst, keine Datenbank.
// Alternatives rejected:
//   - Suche im Browser (JS-Index) → die Seiten sollen unverändert bleiben, das Suchfeld schickt per GET
//   - Index beim Build → doppelte Quelle; Einlesen dauert beim ersten Aufruf nur Millisekunden
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const TEMPLATES = JSON.parse(
  readFileSync(new URL("./templates/search.json", import.meta.url), "utf8"),
);

// WordPress lässt diese Wörter weg, sobald mehr als ein Suchbegriff angegeben ist
const STOPWORDS = new Set(
  "about an are as at be by com for from how in is it of on or that the this to was what when where who will with www".split(
    " ",
  ),
);

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decode(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] !== "#") {
      return ENTITIES[code.toLowerCase()] ?? all;
    }
    const n =
      code[1] === "x" || code[1] === "X"
        ? parseInt(code.slice(2), 16)
        : Number(code.slice(1));
    return String.fromCodePoint(n);
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function* htmlPages(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "wp-content") {
      yield* htmlPages(join(dir, entry.name));
    } else if (entry.name === "index.html") {
      yield join(dir, entry.name);
    }
  }
}

/** Eine Seite für den Index: Titel, Datum, Text des Inhaltsbereichs (ohne Kopf und Fuß). */
export function indexPage(html, url) {
  // WordPress zeigt den Beitragstitel: bei Beiträgen die Schema-"headline", bei Seiten der <title> ohne Zusatz
  const headline = html.match(/"headline":("(?:[^"\\]|\\.)*")/)?.[1];
  const rawTitle = html.match(/<title>(.*?)<\/title>/s)?.[1] ?? url;
  const titleHtml = headline
    ? escapeHtml(decode(JSON.parse(headline)))
    : rawTitle.replace(/\s+-\s+ELFIN Consulting\s*$/, "").trim();
  const start = html.indexOf("<div id='main'");
  const end = html.indexOf("id='footer'", start);
  const body = html
    .slice(start === -1 ? 0 : start, end === -1 ? undefined : end)
    .replace(/<(script|style|noscript|svg)\b.*?<\/\1>/gis, " ")
    .replace(/<[^>]+>/g, " ");
  return {
    url,
    lang: url.startsWith("/de/") ? "de" : "en",
    titleHtml,
    title: decode(titleHtml).toLowerCase(),
    text: decode(body).replace(/\s+/g, " ").toLowerCase(),
    published: html.match(/"datePublished":"([^"]+)"/)?.[1] ?? "",
  };
}

const indexes = new Map();

function loadIndex(publicDir) {
  if (!indexes.has(publicDir)) {
    const build = (async () => {
      const pages = [];
      for await (const file of htmlPages(publicDir)) {
        const rel = relative(publicDir, file).split(sep).slice(0, -1).join("/");
        pages.push(
          indexPage(await readFile(file, "utf8"), rel ? `/${rel}/` : "/"),
        );
      }
      return pages;
    })();
    build.catch(() => indexes.delete(publicDir));
    indexes.set(publicDir, build);
  }
  return indexes.get(publicDir);
}

/** Suchbegriffe wie WordPress: Leerzeichen trennen, "in Anführungszeichen" bleibt zusammen. */
export function searchTerms(query) {
  const terms = [...query.toLowerCase().matchAll(/"([^"]+)"|(\S+)/g)]
    .map((m) => (m[1] ?? m[2]).trim())
    .filter(Boolean);
  const kept =
    terms.length > 1 ? terms.filter((t) => !STOPWORDS.has(t)) : terms;
  return kept.length ? kept : terms;
}

/** Treffer: jeder Begriff kommt in Titel oder Text vor. Reihenfolge wie WordPress. */
export function search(pages, query) {
  const terms = searchTerms(query);
  if (!terms.length) {
    return [];
  }
  const phrase = query.toLowerCase().trim();
  const rank = (p) => {
    if (terms.length === 1) {
      return p.title.includes(terms[0]) ? 0 : 1;
    }
    if (p.title.includes(phrase)) return 0;
    if (terms.every((t) => p.title.includes(t))) return 1;
    if (terms.some((t) => p.title.includes(t))) return 2;
    return p.text.includes(phrase) ? 3 : 4;
  };
  return pages
    .filter((p) =>
      terms.every((t) => p.title.includes(t) || p.text.includes(t)),
    )
    .map((p) => ({ page: p, rank: rank(p) }))
    .sort(
      (a, b) =>
        a.rank - b.rank || b.page.published.localeCompare(a.page.published),
    )
    .map((r) => r.page);
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => values[key] ?? all);
}

function formatDate(iso, months) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return y ? `${d}. ${months[m - 1]} ${y}` : "";
}

function resultHtml(page, i, count, months) {
  const n = i + 1;
  const classes = [
    "post-entry post-entry-type-standard",
    `post-entry-${n} post-loop-${n} post-parity-${n % 2 ? "odd" : "even"}`,
    n === count ? "post-entry-last" : "",
    "single-small page type-page status-publish hentry",
  ]
    .filter(Boolean)
    .join(" ");
  const date = page.published
    ? `<span class="post-meta-infos"><time class="date-container minor-meta updated" itemprop="datePublished" datetime="${escapeHtml(page.published)}" >${formatDate(page.published, months)}</time></span>`
    : "";
  return (
    `<article class="${classes}" itemscope="itemscope" itemtype="https://schema.org/CreativeWork" >` +
    `<div class="entry-content-wrapper clearfix standard-content">` +
    `<header class="entry-content-header" aria-label="Search Result: ${page.titleHtml}" >` +
    `<span class='search-result-counter '>${n}</span>` +
    `<h2 class='post-title entry-title '><a title='${page.titleHtml.replace(/'/g, "&#39;")}' href='${page.url}' itemprop="headline" >${page.titleHtml}</a></h2>` +
    `${date}</header><div class="entry-content" itemprop="text" ></div></div>` +
    `<footer class="entry-footer"></footer></article><!--end post-entry-->\n`
  );
}

/** Fertige Suchergebnisseite für /?s= bzw. /de/?s= */
export async function renderSearch(publicDir, lang, rawQuery) {
  const t = TEMPLATES[lang];
  const query = rawQuery.trim().slice(0, 200);
  const pages = (await loadIndex(publicDir)).filter((p) => p.lang === lang);
  const hits = search(pages, query);
  const q = escapeHtml(query);
  const heading = hits.length
    ? fill(t.heading[hits.length === 1 ? "one" : "many"], {
        n: hits.length,
        query: q,
      })
    : fill(t.heading.none, { query: q });
  const results =
    `<h4 class='extra-mini-title widgettitle'>${heading}</h4>\n` +
    (hits.length
      ? hits.map((p, i) => resultHtml(p, i, hits.length, t.months)).join("")
      : t.nothing);
  return fill(t.page, {
    results,
    query: q,
    queryUrl: encodeURIComponent(query),
    title: fill(t.title, { query: q }),
    bodyClass: hits.length ? "search-results" : "search-no-results",
  });
}
