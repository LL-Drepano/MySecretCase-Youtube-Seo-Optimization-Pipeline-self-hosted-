# MySecretCase-Youtube-Seo-Optimization-Pipeline-self-hosted-n8n

YouTube SEO Optimization Pipeline — MySecretCase

A demo built for a **MySecretCase selection task**.

An n8n workflow that takes ~400 YouTube videos — title, description, tags, metadata and full transcript — works out what each one is actually about, resolves keyword conflicts across the complete catalogue, and generates an optimized title and description for every video.

Built self-hosted on Docker and run entirely on free-tier APIs during the task.

![Scenario canvas](images_mysecretcase/full_workflow_canvas.png)

---

## The problem

The obvious approach is to loop over 400 rows, ask an LLM which keyword each video should target, and write the results to a spreadsheet.

The problem is that every video is processed independently.

Several videos about similar topics naturally select the same keyword, so the resulting sheet can look correct while multiple videos are targeting the same query.

For this task I treated that as a catalogue-level constraint:

**one canonical head keyword = one owner**

The pipeline therefore alternates between two types of processing:

* LLM calls for per-video semantic understanding and copy generation;
* deterministic code for catalogue-level keyword ownership and collision detection.

A second global validation pass is also needed after copy generation, because the generation model sees one video at a time and can re-introduce keyword collisions when it decides to override the assigned target.

---

## Highlights

* **399-video catalogue processed end-to-end.** All source rows remain accounted for in the final XLSX, including videos that could not be processed by Gemini.
* **Global keyword ownership.** Candidate keywords are generated per video, then resolved across the full catalogue instead of accepting independent LLM choices.
* **Post-generation collision guard.** The copy-generation step reintroduced genuine keyword conflicts; the final deterministic pass detected and corrected them before export.
* **12 LLM overrides rejected and 2 additional collisions resolved** during the final catalogue validation.
* **790 LLM calls and ~1.3M input tokens in Fase 1**, run on a self-hosted n8n instance using free-tier APIs.
* **Rate-limit and failure handling built into the workflow.** Batching, retries, parse-error capture and explicit manual-review rows prevent long runs from silently losing data.

**Stack:** self-hosted n8n (Docker) · Google Gemini API · JavaScript (n8n Code nodes) · XLSX processing.

---

## How it works

### 1. Ingest

`Manual Trigger → Read/Write Files from Disk → Extract from File (XLSX)`

The source XLSX is copied into the container at `/tmp/data.xlsx`.

I used XLSX instead of CSV because the transcripts contain commas, quotation marks and line breaks. Keeping the source structured avoids delimiter and encoding issues.

**Input columns:**

`Tipo, Titolo, Data, Durata (s), Views, Likes, Commenti, URL, Descrizione, Tags, Trascrizione, Lingua trascrizione`

**Output:** 399 items.

![FIRST HTTP REQUEST NODE](images_mysecretcase/extract.png)

### 2. Per-video enrichment

`Build prompt (Code) → HTTP Request → Parse (Code)`

Each video is analysed individually using its actual transcript.

The model returns:

* `topic_principale`;
* `cluster`;
* `search_intent`;
* `keyword_candidate[]`;
* `lingua`.

The goal at this stage is only to understand the individual video and produce realistic candidate queries. No attempt is made yet to decide which video should own a keyword globally.

The request uses a structured response schema so the output has a predictable JSON shape.

This guarantees structure and parseability, **not semantic correctness**. Semantic quality is handled later through catalogue-level rules and validation.

![FIRST HTTP REQUEST NODE](images_mysecretcase/LLM_1.png)

### 3. Cluster normalization and keyword ownership

Single n8n Code node, **Run Once for All Items**.

No API calls are required in this phase.

Fase 1 processes videos independently, so similar content can end up with slightly different cluster labels and overlapping candidate queries.

The deterministic phase first normalizes known cluster variants, for example:

```text
anatomia_sessuale → salute_sessuale
masturbazione → educazione_sessuale
lubrificanti → sex_toys
```

Candidate keywords are then converted to a canonical form for collision detection by:

* lowercasing;
* removing accents;
* removing punctuation;
* dropping Italian stopwords;
* sorting the remaining tokens.

The pipeline then assigns contested keywords globally.

Videos with stronger title relevance get priority, while views are used as an additional tiebreak signal. Videos that lose a contested query receive another available candidate.

Secondary candidates are preserved in `keyword_secondarie[]`.

### 4. Rescue generic assignments

Strict deduplication creates a tradeoff.

If several related videos share the same specific candidate keywords, weaker claimants can eventually be left with a vague query.

A deterministic rescue pass checks assignments against a list of generic catch-all phrases and tries to replace them with a more specific unclaimed candidate.

Rescued rows are flagged with:

```text
keyword_rescued: true
```

so the change remains auditable.

Even after this pass, around **8% of successfully processed videos** remained on generic keywords.

I kept that number visible rather than treating deduplication as cost-free.

![TITLE COMPARISON](images_mysecretcase/RESULT.png)

### 5. SEO copy generation

`IF (stato = ok) → Build prompt → HTTP Request → Parse`

The processed branch moves into the second LLM phase.

The model receives:

* the video's topic;
* the assigned `keyword_target`;
* secondary keyword candidates.

It generates:

* `keyword_scelta`;
* `titolo_proposto`;
* `descrizione_proposta`.

The model is allowed to propose a different keyword when it considers another candidate substantially more specific to the video.

That flexibility is useful, but it also creates the main bug discovered later in the workflow.

The eight rows that could not clear Fase 1 do not disappear. The IF false branch carries them directly toward the final merge.

### 6. Deterministic title validation

The 70-character title limit is enforced in JavaScript instead of relying on the prompt.

If a generated title is too long, it is truncated at a word boundary and flagged with:

```text
titolo_troncato
```

A second check removes trailing Italian function words when truncation produces endings such as:

> "...guida alla comunicazione di"

or:

> "...consenso, anatomia e"

The cleanup repeats until the title ends on a meaningful word, provided the result does not become too short.

No additional model call is required.

![TITLE COMPARISON](images_mysecretcase/RESULT.png)

### 7. Final collision guard

Single Code node, **Run Once for All Items**.

This phase was added after inspecting the actual Fase 3 output.

Fase 2 assigns keyword ownership using the complete catalogue, but Fase 3 works on one video at a time.

When the model overrides `keyword_target` with one of the secondary candidates, it does not know whether another video already owns that query.

The generation phase can therefore re-create the same collision problem that Fase 2 was added to solve.

Real examples from the run included:

* the Wax interview attempting to switch to `pratiche BDSM per principianti`, already assigned elsewhere;
* two Truth or Drink videos independently attempting to use `parlare di sesso con i genitori`, which was already owned by the Chadia Rodriguez video.

The guard groups final keyword choices by canonical form and checks the catalogue again.

When an override conflicts with an existing assignment, the override is rejected and flagged:

```text
override_rifiutato
```

Additional collisions detected at this stage are reassigned and flagged:

```text
riassegnato_da_collisione
```

A final verification pass then recounts the canonical keyword assignments and reports any residual duplicates instead of assuming that the correction step succeeded.

**Run result:**

* 12 LLM overrides rejected;
* 2 additional collisions resolved.

The tradeoff is that rejecting an override can return a video to a weaker or more generic target. I preferred keeping keyword ownership unique rather than silently publishing multiple videos against the same canonical query.

![TITLE COMPARISON](images_mysecretcase/guard_code.png)

### 8. Output

`Guard → Merge (input 1)`
`IF false branch → Merge (input 2)`
`Merge (append) → Normalize (Code) → Convert to File (XLSX)`

The two branches have different shapes:

* failed rows never receive the Fase 3 fields;
* processed rows go through generation and the final guard.

A normalization Code node writes every final column explicitly, using empty values where a field does not exist.

It also:

* flattens `keyword_secondarie` into a pipe-separated value;
* restores required source metadata;
* sorts processed rows by status and views;
* keeps manual-review rows in the final deliverable.

**Final output: 399 rows.**

![TITLE COMPARISON](images_mysecretcase/FULL_RESULT_SHEET.png)

---

## Scaling and debugging

A large part of the task was getting the workflow to survive the complete catalogue rather than only a small test.

### Rate limiting

The working setup used n8n HTTP Request batching:

```text
1 item / 5000 ms
```

I initially tried placing a Wait node after the HTTP Request.

That did not throttle the calls as expected because n8n processed the HTTP Request node across the incoming items before those items reached the Wait node.

Moving the delay into the HTTP Request node's own batching settings solved the issue.

With the limits available to the account during the run, a full LLM phase took roughly 30–32 minutes.

### Model attempts

Several model configurations were tried during development:

* `gemini-2.5-flash` — the free-tier quota available during the run was exhausted;
* `gemini-2.0-flash` — a separate quota bucket was also exhausted;
* `gemini-2.5-flash-lite` — returned a model-availability error for the API key being used;
* `gemini-flash-lite-latest` — was the working model alias used for the completed run.

The workflow used the `-latest` alias to avoid pinning the demo to the particular Flash-Lite version available at that moment.

The alias can move to newer model versions over time, so model availability, parameters and behaviour should be checked again before re-running the workflow.

### Why raw HTTP Request

I used n8n's generic HTTP Request node rather than the pre-built Gemini node because I wanted direct access to the request body, including:

* `responseSchema`;
* safety settings;
* model parameters.

The workflow still contains `temperature` and `thinkingConfig` parameters used while testing different model generations.

They are not treated as the mechanism that makes the response reliable.

For this pipeline, the important structural control is the response schema; the deterministic phases are what enforce catalogue-level rules.

### Retry and parse handling

The HTTP node uses retry-on-failure and continues after row-level errors so one bad request does not destroy a long catalogue run.

The parsing step catches invalid responses and stores diagnostic information such as:

* `_parse_error`;
* `finishReason`;
* `blockReason`.

The failed row therefore stays inspectable instead of becoming an unexplained `null`.

---

## Results and validation

The final run produced:

|                                         |                       |
| --------------------------------------- | --------------------: |
| Videos ingested                         |                   399 |
| Successfully enriched in Fase 1         |                   391 |
| Blocked by `PROHIBITED_CONTENT`         |                     8 |
| Generic keyword after Fase 2            | ~8% of processed rows |
| LLM overrides rejected by final guard   |                    12 |
| Additional collisions resolved by guard |                     2 |
| Final XLSX rows                         |                   399 |
| Fase 1 input tokens                     |                 ~1.3M |
| Average Fase 1 input tokens/video       |                ~3,233 |
| Total LLM calls                         |                   790 |

The 12 rejected overrides were manually inspected and corresponded to actual keyword collisions in the generated output.

The final guard exists because these conflicts were found in the real run, not because they were assumed in advance.

---

## Error handling

Eight of the 399 videos returned `PROHIBITED_CONTENT`.

These were porn-reaction videos whose transcripts describe explicit scenes in detail.

Those rows are not deleted.

They are marked:

```text
da_processare_manualmente
```

and carried into the final spreadsheet.

The final deliverable therefore accounts for the complete 399-row input even though only 391 videos completed the LLM stages.

Other operational failures are handled through:

| Situation                              | Behaviour                                 |
| -------------------------------------- | ----------------------------------------- |
| Temporary request failure              | Automatic retry                           |
| Unparseable model response             | Error details stored on the row           |
| Fase 1 blocked video                   | Retained and marked for manual processing |
| LLM keyword override creates collision | Override rejected and flagged             |
| Additional final collision             | Reassigned and flagged                    |
| Overlong generated title               | Deterministically shortened and flagged   |
| Missing fields between branches        | Normalized before XLSX export             |

---

## Keyword ownership tradeoff

Global deduplication solves one problem but creates another.

If several highly related videos compete for the same set of useful queries, only one can keep each canonical target.

The remaining video may receive a less attractive keyword even if the original candidate was semantically better.

In this run, around **8% of processed videos** were still assigned a generic keyword after the deterministic rescue step.

The current workflow therefore prioritizes:

```text
unique catalogue ownership
```

over:

```text
best isolated keyword for every individual video
```

without claiming that those are always the same thing.

With real search-volume and difficulty data, the ownership stage could make a better decision about which video should receive each contested query.

---

## Possible improvement: propagate keyword ownership into Fase 3

A weakness in the current Fase 2 → Fase 3 handoff is that `keyword_secondarie[]` does not tell the model whether each alternative is already owned elsewhere.

The model therefore sees something like:

```text
keyword_target: X

keyword_secondarie:
- A
- B
- C
```

but not:

```text
keyword_target: X

keyword_secondarie:
- A — occupied
- B — unclaimed
- C — occupied
```

A later version could propagate that ownership metadata into the generation prompt.

The model could then keep the assigned keyword by default and only choose an unclaimed alternative when it is clearly more specific.

This would reduce avoidable overrides, although it would not remove the need for the final global guard.

Two videos are still processed independently in Fase 3 and could both select the same previously unclaimed keyword, or generate phrases that collapse to the same canonical form.

---

## Limitations and possible improvements

### No real keyword volume or difficulty data

The task had no budget for Ahrefs, SEMrush, DataForSEO or a similar source.

Candidate keywords are inferred from transcript content rather than selected from measured search-volume and keyword-difficulty data.

With a paid source I would use those metrics when deciding ownership of contested keywords.

### No SERP measurement

The pipeline produces a catalogue-level SEO proposal.

It does **not** demonstrate that rankings or traffic improved.

That would require publishing the changes and tracking the videos over time.

### Lexical rather than semantic collision detection

The current canonicalization catches many wording variations, but it is not semantic clustering.

For example:

```text
confessioni sessuali
confessioni sessuali anonime
confessioni intime anonime
racconti intimi anonimi
racconti erotici reali
```

may represent overlapping search intent without sharing enough lexical structure to be treated as one query family.

The same problem appears with variants such as:

```text
come squirtare
come squirtare consigli
```

and:

```text
come prepararsi al sesso anale
preparazione sesso anale igiene
```

A stronger version could use embeddings followed by clustering or similarity thresholds before the deterministic ownership stage.

### Description generation

Descriptions try to insert the selected keyword naturally.

This works well when the keyword is already a normal Italian phrase, but becomes awkward for keyword forms such as:

```text
coaguli mestruali cause
orgasmo capezzoli come fare
```

I built a second pass that allows the words inside the keyword to be reordered grammatically, but the available free-tier quota ended before I could run it across the complete catalogue.

The detector currently flags 86 possible rows and is intentionally loose: some of them are likely acceptable already.

The regeneration node remains in the workflow but disabled.

### Free-tier constraints

The task was completed using free-tier APIs.

The practical constraints were request quotas and throughput rather than code execution.

For a larger or recurring workload I would re-evaluate the model, quota tier and batch-processing options rather than keeping the demo's fixed throttling settings.

### Google Sheets integration

The final Google Sheets write was not automated during the selection task.

The required Google Cloud setup was still pending payment-method verification, so the workflow exports XLSX for direct import instead.

### Data privacy

The demo used the Gemini free tier with business transcript data.

For a production deployment, data handling and provider terms would need to be reviewed before sending business content to an external model API.

A paid API deployment, Vertex AI, or an appropriate self-hosted model would be options depending on the privacy requirements.

### Dataset count

The supplied catalogue produced **399 data rows rather than the expected ~400**.

I did not investigate whether the difference came from an empty trailing row, header handling, or the original export, so I keep the actual processed count rather than claiming 400.

---

## SEO choices

The generated copy follows a few basic constraints used for this task:

* prefer less explicit phrasing where it preserves the same intent;
* front-load the target keyword where possible;
* keep titles natural rather than filling them with keyword variants;
* avoid unnecessary caps, emoji and clickbait;
* place the keyword and main hook early in the description.

These are generation rules used by the demo, not measured evidence of ranking improvement.

---

## Key Techniques

The final workflow handles the complete path from source catalogue to reviewable XLSX:

```text
XLSX ingest
→ per-video transcript analysis
→ global keyword assignment
→ SEO copy generation
→ deterministic title checks
→ final catalogue collision validation
→ failed-row merge
→ normalized XLSX output
```

The main issue discovered during development was that solving a global constraint once is not enough when a later per-item model call is allowed to modify the constrained value.

That is why keyword ownership is checked again after generation instead of trusting the previous stage.

## Updates
Added EVAL HARNESS
