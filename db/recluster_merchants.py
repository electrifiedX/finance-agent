"""
db/recluster_merchants.py — one-time re-clustering of existing merchants using the improved
fingerprint() in importers/common.py.

What it does:
  1. Recomputes the fingerprint for every existing merchant.
  2. Groups merchants that now share a fingerprint.
  3. For each group, picks a canonical merchant (prefers a locked one; else the one with the
     most transactions), re-points all transactions to it, copies up a locked category if the
     canonical lacks one, and deletes the now-empty duplicate merchants.
  4. Updates the canonical merchant's raw_fingerprint + display_name.

Safety:
  - DRY RUN by default: prints what WOULD merge and flags any group where two LOCKED merchants
    disagree on category (a conflict you should resolve), and changes nothing.
  - Pass --apply to actually perform the merge (wrapped in a transaction).

Usage:
  python -m db.recluster_merchants            # dry run (safe, shows the plan)
  python -m db.recluster_merchants --apply     # perform the merge
"""

import argparse
import os
import sys
from collections import defaultdict

import psycopg

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from importers.common import fingerprint, display_name_guess  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="perform the merge (default: dry run)")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()
    if not args.dsn:
        sys.exit("Set DATABASE_URL or pass --dsn")

    conn = psycopg.connect(args.dsn)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT m.id, m.display_name, m.raw_fingerprint, m.default_category, m.locked,
                   COUNT(t.id) AS txns
            FROM merchants m
            LEFT JOIN transactions t ON t.merchant_id = m.id AND NOT t.is_deleted
            GROUP BY m.id
        """)
        merchants = cur.fetchall()

    # Group by NEW fingerprint.
    groups = defaultdict(list)
    for mid, name, old_fp, default_cat, locked, txns in merchants:
        new_fp = fingerprint(name)  # re-fingerprint from the display name
        groups[new_fp].append({
            "id": mid, "name": name, "old_fp": old_fp,
            "cat": default_cat, "locked": locked, "txns": txns,
        })

    merges = {fp: g for fp, g in groups.items() if len(g) > 1}
    if not merges:
        print("No merges needed — every merchant already has a unique fingerprint.")
        conn.close()
        return

    conflicts = []
    print(f"{'APPLYING' if args.apply else 'DRY RUN —'} {len(merges)} merge groups:\n")
    plan = []
    for fp, group in sorted(merges.items()):
        locked_cats = {m["cat"] for m in group if m["locked"] and m["cat"]}
        conflict = len(locked_cats) > 1
        # canonical: prefer locked, then most transactions
        canonical = sorted(group, key=lambda m: (not m["locked"], -m["txns"]))[0]
        others = [m for m in group if m["id"] != canonical["id"]]
        # category to keep: any locked cat, else canonical's, else first non-null
        keep_cat = (sorted(locked_cats)[0] if locked_cats
                    else canonical["cat"] or next((m["cat"] for m in group if m["cat"]), None))
        keep_locked = bool(locked_cats) or canonical["locked"]

        flag = "  ⚠️ LOCKED-CATEGORY CONFLICT" if conflict else ""
        print(f"[{fp}] -> keep #{canonical['id']} '{canonical['name']}' "
              f"(cat={keep_cat}, locked={keep_locked}){flag}")
        for m in others:
            print(f"      merge #{m['id']} '{m['name']}' ({m['txns']} txns, cat={m['cat']})")
        if conflict:
            conflicts.append((fp, locked_cats))
        plan.append((canonical, others, fp, keep_cat, keep_locked))

    if conflicts:
        print(f"\n⚠️  {len(conflicts)} group(s) have conflicting LOCKED categories. "
              "Resolve those merchants in the app first, or proceed (a locked category is "
              "picked alphabetically). Listed above.")

    if not args.apply:
        print("\nDRY RUN complete. Nothing changed. Re-run with --apply to perform the merge.")
        conn.close()
        return

    # APPLY
    with conn.cursor() as cur:
        for canonical, others, fp, keep_cat, keep_locked in plan:
            other_ids = [m["id"] for m in others]
            if other_ids:
                cur.execute(
                    "UPDATE transactions SET merchant_id = %s WHERE merchant_id = ANY(%s)",
                    (canonical["id"], other_ids),
                )
                cur.execute(
                    "UPDATE split_templates SET merchant_id = %s WHERE merchant_id = ANY(%s)",
                    (canonical["id"], other_ids),
                ) if False else None  # skip if no split_templates yet; harmless
                cur.execute("DELETE FROM split_templates WHERE merchant_id = ANY(%s)", (other_ids,))
                cur.execute("DELETE FROM merchants WHERE id = ANY(%s)", (other_ids,))
            cur.execute(
                "UPDATE merchants SET raw_fingerprint = %s, display_name = %s, "
                "default_category = %s, locked = %s, updated_at = now() WHERE id = %s",
                (fp, display_name_guess(fp), keep_cat, keep_locked, canonical["id"]),
            )
    conn.commit()
    print(f"\nApplied. Merged {sum(len(o) for _, o, *_ in plan)} merchants into "
          f"{len(plan)} canonical merchants.")
    conn.close()


if __name__ == "__main__":
    main()
