import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "node:url"
import { fragmentFocusScript } from "./src/lib/ouro/fragment-focus-script"

const API_PORT = 6877

// Ouro UI's fragmentFocusScript, first in <body> and so after the stylesheets: Safari keeps a person's focus on a page
// opened at a place on it (/#agents) while later stylesheets load. Ouro check's fragment-focus rule names a page without it.
const fragmentFocus = {
  name: "fragment-focus",
  transformIndexHtml: () => [{ tag: "script", children: fragmentFocusScript(), injectTo: "body-prepend" as const }],
}

export default defineConfig({
  plugins: [tailwindcss(), react(), fragmentFocus],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 6876,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
      "/mailbox/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/")
          if (!normalized.includes("/node_modules/")) return undefined
          return "vendor"
        },
      },
    },
  },
})
