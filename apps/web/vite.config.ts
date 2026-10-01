import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import postcssConfig from "../../postcss.config.ts";

const serverOrigin = `http://127.0.0.1:${process.env.TOONFLOW_SERVER_PORT || 47920}`;

export default defineConfig({
  css: { postcss: postcssConfig },
  define: {
    "import.meta.env.appVersion": JSON.stringify(process.env.appVersion ?? "2.0.0"),
  },
  server: {
    proxy: {
      "/mcp": { target: serverOrigin, changeOrigin: false },
      "/a2a": { target: serverOrigin, changeOrigin: false },
      "/api": {
        target: serverOrigin,
        changeOrigin: false,
        configure(proxy) {
          proxy.on("proxyReq", (request, incoming) => {
            request.setHeader("x-toonflow-local-client", ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(incoming.socket.remoteAddress ?? "") ? "1" : "0");
          });
        },
      },
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("./src", import.meta.url)) },
    ],
  },
  build: {
    outDir: "../../build/web",
    emptyOutDir: true,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        pluginSdk: fileURLToPath(new URL("./src/pluginSdk.ts", import.meta.url)),
      },
      output: { entryFileNames: chunk => chunk.name === "pluginSdk" ? "pluginSdk.js" : "assets/[name]-[hash].js" },
    },
  },
  plugins: [
    react(),
  ],
});
