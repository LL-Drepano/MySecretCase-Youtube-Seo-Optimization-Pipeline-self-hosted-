const v = $json;
const alt = (v.keyword_secondarie || []).join(' | ');
const prompt = `Sei un copywriter SEO per un e-commerce italiano di benessere sessuale (MySecretCase).
Ottimizzi titoli e descrizioni di video YouTube per farli rankare nella SERP di Google.

VIDEO
- Topic: ${v.topic_principale ?? ''}
- Titolo attuale: ${v.titolo_originale ?? ''}
- Keyword target assegnata: ${v.keyword_target ?? ''}
- Keyword alternative: ${alt}

ISTRUZIONI
1. keyword_scelta: usa la "keyword target assegnata", A MENO CHE una delle alternative descriva
   in modo nettamente più specifico e preciso il contenuto del video: in quel caso scegli quella.
   Nel dubbio mantieni la keyword target.
2. titolo_proposto: massimo 70 caratteri. Contiene la keyword_scelta in modo naturale, meglio se
   all'inizio. Deve spingere al click e sembrare scritto da una persona. Niente MAIUSCOLO, niente
   emoji, niente clickbait ingannevole.
3. descrizione_proposta: i primi 150 caratteri devono essere ad alto impatto e contenere la
   keyword_scelta il prima possibile. Italiano, tono professionale ma caldo.
   Puoi adattare la keyword grammaticalmente nella descrizione invece di copiaincollarla verbatim.`;
return { json: { ...v, prompt } };