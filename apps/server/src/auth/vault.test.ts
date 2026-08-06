import assert from "node:assert/strict";
import { test } from "node:test";
import { Vault, hashToken, randomToken } from "./vault.js";

test("round-trips a token", () => {
  const vault = new Vault("secret-one");
  const secret = "refresh-token-value";
  const sealed = vault.encrypt(secret);
  assert.notEqual(sealed, secret);
  assert.equal(vault.decrypt(sealed), secret);
});

test("round-trips json", () => {
  const vault = new Vault("secret-one");
  const clientInfo = { client_id: "abc", client_secret: "shh", redirect_uris: ["x"] };
  assert.deepEqual(vault.decryptJson(vault.encryptJson(clientInfo)), clientInfo);
});

test("same plaintext encrypts differently every time", () => {
  const vault = new Vault("secret-one");
  assert.notEqual(vault.encrypt("same"), vault.encrypt("same"));
});

test("a different secret cannot decrypt", () => {
  const sealed = new Vault("secret-one").encrypt("value");
  assert.throws(() => new Vault("secret-two").decrypt(sealed));
});

test("tampered ciphertext fails the auth tag", () => {
  const vault = new Vault("secret-one");
  const [v, iv, tag, ct] = vault.encrypt("value").split(".");
  const flipped = Buffer.from(ct, "base64url");
  flipped[0] ^= 0xff;
  assert.throws(() => vault.decrypt([v, iv, tag, flipped.toString("base64url")].join(".")));
});

test("rejects an unknown envelope", () => {
  assert.throws(() => new Vault("secret-one").decrypt("not-an-envelope"));
});

test("token hashing is stable and one-way", () => {
  const token = randomToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
  assert.notEqual(hashToken(token), hashToken(randomToken()));
});
