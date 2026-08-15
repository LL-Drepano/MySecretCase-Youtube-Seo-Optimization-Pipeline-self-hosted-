/**
 * Fase 3.5 — Override collision guard
 *
 * Place:  after "Parse Fase 3", before the Fase 4 Merge.
 * Mode:   Run Once for All Items.
 * Cost:   zero API calls.
 *
 * Why this exists:
 *   Fase 2 enforces one-head-keyword-one-owner globally. The Fase 3 override
 *   picks from keyword_secondarie, which may hold keywords that
 *   OTHER videos won. So an unchecked override can silently re-create the exact
 *   cannibalization the two-stage architecture exists to prevent — and it will
 *   cluster precisely where the override fires, on videos stranded on generic
 *   keywords, because those are the ones whose secondarie are contested.
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Node holding the raw sheet. Fase 3 output drops Views/Likes, so they are
// re-joined here on URL.
const SOURCE_NODE = 'Extract from File';

// ─── CANONICALIZER ───────────────────────────────────────────────────────────
// REPLACE THIS with the exact function from Fase 2.
// If the stopword list or the normalisation differs by even one token, this
// pass groups keywords differently than Fase 2 did, and the guarantee is void.
const STOPWORDS = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una',
  'del', 'dello', 'della', 'dei', 'degli', 'delle',
  'al', 'allo', 'alla', 'ai', 'agli', 'alle',
  'dal', 'dalla', 'nel', 'nella', 'sul', 'sulla',
  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra',
  'e', 'ed', 'o', 'che', 'come', 'cosa', 'si', 'ci', 'non', 'piu', 'se', 'ma',
]);

const canon = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((t) => t && !STOPWORDS.has(t))
  .sort()
  .join(' ');

const tokenSet = (s) => new Set(canon(s).split(' ').filter(Boolean));

// ─── VIEWS RE-JOIN ───────────────────────────────────────────────────────────
const viewsByUrl = new Map();
for (const it of $(SOURCE_NODE).all()) {
  const url = String(it.json.URL ?? '').trim();
  if (url) viewsByUrl.set(url, Number(it.json.Views) || 0);
}

const rows = $input.all().map((it) => ({ ...it.json }));

for (const r of rows) {
  r.Views = viewsByUrl.get(String(r.URL ?? '').trim()) ?? null;

  // Not emitted by Fase 3 — derived.
  r.override_llm = Boolean(r.keyword_scelta) && r.keyword_scelta !== r.keyword_target;
  r.override_rifiutato = false;
  r.collisione_irrisolta = false;
  r.keyword_finale = r.keyword_scelta || r.keyword_target;
}

// ─── CLAIM STRENGTH ──────────────────────────────────────────────────────────
// Title-token overlap dominant, log10(views) as tiebreak — same ordering Fase 2 used.
const strength = (r) => {
  const kw = tokenSet(r.keyword_finale);
  const title = tokenSet(r.titolo_originale);
  let overlap = 0;
  for (const t of kw) if (title.has(t)) overlap += 1;
  return overlap * 1000 + Math.log10((r.Views || 0) + 1);
};

// ─── GROUP BY CANONICAL HEAD KEYWORD ─────────────────────────────────────────
const groups = new Map();
for (const r of rows) {
  const key = canon(r.keyword_finale);
  if (!key) continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

// ─── RESOLVE ─────────────────────────────────────────────────────────────────
let reverted = 0;
let upstreamBreaks = 0;

for (const group of groups.values()) {
  if (group.length < 2) continue;

  // A row that kept its Fase 2 assignment outranks any overrider.
  const incumbents = group.filter((r) => !r.override_llm);

  // Two incumbents colliding means Fase 2's uniqueness was already broken:
  // neither has anything to revert to. Flag it rather than silently pick.
  if (incumbents.length > 1) {
    upstreamBreaks += 1;
    for (const r of incumbents) r.collisione_irrisolta = true;
  }

  const pool = incumbents.length ? incumbents : group;
  const winner = pool.slice().sort((a, b) => strength(b) - strength(a))[0];

  for (const r of group) {
    if (r === winner || !r.override_llm) continue;
    r.keyword_finale = r.keyword_target; // globally unique per Fase 2
    r.override_rifiutato = true;
    reverted += 1;
  }
}

// ─── VERIFY ──────────────────────────────────────────────────────────────────
// One pass suffices because every reverted row falls back to a keyword_target
// that Fase 2 already made globally unique — no cascade. This asserts that
// invariant instead of trusting it. collisioni_residue should equal
// collisioni_a_monte; anything above that is a bug in this node.
const counts = new Map();
for (const r of rows) {
  const key = canon(r.keyword_finale);
  if (!key) continue;
  counts.set(key, (counts.get(key) || 0) + 1);
}
const residual = [...counts.entries()].filter(([, n]) => n > 1);

console.log(JSON.stringify({
  righe: rows.length,
  override_proposti: rows.filter((r) => r.override_llm).length,
  override_rifiutati: reverted,
  override_accettati: rows.filter((r) => r.override_llm && !r.override_rifiutato).length,
  collisioni_a_monte: upstreamBreaks,
  collisioni_residue: residual.length,
  esempi_residui: residual.slice(0, 5).map(([k]) => k),
}, null, 2));
// ─── PASS 2: incumbent-vs-incumbent collisions ──────────────────────────
const claimed = new Set(rows.map(r => canon(r.keyword_finale)).filter(Boolean));

const stuckGroups = new Map();
for (const r of rows) {
  if (!r.collisione_irrisolta) continue;
  const k = canon(r.keyword_finale);
  if (!stuckGroups.has(k)) stuckGroups.set(k, []);
  stuckGroups.get(k).push(r);
}

for (const group of stuckGroups.values()) {
  if (group.length < 2) continue;
  const winner = group.slice().sort((a, b) => strength(b) - strength(a))[0];
  winner.collisione_irrisolta = false;

  for (const r of group) {
    if (r === winner) continue;
    const title = tokenSet(r.titolo_originale);
    let best = null, bestScore = -1;
    for (const kw of (r.keyword_secondarie || [])) {
      const k = canon(kw);
      if (!k || claimed.has(k)) continue;
      let ov = 0;
      for (const t of tokenSet(kw)) if (title.has(t)) ov += 1;
      if (ov > bestScore) { bestScore = ov; best = kw; }
    }
    if (!best) continue;               // nothing free → stays flagged
    claimed.add(canon(best));
    r.keyword_finale = best;
    r.riassegnato_da_collisione = true;
    r.collisione_irrisolta = false;
  }
}

// ─── PASS 3: clean truncated titles ─────────────────────────────────────
const CODA = /\s+(?:e|ed|o|a|ad|da|di|del|dello|della|dei|degli|delle|al|allo|alla|ai|agli|alle|con|per|tra|fra|in|su|sul|sulla|il|lo|la|i|gli|le|un|uno|una|che|come|se|ma|non|piu|più|senza|dopo|prima|mio|mia|tuo|tua|suo|sua)$/i;

const pulisci = (t) => {
  let s = String(t || '').trim(), prev;
  do { prev = s; s = s.replace(CODA, '').replace(/[\s,;:–—-]+$/, ''); } while (s !== prev);
  return s;
};

for (const r of rows) {
  if (!r.titolo_troncato) continue;
  const p = pulisci(r.titolo_proposto);
  if (p.length >= 40) {
    r.titolo_proposto = p;
    r.titolo_lunghezza = p.length;
    r.titolo_troncato = false;
  }
}
return rows.map((json) => ({ json }));
