// Formular-Einsendungen per Microsoft 365 (Graph API, App-Anmeldung ohne Benutzer) weiterleiten.
//
// Decision: Graph sendMail mit Client-Credentials statt SMTP.
// Why: SMTP AUTH ist in Microsoft 365 standardmäßig aus und nur mit Benutzerpasswort möglich;
//      eine App-Registrierung lässt sich auf genau ein Absender-Postfach beschränken.
// Alternatives rejected:
//   - SMTP mit Postfach-Passwort → Basic Auth, Passwort auf dem Server, von Microsoft abgekündigt
//   - externer Mail-Dienst (SendGrid o. ä.) → weiterer Auftragsverarbeiter, Daten in die USA
//
// Einstellungen in /etc/<app>/env (alle nötig, sonst wird nur gespeichert):
//   M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET  App-Registrierung mit Mail.Send (Anwendung)
//   MAIL_FROM        Absender-Postfach, z. B. website@elfin.works
//   FORM_RECIPIENT   Empfänger, mehrere durch Komma getrennt
//   CHECKLIST_FILE   Pfad zum EcoVadis-PDF (nur für den Versand der Checkliste)
import { readFile } from "node:fs/promises";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,20}$/;

let token = null; // { value, expiresAt }

export function mailConfig(env = process.env) {
  const keys = [
    "M365_TENANT_ID",
    "M365_CLIENT_ID",
    "M365_CLIENT_SECRET",
    "MAIL_FROM",
    "FORM_RECIPIENT",
  ];
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    tenant: env.M365_TENANT_ID,
    clientId: env.M365_CLIENT_ID,
    secret: env.M365_CLIENT_SECRET,
    from: env.MAIL_FROM,
    to: env.FORM_RECIPIENT.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

async function accessToken(cfg) {
  if (token && token.expiresAt > Date.now() + 60_000) {
    return token.value;
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cfg.clientId,
        client_secret: cfg.secret,
        scope: "https://graph.microsoft.com/.default",
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Anmeldung bei Microsoft fehlgeschlagen: ${res.status} ${data.error ?? ""}`,
    );
  }
  token = {
    value: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return token.value;
}

/** Die Mail an ELFIN: Klartext, Antworten gehen direkt an die Person, die das Formular ausgefüllt hat. */
export function buildMessage(entry, to) {
  const lines = Object.entries(entry.fields).map(
    ([label, value]) => `${label}:\n${value}\n`,
  );
  const replyTo = Object.values(entry.fields).find((v) =>
    EMAIL_RE.test(String(v).trim()),
  );
  const subject =
    {
      kontakt: "Kontaktformular",
      "ecovadis-checkliste": "EcoVadis-Checkliste angefordert",
    }[entry.form] ?? entry.form;
  return {
    subject: `[Website] ${subject}`,
    body: {
      contentType: "Text",
      content: `${lines.join("\n")}\n---\nSeite: https://elfin-consulting.com${entry.page}\nSprache: ${entry.lang}\nEingang: ${entry.at}\n`,
    },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
    ...(replyTo && {
      replyTo: [{ emailAddress: { address: replyTo.trim() } }],
    }),
  };
}

const CHECKLIST_TEXT = {
  en: {
    subject: "Your EcoVadis Readiness Checklist – ELFIN Consulting",
    body: (name) =>
      `Hello ${name},\n\nthank you for your interest. Attached you will find our EcoVadis Readiness Checklist.\n\nIf you have any questions about your EcoVadis assessment, simply reply to this e-mail.\n\nKind regards\nELFIN Consulting GmbH\nIm Mediapark 6b, 50670 Cologne, Germany\nhttps://elfin-consulting.com\n`,
  },
  de: {
    subject: "Ihre EcoVadis Readiness Checklist – ELFIN Consulting",
    body: (name) =>
      `Guten Tag ${name},\n\nvielen Dank für Ihr Interesse. Im Anhang finden Sie unsere EcoVadis Readiness Checklist.\n\nBei Fragen zu Ihrem EcoVadis-Assessment antworten Sie einfach auf diese E-Mail.\n\nFreundliche Grüße\nELFIN Consulting GmbH\nIm Mediapark 6b, 50670 Köln\nhttps://elfin-consulting.com/de/\n`,
  },
};

/** Mail mit der Checkliste an die Person, die sie angefordert hat; Antworten gehen an ELFIN. */
export function buildChecklistMessage({ name, email, lang }, replyTo, pdf) {
  const text = CHECKLIST_TEXT[lang] ?? CHECKLIST_TEXT.en;
  return {
    subject: text.subject,
    body: {
      contentType: "Text",
      content: text.body(name.replace(/\s+/g, " ").slice(0, 100)),
    },
    toRecipients: [{ emailAddress: { address: email } }],
    replyTo: replyTo.map((address) => ({ emailAddress: { address } })),
    attachments: [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "EcoVadis Readiness Checklist_ELFIN Consulting.pdf",
        contentType: "application/pdf",
        contentBytes: pdf.toString("base64"),
      },
    ],
  };
}

/**
 * Schickt die EcoVadis-Checkliste; false wenn Mail oder CHECKLIST_FILE nicht eingerichtet ist.
 * Das PDF liegt nur auf dem Server (CHECKLIST_FILE in /etc/<app>/env), nicht im öffentlichen Repo.
 */
export async function sendChecklist(request, env = process.env) {
  const cfg = mailConfig(env);
  if (!cfg.ok || !env.CHECKLIST_FILE) {
    return false;
  }
  const pdf = await readFile(env.CHECKLIST_FILE);
  await graphSend(cfg, buildChecklistMessage(request, cfg.to, pdf));
  return true;
}

/** Schickt die Einsendung weiter; true wenn versendet, false wenn Mail nicht eingerichtet ist. */
export async function sendSubmission(entry, env = process.env) {
  const cfg = mailConfig(env);
  if (!cfg.ok) {
    return false;
  }
  await graphSend(cfg, buildMessage(entry, cfg.to));
  return true;
}

async function graphSend(cfg, message) {
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.from)}/sendMail`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await accessToken(cfg)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message, saveToSentItems: false }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (res.status !== 202) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Graph sendMail: ${res.status} ${detail.slice(0, 300)}`);
  }
}
