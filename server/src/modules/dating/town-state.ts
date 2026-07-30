/**
 * Durable town state — wanted levels and purses.
 *
 * These lived in module-level Maps, so every process restart wiped them. In
 * development `tsx watch` restarts on each edit, which meant a wanted level
 * effectively never survived more than a few minutes and the whole "crime has a
 * price" idea was decorative. Anything built on top (reputation, the economy,
 * bounties) would have been built on sand.
 *
 * Two rules shape the design:
 *
 *  1. **Memory is authoritative at runtime.** Reads never await the network, so
 *     a slow or broken Aicoo cannot stall a turn.
 *  2. **Persistence is best-effort and never throws.** Shared state must not sit
 *     on the operator account's critical path — an operator 402 once froze the
 *     entire feed. If a flush fails the town keeps running on its in-memory
 *     values and says so in the log; it degrades to the old behaviour instead of
 *     taking the world down.
 */
import { ensureFolder, findNoteInFolder, getNote, upsertNote } from '../../aicoo.js';
import { config } from '../../config.js';
import { townDbReady, loadAgent, wantedRows } from './town-repository.js';

const DIR = 'Agent Dating/_town';
const NOTE = 'town-state.json';
const FLUSH_DEBOUNCE_MS = 15_000;

export interface WantedRecord { level: number; reasons: string[]; at: number }
export interface TownState {
  wanted: Record<string, WantedRecord>;
  purse: Record<string, number>;
  /** Calendar day the daily content was last rolled for (see budget.ts::today). */
  day?: string;
}

const state: TownState = { wanted: {}, purse: {} };
let loaded = false;
let dirty = false;
let timer: NodeJS.Timeout | null = null;
let lastError = '';

export const townState = (): TownState => state;
export const townStateHealth = () => ({ loaded, dirty, lastError, wanted: Object.keys(state.wanted).length, purses: Object.keys(state.purse).length });

/**
 * Pull the saved state in once at boot. A failure here is not fatal: the town
 * simply starts from a clean slate, which is exactly what it did before.
 */
export async function loadTownState(): Promise<void> {
  if (loaded) return;
  // Postgres is the real home for this. The Aicoo-note path below is only the
  // fallback for a checkout with no database configured.
  if (townDbReady()) {
    try {
      for (const row of await wantedRows()) {
        state.wanted[row.agent] = { level: row.wantedLevel, reasons: row.wantedReasons, at: row.wantedAt ?? Date.now() };
      }
      loaded = true;
      console.log(`[town] state loaded from Postgres · ${Object.keys(state.wanted).length} wanted`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn('[town] Postgres unavailable, falling back to notes —', lastError);
    }
  }
  if (loaded || !config.operatorApiKey) { loaded = true; return; }
  try {
    const folderId = await ensureFolder(config.operatorApiKey, DIR);
    const note = await findNoteInFolder(config.operatorApiKey, folderId, NOTE);
    if (note) {
      const raw = await getNote(config.operatorApiKey, note.id);
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const saved = JSON.parse(m[0]) as Partial<TownState>;
        Object.assign(state.wanted, saved.wanted ?? {});
        Object.assign(state.purse, saved.purse ?? {});
        state.day = saved.day;
      }
    }
    console.log(`[town] state loaded · ${Object.keys(state.wanted).length} wanted · ${Object.keys(state.purse).length} purses`);
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.warn('[town] could not load saved state, starting fresh —', lastError);
  } finally {
    loaded = true;
  }
}

/** Mark the state changed; the write happens later, off the request path. */
export function markTownDirty(): void {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushTownState(); }, FLUSH_DEBOUNCE_MS);
  timer.unref?.();
}

/** Best-effort write-behind. Never throws — a failed flush keeps the memory copy. */
export async function flushTownState(): Promise<void> {
  if (!dirty || !config.operatorApiKey) return;
  dirty = false;
  try {
    await upsertNote(config.operatorApiKey, DIR, NOTE, JSON.stringify(state, null, 2));
    lastError = '';
  } catch (error) {
    dirty = true;                 // try again on the next change
    lastError = error instanceof Error ? error.message : String(error);
    console.warn('[town] state flush failed, keeping in-memory copy —', lastError);
  }
}
