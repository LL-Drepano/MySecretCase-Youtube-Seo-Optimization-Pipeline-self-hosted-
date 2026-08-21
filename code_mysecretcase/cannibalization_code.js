// =============================================================================
// FASE 2 — Normalize clusters + resolve keyword cannibalization
// =============================================================================
//
// n8n mode: Run Once for All Items
// API calls: 0
//
// Responsibilities:
//   1. Rejoin Views from the original XLSX.
//   2. Normalize cluster labels.
//   3. Canonicalize keyword candidates for collision detection.
//   4. Assign contested keywords globally.
//   5. Give unassigned videos the best available alternative.
//   6. Rescue videos stranded on generic keywords when a better free candidate exists.
//   7. Emit both successfully processed and failed rows.
//
// Important:
//   Fase 2 tries to keep one canonical head keyword per video.
//   If a video reaches the leftover stage and every candidate it has is already
//   owned, a collision is unavoidable without inventing a new keyword.
//   In that case we choose the least-conflicted fallback and let the final
//   collision guard resolve it after Fase 3.
// =============================================================================

const items = $input.all();

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
 * It is useful for titles, where we want to compare all meaningful
 * keyword tokens against the complete title vocabulary.
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
 *
 * Steps:
 *   1. lowercase;
 *   2. remove accents;
 *   3. remove punctuation;
 *   4. split into tokens;
 *   5. remove Italian stopwords;
 *   6. sort tokens alphabetically;
 *   7. join them back into one string.
 *
 * Examples:
 *
 *   "Come fare la spagnola"
 *     -> "fare spagnola"
 *
 *   "La spagnola: come fare"
 *     -> "fare spagnola"
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
 * Measure how much of a keyword is explicitly represented in the title.
 *
 * The score is normalized by keyword length:
 *
 *   matched keyword tokens / total keyword tokens
 *
 * This avoids favouring a six-token keyword merely because it can match
 * more absolute tokens than a highly-specific two-token keyword.
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
 * Title relevance is the dominant signal.
 * Views only break close ties.
 *
 * Formula:
 *
 *   title overlap percentage
 *   +
 *   log10(views + 10)
 *
 * The +10 is intentional and MUST stay identical in Fase 2 and Fase 3.5.
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
 * Load Views from the original XLSX node and index them by URL.
 *
 * Fase 1 output does not necessarily carry Views through every node,
 * so Fase 2 restores them here for the popularity tiebreak.
 *
 * If the source node cannot be read, the workflow continues with Views = 0.
 */
function loadViewsByUrl(sourceNodeName) {
  const viewsByUrl = new Map();

  try {
    for (const item of $(sourceNodeName).all()) {
      const url = String(item.json.URL ?? '').trim();

      if (!url) continue;

      viewsByUrl.set(
        url,
        Math.max(0, Number(item.json.Views) || 0),
      );
    }
  } catch (error) {
    // Deliberately continue.
    // Missing source statistics should not destroy the deterministic pass.
  }

  return viewsByUrl;
}


const viewsByUrl = loadViewsByUrl(SOURCE_NODE_NAME);


// =============================================================================
// CLUSTER NORMALIZATION
// =============================================================================

const CLUSTER_NORMALIZATION_MAP = {
  anatomia_sessuale: 'salute_sessuale',
  masturbazione: 'educazione_sessuale',
  lubrificanti: 'sex_toys',

  // Deliberately kept distinct:
  //
  // educazione_sessuale
  // salute_sessuale
  // relazioni_coppia
  // sex_toys
  // esperienze_personali
  // sessualita_trans
  // bdsm_kink
  // sesso_anale
};


/**
 * Normalize only the cluster variants explicitly known to be equivalent.
 */
function normalizeCluster(cluster) {
  if (!cluster) {
    return 'non_classificato';
  }

  return CLUSTER_NORMALIZATION_MAP[cluster] || cluster;
}


// =============================================================================
// CANDIDATE PREPARATION
// =============================================================================

/**
 * Convert the model's raw keyword candidates into canonicalized candidates.
 *
 * Multiple raw candidates can collapse to the same canonical keyword.
 * We keep only the first representation of each canonical form so one video
 * cannot artificially increase a keyword's "contested" count by proposing
 * the same query several times with slightly different wording.
 */
function buildUniqueKeywordCandidates(rawCandidates) {
  const candidatesByCanonicalKey = new Map();

  for (const rawKeyword of rawCandidates || []) {
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
 * Split the input into:
 *
 *   videos -> usable rows with valid keyword candidates;
 *   failed -> parse failures / blocked rows / unusable rows.
 */
function prepareVideosForAssignment(inputItems, sourceViewsByUrl) {
  const videos = [];
  const failed = [];

  for (const item of inputItems) {
    const row = item.json;

    if (
      row._parse_error ||
      !Array.isArray(row.keyword_candidate) ||
      row.keyword_candidate.length === 0
    ) {
      failed.push(row);
      continue;
    }

    const candidates = buildUniqueKeywordCandidates(row.keyword_candidate);

    // The array can exist but canonicalization can still remove everything.
    if (candidates.length === 0) {
      failed.push(row);
      continue;
    }

    const url = String(row.URL ?? '').trim();

    videos.push({
      source: row,

      url,
      title: String(row.titolo_originale ?? ''),

      clusterNormalized: normalizeCluster(row.cluster),

      views: sourceViewsByUrl.get(url) ?? 0,

      candidates,

      assignedKey: null,
      assignedRaw: null,

      rescued: false,
    });
  }

  return {
    videos,
    failed,
  };
}


const {
  videos,
  failed,
} = prepareVideosForAssignment(items, viewsByUrl);


// =============================================================================
// GLOBAL KEYWORD INDEX
// =============================================================================

/**
 * Build:
 *
 *   canonical keyword -> videos that proposed it
 *
 * Because candidates were already deduplicated per video, each video can
 * appear only once for each canonical keyword.
 */
function buildKeywordContendersIndex(videoRows) {
  const contendersByKeyword = new Map();

  for (const video of videoRows) {
    for (const candidate of video.candidates) {
      if (!contendersByKeyword.has(candidate.key)) {
        contendersByKeyword.set(candidate.key, []);
      }

      contendersByKeyword.get(candidate.key).push(video);
    }
  }

  return contendersByKeyword;
}


const contendersByKeyword = buildKeywordContendersIndex(videos);


// =============================================================================
// INITIAL GLOBAL ASSIGNMENT
// =============================================================================

/**
 * Assign the most contested keywords first.
 *
 * For each keyword:
 *   - ignore videos that already won another keyword;
 *   - rank the remaining contenders using calculateClaimStrength();
 *   - use URL as a deterministic final tie-break;
 *   - award the keyword to the strongest contender.
 *
 * Returns the set of canonical keywords currently claimed.
 */
function assignMostContestedKeywords(videoRows, keywordIndex) {
  const claimedKeywords = new Set();

  const keywordsByContention = [...keywordIndex.entries()]
    .sort(([keyA, videosA], [keyB, videosB]) => {
      const contentionDifference = videosB.length - videosA.length;

      if (contentionDifference !== 0) {
        return contentionDifference;
      }

      return keyA.localeCompare(keyB);
    });

  for (const [keywordKey, keywordContenders] of keywordsByContention) {
    if (claimedKeywords.has(keywordKey)) {
      continue;
    }

    const unassignedContenders = keywordContenders
      .filter((video) => !video.assignedKey);

    if (unassignedContenders.length === 0) {
      continue;
    }

    unassignedContenders.sort((videoA, videoB) => {
      const scoreA = calculateClaimStrength(
        videoA.title,
        videoA.views,
        keywordKey,
      );

      const scoreB = calculateClaimStrength(
        videoB.title,
        videoB.views,
        keywordKey,
      );

      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      return videoA.url.localeCompare(videoB.url);
    });

    const winner = unassignedContenders[0];

    const winningCandidate = winner.candidates
      .find((candidate) => candidate.key === keywordKey);

    winner.assignedKey = keywordKey;
    winner.assignedRaw = winningCandidate.raw;

    claimedKeywords.add(keywordKey);
  }

  return claimedKeywords;
}


const claimedKeywords = assignMostContestedKeywords(
  videos,
  contendersByKeyword,
);


// =============================================================================
// LEFTOVER ASSIGNMENT
// =============================================================================

/**
 * Rank currently-unclaimed candidates for one video.
 *
 * Preference:
 *   1. lower global contention;
 *   2. stronger title relevance;
 *   3. deterministic lexical tie-break.
 */
function chooseBestUnclaimedCandidate(
  video,
  currentlyClaimedKeywords,
  keywordIndex,
) {
  const availableCandidates = video.candidates
    .filter((candidate) => !currentlyClaimedKeywords.has(candidate.key));

  if (availableCandidates.length === 0) {
    return null;
  }

  availableCandidates.sort((candidateA, candidateB) => {
    const contentionA =
      keywordIndex.get(candidateA.key)?.length ?? Number.MAX_SAFE_INTEGER;

    const contentionB =
      keywordIndex.get(candidateB.key)?.length ?? Number.MAX_SAFE_INTEGER;

    if (contentionA !== contentionB) {
      return contentionA - contentionB;
    }

    const scoreA = calculateClaimStrength(
      video.title,
      video.views,
      candidateA.key,
    );

    const scoreB = calculateClaimStrength(
      video.title,
      video.views,
      candidateB.key,
    );

    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }

    return candidateA.raw.localeCompare(candidateB.raw);
  });

  return availableCandidates[0];
}


/**
 * If every candidate is already owned, a unique assignment is impossible
 * without inventing a new keyword.
 *
 * Instead of pretending uniqueness still exists, choose the least-conflicted
 * existing candidate:
 *
 *   1. lowest number of contenders;
 *   2. strongest title relevance;
 *   3. more specific raw phrase;
 *   4. deterministic lexical tie-break.
 *
 * The final guard can later attempt to move the loser to a free alternative.
 */
function chooseLeastConflictedFallbackCandidate(video, keywordIndex) {
  const rankedCandidates = [...video.candidates]
    .sort((candidateA, candidateB) => {
      const contentionA =
        keywordIndex.get(candidateA.key)?.length ?? Number.MAX_SAFE_INTEGER;

      const contentionB =
        keywordIndex.get(candidateB.key)?.length ?? Number.MAX_SAFE_INTEGER;

      if (contentionA !== contentionB) {
        return contentionA - contentionB;
      }

      const scoreA = calculateClaimStrength(
        video.title,
        video.views,
        candidateA.key,
      );

      const scoreB = calculateClaimStrength(
        video.title,
        video.views,
        candidateB.key,
      );

      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      if (candidateA.raw.length !== candidateB.raw.length) {
        return candidateB.raw.length - candidateA.raw.length;
      }

      return candidateA.raw.localeCompare(candidateB.raw);
    });

  return rankedCandidates[0] ?? null;
}


/**
 * Assign every video that did not win a keyword during the contested pass.
 */
function assignLeftoverVideos(
  videoRows,
  currentlyClaimedKeywords,
  keywordIndex,
) {
  for (const video of videoRows) {
    if (video.assignedKey) {
      continue;
    }

    const freeCandidate = chooseBestUnclaimedCandidate(
      video,
      currentlyClaimedKeywords,
      keywordIndex,
    );

    if (freeCandidate) {
      video.assignedKey = freeCandidate.key;
      video.assignedRaw = freeCandidate.raw;

      currentlyClaimedKeywords.add(freeCandidate.key);

      continue;
    }

    // Every candidate is already owned.
    // This collision is explicit and will be visible to the final guard.
    const fallbackCandidate = chooseLeastConflictedFallbackCandidate(
      video,
      keywordIndex,
    );

    if (!fallbackCandidate) {
      continue;
    }

    video.assignedKey = fallbackCandidate.key;
    video.assignedRaw = fallbackCandidate.raw;
  }
}


assignLeftoverVideos(
  videos,
  claimedKeywords,
  contendersByKeyword,
);


// =============================================================================
// GENERIC KEYWORD RESCUE
// =============================================================================

const GENERIC_KEYWORDS_RAW = [
  'come migliorare la vita sessuale di coppia',
  'come migliorare la vita sessuale',

  "consigli per migliorare l'intimità di coppia",
  "come migliorare l'intimità di coppia",
  "consigli per migliorare l'intimità",

  'guida al piacere femminile',

  'consigli per una vita sessuale appagante',
  'consigli su vita sessuale',
  'consigli su come vivere la sessualità',

  'consigli per posizioni sessuali',
  'guida posizioni sessuali',
  'posizioni sessuali di coppia',
  'posizioni sessuali per principianti',

  'idee per ravvivare la vita di coppia',

  "consigli per l'intimità di coppia",
  'esplorare la propria sessualità',
  "come migliorare l'intesa sessuale",

  'consigli per migliorare la vita sessuale di coppia',

  'consigli per una relazione sana',
  'consigli su relazioni di coppia',
  'consigli per migliorare la vita di coppia',

  'posizioni sessuali consigliate',
];


const GENERIC_KEYWORDS = new Set(
  GENERIC_KEYWORDS_RAW.map(canonicalizeKeyword),
);


/**
 * Check whether a canonical keyword is currently owned by another video.
 *
 * Unlike the old `claimed` Set approach, this remains correct even if
 * upstream fallback assignments temporarily created duplicate ownership.
 */
function isKeywordOwnedByAnotherVideo(videoRows, currentVideo, keywordKey) {
  return videoRows.some(
    (otherVideo) =>
      otherVideo !== currentVideo &&
      otherVideo.assignedKey === keywordKey,
  );
}


/**
 * Rescue videos currently assigned to a generic keyword.
 *
 * A replacement candidate must:
 *   - be non-generic;
 *   - not already be owned by another video;
 *   - match the title better than the current generic keyword.
 */
function rescueGenericKeywordAssignments(videoRows) {
  let rescuedCount = 0;

  for (const video of videoRows) {
    if (!GENERIC_KEYWORDS.has(video.assignedKey)) {
      continue;
    }

    const currentOverlap = calculateKeywordTitleOverlapRatio(
      video.title,
      video.assignedKey,
    );

    const possibleReplacements = video.candidates
      .filter((candidate) => candidate.key !== video.assignedKey)
      .filter((candidate) => !GENERIC_KEYWORDS.has(candidate.key))
      .filter(
        (candidate) =>
          !isKeywordOwnedByAnotherVideo(
            videoRows,
            video,
            candidate.key,
          ),
      )
      .map((candidate) => ({
        candidate,
        overlap: calculateKeywordTitleOverlapRatio(
          video.title,
          candidate.key,
        ),
      }))
      .filter(
        ({ overlap }) =>
          overlap > 0 &&
          overlap > currentOverlap,
      )
      .sort((optionA, optionB) => {
        if (optionA.overlap !== optionB.overlap) {
          return optionB.overlap - optionA.overlap;
        }

        const scoreA = calculateClaimStrength(
          video.title,
          video.views,
          optionA.candidate.key,
        );

        const scoreB = calculateClaimStrength(
          video.title,
          video.views,
          optionB.candidate.key,
        );

        if (scoreA !== scoreB) {
          return scoreB - scoreA;
        }

        return optionA.candidate.raw.localeCompare(
          optionB.candidate.raw,
        );
      });

    const bestReplacement = possibleReplacements[0];

    if (!bestReplacement) {
      continue;
    }

    video.assignedKey = bestReplacement.candidate.key;
    video.assignedRaw = bestReplacement.candidate.raw;
    video.rescued = true;

    rescuedCount += 1;
  }

  return rescuedCount;
}


const rescuedCount = rescueGenericKeywordAssignments(videos);


// =============================================================================
// OUTPUT
// =============================================================================

/**
 * Convert successful internal video objects into the shape expected by Fase 3.
 */
function buildSuccessfulOutputRow(video) {
  return {
    URL: video.url,

    titolo_originale: video.source.titolo_originale,
    lingua_video: video.source.lingua_video,

    topic_principale: video.source.topic_principale,
    cluster: video.clusterNormalized,
    search_intent: video.source.search_intent,

    keyword_target: video.assignedRaw,

    keyword_secondarie: video.candidates
      .filter((candidate) => candidate.key !== video.assignedKey)
      .slice(0, 3)
      .map((candidate) => candidate.raw),

    keyword_rescued: Boolean(video.rescued),

    stato: 'ok',
  };
}


/**
 * Preserve failed / blocked rows instead of silently dropping them.
 */
function buildFailedOutputRow(row) {
  return {
    URL: row.URL,

    titolo_originale: row.titolo_originale,
    lingua_video: row.lingua_video,

    topic_principale: row.topic_principale || null,
    cluster: normalizeCluster(row.cluster),
    search_intent: row.search_intent || null,

    keyword_target: null,
    keyword_secondarie: [],

    stato: 'da_processare_manualmente',
  };
}


const output = [
  ...videos.map((video) => ({
    json: buildSuccessfulOutputRow(video),
  })),

  ...failed.map((row) => ({
    json: buildFailedOutputRow(row),
  })),
];


console.log(JSON.stringify({
  righe_input: items.length,
  righe_processabili: videos.length,
  righe_manuali: failed.length,
  keyword_rescued: rescuedCount,
}, null, 2));


return output;
