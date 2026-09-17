import {buildPushPayload, type VapidKeys} from "@block65/webcrypto-web-push";
import type {PushSubscriptionData} from "@gadgets/workshop-shared/api";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Public VAPID application-server key, base64url encoded. */
      VAPID_PUBLIC_KEY?: string;
      /** Private VAPID signing key. Configure as a Worker secret. */
      VAPID_PRIVATE_KEY?: string;
      /** Deployment operator contact, an HTTPS URL or mailto address. */
      VAPID_SUBJECT?: string;
    }
  }
}

function keyBytes(value: string, size: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length !== Math.ceil(size * 4 / 3)) {
    throw new Error("Invalid Web Push key.");
  }
  const bytes = Uint8Array.fromBase64(value, {alphabet: "base64url"});
  if (bytes.length !== size || (size === 65 && bytes[0] !== 4)) throw new Error("Invalid Web Push key.");
  return bytes;
}

/** Read complete deployment configuration without exposing a private key to browser settings. */
export function readPushConfig(env: Cloudflare.Env): VapidKeys | undefined {
  const {VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject} = env;
  if (!publicKey || !privateKey || !subject || subject.length > 512) return;
  try {
    keyBytes(publicKey, 65);
    keyBytes(privateKey, 32);
    const url = new URL(subject);
    if ((url.protocol !== "https:" && url.protocol !== "mailto:") || url.username || url.password || url.hash ||
        (url.protocol === "mailto:" && (!url.pathname.includes("@") || url.search))) return;
    return {publicKey, privateKey, subject};
  } catch {
    return; // Misconfiguration is unavailable, not an error containing a signing secret.
  }
}

/** Validate receiver key encodings and constrain user-supplied endpoints to supported push services. */
export function validatePushSubscription(subscription: PushSubscriptionData): void {
  try {
    if (subscription.endpoint.length > 4096) throw new Error();
    const url = new URL(subscription.endpoint);
    const supported = url.hostname === "fcm.googleapis.com" ||
      url.hostname === "updates.push.services.mozilla.com" ||
      url.hostname === "web.push.apple.com" || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname);
    if (!supported || url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
      throw new Error();
    }
    keyBytes(subscription.keys.p256dh, 65);
    keyBytes(subscription.keys.auth, 16);
  } catch {
    // Subscription URLs and encryption keys are secrets, including in rejected-input diagnostics.
    throw new Error("Unsupported or invalid browser push subscription.");
  }
}

/** Encrypt only a fixed generic notification; the caller rechecks consent before sending this request. */
export async function createPushRequest(subscription: PushSubscriptionData, config: VapidKeys): Promise<Request> {
  validatePushSubscription(subscription);
  try {
    const payload = await buildPushPayload({
      data: {type: "attention"},
      options: {ttl: 300, topic: "attention", urgency: "normal"},
    }, {...subscription, expirationTime: null}, config);
    // Workers supports manual/follow, not redirect:error. The sender rejects 3xx explicitly.
    return new Request(subscription.endpoint, {...payload, redirect: "manual"});
  } catch {
    throw new Error("Could not prepare browser push notification.");
  }
}
