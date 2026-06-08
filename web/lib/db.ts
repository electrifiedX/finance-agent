import path from "path";
import { loadEnvConfig } from "@next/env";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

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
