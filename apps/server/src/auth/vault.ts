import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

// AES-256-GCM with a scrypt-stretched APP_SECRET. The key never touches the
// database: a stolen watcher.db is inert without the environment (appendix 1 §3.4).

const VERSION = "v1";
const SALT = "indmoney-watcher/vault/v1";
const IV_BYTES = 12;

export class Vault {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error("vault secret is empty");
    this.key = scryptSync(secret, SALT, 32);
  }

  /** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
  }

  decrypt(payload: string): string {
    const [version, iv, tag, ct] = payload.split(".");
    if (version !== VERSION || !iv || !tag || !ct) {
      throw new Error("vault: unrecognised ciphertext envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, unb64(iv));
    decipher.setAuthTag(unb64(tag));
    return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString(
      "utf8",
    );
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }
}

/** 32 bytes of entropy, base64url — used for invites, sessions and OAuth state. */
export function randomToken(): string {
  return b64(randomBytes(32));
}

/** Tokens are stored hashed, so a database dump cannot be replayed as a login. */
export function hashToken(token: string): string {
  return b64(createHash("sha256").update(token).digest());
}

function b64(buf: Buffer): string {
  return buf.toString("base64url");
}

function unb64(s: string): Buffer {
  return Buffer.from(s, "base64url");
}
