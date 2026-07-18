// ---- Fase 2: normalize clusters + resolve keyword cannibalization (deterministic, no LLM) ----
const items = $input.all();

// Rejoin views/likes from the pinned Extract node (popularity tiebreak). Skips silently if node name differs.
let statsByUrl = {};
try {
  for (const r of $('Extract from File').all()) {
    const j = r.json;
    if (j.URL) statsByUrl[j.URL] = { views: Number(j.Views) || 0, likes: Number(j.Likes) || 0 };
  }
} catch (e) {}

// 1) Cluster normalization — light, defensible merges. Tune this dict after seeing the distribution.
const CLUSTER_MAP = {
  anatomia_sessuale: 'salute_sessuale',
  masturbazione: 'educazione_sessuale',
  lubrificanti: 'sex_toys',
  // kept distinct on purpose: educazione_sessuale, salute_sessuale, relazioni_coppia,
  // sex_toys, esperienze_personali, sessualita_trans, bdsm_kink, sesso_anale
};
const normCluster = (c) => CLUSTER_MAP[c] || c || 'non_classificato';

// 2) Keyword canonicalization for collision detection
const STOP = new Set(['il','lo','la','i','gli','le','un','uno','una','di','a','da','in','con','su','per','tra','fra','e','o','che','come','del','della','dei','delle','al','alla','e','si','sono','piu','fa','ha','cosa','quali','quando','perche']);
const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
const canon = (kw) => stripAccents(String(kw).toLowerCase())
  .replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
  .filter(w => w && !STOP.has(w)).sort().join(' ').trim();

// 3) Split good rows from failed (PROHIBITED_CONTENT etc.) — nothing is lost
const videos = [], failed = [];
for (const it of items) {
  const v = it.json;
  if (v._parse_error || !Array.isArray(v.keyword_candidate) || v.keyword_candidate.length === 0) {
    failed.push(v); continue;
  }
  const title = stripAccents(String(v.titolo_originale || '').toLowerCase());
  const titleTokens = new Set(title.replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean));
  videos.push({
    ref: v, url: v.URL, cluster_norm: normCluster(v.cluster), titleTokens,
    stats: statsByUrl[v.URL] || { views: 0, likes: 0 },
    candidates: v.keyword_candidate.map(k => ({ raw: k, key: canon(k) })).filter(c => c.key),
    assigned: null, assignedRaw: null,
  });
}

// 4) Claim strength = title match dominates, views break ties
function claimStrength(video, kwCanon) {
  const t = kwCanon.split(' ').filter(Boolean);
  if (!t.length) return 0;
  let overlap = 0; for (const w of t) if (video.titleTokens.has(w)) overlap++;
  return (overlap / t.length) * 100 + Math.log10((video.stats.views || 0) + 10);
}

// 5) Greedy assignment: award most-contested keywords first, to the strongest claimant
const kwToVideos = new Map();
for (const vid of videos) for (const c of vid.candidates) {
  if (!kwToVideos.has(c.key)) kwToVideos.set(c.key, []);
  kwToVideos.get(c.key).push(vid);
}
const kwList = [...kwToVideos.entries()].sort((a,b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : 1));
const claimed = new Set();
for (const [kw, vids] of kwList) {
  if (claimed.has(kw)) continue;
  const contenders = vids.filter(v => !v.assigned);
  if (!contenders.length) continue;
  contenders.sort((a,b) => (claimStrength(b,kw) - claimStrength(a,kw)) || (a.url < b.url ? -1 : 1));
  const w = contenders[0];
  w.assigned = kw; w.assignedRaw = w.candidates.find(c => c.key === kw).raw; claimed.add(kw);
}

// 6) Leftovers: take least-contested unclaimed candidate, else the most specific one
for (const vid of videos) {
  if (vid.assigned) continue;
  const unclaimed = vid.candidates.filter(c => !claimed.has(c.key));
  let pick;
  if (unclaimed.length) { unclaimed.sort((a,b)=>(kwToVideos.get(a.key).length)-(kwToVideos.get(b.key).length)); pick = unclaimed[0]; }
  else { pick = [...vid.candidates].sort((a,b)=> b.raw.length - a.raw.length)[0]; }
  vid.assigned = pick.key; vid.assignedRaw = pick.raw; claimed.add(pick.key);
}
// ---- 6.5) RESCUE: swap a generic target for a specific, unclaimed candidate that matches the title ----
const GENERIC_RAW = [
  "come migliorare la vita sessuale di coppia", "come migliorare la vita sessuale",
  "consigli per migliorare l'intimità di coppia", "come migliorare l'intimità di coppia",
  "consigli per migliorare l'intimità", "guida al piacere femminile",
  "consigli per una vita sessuale appagante", "consigli su vita sessuale",
  "consigli su come vivere la sessualità", "consigli per posizioni sessuali",
  "guida posizioni sessuali", "posizioni sessuali di coppia",
  "posizioni sessuali per principianti", "idee per ravvivare la vita di coppia",
  "consigli per l'intimità di coppia", "esplorare la propria sessualità",
  "come migliorare l'intesa sessuale", "consigli per migliorare la vita sessuale di coppia",
  "consigli per una relazione sana", "consigli su relazioni di coppia",
  "consigli per migliorare la vita di coppia", "posizioni sessuali consigliate"
];
const GENERIC = new Set(GENERIC_RAW.map(canon));

const titleOverlap = (video, kwKey) => {
  const t = kwKey.split(' ').filter(Boolean);
  if (!t.length) return 0;
  let hit = 0; for (const w of t) if (video.titleTokens.has(w)) hit++;
  return hit / t.length;
};

let rescuedCount = 0;
for (const vid of videos) {
  if (!GENERIC.has(vid.assigned)) continue;                 // only videos stuck on a generic target
  const cur = titleOverlap(vid, vid.assigned);
  const better = vid.candidates
    .filter(c => c.key !== vid.assigned && !GENERIC.has(c.key) && !claimed.has(c.key))
    .map(c => ({ c, score: titleOverlap(vid, c.key) }))
    .sort((a, b) => b.score - a.score)[0];
  if (better && better.score > 0 && better.score > cur) {   // the alt matches the title better
    claimed.delete(vid.assigned);                           // release the generic
    vid.assigned = better.c.key;
    vid.assignedRaw = better.c.raw;
    claimed.add(better.c.key);
    vid.rescued = true;
    rescuedCount++;
  }
}
// 7) Emit rows
const out = [];
for (const vid of videos) {
  out.push({ json: {
    URL: vid.url,
    titolo_originale: vid.ref.titolo_originale,
    lingua_video: vid.ref.lingua_video,
    topic_principale: vid.ref.topic_principale,
    cluster: vid.cluster_norm,
    search_intent: vid.ref.search_intent,
    keyword_target: vid.assignedRaw,
    keyword_secondarie: vid.candidates.filter(c => c.raw !== vid.assignedRaw).slice(0,3).map(c => c.raw),
    keyword_rescued: !!vid.rescued, stato: 'ok',
  }});
}
for (const f of failed) {
  out.push({ json: {
    URL: f.URL, titolo_originale: f.titolo_originale, lingua_video: f.lingua_video,
    topic_principale: f.topic_principale || null, cluster: normCluster(f.cluster),
    search_intent: f.search_intent || null, keyword_target: null, keyword_secondarie: [],
    stato: 'da_processare_manualmente',
  }});
}
return out;