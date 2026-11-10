# Contributing

Small, focused PRs welcome.

```bash
npm install
npm test          # vitest, mocked fetch, no API key needed
npm run build     # tsc -> packages/penny-pacer/dist
npm run dev       # build + wrangler dev for the demo (add ?dry=1 to the URL for no API calls)
```

- Keep the library zero-dependency (global `fetch` only).
- Add a test for every behavior change; tests must never hit the network.
- Never commit API keys (`.env` and `.dev.vars` are gitignored).
