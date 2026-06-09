import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

// The repo-root .env is shared with the Python importers. Next.js's built-in
// env loading (@next/env's loadEnvConfig) only picks up that repo-root file
// reliably under `next dev`; under `next start` (production) it is frequently
// missed, leaving DATABASE_URL undefined. We also can't trust __dirname here,
// since it points inside the bundled .next output rather than web/lib.
//
// Both `next dev` and `next start` are launched from the web/ directory, so the
// repo root is one level up from process.cwd(). Resolve that absolute path and
// load the .env explicitly so it works identically in dev and production.
const repoRootEnvPath = path.resolve(process.cwd(), "..", ".env");
dotenv.config({ path: repoRootEnvPath });

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const existsNote = fs.existsSync(repoRootEnvPath)
      ? "the file exists but has no DATABASE_URL entry"
      : "the file does not exist";
    throw new Error(
      `DATABASE_URL not found — checked ${repoRootEnvPath} (${existsNote}). ` +
        "Run the app from the web/ directory so the repo-root .env can be located, " +
        "or set DATABASE_URL in the environment.",
    );
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
