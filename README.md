# app-tech-stack-watch

Which SDKs does a competitor's iOS app ship with, and how high has it charted? [PeekPanda](https://peekpanda.com) is an iOS competitor catalogue where every app has a case file of dated, stored evidence, including technology evidence. This small Node CLI (no dependencies, Node 18+) reads it for a list of apps and gives you a Markdown, CSV or JSON report, a diff against last run, and an optional Slack or Discord post. A [browser page](https://fdarkaou.github.io/app-tech-stack-watch/) renders the same report from pasted JSON.

It calls one documented read per app, [`GET /v1/competitors/ios/{storeId}/technology`](https://peekpanda.com/docs/get-competitor-technology) (MCP tool `get_app`, action `technology`, scope `context:read`). Reading never starts collection, and this tool never requests a refresh.

```sh
export PEEKPANDA_TOKEN=...   # a PeekPanda API key (Account → API keys); never commit it
node cli.js --apps "571800810=Calm,493145008=Headspace,id389801252"
node cli.js --apps-file apps.txt --format csv > tech.csv
node cli.js --apps-file apps.txt --state tech-state.json --webhook "$SLACK_WEBHOOK_URL"   # weekly diff + post
node cli.js --apps-file apps.txt --save run.json    # keep the answers; re-render later with --file run.json
```

Options: `--apps`, `--apps-file` (one per line, `#` comments, `=Label` names an app), `--state`, `--save`, `--file`, `--format md|csv|json`, `--webhook`, `--tenancy` (only a workspace id if you need one; leave it out otherwise, because a key pinned to a workspace answers 403 `workspace_not_accessible` for a tenancy it cannot reach). Each app is one call against your plan's daily API and MCP allowance (see [plans and refreshes](https://peekpanda.com/docs/plans-and-refreshes)). On `daily_call_limit` the tool stops and reports what it already read; one `Retry-After` retry is made on `rate_limited` or 503.

## Reading the report

- **SDK evidence found** lists readable names from the SDK prefixes PeekPanda stored, grouped by its categories. Related bundles (for example several `Firebase_*` ones) are folded under their first word. Identifiers that are not readable names (hex strings, keys, URLs, bare numbers) are only counted as *unnamed identifiers*, and `--save` replaces them with `#` so no keys land on disk.
- An advertising-network identifier does **not** prove active ad buying, and an SDK that is not listed is not proof the app lacks it. Evidence that is not collected stays "not collected" rather than becoming a guess.
- **Best chart position** is source-reported over a rolling 90-day window. It is not a daily history or the current position (for that see [rank history and charts](https://peekpanda.com/docs/rank-history-and-charts)).
- The diff lists SDK families added or no longer listed, SKAdNetwork ID count changes, best-position changes, and apps whose evidence went from not collected to observed.

## Weekly GitHub Action

`.github/workflows/tech-watch.yml` runs every Monday once you set the repository variable `ENABLE_TECH_WATCH=true`, the variable `TECH_APPS` (store IDs) and the secret `PEEKPANDA_TOKEN` (optional `TECH_WATCH_WEBHOOK_URL`).

## Tests

`npm test` (offline, uses the made-up files in `examples/`).

MIT licensed. Not affiliated with Apple.
