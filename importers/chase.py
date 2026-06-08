"""
importers/chase.py — Chase credit cards (Prime 6487, Southwest 7486, United 9565).
Format: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
Amount: negative = spending, positive = inflow (already our convention).
Type: Sale | Payment | Fee | Return.  No reference number -> composite hash dedupe.

NOTE on duplicates: Chase has no per-transaction reference number, so two genuinely identical
same-day charges (e.g. two Google Pixel insurance subscriptions billed the same day at the same
price) would otherwise produce the same dedupe key and collapse into one. To preserve real
duplicates, we append a per-(date,amount,description) occurrence counter to the dedupe key.

Trade-off: if you RE-import an overlapping Chase CSV later, identical rows could be re-added
(the counter restarts per file). For a one-time historical backfill this is the right call —
it captures every real charge. Once email ingestion takes over, you won't be re-importing
overlapping Chase CSVs. If you ever do, import only non-overlapping date ranges.
"""

import csv
from collections import defaultdict
from datetime import datetime

from .common import NormalizedTxn, classify_generic, make_dedupe_key


def _date(s):
    return datetime.strptime(s.strip(), "%m/%d/%Y").date()


def parse(path: str, account_name: str) -> list[NormalizedTxn]:
    out = []
    seen = defaultdict(int)  # (date, amount, desc) -> count, to disambiguate true duplicates
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if not row.get("Transaction Date"):
                continue
            amount = float(row["Amount"])
            desc = row["Description"].strip()
            stype = row.get("Type", "")
            ttype, cat, is_sp = classify_generic(desc, amount, stype)
            if ttype is None:
                ttype, cat, is_sp = "sale", None, True

            sig = (row["Transaction Date"], row["Amount"], desc)
            occurrence = seen[sig]
            seen[sig] += 1

            out.append(NormalizedTxn(
                account_name=account_name,
                occurred_at=_date(row["Transaction Date"]),
                posted_at=_date(row["Post Date"]) if row.get("Post Date") else None,
                amount=amount,
                merchant_raw=desc,
                txn_type=ttype,
                category=cat,
                is_spending=is_sp,
                source="csv",
                raw_payload=dict(row),
                dedupe_key=make_dedupe_key(
                    "chase",
                    txn_date=row["Transaction Date"], post_date=row.get("Post Date", ""),
                    amount=row["Amount"], desc=desc, occ=occurrence,
                ),
            ))
    return out
