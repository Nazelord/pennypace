<p align="center">
  <img src="./assets/logo.svg" alt="pennypace" width="460">
</p>

<p align="center">
  <b>Agents die when the money runs out. This one adapts.</b><br>
  Run many LLM tasks under a hard dollar budget. When money gets tight, pennypace paces it and degrades gracefully instead of crashing.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pennypace"><img alt="npm version" src="https://img.shields.io/npm/v/pennypace?color=4C8DFF&label=npm"></a>
  <a href="https://www.npmjs.com/package/pennypace"><img alt="npm downloads" src="https://img.shields.io/npm/dm/pennypace?color=7CF7C4"></a>
  <a href="https://github.com/YOUR_GITHUB_USER/pennypace/actions/workflows/test.yml"><img alt="CI" src="https://github.com/YOUR_GITHUB_USER/pennypace/actions/workflows/test.yml/badge.svg"></a>
  <img alt="dependencies: 0" src="https://img.shields.io/badge/dependencies-0-brightgreen">
  <a href="https://bundlephobia.com/package/pennypace"><img alt="minzipped size" src="https://img.shields.io/bundlephobia/minzip/pennypace?label=size"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178C6?logo=typescript&logoColor=white">
  <a href="./LICENSE"><img alt="license: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="./CONTRIBUTING.md"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen"></a>
  <img alt="Built on Meta Muse Ember" src="https://img.shields.io/badge/built%20on-Meta%20Muse%20Ember-0866FF">
</p>

---

## Why

You have 1,000 tasks for an LLM and $1. Normally you find out what it cost *after* it cost it, or the job crashes halfway and the last 600 tasks never run.

Think of a taxi meter with a budget: you say "I have $5 to get there", and if the ride gets expensive, the driver takes a shorter route instead of leaving you on the road.

pennypace does that for LLM calls:

- **Hard cap:** never spends more than your budget.
- **Pacing:** splits the remaining budget across the remaining tasks.
- **Graceful degradation:** drops from `full` to `lite` to `skipped`, lowest priority first, instead of failing.
- **Real costs:** reads `usage.cost` from OpenRouter, not estimates.
- **Zero dependencies.** Plain `fetch`. Works in Node 18+, Cloudflare Workers, Deno and Bun.

## Install

```bash
npm i pennypace
```

## Quickstart

```ts
import { createRunner } from "pennypace";

const run = createRunner({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: "meta/muse-ember", // optional: this is the default
  budgetUsd: 1,
});

const results = await run.map(documents, (doc) => ({
  prompt: `Summarize in one sentence: ${doc}`,
}));

console.log(run.report());
// { spent: 0.04, coverage: 100, tasksPerDollar: 2500, ... }
```

## How pacing works

Before every task, pennypace computes what that task can afford:

```
allowance = remainingBudget / remainingTasks
```

It picks the best tier whose estimated cost fits the allowance. If nothing fits, the lowest-priority tasks are skipped first.

| Budget situation | What happens | Result badge |
| --- | --- | --- |
| Plenty of money | Full input, normal reasoning | `FULL` |
| Getting tight | Shorter input, low reasoning effort, short output | `LITE` |
| Not enough even for lite | Lowest-priority tasks are skipped | `SKIPPED` |

Why degrade instead of just stopping? Because **coverage beats depth**. A light answer on all 100 tasks is more useful than 40 full answers and 60 untouched ones, and you can't know in advance which tasks matter. If you do prefer a hard stop, use `onBudget: "skip"`.

## Examples

### 1. Batch with live cost

```ts
run.on("cost", ({ spent, calls, avgCost, tasksPerDollar }) => {
  process.stdout.write(
    `\r$${spent.toFixed(4)} | ${calls} calls | $${avgCost.toFixed(5)}/task | ${tasksPerDollar} per $1`
  );
});

await run.map(urls, (url) => ({ prompt: `Audit this page: ${url}` }));
```

### 2. Structured JSON with validation

```ts
const results = await run.map(pages, (page) => ({
  system: "Return ONLY JSON: {\"risk_score\": 0-100, \"red_flags\": string[]}",
  prompt: page.text,
  json: true,
  validate: (o) => typeof o.risk_score === "number" && Array.isArray(o.red_flags),
}));

console.log(run.report().validJsonRate); // 0.98
```

### 3. Priorities: important tasks survive

```ts
const run = createRunner({
  apiKey,
  budgetUsd: 0.01, // very tight
  priority: (item) => (item.isCustomerFacing ? 10 : 1),
});
```

Under a tight budget, high-priority items keep running while low-priority ones are downgraded or skipped first.

### 4. Custom tiers

```ts
const run = createRunner({
  apiKey,
  budgetUsd: 0.25,
  tiers: [
    { name: "full", maxInputChars: 8000, maxOutputTokens: 300, reasoning: "medium" },
    { name: "lite", maxInputChars: 2000, maxOutputTokens: 100, reasoning: "low" },
  ],
});
```

### 5. Hard stop instead of degrading

```ts
const run = createRunner({ apiKey, budgetUsd: 0.5, onBudget: "skip" });
```

### 6. Test your pipeline for free

```ts
const run = createRunner({ budgetUsd: 1, dryRun: true });
// Deterministic fake outputs and fake cost. Zero network calls.
```

### 7. Inside a Cloudflare Worker

```ts
export default {
  async fetch(req: Request, env: { OPENROUTER_API_KEY: string }) {
    const run = createRunner({ apiKey: env.OPENROUTER_API_KEY, budgetUsd: 0.05 });
    const { urls } = await req.json();
    const results = await run.map(urls, (u) => ({ prompt: `Audit: ${u}` }));
    return Response.json({ results, report: run.report() });
  },
};
```

## API

### `createRunner(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | required (not with `dryRun`) | OpenRouter API key |
| `model` | `string` | `meta/muse-ember` | OpenRouter model slug |
| `budgetUsd` | `number` | `1` | Hard spending cap in USD |
| `concurrency` | `number` | `8` | Parallel requests |
| `onBudget` | `"degrade" \| "skip"` | `"degrade"` | Degrade tiers or stop at the cap |
| `tiers` | `Tier[]` | full + lite | Quality levels, best first |
| `priority` | `(item) => number` | `() => 0` | Higher survives longer |
| `dryRun` | `boolean` | `false` | Fake outputs, no network |

### `run.map(items, buildTask)`

`buildTask(item)` returns `{ system?, prompt, json?, validate? }`. Resolves to one result per item:

```ts
{ status: "ok" | "skipped:budget" | "error", tier, cost, latencyMs, data, raw }
```

Per-task errors never stop the batch.

### `run.on("cost", handler)`

Fires after every call with `{ spent, calls, avgCost, tasksPerDollar }`.

### `run.report()`

```ts
{
  spent, budget, calls, skipped, errors,
  avgCost, avgLatencyMs, validJsonRate,
  tierCounts: { full, lite, skipped },
  coverage,        // % of tasks answered
  tasksPerDollar,
}
```

## Live demo: Fine Print Watchdog

`apps/watchdog` audits Terms of Service and privacy policies with a **live budget slider**. Drag it from $1.00 down to $0.001 and watch cards flip from `FULL` to `LITE` to `SKIPPED` without a single crash.

```bash
cd apps/watchdog
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler deploy
```

Add `?dry=1` to the URL to try the UI with no API calls.

## Cost benchmark

> Fill this in with your own run (`run.report()`). List prices for Muse Ember are $0.10 / $0.50 per 1M input / output tokens, which suggests roughly 2,500 small tasks per dollar. Replace with measured numbers.

| Tier | Avg cost / task | Avg latency | Valid JSON | Tasks per $1 |
| --- | --- | --- | --- | --- |
| `full` | $0.000 | 0.0 s | 0% | 0 |
| `lite` | $0.000 | 0.0 s | 0% | 0 |

## Roadmap

- [ ] Triage then deep dive: run `lite` on everything, spend what's left on `full` only for flagged items
- [ ] `bench()` to compare cost, latency and agreement across models
- [ ] CLI: `npx pennypace run tasks.jsonl --budget 1`
- [ ] Pluggable cache
- [ ] More source packs for the demo (pricing pages, regulations, tenders)

## Contributing

PRs welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md). A good first contribution is a new source pack for the demo.

## License

MIT

---

<p align="center">Built on <a href="https://openrouter.ai">OpenRouter</a> with Meta's Muse Ember.</p>
