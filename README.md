# elfin-website

Die Website [elfin-consulting.com](https://elfin-consulting.com) als statische Seite mit einem kleinen Node-Server.
Sie ist ein 1:1-Nachbau der bisherigen WordPress-Seite (Enfold-Theme, WPML), ohne WordPress, ohne Tracking und ohne Cookie-Banner.

## Aufbau

| Pfad                     | Inhalt                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site/`                  | **Die Website.** Fertiges HTML je Seite (`site/<pfad>/index.html`, Deutsch unter `site/de/`), dazu Bilder, Schriften, Skripte und PDFs unter `site/wp-content/`. |
| `src/server.js`          | Liefert `site/` aus, `/health` für den Deploy, `/seite` → `/seite/` wie bei WordPress, eigene 404-Seite je Sprache.                                              |
| `src/forms.js`           | Nimmt die zwei Formulare an (Kontakt im Footer, EcoVadis-Checkliste) und speichert sie auf dem Server.                                                           |
| `scripts/build.js`       | Baut `dist/` und erzeugt `sitemap.xml`, `sitemap_index.xml`, `robots.txt` und `version.json`.                                                                    |
| `test/`                  | Tests für Server und Formulare.                                                                                                                                  |
| `tools/import-mirror.py` | Einmal-Import aus dem WordPress-Spiegel (Protokoll, wie `site/` entstanden ist). Nicht erneut ausführen, sonst gehen Änderungen in `site/` verloren.             |

## Ändern und veröffentlichen

```bash
npm install          # einmalig
npm run dev          # http://127.0.0.1:3000
```

Texte und Bilder ändern sich direkt in `site/…/index.html` bzw. `site/wp-content/uploads/`. Danach:

```bash
npm run lint && npm run format:check && npm test
git commit -am "…" && git push
```

Der Push auf `main` startet GitHub Actions: prüfen, bauen, auf den Server laden, umschalten. Schlägt der Health-Check fehl, bleibt die alte Version aktiv.

## Was gegenüber WordPress fehlt (bewusst)

- **Kein Tracking:** Google Tag Manager, Consent Mode, Cookiebot und reCAPTCHA sind entfernt. Spamschutz der Formulare: verstecktes Honeypot-Feld und Begrenzung auf 5 Einsendungen pro 10 Minuten und IP.
- **Keine Event-Seiten:** die 11 leeren Eventin-Seiten (`/events/…`, `/etn_category/`) sind weggelassen.
- **Keine Suche:** das Suchfeld auf `/insights/` führt auf `/?s=…` und zeigt aktuell die Startseite.
- **Kein Mailversand:** Einsendungen landen in `/var/lib/elfin-website/submissions.jsonl` (eine JSON-Zeile pro Einsendung). Der Versand über Microsoft 365 an `FORM_RECIPIENT` folgt.

## Server

Port 3002, eingerichtet mit `server/setup-app.sh elfin-website 3002 <domain>` (siehe `Web setup/INDEX.md`). In `/etc/elfin-website/env`:

```
FORM_RECIPIENT=joschua.fassbender@elfin.works
```
