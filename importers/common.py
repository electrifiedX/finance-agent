"""
importers/common.py — shared utilities for all CSV/PDF importers.

Every institution-specific importer (chase.py, bofa.py, ...) parses its own format
and emits a list of NormalizedTxn. This module handles everything format-agnostic:
fingerprinting merchant strings, building dedupe keys, classifying transfers/interest,
resolving accounts, and the idempotent upsert into Postgres.

Sign convention everywhere downstream: NEGATIVE = spending/outflow, POSITIVE = inflow.
Each importer is responsible for converting its source's convention to this.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date
from typing import Optional

import psycopg
from psycopg.types.json import Jsonb


# ---------------------------------------------------------------------------
# Normalized transaction — what every importer emits.
# ---------------------------------------------------------------------------
@dataclass
class NormalizedTxn:
    account_name: str            # which seeded account this belongs to
    occurred_at: date
    amount: float                # signed: negative = spending
    merchant_raw: str
    posted_at: Optional[date] = None
    txn_type: str = "sale"       # sale|payment|fee|return|transfer|income|business_expense|cash
    category: Optional[str] = None       # seed rule may set this; else None -> LLM later
    is_spending: bool = True
    external_id: Optional[str] = None    # stable ref (BofA, Target) when available
    source: str = "csv"
    raw_payload: dict = field(default_factory=dict)
    dedupe_key: Optional[str] = None     # set by importer via make_dedupe_key()


# ---------------------------------------------------------------------------
# Merchant fingerprinting — collapse messy strings to a stable clustering key.
# ---------------------------------------------------------------------------
_PREFIXES = ["SQ *", "SQ*", "TST*", "TST *", "TM *", "TM*", "SP ", "SP*", "PL*",
             "PY *", "PAYPAL *", "PP*", "CKE*", "IN *"]
_STATE_TAIL = re.compile(r"\s+[A-Z]{2}\s*$")          # trailing " CO", " TX", " WA"
_PHONE = re.compile(r"\b\d{3}[-.]?\d{3}[-.]?\d{4}\b")  # phone numbers
_CARDNUM = re.compile(r"X{4,}\d*", re.IGNORECASE)      # masked card numbers XXXX...4559
_ALLY_TAIL = re.compile(r"~.*?~")                       # Ally "~ Future Amount: 600 ~"
_LONG_DIGITS = re.compile(r"\b\d{5,}\b")               # long ref/store digit runs
_MULTISPACE = re.compile(r"\s+")

# Known brand folds — applied after generic cleanup so variants collapse to one merchant.
_BRAND_FOLDS = [
    (re.compile(r"\bAMAZON\b.*"), "AMAZON"),
    (re.compile(r"\bAMZN\b.*"), "AMAZON"),
    (re.compile(r"\bSTARBUCKS\b.*"), "STARBUCKS"),
    (re.compile(r"\bTARGET\b.*"), "TARGET"),
    (re.compile(r"\bWAL-?MART\b.*"), "WALMART"),
    (re.compile(r"\bCOSTCO\b.*"), "COSTCO"),
    (re.compile(r"\bSOUTHWES\w*\b.*"), "SOUTHWEST"),
    (re.compile(r"\bUNITED\b\s*\d.*"), "UNITED"),
    (re.compile(r"\bNETFLIX\b.*"), "NETFLIX"),
    (re.compile(r"\bSPOTIFY\b.*"), "SPOTIFY"),
    (re.compile(r"\bWHOLEFDS\b.*|\bWHOLE FOODS\b.*"), "WHOLE FOODS"),
    (re.compile(r"\bKING SOOPERS\b.*"), "KING SOOPERS"),
    (re.compile(r"\bCHEWY\b.*"), "CHEWY"),
    (re.compile(r"\bROCKET ?MORT\w*\b.*|\bROCKET MORTGAGE\b.*"), "ROCKET MORTGAGE"),
]


def fingerprint(raw: str) -> str:
    """Normalize a raw merchant/payee string to a stable clustering key (uppercase)."""
    s = (raw or "").upper().strip()
    s = _ALLY_TAIL.sub(" ", s)
    s = s.replace("NULL", " ")
    for p in _PREFIXES:
        if s.startswith(p.upper()):
            s = s[len(p):]
    s = _CARDNUM.sub(" ", s)
    s = _PHONE.sub(" ", s)
    s = _LONG_DIGITS.sub(" ", s)
    s = _STATE_TAIL.sub("", s)
    s = re.sub(r"[*#]", " ", s)
    s = _MULTISPACE.sub(" ", s).strip()
    for pattern, fold in _BRAND_FOLDS:
        if pattern.search(s):
            return fold
    return s or (raw or "").upper().strip()


def display_name_guess(fp: str) -> str:
    """A reasonable human display name from a fingerprint (title-cased). LLM may override."""
    return " ".join(w.capitalize() for w in fp.split())


# ---------------------------------------------------------------------------
# Dedupe keys — idempotent imports. Re-running a file inserts 0 new rows.
# ---------------------------------------------------------------------------
def _sha(*parts) -> str:
    h = hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return h[:16]


def make_dedupe_key(family: str, *, external_id: Optional[str] = None, **parts) -> str:
    """external_id (BofA ref, Target ref#) is preferred; else hash of stable fields."""
    if external_id and external_id.strip():
        return f"{family}:{external_id.strip()}"
    return f"{family}:{_sha(*parts.values())}"


# ---------------------------------------------------------------------------
# Transfer / interest / income classification (format-agnostic keyword pass).
# Importers may set txn_type/category directly; this is the shared fallback +
# the Ally-specific seed rules live in ally.py which calls classify_ally().
# ---------------------------------------------------------------------------
_TRANSFER_KEYS = [
    "ELECTRONIC PAYMENT", "PAYMENT THANK YOU", "ONLINE ACH PAYMENT THANK YOU",
    "E-PAY TARGET", "AUTOPAY", "AUTOMATIC PAYMENT", "PAYMENT - THANK YOU",
]
_INTEREST_KEYS = [
    "INTEREST CHARGED", "INTEREST CHARGE", "PURCHASE INTEREST", "DEFERRED INTEREST",
]
_FEE_KEYS = ["LATE FEE", "ANNUAL FEE"]


def classify_generic(merchant_raw: str, amount: float, source_type: Optional[str]):
    """
    Returns (txn_type, category, is_spending) or (None, None, None) if no rule matched.
    source_type is the issuer's own Type column value when present (e.g. Chase 'Payment').
    """
    up = (merchant_raw or "").upper()
    st = (source_type or "").upper()

    if st == "PAYMENT" or any(k in up for k in _TRANSFER_KEYS):
        return ("transfer", "transfer", False)
    if any(k in up for k in _INTEREST_KEYS):
        return ("fee", "interest", True)
    if any(k in up for k in _FEE_KEYS):
        return ("fee", "fees", True)
    if st == "RETURN":
        return ("return", "refund", False)
    return (None, None, None)


# ---------------------------------------------------------------------------
# DB upsert
# ---------------------------------------------------------------------------
def connect(dsn: str) -> psycopg.Connection:
    return psycopg.connect(dsn)


def resolve_account_id(conn, account_name: str) -> int:
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM accounts WHERE name = %s", (account_name,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"Account not seeded: {account_name!r}. Run db/seed_accounts.sql.")
        return row[0]


def upsert_merchant(conn, raw: str) -> tuple[int, Optional[str], bool]:
    """Get-or-create a merchant by fingerprint. Returns (merchant_id, default_category, locked)."""
    fp = fingerprint(raw)
    with conn.cursor() as cur:
        cur.execute("SELECT id, default_category, locked FROM merchants WHERE raw_fingerprint = %s", (fp,))
        row = cur.fetchone()
        if row:
            return row[0], row[1], row[2]
        cur.execute(
            "INSERT INTO merchants (raw_fingerprint, display_name) VALUES (%s, %s) RETURNING id",
            (fp, display_name_guess(fp)),
        )
        return cur.fetchone()[0], None, False


def insert_txn(conn, txn: NormalizedTxn) -> bool:
    """Insert one normalized transaction idempotently. Returns True if a new row was created."""
    account_id = resolve_account_id(conn, txn.account_name)
    merchant_id, default_cat, locked = upsert_merchant(conn, txn.merchant_raw)

    # If the merchant has a locked default and the importer didn't already set a category
    # via a seed rule, inherit the locked default.
    category = txn.category
    if category is None and locked and default_cat:
        category = default_cat

    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO transactions
              (account_id, occurred_at, posted_at, amount, merchant_id, merchant_raw,
               category, txn_type, is_spending, source, external_id, dedupe_key, raw_payload)
            VALUES
              (%(account_id)s, %(occurred_at)s, %(posted_at)s, %(amount)s, %(merchant_id)s,
               %(merchant_raw)s, %(category)s, %(txn_type)s, %(is_spending)s, %(source)s,
               %(external_id)s, %(dedupe_key)s, %(raw_payload)s)
            ON CONFLICT (dedupe_key) DO NOTHING
            RETURNING id
            """,
            {
                "account_id": account_id,
                "occurred_at": txn.occurred_at,
                "posted_at": txn.posted_at,
                "amount": txn.amount,
                "merchant_id": merchant_id,
                "merchant_raw": txn.merchant_raw,
                "category": category,
                "txn_type": txn.txn_type,
                "is_spending": txn.is_spending,
                "source": txn.source,
                "external_id": txn.external_id,
                "dedupe_key": txn.dedupe_key,
                "raw_payload": Jsonb(txn.raw_payload),
            },
        )
        return cur.fetchone() is not None


def import_batch(conn, txns: list[NormalizedTxn]) -> tuple[int, int]:
    """Insert a batch. Returns (inserted, skipped_duplicates)."""
    inserted = 0
    for t in txns:
        if t.dedupe_key is None:
            raise ValueError(f"Txn missing dedupe_key: {t.merchant_raw!r}")
        if insert_txn(conn, t):
            inserted += 1
    conn.commit()
    return inserted, len(txns) - inserted
