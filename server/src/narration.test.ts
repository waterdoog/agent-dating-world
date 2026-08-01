/**
 * The town's authored layer has to survive the process that wrote it.
 *
 * Beats are facts and rebuild from `town_events`. A thread's title, its arc, its
 * open question and the world digest are model output — nothing can recreate
 * them, and they lived in a module-level Map. Every restart threw them away and
 * the next beat regenerated a different version, which is exactly what "the
 * story lines keep resetting" was.
 *
 * These run against the real Postgres because storage is the thing under test.
 * Skipped without one, like the rest of the town.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { database, isDatabaseConfigured } from './database/client.js';
import { saveNarration, readNarration, narrationsUnder } from './modules/dating/town-repository.js';

const live = isDatabaseConfigured();
const skip = live ? undefined : 'no database configured';

test('narration survives the process that wrote it', { skip }, async () => {
  const key = `test:thread:${randomUUID()}`;
  try {
    await saveNarration(key, { title: 'Bravo catches Charlie changing his story', arc: 'one', openQuestion: 'who asks first' }, 'run-1');
    const back = await readNarration<{ title: string; arc: string; openQuestion: string }>(key);
    assert.equal(back?.title, 'Bravo catches Charlie changing his story');
    assert.equal(back?.openQuestion, 'who asks first');
  } finally {
    await database()`DELETE FROM virtual_n1.town_narration WHERE key = ${key}`;
  }
});

test('re-narrating a thread replaces it rather than accumulating', { skip }, async () => {
  // The memory compaction bug in this project appended a fresh summary on every
  // pass until one note held a dozen near-identical ones and no dialogue at all.
  // A thread narrated on every beat would do the same to this table.
  const key = `test:thread:${randomUUID()}`;
  try {
    await saveNarration(key, { title: 'first' }, 'run-1');
    await saveNarration(key, { title: 'second' }, 'run-2');
    const rows = await database()`SELECT value, run_id FROM virtual_n1.town_narration WHERE key = ${key}`;
    assert.equal(rows.length, 1, 'one row per thread, however many times it is narrated');
    assert.equal((rows[0].value as { title: string }).title, 'second');
    assert.equal(rows[0].run_id, 'run-2', 'the run id follows the current text, so the line stays traceable');
  } finally {
    await database()`DELETE FROM virtual_n1.town_narration WHERE key = ${key}`;
  }
});

test('every thread narration comes back in one read', { skip }, async () => {
  // rehydrateThreads rebuilds every thread at once and must not issue a query
  // per pair to find their titles.
  const stamp = randomUUID().slice(0, 8);
  const prefix = `test:${stamp}:`;
  try {
    await saveNarration(`${prefix}a~b`, { title: 'A and B' });
    await saveNarration(`${prefix}c~d`, { title: 'C and D' });
    await saveNarration(`other:${stamp}`, { title: 'not a thread' });

    const found = await narrationsUnder<{ title: string }>(prefix);
    assert.equal(found.length, 2, 'the prefix selects threads and nothing else');
    assert.deepEqual(
      found.map((n) => n.key.slice(prefix.length)).sort(),
      ['a~b', 'c~d']
    );
  } finally {
    await database()`DELETE FROM virtual_n1.town_narration WHERE key LIKE ${`%${stamp}%`}`;
  }
});

test.after(async () => {
  if (live) await database().end();
});
