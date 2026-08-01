/**
 * The two guarantees the town's correctness now rests on, tested the only way
 * they can be: concurrently, against a real Postgres.
 *
 * A single-process test would pass against the code these replaced. The bug was
 * never visible from inside one process — thirty-one of them each held a private
 * ledger, each saw 0 turns used, and each said yes. So these tests fire genuinely
 * concurrent callers at one row and assert on what the database allowed through.
 *
 * Skipped when no database is configured, in keeping with the rest of the town:
 * a local checkout without Postgres is a single process by definition.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { database, isDatabaseConfigured } from './database/client.js';
import { claimTurn, completeTurn } from './modules/dating/turn-lock.js';
import { reserveTurn } from './modules/dating/budget.js';

const live = isDatabaseConfigured();
const skip = live ? undefined : 'no database configured';

test('only one caller can claim a turn, however many race for it', { skip }, async () => {
  const operationId = `test:${randomUUID()}`;
  try {
    const winners = (await Promise.all(
      Array.from({ length: 24 }, () => claimTurn(operationId, 'RaceTest'))
    )).filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one process may take a turn');
  } finally {
    await database()`DELETE FROM virtual_n1.town_turns WHERE operation_id = ${operationId}`;
  }
});

test('a completed turn is never reclaimed', { skip }, async () => {
  const operationId = `test:${randomUUID()}`;
  try {
    assert.equal(await claimTurn(operationId, 'DoneTest'), true);
    await completeTurn(operationId);
    // Expire the lease: without the `status <> 'done'` guard this is exactly the
    // moment a second process would pick the turn back up and replay it.
    await database()`
      UPDATE virtual_n1.town_turns SET lease_expires_at = now() - interval '1 hour'
       WHERE operation_id = ${operationId}
    `;
    assert.equal(await claimTurn(operationId, 'DoneTest'), false);
  } finally {
    await database()`DELETE FROM virtual_n1.town_turns WHERE operation_id = ${operationId}`;
  }
});

test('concurrent reservations cannot exceed the daily budget', { skip }, async () => {
  const agent = `BudgetTest-${randomUUID().slice(0, 8)}`;
  const cap = config.dailyTurnBudget;
  try {
    const granted = (await Promise.all(
      Array.from({ length: cap + 25 }, () => reserveTurn(agent, 'Someone'))
    )).filter(Boolean);
    assert.equal(granted.length, cap, `exactly ${cap} turns may be granted in a day`);

    const [row] = await database()`
      SELECT turns FROM virtual_n1.town_budget
       WHERE day = CURRENT_DATE AND agent = ${agent} AND target = ''
    `;
    assert.equal(Number(row?.turns), cap, 'the recorded total matches what was granted');
  } finally {
    await database()`DELETE FROM virtual_n1.town_budget WHERE agent = ${agent}`;
  }
});

test.after(async () => {
  if (live) await database().end();
});
