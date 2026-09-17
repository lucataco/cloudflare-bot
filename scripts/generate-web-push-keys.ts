import {writeFileSync} from "node:fs";
import {parseArgs} from "node:util";

const {values} = parseArgs({options: {
  subject: {type: "string"}, out: {type: "string"},
}});
if (!values.subject || !values.out) {
  throw new Error("Usage: node scripts/generate-web-push-keys.ts --subject mailto:operator@example.com --out /private/path/web-push-secrets.json");
}
const subject = new URL(values.subject);
if ((subject.protocol !== "https:" && subject.protocol !== "mailto:") || subject.username ||
    subject.password || subject.hash || (subject.protocol === "mailto:" &&
      (!subject.pathname.includes("@") || subject.search))) {
  throw new Error("Use an HTTPS or mailto operator contact without credentials or a fragment.");
}

const keys = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))
  .toBase64({alphabet: "base64url", omitPadding: true});
const privateKey = (await crypto.subtle.exportKey("jwk", keys.privateKey)).d;
// Refuse overwrite and keep signing material out of console output and shell history.
writeFileSync(values.out, JSON.stringify({VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey,
  VAPID_SUBJECT: values.subject}, null, 2) + "\n", {flag: "wx", mode: 0o600});
console.log("Created private Web Push configuration. Keep it outside the repository and provision it as Worker secrets.");
