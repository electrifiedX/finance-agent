"""
importers/citi.py — Citi credit card (4559).
Format: Status,Date,Description,Debit,Credit  (SPLIT debit/credit, not one signed column)
Debit = spending (store negative). Credit = inflow (store positive). Exactly one populated.
Description embeds the full card number + literal 'null' -> stripped by fingerprint().
No Type column -> infer transfer from keywords (classify_generic).
"""

import csv
from datetime import datetime

from .common import NormalizedTxn, classify_generic, make_dedupe_key


def _date(s):
    return datetime.strptime(s.strip(), "%m/%d/%Y").date()


def _num(s):
    s = (s or "").strip().replace(",", "")
    return float(s) if s else None


def parse(path: str, account_name: str) -> list[NormalizedTxn]:
    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            if not row.get("Date"):
                continue
            debit = _num(row.get("Debit"))
            credit = _num(row.get("Credit"))
            if debit is not None:
                amount = -abs(debit)            # spending -> negative
            elif credit is not None:
                amount = abs(credit)            # inflow -> positive
            else:
                continue

            desc = (row.get("Description") or "").strip()
            ttype, cat, is_sp = classify_generic(desc, amount, None)
            if ttype is None:
                ttype, cat, is_sp = "sale", None, True

            out.append(NormalizedTxn(
                account_name=account_name,
                occurred_at=_date(row["Date"]),
                amount=amount,
                merchant_raw=desc,
                txn_type=ttype,
                category=cat,
                is_spending=is_sp,
                source="csv",
                raw_payload=dict(row),
                dedupe_key=make_dedupe_key(
                    "citi", date=row["Date"], amount=str(amount), desc=desc,
                ),
            ))
    return out
