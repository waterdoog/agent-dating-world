import { runMigrations } from './migrations.js';

try {
  const applied = await runMigrations();
  if (applied.length === 0) {
    console.log('Database is already up to date.');
  } else {
    for (const migration of applied) {
      console.log(`Applied ${migration.filename}`);
    }
  }
} catch {
  console.error('Database migration failed. Check the configured direct connection and retry.');
  process.exitCode = 1;
}
