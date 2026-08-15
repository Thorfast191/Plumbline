import { PrismaClient, type Prisma } from "@prisma/client";

export const prisma = new PrismaClient();

export type TenantClient = Prisma.TransactionClient;

/**
 * Runs `fn` inside a transaction with the Postgres session var
 * `app.current_account_id` set for the duration of the transaction. Every
 * tenant-scoped table has a row-level security policy that filters on this
 * setting (see prisma/migrations/*_add_account_id_and_rls), so any query
 * issued through the client passed to `fn` is enforced at the database
 * layer, not just in application code.
 *
 * `client` must connect as a non-superuser role — Postgres bypasses RLS
 * entirely for superusers, so a superuser connection here would silently
 * defeat isolation. See DATABASE_URL vs DATABASE_URL_MIGRATE in .env.example.
 */
export async function withAccountContextOn<T>(
  client: PrismaClient,
  accountId: string,
  fn: (tx: TenantClient) => Promise<T>
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_account_id', ${accountId}, true)`;
    return fn(tx);
  });
}

export async function withAccountContext<T>(
  accountId: string,
  fn: (tx: TenantClient) => Promise<T>
): Promise<T> {
  return withAccountContextOn(prisma, accountId, fn);
}
