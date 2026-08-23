from pathlib import Path
from collections import Counter
import json
import re
import unicodedata

import pandas as pd


# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
OUTPUT_XLSX = BASE_DIR / "mysecretcase_seo_youtube.xlsx"

# Optional: if the original Phase 0 input file is available, set its path here.
# When provided, record preservation compares the exact URL set input -> output.
SOURCE_XLSX = None

EXPECTED_ROWS = 399
MAX_TITLE_LENGTH = 70

ID_FIELD = "URL"
STATUS_FIELD = "Stato"
OK_STATUS = "ok"
MANUAL_STATUS = "da_processare_manualmente"
KEYWORD_FIELD = "Keyword finale"
TITLE_FIELD = "Titolo proposto"

# Fields expected on rows that completed the AI pipeline.
REQUIRED_FIELDS_OK = [
    "URL",
    "Titolo originale",
    "Cluster",
    "Search intent",
    "Topic principale",
    "Keyword finale",
    "Titolo proposto",
    "Lunghezza titolo",
    "Descrizione proposta",
    "Stato",
    "Keyword assegnata (Fase 2)",
    "Keyword secondarie",
    "Override LLM",
    "Override rifiutato",
    "Collisione irrisolta",
    "Keyword recuperata (Fase 2)",
    "Titolo troncato",
]

# Manual rows are intentionally incomplete: the LLM did not produce SEO copy.
REQUIRED_FIELDS_MANUAL = ["URL", "Titolo originale", "Stato"]

# Same stopword set used by the JS keyword canonicalizer in the pipeline.
STOPWORDS = {
    "il", "lo", "la", "i", "gli", "le", "un", "uno", "una",
    "del", "dello", "della", "dei", "degli", "delle",
    "al", "allo", "alla", "ai", "agli", "alle",
    "dal", "dalla", "nel", "nella", "sul", "sulla",
    "di", "a", "da", "in", "con", "su", "per", "tra", "fra",
    "e", "ed", "o", "che", "come", "cosa", "si", "ci", "non", "piu", "se", "ma",
}


def load_rows(path):
    """Read an XLSX file and return a list of row dictionaries."""
    df = pd.read_excel(path, dtype=object)
    df = df.where(pd.notna(df), None)
    return df.to_dict(orient="records")


def is_blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def normalize_status(value):
    if is_blank(value):
        return ""
    return str(value).strip().lower()


def canonicalize_keyword(keyword):
    """Independent Python reimplementation of the pipeline collision key."""
    text = unicodedata.normalize("NFD", str(keyword).lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    tokens = [token for token in text.split() if token and token not in STOPWORDS]
    return " ".join(sorted(tokens)).strip()


def result(name, passed, summary, issues=None):
    return {
        "name": name,
        "pass": passed,
        "summary": summary,
        "issues": issues or [],
    }


# -----------------------------------------------------------------------------
# Invariant 1: record preservation / identifier integrity
# -----------------------------------------------------------------------------
def check_record_preservation(rows, source_rows=None):
    output_ids = [row.get(ID_FIELD) for row in rows]
    nonblank_output_ids = [value for value in output_ids if not is_blank(value)]
    duplicate_output_ids = [
        value for value, count in Counter(nonblank_output_ids).items() if count > 1
    ]
    missing_id_rows = len(rows) - len(nonblank_output_ids)

    issues = []

    if source_rows is None:
        expected_count = EXPECTED_ROWS
        if len(rows) != expected_count:
            issues.append(
                f"Expected {expected_count} output rows, found {len(rows)}."
            )
    else:
        source_ids = [row.get(ID_FIELD) for row in source_rows]
        source_ids = [value for value in source_ids if not is_blank(value)]
        expected_count = len(source_rows)

        source_set = set(source_ids)
        output_set = set(nonblank_output_ids)

        missing_from_output = sorted(source_set - output_set)
        unexpected_in_output = sorted(output_set - source_set)

        if len(rows) != expected_count:
            issues.append(
                f"Input has {expected_count} rows; output has {len(rows)} rows."
            )
        if missing_from_output:
            issues.append({"missing_from_output": missing_from_output})
        if unexpected_in_output:
            issues.append({"unexpected_in_output": unexpected_in_output})

    if missing_id_rows:
        issues.append(f"{missing_id_rows} output rows have no {ID_FIELD}.")
    if duplicate_output_ids:
        issues.append({"duplicate_output_ids": duplicate_output_ids})

    passed = len(issues) == 0
    summary = (
        f"{len(rows)} rows; {len(nonblank_output_ids)} non-empty IDs; "
        f"{len(set(nonblank_output_ids))} unique IDs"
    )
    return result("Record preservation", passed, summary, issues)


# -----------------------------------------------------------------------------
# Invariant 2: final keyword uniqueness after canonicalization
# -----------------------------------------------------------------------------
def check_keyword_uniqueness(rows):
    groups = {}

    for row in rows:
        if normalize_status(row.get(STATUS_FIELD)) != OK_STATUS:
            continue

        raw_keyword = row.get(KEYWORD_FIELD)
        if is_blank(raw_keyword):
            # Missing required keywords are handled by the required-fields check.
            continue

        key = canonicalize_keyword(raw_keyword)
        owner = {
            "url": row.get(ID_FIELD),
            "keyword": raw_keyword,
        }

        if key in groups:
            groups[key].append(owner)
        else:
            groups[key] = [owner]

    duplicates = []
    for key in groups:
        if len(groups[key]) > 1:
            duplicates.append({
                "canonical_keyword": key,
                "owners": groups[key],
            })

    passed = len(duplicates) == 0
    summary = f"{len(groups)} canonical final keywords; {len(duplicates)} collision groups"
    return result("Keyword uniqueness", passed, summary, duplicates)


# -----------------------------------------------------------------------------
# Invariant 3: final title length
# -----------------------------------------------------------------------------
def check_title_length(rows):
    violations = []
    checked = 0

    for row in rows:
        if normalize_status(row.get(STATUS_FIELD)) != OK_STATUS:
            continue

        title = row.get(TITLE_FIELD)
        if is_blank(title):
            # Missing titles are handled by the required-fields check.
            continue

        checked += 1
        actual_length = len(str(title))

        if actual_length > MAX_TITLE_LENGTH:
            violations.append({
                "url": row.get(ID_FIELD),
                "length": actual_length,
                "title": title,
            })

    passed = len(violations) == 0
    summary = (
        f"{checked} titles checked; {len(violations)} titles over "
        f"{MAX_TITLE_LENGTH} characters"
    )
    return result("Title length", passed, summary, violations)


# -----------------------------------------------------------------------------
# Invariant 4: required fields by row state
# -----------------------------------------------------------------------------
def check_required_fields(rows):
    violations = []

    for row in rows:
        status = normalize_status(row.get(STATUS_FIELD))

        if status == OK_STATUS:
            required_fields = REQUIRED_FIELDS_OK
        elif status == MANUAL_STATUS:
            required_fields = REQUIRED_FIELDS_MANUAL
        else:
            violations.append({
                "url": row.get(ID_FIELD),
                "invalid_status": row.get(STATUS_FIELD),
            })
            continue

        missing = [field for field in required_fields if is_blank(row.get(field))]

        if missing:
            violations.append({
                "url": row.get(ID_FIELD),
                "status": row.get(STATUS_FIELD),
                "missing_fields": missing,
            })

    passed = len(violations) == 0
    summary = f"{len(rows)} rows checked; {len(violations)} rows with structural problems"
    return result("Required fields", passed, summary, violations)


# -----------------------------------------------------------------------------
# Harness runner + aggregated report
# -----------------------------------------------------------------------------
def run_evaluation(output_path, source_path=None):
    rows = load_rows(output_path)
    source_rows = load_rows(source_path) if source_path else None

    metrics = {
        "rows_total": len(rows),
        "rows_ok": sum(
            normalize_status(row.get(STATUS_FIELD)) == OK_STATUS for row in rows
        ),
        "rows_manual": sum(
            normalize_status(row.get(STATUS_FIELD)) == MANUAL_STATUS for row in rows
        ),
    }

    checks = [
        check_record_preservation(rows, source_rows),
        check_keyword_uniqueness(rows),
        check_title_length(rows),
        check_required_fields(rows),
    ]

    report = {
        "overall_pass": all(check["pass"] for check in checks),
        "metrics": metrics,
        "checks": checks,
    }
    return report


def print_report(report):
    print("\n=== MySecretCase Evaluation Harness ===")
    print(
        f"Rows: {report['metrics']['rows_total']} total | "
        f"{report['metrics']['rows_ok']} ok | "
        f"{report['metrics']['rows_manual']} manual"
    )
    print()

    for check in report["checks"]:
        status = "PASS" if check["pass"] else "FAIL"
        print(f"[{status}] {check['name']}: {check['summary']}")

        if not check["pass"]:
            for issue in check["issues"][:10]:
                print(f"       - {issue}")
            if len(check["issues"]) > 10:
                print(f"       - ... {len(check['issues']) - 10} more issue(s)")

    overall = "PASS" if report["overall_pass"] else "FAIL"
    print(f"\nOVERALL: {overall}")


def main():
    if not OUTPUT_XLSX.exists():
        raise FileNotFoundError(
            f"Output file not found: {OUTPUT_XLSX.resolve()}"
        )

    source_path = SOURCE_XLSX if SOURCE_XLSX and Path(SOURCE_XLSX).exists() else None
    report = run_evaluation(OUTPUT_XLSX, source_path)

    print_report(report)

    with open(BASE_DIR / "evaluation_report.json", "w", encoding="utf-8") as file:
        json.dump(report, file, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
