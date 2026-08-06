import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// DEV MOCK — returns null unless WATCHER_MOCK=1; see apps/web/dev/mock-api.ts.
import { devMockApi } from "./dev/mock-api"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), devMockApi()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
})
