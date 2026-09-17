import {describe, expect, it, vi} from "vitest";
import {env} from "cloudflare:workers";
import {createPushRequest, readPushConfig, validatePushSubscription} from "../src/web-push.js";

const encode = (bytes: ArrayBuffer | Uint8Array) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  .toBase64({alphabet: "base64url", omitPadding: true});
const decode = (text: string) => Uint8Array.fromBase64(text, {alphabet: "base64url"});
const encoder = new TextEncoder();

async function keys() {
  const sender = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const receiver = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]);
  const publicKey = encode(await crypto.subtle.exportKey("raw", sender.publicKey));
  const privateKey = (await crypto.subtle.exportKey("jwk", sender.privateKey)).d!;
  const subscription = {endpoint: "https://fcm.googleapis.com/fcm/send/private-receiver-token",
    keys: {p256dh: encode(await crypto.subtle.exportKey("raw", receiver.publicKey)),
      auth: encode(crypto.getRandomValues(new Uint8Array(16)))}};
  return {sender, receiver, subscription, config: {publicKey, privateKey, subject: "mailto:operator@example.com"}};
}

describe("Web Push transport boundary", () => {
  it("encrypts a fixed padded payload and signs a push-service-scoped VAPID token in workerd", async () => {
    const {sender, receiver, subscription, config} = await keys();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in crypto tests"));
    try {
      const request = await createPushRequest(subscription, config);
      expect(network).not.toHaveBeenCalled();
      expect(request.redirect).toBe("manual");
      expect(request.method).toBe("POST");
      expect(request.headers.get("content-encoding")).toBe("aes128gcm");
      expect(request.headers.get("ttl")).toBe("300");
      expect(request.headers.get("topic")).toBe("attention");
      const authorization = request.headers.get("authorization")!;
      const token = authorization.match(/t=([^, ]+)/)![1];
      const [header, body, signature] = token.split(".");
      const claims = JSON.parse(new TextDecoder().decode(decode(body)));
      expect(claims.aud).toBe("https://fcm.googleapis.com");
      expect(claims.sub).toBe(config.subject);
      expect(authorization).not.toContain(config.privateKey);
      expect(await crypto.subtle.verify({name: "ECDSA", hash: "SHA-256"}, sender.publicKey,
        decode(signature), encoder.encode(`${header}.${body}`))).toBe(true);

      // Independently decrypt the RFC 8291/8188 envelope with the receiver's private key.
      const encrypted = new Uint8Array(await request.arrayBuffer());
      expect(encrypted.byteLength).toBe(4096);
      const publicBytes = encrypted.slice(21, 86);
      const ephemeral = await crypto.subtle.importKey("raw", publicBytes,
        {name: "ECDH", namedCurve: "P-256"}, false, []);
      const secret = await crypto.subtle.deriveBits({name: "ECDH", public: ephemeral}, receiver.privateKey, 256);
      const derive = async (material: BufferSource, salt: Uint8Array, info: Uint8Array, bits: number) => {
        const key = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveBits"]);
        return crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt, info}, key, bits);
      };
      const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...decode(subscription.keys.p256dh), ...publicBytes]);
      const ikm = await derive(secret, decode(subscription.keys.auth), info, 256);
      const cek = await derive(ikm, encrypted.slice(0, 16), encoder.encode("Content-Encoding: aes128gcm\0"), 128);
      const nonce = await derive(ikm, encrypted.slice(0, 16), encoder.encode("Content-Encoding: nonce\0"), 96);
      const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
      const plain = new Uint8Array(await crypto.subtle.decrypt({name: "AES-GCM", iv: nonce}, aes, encrypted.slice(86)));
      const delimiter = plain.findLastIndex(byte => byte !== 0);
      expect(plain[delimiter]).toBe(2);
      expect(JSON.parse(new TextDecoder().decode(plain.slice(0, delimiter)))).toEqual({type: "attention"});
    } finally { network.mockRestore(); }
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/token", "https://127.0.0.1/token", "https://[::1]/token",
    "https://localhost/token", "https://fcm.googleapis.com.attacker.test/token",
    "https://attacker.test/?next=https://fcm.googleapis.com", "https://fcm.googleapis.com:8443/token",
    "https://user:secret@fcm.googleapis.com/token", "https://fcm.googleapis.com/token#secret",
    "https://notify.windows.com.attacker.test/token",
  ])("rejects an unsafe endpoint without quoting it: %s", async endpoint => {
    const {subscription} = await keys();
    expect(() => validatePushSubscription({...subscription, endpoint}))
      .toThrow(/^Unsupported or invalid browser push subscription\.$/);
  });

  it.each(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "wns2-db5p.notify.windows.com"])(
    "accepts the supported public push service %s", async host => {
      const {subscription} = await keys();
      expect(() => validatePushSubscription({...subscription, endpoint: `https://${host}/private?token=secret`})).not.toThrow();
    });

  it("rejects malformed and oversized key material with bounded diagnostics", async () => {
    const {subscription} = await keys();
    for (const value of ["secret-invalid-key", "x".repeat(10_000), "", subscription.keys.auth + "="]) {
      expect(() => validatePushSubscription({...subscription, keys: {...subscription.keys, auth: value}}))
        .toThrow(/^Unsupported or invalid browser push subscription\.$/);
    }
  });

  it("enables only complete deployment configuration, without treating it as browser consent", async () => {
    const {config} = await keys();
    const configured = {...env, VAPID_PUBLIC_KEY: config.publicKey,
      VAPID_PRIVATE_KEY: config.privateKey, VAPID_SUBJECT: config.subject};
    expect(readPushConfig(configured)).toEqual(config);
    expect(readPushConfig({...configured, VAPID_PRIVATE_KEY: undefined})).toBeUndefined();
    expect(readPushConfig({...configured, VAPID_PRIVATE_KEY: "secret-invalid"})).toBeUndefined();
    for (const subject of ["javascript:alert(1)", "http://example.com", "https://user:secret@example.com", "mailto:invalid"]) {
      expect(readPushConfig({...configured, VAPID_SUBJECT: subject})).toBeUndefined();
    }
  });
});
