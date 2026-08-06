import { createHash } from "node:crypto";

// AES-256-GCM with a PBKDF2-stretched APP_SECRET. The key never touches the
// database: a stolen watcher.db is inert without the environment (appendix 1 §3.4).
//
// v2 (this file) derives the key with PBKDF2-SHA-256 through WebCrypto, which
// exists identically in Node and in Cloudflare Workers. v1 used node:crypto's
// scryptSync, which Workers does not reliably provide — v1 ciphertext is
// therefore unreadable here on purpose (see `decrypt`). The only v1 data that
// ever existed is one dev-machine OAuth grant, and the redirect URI changes on
// deploy anyway, so a reconnect was always going to be required.
//
// Everything except `hashToken` is WebCrypto. `hashToken` has to stay
// synchronous — api.ts and auth/session.ts call it inline — and WebCrypto has no
// synchronous digest, so it keeps node:crypto. Workers covers that under the
// `nodejs_compat` flag, which this app needs regardless (src/chat.ts,
// src/diff/index.ts and src/poller/* all import node:crypto synchronously).

const VERSION = "v2";
const LEGACY_VERSION = "v1";
const KDF_SALT = "indmoney-watcher/vault/v2";
const IV_BYTES = 12;

/**
 * OWASP's 2023 floor for PBKDF2-HMAC-SHA256. Costs real CPU: see
 * docs/DEPLOYMENT.md for the Workers CPU-limit note. Derivation is cached per
 * (secret, iterations) for the life of the isolate, so it is paid once.
 */
export const DEFAULT_KDF_ITERATIONS = 600_000;

const keyCache = new Map<string, Promise<CryptoKey>>();

export interface VaultOptions {
  /** Override only to trade security for CPU on a constrained runtime. */
  iterations?: number;
}

export class Vault {
  private readonly secret: string;
  private readonly iterations: number;

  constructor(secret: string, options: VaultOptions = {}) {
    if (!secret) throw new Error("vault secret is empty");
    this.secret = secret;
    this.iterations = options.iterations ?? DEFAULT_KDF_ITERATIONS;
  }

  /** `v2.<iv>.<tag>.<ciphertext>`, all base64url. */
  async encrypt(plaintext: string): Promise<string> {
    const key = await this.key();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        key,
        new TextEncoder().encode(plaintext),
      ),
    );
    // WebCrypto appends the tag to the ciphertext; the envelope keeps them
    // apart so the wire format is unchanged from v1.
    const split = sealed.length - 16;
    return [VERSION, b64(iv), b64(sealed.subarray(split)), b64(sealed.subarray(0, split))].join(
      ".",
    );
  }

  async decrypt(payload: string): Promise<string> {
    const [version, iv, tag, ct] = payload.split(".");
    if (version === LEGACY_VERSION) {
      throw new Error(
        "vault: v1 (scrypt) ciphertext cannot be read by this build — " +
          "reconnect the INDmoney account to re-issue tokens",
      );
    }
    if (version !== VERSION || !iv || !tag || !ct) {
      throw new Error("vault: unrecognised ciphertext envelope");
    }
    const key = await this.key();
    const ciphertext = unb64(ct);
    const authTag = unb64(tag);
    const joined = new Uint8Array(ciphertext.length + authTag.length);
    joined.set(ciphertext);
    joined.set(authTag, ciphertext.length);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), tagLength: 128 },
      key,
      joined,
    );
    return new TextDecoder().decode(plain);
  }

  async encryptJson(value: unknown): Promise<string> {
    return this.encrypt(JSON.stringify(value));
  }

  async decryptJson<T>(payload: string): Promise<T> {
    return JSON.parse(await this.decrypt(payload)) as T;
  }

  /**
   * Cached across instances: the secret is a process-lifetime constant, and on
   * Workers a fresh PBKDF2 run per request would blow the CPU budget.
   */
  private key(): Promise<CryptoKey> {
    const cacheKey = `${this.iterations}:${this.secret}`;
    let derived = keyCache.get(cacheKey);
    if (!derived) {
      derived = deriveKey(this.secret, this.iterations);
      keyCache.set(cacheKey, derived);
    }
    return derived;
  }
}

async function deriveKey(secret: string, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(KDF_SALT),
      iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 32 bytes of entropy, base64url — used for invites, sessions and OAuth state. */
export function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Tokens are stored hashed, so a database dump cannot be replayed as a login.
 * Deliberately synchronous — its callers are inline expressions — and therefore
 * the one node:crypto holdout in this file. Output is byte-identical to v1, so
 * existing invite/session rows keep working.
 */
export function hashToken(token: string): string {
  return b64(new Uint8Array(createHash("sha256").update(token).digest()));
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
