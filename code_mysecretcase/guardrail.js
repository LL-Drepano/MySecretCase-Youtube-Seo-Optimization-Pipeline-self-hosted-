// =============================================================================
// FASE 3.5 — Final keyword collision guard
// =============================================================================
//
// Place: after "Parse Fase 3", before the Fase 4 Merge.
// n8n mode: Run Once for All Items
// API calls: 0
//
// Why this exists:
//
//   Fase 2 assigns keywords using the complete catalogue.
//
//   Fase 3 is allowed to replace keyword_target with one of the video's
//   keyword_secondarie, but Fase 3 processes one video at a time.
//
//   A locally-better override can therefore select a keyword already owned by
//   another video.
//
// This node:
//   1. restores Views;
//   2. detects real overrides using canonical keyword equality;
//   3. rejects overrides that collide with another final keyword;
//   4. recomputes the complete catalogue after those reverts;
//   5. resolves remaining collisions using free alternatives;
//   6. verifies the final uniqueness invariant;
//   7. cleans titles that were truncated onto Italian function words.
// =============================================================================


const SOURCE_NODE_NAME = 'Extract from File';


// =============================================================================
// SHARED KEYWORD NORMALIZATION
//
// Keep this block identical in Fase 2 and Fase 3.5.
// =============================================================================

const STOPWORDS = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le',
  'un', 'uno', 'una',

  'del', 'dello', 'della', 'dei', 'degli', 'delle',
  'al', 'allo', 'alla', 'ai', 'agli', 'alle',
  'dal', 'dalla',
  'nel', 'nella',
  'sul', 'sulla',

  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra',

  'e', 'ed', 'o',

  'che', 'come', 'cosa',
  'si', 'ci',
  'non', 'se', 'ma',

  'piu',

  'sono', 'fa', 'ha',
  'quali', 'quando', 'perche',
]);


/**
 * Remove accents while leaving the rest of the text untouched.
 *
 * Example:
 *   "più" -> "piu"
 */
function removeAccents(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}


/**
 * Convert arbitrary text into lowercase alphanumeric tokens.
 *
 * This does NOT remove stopwords.
 */
function tokenizeText(value) {
  const normalized = removeAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim();

  if (!normalized) return [];

  return normalized
    .split(/\s+/)
    .filter(Boolean);
}


/**
 * Convert a keyword into the canonical representation used everywhere
 * for ownership and collision detection.
 */
function canonicalizeKeyword(keyword) {
  return tokenizeText(keyword)
    .filter((token) => !STOPWORDS.has(token))
    .sort()
    .join(' ');
}


/**
 * Return the canonical keyword as an array of tokens.
 */
function getCanonicalKeywordTokens(keyword) {
  const canonicalKeyword = canonicalizeKeyword(keyword);

  return canonicalKeyword
    ? canonicalKeyword.split(' ')
    : [];
}


/**
 * Measure what fraction of a keyword is represented in the title.
 *
 * Returns a value between 0 and 1.
 */
function calculateKeywordTitleOverlapRatio(title, keyword) {
  const keywordTokens = getCanonicalKeywordTokens(keyword);

  if (keywordTokens.length === 0) {
    return 0;
  }

  const titleTokens = new Set(tokenizeText(title));

  let matchingTokens = 0;

  for (const token of keywordTokens) {
    if (titleTokens.has(token)) {
      matchingTokens += 1;
    }
  }

  return matchingTokens / keywordTokens.length;
}


/**
 * Calculate how strongly a video should claim a keyword.
 *
 * IMPORTANT:
 * This formula is deliberately identical to Fase 2.
 *
 *   title overlap percentage
 *   +
 *   log10(views + 10)
 */
function calculateClaimStrength(title, views, keyword) {
  const titleOverlapPercentage =
    calculateKeywordTitleOverlapRatio(title, keyword) * 100;

  const safeViews = Math.max(0, Number(views) || 0);
  const popularityTieBreak = Math.log10(safeViews + 10);

  return titleOverlapPercentage + popularityTieBreak;
}


// =============================================================================
// SOURCE METADATA
// =============================================================================

/**
 * Rejoin Views from the original XLSX using URL as the key.
 */
function loadViewsByUrl(sourceNodeName) {
  const viewsByUrl = new Map();

  for (const item of $(sourceNodeName).all()) {
    const url = String(item.json.URL ?? '').trim();

    if (!url) continue;

    viewsByUrl.set(
      url,
      Math.max(0, Number(item.json.Views) || 0),
    );
  }

  return viewsByUrl;
}


const viewsByUrl = loadViewsByUrl(SOURCE_NODE_NAME);


// =============================================================================
// ROW PREPARATION
// =============================================================================

/**
 * Prepare every Fase 3 row for global validation.
 *
 * A model choice counts as a real override only if its CANONICAL form differs
 * from keyword_target.
 *
 * This prevents superficial differences such as punctuation, accents,
 * stopwords or token order from being treated as semantic overrides.
 */
function prepareRowsForCollisionValidation(inputItems, sourceViewsByUrl) {
  return inputItems.map((item) => {
    const row = {
      ...item.json,
    };

    const url = String(row.URL ?? '').trim();

    row.Views = sourceViewsByUrl.get(url) ?? 0;

    const targetCanonical =
      canonicalizeKeyword(row.keyword_target);

    const chosenCanonical =
      canonicalizeKeyword(row.keyword_scelta);

    row.override_llm =
      Boolean(chosenCanonical) &&
      chosenCanonical !== targetCanonical;

    row.override_rifiutato = false;
    row.riassegnato_da_collisione = false;
    row.collisione_irrisolta = false;

    // Ignore an unusable model keyword and fall back to the deterministic one.
    row.keyword_finale =
      chosenCanonical
        ? row.keyword_scelta
        : row.keyword_target;

    return row;
  });
}


const rows = prepareRowsForCollisionValidation(
  $input.all(),
  viewsByUrl,
);


// =============================================================================
// GROUPING HELPERS
// =============================================================================

/**
 * Group rows by the canonical form of keyword_finale.
 *
 * Empty keywords are ignored.
 */
function groupRowsByFinalCanonicalKeyword(currentRows) {
  const groups = new Map();

  for (const row of currentRows) {
    const canonicalKeyword =
      canonicalizeKeyword(row.keyword_finale);

    if (!canonicalKeyword) {
      continue;
    }

    if (!groups.has(canonicalKeyword)) {
      groups.set(canonicalKeyword, []);
    }

    groups.get(canonicalKeyword).push(row);
  }

  return groups;
}


/**
 * Select the strongest claimant for the keyword currently shared by a group.
 *
 * If one or more videos are currently using their Fase 2 keyword_target,
 * they are incumbents and outrank LLM overrides.
 *
 * Claim strength breaks ties among the eligible pool.
 */
function chooseCollisionWinner(group) {
  const incumbents = group.filter((row) => {
    return (
      canonicalizeKeyword(row.keyword_finale) ===
      canonicalizeKeyword(row.keyword_target)
    );
  });

  const eligibleRows =
    incumbents.length > 0
      ? incumbents
      : group;

  return [...eligibleRows]
    .sort((rowA, rowB) => {
      const scoreA = calculateClaimStrength(
        rowA.titolo_originale,
        rowA.Views,
        rowA.keyword_finale,
      );

      const scoreB = calculateClaimStrength(
        rowB.titolo_originale,
        rowB.Views,
        rowB.keyword_finale,
      );

      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      return String(rowA.URL ?? '')
        .localeCompare(String(rowB.URL ?? ''));
    })[0];
}


// =============================================================================
// PASS 1 — REJECT CONFLICTING LLM OVERRIDES
// =============================================================================

/**
 * Reject LLM overrides that create a collision.
 *
 * Rules:
 *
 *   collision containing an incumbent:
 *     incumbent wins, colliding overrides revert;
 *
 *   collision containing only overrides:
 *     strongest override survives, the other overrides revert.
 *
 * Reverting can expose another collision if Fase 2 already had duplicate
 * ownership, so we explicitly recompute the complete catalogue afterwards.
 */
function rejectConflictingOverrides(currentRows) {
  const groups =
    groupRowsByFinalCanonicalKeyword(currentRows);

  let rejectedOverrides = 0;

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const winner = chooseCollisionWinner(group);

    for (const row of group) {
      if (row === winner) {
        continue;
      }

      if (!row.override_llm) {
        continue;
      }

      const targetCanonical =
        canonicalizeKeyword(row.keyword_target);

      // If there is no usable deterministic target, there is nothing
      // meaningful to revert to. Leave it for Pass 2.
      if (!targetCanonical) {
        continue;
      }

      row.keyword_finale = row.keyword_target;
      row.override_rifiutato = true;

      rejectedOverrides += 1;
    }
  }

  return rejectedOverrides;
}


const rejectedOverrideCount =
  rejectConflictingOverrides(rows);


// =============================================================================
// PASS 2 — RESOLVE ALL REMAINING COLLISIONS
// =============================================================================

/**
 * Build unique alternative candidates for one row.
 *
 * The deterministic target is included first, followed by secondaries.
 * Duplicate canonical forms are removed.
 */
function buildAlternativeKeywordCandidates(row) {
  const rawCandidates = [
    row.keyword_target,
    ...(Array.isArray(row.keyword_secondarie)
      ? row.keyword_secondarie
      : []),
  ];

  const candidatesByCanonicalKey = new Map();

  for (const rawKeyword of rawCandidates) {
    const raw = String(rawKeyword ?? '').trim();
    const key = canonicalizeKeyword(raw);

    if (!raw || !key) continue;

    if (!candidatesByCanonicalKey.has(key)) {
      candidatesByCanonicalKey.set(key, {
        raw,
        key,
      });
    }
  }

  return [...candidatesByCanonicalKey.values()];
}


/**
 * Find the best currently-unclaimed alternative for a collision loser.
 *
 * The current colliding keyword is excluded.
 *
 * Alternatives are ranked using the SAME claim-strength calculation used
 * in Fase 2.
 */
function findBestAvailableAlternative(
  row,
  claimedCanonicalKeywords,
) {
  const currentCanonical =
    canonicalizeKeyword(row.keyword_finale);

  const availableCandidates =
    buildAlternativeKeywordCandidates(row)
      .filter(
        (candidate) =>
          candidate.key !== currentCanonical,
      )
      .filter(
        (candidate) =>
          !claimedCanonicalKeywords.has(candidate.key),
      );

  if (availableCandidates.length === 0) {
    return null;
  }

  availableCandidates.sort((candidateA, candidateB) => {
    const scoreA = calculateClaimStrength(
      row.titolo_originale,
      row.Views,
      candidateA.raw,
    );

    const scoreB = calculateClaimStrength(
      row.titolo_originale,
      row.Views,
      candidateB.raw,
    );

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    return candidateA.raw.localeCompare(candidateB.raw);
  });

  return availableCandidates[0];
}


/**
 * Resolve every collision that remains after override rejection.
 *
 * This includes:
 *   - duplicate incumbents inherited from Fase 2;
 *   - collisions exposed when an override reverts;
 *   - any other residual duplicate.
 *
 * Each group keeps one winner.
 *
 * Every loser is moved only to a currently-unclaimed alternative,
 * so this pass cannot create a new collision elsewhere.
 *
 * If no free candidate exists, the row remains on the collision and is
 * explicitly marked collisione_irrisolta = true.
 */
function resolveRemainingKeywordCollisions(currentRows) {
  const groups =
    groupRowsByFinalCanonicalKeyword(currentRows);

  const claimedCanonicalKeywords = new Set(
    [...groups.keys()],
  );

  let reassignedRows = 0;

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }

    const winner = chooseCollisionWinner(group);

    winner.collisione_irrisolta = false;

    for (const row of group) {
      if (row === winner) {
        continue;
      }

      const replacement =
        findBestAvailableAlternative(
          row,
          claimedCanonicalKeywords,
        );

      if (!replacement) {
        row.collisione_irrisolta = true;
        continue;
      }

      row.keyword_finale = replacement.raw;
      row.riassegnato_da_collisione = true;
      row.collisione_irrisolta = false;

      claimedCanonicalKeywords.add(
        replacement.key,
      );

      reassignedRows += 1;
    }
  }

  return reassignedRows;
}


const reassignedCollisionCount =
  resolveRemainingKeywordCollisions(rows);


// =============================================================================
// PASS 3 — CLEAN TRUNCATED TITLES
// =============================================================================

const TRAILING_FUNCTION_WORD_PATTERN =
  /\s+(?:e|ed|o|a|ad|da|di|del|dello|della|dei|degli|delle|al|allo|alla|ai|agli|alle|con|per|tra|fra|in|su|sul|sulla|il|lo|la|i|gli|le|un|uno|una|che|come|se|ma|non|piu|più|senza|dopo|prima|mio|mia|tuo|tua|suo|sua)$/i;


/**
 * Remove dangling Italian function words repeatedly from the end of a title.
 *
 * Example:
 *
 *   "... guida alla comunicazione di"
 *
 * becomes:
 *
 *   "... guida alla comunicazione"
 */
function removeDanglingFunctionWords(title) {
  let cleanedTitle = String(title ?? '').trim();
  let previousTitle;

  do {
    previousTitle = cleanedTitle;

    cleanedTitle = cleanedTitle
      .replace(TRAILING_FUNCTION_WORD_PATTERN, '')
      .replace(/[\s,;:–—-]+$/, '');

  } while (cleanedTitle !== previousTitle);

  return cleanedTitle;
}


/**
 * Apply cleanup only to titles previously marked as truncated.
 *
 * We keep the cleaned version only if at least 40 characters remain.
 */
function cleanTruncatedTitles(currentRows) {
  let cleanedTitles = 0;

  for (const row of currentRows) {
    if (!row.titolo_troncato) {
      continue;
    }

    const cleanedTitle =
      removeDanglingFunctionWords(
        row.titolo_proposto,
      );

    if (cleanedTitle.length < 40) {
      continue;
    }

    row.titolo_proposto = cleanedTitle;
    row.titolo_lunghezza = cleanedTitle.length;

    // The title was still truncated for length earlier,
    // but it no longer ends in a broken grammatical tail.
    //
    // Keeping the historical behaviour here:
    row.titolo_troncato = false;

    cleanedTitles += 1;
  }

  return cleanedTitles;
}


const cleanedTitleCount =
  cleanTruncatedTitles(rows);


// =============================================================================
// FINAL VERIFICATION
// =============================================================================

/**
 * Recompute the COMPLETE final catalogue after every corrective pass.
 *
 * No intermediate assumption is trusted.
 */
function findResidualKeywordCollisions(currentRows) {
  const groups =
    groupRowsByFinalCanonicalKeyword(currentRows);

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1);
}


const residualCollisions =
  findResidualKeywordCollisions(rows);


// Mark every row that still belongs to a residual collision.
for (const [, group] of residualCollisions) {
  for (const row of group) {
    row.collisione_irrisolta = true;
  }
}


// =============================================================================
// FINAL DIAGNOSTICS
// =============================================================================

const proposedOverrides =
  rows.filter((row) => row.override_llm).length;

const acceptedOverrides =
  rows.filter(
    (row) =>
      row.override_llm &&
      !row.override_rifiutato,
  ).length;


console.log(JSON.stringify({
  righe: rows.length,

  override_proposti: proposedOverrides,
  override_rifiutati: rejectedOverrideCount,
  override_accettati: acceptedOverrides,

  riassegnazioni_da_collisione:
    reassignedCollisionCount,

  collisioni_residue:
    residualCollisions.length,

  esempi_collisioni_residue:
    residualCollisions
      .slice(0, 5)
      .map(([canonicalKeyword, group]) => ({
        keyword: canonicalKeyword,
        urls: group.map((row) => row.URL),
      })),

  titoli_troncati_ripuliti:
    cleanedTitleCount,
}, null, 2));


// =============================================================================
// OUTPUT
// =============================================================================

return rows.map((json) => ({
  json,
}));
