/**
 * Web Push, from the two RFCs, on nothing but WebCrypto.
 *
 * Hand-rolled rather than pulled in as a dependency, for one reason that
 * outweighs the rest: every published Web Push library for Node reaches for
 * node:crypto's ECDH/HKDF objects or for `https.request`, and neither exists on
 * Workers. The Workers-flavoured forks that do exist are thin, unaudited and
 * unmaintained, and the surface they wrap is this file — about 150 lines of
 * key agreement and HKDF, pinned by the RFCs' own published test vectors in
 * webpush.test.ts. A dependency whose correctness we would have to prove with
 * the same vectors is not safer than the vectors.
 *
 * Two documents, two halves:
 *
 *   RFC 8291 (payload encryption) — ECDH to the user agent's subscription key,
 *   HKDF twice, one AES-128-GCM record in the aes128gcm content coding of
 *   RFC 8188. Implemented in `encryptPayload`.
 *
 *   RFC 8292 (VAPID) — an ES256-signed JWT naming the push service's origin,
 *   carried with the public key that signed it. Implemented in
 *   `vapidAuthorization`.
 *
 * Nothing here reads a database or an environment. `sendWebPush` takes an
 * injected `fetch` so the whole path is testable without a network.
 */

/** A browser's PushSubscription, exactly as `subscription.toJSON()` emits it. */
export interface WebPushSubscription {
  endpoint: string;
  keys: {
    /** The UA's P-256 public key, uncompressed X9.62, base64url. 65 octets. */
    p256dh: string;
    /** 16 octets of shared entropy, base64url. */
    auth: string;
  };
}

/** base64url, both halves. `publicKey` is the uncompressed point. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface VapidConfig extends VapidKeys {
  /** A `mailto:` or `https:` URI the push service can complain to. RFC 8292 §2.1. */
  subject: string;
}

/**
 * RFC 8188's record size. One record is all we ever send, so this is really a
 * ceiling on the payload: header (86) + plaintext + delimiter (1) + tag (16).
 */
const RECORD_SIZE = 4096;

/**
 * Push services guarantee 4096 octets of encrypted body. Anything approaching
 * that from a notification payload is a bug in the caller, not a long message.
 */
export const MAX_PAYLOAD_BYTES = 3000;

/**
 * How long the push service should hold a message for a device that is offline.
 * Six hours: the group's moves land during US market hours, which is the middle
 * of the night in IST, and a trade alert delivered at breakfast is still worth
 * reading. One delivered two days later is litter.
 */
export const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

/** RFC 8292 caps this at 24 hours. Twelve leaves room for a slow clock. */
const JWT_TTL_SECONDS = 12 * 60 * 60;

// --- RFC 8291: payload encryption -------------------------------------------

export interface EncryptOptions {
  /**
   * The 16-octet salt. Random per message in production; the RFC's fixed value
   * in the test that proves this code against Appendix A.
   */
  salt?: Uint8Array;
  /** The ephemeral application-server keypair, likewise. */
  serverKeys?: CryptoKeyPair;
}

/**
 * One aes128gcm record, ready to be the body of a POST to the endpoint.
 *
 * The dance, in the order RFC 8291 §3.4 sets it out:
 *
 *   ecdh_secret = ECDH(as_private, ua_public)
 *   PRK_key     = HMAC-SHA-256(auth_secret, ecdh_secret)
 *   key_info    = "WebPush: info" || 0x00 || ua_public || as_public
 *   IKM         = HMAC-SHA-256(PRK_key, key_info || 0x01)
 *
 * — that is, the authentication secret salts a first HKDF whose only job is to
 * mix both public keys into the input keying material. From there it is plain
 * RFC 8188: PRK = HMAC(salt, IKM), then the content encryption key and nonce
 * off the two fixed info strings.
 */
export async function encryptPayload(
  plaintext: Uint8Array | string,
  subscriptionKeys: { p256dh: string; auth: string },
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  const message =
    typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  if (message.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `web push payload is ${message.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`,
    );
  }

  const uaPublicRaw = decodeBase64Url(subscriptionKeys.p256dh);
  const authSecret = decodeBase64Url(subscriptionKeys.auth);
  if (uaPublicRaw.length !== 65 || uaPublicRaw[0] !== 0x04) {
    throw new Error("subscription p256dh is not an uncompressed P-256 point");
  }
  if (authSecret.length !== 16) {
    throw new Error("subscription auth secret is not 16 octets");
  }

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const serverKeys = options.serverKeys ?? (await generateEcdhKeyPair());
  const asPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey),
  );

  // Importing the UA's key is also where it gets validated: WebCrypto rejects a
  // point that is not on the curve, which is exactly the check RFC 8291 §7
  // requires and the one an attacker would want us to skip.
  const uaPublic = await crypto.subtle.importKey(
    "raw",
    asBuffer(uaPublicRaw),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaPublic },
      serverKeys.privateKey,
      256,
    ),
  );

  const prkKey = await hmac(authSecret, ecdhSecret);
  const keyInfo = concat(
    new TextEncoder().encode("WebPush: info"),
    Uint8Array.of(0x00),
    uaPublicRaw,
    asPublicRaw,
  );
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, infoString("aes128gcm"), 16);
  const nonce = await hkdfExpand(prk, infoString("nonce"), 12);

  // Single record, so the padding delimiter is 0x02 (RFC 8188 §2). No padding
  // beyond it: the notification is JSON of a fixed shape, and hiding its length
  // from the push service buys nothing it cannot already infer.
  const padded = concat(message, Uint8Array.of(0x02));

  const key = await crypto.subtle.importKey(
    "raw",
    asBuffer(cek),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asBuffer(nonce), tagLength: 128 },
      key,
      asBuffer(padded),
    ),
  );

  return concat(aes128gcmHeader(salt, asPublicRaw), ciphertext);
}

/**
 * RFC 8188 §2.1: salt(16) ‖ rs(4, big-endian) ‖ idlen(1) ‖ keyid. For Web Push
 * the key id is the application server's ephemeral public key, so the receiver
 * can run the same ECDH from the other side.
 */
export function aes128gcmHeader(salt: Uint8Array, keyId: Uint8Array): Uint8Array {
  const header = new Uint8Array(16 + 4 + 1 + keyId.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = keyId.length;
  header.set(keyId, 21);
  return header;
}

/** `"Content-Encoding: <name>" || 0x00` — RFC 8188's two derivation labels. */
function infoString(name: string): Uint8Array {
  return concat(
    new TextEncoder().encode(`Content-Encoding: ${name}`),
    Uint8Array.of(0x00),
  );
}

/**
 * HKDF-Expand for a single block. Every output this code asks for is 32 octets
 * or fewer, so the counter never leaves 0x01 and the loop RFC 5869 describes
 * collapses to one HMAC. Hard-failing above 32 keeps that assumption honest.
 */
async function hkdfExpand(
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (length > 32) throw new Error("hkdfExpand: single-block only");
  const block = await hmac(prk, concat(info, Uint8Array.of(0x01)));
  return block.subarray(0, length);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    asBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, asBuffer(data)));
}

// --- RFC 8292: VAPID --------------------------------------------------------

/**
 * The `Authorization` header value for one push service.
 *
 * `aud` is the *origin* of the endpoint, not the endpoint itself — the token is
 * reusable across every subscription that service holds, which is why the
 * caller may (and does) cache it for a whole fan-out.
 */
export async function vapidAuthorization(
  vapid: VapidConfig,
  audience: string,
  now: Date = new Date(),
): Promise<string> {
  const jwt = await signJwt(
    {
      aud: audience,
      exp: Math.floor(now.getTime() / 1000) + JWT_TTL_SECONDS,
      sub: vapid.subject,
    },
    vapid,
  );
  return `vapid t=${jwt}, k=${vapid.publicKey}`;
}

/** Claim order is fixed so the signing input is reproducible byte for byte. */
export interface VapidClaims {
  aud: string;
  exp: number;
  sub: string;
}

export async function signJwt(claims: VapidClaims, keys: VapidKeys): Promise<string> {
  const signingInput = jwtSigningInput(claims);
  const key = await importVapidPrivateKey(keys);
  // WebCrypto emits ECDSA signatures as the raw r‖s pair JWS wants, not the
  // DER envelope node:crypto would give us. One less thing to unpick.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

/** Split out so the test can pin it against RFC 8292's worked example. */
export function jwtSigningInput(claims: VapidClaims): string {
  const header = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const body = encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({ aud: claims.aud, exp: claims.exp, sub: claims.sub }),
    ),
  );
  return `${header}.${body}`;
}

/**
 * A fresh signing keypair, in the shape `pnpm --filter server vapid:generate`
 * prints and the deploy installs: the public key as an uncompressed point, the
 * private key as the bare 32-octet scalar. Both base64url, both the form every
 * other Web Push tool uses, so a key generated elsewhere works here.
 */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: encodeBase64Url(publicKey), privateKey: jwk.d! };
}

/**
 * WebCrypto cannot derive a public key from a private scalar, and JWK import
 * insists on x and y. That is why VAPID_PUBLIC_KEY is a var alongside the
 * secret rather than something we could recompute: the two are imported
 * together, and a mismatched pair fails here rather than at the push service.
 */
async function importVapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const point = decodeBase64Url(keys.publicKey);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("VAPID public key is not an uncompressed P-256 point");
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: encodeBase64Url(point.subarray(1, 33)),
      y: encodeBase64Url(point.subarray(33, 65)),
      d: keys.privateKey,
      ext: false,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// --- The request itself -----------------------------------------------------

export interface SendOptions {
  /** Injected so the whole send path is exercised in tests without a network. */
  fetch?: typeof fetch;
  ttlSeconds?: number;
  now?: Date;
  /** Reuse one JWT across a fan-out to the same push service. */
  authorization?: string;
}

export interface SendResult {
  status: number;
  /** True for 404/410 — the subscription is gone and the row should go too. */
  gone: boolean;
  ok: boolean;
}

/**
 * One message to one subscription. Never throws for a rejection the push
 * service articulated: a status is an answer, and the caller's cleanup rules
 * are written against statuses. A transport failure still throws — the caller
 * treats that as a failure to count, not as a dead subscription.
 */
export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: string,
  vapid: VapidConfig,
  options: SendOptions = {},
): Promise<SendResult> {
  const body = await encryptPayload(payload, subscription.keys);
  const authorization =
    options.authorization ??
    (await vapidAuthorization(vapid, audienceFor(subscription.endpoint), options.now));

  const doFetch = options.fetch ?? fetch;
  const response = await doFetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
      // "normal" wakes the device but does not demand it; RFC 8030 §5.3.
      Urgency: "normal",
    },
    body: asBuffer(body),
  });

  return {
    status: response.status,
    gone: response.status === 404 || response.status === 410,
    ok: response.status >= 200 && response.status < 300,
  };
}

/** The Unicode serialization of the endpoint's origin — RFC 8292 §2. */
export function audienceFor(endpoint: string): string {
  return new URL(endpoint).origin;
}

// --- Bytes ------------------------------------------------------------------

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * A view's `.buffer` is the whole backing store, which is not what any of these
 * calls mean when the view is a subarray. Copy to an exact-sized buffer.
 */
function asBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length));
  copy.set(bytes);
  return copy.buffer;
}

async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
}

/**
 * Import a fixed ECDH keypair from the raw scalar and point. Only the RFC 8291
 * test vector needs this — production keys are ephemeral and generated per
 * message — but it lives here rather than in the test so the JWK shape sits
 * next to the one `importVapidPrivateKey` uses.
 */
export async function importEcdhKeyPair(
  privateKey: string,
  publicKey: string,
): Promise<CryptoKeyPair> {
  const point = decodeBase64Url(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(point.subarray(1, 33)),
    y: encodeBase64Url(point.subarray(33, 65)),
  };
  return {
    privateKey: await crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: privateKey, ext: false },
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    ),
    publicKey: await crypto.subtle.importKey(
      "jwk",
      { ...jwk, ext: true },
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    ),
  };
}
