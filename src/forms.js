// Kontaktformulare der alten WordPress-Seite, nachgebaut ohne WordPress:
//   - Avia-Formular (Footer, 26 Seiten): Enfolds eigenes JS schickt per POST an die Seiten-URL
//     und übernimmt aus der Antwort das Element .ajaxresponse.
//   - Contact Form 7 (EcoVadis): das CF7-JS spricht die REST-Adressen unter /wp-json/contact-form-7/v1/ an.
// Beide Front-ends bleiben unverändert; der Server antwortet im jeweils erwarteten Format.
//
// Einsendungen werden in $STATE_DIRECTORY/submissions.jsonl gespeichert (systemd: /var/lib/<app>).
// Mailversand (Microsoft 365) ist noch nicht eingerichtet; Empfänger kommt aus FORM_RECIPIENT.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

const MAX_BODY = 32 * 1024;
const CF7_PREFIX = "/wp-json/contact-form-7/v1/contact-forms/";
const CF7_SCHEMA = new URL("./cf7-schema-4662.json", import.meta.url);
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,20}$/;

const TEXT = {
  en: {
    sent: "Your message has been sent!",
    failed: "Your message could not be sent. Please check your entries.",
    tooMany: "Too many messages. Please try again later.",
    cf7Sent: "Thank you for your message. It has been sent.",
    cf7Invalid: "One or more fields have an error. Please check and try again.",
    required: "Please fill out this field.",
    email: "Please enter an email address.",
    accept:
      "You must accept the terms and conditions before sending your message.",
  },
  de: {
    sent: "Ihre Nachricht wurde versendet!",
    failed:
      "Ihre Nachricht konnte nicht versendet werden. Bitte prüfen Sie Ihre Eingaben.",
    tooMany: "Zu viele Nachrichten. Bitte versuchen Sie es später noch einmal.",
    cf7Sent: "Vielen Dank für Ihre Nachricht. Sie wurde gesendet.",
    cf7Invalid:
      "Ein oder mehrere Felder sind fehlerhaft. Bitte überprüfen Sie Ihre Eingaben.",
    required: "Bitte füllen Sie dieses Feld aus.",
    email: "Bitte geben Sie eine E-Mail-Adresse ein.",
    accept:
      "Sie müssen die Bedingungen akzeptieren, bevor Sie Ihre Nachricht senden.",
  },
};

const recent = new Map(); // IP -> Zeitstempel der letzten Einsendungen

export function isFormRequest(req, pathname) {
  if (pathname.startsWith(CF7_PREFIX)) {
    return true;
  }
  return req.method === "POST";
}

export async function handleForm(req, res, pathname, publicDir) {
  if (pathname.startsWith(CF7_PREFIX)) {
    return handleCf7(req, res, pathname);
  }
  return handleAvia(req, res, pathname, publicDir);
}

// --- Avia-Formular -----------------------------------------------------------

async function handleAvia(req, res, pathname, publicDir) {
  const lang = pathname.startsWith("/de/") ? "de" : "en";
  const body = await readBody(req, res);
  if (body === null) {
    return;
  }
  const params = new URLSearchParams(body.toString("utf8"));
  const formKey = [...params.keys()].find((k) =>
    /^avia_generated_form\d+$/.test(k),
  );
  const form = formKey
    ? await aviaFormSpec(publicDir, pathname, formKey.slice(19))
    : null;
  if (!form) {
    return sendJson(res, 404, { error: "Formular nicht gefunden" });
  }

  // Enfold kodiert jeden Wert vor dem Senden zusätzlich mit encodeURIComponent
  const value = (name) => safeDecode(params.get(name) ?? "").trim();
  const reply = (status, message, ok) =>
    sendHtml(
      res,
      status,
      `<div class="ajaxresponse"><h3 class="${ok ? "avia-form-success" : "avia-form-error"}">${message}</h3></div>`,
    );

  if (form.honeypot.some((name) => value(name) !== "")) {
    return reply(200, TEXT[lang].sent, true); // Bot: so tun, als ob
  }
  const invalid = form.fields.some(
    (f) =>
      (f.required && (value(f.name) === "" || value(f.name) === "false")) ||
      (f.email && !EMAIL_RE.test(value(f.name))),
  );
  if (invalid) {
    return reply(400, TEXT[lang].failed, false);
  }
  if (rateLimited(req)) {
    return reply(429, TEXT[lang].tooMany, false);
  }

  const fields = Object.fromEntries(
    form.fields.map((f) => [f.label, value(f.name)]),
  );
  await store({ form: "kontakt", page: pathname, lang, fields });
  return reply(200, TEXT[lang].sent, true);
}

const specCache = new Map();

/** Felder des Formulars aus der ausgelieferten Seite lesen: Name, Beschriftung, Pflicht, Honeypot. */
async function aviaFormSpec(publicDir, pathname, formId) {
  const key = `${pathname}#${formId}`;
  if (specCache.has(key)) {
    return specCache.get(key);
  }
  let html;
  try {
    const rel = pathname.replace(/^\/+/, "").replace(/\/?$/, "/");
    html = await readFile(join(publicDir, rel, "index.html"), "utf8");
  } catch {
    return null;
  }
  const start = html.indexOf(`data-avia-form-id="${formId}"`);
  if (start < 0) {
    return null;
  }
  const markup = html.slice(start, html.indexOf("</form>", start));
  const fields = [];
  const honeypot = [];
  for (const m of markup.matchAll(
    /<(input|textarea)\b[^>]*\bname="(avia_\d+_\d+)"[^>]*>/g,
  )) {
    const [tag, , name] = m;
    const before = markup.slice(0, m.index);
    if (/<p class="hidden">\s*$/.test(before)) {
      honeypot.push(name);
      continue;
    }
    const label = new RegExp(
      `<label\\b[^>]*\\bfor="${name}"[^>]*>([\\s\\S]*?)</label>`,
    )
      .exec(markup)?.[1]
      .replace(/<abbr[\s\S]*?<\/abbr>/g, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    fields.push({
      name,
      label: label || name,
      required: /is_empty|is_email|type="checkbox"[^>]*is_empty/.test(tag),
      email: /is_email/.test(tag),
    });
  }
  const spec = { fields, honeypot };
  specCache.set(key, spec);
  return spec;
}

// --- Contact Form 7 ----------------------------------------------------------

async function handleCf7(req, res, pathname) {
  const route = pathname.slice(CF7_PREFIX.length); // z. B. "4662/feedback"
  if (req.method === "GET" && route === "4662/feedback/schema") {
    return sendJson(res, 200, JSON.parse(await readFile(CF7_SCHEMA, "utf8")));
  }
  if (req.method === "GET" && route === "4662/refill") {
    return sendJson(res, 200, {});
  }
  if (req.method !== "POST" || route !== "4662/feedback") {
    return sendJson(res, 404, { code: "rest_no_route" });
  }

  const raw = await readBody(req, res);
  if (raw === null) {
    return;
  }
  let data;
  try {
    data = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] ?? "" },
      body: raw,
    }).formData();
  } catch {
    return sendJson(res, 400, { code: "invalid_body" });
  }
  const get = (k) => String(data.get(k) ?? "").trim();
  const lang = get("_wpcf7_locale").startsWith("de") ? "de" : "en";
  const unit = get("_wpcf7_unit_tag");
  const base = {
    contact_form_id: 4662,
    into: `#${unit}`,
    posted_data_hash: "",
  };

  const invalid = [];
  const fieldError = (field, message) =>
    invalid.push({
      field,
      message,
      idref: null,
      error_id: `${unit}-ve-${field}`,
    });
  if (!get("you-name")) fieldError("you-name", TEXT[lang].required);
  if (!get("email")) fieldError("email", TEXT[lang].required);
  else if (!EMAIL_RE.test(get("email"))) fieldError("email", TEXT[lang].email);
  if (invalid.length) {
    return sendJson(res, 200, {
      ...base,
      status: "validation_failed",
      message: TEXT[lang].cf7Invalid,
      invalid_fields: invalid,
    });
  }
  if (get("acceptance") !== "1") {
    return sendJson(res, 200, {
      ...base,
      status: "acceptance_missing",
      message: TEXT[lang].accept,
      invalid_fields: [],
    });
  }
  if (rateLimited(req)) {
    return sendJson(res, 200, {
      ...base,
      status: "mail_failed",
      message: TEXT[lang].tooMany,
      invalid_fields: [],
    });
  }

  await store({
    form: "ecovadis-checkliste",
    page: lang === "de" ? "/de/ecovadis/" : "/focus/ecovadis/",
    lang,
    fields: { Name: get("you-name"), "E-Mail": get("email") },
  });
  return sendJson(res, 200, {
    ...base,
    status: "mail_sent",
    message: TEXT[lang].cf7Sent,
    invalid_fields: [],
  });
}

// --- Gemeinsam ---------------------------------------------------------------

async function store(entry) {
  const dir = process.env.STATE_DIRECTORY ?? join(process.cwd(), "var");
  await mkdir(dir, { recursive: true });
  const record = { at: new Date().toISOString(), ...entry };
  await appendFile(
    join(dir, "submissions.jsonl"),
    `${JSON.stringify(record)}\n`,
    {
      mode: 0o600,
    },
  );
  // Keine personenbezogenen Daten ins Log
  const to = process.env.FORM_RECIPIENT ?? "(kein FORM_RECIPIENT gesetzt)";
  console.log(
    `Formular "${entry.form}" von ${entry.page} gespeichert. Mailversand an ${to} noch nicht eingerichtet.`,
  );
}

function rateLimited(req) {
  const ip =
    req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "unbekannt";
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 10_000) {
    recent.clear();
  }
  return hits.length > RATE_MAX;
}

/** Body bis MAX_BODY lesen; bei Überlänge 413 senden und null liefern. */
async function readBody(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of Readable.from(req)) {
    size += chunk.length;
    if (size > MAX_BODY) {
      sendJson(res, 413, { error: "zu groß" });
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}
