// Webserver für elfin-consulting.com: liefert die statische Seite aus public/ aus,
// nimmt die Kontaktformulare an (siehe forms.js) und beantwortet /health für den Deploy-Check.
// Verhält sich bei Adressen wie das alte Apache/WordPress: /seite -> 301 /seite/, 404-Seite je Sprache.
import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleForm, isFormRequest } from "./forms.js";

// Im Build liegt die Seite in dist/public/, beim Entwickeln direkt in site/
const BUILT = fileURLToPath(new URL("./public/", import.meta.url));
const DEFAULT_PUBLIC_DIR = existsSync(BUILT)
  ? BUILT
  : fileURLToPath(new URL("../site/", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
  // Vorschau (Test-Adresse): NOINDEX=1 in /etc/<app>/env, damit Suchmaschinen sie nicht aufnehmen
  ...(process.env.NOINDEX === "1" && { "x-robots-tag": "noindex, nofollow" }),
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
}

/** Datei unter public/ finden; null, wenn es sie nicht gibt oder der Pfad hinausführt. */
async function resolveFile(publicDir, pathname) {
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  const file = join(publicDir, relative);
  if (file !== publicDir.slice(0, -1) && !file.startsWith(publicDir)) {
    return null;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      const index = join(file, "index.html");
      const indexInfo = await stat(index).catch(() => null);
      return indexInfo?.isFile()
        ? { file: index, info: indexInfo, isDir: true }
        : null;
    }
    return info.isFile() ? { file, info, isDir: false } : null;
  } catch {
    return null;
  }
}

async function serveFile(req, res, { file, info }, status = 200) {
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const isHtml = type.startsWith("text/html");
  res.writeHead(status, {
    "content-type": type,
    "content-length": info.size,
    "last-modified": info.mtime.toUTCString(),
    // Seiten immer frisch, Bilder/Skripte eine Woche (Dateinamen sind nicht versioniert)
    "cache-control": isHtml ? "no-cache" : "public, max-age=604800",
    ...SECURITY_HEADERS,
  });
  if (req.method === "HEAD") {
    return res.end();
  }
  createReadStream(file).pipe(res);
}

async function notFound(publicDir, req, res, pathname) {
  const page = pathname.startsWith("/de/") ? "de/404.html" : "404.html";
  const hit = await resolveFile(publicDir, page);
  if (hit) {
    return serveFile(req, res, hit, 404);
  }
  return send(res, 404, "Nicht gefunden");
}

export function createApp({ publicDir = DEFAULT_PUBLIC_DIR } = {}) {
  if (!publicDir.endsWith(sep)) {
    publicDir += sep;
  }
  return createServer(async (req, res) => {
    let url;
    let pathname;
    try {
      url = new URL(req.url, "http://localhost");
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, "Ungültige Adresse");
    }

    try {
      if (pathname === "/health") {
        return send(res, 200, JSON.stringify({ status: "ok" }), {
          "content-type": TYPES[".json"],
          "cache-control": "no-store",
        });
      }
      if (isFormRequest(req, pathname)) {
        return await handleForm(req, res, pathname, publicDir);
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return send(res, 405, "Methode nicht erlaubt", { allow: "GET, HEAD" });
      }

      const hit = await resolveFile(publicDir, pathname);
      if (!hit) {
        return notFound(publicDir, req, res, pathname);
      }
      // wie WordPress: Ordner-Adressen immer mit Schrägstrich am Ende
      if (hit.isDir && !pathname.endsWith("/") && !pathname.endsWith(sep)) {
        return send(res, 301, "", {
          location: `${url.pathname}/${url.search}`,
        });
      }
      return await serveFile(req, res, hit);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        send(res, 500, "Interner Fehler");
      }
    }
  });
}

if (import.meta.main) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, host, () => {
    console.log(`elfin-website läuft auf http://${host}:${port}`);
  });
}
