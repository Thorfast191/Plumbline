import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../.env") });

// Point @plumbline/model's shared `prisma` singleton (and identity.ts's
// admin client) at the TEST database, not dev — this must run before any
// test file imports @plumbline/model, which vitest's setupFiles guarantee
// (see packages/model/src/__tests__/tenant-isolation.test.ts for the
// alternative pattern of constructing explicit clients instead; sync's
// functions use the shared singleton via withAccountContext, so redirecting
// the env vars it reads is the simpler fix here).
if (process.env.DATABASE_URL_TEST) process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
if (process.env.DATABASE_URL_MIGRATE_TEST) process.env.DATABASE_URL_MIGRATE = process.env.DATABASE_URL_MIGRATE_TEST;
