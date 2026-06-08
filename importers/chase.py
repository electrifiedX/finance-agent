"""
importers/chase.py — Chase credit cards (Prime 6487, Southwest 7486, United 9565).
Format: Transaction Date,Post Date,Description,Category,Type,Amount,Memo
Amount: negative = spending, positive = inflow (already our convention).
Type: Sale | Payment | Fee | Return.  No reference number -> composite hash dedupe.
"""

import csv
from datetime import datetime

from .common import NormalizedTxn, classify_generic, make_dedupe_key


def _date(s):
    return datetime.strptime(s.strip(), "%m/%d/%Y").date()


def parse(path: str, account_name: str) -> list[NormalizedTxn]:
    out = []
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
                    amount=row["Amount"], desc=desc,
                ),
            ))
    return out
