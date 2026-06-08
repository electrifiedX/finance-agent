"""
importers/run.py — detect each CSV's family by header signature, route to the right
parser, and import idempotently into Postgres.

Usage:
    python -m importers.run ./drop
    python -m importers.run ./drop --dsn "postgresql://user@localhost/finance"

Account assignment: a file's account is determined by the FILENAME_ACCOUNT_HINTS map below
(filename substring -> account name). This is explicit on purpose — filenames carry the card,
the CSV contents often don't. Add entries as you add files. If no hint matches, the file is
skipped with a warning so you never import into the wrong account by accident.

Set DATABASE_URL in the environment or pass --dsn.
"""

import argparse
import os
import sys
from pathlib import Path

from . import ally, bofa, chase, citi, target, wellsfargo
from .common import connect, import_batch

# Header signature (lowercased, stripped) -> (family module, parser)
HEADER_SIGNATURES = {
    "transaction date,post date,description,category,type,amount,memo": ("chase", chase.parse),
    "posted date,reference number,payee,address,amount": ("bofa", bofa.parse),
    "status,date,description,debit,credit": ("citi", citi.parse),
    '"transaction date","posting date","ref#","amount","description","last 4 of card/account","transaction type"': ("target", target.parse),
    '"date","description","amount","check #","status"': ("wellsfargo", wellsfargo.parse),
    "date, time, amount, type, description": ("ally", ally.parse),
}

# Filename substring -> account name (must match db/seed_accounts.sql).
FILENAME_ACCOUNT_HINTS = {
    "chase_prime": "Chase Prime",
    "6487": "Chase Prime",
    "chase_southwest": "Chase Southwest",
    "7486": "Chase Southwest",
    "chase_united": "Chase United",
    "9565": "Chase United",
    "bankofamerica": "BofA Royal Caribbean",
    "royalcaribbean": "BofA Royal Caribbean",
    "5142": "BofA Royal Caribbean",
    "citi": "Citi",
    "4559": "Citi",
    "target": "Target",
    "wellsfargo": "Wells Fargo",
    "2355": "Wells Fargo",
    "ally": "Ally Checking",
}


def detect_family(path: Path):
    """Read the header line(s) and match a signature. Handles BofA's junk title line."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        lines = [next(f, "") for _ in range(3)]
    for line in lines:
        sig = line.strip().lower()
        if sig in HEADER_SIGNATURES:
            return HEADER_SIGNATURES[sig]
    return None, None


def account_for(path: Path):
    name = path.name.lower()
    for hint, account in FILENAME_ACCOUNT_HINTS.items():
        if hint in name:
            return account
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("drop_dir", help="directory of CSVs to import")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"))
    args = ap.parse_args()
    if not args.dsn:
        sys.exit("Set DATABASE_URL or pass --dsn")

    drop = Path(args.drop_dir)
    files = sorted(p for p in drop.iterdir() if p.suffix.lower() == ".csv")
    if not files:
        print(f"No .csv files in {drop}")
        return

    conn = connect(args.dsn)
    total_ins = total_dup = 0
    for path in files:
        family, parser = detect_family(path)
        account = account_for(path)
        if not family:
            print(f"SKIP  {path.name}: unrecognized header")
            continue
        if not account:
            print(f"SKIP  {path.name}: no account hint (add to FILENAME_ACCOUNT_HINTS)")
            continue
        txns = parser(str(path), account)
        ins, dup = import_batch(conn, txns)
        total_ins += ins
        total_dup += dup
        print(f"OK    {path.name}: {family} -> {account} | +{ins} new, {dup} dup")

    print(f"\nDone. {total_ins} inserted, {total_dup} duplicates skipped.")
    conn.close()


if __name__ == "__main__":
    main()
