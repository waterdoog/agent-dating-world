import { loadEnvFile } from 'node:process';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

function nonEmpty(name: string): string | null {
  return process.env[name]?.trim() || null;
}

/**
 * The application uses only this project's explicitly prefixed Supabase
 * binding. Falling back to a generic DATABASE_URL is dangerous when a Vercel
 * project has ever had more than one database integration.
 */
export function runtimeDatabaseUrl(): string | null {
  return nonEmpty('n1_POSTGRES_URL');
}

/**
 * Migrations prefer the direct/non-pooling connection so DDL is never sent
 * through a transaction pooler. The project-scoped runtime URL is a local
 * fallback when Supabase supplies no separate direct URL.
 */
export function migrationDatabaseUrl(): string | null {
  return nonEmpty('n1_POSTGRES_URL_NON_POOLING') ?? runtimeDatabaseUrl();
}

export function requireDatabaseUrl(kind: 'runtime' | 'migration'): string {
  const value = kind === 'runtime' ? runtimeDatabaseUrl() : migrationDatabaseUrl();
  if (!value) {
    const preferred =
      kind === 'runtime' ? 'n1_POSTGRES_URL' : 'n1_POSTGRES_URL_NON_POOLING';
    throw new Error(`Database is not configured. Set ${preferred}.`);
  }
  return value;
}
