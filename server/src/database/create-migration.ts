import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrations } from './migrations.js';

const rawName = process.argv.slice(2).join('_').trim().toLowerCase();
const name = rawName
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

if (!name) {
  console.error('Usage: pnpm db:create -- <migration_name>');
  process.exitCode = 1;
} else {
  const migrations = await readMigrations();
  const nextVersion = (migrations.at(-1)?.version ?? 0) + 1;
  if (nextVersion > 9_999) throw new Error('Migration version limit reached.');
  const filename = `${String(nextVersion).padStart(4, '0')}_${name}.sql`;
  const directory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../migrations'
  );
  const target = path.join(directory, filename);
  try {
    await access(target);
    throw new Error(`${filename} already exists.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(target, '-- Write this migration so it can run once inside a transaction.\n', {
    flag: 'wx',
  });
  console.log(`Created server/migrations/${filename}`);
}
