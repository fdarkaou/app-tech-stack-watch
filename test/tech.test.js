import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInput, readableName, techReport, scrub, buildReport, diff, toMarkdown, toCsv, toChat } from '../tech.js';

const load = async (f) => JSON.parse(await readFile(new URL(`../examples/${f}`, import.meta.url), 'utf8'));
const rep = async (f) => buildReport((await load(f)).map((x) => techReport(x.raw, x.label)));

test('parseInput takes ids, links and labels', () => {
  assert.deepEqual(parseInput('id571800810'), { storeId: '571800810', label: null });
  assert.deepEqual(parseInput('https://apps.apple.com/us/app/calm/id571800810=Calm'), { storeId: '571800810', label: 'Calm' });
  assert.throws(() => parseInput('Calm'));
});

test('readableName keeps framework names and drops identifiers', () => {
  assert.equal(readableName('AppsFlyerLib.framework'), 'AppsFlyerLib');
  for (const x of ['False', '1592594007691679', 'https://appsflyer-skadnetwork.com/', 'key_live_abc', 'headspace.app', 'ca-app-pub-1~2', '#']) assert.equal(readableName(x), null, x);
});

test('techReport groups families, counts unnamed identifiers, finds best rank', async () => {
  const r = await rep('run.json');
  const a = r.apps[0];
  assert.equal(a.sdk.categories[0].names.join(), 'Amplitude,FirebaseAnalytics,Mixpanel');
  assert.equal(a.sdk.categories[1].unlabelled, 1);
  assert.equal(a.ranks.best.bestRank, 5);
  assert.equal(a.ranks.countries, 3);
});

test('not_collected apps render honestly', () => {
  const a = techReport({ storeId: '1', status: 'not_collected', sdk: { status: 'not_collected' }, bestRanks: { status: 'not_collected' } });
  assert.match(toMarkdown(buildReport([a])), /not collected/);
  assert.equal(a.ranks.best, null);
});

test('diff reports added SDK, rank and status changes', async () => {
  const lines = diff(await rep('previous-run.json'), await rep('run.json'));
  assert.ok(lines.some((l) => /added: Product analytics: Mixpanel/.test(l)));
  assert.ok(lines.some((l) => /#14 → #5/.test(l)));
  assert.ok(lines.some((l) => /now observed/.test(l)));
  assert.deepEqual(diff(await rep('run.json'), await rep('run.json')), []);
});

test('scrub removes unreadable identifiers; csv and chat render', async () => {
  const s = scrub({ storeId: '1', sdk: { sdkCategories: [{ category: 'x', sdkPrefixes: ['key_live_abc', 'Sentry.framework'] }], appQueries: ['fb123'], skAdNetworkIds: ['a.skadnetwork'] } });
  assert.deepEqual(s.sdk.sdkCategories[0].sdkPrefixes, ['#', 'Sentry.framework']);
  assert.deepEqual(s.sdk.appQueries, ['#']);
  const r = await rep('run.json');
  assert.match(toCsv(r), /^store_id,name,status/);
  assert.match(toChat(r, [], [{ input: '2', why: '404 not_found' }]), /2 apps, 2 with stored/);
});
