import { generateVapidKeys } from "./webpush.js";

/**
 * `pnpm --filter server vapid:generate`
 *
 * Prints one fresh VAPID keypair and the two commands that install it. Run it
 * once, at deploy; the pair is the watcher's permanent identity to every push
 * service, and rotating it silently invalidates every subscription the group
 * has made — each friend would have to open Settings and turn notifications on
 * again, with nothing telling them to. So: generate once, keep it.
 *
 * Deliberately prints rather than writes. Nothing here should be able to leave
 * a private key in the working tree.
 */

const { publicKey, privateKey } = await generateVapidKeys();

console.log(`
VAPID keypair (P-256, RFC 8292). Generated ${new Date().toISOString()}.

  VAPID_PUBLIC_KEY   ${publicKey}
  VAPID_PRIVATE_KEY  ${privateKey}

The public key is a var — the browser needs it to subscribe, and it travels in
every push request anyway. The private key is a secret and belongs nowhere near
wrangler.jsonc or git.

Production:

  # add to "vars" in apps/server/wrangler.jsonc:
  #   "VAPID_PUBLIC_KEY": "${publicKey}",
  #   "VAPID_SUBJECT": "mailto:you@example.com"

  wrangler secret put VAPID_PRIVATE_KEY   # paste the private key above

Local (apps/server/.dev.vars, gitignored):

  VAPID_PUBLIC_KEY=${publicKey}
  VAPID_PRIVATE_KEY=${privateKey}
  VAPID_SUBJECT=mailto:you@example.com

Set all three or none: a public key without a private one gives the settings
screen a working Enable button whose every send then fails silently.
`);
