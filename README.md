# penny-pacer

**Agents die when the money runs out. This one adapts.**

A tiny zero-dependency TypeScript package that runs many LLM tasks through [OpenRouter](https://openrouter.ai) under a hard dollar budget. Instead of crashing at $0, it paces spend, downgrades quality tier by tier, and skips the least important work last-resort. Built on **Meta Muse Ember** (`meta/muse-ember`).

## Quickstart

```ts
import { createRunner } from "penny-pacer";

const run = createRunner({ apiKey: process.env.OPENROUTER_API_KEY, budgetUsd: 0.5 });
const results = await run.map(items, (item) => ({ prompt: `Summarize: ${item}` }));
console.log(run.report()); // spent, coverage, tasksPerDollar, tierCounts...
```

## API

```ts
const run = createRunner({
  apiKey,                          // OpenRouter key (not needed with dryRun)
  model: "meta/muse-ember",        // default (exported as MUSE_EMBER)
  budgetUsd: 1,                    // hard cap
  concurrency: 8,
  onBudget: "degrade",             // "degrade" | "skip"
  tiers: [
    { name: "full", maxInputChars: 8000, maxOutputTokens: 300, reasoning: "medium" },
    { name: "lite", maxInputChars: 2000, maxOutputTokens: 100, reasoning: "low" },
  ],
  priority: (item) => 0,           // higher = more important
  dryRun: false,                   // fake outputs + fake cost, zero fetch calls
});

const results = await run.map(items, (item) => ({
  system, prompt, json: true, validate: (obj) => boolean,
  fake: () => ({ ... }),           // optional: dryRun output
}));
run.on("cost", (report) => {});    // live stats after every task
run.on("result", ({ index, item, result }) => {}); // each task as it finishes
run.report();
```

Each result: `{ status: "ok" | "skipped:budget" | "error", tier, cost, latencyMs, data, raw, error? }`.

`report()` returns `{ spent, budget, calls, skipped, errors, avgCost, avgLatencyMs, validJsonRate, tierCounts, coverage, tasksPerDollar }`.

Details:
- Calls `POST /api/v1/chat/completions` with `usage: { include: true }` and reads the **real** `usage.cost` (reasoning tokens included). Sends `HTTP-Referer` and `X-Title`.
- Tier `reasoning` is sent as OpenRouter's `reasoning: { effort }` (see [reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)). Reasoning tokens count against `maxOutputTokens`, so give reasoning tiers some headroom.
- Temperature 0. One retry on network errors only. A failing task never stops the batch.
- `json: true` sets `response_format: json_object`, strips code fences, runs `validate`, and counts `validJsonRate`. An invalid result has `status: "error"` and `error: "invalid_json"` (its cost is still counted).

## How pacing works

Like a taxi meter with a destination fare cap: before every task it divides the money left by the tasks left, picks the best tier whose estimated cost fits that share, and refuses any call whose worst case could push the total over `budgetUsd`.

1. `allowance = remainingBudget / remainingTasks`.
2. Estimates per tier come from running averages of real costs (list prices of $0.10/M in, $0.50/M out, ~4 chars/token until data exists).
3. Pick the highest tier with `estimate <= allowance`. If none fits, serve the highest-priority task at the cheapest safe tier; the lowest-priority tail ends up `skipped:budget`.
4. Hard cap: before each call, `spent + in-flight worst case + this call's worst case <= budgetUsd`. The worst case is full input plus every output token at list price.
5. `onBudget: "skip"` uses only the first tier and stops launching when the budget is gone.

Tasks run most-important-first; results are returned in input order.

## Cost benchmark

Fill in after your first real run (`npm run dev`, no `?dry=1`).

| Tier | Cost / task | Latency | Valid JSON | Tasks per $1 |
|------|-------------|---------|------------|--------------|
| Ember full | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Ember lite | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Demo: Fine Print Watchdog

`apps/watchdog` is a Cloudflare Worker that audits Terms of Service and privacy policies, streaming cards over SSE. It has a log-scale budget slider ($0.001 to $1) so you can watch FULL / LITE / SKIPPED shift live. Add `?dry=1` for a no-API-call mode.

`packs/policies.json` has 100 well-known policy URLs: 98 verified reachable, plus 2 OpenAI pages that exist but block bots. Pages that can't be fetched (bot walls, JS-rendered) fall back to bundled sample text, so the demo never breaks.

### Deploy to Cloudflare

```powershell
npm install
npm run build
cd apps/watchdog
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler deploy
```

Note: a request to a Worker is limited to 50 subrequests on the free plan (1000 on paid). A real run with 100 URLs needs about 200 (page fetches + model calls), so use the Workers Paid plan or a 20-URL list on free. Dry mode makes no subrequests.

Local real run: put `OPENROUTER_API_KEY=...` in `apps/watchdog/.dev.vars`, then `npm run dev` from the repo root.

## Roadmap

- Triage-then-deep-dive (cheap pass first, spend the remainder on the riskiest items)
- Benchmark across models
- CLI

## License

MIT. Built on Meta Muse Ember via OpenRouter.
