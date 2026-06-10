"""
jobs/gmail_ingest.py — poll Gmail for bank transaction alerts and ingest them.

Flow:
  1. Read token from secrets/gmail_token.json (read-only Gmail).
  2. Search inbox for alert emails from the three banks, newer than a lookback window.
  3. For each message NOT already in processed_emails (by Gmail message id):
       - detect bank by sender, parse body -> NormalizedTxn
       - resolve account by last4 (account_last4s table)
       - insert via importers.common.insert_txn (idempotent on dedupe_key)
       - run categorization for the new merchant (Chase/BofA); Ally stays needs_review
       - record the gmail id in processed_emails
  Processing state lives in processed_emails — NEVER Gmail read/unread flags
  (both humans read this inbox).

Usage:
  cd ~/Developer/finance-agent
  export $(grep -v '^#' .env | xargs)
  python -m jobs.gmail_ingest                 # one pass
  python -m jobs.gmail_ingest --lookback-days 30   # wider catch-up on first run
"""

import argparse
import base64
import os
import sys
from datetime import datetime, timedelta

import psycopg
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from importers.common import insert_txn  # noqa: E402
from jobs.email_parsers import PARSERS, detect_bank, SENDER_CHASE, SENDER_BOFA, SENDER_ALLY  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_PATH = os.path.join(REPO_ROOT, "secrets", "gmail_token.json")
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
SENDERS = [SENDER_CHASE, SENDER_BOFA, SENDER_ALLY]


def gmail_service():
    creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    return build("gmail", "v1", credentials=creds)


def _header(msg, name):
    for h in msg["payload"].get("headers", []):
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def _body_text(msg) -> str:
    """Extract plain-text (or HTML stripped) body from a Gmail message."""
    def walk(part):
        out = ""
        mime = part.get("mimeType", "")
        data = part.get("body", {}).get("data")
        if data and mime in ("text/plain", "text/html"):
            decoded = base64.urlsafe_b64decode(data).decode("utf-8", "ignore")
            if mime == "text/html":
                import re
                decoded = re.sub(r"<[^>]+>", " ", decoded)        # strip tags
                decoded = re.sub(r"&nbsp;|&amp;", " ", decoded)
            out += decoded + "\n"
        for p in part.get("parts", []) or []:
            out += walk(p)
        return out
    return walk(msg["payload"])


def already_processed(conn, gmail_msg_id) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM processed_emails WHERE gmail_msg_id = %s", (gmail_msg_id,))
        return cur.fetchone() is not None


def mark_processed(conn, gmail_msg_id, bank, status):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO processed_emails (gmail_msg_id, bank, status, processed_at) "
            "VALUES (%s, %s, %s, now()) ON CONFLICT (gmail_msg_id) DO NOTHING",
            (gmail_msg_id, bank, status),
        )
    conn.commit()


def account_name_for_last4(conn, last4):
    if not last4:
        return None
    with conn.cursor() as cur:
        cur.execute(
            "SELECT a.name FROM accounts a JOIN account_last4s l ON l.account_id = a.id "
            "WHERE l.last4 = %s",
            (last4,),
        )
        row = cur.fetchone()
        return row[0] if row else None


def run(dsn: str, lookback_days: int = 7):
    svc = gmail_service()
    conn = psycopg.connect(dsn)

    after = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y/%m/%d")
    query = "(" + " OR ".join(f"from:{s}" for s in SENDERS) + f") after:{after}"
    resp = svc.users().messages().list(userId="me", q=query, maxResults=100).execute()
    ids = [m["id"] for m in resp.get("messages", [])]
    print(f"Found {len(ids)} alert emails in the last {lookback_days} days.")

    inserted = skipped = unresolved = 0
    for gid in ids:
        if already_processed(conn, gid):
            continue
        msg = svc.users().messages().get(userId="me", id=gid, format="full").execute()
        sender = _header(msg, "From")
        subject = _header(msg, "Subject")
        bank = detect_bank(sender)
        if not bank:
            mark_processed(conn, gid, "unknown", "skipped_sender")
            continue
        body = _body_text(msg)
        txn = PARSERS[bank](body, subject)
        if txn is None:
            # Could be a non-transaction email (settings/2FA) OR a format we don't parse yet.
            # Mark processed so genuine non-txn emails don't retry forever. If you later improve
            # a parser, clear these with: DELETE FROM processed_emails WHERE status='parse_failed';
            mark_processed(conn, gid, bank, "parse_failed")
            print(f"  [{bank}] PARSE FAILED (likely not a transaction): {subject[:60]}")
            continue
        # resolve account by last4
        last4 = txn.raw_payload.get("last4")
        acct = account_name_for_last4(conn, last4)
        if not acct:
            # RECOVERABLE: do NOT mark processed — once you map the last4, a re-run picks it up.
            print(f"  [{bank}] UNKNOWN last4 {last4}: {txn.merchant_raw[:40]} — add it to account_last4s, then re-run")
            unresolved += 1
            continue
        txn.account_name = acct
        ok = insert_txn(conn, txn)   # idempotent on dedupe_key
        conn.commit()
        mark_processed(conn, gid, bank, "inserted" if ok else "duplicate")
        if ok:
            inserted += 1
            print(f"  [{bank}] + {txn.occurred_at} {txn.merchant_raw[:30]} {txn.amount}")
        else:
            skipped += 1

    print(f"\nInserted {inserted}, duplicates {skipped}, unresolved-account {unresolved}.")
    if inserted:
        print("Run the categorizer to assign categories to new merchants:")
        print("  python -m llm.categorize")
    conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lookback-days", type=int, default=7)
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()
    if not args.dsn:
        sys.exit("Set DATABASE_URL")
    run(args.dsn, args.lookback_days)


if __name__ == "__main__":
    main()
