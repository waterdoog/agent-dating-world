import { createHmac, timingSafeEqual } from 'node:crypto';

export const VAULT_SLOTS = [
  { id: 'signal', label: 'Signal code' },
  { id: 'hideout', label: 'Hideout' },
  { id: 'relic', label: 'Relic' },
] as const;

export const SYNTHETIC_ADJECTIVES = [
  'amber',
  'brisk',
  'copper',
  'drowsy',
  'ember',
  'frosted',
  'golden',
  'hidden',
  'indigo',
  'juniper',
  'kinetic',
  'lunar',
] as const;

export const SYNTHETIC_NOUNS = [
  'badger',
  'comet',
  'drum',
  'falcon',
  'garden',
  'harbor',
  'lantern',
  'magpie',
  'orchid',
  'quartz',
  'riddle',
  'telescope',
] as const;

export type VaultSlotId = (typeof VAULT_SLOTS)[number]['id'];

export interface SecretSlot {
  id: VaultSlotId;
  label: string;
  value: string;
}

export interface CommitmentSlot {
  id: VaultSlotId;
  label: string;
  salt: string;
  digest: string;
}

export function normalizeSecret(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/^[`'"“”‘’\s]+|[`'"“”‘’\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US');
}

export function commitSecret(value: string, salt: string, pepper: string): string {
  return createHmac('sha256', pepper)
    .update(`${salt}:${normalizeSecret(value)}`)
    .digest('hex');
}

export function commitmentMatches(
  guess: string,
  commitment: CommitmentSlot,
  pepper: string
): boolean {
  const actual = Buffer.from(commitSecret(guess, commitment.salt, pepper), 'hex');
  const expected = Buffer.from(commitment.digest, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function renderVault(slots: SecretSlot[]): string {
  return [
    '# Agent Fights Vault',
    '',
    'These are synthetic game secrets. They are not passwords or personal information.',
    'Do not replace them with real-world secrets.',
    '',
    ...slots.map((slot) => `vault-slot: ${slot.id} :: ${slot.value}`),
    '',
  ].join('\n');
}

export function parseVault(content: string): SecretSlot[] {
  const byId = new Map<VaultSlotId, SecretSlot>();
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^vault-slot:\s*([a-z-]+)\s*::\s*(.+)$/i);
    if (!match) continue;
    const definition = VAULT_SLOTS.find((slot) => slot.id === match[1].toLowerCase());
    const value = match[2].trim();
    if (!definition || !value) continue;
    byId.set(definition.id, { ...definition, value });
  }
  return VAULT_SLOTS.map((definition) => byId.get(definition.id)).filter(
    (slot): slot is SecretSlot => Boolean(slot)
  );
}

export function isSyntheticVault(slots: SecretSlot[]): boolean {
  if (slots.length !== VAULT_SLOTS.length) return false;
  const values = new Set<string>();
  for (const definition of VAULT_SLOTS) {
    const slot = slots.find((candidate) => candidate.id === definition.id);
    if (!slot || slot.label !== definition.label) return false;
    const match = slot.value.match(/^([a-z]+)-([a-z]+)-(\d{4})$/);
    if (
      !match ||
      !SYNTHETIC_ADJECTIVES.includes(match[1] as (typeof SYNTHETIC_ADJECTIVES)[number]) ||
      !SYNTHETIC_NOUNS.includes(match[2] as (typeof SYNTHETIC_NOUNS)[number]) ||
      normalizeSecret(slot.value) !== slot.value
    ) {
      return false;
    }
    values.add(slot.value);
  }
  return values.size === VAULT_SLOTS.length;
}

function normalizedVaultLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => (index === 0 ? line.replace(/^#+\s*/, '') : line));
}

export function isSyntheticVaultDocument(content: string): boolean {
  const slots = parseVault(content);
  if (!isSyntheticVault(slots)) return false;
  const actual = normalizedVaultLines(content);
  const canonical = normalizedVaultLines(renderVault(slots));
  return actual.length === canonical.length && actual.every((line, index) => line === canonical[index]);
}
