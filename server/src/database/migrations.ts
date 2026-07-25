import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { requireDatabaseUrl } from './config.js';

const MIGRATION_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations'
);
const MIGRATION_LOCK_ID = 1_813_370_822;
const MIGRATION_TABLE = 'virtual_n1.n1_schema_migrations';

const HARDEN_PRIVATE_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS virtual_n1;
  REVOKE ALL ON SCHEMA virtual_n1 FROM PUBLIC;
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA virtual_n1 FROM PUBLIC;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA virtual_n1 FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1
    REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;

  DO $n1_acl$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA virtual_n1 FROM anon';
      EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA virtual_n1 FROM anon';
      EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA virtual_n1 FROM anon';
      EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1 REVOKE ALL PRIVILEGES ON TABLES FROM anon';
      EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1 REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA virtual_n1 FROM authenticated';
      EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA virtual_n1 FROM authenticated';
      EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA virtual_n1 FROM authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1 REVOKE ALL PRIVILEGES ON TABLES FROM authenticated';
      EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA virtual_n1 REVOKE ALL PRIVILEGES ON SEQUENCES FROM authenticated';
    END IF;
  END
  $n1_acl$;
`;

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export async function readMigrations(): Promise<MigrationFile[]> {
  const filenames = (await readdir(MIGRATIONS_DIR))
    .filter((filename) => MIGRATION_PATTERN.test(filename))
    .sort();
  const seen = new Set<number>();
  const migrations: MigrationFile[] = [];
  for (const filename of filenames) {
    const match = filename.match(MIGRATION_PATTERN)!;
    const version = Number(match[1]);
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${match[1]}.`);
    }
    seen.add(version);
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    migrations.push({
      version,
      name: match[2],
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

function migrationClient() {
  return postgres(requireDatabaseUrl('migration'), {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => undefined,
  });
}

export async function migrationStatus(): Promise<{
  applied: MigrationFile[];
  pending: MigrationFile[];
  mismatched: MigrationFile[];
}> {
  const migrations = await readMigrations();
  const sql = migrationClient();
  try {
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass(${MIGRATION_TABLE}) IS NOT NULL AS exists
    `;
    if (!exists) return { applied: [], pending: migrations, mismatched: [] };
    const rows = await sql<{ version: number; checksum: string }[]>`
      SELECT version, checksum
      FROM virtual_n1.n1_schema_migrations
      ORDER BY version
    `;
    const appliedChecksums = new Map(
      rows.map((row) => [Number(row.version), row.checksum])
    );
    return {
      applied: migrations.filter(
        (migration) =>
          appliedChecksums.get(migration.version) === migration.checksum
      ),
      pending: migrations.filter(
        (migration) => !appliedChecksums.has(migration.version)
      ),
      mismatched: migrations.filter(
        (migration) =>
          appliedChecksums.has(migration.version) &&
          appliedChecksums.get(migration.version) !== migration.checksum
      ),
    };
  } finally {
    await sql.end({ timeout: 1 });
  }
}

export async function runMigrations(): Promise<MigrationFile[]> {
  const migrations = await readMigrations();
  const sql = migrationClient();
  const applied: MigrationFile[] = [];
  let locked = false;
  try {
    await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
    locked = true;
    await sql.unsafe(HARDEN_PRIVATE_SCHEMA_SQL);
    await sql`
      CREATE TABLE IF NOT EXISTS virtual_n1.n1_schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql.unsafe(HARDEN_PRIVATE_SCHEMA_SQL);
    const rows = await sql<{ version: number; checksum: string }[]>`
      SELECT version, checksum
      FROM virtual_n1.n1_schema_migrations
      ORDER BY version
    `;
    const appliedChecksums = new Map(
      rows.map((row) => [Number(row.version), row.checksum])
    );
    for (const migration of migrations) {
      const previousChecksum = appliedChecksums.get(migration.version);
      if (previousChecksum) {
        if (previousChecksum !== migration.checksum) {
          throw new Error(
            `Applied migration ${migration.filename} has been modified.`
          );
        }
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx.unsafe(HARDEN_PRIVATE_SCHEMA_SQL);
        await tx`
          INSERT INTO virtual_n1.n1_schema_migrations (version, name, checksum)
          VALUES (${migration.version}, ${migration.name}, ${migration.checksum})
        `;
      });
      applied.push(migration);
    }
    return applied;
  } finally {
    if (locked) {
      await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`.catch(() => undefined);
    }
    await sql.end({ timeout: 1 });
  }
}
