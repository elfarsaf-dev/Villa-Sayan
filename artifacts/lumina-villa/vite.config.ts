import { defineConfig, type Plugin } from "vite";
import path from "path";

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? "/";

// Plugin: inject VITE_* env vars into HTML by replacing %VITE_XXX% tokens
function injectEnvPlugin(): Plugin {
  return {
    name: "inject-env-html",
    transformIndexHtml(html) {
      return html.replace(/%VITE_([A-Z0-9_]+)%/g, (_match, key) => {
        return process.env[`VITE_${key}`] ?? "";
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  root: path.resolve(import.meta.dirname),
  plugins: [injectEnvPlugin()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
