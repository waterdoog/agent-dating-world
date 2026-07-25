import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import test from 'node:test';
import {
  DEFAULT_ATTACK_POLICY,
  DEFAULT_DEFENSE_POLICY,
  addFighterDraft,
  createMiniGameState,
  type FighterMiniGameState,
} from './fighter-world-core.js';
import {
  WorldStateIntegrityError,
  openWorldState,
  sealWorldState,
} from './database/world-state.js';

const FIRST_SECRET = 'first-test-arena-secret-with-enough-entropy';
const SECOND_SECRET = 'second-test-arena-secret-with-enough-entropy';

function populatedState(): FighterMiniGameState {
  return addFighterDraft(createMiniGameState(), {
    id: 'fighter-alpha',
    handle: 'alpha',
    displayName: 'Alpha',
    joinedAt: '2026-07-25T03:00:00.000Z',
    draftId: 'draft-alpha',
    attackPolicy: DEFAULT_ATTACK_POLICY,
    defensePolicy: DEFAULT_DEFENSE_POLICY,
    secrets: [
      { id: 'signal', label: 'Signal code', value: 'amber-lantern-0427' },
      { id: 'hideout', label: 'Hideout', value: 'frosted-harbor-9001' },
      { id: 'relic', label: 'Relic', value: 'lunar-quartz-1003' },
    ],
  });
}

test('world snapshots round-trip through authenticated encryption', () => {
  const state = populatedState();
  const first = sealWorldState(state, FIRST_SECRET);
  const second = sealWorldState(state, FIRST_SECRET);
  assert.notEqual(first, second, 'each seal must use a fresh nonce');
  assert.deepEqual(openWorldState(first, FIRST_SECRET), state);
  assert.deepEqual(openWorldState(second, FIRST_SECRET), state);
});

test('sealed world snapshots contain no policy or synthetic value plaintext', () => {
  const state = populatedState();
  const sealed = sealWorldState(state, FIRST_SECRET);
  assert.doesNotMatch(sealed, /amber-lantern-0427/);
  assert.doesNotMatch(sealed, /Be charming, curious/);
  assert.doesNotMatch(sealed, /Protect every exact/);
  assert.match(sealed, /^n1ws1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('world snapshot opening fails closed on tampering or the wrong key', () => {
  const sealed = sealWorldState(populatedState(), FIRST_SECRET);
  const parts = sealed.split('.');
  const position = Math.floor(parts[2].length / 2);
  const replacement = parts[2][position] === 'A' ? 'B' : 'A';
  parts[2] =
    parts[2].slice(0, position) + replacement + parts[2].slice(position + 1);
  assert.throws(
    () => openWorldState(parts.join('.'), FIRST_SECRET),
    WorldStateIntegrityError
  );
  assert.throws(
    () => openWorldState(sealed, SECOND_SECRET),
    WorldStateIntegrityError
  );
});

test('authenticated but invalid state is rejected after decryption', () => {
  const invalid = JSON.stringify({
    ...createMiniGameState(),
    version: 999,
  });
  const salt = Buffer.from('virtual-n1-world-state-key-v1', 'utf8');
  const info = Buffer.from('fighter-mini-game-state/aes-256-gcm', 'utf8');
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(FIRST_SECRET, 'utf8'), salt, info, 32)
  );
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(
    Buffer.from('virtual-n1/fighter-mini-game-state/n1ws1', 'utf8')
  );
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(invalid, 'utf8')),
    cipher.final(),
  ]);
  const forged = [
    'n1ws1',
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
  assert.throws(
    () => openWorldState(forged, FIRST_SECRET),
    WorldStateIntegrityError
  );
});
