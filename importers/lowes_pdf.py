"""
importers/lowes_pdf.py — one-time import of the Lowe's (Synchrony) credit card PDF.

The Synchrony "Account Manager" PDF lists transactions as two-line blocks, e.g.:
    May 21 2026 Completed $65.88
    Purchase STORE 3444 ERIE CO
or with the type label leading:
    Apr 27 2026 Completed -$251.80
    Payment PAYMENT

SIGN CONVENTION (inverted vs. our system, like Target):
  - On the statement, PURCHASES are POSITIVE, REFUNDS/PAYMENTS are NEGATIVE.
  - In our DB, spending is NEGATIVE. So we flip: purchase 65.88 -> -65.88 (spending);
    refund -27.21 -> +27.21 (credit, non-spending).

Type mapping:
  Purchase -> sale, housing (home improvement)
  Refund   -> return, non-spending
  Payment  -> transfer, non-spending (card payoff; NOT housing — avoids double count)
  Fee      -> fee, fees
  Interest -> sale, interest
  Autopay/Scheduled (future) -> SKIPPED (hasn't happened yet)

Usage:
  cd ~/Developer/finance-agent
  export $(grep -v '^#' .env | xargs)
  python -m importers.lowes_pdf /path/to/lowescard.pdf            # dry run (prints, no insert)
  python -m importers.lowes_pdf /path/to/lowescard.pdf --apply     # insert
"""

import argparse
import os
import re
import sys
from datetime import datetime

import pdfplumber
import psycopg

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from importers.common import NormalizedTxn, make_dedupe_key, insert_txn  # noqa: E402

ACCOUNT_NAME = "Lowe's"          # matches the seeded account (id 8)
LAST4 = "5246"

# A transaction starts with a date line:  "Mon DD YYYY <status> [-]$amount"
DATE_LINE = re.compile(
    r"^([A-Z][a-z]{2}) (\d{1,2}) (\d{4})\s+(Completed|Processing|Scheduled)\s+(-?)\$([\d,]+\.\d{2})"
)
# The following line carries the type + merchant, e.g. "Purchase STORE 3444 ERIE CO"
TYPE_LINE = re.compile(r"^(Purchase|Refund|Payment|Fee|Interest|Autopay)\b\s*(.*)")


def parse(pdf_path: str):
    txns = []
    lines = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            lines.extend(text.split("\n"))

    i = 0
    occ_counter = {}  # for same-day same-amount dedupe
    while i < len(lines):
        m = DATE_LINE.match(lines[i].strip())
        if not m:
            i += 1
            continue
        mon, day, year, status, neg, amt_s = m.groups()
        # The type/merchant is usually the NEXT line; sometimes label precedes merchant text.
        type_label, merchant = "", ""
        if i + 1 < len(lines):
            tm = TYPE_LINE.match(lines[i + 1].strip())
            if tm:
                type_label, merchant = tm.group(1), tm.group(2).strip()
        # Skip future/scheduled autopay — hasn't happened.
        if status == "Scheduled" or type_label == "Autopay":
            i += 2
            continue

        amount_stmt = float(amt_s.replace(",", "")) * (-1 if neg == "-" else 1)
        occurred = datetime.strptime(f"{mon} {day} {year}", "%b %d %Y").date()

        # Flip sign to our convention (spending negative).
        # Statement: purchase positive -> spending negative; refund/payment negative -> positive credit.
        amount = -amount_stmt

        # Classify by type label.
        if type_label == "Purchase":
            txn_type, category, is_spending = "sale", "housing", True
        elif type_label == "Refund":
            # A Lowe's refund is returned housing items. Mark is_spending=TRUE with category housing
            # so it's counted in the housing total — and because the amount is POSITIVE (money back)
            # while purchases are negative, it correctly NETS against them (net = purchases - returns).
            txn_type, category, is_spending = "return", "housing", True
        elif type_label == "Payment":
            txn_type, category, is_spending = "transfer", "transfer", False
            merchant = merchant or "Lowe's Card Payment"
        elif type_label == "Fee":
            txn_type, category, is_spending = "fee", "fees", True
        elif type_label == "Interest":
            txn_type, category, is_spending = "sale", "interest", True
        else:
            txn_type, category, is_spending = "sale", "needs_review", True

        merchant_raw = merchant or type_label or "LOWES"

        # Same-day/same-amount counter so genuine duplicates (e.g. the two May 13 $41.44s)
        # get distinct dedupe keys.
        key = (str(occurred), f"{amount_stmt:.2f}", merchant_raw)
        occ_counter[key] = occ_counter.get(key, 0) + 1
        occ = occ_counter[key]

        txns.append(NormalizedTxn(
            account_name=ACCOUNT_NAME,
            occurred_at=occurred,
            amount=amount,
            merchant_raw=merchant_raw,
            txn_type=txn_type,
            category=category,
            is_spending=is_spending,
            source="lowes_pdf",
            raw_payload={"last4": LAST4, "statement_type": type_label, "occ": occ},
            dedupe_key=make_dedupe_key("lowes_pdf", date=str(occurred),
                                       amount=f"{amount_stmt:.2f}", merchant=merchant_raw[:24], occ=str(occ)),
        ))
        i += 2
    return txns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()

    txns = parse(args.pdf)
    print(f"Parsed {len(txns)} transactions:\n")
    total_spend = 0.0
    for t in txns:
        flag = "  <-- LARGE" if abs(t.amount) > 1000 else ""
        print(f"  {t.occurred_at}  {t.amount:>11.2f}  {t.txn_type:8} {t.category or '-':12} {t.merchant_raw[:32]}{flag}")
        if t.is_spending:
            total_spend += -t.amount
    print(f"\nTotal spending (excl. payments/refunds): ${total_spend:,.2f}")

    if not args.apply:
        print("\nDRY RUN — nothing inserted. Re-run with --apply to import.")
        return
    if not args.dsn:
        sys.exit("Set DATABASE_URL to apply.")
    conn = psycopg.connect(args.dsn)
    inserted = 0
    for t in txns:
        if insert_txn(conn, t):
            inserted += 1
    conn.commit()
    conn.close()
    print(f"\nInserted {inserted} new transactions ({len(txns) - inserted} were duplicates).")
    print("Run: python -m llm.categorize   to categorize any new merchants.")


if __name__ == "__main__":
    main()
