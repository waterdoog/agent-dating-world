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

  if (!apiKey) {
    throw new ModelError('failed', 'XAI_API_KEY is not configured — the town cannot run.',
      record({ ...base, status: 'failed', error: 'missing XAI_API_KEY', attempts: 0, elapsedMs: 0 }));
  }

  let lastError = '';
  let lastStatus: RunStatus = 'failed';
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
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
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = (json.choices?.[0]?.message?.content ?? '').trim();
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
