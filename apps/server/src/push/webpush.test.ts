import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  aes128gcmHeader,
  audienceFor,
  decodeBase64Url,
  encodeBase64Url,
  encryptPayload,
  generateVapidKeys,
  importEcdhKeyPair,
  jwtSigningInput,
  MAX_PAYLOAD_BYTES,
  sendWebPush,
  signJwt,
  vapidAuthorization,
} from "./webpush.js";

/**
 * The correctness argument for src/push/webpush.ts, and the reason it is
 * hand-rolled rather than a dependency: both RFCs published worked examples,
 * and both are reproduced here byte for byte.
 *
 * RFC 8291 Appendix A gives every intermediate value for one encryption with a
 * fixed salt and a fixed application-server keypair. Feed those in and the
 * output is deterministic — if the ECDH, either HKDF, the record header or the
 * padding delimiter is wrong by one octet, the ciphertext will not match.
 *
 * RFC 8292 §2.4 gives a JWT and the JWK that signed it. ECDSA is randomised so
 * the signature cannot be reproduced, but the *signing input* can — and the
 * RFC's own signature is verified here against the RFC's own public key
 * through the same encoding this file uses, which pins both halves.
 */

// --- RFC 8291 Appendix A ----------------------------------------------------

const A = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  header:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext:
    "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
  // RFC 8291 §5, the body of the example POST: header ‖ ciphertext.
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("RFC 8291 payload encryption", () => {
  test("reproduces the Appendix A body exactly", async () => {
    const encrypted = await encryptPayload(
      A.plaintext,
      { p256dh: A.uaPublic, auth: A.authSecret },
      {
        salt: decodeBase64Url(A.salt),
        serverKeys: await importEcdhKeyPair(A.asPrivate, A.asPublic),
      },
    );
    assert.equal(encodeBase64Url(encrypted), A.body);
  });

  test("splits into the Appendix A header and ciphertext", async () => {
    const encrypted = await encryptPayload(
      A.plaintext,
      { p256dh: A.uaPublic, auth: A.authSecret },
      {
        salt: decodeBase64Url(A.salt),
        serverKeys: await importEcdhKeyPair(A.asPrivate, A.asPublic),
      },
    );
    // 86 octets: 16 salt + 4 record size + 1 length + 65 key.
    assert.equal(encodeBase64Url(encrypted.subarray(0, 86)), A.header);
    assert.equal(encodeBase64Url(encrypted.subarray(86)), A.ciphertext);
  });

  test("the header carries salt, a 4096 record size and the sender's key", () => {
    const salt = decodeBase64Url(A.salt);
    const key = decodeBase64Url(A.asPublic);
    const header = aes128gcmHeader(salt, key);
    assert.equal(header.length, 86);
    assert.deepEqual(Array.from(header.subarray(16, 21)), [0, 0, 0x10, 0, 65]);
    assert.equal(encodeBase64Url(header.subarray(21)), A.asPublic);
  });

  test("a random salt and ephemeral key change the body but not its shape", async () => {
    const keys = { p256dh: A.uaPublic, auth: A.authSecret };
    const one = await encryptPayload(A.plaintext, keys);
    const two = await encryptPayload(A.plaintext, keys);
    assert.notEqual(encodeBase64Url(one), encodeBase64Url(two));
    // 86 header + 41 plaintext + 1 delimiter + 16 tag.
    assert.equal(one.length, 144);
    assert.equal(two.length, 144);
  });

  test("rejects malformed subscription keys rather than sending garbage", async () => {
    await assert.rejects(
      encryptPayload("x", { p256dh: encodeBase64Url(new Uint8Array(65)), auth: A.authSecret }),
      /uncompressed P-256 point/,
    );
    await assert.rejects(
      encryptPayload("x", { p256dh: A.uaPublic, auth: "c2hvcnQ" }),
      /16 octets/,
    );
    await assert.rejects(
      encryptPayload("x".repeat(MAX_PAYLOAD_BYTES + 1), {
        p256dh: A.uaPublic,
        auth: A.authSecret,
      }),
      /the limit is/,
    );
  });
});

// --- RFC 8292 §2.4 ----------------------------------------------------------

const V = {
  jwt:
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9" +
    ".eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0" +
    ".i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA",
  publicKey:
    "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
  x: "DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc",
  y: "F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
  claims: {
    aud: "https://push.example.net",
    exp: 1453523768,
    sub: "mailto:push@example.com",
  },
};

describe("RFC 8292 VAPID", () => {
  test("builds the example's signing input byte for byte", () => {
    const [header, body] = V.jwt.split(".");
    assert.equal(jwtSigningInput(V.claims), `${header}.${body}`);
  });

  test("the example's own signature verifies through our key encoding", async () => {
    const point = decodeBase64Url(V.publicKey);
    // The split this code relies on everywhere: 0x04 ‖ x ‖ y.
    assert.equal(encodeBase64Url(point.subarray(1, 33)), V.x);
    assert.equal(encodeBase64Url(point.subarray(33, 65)), V.y);

    const [header, body, signature] = V.jwt.split(".");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: V.x, y: V.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(`${header}.${body}`),
    );
    assert.ok(verified, "RFC 8292's example signature did not verify");
  });

  test("a generated keypair signs a token that verifies against its public key", async () => {
    const keys = await generateVapidKeys();
    const jwt = await signJwt(V.claims, keys);
    const [header, body, signature] = jwt.split(".");
    assert.equal(`${header}.${body}`, jwtSigningInput(V.claims));

    const point = decodeBase64Url(keys.publicKey);
    const key = await crypto.subtle.importKey(
      "jwk",
      {
        kty: "EC",
        crv: "P-256",
        x: encodeBase64Url(point.subarray(1, 33)),
        y: encodeBase64Url(point.subarray(33, 65)),
      },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    assert.ok(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        decodeBase64Url(signature),
        new TextEncoder().encode(`${header}.${body}`),
      ),
    );
  });

  test("the authorization header carries t and k, and expires inside 24 hours", async () => {
    const keys = await generateVapidKeys();
    const now = new Date("2026-08-06T00:00:00.000Z");
    const header = await vapidAuthorization(
      { ...keys, subject: "mailto:watcher@example.com" },
      "https://fcm.googleapis.com",
      now,
    );
    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header);
    assert.ok(match, `unexpected header: ${header}`);
    assert.equal(match[2], keys.publicKey);

    const claims = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(match[1].split(".")[1])),
    ) as { aud: string; exp: number; sub: string };
    assert.equal(claims.aud, "https://fcm.googleapis.com");
    assert.equal(claims.sub, "mailto:watcher@example.com");
    const seconds = claims.exp - Math.floor(now.getTime() / 1000);
    assert.ok(seconds > 0 && seconds <= 86_400, `exp is ${seconds}s out`);
  });

  test("a mismatched key pair fails here, not at the push service", async () => {
    const one = await generateVapidKeys();
    const two = await generateVapidKeys();
    await assert.rejects(signJwt(V.claims, { publicKey: one.publicKey, privateKey: two.privateKey }));
  });

  test("the audience is the endpoint's origin, never the endpoint", () => {
    assert.equal(
      audienceFor("https://fcm.googleapis.com/fcm/send/abc:123?x=1"),
      "https://fcm.googleapis.com",
    );
    assert.equal(
      audienceFor("https://web.push.apple.com/QK9k...long/path"),
      "https://web.push.apple.com",
    );
  });
});

// --- The request ------------------------------------------------------------

describe("sendWebPush", () => {
  const subscription = {
    endpoint: "https://push.example.net/push/abc",
    keys: { p256dh: A.uaPublic, auth: A.authSecret },
  };

  test("POSTs an aes128gcm body with the VAPID header", async () => {
    const keys = await generateVapidKeys();
    let seen: { url: string; init: RequestInit } | undefined;
    const result = await sendWebPush(
      subscription,
      JSON.stringify({ title: "hello" }),
      { ...keys, subject: "mailto:watcher@example.com" },
      {
        fetch: (async (url: string, init: RequestInit) => {
          seen = { url, init };
          return new Response(null, { status: 201 });
        }) as unknown as typeof fetch,
      },
    );

    assert.deepEqual(result, { status: 201, gone: false, ok: true });
    assert.equal(seen?.url, subscription.endpoint);
    const headers = seen!.init.headers as Record<string, string>;
    assert.equal(headers["Content-Encoding"], "aes128gcm");
    assert.equal(headers["Content-Type"], "application/octet-stream");
    assert.match(headers.Authorization, /^vapid t=.+, k=.+$/);
    assert.ok(Number(headers.TTL) > 0);
    // Header (86) + the JSON + delimiter + tag; the body is real ciphertext.
    assert.ok((seen!.init.body as ArrayBuffer).byteLength > 86);
  });

  test("404 and 410 report `gone`; other rejections merely report themselves", async () => {
    const keys = { ...(await generateVapidKeys()), subject: "mailto:w@example.com" };
    const reply = (status: number) =>
      sendWebPush(subscription, "{}", keys, {
        fetch: (async () => new Response(null, { status })) as unknown as typeof fetch,
      });

    assert.equal((await reply(404)).gone, true);
    assert.equal((await reply(410)).gone, true);
    assert.deepEqual(await reply(429), { status: 429, gone: false, ok: false });
    assert.deepEqual(await reply(500), { status: 500, gone: false, ok: false });
  });

  test("one authorization can be reused across a fan-out to one service", async () => {
    const keys = { ...(await generateVapidKeys()), subject: "mailto:w@example.com" };
    const authorization = await vapidAuthorization(keys, audienceFor(subscription.endpoint));
    const headers: string[] = [];
    for (let i = 0; i < 3; i++) {
      await sendWebPush(subscription, "{}", keys, {
        authorization,
        fetch: (async (_url: string, init: RequestInit) => {
          headers.push((init.headers as Record<string, string>).Authorization);
          return new Response(null, { status: 201 });
        }) as unknown as typeof fetch,
      });
    }
    assert.deepEqual(headers, [authorization, authorization, authorization]);
  });
});
