import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// Next.js only auto-loads .env* files from apps/web/ itself, never the
// monorepo root — but DATABASE_URL_MIGRATE, DATABASE_URL, SHOPIFY_* etc.
// all live in the root .env (same file every package/script in this repo
// reads via `config({ path: ... "../../.env" })`, e.g.
// packages/model/prisma/seed.ts, scripts/worker.ts). Without this, every
// page/route that touches @plumbline/model (sync-status, /api/enrich/*)
// fails at runtime with "DATABASE_URL_MIGRATE is not set" even though
// typecheck and the standalone scripts both look fine.
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // Workspace packages (@plumbline/*) are consumed directly as TypeScript
    // source (package.json "main": "./src/index.ts"), and that source uses
    // NodeNext-style relative imports with explicit ".js" extensions (e.g.
    // `export * from "./money.js"` in a file that's actually money.ts) —
    // correct for tsc/Node's own ESM resolution (see root tsconfig.json:
    // module/moduleResolution "NodeNext"), but webpack has no built-in rule
    // mapping a ".js" specifier back to a ".ts" file on disk. Without this,
    // any page/route pulling in such a chain (e.g. @plumbline/model's
    // index.ts) fails with "Module not found: Can't resolve './money.js'"
    // — in both `next dev` and `next build`, not just production as
    // originally (incompletely) flagged after Phase 4.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
