/** penny-pacer: run many LLM tasks through OpenRouter under a hard dollar budget. */

/** Single source of truth for the default model: Meta Muse Ember on OpenRouter. */
export const MUSE_EMBER = "meta/muse-ember";

const LIST_IN = 0.1 / 1e6; // $/input token (Ember list price)
const LIST_OUT = 0.5 / 1e6; // $/output token (Ember list price)
const CHARS_PER_TOKEN = 4;

export type Reasoning = "none" | "minimal" | "low" | "medium" | "high";

export interface Tier {
  name: string;
  maxInputChars: number;
  maxOutputTokens: number;
  reasoning?: Reasoning;
}

export interface TaskSpec<T = unknown> {
  system?: string;
  prompt: string;
  json?: boolean;
  validate?: (obj: any) => boolean;
  /** dryRun only: deterministic fake output for this task. */
  fake?: () => T;
}

export interface RunnerOptions<I = any> {
  apiKey?: string;
  model?: string;
  budgetUsd?: number;
  concurrency?: number;
  onBudget?: "degrade" | "skip";
  tiers?: Tier[];
  priority?: (item: I, index: number) => number;
  dryRun?: boolean;
  referer?: string;
  appTitle?: string;
  baseUrl?: string;
}

export type Status = "ok" | "skipped:budget" | "error";

export interface Result<T = any> {
  status: Status;
  tier: string | null;
  cost: number;
  latencyMs: number;
  data: T | null;
  raw: string | null;
  error?: string;
}

export interface Report {
  spent: number;
  budget: number;
  calls: number;
  skipped: number;
  errors: number;
  avgCost: number;
  avgLatencyMs: number;
  validJsonRate: number;
  tierCounts: Record<string, number>;
  coverage: number;
  tasksPerDollar: number;
}

export interface ResultEvent<I = any> {
  index: number;
  item: I;
  result: Result;
}

export const DEFAULT_TIERS: Tier[] = [
  { name: "full", maxInputChars: 8000, maxOutputTokens: 300, reasoning: "medium" },
  { name: "lite", maxInputChars: 2000, maxOutputTokens: 100, reasoning: "low" },
];

const toks = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** Strip code fences and parse JSON; returns undefined if unparseable. */
export function safeParseJson(text: string): unknown | undefined {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* fallthrough */
      }
    }
    return undefined;
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function createRunner<I = any>(opts: RunnerOptions<I> = {}) {
  const cfg = {
    model: MUSE_EMBER,
    budgetUsd: 1,
    concurrency: 8,
    onBudget: "degrade" as "degrade" | "skip",
    tiers: DEFAULT_TIERS,
    priority: (() => 0) as (item: I, index: number) => number,
    dryRun: false,
    referer: "https://github.com/penny-pacer/penny-pacer",
    appTitle: "penny-pacer",
    baseUrl: "https://openrouter.ai/api/v1",
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
  } as Required<Omit<RunnerOptions<I>, "apiKey">> & { apiKey?: string };

  if (!cfg.dryRun && !cfg.apiKey) throw new Error("penny-pacer: apiKey is required unless dryRun is true");
  if (!cfg.tiers.length) throw new Error("penny-pacer: at least one tier is required");

  // ---- state ----
  let spent = 0;
  let reserved = 0; // worst-case cost of in-flight calls
  let inflight = 0;
  let total = 0;
  let okCount = 0;
  let calls = 0;
  let errors = 0;
  let skipped = 0;
  let latencySum = 0;
  let jsonTotal = 0;
  let jsonValid = 0;
  const tierCounts: Record<string, number> = { skipped: 0 };
  for (const t of cfg.tiers) tierCounts[t.name] = 0;
  const tierStats: Record<string, { n: number; sum: number }> = {};
  for (const t of cfg.tiers) tierStats[t.name] = { n: 0, sum: 0 };
  const listeners: Record<string, Array<(p: any) => void>> = {};
  let waiters: Array<() => void> = [];

  const emit = (ev: string, payload: unknown) => {
    for (const fn of listeners[ev] ?? []) {
      try {
        fn(payload);
      } catch {
        /* listener errors never break the batch */
      }
    }
  };

  const report = (): Report => ({
    spent,
    budget: cfg.budgetUsd,
    calls,
    skipped,
    errors,
    avgCost: okCount + errors > 0 && calls > 0 ? spent / calls : 0,
    avgLatencyMs: calls > 0 ? latencySum / calls : 0,
    validJsonRate: jsonTotal > 0 ? jsonValid / jsonTotal : 1,
    tierCounts: { ...tierCounts },
    coverage: total > 0 ? (okCount / total) * 100 : 0,
    tasksPerDollar: spent > 0 ? okCount / spent : 0,
  });

  // ---- cost estimation ----
  const effInChars = (spec: TaskSpec, tier: Tier) =>
    (spec.system?.length ?? 0) + Math.min(spec.prompt.length, tier.maxInputChars);
  /** Worst case: full input + every output token used. Used for the HARD cap. */
  const ceiling = (spec: TaskSpec, tier: Tier) =>
    toks(effInChars(spec, tier)) * LIST_IN + tier.maxOutputTokens * LIST_OUT;
  /** Pacing estimate: running average per tier, list prices until real data exists. */
  const estimate = (spec: TaskSpec, tier: Tier) => {
    const s = tierStats[tier.name];
    return s.n > 0 ? s.sum / s.n : ceiling(spec, tier);
  };

  // ---- one call ----
  async function execute(spec: TaskSpec, tier: Tier): Promise<{ raw: string; cost: number }> {
    const prompt = spec.prompt.slice(0, tier.maxInputChars);
    if (cfg.dryRun) {
      const h = hash(prompt + (spec.system ?? "") + tier.name);
      await new Promise((r) => setTimeout(r, 10 + (h % 30)));
      const outTok = Math.floor(tier.maxOutputTokens * (0.4 + (h % 50) / 100));
      const cost = toks(effInChars(spec, tier)) * LIST_IN + outTok * LIST_OUT;
      const fake = spec.fake ? spec.fake() : spec.json ? { dryRun: true, n: h % 1000 } : "dry-run output";
      return { raw: typeof fake === "string" ? fake : JSON.stringify(fake), cost };
    }
    const messages: Array<{ role: string; content: string }> = [];
    if (spec.system) messages.push({ role: "system", content: spec.system });
    messages.push({ role: "user", content: prompt });
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages,
      temperature: 0,
      max_tokens: tier.maxOutputTokens,
      usage: { include: true },
    };
    if (tier.reasoning) body.reasoning = { effort: tier.reasoning };
    if (spec.json) body.response_format = { type: "json_object" };

    const doFetch = () =>
      fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": cfg.referer,
          "X-Title": cfg.appTitle,
        },
        body: JSON.stringify(body),
      });
    let res: Response;
    try {
      res = await doFetch();
    } catch {
      res = await doFetch(); // single retry, network errors only
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    }
    const u = json.usage ?? {};
    const cost =
      typeof u.cost === "number"
        ? u.cost
        : (u.prompt_tokens ?? 0) * LIST_IN + (u.completion_tokens ?? 0) * LIST_OUT;
    return { raw: String(json.choices?.[0]?.message?.content ?? ""), cost };
  }

  async function runOne(spec: TaskSpec, tier: Tier, hold: number): Promise<Result> {
    const t0 = performance.now();
    try {
      const { raw, cost } = await execute(spec, tier);
      const latencyMs = performance.now() - t0;
      spent += cost;
      calls++;
      latencySum += latencyMs;
      tierStats[tier.name].n++;
      tierStats[tier.name].sum += cost;
      tierCounts[tier.name]++;
      if (!spec.json) {
        okCount++;
        return { status: "ok", tier: tier.name, cost, latencyMs, data: raw, raw };
      }
      jsonTotal++;
      const parsed = safeParseJson(raw);
      let valid = parsed !== undefined;
      if (valid && spec.validate) {
        try {
          valid = !!spec.validate(parsed);
        } catch {
          valid = false;
        }
      }
      if (valid) {
        jsonValid++;
        okCount++;
        return { status: "ok", tier: tier.name, cost, latencyMs, data: parsed, raw };
      }
      errors++;
      return { status: "error", tier: tier.name, cost, latencyMs, data: null, raw, error: "invalid_json" };
    } catch (e: any) {
      errors++;
      tierCounts[tier.name]++;
      return {
        status: "error",
        tier: tier.name,
        cost: 0,
        latencyMs: performance.now() - t0,
        data: null,
        raw: null,
        error: String(e?.message ?? e),
      };
    } finally {
      reserved -= hold;
      inflight--;
      const w = waiters;
      waiters = [];
      w.forEach((fn) => fn());
    }
  }

  // ---- public API ----
  async function map<T = any>(items: I[], build: (item: I, index: number) => TaskSpec<T>): Promise<Result<T>[]> {
    const results: Result<T>[] = new Array(items.length);
    total += items.length;
    const queue = items
      .map((item, i) => ({ item, i, p: cfg.priority(item, i), spec: build(item, i) }))
      .sort((a, b) => b.p - a.p || a.i - b.i); // most important first; lowest priority is skipped first
    let head = 0;

    const finish = (e: (typeof queue)[number], r: Result<T>) => {
      results[e.i] = r;
      emit("result", { index: e.i, item: e.item, result: r } satisfies ResultEvent<I>);
      emit("cost", report());
    };
    const skipRest = () => {
      while (head < queue.length) {
        const e = queue[head++];
        skipped++;
        tierCounts.skipped++;
        finish(e, { status: "skipped:budget", tier: null, cost: 0, latencyMs: 0, data: null, raw: null });
      }
    };

    const worker = async () => {
      while (head < queue.length) {
        const e = queue[head];
        const available = cfg.budgetUsd - spent - reserved;
        const remaining = queue.length - head;
        let chosen: Tier | undefined;
        if (cfg.onBudget === "skip") {
          const t0 = cfg.tiers[0];
          if (ceiling(e.spec, t0) <= available) chosen = t0;
        } else {
          const allowance = available / remaining;
          // highest tier whose estimate fits the per-task allowance (and the hard cap)
          chosen = cfg.tiers.find(
            (t) => estimate(e.spec, t) <= allowance && ceiling(e.spec, t) <= available,
          );
          // none fits the allowance: serve the most important task at the cheapest
          // tier that is still safe; the lowest-priority tail starves and is skipped
          if (!chosen) {
            for (let k = cfg.tiers.length - 1; k >= 0; k--) {
              const t = cfg.tiers[k];
              if (estimate(e.spec, t) <= available && ceiling(e.spec, t) <= available) {
                chosen = t;
                break;
              }
            }
          }
        }
        if (!chosen) {
          if (inflight > 0) {
            // in-flight calls reserve worst-case cost; wait, their real cost may free budget
            await new Promise<void>((r) => waiters.push(r));
            continue;
          }
          skipRest();
          return;
        }
        head++;
        const hold = ceiling(e.spec, chosen);
        reserved += hold;
        inflight++;
        const r = await runOne(e.spec, chosen, hold);
        finish(e, r as Result<T>);
      }
    };

    const n = Math.max(1, Math.min(cfg.concurrency, queue.length));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
  }

  return {
    map,
    report,
    on(event: "cost" | "result", fn: (payload: any) => void) {
      (listeners[event] ??= []).push(fn);
      return () => {
        listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn);
      };
    },
  };
}
