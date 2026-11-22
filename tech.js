// App tech stack watch for PeekPanda. No dependencies; runs in Node 18+ and in the browser.
// Input per app: the answer of GET /v1/competitors/ios/{storeId}/technology (MCP get_app action technology).
// It holds stored SDK evidence (grouped by category) and source-reported best chart positions over a rolling 90 days.
// An advertising-network identifier does not prove active ad buying, and a missing SDK is not proof of absence.

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const day = (s) => (typeof s === 'string' && s.length >= 10 ? s.slice(0, 10) : null);

export const CATEGORY_LABEL = {
  'ad-networks': 'Ad networks', 'ad-attribution': 'Ad attribution', 'product-analytics': 'Product analytics',
  'business-tools': 'Business tools', 'development-tools': 'Development tools',
};
export const label = (c) => CATEGORY_LABEL[c] ?? String(c).replace(/-/g, ' ').replace(/^./, (m) => m.toUpperCase());
export const COLLECTION_LABEL = { TOP_FREE_IOS: 'Top free iPhone', TOP_PAID_IOS: 'Top paid iPhone', TOP_GROSSING_IOS: 'Top grossing iPhone', TOP_FREE_IPAD: 'Top free iPad', TOP_PAID_IPAD: 'Top paid iPad', TOP_GROSSING_IPAD: 'Top grossing iPad' };
const collLabel = (c) => COLLECTION_LABEL[c] ?? String(c ?? '').toLowerCase().replace(/_/g, ' ');

export function parseInput(s) {
  const raw = String(s).trim();
  const [text, name] = raw.split(/\s*=\s*(?=[^/]*$)/);
  const m = text.match(/\/id(\d{3,20})/i) || text.match(/^(?:id)?(\d{3,20})$/i);
  if (!m) throw new Error(`"${raw}" is not a store ID or an apps.apple.com link.`);
  return { storeId: m[1], label: name || null };
}

// SDK prefixes are raw strings from the app binary. A readable one looks like a framework or bundle name; hex
// strings, bare numbers, "False", URLs and key-like strings are counted but never printed.
export function readableName(p) {
  const s = String(p ?? '').trim();
  if (!s || /^(true|false)$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) || /^\d+$/.test(s) || /^https?:/i.test(s) || /key_|secret|token|~/i.test(s) || s.length > 70) return null;
  const n = s.replace(/\.(framework|xcframework|bundle)$/i, '');
  return /[A-Za-z]{3}/.test(n) && !n.includes('.') ? n : null;
}

// Group the many Firebase_/GoogleUtilities_ style bundles under their first token so the table stays short.
const family = (n) => n.split(/[_.\-]/)[0] || n;

export function techReport(r, name = null) {
  if (!r || typeof r !== 'object' || r.storeId == null) throw new Error('Expected the answer of GET /v1/competitors/ios/{storeId}/technology (an object with "storeId").');
  const sdk = r.sdk ?? {}, br = r.bestRanks ?? {};
  const categories = (Array.isArray(sdk.sdkCategories) ? sdk.sdkCategories : []).map((c) => {
    const prefixes = Array.isArray(c.sdkPrefixes) ? c.sdkPrefixes : [];
    const seen = new Map();
    for (const f of prefixes.map(readableName).filter(Boolean).map(family)) if (!seen.has(f.toLowerCase())) seen.set(f.toLowerCase(), f);
    const names = [...seen.values()].sort((a, b) => a.localeCompare(b));
    return { category: c.category, names, unlabelled: prefixes.filter((p) => !readableName(p)).length };
  });
  const records = (Array.isArray(br.records) ? br.records : []).map((x) => ({ country: x.country, collection: x.collection, category: x.category, bestRank: num(x.bestRank) })).filter((x) => x.bestRank != null);
  const best = records.slice().sort((a, b) => a.bestRank - b.bestRank)[0] ?? null;
  const byCollection = {};
  for (const x of records) {
    const c = (byCollection[x.collection] ??= { collection: x.collection, countries: new Set(), best: x });
    c.countries.add(x.country);
    if (x.bestRank < c.best.bestRank) c.best = x;
  }
  return {
    storeId: String(r.storeId), name, status: r.status ?? 'not_collected', collectedAt: day(r.collectedAt),
    sdk: {
      status: sdk.status ?? 'not_collected', collectedAt: day(sdk.collectedAt), categories,
      permissions: Array.isArray(sdk.permissions) ? sdk.permissions : [], appQueries: Array.isArray(sdk.appQueries) ? sdk.appQueries.length : null,
      skAdNetworkIds: Array.isArray(sdk.skAdNetworkIds) ? sdk.skAdNetworkIds.length : null, unclassified: sdk.hasUnclassifiedEvidence === true,
    },
    ranks: {
      status: br.status ?? 'not_collected', collectedAt: day(br.collectedAt), windowDays: num(br.windowDays), records: records.length,
      countries: new Set(records.map((x) => x.country)).size, best,
      collections: Object.values(byCollection).map((c) => ({ collection: c.collection, countries: c.countries.size, best: c.best })).sort((a, b) => a.best.bestRank - b.best.bestRank),
    },
  };
}

export const buildReport = (items) => ({ apps: items });

// What changed since an earlier report (same shape): SDK families added or dropped per category, SkAdNetwork ID count,
// best chart position, and apps whose evidence went from not collected to observed.
export function diff(prev, cur) {
  const before = new Map((prev?.apps ?? []).map((a) => [a.storeId, a]));
  const lines = [];
  for (const a of cur.apps) {
    const p = before.get(a.storeId), who = a.name ? `${a.name} (${a.storeId})` : a.storeId;
    if (!p) { lines.push(`${who}: new in this list`); continue; }
    if (p.sdk.status !== 'observed' && a.sdk.status === 'observed') lines.push(`${who}: SDK evidence now observed (${a.sdk.collectedAt ?? 'undated'})`);
    const set = (x) => new Set(x.sdk.categories.flatMap((c) => c.names.map((n) => `${label(c.category)}: ${n}`)));
    const ps = set(p), cs = set(a);
    const added = [...cs].filter((x) => !ps.has(x)), dropped = [...ps].filter((x) => !cs.has(x));
    if (added.length) lines.push(`${who}: SDK evidence added: ${added.join(', ')}`);
    if (dropped.length) lines.push(`${who}: SDK evidence no longer listed: ${dropped.join(', ')}`);
    if (p.sdk.skAdNetworkIds != null && a.sdk.skAdNetworkIds != null && p.sdk.skAdNetworkIds !== a.sdk.skAdNetworkIds) lines.push(`${who}: SKAdNetwork IDs ${p.sdk.skAdNetworkIds} → ${a.sdk.skAdNetworkIds}`);
    const pb = p.ranks.best?.bestRank, cb = a.ranks.best?.bestRank;
    if (pb != null && cb != null && pb !== cb) lines.push(`${who}: best chart position #${pb} → #${cb} (90-day window)`);
    if (p.ranks.status !== 'observed' && a.ranks.status === 'observed') lines.push(`${who}: best chart positions now observed`);
  }
  for (const p of prev?.apps ?? []) if (!cur.apps.some((a) => a.storeId === p.storeId)) lines.push(`${p.name ?? p.storeId}: no longer in this list`);
  return lines;
}

const title = (a) => (a.name ? `${a.name} (${a.storeId})` : a.storeId);
const list = (xs, max = 14) => (xs.length > max ? `${xs.slice(0, max).join(', ')} +${xs.length - max} more` : xs.join(', '));

export function toMarkdown(rep, changes = null) {
  const out = ['# App tech stack watch', '', '_Stored SDK evidence and source-reported best chart positions from PeekPanda. SDK names are what was found in the app package, grouped by category; an advertising-network identifier does not prove active ad buying, and no SDK listed is not proof the app lacks one. Best ranks cover a rolling 90-day window, not a daily history or the current position._', ''];
  if (changes) out.push('## Changes since last run', '', ...(changes.length ? changes.map((l) => `- ${l}`) : ['- nothing changed in the stored evidence']), '');
  for (const a of rep.apps) {
    out.push(`## ${title(a)}`, '');
    if (a.status !== 'observed') { out.push('Technology evidence is not collected for this app yet (status not_collected). Reading it never starts collection.', ''); continue; }
    out.push(`SDK evidence ${a.sdk.status}${a.sdk.collectedAt ? ` on ${a.sdk.collectedAt}` : ''}; chart evidence ${a.ranks.status}${a.ranks.collectedAt ? ` on ${a.ranks.collectedAt}` : ''}.`, '');
    if (a.sdk.status === 'observed') {
      out.push('| Category | SDK evidence found | Unnamed identifiers |', '|---|---|---|');
      for (const c of a.sdk.categories) out.push(`| ${label(c.category)} | ${c.names.length ? list(c.names) : '–'} | ${c.unlabelled || '–'} |`);
      if (!a.sdk.categories.length) out.push('| – | no categories stored | – |');
      out.push('', `SKAdNetwork IDs: ${a.sdk.skAdNetworkIds ?? 'n/a'} · URL schemes it checks for (appQueries): ${a.sdk.appQueries ?? 'n/a'} · permissions listed: ${a.sdk.permissions.length}${a.sdk.unclassified ? ' · some evidence is unclassified' : ''}`, '');
    } else out.push('SDK evidence not collected.', '');
    if (a.ranks.status === 'observed' && a.ranks.best) {
      const b = a.ranks.best;
      out.push(`Best chart position in the last ${a.ranks.windowDays ?? 90} days: **#${b.bestRank}** (${collLabel(b.collection)}, ${b.country}, ${String(b.category ?? '').toLowerCase().replace(/_/g, ' ')}); ${a.ranks.records} records across ${a.ranks.countries} countries.`, '');
      out.push('| Chart | Countries | Best rank |', '|---|---|---|', ...a.ranks.collections.map((c) => `| ${collLabel(c.collection)} | ${c.countries} | #${c.best.bestRank} (${c.best.country}) |`), '');
    } else out.push('Best chart positions not collected.', '');
  }
  return out.join('\n');
}

export function toCsv(rep) {
  const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['store_id', 'name', 'status', 'sdk_collected', 'category', 'sdk_families', 'unnamed_identifiers', 'skadnetwork_ids', 'best_rank', 'best_chart', 'best_country', 'chart_countries'];
  const rows = [head.join(',')];
  for (const a of rep.apps) {
    const base = [a.storeId, a.name, a.status, a.sdk.collectedAt];
    const tail = [a.sdk.skAdNetworkIds, a.ranks.best?.bestRank, a.ranks.best ? collLabel(a.ranks.best.collection) : '', a.ranks.best?.country, a.ranks.countries];
    const cats = a.sdk.categories.length ? a.sdk.categories : [null];
    for (const c of cats) rows.push([...base, c ? label(c.category) : '', c ? c.names.join('; ') : '', c ? c.unlabelled : '', ...tail].map(q).join(','));
  }
  return rows.join('\n') + '\n';
}

export function toChat(rep, changes, unresolved = []) {
  const obs = rep.apps.filter((a) => a.status === 'observed').length;
  const l = [`App tech stack watch: ${rep.apps.length} apps, ${obs} with stored technology evidence.`];
  if (changes) l.push(...(changes.length ? changes.slice(0, 15).map((c) => `• ${c}`) : ['• nothing changed since last run']), ...(changes.length > 15 ? [`• +${changes.length - 15} more`] : []));
  for (const u of unresolved) l.push(`• ${u.input}: ${u.why}`);
  return l.join('\n');
}

// For --save: keep the answer but replace identifiers that are not readable names with "#", so no keys or IDs are written to disk.
export function scrub(r) {
  const c = JSON.parse(JSON.stringify(r));
  for (const cat of c.sdk?.sdkCategories ?? []) cat.sdkPrefixes = (cat.sdkPrefixes ?? []).map((p) => (readableName(p) ? p : '#'));
  if (Array.isArray(c.sdk?.appQueries)) c.sdk.appQueries = c.sdk.appQueries.map(() => '#');
  if (Array.isArray(c.sdk?.skAdNetworkIds)) c.sdk.skAdNetworkIds = c.sdk.skAdNetworkIds.map(() => '#');
  return c;
}
