"""
importers/wellsfargo.py — Wells Fargo credit card (2355).
Format: "DATE","DESCRIPTION","AMOUNT","CHECK #","STATUS"
No Type column -> infer transfer/interest from DESCRIPTION (classify_generic).
STATUS: Pending | Posted.  Amount: negative = spending, positive = inflow.
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
            if not row.get("DATE"):
                continue
            amount = float(row["AMOUNT"])
            desc = (row.get("DESCRIPTION") or "").strip()
            status = (row.get("STATUS") or "").strip()
            ttype, cat, is_sp = classify_generic(desc, amount, None)
            if ttype is None:
                ttype, cat, is_sp = "sale", None, True

            out.append(NormalizedTxn(
                account_name=account_name,
                occurred_at=_date(row["DATE"]),
                posted_at=None,
                amount=amount,
                merchant_raw=desc,
                txn_type=ttype,
                category=cat,
                is_spending=is_sp,
                source="csv",
                raw_payload=dict(row),
                dedupe_key=make_dedupe_key(
                    "wf", date=row["DATE"], amount=row["AMOUNT"], desc=desc, status=status,
                ),
            ))
    return out
