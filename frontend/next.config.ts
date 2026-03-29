import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));

const nextConfig: NextConfig = {
  // Static HTML export: Tauri serves the `out/` directory from the webview.
  // This removes the need for a Node.js runtime at run time.
  output: "export",

  // When building for the desktop app the backend runs on a fixed localhost port.
  // NEXT_PUBLIC_API_URL is baked in at build time; the default below is for dev.
  // The CI release workflow sets NEXT_PUBLIC_API_URL=http://127.0.0.1:8000.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },

  // Image optimisation requires a Node.js server, so we fall back to the
  // built-in unoptimised loader for the static export.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
