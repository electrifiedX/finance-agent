"""
db/rename_merchants_llm.py — one-time pass that asks the LLM for a clean display name for every
existing merchant (using real brand knowledge: keeps "7-Eleven", strips "F6011"), then MERGES any
merchants that collapse to the same clean name (re-pointing transactions, preserving locked
categories) so we don't end up with two "McDonald's" rows.

Locked merchants keep their human-set name and category (we don't override your decisions); they
still participate in merging as a canonical target if an unlocked merchant cleans to their name.

DRY RUN by default — prints proposed renames + merges, changes nothing.
  python -m db.rename_merchants_llm            # preview
  python -m db.rename_merchants_llm --apply     # do it
Requires DATABASE_URL and ANTHROPIC_API_KEY.
"""

import argparse
import json
import os
import sys
from collections import defaultdict

import psycopg

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from llm.categorize import call_llm  # noqa: E402


_LLM_FAILURE_MARKERS = ("i don't", "i do not", "unable", "cannot", "not a merchant",
                        "insufficient", "i can't", "don't recognize", "no recognizable")

# Merchants that are NOT real businesses — bank transfers, card payments, interest, etc.
# These keep their existing handling and must NOT be renamed/merged by the LLM (it mangles them,
# and merging would mix transfers/payments/cash into fake "businesses").
_SKIP_SUBSTRINGS = ("PAYMENT THANK", "ELECTRONIC PAYMENT", "ONLINE PMT", "CCPYMT", "CRD EPAY",
                    "ACH PAYMENT", "INTERNET TRANSFER", "EXT TRNSFR", "INTEREST CHARGE",
                    "INTEREST CHARGED", "FINANCE CHARGE", "ATM FEE", "CASH BACK", "LATE FEE",
                    "ANNUAL MEMBERSHIP", "REQUESTED TRANSFER", "SYF PAYMNT", "GSBANK PAYMENT",
                    "PLAN FEE", "CHECK PAID", "DIR DEP",
                    # keep descriptive payee info that carries the category clue / stays distinct:
                    "ZELLE PAYMENT", "VENMO", "TESLA ENERGY", "TESLA_US_CAPTIVE",
                    "BRAZOS", "US BANK", "U.S. BANK", "BANK OF AMERICA",
                    "GOOGLE THE BATTLE", "GOOGLE 1 SECOND")


def _is_failure(text: str) -> bool:
    low = text.lower()
    return any(mark in low for mark in _LLM_FAILURE_MARKERS) or len(text) > 50


def _should_skip(name: str, raw: str) -> bool:
    up = (name + " " + raw).upper()
    return any(s in up for s in _SKIP_SUBSTRINGS)


def clean_name(raw_display: str, merchant_raw: str) -> str:
    if _should_skip(raw_display, merchant_raw):
        return raw_display  # leave transfers/payments/fees untouched
    prompt = f"""Give the clean, recognizable BUSINESS name for this merchant. Strip store numbers,
city names, and payment-processor junk, but KEEP numbers that are part of the real brand
(e.g. "7-Eleven", "5 Guys", "Dave & Buster's"). Use the well-known name if you recognize it.
If you do NOT recognize it, just return the input name cleaned of obvious junk — do NOT write a
sentence or explanation.

Current name: "{raw_display}"
Original bank string: "{merchant_raw}"

Respond with ONLY the clean name, nothing else."""
    out = call_llm(prompt).strip().strip('"').replace("```", "").strip()
    out = out.split("\n")[0] if out else raw_display
    if not out or _is_failure(out):
        return raw_display  # LLM didn't recognize it — keep the existing name
    return out[:60]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()
    if not args.dsn:
        sys.exit("Set DATABASE_URL")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set ANTHROPIC_API_KEY")

    conn = psycopg.connect(args.dsn)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT m.id, m.display_name, m.default_category, m.locked,
                   COALESCE((SELECT t.merchant_raw FROM transactions t WHERE t.merchant_id=m.id LIMIT 1), m.display_name),
                   COUNT(t.id)
            FROM merchants m LEFT JOIN transactions t ON t.merchant_id=m.id AND NOT t.is_deleted
            GROUP BY m.id, m.display_name, m.default_category, m.locked
        """)
        merchants = cur.fetchall()

    print(f"Asking the LLM to clean {len(merchants)} merchant names...\n")
    # Compute new names. Locked merchants keep their existing name.
    new_names = {}
    for mid, name, cat, locked, raw, txns in merchants:
        new_names[mid] = name if locked else clean_name(name, raw)

    # Group by new name (case-insensitive) to find merges.
    by_name = defaultdict(list)
    info = {m[0]: {"name": m[1], "cat": m[2], "locked": m[3], "txns": m[5]} for m in merchants}
    for mid, nm in new_names.items():
        by_name[nm.strip().lower()].append(mid)

    renames = [(mid, new_names[mid]) for mid, *_ in merchants
               if new_names[mid] != info[mid]["name"]]
    # Only merge groups that are SAFE: don't merge merchants with conflicting locked categories.
    merges = {}
    blocked = []
    for nm, ids in by_name.items():
        if len(ids) < 2:
            continue
        locked_cats = {info[i]["cat"] for i in ids if info[i]["locked"] and info[i]["cat"]}
        if len(locked_cats) > 1:
            blocked.append((nm, ids, locked_cats))   # conflicting locked categories -> do NOT merge
        else:
            merges[nm] = ids

    print(f"{len(renames)} renames, {len(merges)} merge groups:\n")
    for mid, nm in renames:
        print(f"  rename #{mid} '{info[mid]['name']}' -> '{nm}'")
    print()
    for nm, ids in merges.items():
        names = [f"#{i} '{info[i]['name']}'" for i in ids]
        print(f"  MERGE -> '{new_names[ids[0]]}': " + ", ".join(names))
    if blocked:
        print(f"\n  {len(blocked)} merge(s) BLOCKED (conflicting locked categories — left separate):")
        for nm, ids, cats in blocked:
            print(f"    '{nm}': {sorted(cats)} — " + ", ".join(f"#{i}" for i in ids))

    if not args.apply:
        print("\nDRY RUN. Nothing changed. Re-run with --apply.")
        conn.close()
        return

    with conn.cursor() as cur:
        # First apply renames (skip locked).
        for mid, nm in renames:
            if not info[mid]["locked"]:
                cur.execute("UPDATE merchants SET display_name=%s, updated_at=now() WHERE id=%s", (nm, mid))
        # Then merge groups: canonical = locked first, else most txns.
        for nm, ids in merges.items():
            group = sorted(ids, key=lambda i: (not info[i]["locked"], -info[i]["txns"]))
            canonical, others = group[0], group[1:]
            locked_cats = {info[i]["cat"] for i in ids if info[i]["locked"] and info[i]["cat"]}
            keep_cat = (sorted(locked_cats)[0] if locked_cats
                        else info[canonical]["cat"] or next((info[i]["cat"] for i in ids if info[i]["cat"]), None))
            keep_locked = bool(locked_cats) or info[canonical]["locked"]
            if others:
                cur.execute("UPDATE transactions SET merchant_id=%s WHERE merchant_id=ANY(%s)", (canonical, others))
                cur.execute("DELETE FROM split_templates WHERE merchant_id=ANY(%s)", (others,))
                cur.execute("DELETE FROM merchants WHERE id=ANY(%s)", (others,))
            cur.execute("UPDATE merchants SET display_name=%s, default_category=%s, locked=%s, updated_at=now() WHERE id=%s",
                        (new_names[canonical], keep_cat, keep_locked, canonical))
    conn.commit()
    print(f"\nApplied {len(renames)} renames and {len(merges)} merges.")
    conn.close()


if __name__ == "__main__":
    main()
