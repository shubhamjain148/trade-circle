import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

// DEV MOCK — returns null unless WATCHER_MOCK=1; see apps/web/dev/mock-api.ts.
import { devMockApi } from "./dev/mock-api"

/**
 * public/sw.js ships two build-time holes: the list of shell files to precache
 * and a version string to key the cache on. Both are filled in here, from the
 * bundle Rollup actually emitted, so the worker can't precache a filename that
 * a rebuild renamed. Cheaper than a workbox dependency and it fits on a page.
 */
function precacheServiceWorker(): Plugin {
  return {
    name: "watcher-sw-precache",
    apply: "build",
    async writeBundle(options, bundle) {
      const outDir = options.dir
      if (!outDir) return

      const shell = Object.values(bundle)
        .filter((chunk) =>
          chunk.type === "chunk"
            ? chunk.isEntry
            : chunk.fileName.endsWith(".css")
        )
        .map((chunk) => `/${chunk.fileName}`)
        .sort()

      // Fonts and lazy chunks stay out: they land in the cache on first use.
      const precache = [
        "/index.html",
        ...shell,
        "/manifest.webmanifest",
        "/icon.svg",
        "/icons/apple-touch-icon.png",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
      ]

      const swPath = path.join(outDir, "sw.js")
      const source = await fs.readFile(swPath, "utf8")
      const version = createHash("sha256")
        .update(precache.join("|"))
        .digest("hex")
        .slice(0, 12)

      const next = source
        .replace("__SW_VERSION__", version)
        .replace(
          /\["\/index\.html"\] \/\* __SW_PRECACHE__ \*\//,
          JSON.stringify(precache)
        )

      if (next === source) {
        this.error("sw.js is missing its precache placeholders")
      }

      await fs.writeFile(swPath, next)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), devMockApi(), precacheServiceWorker()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // Override to point a scratch dev server at a scratch API instance.
      // `ws` so /api/chat/ws upgrades through the proxy rather than 400ing —
      // needed when the API behind it is `wrangler dev`. The Node entry point
      // answers that route with 501 and the client falls back to polling.
      "/api": {
        target: process.env.WATCHER_API ?? "http://localhost:3001",
        ws: true,
      },
    },
  },
  // `vite preview` does not inherit server.proxy, and the built app is the only
  // place the service worker exists — so previewing it has to reach an API too.
  preview: {
    proxy: {
      "/api": {
        target: process.env.WATCHER_API ?? "http://localhost:3001",
        ws: true,
      },
    },
  },
})
