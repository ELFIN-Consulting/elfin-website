// kununu-Siegel auf der Karriereseite über den eigenen Server: Besucher laden das Bild von uns,
// kununu erfährt beim Seitenaufruf nichts (keine IP an Dritte). Der Server holt das Siegel
// höchstens einmal am Tag neu, damit die Bewertung aktuell bleibt. Bis dahin, und wenn kununu
// nicht erreichbar ist, gilt der Stand aus public/kununu-badge.svg.
import { readFile } from "node:fs/promises";

export const KUNUNU_PATH = "/kununu-badge.svg";

const SOURCE =
  "https://widgets.kununu.com/widget_icon_score_logo_small/profiles/cb9eaf81-7a42-4dbe-bd64-42331b394490";
const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

let latest = null; // { body, checkedAt }
let pending = null;

async function refresh(source) {
  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(5000) });
    const body = Buffer.from(await res.arrayBuffer());
    if (
      !res.ok ||
      !res.headers.get("content-type")?.startsWith("image/svg+xml") ||
      body.length > 100_000
    ) {
      throw new Error(`HTTP ${res.status}, ${body.length} Bytes`);
    }
    latest = { body, checkedAt: Date.now() };
  } catch (err) {
    console.warn(`kununu-Siegel nicht aktualisiert: ${err.message}`);
    // nächster Versuch in einer Stunde, bis dahin die bisherige Fassung
    if (latest) latest.checkedAt = Date.now() - REFRESH_MS + RETRY_MS;
    else latest = { body: null, checkedAt: Date.now() - REFRESH_MS + RETRY_MS };
  }
}

/** Das Siegel als SVG; frischt es im Hintergrund auf, Besucher warten nie auf kununu. */
export async function kununuBadge(
  fallbackFile,
  source = process.env.KUNUNU_BADGE_URL ?? SOURCE,
) {
  if (
    source &&
    !pending &&
    (!latest || Date.now() - latest.checkedAt > REFRESH_MS)
  ) {
    pending = refresh(source).finally(() => (pending = null));
  }
  return latest?.body ?? readFile(fallbackFile);
}
