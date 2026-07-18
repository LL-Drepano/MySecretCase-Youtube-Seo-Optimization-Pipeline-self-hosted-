// Loop over input items and add a new field called 'myNewField' to the JSON of each one
const v = $json;
const prompt = `Sei un analista SEO per un e-commerce italiano di benessere sessuale/intimità.
Analizza il seguente video YouTube. Basati ESCLUSIVAMENTE sul contenuto fornito: non inventare nulla che non sia nel testo.

DATI VIDEO
- Titolo: ${v. Titolo ?? ''}
- Descrizione: ${v.Descrizione ?? ''}
- Tag: ${v.Tags ?? ''}
- Lingua trascrizione: ${v['Lingua trascrizione'] ?? ''}
- Trascrizione: ${v.Trascrizione ?? ''}

ISTRUZIONI
- topic_principale: una frase, cosa tratta il video, nella lingua della trascrizione.
- cluster:
Assegna una macro-categoria SEO riutilizzabile.
Usa sempre categorie brevi in formato snake_case.
Non creare categorie nuove se una categoria esistente descrive il video.

Categorie preferite:
 - sex_toys
 - lubrificanti
 - masturbazione
 - bdsm_kink
 - sesso_anale
 - educazione_sessuale
 - anatomia_sessuale
 - relazioni_coppia
 - sessualita_trans
 - esperienze_personali
 - interviste
 - salute_sessuale

Scegli la categoria più utile per separare contenuti simili nei motori di ricerca.
- search_intent: informazionale | commerciale | transazionale.
- keyword_candidate: 5-8 query REALI che una persona digiterebbe su Google per trovare questo contenuto, nella lingua della trascrizione. Preferisci formulazioni non esplicite quando catturano la stessa intenzione.
- lingua: il codice lingua della trascrizione.
Il cluster NON deve descrivere il formato del video (es. intervista, podcast, Q&A).
Deve descrivere l'argomento SEO principale per cui un utente cercherebbe questo contenuto.
Scegli il cluster in base all'intento di ricerca, non alla modalità con cui il contenuto è presentato.
Il cluster NON indica il formato del contenuto (intervista, Q&A, podcast).
Il cluster NON indica semplicemente che il video contiene informazioni.

Il cluster deve indicare l'argomento SEO principale per cui una persona farebbe una ricerca Google.

Esempi:
Video che parla di BDSM → bdsm_kink
Video che parla di sex toys → sex_toys
Video che parla di lubrificanti → lubrificanti
Video che parla di transizione e sessualità → sessualita_trans
Video che parla genericamente di consenso/anatomia → educazione_sessuale`;

return { json: { ...v, prompt } };