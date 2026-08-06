import type { Context } from "hono";

/**
 * Fire-and-forget work that must outlive the response.
 *
 * On Workers a promise the runtime doesn't know about is cancelled the moment
 * the response is returned, so it has to be handed to `waitUntil`. Under
 * @hono/node-server there is no ExecutionContext at all and reading
 * `c.executionCtx` throws — there the process is long-lived and a detached
 * promise simply runs. One helper, both runtimes, no runtime flag in the deps.
 *
 * The promise passed in must already handle its own failures: nothing here
 * will ever see the rejection.
 */
export function background(c: Context, work: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    void work;
  }
}
