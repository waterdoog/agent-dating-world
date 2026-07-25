import postgres from 'postgres';
import { requireDatabaseUrl, runtimeDatabaseUrl } from './config.js';

export type DatabaseClient = ReturnType<typeof postgres>;
export type DatabaseQueryClient =
  | DatabaseClient
  | postgres.TransactionSql;

let runtimeClient: DatabaseClient | null = null;

export function isDatabaseConfigured(): boolean {
  return runtimeDatabaseUrl() !== null;
}

export function database(): DatabaseClient {
  if (!runtimeClient) {
    runtimeClient = postgres(requireDatabaseUrl('runtime'), {
      max: 8,
      idle_timeout: 20,
      connect_timeout: 10,
      // Supabase's pooled URL may use transaction mode, where prepared
      // statements cannot be assumed to remain on one backend connection.
      prepare: false,
      onnotice: () => undefined,
    });
  }
  return runtimeClient;
}

export async function closeDatabaseForTests(): Promise<void> {
  if (!runtimeClient) return;
  const client = runtimeClient;
  runtimeClient = null;
  await client.end({ timeout: 1 });
}
