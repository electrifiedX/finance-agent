"""
importers/ally.py — Ally checking (the hub).
Format: " Date, Time, Amount, Type, Description"  (leading spaces in headers -> trimmed)
Type: Deposit | Withdrawal only -> ALL classification rides on Description.
Amount: negative = withdrawal/spending, positive = deposit/inflow.
Descriptions carry "~ Future Amount: 600 ~ Tran: ACHDW" noise -> stripped by fingerprint().

Source-of-truth model: the CARD is truth for card spending. Every Ally->card payment is a
TRANSFER (the real purchases are itemized on the card). Ally contributes income + checking-origin
spending only. See classify_ally() for the full seed-rules table.
"""

import csv
import re
from datetime import datetime

from .common import NormalizedTxn, make_dedupe_key

# (substring [UPPERCASE], txn_type, category, is_spending). First match wins.
_RULES = [
    # --- Card payments leaving Ally -> transfers (NOT spending; card has the purchases) ---
    ("CHASE CREDIT CRD EPAY",      "transfer", "transfer", False),
    ("WELLS FARGO CARD CCPYMT",    "transfer", "transfer", False),
    ("TARGET CARD SRVC PAYMENT",   "transfer", "transfer", False),
    ("LOWES SYF PAYMNT",           "transfer", "transfer", False),
    ("APPLECARD GSBANK PAYMENT",   "transfer", "transfer", False),
    ("BANK OF AMERICA ONLINE PMT", "transfer", "transfer", False),
    # --- Inter-account moves (own money) -> transfers ---
    ("INTERNET TRANSFER",          "transfer", "transfer", False),
    ("REQUESTED TRANSFER FROM ALLY INVEST", "transfer", "transfer", False),
    ("JPMORGAN CHASE EXT TRNSFR",  "transfer", "transfer", False),
    # --- Housing (mortgage + home-secured debt all roll into housing) ---
    ("ROCKET MORTGAGE LOAN",       "sale", "housing", True),
    ("NSM DBAMR.COOPER",           "sale", "housing", True),   # Mr. Cooper — mortgage, new servicer
    ("MR COOPER",                  "sale", "housing", True),
    ("FIGURE LENDING",             "sale", "housing", True),   # HELOC (becoming Aven)
    ("AVEN",                       "sale", "housing", True),   # HELOC successor
    ("GREENSKY",                   "sale", "housing", True),   # HVAC loan (financed home improvement)
    # --- Cash withdrawals: money to wallet, NOT consumption. Real spend logged manually. ---
    ("U.S. BANK TM",               "transfer", "cash_withdrawal", False),  # ATM
    ("US BANK ERIE",               "transfer", "cash_withdrawal", False),  # ATM
    ("BANK OF AMERICA *BRAZOS",    "transfer", "cash_withdrawal", False),  # ATM
    # --- Automotive ---
    ("COGOV COMOTORVEH",           "sale", "automotive", True),   # CO vehicle registration
    # --- Income ---
    ("CATERPILLAR INC. DIR DEP",   "income", "income", False),
    ("INTEREST PAID",              "income", "income", False),
    ("ATM FEE REIMBURSEMENT",      "income", "income", False),
    # --- Utilities ---
    ("XCEL ENERGY",                "sale", "utilities", True),
    ("UNITED POWER",               "sale", "utilities", True),   # electric co-op
    ("TOE UTILITIES",              "sale", "utilities", True),
    ("TESLA_US_CAPTIVE",           "sale", "utilities", True),   # solar/Powerwall energy lease
    ("ENERGY_LEASE",               "sale", "utilities", True),
    # --- Automotive (the car, NOT the energy lease) ---
    ("TESLA MOTORS",               "sale", "automotive", True),
    # --- Fitness ---
    ("KODA COLORADO",              "sale", "fitness", True),
    ("VASAFIT",                    "sale", "fitness", True),
    ("PARAMOUNT ACCEPT",           "sale", "fitness", True),
    ("NOBULL",                     "sale", "fitness", True),
    # --- Pets / childcare (specific Zelle recipients) ---
    ("KELLY MAILLY",               "sale", "pets", True),
    ("POPPINS",                    "sale", "childcare", True),
    # --- Business (own company) -> business_expense, not family spend ---
    ("BLUTERRA",                   "business_expense", "business_expense", False),
]

# Ambiguous -> needs_review (manual weekly pass). Checked after _RULES.
_REVIEW_PATTERNS = [
    re.compile(r"CHECK\s*PAID"),          # bare checks, no description
    re.compile(r"VENMO PAYMENT"),         # outgoing venmo, ambiguous
]


def _date(s):
    return datetime.strptime(s.strip(), "%Y-%m-%d").date()


def classify_ally(description: str, amount: float):
    """Returns (txn_type, category, is_spending)."""
    up = (description or "").upper()
    for sub, ttype, cat, is_sp in _RULES:
        if sub in up:
            return ttype, cat, is_sp
    # Zelle/Venmo DEPOSITS in (positive) = Tina selling household items = misc_income
    if amount > 0 and ("ZELLE" in up or "VENMO" in up):
        return "income", "misc_income", False
    for pat in _REVIEW_PATTERNS:
        if pat.search(up):
            return "sale", "needs_review", True
    # Unmatched -> uncategorized (LLM/review will handle)
    return "sale", "uncategorized", True


def parse(path: str, account_name: str) -> list[NormalizedTxn]:
    out = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        # Headers have leading spaces (" Date", " Amount"...) -> build a trimmed key map.
        keymap = {k: k.strip() for k in reader.fieldnames}
        for raw_row in reader:
            row = {keymap[k]: (v.strip() if isinstance(v, str) else v) for k, v in raw_row.items()}
            if not row.get("Date"):
                continue
            amount = float(row["Amount"])
            desc = row.get("Description") or ""
            time = row.get("Time") or ""
            ttype, cat, is_sp = classify_ally(desc, amount)

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
                    "ally", date=row["Date"], time=time, amount=row["Amount"], desc=desc,
                ),
            ))
    return out
