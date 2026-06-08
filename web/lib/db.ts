import path from "path";
import { loadEnvConfig } from "@next/env";
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

// Repo-root .env is shared with Python importers (see web/next.config.ts).
loadEnvConfig(path.resolve(__dirname, "../.."));

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return url;
}

declare global {
  var __financePgPool: Pool | undefined;
}

function getPool(): Pool {
  if (!global.__financePgPool) {
    global.__financePgPool = new Pool({ connectionString: getDatabaseUrl() });
  }
  return global.__financePgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

// Run a set of writes in one transaction on a single pooled client. Used by the
// edit/add routes where merchant re-pointing, the txn write, split rows, the
// merchant default + correction log must all commit (or roll back) together.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
