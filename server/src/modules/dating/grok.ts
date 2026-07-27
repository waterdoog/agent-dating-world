/**
 * The town's single model gateway. Every agent-facing call in the 相亲小镇 goes
 * through `grok()` — target selection, decisions, conversation, memory,
 * relationship updates, story threads, feed summaries. The model is configured
 * once in config.model; nothing else may hardcode a provider or model name.
 *
 * Every run is recorded: provider, model, run id, input, output, token usage,
 * status, and any error/timeout/retry. A failed run stays failed — callers must
 * surface queued/failed/timeout/retry and never substitute invented content.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';

export type RunStatus = 'ok' | 'failed' | 'timeout' | 'retrying';

export interface ModelRun {
  id: string;
  provider: string;
  model: string;
  purpose: string;
  agent?: string;
  input: string;
  output: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  status: RunStatus;
  error?: string;
  attempts: number;
  elapsedMs: number;
  at: number;
}

export class ModelError extends Error {
  constructor(
    public status: RunStatus,
    message: string,
    public run: ModelRun
  ) {
    super(message);
  }
}

// A bounded in-memory ledger of recent runs, exposed for tracing a town event
// back to the exact model call that produced it.
const runs: ModelRun[] = [];
/** Bearers we've learned have no Grok access — they use their standard model. */
const noGrok = new Set<string>();
const MAX_RUNS = 300;
export function recentRuns(limit = 50): ModelRun[] {
  return runs.slice(0, limit);
}
export function runById(id: string): ModelRun | undefined {
  return runs.find((r) => r.id === id);
}
function record(run: ModelRun): ModelRun {
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  return run;
}

export interface GrokOptions {
  purpose: string;          // e.g. 'decide' | 'reply' | 'feed-summary'
  agent?: string;           // whose turn this is, for tracing
  system?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;           // ask for a strict JSON object back
  /** Aicoo bearer to execute this turn as — the account whose Grok access is used. */
  bearer?: string;
  /** Keep a turn in one Aicoo conversation thread. */
  conversationId?: string;
}

export interface GrokResult {
  text: string;
  run: ModelRun;
}

/** One recorded call to the town's model. Throws ModelError on failure. */
export async function grok(prompt: string, opts: GrokOptions): Promise<GrokResult> {
  const { provider, name: model, apiKey, baseUrl, timeoutMs, maxRetries } = config.model;
  const id = randomUUID();
  const started = Date.now();
  const base: Omit<ModelRun, 'status' | 'attempts' | 'elapsedMs'> = {
    id, provider, model, purpose: opts.purpose, agent: opts.agent,
    input: prompt, output: '', at: started,
  };

  const viaAicoo = Boolean(opts.bearer);
  if (!viaAicoo && !apiKey) {
    throw new ModelError('failed', 'No Grok access: pass an Aicoo bearer with Grok enabled, or set XAI_API_KEY.',
      record({ ...base, status: 'failed', error: 'no Aicoo bearer and no XAI_API_KEY', attempts: 0, elapsedMs: 0 }));
  }
  const strip = (t: string) => t.split(/\n*<suggestions?>/i)[0].trim();

  let lastError = '';
  let lastStatus: RunStatus = 'failed';
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      // Grok per the town spec, but tier-gated per account: an account without
      // Grok gets its standard model rather than a hard failure, and the run
      // records whichever model actually answered.
      const wantGrok = model && model !== 'default' && !noGrok.has(opts.bearer ?? '');
      const res = viaAicoo
        ? await fetch(`${config.aicooBaseUrl}/api/v1/chat`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${opts.bearer}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: opts.system ? `${opts.system}\n\n${prompt}` : prompt,
              // "default" means the account's standard model — Aicoo rejects it
              // as an explicit value, so omit the field and let it choose.
              ...(wantGrok ? { model } : {}),
              stream: false,
              ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          })
        : await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: [
                ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
                { role: 'user', content: prompt },
              ],
              temperature: opts.temperature ?? 0.9,
              ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
              ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
      const body = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${body.slice(0, 300)}`;
        lastStatus = res.status === 429 || res.status >= 500 ? 'retrying' : 'failed';
        if (lastStatus === 'failed' || attempt > maxRetries) break;
        continue;
      }
      const json = JSON.parse(body) as {
        // Aicoo shape
        response?: string; conversationId?: string; model?: string; deployment?: string;
        type?: string; error?: string; message?: string;
        // xAI shape
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      // Aicoo answers HTTP 200 with an error body for quota / model availability
      if (json.type === 'error' && json.error === 'MODEL_NOT_AVAILABLE' && wantGrok) {
        noGrok.add(opts.bearer ?? '');          // this account has no Grok — fall back and retry
        lastError = `${json.error}: falling back to the account's standard model`;
        lastStatus = 'retrying';
        continue;
      }
      if (json.type === 'error') {
        lastError = `${json.error ?? 'AICOO_ERROR'}: ${(json.message ?? '').slice(0, 200)}`;
        lastStatus = 'failed';
        break;
      }
      const text = strip(String(json.response ?? json.choices?.[0]?.message?.content ?? ''));
      if (!text) {
        lastError = 'model returned an empty completion';
        lastStatus = 'failed';
        if (attempt > maxRetries) break;
        continue;
      }
      return {
        text,
        run: record({
          ...base, output: text, status: 'ok', attempts: attempt,
          model: json.deployment ?? json.model ?? model,
          promptTokens: json.usage?.prompt_tokens,
          completionTokens: json.usage?.completion_tokens,
          totalTokens: json.usage?.total_tokens,
          elapsedMs: Date.now() - started,
        }),
      };
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      lastStatus = timedOut ? 'timeout' : 'retrying';
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt > maxRetries) break;
    }
  }

  const run = record({
    ...base, status: lastStatus === 'retrying' ? 'failed' : lastStatus,
    error: lastError, attempts: maxRetries + 1, elapsedMs: Date.now() - started,
  });
  throw new ModelError(run.status, `Grok call failed (${run.status}): ${lastError}`, run);
}

/** Parse a JSON object out of a model reply; throws if the shape is unusable. */
export function parseJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}
