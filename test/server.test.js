import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server.js";

const SITE = fileURLToPath(new URL("../site/", import.meta.url));
let server;
let base;
let stateDir;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "elfin-website-"));
  process.env.STATE_DIRECTORY = stateDir;
  process.env.KUNUNU_BADGE_URL = ""; // Tests ohne Netz: Siegel aus site/
  server = createApp({ publicDir: SITE });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await rm(stateDir, { recursive: true, force: true });
});

const get = (path, init) => fetch(base + path, { redirect: "manual", ...init });

test("/health meldet ok", async () => {
  const res = await get("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("Start- und Unterseiten in beiden Sprachen", async () => {
  for (const path of ["/", "/de/", "/services/", "/de/was-wir-tun/"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /text\/html/);
  }
});

test("Adresse ohne Schrägstrich leitet weiter wie WordPress", async () => {
  const res = await get("/services?x=1");
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("location"), "/services/?x=1");
});

test("unbekannte Seite liefert die 404-Seite der Sprache", async () => {
  const en = await get("/gibt-es-nicht/");
  assert.equal(en.status, 404);
  assert.match(await en.text(), /<html[^>]+lang="en/);
  const de = await get("/de/gibt-es-nicht/");
  assert.equal(de.status, 404);
  assert.match(await de.text(), /<html[^>]+lang="de/);
});

test("Dateien außerhalb von site/ sind nicht erreichbar", async () => {
  for (const path of ["/..%2Fsrc%2Fserver.js", "/../package.json"]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test("keine Tracking- oder Consent-Skripte in den Seiten", async () => {
  for (const path of ["/", "/de/", "/contact/", "/privacy-policy/"]) {
    const html = await (await get(path)).text();
    assert.doesNotMatch(
      html,
      /googletagmanager|consent\.cookiebot|recaptcha\/api\.js|gtag\(/,
      path,
    );
  }
});

test("Kontaktformular (Avia) speichert und antwortet mit .ajaxresponse", async () => {
  const enc = (v) => encodeURIComponent(v); // Enfold kodiert jeden Wert doppelt
  const body = new URLSearchParams({
    avia_1_1: enc("Erika Muster"),
    avia_2_1: enc("erika@example.com"),
    avia_3_1: enc("Hallo & guten Tag"),
    avia_4_1: "",
    avia_generated_form1: "1",
  });
  const res = await get("/contact/", { method: "POST", body });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /class="ajaxresponse".*avia-form-success/);

  const lines = (await readFile(join(stateDir, "submissions.jsonl"), "utf8"))
    .trim()
    .split("\n");
  const saved = JSON.parse(lines.at(-1));
  assert.equal(saved.page, "/contact/");
  assert.equal(saved.fields.Message, "Hallo & guten Tag");
  assert.equal(saved.fields["E-mail address"], "erika@example.com");
});

test("Kontaktformular lehnt ungültige E-Mail ab, Honeypot wird verworfen", async () => {
  const bad = new URLSearchParams({
    avia_1_1: "A",
    avia_2_1: "keine-mail",
    avia_3_1: "x",
    avia_generated_form1: "1",
  });
  assert.equal(
    (await get("/contact/", { method: "POST", body: bad })).status,
    400,
  );

  const before = await readFile(join(stateDir, "submissions.jsonl"), "utf8");
  const bot = new URLSearchParams({
    avia_1_1: "Bot",
    avia_2_1: "bot@example.com",
    avia_3_1: "spam",
    avia_4_1: "gefüllt",
    avia_generated_form1: "1",
  });
  assert.equal(
    (await get("/contact/", { method: "POST", body: bot })).status,
    200,
  );
  assert.equal(
    await readFile(join(stateDir, "submissions.jsonl"), "utf8"),
    before,
  );
});

test("EcoVadis-Formular (Contact Form 7) im CF7-Antwortformat", async () => {
  const url = "/wp-json/contact-form-7/v1/contact-forms/4662/feedback";
  const schema = await get(`${url}/schema`);
  assert.equal(schema.status, 200);
  assert.ok((await schema.json()).rules.length > 0);

  const form = new FormData();
  form.set("_wpcf7_unit_tag", "wpcf7-f4662-p4497-o1");
  form.set("_wpcf7_locale", "en_US");
  form.set("you-name", "Erika Muster");
  form.set("email", "erika@example.com");
  const missing = await (await get(url, { method: "POST", body: form })).json();
  assert.equal(missing.status, "acceptance_missing");

  form.set("acceptance", "1");
  const ok = await (await get(url, { method: "POST", body: form })).json();
  assert.equal(ok.status, "mail_sent");
  assert.equal(ok.into, "#wpcf7-f4662-p4497-o1");
});

test("Suche wie WordPress: Treffer je Sprache, Seite ohne Treffer", async () => {
  const en = await (await get("/?s=EcoVadis")).text();
  assert.match(en, /\d+ search results? for: EcoVadis/);
  assert.match(en, /href='\/focus\/ecovadis\/'/);
  assert.match(en, /<input type="search" id="s" name="s" value="EcoVadis"/);
  assert.doesNotMatch(en, /href='\/de\/[^']*' itemprop="headline"/);

  const de = await (await get("/de/?s=EcoVadis")).text();
  assert.match(de, /Suchergebnis(se)? für: EcoVadis/);
  assert.match(de, /href='\/de\/ecovadis\/'/);

  const none = await (await get("/?s=xyzqqq")).text();
  assert.match(none, /Nothing Found/);
  assert.match(none, /search-no-results/);
});

test("Suchbegriff wird maskiert", async () => {
  const html = await (
    await get(`/?s=${encodeURIComponent('<script>alert(1)</script>"')}`)
  ).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /\{\{\w+\}\}/);
});

test("kununu-Siegel kommt vom eigenen Server", async () => {
  const page = await (await get("/career/")).text();
  assert.match(page, /src="\/kununu-badge\.svg"/);
  assert.doesNotMatch(page, /<img[^>]+widgets\.kununu\.com/);
  const res = await get("/kununu-badge.svg");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
  assert.match(await res.text(), /<svg/);
});
