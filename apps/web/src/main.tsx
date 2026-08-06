import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@workspace/ui/globals.css"
import { App } from "./App.tsx"
import { SessionProvider } from "@/components/session-provider.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

// Production only: in dev the worker would serve a stale shell over Vite's
// HMR, and `import.meta.env.PROD` also keeps it out of the mock-API runs.
// Registered after load so it never competes with the first paint for
// bandwidth. See apps/web/public/sw.js.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js")
  })
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Dark by default: the group checks this in the evening, IST. */}
    <ThemeProvider defaultTheme="dark">
      <SessionProvider>
        <App />
      </SessionProvider>
    </ThemeProvider>
  </StrictMode>
)
