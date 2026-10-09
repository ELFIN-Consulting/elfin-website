import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChecklistMessage,
  buildMessage,
  mailConfig,
  sendSubmission,
} from "../src/mail.js";

test("ohne vollständige Einstellungen wird nichts versendet", async () => {
  const env = { FORM_RECIPIENT: "a@example.com" };
  assert.deepEqual(mailConfig(env).ok, false);
  assert.ok(mailConfig(env).missing.includes("M365_CLIENT_SECRET"));
  assert.equal(
    await sendSubmission({ form: "kontakt", page: "/", fields: {} }, env),
    false,
  );
});

test("Mail: Klartext, Antwort an die einsendende Person, mehrere Empfänger", () => {
  const msg = buildMessage(
    {
      at: "2026-10-09T10:00:00.000Z",
      form: "kontakt",
      page: "/contact/",
      lang: "en",
      fields: {
        Name: "Erika <b>",
        "E-mail address": "erika@example.com",
        Message: "Hallo",
      },
    },
    ["a@elfin.works", "b@elfin.works"],
  );
  assert.equal(msg.subject, "[Website] Kontaktformular");
  assert.equal(msg.body.contentType, "Text");
  assert.match(msg.body.content, /Message:\nHallo/);
  assert.match(msg.body.content, /https:\/\/elfin-consulting\.com\/contact\//);
  assert.deepEqual(msg.replyTo, [
    { emailAddress: { address: "erika@example.com" } },
  ]);
  assert.equal(msg.toRecipients.length, 2);
});

test("Checkliste: PDF im Anhang, an die anfordernde Person, Antwort an ELFIN", async () => {
  const pdf = Buffer.from("%PDF-1.7\n% Test\n");
  const msg = buildChecklistMessage(
    { name: "Erika\nMuster", email: "erika@example.com", lang: "de" },
    ["service@elfin.works"],
    pdf,
  );
  assert.match(msg.subject, /EcoVadis/);
  assert.match(msg.body.content, /^Guten Tag Erika Muster,/);
  assert.deepEqual(msg.toRecipients, [
    { emailAddress: { address: "erika@example.com" } },
  ]);
  assert.deepEqual(msg.replyTo, [
    { emailAddress: { address: "service@elfin.works" } },
  ]);
  assert.equal(msg.attachments[0].contentType, "application/pdf");
  assert.equal(
    Buffer.from(msg.attachments[0].contentBytes, "base64").length,
    pdf.length,
  );
});
