import assert from "node:assert/strict";
import { test } from "node:test";
import { Vault, hashToken, randomToken } from "./vault.js";

// PBKDF2 at the production iteration count costs ~0.3s per distinct secret and
// these tests use several. The KDF is not what is under test here — the
// envelope is — so the tests run it cheap. One test below pins the default.
const fast = { iterations: 1_000 };

test("round-trips a token", async () => {
  const vault = new Vault("secret-one", fast);
  const secret = "refresh-token-value";
  const sealed = await vault.encrypt(secret);
  assert.notEqual(sealed, secret);
  assert.equal(await vault.decrypt(sealed), secret);
});

test("round-trips json", async () => {
  const vault = new Vault("secret-one", fast);
  const clientInfo = { client_id: "abc", client_secret: "shh", redirect_uris: ["x"] };
  assert.deepEqual(await vault.decryptJson(await vault.encryptJson(clientInfo)), clientInfo);
});

test("round-trips non-ascii", async () => {
  const vault = new Vault("secret-one", fast);
  const value = "ünïcode — ₹1,00,000 🎯";
  assert.equal(await vault.decrypt(await vault.encrypt(value)), value);
});

test("same plaintext encrypts differently every time", async () => {
  const vault = new Vault("secret-one", fast);
  assert.notEqual(await vault.encrypt("same"), await vault.encrypt("same"));
});

test("a different secret cannot decrypt", async () => {
  const sealed = await new Vault("secret-one", fast).encrypt("value");
  await assert.rejects(() => new Vault("secret-two", fast).decrypt(sealed));
});

test("a different iteration count cannot decrypt", async () => {
  const sealed = await new Vault("secret-one", fast).encrypt("value");
  await assert.rejects(() => new Vault("secret-one", { iterations: 2_000 }).decrypt(sealed));
});

test("tampered ciphertext fails the auth tag", async () => {
  const vault = new Vault("secret-one", fast);
  const [v, iv, tag, ct] = (await vault.encrypt("value")).split(".");
  const flipped = Buffer.from(ct, "base64url");
  flipped[0] ^= 0xff;
  await assert.rejects(() =>
    vault.decrypt([v, iv, tag, flipped.toString("base64url")].join(".")),
  );
});

test("tampered auth tag is rejected", async () => {
  const vault = new Vault("secret-one", fast);
  const [v, iv, tag, ct] = (await vault.encrypt("value")).split(".");
  const flipped = Buffer.from(tag, "base64url");
  flipped[0] ^= 0xff;
  await assert.rejects(() =>
    vault.decrypt([v, iv, flipped.toString("base64url"), ct].join(".")),
  );
});

test("rejects an unknown envelope", async () => {
  await assert.rejects(() => new Vault("secret-one", fast).decrypt("not-an-envelope"));
});

test("v1 ciphertext reports that a reconnect is required", async () => {
  // The scrypt-keyed envelope this build replaced. Unreadable by design; the
  // error has to say so rather than surfacing as a generic decrypt failure.
  const v1 = "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCC";
  await assert.rejects(
    () => new Vault("secret-one", fast).decrypt(v1),
    /reconnect the INDmoney account/,
  );
});

test("envelope is versioned v2", async () => {
  const sealed = await new Vault("secret-one", fast).encrypt("value");
  assert.equal(sealed.split(".")[0], "v2");
  assert.equal(sealed.split(".").length, 4);
});

test("the default KDF is PBKDF2 at 600k iterations", async () => {
  // Slow on purpose — this is the one place the production cost is paid, and
  // an accidental downgrade of the work factor must fail here.
  const sealed = await new Vault("secret-one").encrypt("value");
  assert.equal(await new Vault("secret-one").decrypt(sealed), "value");
  await assert.rejects(() => new Vault("secret-one", fast).decrypt(sealed));
});

test("token hashing is stable and one-way", () => {
  const token = randomToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
  assert.notEqual(hashToken(token), hashToken(randomToken()));
});

test("random tokens are 32 bytes of base64url", () => {
  const token = randomToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
});
