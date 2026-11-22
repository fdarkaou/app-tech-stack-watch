#!/usr/bin/env node
// App tech stack watch for PeekPanda. Node 18+, no dependencies. Read-only (scope context:read):
//   GET /v1/competitors/ios/{storeId}/technology   stored SDK evidence + best chart positions (MCP get_app action technology)
// One call per app. Reading never starts collection (collection needs an explicit refresh request, which this tool never makes).
import { readFile, writeFile } from 'node:fs/promises';
import { parseInput, techReport, scrub, buildReport, diff, toMarkdown, toCsv, toChat } from './tech.js';

const HELP = `Usage:
  PEEKPANDA_TOKEN=... node cli.js --apps "571800810=Our app,493145008,id389801252"   one call per app
  PEEKPANDA_TOKEN=... node cli.js --apps-file apps.txt                              one per line, # comments
  node cli.js --file run.json [opts]                                                re-render a saved run

Each app is a store ID, id123..., or an apps.apple.com link; add =Label to name it.

Options:
  --apps <list>          comma-separated apps (up to 30)
  --apps-file <path>     one app per line
  --state <path>         compare with the report saved at this path, then save this run there
  --save <path>          save the answers (unreadable identifiers replaced by #); re-render later with --file or paste them into the browser page
  --format md|csv|json   output format (default md)
  --webhook <url>        also POST a short summary to a Slack or Discord incoming webhook
  --tenancy <selector>   send x-genviral-tenancy (a workspace id). Left out by default: a key pinned to a workspace
                         reads that workspace, and naming one it cannot reach answers 403 workspace_not_accessible.
  --api <url>            API base (default https://api.peekpanda.com)

Every call counts toward your plan's daily API and MCP allowance (see https://peekpanda.com/docs/plans-and-refreshes).`;

const FLAGS = new Set(['--help', '-h']);
function parse(argv) {
  const o = { format: 'md', api: 'https://api.peekpanda.com' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) o.help = true;
    else if (a.startsWith('--')) {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value. See --help.`);
      o[a.slice(2)] = v;
    } else throw new Error(`Unexpected argument "${a}". See --help.`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class StopError extends Error {}

async function call(o, path, retried = false) {
  const token = process.env.PEEKPANDA_TOKEN;
  if (!token) throw new StopError('Set PEEKPANDA_TOKEN to a PeekPanda API key (Account → API keys). Never commit it.');
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (o.tenancy) headers['x-genviral-tenancy'] = o.tenancy;
  const res = await fetch(new URL(path, o.api), { headers });
  if (res.ok) return res.json();
  const body = await res.json().catch(() => null);
  const code = body?.error?.code ?? '';
  const retry = Number(res.headers.get('retry-after') ?? body?.error?.retryAfterSeconds);
  if ((code === 'rate_limited' || res.status === 503) && !retried && retry > 0 && retry <= 70) {
    await sleep(retry * 1000);
    return call(o, path, true);
  }
  const msg = `${res.status} ${code}`.trim();
  if (code === 'daily_call_limit') throw new StopError(`PeekPanda API ${msg}: the daily API and MCP allowance is used until 00:00 UTC; stopping.`);
  if ([401, 402, 403].includes(res.status)) {
    const hint = { workspace_not_accessible: ' The key cannot reach that tenancy; leave out --tenancy or use a selector from GET /v1/workspaces.', authorization_required: ' Check the key scopes (context:read).', subscription_required: ' These reads need a plan with API access.' }[code] ?? '';
    throw new StopError(`PeekPanda API ${msg} (GET ${path}): ${String(body?.error?.message ?? res.statusText).replace(/\.$/, '')}.${hint}`);
  }
  return { error: `${msg}${body?.error?.message ? ` ${String(body.error.message).replace(/\.$/, '')}` : ''}` };
}

async function readApps(o) {
  const list = [];
  if (o.apps) list.push(...o.apps.split(','));
  if (o['apps-file']) list.push(...(await readFile(o['apps-file'], 'utf8')).split('\n').map((l) => l.replace(/#.*/, '')));
  const apps = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  if (!apps.length) throw new Error('Give --apps, --apps-file or --file. See --help.');
  if (apps.length > 30) throw new Error('At most 30 apps per run (one API call each).');
  return apps.map(parseInput);
}

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) return console.log(HELP);
  const raws = [], unresolved = [];
  let stopped = null;
  if (o.file) {
    const saved = JSON.parse(await readFile(o.file, 'utf8'));
    raws.push(...(Array.isArray(saved) ? saved : saved.raws ?? [saved]).map((x) => ({ raw: x.raw ?? x, label: x.label ?? null })));
  } else {
    for (const want of await readApps(o)) {
      try {
        const r = await call(o, `/v1/competitors/ios/${want.storeId}/technology`);
        if (r.error) unresolved.push({ input: want.storeId, why: r.error }); else raws.push({ raw: r, label: want.label });
      } catch (e) {
        if (!(e instanceof StopError)) throw e;
        stopped = e.message; break;
      }
    }
  }
  if (stopped && !raws.length) throw new Error(stopped);
  const rep = buildReport(raws.map((x) => techReport(x.raw, x.label)));
  if (o.save) await writeFile(o.save, JSON.stringify(raws.map((x) => ({ ...x, raw: scrub(x.raw) })), null, 2) + '\n');
  let changes = null;
  if (o.state) {
    const prev = await readFile(o.state, 'utf8').then(JSON.parse, () => null);
    if (prev) changes = diff(prev, rep);
    await writeFile(o.state, JSON.stringify(rep));
  }
  const text = o.format === 'json' ? JSON.stringify({ ...rep, changes, unresolved }, null, 2) : o.format === 'csv' ? toCsv(rep) : toMarkdown(rep, changes);
  console.log(text);
  if (o.format === 'md' && unresolved.length) console.log('\n' + unresolved.map((u) => `- ${u.input}: ${u.why}`).join('\n'));
  if (o.webhook) {
    const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(o.webhook);
    const msg = toChat(rep, changes, unresolved) + (stopped ? `\n${stopped}` : '');
    const res = await fetch(o.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(isDiscord ? { content: msg.slice(0, 1900) } : { text: msg }) });
    if (!res.ok) console.error(`webhook answered ${res.status}`);
  }
  if (stopped) { console.error(stopped); process.exit(2); }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
