// Fase 4 — Normalize. Run Once for All Items. Zero API calls.
const val = (v) => (v === undefined || v === null ? '' : v);
const flag = (v) => (v === true ? 'sì' : v === false ? 'no' : '');

const rows = $input.all().map((it) => {
  const r = it.json;
  const sec = Array.isArray(r.keyword_secondarie) ? r.keyword_secondarie.join(' | ') : val(r.keyword_secondarie);

  return {
    json: {
      URL: val(r.URL),
      'Titolo originale': val(r.titolo_originale),
      Views: r.Views ?? '',
      Cluster: val(r.cluster),
      'Search intent': val(r.search_intent),
      'Topic principale': val(r.topic_principale),

      'Keyword finale': val(r.keyword_finale || r.keyword_target),
      'Titolo proposto': val(r.titolo_proposto),
      'Lunghezza titolo': r.titolo_lunghezza ?? '',
      'Descrizione proposta': val(r.descrizione_proposta),

      Stato: val(r.stato),
      Note: val(r._reason || r._parse_error),

      'Keyword assegnata (Fase 2)': val(r.keyword_target),
      'Keyword secondarie': sec,
      'Override LLM': flag(r.override_llm),
      'Override rifiutato': flag(r.override_rifiutato),
      'Riassegnato per collisione': flag(r.riassegnato_da_collisione),
      'Collisione irrisolta': flag(r.collisione_irrisolta),
      'Keyword recuperata (Fase 2)': flag(r.keyword_rescued),
      'Titolo troncato': flag(r.titolo_troncato),
    },
  };
});

rows.sort((a, b) => {
  const s = (a.json.Stato === 'ok' ? 0 : 1) - (b.json.Stato === 'ok' ? 0 : 1);
  return s !== 0 ? s : (Number(b.json.Views) || 0) - (Number(a.json.Views) || 0);
});

console.log(`Righe: ${rows.length}`);
return rows;