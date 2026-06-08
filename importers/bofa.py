"""
importers/bofa.py — Bank of America credit card (Royal Caribbean 5142).
Format: Posted Date,Reference Number,Payee,Address,Amount
GOTCHA: the file has a junk TITLE line before the real header, e.g.
   BankofAmerica_January2026_5142
   Posted Date,Reference Number,Payee,Address,Amount
We skip lines until we find the real header.
Amount: negative = spending, positive = inflow.
Reference Number: stable unique id when present (blank/whitespace on interest rows).
"""

import csv
from datetime import datetime

from .common import NormalizedTxn, classify_generic, make_dedupe_key

_HEADER = "Posted Date,Reference Number,Payee,Address,Amount"


def _date(s):
    return datetime.strptime(s.strip(), "%m/%d/%Y").date()


def parse(path: str, account_name: str) -> list[NormalizedTxn]:
    with open(path, newline="", encoding="utf-8-sig") as f:
        lines = f.readlines()

    # Find the real header line; skip any junk title line(s) before it.
    start = 0
    for i, line in enumerate(lines):
        if line.strip().startswith("Posted Date") and "Reference Number" in line:
            start = i
            break

    out = []
    reader = csv.DictReader(lines[start:])
    for row in reader:
        if not row.get("Posted Date"):
            continue
        amount = float(row["Amount"])
        payee = (row.get("Payee") or "").strip()
        ref = (row.get("Reference Number") or "").strip()
        ttype, cat, is_sp = classify_generic(payee, amount, None)
        if ttype is None:
            ttype, cat, is_sp = "sale", None, True

        out.append(NormalizedTxn(
            account_name=account_name,
            occurred_at=_date(row["Posted Date"]),
            posted_at=None,  # BofA gives only one date
            amount=amount,
            merchant_raw=payee,
            txn_type=ttype,
            category=cat,
            is_spending=is_sp,
            external_id=ref or None,
            source="csv",
            raw_payload=dict(row),
            dedupe_key=make_dedupe_key(
                "bofa",
                external_id=ref or None,
                date=row["Posted Date"], amount=row["Amount"], payee=payee,
            ),
        ))
    return out
