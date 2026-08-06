/**
 * ─────────────────────────────────────────────────────────────────────────────
 * DEV MOCK — delete this file and its two references to remove it entirely.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Stands in for the auth/connect endpoints while the server grows them, so
 * every state of the login and settings UI can be driven visually.
 *
 * It cannot reach production:
 *   1. `apply: "serve"` — Vite never loads it in `vite build`.
 *   2. It returns `null` (no plugin at all) unless WATCHER_MOCK=1 is set in
 *      the shell that starts the dev server.
 * So by default `pnpm dev` talks to the real Hono server on :3001 exactly as
 * before, and this middleware is not even installed.
 *
 * Drive it:
 *   WATCHER_MOCK=1 pnpm --filter web dev
 *   open http://localhost:5173/__mock?scenario=needs_reauth
 *
 * To remove: delete apps/web/dev/, and drop the devMockApi() line and its
 * import from apps/web/vite.config.ts.
 */
import type { Connect, Plugin } from "vite"
import type { ServerResponse } from "node:http"

type Scenario =
  | "signed_out"
  | "unreachable"
  | "not_connected"
  | "pending"
  | "active"
  | "needs_reauth"
  | "revoked"
  | "join_used"
  | "join_invalid"
  | "connect_error"

const DEFAULT_SCENARIO: Scenario = "active"
const COOKIE = "watcher_mock_scenario"

interface MockAccount {
  connected: boolean
  status: "active" | "needs_reauth" | "revoked" | "pending"
  lastPolledAt: string | null
}

const hoursAgo = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString()

const ACCOUNTS: Record<Scenario, MockAccount | null> = {
  signed_out: null,
  unreachable: null,
  not_connected: null,
  pending: { connected: true, status: "pending", lastPolledAt: null },
  active: { connected: true, status: "active", lastPolledAt: hoursAgo(1.5) },
  needs_reauth: {
    connected: true,
    status: "needs_reauth",
    lastPolledAt: hoursAgo(31),
  },
  revoked: { connected: false, status: "revoked", lastPolledAt: hoursAgo(76) },
  join_used: null,
  join_invalid: null,
  connect_error: null,
}

const MEMBERS = [
  { id: "m_rahul", name: "Rahul Menon", visibility: "named", role: "admin" },
  { id: "m_aditi", name: "Aditi Sharma", visibility: "named", role: "member" },
  {
    id: "m_karthik",
    name: "Karthik Iyer",
    visibility: "anonymous",
    role: "member",
  },
  { id: "m_neha", name: "Neha Bhat", visibility: "paused", role: "member" },
]

/**
 * The admin roster, so Settings' Group section can be driven visually too.
 * Mutated in place by the handlers below — a mint/void within one scenario
 * survives a reload, exactly like the account state above it.
 */
const ROSTER: {
  id: string
  name: string
  role: string
  visibility: string
  connected: boolean
  status: string
  lastPolledAt: string | null
  invite: { status: "pending" | "used"; at: string } | null
}[] = [
  {
    ...MEMBERS[0],
    connected: true,
    status: "active",
    lastPolledAt: hoursAgo(1.5),
    invite: { status: "used", at: hoursAgo(700) },
  },
  {
    ...MEMBERS[1],
    connected: true,
    status: "active",
    lastPolledAt: hoursAgo(2),
    invite: { status: "used", at: hoursAgo(600) },
  },
  {
    ...MEMBERS[2],
    connected: true,
    status: "needs_reauth",
    lastPolledAt: hoursAgo(31),
    invite: { status: "used", at: hoursAgo(500) },
  },
  {
    ...MEMBERS[3],
    connected: false,
    status: "not_connected",
    lastPolledAt: null,
    invite: { status: "pending", at: hoursAgo(3) },
  },
]

const ME = MEMBERS[0]

const FEED = [
  {
    id: "e1",
    accountId: "m_aditi",
    accountName: "Aditi Sharma",
    type: "NEW_POSITION",
    symbol: "NVDA",
    instrumentName: "NVIDIA Corporation",
    pctOfPortfolio: 6.4,
    detectedAt: hoursAgo(0.4),
  },
  {
    id: "e2",
    accountId: "m_karthik",
    accountName: "Anonymous",
    type: "SIZE_UP",
    symbol: "AMD",
    instrumentName: "Advanced Micro Devices",
    pctOfPortfolio: 11.2,
    qtyChangePct: 0.35,
    detectedAt: hoursAgo(3),
  },
  {
    id: "e3",
    accountId: "m_rahul",
    accountName: "Rahul Menon",
    type: "EXITED",
    symbol: "TSLA",
    instrumentName: "Tesla, Inc.",
    pctOfPortfolio: 0,
    detectedAt: hoursAgo(20),
  },
  {
    id: "e4",
    accountId: "m_aditi",
    accountName: "Aditi Sharma",
    type: "SIZE_DOWN",
    symbol: "COIN",
    instrumentName: "Coinbase Global",
    pctOfPortfolio: 2.1,
    qtyChangePct: -0.4,
    detectedAt: hoursAgo(27),
  },
  {
    id: "e5",
    accountId: "m_rahul",
    accountName: "Rahul Menon",
    type: "NEW_POSITION",
    symbol: "MSFT",
    instrumentName: "Microsoft Corporation",
    pctOfPortfolio: 9.8,
    detectedAt: hoursAgo(50),
  },
]

/** Per-scenario session, so logging out in one tab doesn't wedge the next run. */
interface MockState {
  scenario: Scenario
  signedIn: boolean
  account: MockAccount | null
}

function stateFor(scenario: Scenario): MockState {
  return {
    scenario,
    signedIn: !(
      scenario === "signed_out" ||
      scenario === "join_used" ||
      scenario === "join_invalid"
    ),
    account: ACCOUNTS[scenario],
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

function redirect(res: ServerResponse, location: string) {
  res.statusCode = 302
  res.setHeader("Location", location)
  res.end()
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => resolve(raw))
  })
}

export function devMockApi(): Plugin | null {
  if (process.env.WATCHER_MOCK !== "1") return null

  // Keyed by scenario so switching scenarios is a clean reset, and so a
  // logout/disconnect within one scenario persists across reloads.
  const states = new Map<Scenario, MockState>()

  const load = (req: Connect.IncomingMessage): MockState => {
    const match = new RegExp(`${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? "")
    const scenario = (match?.[1] ?? DEFAULT_SCENARIO) as Scenario

    if (!states.has(scenario)) states.set(scenario, stateFor(scenario))
    return states.get(scenario)!
  }

  return {
    name: "watcher-dev-mock-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost")
        const path = url.pathname
        const method = req.method ?? "GET"

        // Scenario switch: /__mock?scenario=needs_reauth[&to=%23/settings]
        if (path === "/__mock") {
          const scenario = (url.searchParams.get("scenario") ??
            DEFAULT_SCENARIO) as Scenario
          states.set(scenario, stateFor(scenario))
          res.setHeader("Set-Cookie", `${COOKIE}=${scenario}; Path=/`)
          redirect(res, url.searchParams.get("to") ?? "/")
          return
        }

        if (!path.startsWith("/api/")) return next()

        const state = load(req)

        if (path === "/api/me" && method === "GET") {
          if (state.scenario === "unreachable") {
            return json(res, 503, { error: "watcher_unreachable" })
          }
          if (!state.signedIn) return json(res, 401, { error: "no_session" })
          return json(res, 200, { member: ME, account: state.account })
        }

        if (path === "/api/auth/session" && method === "POST") {
          const body = await readBody(req)
          const token = (JSON.parse(body || "{}") as { inviteToken?: string })
            .inviteToken

          if (!token) return json(res, 400, { error: "missing_token" })
          if (state.scenario === "join_used") {
            return json(res, 410, { error: "token_used" })
          }
          if (state.scenario === "join_invalid") {
            return json(res, 400, { error: "token_invalid" })
          }

          state.signedIn = true
          res.setHeader("Set-Cookie", `${COOKIE}=${state.scenario}; Path=/`)
          return json(res, 200, { member: ME })
        }

        if (path === "/api/auth/logout" && method === "POST") {
          state.signedIn = false
          res.statusCode = 204
          return res.end()
        }

        if (path === "/api/connect/indmoney/start" && method === "GET") {
          // Stands in for the whole INDmoney round trip, callback included.
          return redirect(
            res,
            state.scenario === "connect_error"
              ? "/#/settings?connect_error=access_denied"
              : "/#/settings?connected=1"
          )
        }

        if (path === "/api/connect/indmoney" && method === "DELETE") {
          state.account = null
          res.statusCode = 204
          return res.end()
        }

        if (!state.signedIn) return json(res, 401, { error: "no_session" })

        if (path === "/api/members") return json(res, 200, MEMBERS)

        // Admin roster + invites. ME is the admin in this mock, so the Group
        // section is always reachable; flip ME's role to "member" to see the
        // section vanish the way it does for everyone else.
        if (path.startsWith("/api/admin/")) {
          if (ME.role !== "admin") return json(res, 403, { error: "forbidden" })

          if (path === "/api/admin/members" && method === "GET") {
            return json(res, 200, ROSTER)
          }

          if (path === "/api/admin/members" && method === "POST") {
            const body = await readBody(req)
            const name = (
              (JSON.parse(body || "{}") as { name?: string }).name ?? ""
            ).trim()
            if (!name) return json(res, 400, { error: "name_required" })

            const member = {
              id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
              name,
              role: "member",
              visibility: "named",
              connected: false,
              status: "not_connected",
              lastPolledAt: null,
              invite: null,
            }
            ROSTER.push(member)
            return json(res, 201, { member })
          }

          const inviteFor = /^\/api\/admin\/members\/([^/]+)\/invite$/.exec(path)
          const target = inviteFor
            ? ROSTER.find((m) => m.id === decodeURIComponent(inviteFor[1]))
            : undefined
          if (!target) return json(res, 404, { error: "unknown_member" })

          if (method === "POST") {
            target.invite = { status: "pending", at: new Date().toISOString() }
            return json(res, 201, {
              url: `http://localhost:5173/#/join?token=mock-${target.id}-${Date.now().toString(36)}`,
            })
          }

          if (method === "DELETE") {
            if (target.invite?.status !== "pending") {
              return json(res, 404, { error: "no_pending_invite" })
            }
            target.invite = null
            return json(res, 200, { voided: 1 })
          }
        }

        if (path === "/api/feed") {
          const accountId = url.searchParams.get("accountId")
          return json(
            res,
            200,
            accountId ? FEED.filter((e) => e.accountId === accountId) : FEED
          )
        }

        return next()
      })
    },
  }
}
