"""
jobs/email_parsers.py — parse bank transaction-alert emails into NormalizedTxn.

Three banks, matched by sender:
  - Chase  (no.reply.alerts@chase.com)             -> rich: merchant, amount, last4, date -> spending
  - BofA   (onlinebanking@ealerts.bankofamerica.com)-> rich: merchant ("Where:"), amount, last4, date
  - Ally   (email@alert.ally.com)                  -> THIN: amount, last4, date, type only. NO merchant.
           Ally lands as needs_review for manual vendor/type assignment.

Each parser returns a NormalizedTxn (account resolved by last4) or None if it can't parse.
The dedupe_key is built from account+date+amount+merchant so re-reading the same email,
or an email that duplicates a CSV row, won't double-insert.
"""

import re
from datetime import datetime
from typing import Optional

from importers.common import NormalizedTxn, make_dedupe_key

# Sender addresses (lowercased substring match is enough).
SENDER_CHASE = "no.reply.alerts@chase.com"
SENDER_BOFA = "onlinebanking@ealerts.bankofamerica.com"
SENDER_ALLY = "email@alert.ally.com"


def _money(s: str) -> Optional[float]:
    m = re.search(r"\$?\s*([\d,]+\.\d{2})", s)
    return float(m.group(1).replace(",", "")) if m else None


def _last4(s: str) -> Optional[str]:
    m = re.search(r"(\d{4})", s)
    return m.group(1) if m else None


def detect_bank(sender: str) -> Optional[str]:
    s = (sender or "").lower()
    if SENDER_CHASE in s:
        return "chase"
    if SENDER_BOFA in s:
        return "bofa"
    if SENDER_ALLY in s:
        return "ally"
    return None


# ---------------------------------------------------------------------------
# Chase: body has labeled rows  Account / Date / Merchant / Amount
#   Account	Prime Visa (...6487)
#   Date	Jun 9, 2026 at 1:21 PM ET
#   Merchant	Amazon.com
#   Amount	$19.60
# ---------------------------------------------------------------------------
def parse_chase(body: str, subject: str) -> Optional[NormalizedTxn]:
    acct = re.search(r"Account\s*[:\t ]+.*?\(\.*\s*(\d{4})\)", body) or re.search(r"\(\.{0,3}(\d{4})\)", body)
    merch = re.search(r"Merchant\s*[:\t ]+(.+)", body)
    amt = re.search(r"Amount\s*[:\t ]+\$?([\d,]+\.\d{2})", body)
    dt = re.search(r"Date\s*[:\t ]+([A-Z][a-z]{2} \d{1,2}, \d{4})", body)
    if not (merch and amt):
        # fall back to subject: "You made a $19.60 transaction with Amazon.com"
        sm = re.search(r"\$([\d,]+\.\d{2}) transaction with (.+)", subject or "")
        if sm:
            amount = float(sm.group(1).replace(",", ""))
            merchant = sm.group(2).strip()
        else:
            return None
    else:
        amount = float(amt.group(1).replace(",", ""))
        merchant = merch.group(1).strip()
    last4 = acct.group(1) if acct else None
    occurred = _parse_date(dt.group(1)) if dt else datetime.now().date()
    return NormalizedTxn(
        account_name="",  # resolved later by last4
        occurred_at=occurred,
        amount=-abs(amount),           # purchases are spending (negative)
        merchant_raw=merchant,
        txn_type="sale",
        is_spending=True,
        source="email_chase",
        external_id=None,
        raw_payload={"last4": last4, "subject": subject},
        dedupe_key=make_dedupe_key("email_chase", last4=last4, date=str(occurred),
                                   amount=f"{amount:.2f}", merchant=merchant[:24]),
    )


# ---------------------------------------------------------------------------
# BofA: body has  <CardName> ending in 5142 / Amount: $X / Date: June 9, 2026 / Where: MERCHANT
# ---------------------------------------------------------------------------
def parse_bofa(body: str, subject: str) -> Optional[NormalizedTxn]:
    last4 = re.search(r"ending in\s*(\d{4})", body)
    amt = re.search(r"Amount:?\s*\$?([\d,]+\.\d{2})", body)
    dt = re.search(r"Date:?\s*([A-Z][a-z]+ \d{1,2}, \d{4})", body)
    where = re.search(r"Where:?\s*(.+)", body)
    if not (amt and where):
        return None
    amount = float(amt.group(1).replace(",", ""))
    merchant = where.group(1).strip()
    occurred = _parse_date(dt.group(1)) if dt else datetime.now().date()
    l4 = last4.group(1) if last4 else None
    return NormalizedTxn(
        account_name="",
        occurred_at=occurred,
        amount=-abs(amount),
        merchant_raw=merchant,
        txn_type="sale",
        is_spending=True,
        source="email_bofa",
        raw_payload={"last4": l4, "subject": subject},
        dedupe_key=make_dedupe_key("email_bofa", last4=l4, date=str(occurred),
                                   amount=f"{amount:.2f}", merchant=merchant[:24]),
    )


# ---------------------------------------------------------------------------
# Ally: THIN. body has  Account ending in 8985 / Amount $X / Transaction TYPE / Date M/D/YYYY
# No merchant -> needs_review, no is_spending assumption (could be transfer/payment/sale).
# ---------------------------------------------------------------------------
def parse_ally(body: str, subject: str) -> Optional[NormalizedTxn]:
    last4 = re.search(r"ending in\s*(\d{4})", body)
    amt = re.search(r"Amount\s*[:\t ]*\$?([\d,]+\.\d{2})", body)
    ttype = re.search(r"Transaction\s*[:\t ]*(.+)", body)
    dt = re.search(r"Date\s*[:\t ]*(\d{1,2}/\d{1,2}/\d{4})", body)
    is_debit = "debit" in (subject or "").lower() or "withdrawal" in (ttype.group(1).lower() if ttype else "")
    if not amt:
        return None
    amount = float(amt.group(1).replace(",", ""))
    occurred = _parse_date(dt.group(1)) if dt else datetime.now().date()
    l4 = last4.group(1) if last4 else None
    type_label = ttype.group(1).strip() if ttype else "ALLY TRANSACTION"
    # Debit = money out (negative). Ally alerts here are debit-threshold alerts.
    signed = -abs(amount) if is_debit else abs(amount)
    return NormalizedTxn(
        account_name="",
        occurred_at=occurred,
        amount=signed,
        merchant_raw=type_label,           # e.g. "DDA ACH WITHDRAWAL" — placeholder; user assigns vendor
        txn_type="sale",                   # tentative; Ally needs manual type too
        category="needs_review",           # ALWAYS needs_review — email lacks merchant
        is_spending=is_debit,
        source="email_ally",
        raw_payload={"last4": l4, "subject": subject, "ally_type": type_label},
        dedupe_key=make_dedupe_key("email_ally", last4=l4, date=str(occurred),
                                   amount=f"{amount:.2f}", type=type_label[:24]),
    )


def _parse_date(s: str):
    s = s.strip()
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return datetime.now().date()


PARSERS = {"chase": parse_chase, "bofa": parse_bofa, "ally": parse_ally}
