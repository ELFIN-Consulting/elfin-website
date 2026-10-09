// Baut dist/: Server aus src/, Website aus site/ nach dist/public/,
// dazu Sitemap, robots.txt und version.json (Commit + Build-Zeit).
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ORIGIN = "https://elfin-consulting.com";

await rm("dist", { recursive: true, force: true });
await cp("src", "dist", { recursive: true });
await cp("site", "dist/public", { recursive: true });

// Sitemap aus allen indexierbaren Seiten (ohne 404 und noindex)
const urls = [];
for (const entry of await readdir("site", { recursive: true })) {
  const file = entry.replaceAll("\\", "/");
  if (!file.endsWith("index.html") || file.startsWith("wp-")) continue;
  const html = await readFile(join("site", file), "utf8");
  if (/<meta name=['"]robots['"] content=['"][^'"]*noindex/.test(html))
    continue;
  const path = `/${file.slice(0, -"index.html".length)}`;
  const modified = /article:modified_time" content="([^"]+)"/.exec(html)?.[1];
  urls.push({ loc: ORIGIN + path, lastmod: modified });
}
urls.sort((a, b) => a.loc.localeCompare(b.loc));

const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...urls.map(
    (u) =>
      `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`,
  ),
  "</urlset>",
  "",
].join("\n");
await writeFile("dist/public/sitemap.xml", sitemap);
// Yoast-Adresse beibehalten, damit bei Google hinterlegte Sitemaps weiter funktionieren
await writeFile(
  "dist/public/sitemap_index.xml",
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <sitemap><loc>${ORIGIN}/sitemap.xml</loc></sitemap>`,
    "</sitemapindex>",
    "",
  ].join("\n"),
);
await writeFile(
  "dist/public/robots.txt",
  `User-agent: *\nDisallow:\n\nSitemap: ${ORIGIN}/sitemap_index.xml\n`,
);

const version = {
  commit: process.env.GITHUB_SHA ?? "lokal",
  builtAt: new Date().toISOString(),
};
await writeFile(
  "dist/public/version.json",
  `${JSON.stringify(version, null, 2)}\n`,
);
console.log(`dist/ gebaut: ${urls.length} Seiten in der Sitemap`, version);
