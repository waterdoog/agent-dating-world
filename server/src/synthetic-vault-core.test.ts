import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitmentMatches,
  commitSecret,
  isSyntheticVault,
  isSyntheticVaultDocument,
  normalizeSecret,
  parseVault,
  renderVault,
  type SecretSlot,
} from './synthetic-vault-core.js';

const secrets: SecretSlot[] = [
  { id: 'signal', label: 'Signal code', value: 'Amber-Lantern-0427' },
  { id: 'hideout', label: 'Hideout', value: 'hidden-orchid-1933' },
  { id: 'relic', label: 'Relic', value: 'copper-comet-8080' },
];

test('vault format round-trips all three synthetic slots', () => {
  assert.deepEqual(parseVault(renderVault(secrets)), secrets);
  assert.equal(isSyntheticVault(parseVault(renderVault(secrets))), false);
  const generatedShape: SecretSlot[] = [
    { id: 'signal', label: 'Signal code', value: 'amber-lantern-0427' },
    { id: 'hideout', label: 'Hideout', value: 'hidden-orchid-1933' },
    { id: 'relic', label: 'Relic', value: 'copper-comet-8080' },
  ];
  assert.equal(isSyntheticVault(generatedShape), true);
  const canonicalDocument = renderVault(generatedShape);
  assert.equal(isSyntheticVaultDocument(canonicalDocument), true);
  assert.equal(isSyntheticVaultDocument(`${canonicalDocument}\nPersonal secret: hunter2`), false);
  assert.equal(
    isSyntheticVault([
      ...generatedShape.slice(0, 2),
      { id: 'relic', label: 'Relic', value: 'my-real-password' },
    ]),
    false
  );
});

test('vault parsing accepts Aicoo-collapsed Markdown paragraphs', () => {
  const generatedShape: SecretSlot[] = [
    { id: 'signal', label: 'Signal code', value: 'amber-lantern-0427' },
    { id: 'hideout', label: 'Hideout', value: 'hidden-orchid-1933' },
    { id: 'relic', label: 'Relic', value: 'copper-comet-8080' },
  ];
  const collapsed = [
    '# Agent Fights Vault',
    'These are synthetic game secrets. They are not passwords or personal information.',
    'Do not replace them with real-world secrets.',
    generatedShape
      .map((slot) => `vault-slot: ${slot.id} :: ${slot.value}`)
      .join(' '),
  ].join('\n');

  assert.deepEqual(parseVault(collapsed), generatedShape);
  assert.equal(isSyntheticVaultDocument(collapsed), true);
});

test('secret normalization accepts harmless casing and surrounding quotes only', () => {
  assert.equal(normalizeSecret('  “Amber-Lantern-0427”  '), 'amber-lantern-0427');
  assert.equal(normalizeSecret('  `Amber-Lantern-0427`  '), 'amber-lantern-0427');
  assert.notEqual(normalizeSecret('amber lantern 0427'), 'amber-lantern-0427');
});

test('commitments verify deterministically without storing plaintext', () => {
  const salt = 'fixed-salt';
  const digest = commitSecret('Amber-Lantern-0427', salt, 'pepper');
  const commitment = { id: 'signal' as const, label: 'Signal code', salt, digest };
  assert.equal(commitmentMatches(' amber-lantern-0427 ', commitment, 'pepper'), true);
  assert.equal(commitmentMatches('amber-lantern-0428', commitment, 'pepper'), false);
  assert.equal(digest.includes('amber'), false);
});
