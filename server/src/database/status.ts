import { migrationStatus } from './migrations.js';

try {
  const status = await migrationStatus();
  console.log(`Applied migrations: ${status.applied.length}`);
  console.log(`Pending migrations: ${status.pending.length}`);
  console.log(`Checksum mismatches: ${status.mismatched.length}`);
  for (const migration of status.pending) {
    console.log(`Pending ${migration.filename}`);
  }
  for (const migration of status.mismatched) {
    console.log(`Modified after apply ${migration.filename}`);
  }
  if (status.mismatched.length > 0) process.exitCode = 1;
} catch {
  console.error('Could not read migration status. Check the configured database connection.');
  process.exitCode = 1;
}
