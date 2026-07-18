const orig = $('Build prompt').item.json;
const resp = $json;
const cand = resp?.candidates?.[0];
const raw  = cand?.content?.parts?.[0]?.text;

let parsed;
if (raw) {
  try { parsed = JSON.parse(raw); }
  catch (e) { parsed = { _parse_error: true, _reason: 'invalid_json', _raw: raw }; }
} else {
  parsed = {
    _parse_error: true,
    _reason: cand?.finishReason || resp?.promptFeedback?.blockReason || resp?.error?.message || 'no_content'
  };
}

return { json: { URL: orig.URL, titolo_originale: orig.Titolo, lingua_video: orig['Lingua trascrizione'], ...parsed } };