"""
importers/target.py — Target credit card (cards 1145 Andy + 1137 Tina, ONE account).
Format (note BOM): "Transaction Date","Posting Date","Ref#","Amount","Description",
                   "Last 4 of Card/Account","Transaction Type"
GOTCHA: OPPOSITE SIGN CONVENTION. A Sale is POSITIVE (80.73); a Payment is NEGATIVE (-224.16).
We FLIP the sign so spending is negative like everyone else.
Dates: YYYY-MM-DD.  Ref# -> external_id/dedupe.
Transaction Type: Sale|Payment|Return|Fee|Interest|Adjustment.
"""

import csv
from datetime import datetime

from .common import NormalizedTxn, make_dedupe_key


def _date(s):
    return datetime.strptime(s.strip(), "%Y-%m-%d").date()


def parse(path: str, account_name: str) -> list[NormalizedTxn]:
    out = []
    # utf-8-sig strips the BOM on the first header field.
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if not row.get("Transaction Date"):
                continue
            raw_amount = float(row["Amount"])
            amount = -raw_amount               # FLIP: Target Sale(+) -> spending(-)
            desc = (row.get("Description") or "").strip()
            ttype_src = (row.get("Transaction Type") or "").strip()
            ref = (row.get("Ref#") or "").strip()

            tl = ttype_src.lower()
            if tl == "payment":
                ttype, cat, is_sp = "transfer", "transfer", False
            elif tl == "return":
                ttype, cat, is_sp = "return", "refund", False
            elif tl in ("interest", "fee"):
                ttype, cat, is_sp = "fee", ("interest" if tl == "interest" else "fees"), True
            elif tl == "adjustment":
                ttype, cat, is_sp = "sale", "needs_review", True
            else:  # Sale
                ttype, cat, is_sp = "sale", None, True

            out.append(NormalizedTxn(
                account_name=account_name,
                occurred_at=_date(row["Transaction Date"]),
                posted_at=_date(row["Posting Date"]) if row.get("Posting Date") else None,
                amount=amount,
                merchant_raw=desc,
                txn_type=ttype,
                category=cat,
                is_spending=is_sp,
                external_id=ref or None,
                source="csv",
                raw_payload=dict(row),
                # NOTE: Target reuses Ref# across split-tender/multi-item postings, so the
                # ref alone is NOT unique. Build the key from ref + amount + desc instead of
                # passing external_id to make_dedupe_key (which would trust the ref alone).
                dedupe_key=make_dedupe_key("target",
                                           ref=ref, date=row["Transaction Date"],
                                           amount=row["Amount"], desc=desc),
            ))
    return out
