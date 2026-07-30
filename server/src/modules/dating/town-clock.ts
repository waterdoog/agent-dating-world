/**
 * The town's time of day.
 *
 * Beats used to be instantaneous and placeless in time: "酒馆后门九点" and the
 * arrival happened in the same millisecond, so "你没来" could only ever be
 * something an agent made up. There was no way to be early, late, or absent.
 *
 * A town day is deliberately short — sixteen real minutes, four shifts of four —
 * because that is the rotation the NPCs already run on (`town-life.ts::npcNow`).
 * Aligning to it means the florist is at the market in the morning and the
 * bartender is closing up at night from the agents' point of view too, instead
 * of each system keeping private time.
 */

export type Shift = 'morning' | 'afternoon' | 'evening' | 'night';

const SHIFT_MS = 4 * 60_000;          // one shift — matches npcNow()
const DAY_MS = SHIFT_MS * 4;
/** Same epoch the world year counts from, so day 1 is the day the town opened. */
const EPOCH = Date.UTC(2026, 6, 23);

const ORDER: Shift[] = ['morning', 'afternoon', 'evening', 'night'];

const LABEL: Record<Shift, string> = {
  morning: '早上',
  afternoon: '下午',
  evening: '傍晚',
  night: '深夜',
};

/** What time it is in town, and how far through that stretch we are. */
export function townNow(at = Date.now()): { shift: Shift; label: string; day: number; intoShift: number } {
  const index = Math.floor(at / SHIFT_MS) % ORDER.length;
  return {
    shift: ORDER[index],
    label: LABEL[ORDER[index]],
    day: Math.max(1, Math.floor((at - EPOCH) / DAY_MS) + 1),
    intoShift: (at % SHIFT_MS) / SHIFT_MS,
  };
}

/**
 * Whether a promised meeting has come and gone.
 *
 * An agent that says "傍晚在酒馆后巷" is making a claim that can now be checked:
 * if the evening passed and the other party never showed up there, "你没来" is a
 * fact rather than a line. The engine records the promise; this says when it is
 * due and when it has expired.
 */
export function shiftsSince(then: number, now = Date.now()): number {
  return Math.floor((now - then) / SHIFT_MS);
}

export const shiftLabel = (s: Shift): string => LABEL[s];

/** The town's own sense of what each stretch of the day is for. */
export const SHIFT_MOOD: Record<Shift, string> = {
  morning: '摊子刚支起来，街上是干活的人',
  afternoon: '人最多的时候，广场和商业街都有人看着',
  evening: '收摊、下工，大家开始往酒馆那边走',
  night: '只剩酒馆还亮着，后巷和钟楼背面没人看得见',
};
