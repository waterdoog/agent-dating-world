import { migrationStatus } from './migrations.js';

try {
  const status = await migrationStatus();
  console.log(`Applied migrations: ${status.applied.length}`);
  console.log(`Pending migrations: ${status.pending.length}`);
  console.log(`Checksum mismatches: ${status.mismatched.length}`);
  console.log(`Database-only migrations: ${status.databaseOnly.length}`);
  for (const migration of status.pending) {
    console.log(`Pending ${migration.filename}`);
  }
  for (const migration of status.mismatched) {
    console.log(`Modified after apply ${migration.filename}`);
  }
  for (const migration of status.databaseOnly) {
    console.log(
      `Applied outside this checkout ${String(migration.version).padStart(4, '0')}_${migration.name}`
    );
  }
  if (status.mismatched.length > 0) process.exitCode = 1;
} catch {
  console.error('Could not read migration status. Check the configured database connection.');
  process.exitCode = 1;
}
