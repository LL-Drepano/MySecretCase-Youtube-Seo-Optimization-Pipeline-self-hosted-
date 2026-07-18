const orig = $('Build prompt Fase 3').item.json;
const { prompt, ...clean } = orig;
const raw = $json.candidates?.[0]?.content?.parts?.[0]?.text;

let p;
try { p = JSON.parse(raw); }
catch (e) {
  return { json: { ...clean, _parse_error: true,
    _reason: $json.candidates?.[0]?.finishReason || $json.promptFeedback?.blockReason || 'no_content' } };
}

// enforce ≤70-char title at a word boundary
let titolo = String(p.titolo_proposto || '').trim();
let troncato = false;
if (titolo.length > 70) {
  let cut = titolo.slice(0, 70);
  const sp = cut.lastIndexOf(' ');
  if (sp > 40) cut = cut.slice(0, sp);
  titolo = cut.replace(/[\s,;:.\-–]+$/, '').trim();
  troncato = true;
}

return { json: {
  ...clean,
  keyword_scelta: p.keyword_scelta,
  titolo_proposto: titolo,
  titolo_lunghezza: titolo.length,
  titolo_troncato: troncato,
  descrizione_proposta: p.descrizione_proposta
}};