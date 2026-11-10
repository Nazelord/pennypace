import { describe, it, expect, vi, afterEach } from "vitest";
import { createRunner, safeParseJson } from "./index";

const tiers = [
  { name: "full", maxInputChars: 8000, maxOutputTokens: 300, reasoning: "medium" as const },
  { name: "lite", maxInputChars: 2000, maxOutputTokens: 100, reasoning: "low" as const },
];

/** Mock OpenRouter: cost = list price of prompt + max_tokens (a full-use call). */
function mockFetch(opts: { content?: (n: number) => string; delay?: number; cost?: (body: any) => number } = {}) {
  let n = 0;
  let inflight = 0;
  const stats = { max: 0, calls: 0 };
  const fn = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    stats.calls++;
    inflight++;
    stats.max = Math.max(stats.max, inflight);
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    inflight--;
    const chars = body.messages.reduce((a: number, m: any) => a + m.content.length, 0);
    const cost = opts.cost ? opts.cost(body) : Math.ceil(chars / 4) * 1e-7 + body.max_tokens * 5e-7;
    const content = opts.content ? opts.content(n++) : '{"ok":true}';
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage: { cost } }) };
  });
  vi.stubGlobal("fetch", fn);
  return { fn, stats };
}

afterEach(() => vi.unstubAllGlobals());

const items = (n: number) => Array.from({ length: n }, (_, i) => i);
const spec = (i: number) => ({ prompt: "p".repeat(400) + i, json: true });

describe("penny-pacer", () => {
  it("never exceeds the budget", async () => {
    mockFetch();
    const run = createRunner({ apiKey: "k", budgetUsd: 0.001, tiers, concurrency: 8 });
    const res = await run.map(items(200), spec);
    const r = run.report();
    expect(r.spent).toBeLessThanOrEqual(0.001);
    expect(res.reduce((a, x) => a + x.cost, 0)).toBeLessThanOrEqual(0.001);
    expect(r.skipped).toBeGreaterThan(0);
  });

  it("downgrades full->lite under a tight budget and keeps coverage > 0", async () => {
    mockFetch();
    const run = createRunner({ apiKey: "k", budgetUsd: 0.003, tiers, concurrency: 2 });
    await run.map(items(30), spec);
    const r = run.report();
    expect(r.tierCounts.lite).toBeGreaterThan(0);
    expect(r.coverage).toBeGreaterThan(0);
    expect(r.spent).toBeLessThanOrEqual(0.003);
  });

  it("uses full for everything with a huge budget", async () => {
    mockFetch();
    const run = createRunner({ apiKey: "k", budgetUsd: 100, tiers });
    const res = await run.map(items(20), spec);
    expect(res.every((x) => x.status === "ok" && x.tier === "full")).toBe(true);
    expect(run.report().coverage).toBe(100);
  });

  it("keeps high-priority tasks when skipping", async () => {
    mockFetch();
    const one = [{ name: "only", maxInputChars: 100, maxOutputTokens: 200 }];
    const run = createRunner({
      apiKey: "k",
      budgetUsd: 5.5e-4,
      tiers: one,
      priority: (i: number) => i,
      concurrency: 4,
    });
    const res = await run.map(items(20), () => ({ prompt: "x" }));
    const ok = res.map((r, i) => (r.status === "ok" ? i : -1)).filter((i) => i >= 0);
    const sk = res.map((r, i) => (r.status === "skipped:budget" ? i : -1)).filter((i) => i >= 0);
    expect(ok.length).toBeGreaterThan(0);
    expect(sk.length).toBeGreaterThan(0);
    expect(Math.min(...ok)).toBeGreaterThan(Math.max(...sk));
    expect(run.report().spent).toBeLessThanOrEqual(5.5e-4);
  });

  it('onBudget:"skip" stops without degrading', async () => {
    mockFetch();
    const run = createRunner({ apiKey: "k", budgetUsd: 0.001, tiers, onBudget: "skip", concurrency: 2 });
    const res = await run.map(items(20), spec);
    const r = run.report();
    expect(r.tierCounts.lite).toBe(0);
    expect(res.filter((x) => x.status === "ok").every((x) => x.tier === "full")).toBe(true);
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.spent).toBeLessThanOrEqual(0.001);
  });

  it("respects the concurrency limit", async () => {
    const { stats } = mockFetch({ delay: 15 });
    const run = createRunner({ apiKey: "k", budgetUsd: 100, tiers, concurrency: 3 });
    await run.map(items(15), spec);
    expect(stats.max).toBeLessThanOrEqual(3);
    expect(stats.max).toBeGreaterThan(1);
  });

  it("counts invalid JSON and failed validation", async () => {
    mockFetch({ content: (n) => (n % 4 === 0 ? "not json" : n % 4 === 1 ? '{"v":0}' : '```json\n{"v":1}\n```') });
    const run = createRunner({ apiKey: "k", budgetUsd: 100, tiers, concurrency: 1 });
    const res = await run.map(items(8), (i) => ({ prompt: "q" + i, json: true, validate: (o: any) => o.v === 1 }));
    const r = run.report();
    expect(r.validJsonRate).toBeCloseTo(0.5);
    expect(res.filter((x) => x.error === "invalid_json").length).toBe(4);
    expect(r.errors).toBe(4);
  });

  it("dryRun makes zero fetch calls", async () => {
    const fn = vi.fn();
    vi.stubGlobal("fetch", fn);
    const run = createRunner({ dryRun: true, budgetUsd: 0.01, tiers });
    const res = await run.map(items(20), spec);
    expect(fn).not.toHaveBeenCalled();
    expect(res.some((x) => x.status === "ok")).toBe(true);
    expect(run.report().spent).toBeLessThanOrEqual(0.01);
  });

  it("report math is correct", async () => {
    mockFetch({ cost: () => 0.001 });
    const run = createRunner({ apiKey: "k", budgetUsd: 1, tiers });
    await run.map(items(4), (i) => ({ prompt: "a" + i }));
    const r = run.report();
    expect(r.spent).toBeCloseTo(0.004);
    expect(r.calls).toBe(4);
    expect(r.avgCost).toBeCloseTo(0.001);
    expect(r.coverage).toBe(100);
    expect(r.tasksPerDollar).toBeCloseTo(1000);
    expect(r.tierCounts.full + r.tierCounts.lite).toBe(4);
  });

  it("parses fenced JSON", () => {
    expect(safeParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(safeParseJson("nope")).toBeUndefined();
  });
});
