/**
 * Preloaded before every test file (see the `test` script in package.json).
 *
 * Tests must see the same environment on a laptop and in CI. Cloudflare Workers
 * Builds exports the deploy-time build variables (APP_URL, VAPID_PUBLIC_KEY,
 * VAPID_SUBJECT, …) into the build shell, and `config.ts` reads process.env at
 * import — so without this, the half-configured-VAPID guard fires in CI and ten
 * test files fail before their first assertion. Strip everything the runtime
 * config understands; each test sets what it needs explicitly.
 */
for (const key of [
  "APP_URL",
  "APP_SECRET",
  "MCP_BASE_URL",
  "MCP_CLIENT_NAME",
  "DB_PATH",
  "PORT",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
  "VAULT_KDF_ITERATIONS",
  "DISABLE_SCHEDULER",
]) {
  delete process.env[key];
}
