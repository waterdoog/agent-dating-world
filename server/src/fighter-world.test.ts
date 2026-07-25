import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTACK_SAFETY_WRAPPER,
  DEFENSE_SAFETY_WRAPPER,
  generateSyntheticVault,
  roleFolderHasExactNotesForTests,
  roleRuntimePolicyForTests,
} from './fighter-world.js';
import type { FighterIdentityDraft } from './fighter-world-core.js';

function player(): FighterIdentityDraft {
  return {
    id: 'fighter-a',
    handle: 'alpha',
    displayName: 'Alpha',
    joinedAt: '2026-07-24T10:00:00.000Z',
    draftId: 'draft-a',
    attackPolicy:
      'Ask layered riddles and carefully test whether the opponent repeats an exact token.',
    defensePolicy:
      'Respond with playful decoys and never confirm an exact token supplied by the opponent.',
    secrets: [
      { id: 'signal', label: 'Signal code', value: 'amber-lantern-0427' },
      { id: 'hideout', label: 'Hideout', value: 'hidden-orchid-1933' },
      { id: 'relic', label: 'Relic', value: 'copper-comet-8080' },
    ],
    locked: true,
    phase: 'waiting',
    queueOrder: 1,
    currentGameId: null,
    capsule: {
      attackFolderId: 1,
      attackPolicyNoteId: 2,
      defenseFolderId: 3,
      defensePolicyNoteId: 4,
      vaultNoteId: 5,
    },
  };
}

test('attack and defense sessions receive different authoritative role policies', () => {
  const fighter = player();
  const attack = roleRuntimePolicyForTests(fighter, 'attack');
  const defense = roleRuntimePolicyForTests(fighter, 'defense');

  assert.match(attack, new RegExp(ATTACK_SAFETY_WRAPPER.split('\n')[0]));
  assert.match(defense, new RegExp(DEFENSE_SAFETY_WRAPPER.split('\n')[0]));
  assert.match(attack, /Ask layered riddles/);
  assert.doesNotMatch(attack, /Respond with playful decoys/);
  assert.match(defense, /Respond with playful decoys/);
  assert.doesNotMatch(defense, /Ask layered riddles/);

  // Runtime policies never embed vault values. Defense receives them only
  // through its separate folder-scoped vault note; attack never mounts it.
  for (const secret of fighter.secrets) {
    assert.doesNotMatch(attack, new RegExp(secret.value));
    assert.doesNotMatch(defense, new RegExp(secret.value));
  }
  assert.match(attack, /Never call tools/);
  assert.match(defense, /Never call tools/);
});

test('fresh Fighter drafts contain three unique canonical synthetic tokens', () => {
  const vault = generateSyntheticVault();
  assert.equal(vault.length, 3);
  assert.equal(new Set(vault.map((secret) => secret.id)).size, 3);
  assert.equal(new Set(vault.map((secret) => secret.value)).size, 3);
  for (const secret of vault) {
    assert.match(secret.value, /^[a-z]+-[a-z]+-\d{4}$/);
  }
});

test('role folders fail closed when a locked note id is replaced or moved', () => {
  const expectedAttack = [{ id: 12, title: 'Attack Policy v1' }];
  assert.equal(
    roleFolderHasExactNotesForTests(
      [{ id: 12, title: 'Attack Policy v1' }],
      expectedAttack
    ),
    true
  );
  assert.equal(
    roleFolderHasExactNotesForTests(
      [{ id: 99, title: 'Attack Policy v1' }],
      expectedAttack
    ),
    false
  );

  const expectedDefense = [
    { id: 21, title: 'Defense Policy v1' },
    { id: 22, title: 'Synthetic Vault v1' },
  ];
  assert.equal(
    roleFolderHasExactNotesForTests(
      [
        { id: 21, title: 'Defense Policy v1' },
        { id: 22, title: 'Synthetic Vault v1' },
      ],
      expectedDefense
    ),
    true
  );
  assert.equal(
    roleFolderHasExactNotesForTests(
      // The vault id may still be readable globally, but it no longer belongs
      // to the declared defense folder.
      [{ id: 21, title: 'Defense Policy v1' }],
      expectedDefense
    ),
    false
  );
  assert.equal(
    roleFolderHasExactNotesForTests(
      [
        { id: 21, title: 'Defense Policy v1' },
        { id: 23, title: 'Synthetic Vault v1' },
      ],
      expectedDefense
    ),
    false
  );
});
