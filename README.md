# elfin-website

Die Website [elfin-consulting.com](https://elfin-consulting.com) als statische Seite mit einem kleinen Node-Server.
Sie ist ein 1:1-Nachbau der bisherigen WordPress-Seite (Enfold-Theme, WPML), ohne WordPress, ohne Tracking und ohne Cookie-Banner.

## Aufbau

| Pfad                     | Inhalt                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site/`                  | **Die Website.** Fertiges HTML je Seite (`site/<pfad>/index.html`, Deutsch unter `site/de/`), dazu Bilder, Schriften, Skripte und PDFs unter `site/wp-content/`. |
| `src/server.js`          | Liefert `site/` aus, `/health` für den Deploy, `/seite` → `/seite/` wie bei WordPress, eigene 404-Seite je Sprache.                                              |
| `src/forms.js`           | Nimmt die zwei Formulare an (Kontakt im Footer, EcoVadis-Checkliste), speichert sie auf dem Server und leitet sie per Microsoft 365 weiter (`src/mail.js`).      |
| `src/search.js`          | Suche wie bei WordPress (`/?s=…`, `/de/?s=…`) über alle Seiten; Seitenvorlage in `src/templates/search.json`.                                                    |
| `src/kununu.js`          | Liefert das kununu-Siegel der Karriereseite vom eigenen Server aus (einmal am Tag von kununu aktualisiert).                                                      |
| `scripts/build.js`       | Baut `dist/` und erzeugt `sitemap.xml`, `sitemap_index.xml`, `robots.txt` und `version.json`.                                                                    |
| `test/`                  | Tests für Server und Formulare.                                                                                                                                  |
| `tools/import-mirror.py` | Einmal-Import aus dem WordPress-Spiegel (Protokoll, wie `site/` entstanden ist). Nicht erneut ausführen, sonst gehen Änderungen in `site/` verloren.             |
| `tools/import-search.py` | Einmal-Import der WordPress-Suchseite als Vorlage für `src/search.js`.                                                                                           |

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

## Was gegenüber WordPress anders ist (bewusst)

- **Kein Tracking, keine Cookies:** Google Tag Manager, Consent Mode, Cookiebot und reCAPTCHA sind entfernt, deshalb gibt es kein Cookie-Banner. Spamschutz der Formulare: verstecktes Honeypot-Feld und Begrenzung auf 5 Einsendungen pro 10 Minuten und IP.
- **kununu-Siegel** kommt vom eigenen Server, Besucher rufen nichts bei kununu ab.
- **Keine Event-Seiten:** die 11 leeren Eventin-Seiten (`/events/…`, `/etn_category/`) sind weggelassen.
- **Suche:** zeigt Titel und Datum der Treffer, ohne Autor und Kategorie (die Autorenseiten gibt es nicht mehr).
- **Datenschutzerklärung (EN/DE)** ist an den neuen Stand angepasst (Hetzner statt IONOS/WordPress, keine Cookies, kein Analytics, Microsoft 365 für Formular-Mails).

## Server

Port 3002, eingerichtet mit `server/setup-app.sh elfin-website 3002 <domain>` (siehe `Web setup/INDEX.md`). Einsendungen liegen immer in `/var/lib/elfin-website/submissions.jsonl` (eine JSON-Zeile pro Einsendung). In `/etc/elfin-website/env` (chmod 600):

```
NOINDEX=1                              # nur solange die Seite Vorschau ist
FORM_RECIPIENT=service@elfin.works   # mehrere durch Komma
MAIL_FROM=website@elfin.works          # Absender-Postfach in Microsoft 365
M365_TENANT_ID=…
M365_CLIENT_ID=…
M365_CLIENT_SECRET=…
CHECKLIST_FILE=/etc/elfin-website/ecovadis-checklist.pdf
```

Ohne die `M365_*`-Werte werden Einsendungen nur gespeichert. Mit ihnen geht jede Einsendung an `FORM_RECIPIENT`, und wer die EcoVadis-Checkliste anfordert, bekommt die PDF direkt per Mail. Die PDF liegt nur auf dem Server (`CHECKLIST_FILE`), nicht in diesem öffentlichen Repo; ohne den Wert wird keine Checkliste verschickt. Die App-Registrierung in Microsoft Entra braucht die Anwendungsberechtigung **Mail.Send** (Microsoft Graph) mit Administratorzustimmung, beschränkt auf das Absender-Postfach (Exchange „RBAC for Applications“).
