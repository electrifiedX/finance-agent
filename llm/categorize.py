"""
llm/categorize.py — assign categories to transactions whose category is still NULL or
'uncategorized', using the merchant cache first and the LLM only for genuinely new merchants.

The LLM is behind a single function (call_llm) so the provider can be swapped (Anthropic API
now, local Ollama later) without touching callers.

Few-shot from history: when asking the LLM about a NEW merchant, we include a sample of the
household's already-LOCKED merchant->category decisions so the model generalizes from THEIR
taste, not a generic prior. The example set grows as more merchants get locked.

Usage:
    python -m llm.categorize            # categorize the backlog
    DATABASE_URL=... ANTHROPIC_API_KEY=... python -m llm.categorize
"""

import json
import os
import sys

import psycopg

# The full v1 taxonomy (keep in sync with docs/BRIEF.md §9).
SPENDING_CATEGORIES = [
    "groceries", "eating_out", "coffee_snacks", "utilities", "housing",
    "home_entertainment", "outings_activities", "fitness", "medical", "wellness",
    "automotive", "insurance", "toiletries_home", "childcare", "kid_expenses",
    "pets", "travel", "giving", "gifts", "personal_andy", "personal_tina",
    "shopping", "interest", "fees", "needs_review", "uncategorized",
]
NONSPENDING_CATEGORIES = ["transfer", "income", "misc_income", "refund", "business_expense", "cash_withdrawal"]
ALL_CATEGORIES = SPENDING_CATEGORIES + NONSPENDING_CATEGORIES


def _anthropic_call(prompt: str) -> str:
    """Default provider: Anthropic API. Swap this body for Ollama later if desired."""
    import anthropic
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in resp.content if b.type == "text")


def call_llm(prompt: str) -> str:
    return _anthropic_call(prompt)


def _fewshot_examples(conn, limit: int = 20) -> list[tuple[str, str]]:
    """Pull locked merchant->category pairs as few-shot examples of the household's taste."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT display_name, default_category FROM merchants "
            "WHERE locked = true AND default_category IS NOT NULL "
            "ORDER BY updated_at DESC LIMIT %s",
            (limit,),
        )
        return cur.fetchall()


def categorize_merchant(conn, display_name: str, merchant_raw: str, amount: float) -> tuple[str, str, float]:
    """Ask the LLM for {display_name, category, confidence} for a new merchant, few-shot from history."""
    examples = _fewshot_examples(conn)
    ex_text = "\n".join(f"  {n} -> {c}" for n, c in examples) or "  (none yet)"
    prompt = f"""You clean up and categorize a household's financial transactions.

Valid categories:
{", ".join(ALL_CATEGORIES)}

How THIS household has categorized merchants before (match their taste):
{ex_text}

Notes:
- coffee_snacks = informal treats (coffee, ice cream, a cookie); eating_out = actual meals.
- outings_activities = going out to DO something (bowling, arcade, movies), not eating.
- personal_andy = Grok/Claude/X/Audible/books; personal_tina = her subscriptions/hobbies.
- kid_expenses = goods for kids (diapers, kids' clothes/toys); childcare = paid care services.
- If genuinely unclear, use "needs_review".

Two tasks for this transaction:
1. display_name: the clean, recognizable BUSINESS name. Strip store numbers, city names, and
   payment-processor junk, BUT KEEP numbers that are part of the real brand (e.g. "7-Eleven",
   "5 Guys", "Dave & Buster's"). Use the well-known name of the business if you recognize it.
2. category: exactly one from the list above.

Transaction: raw="{merchant_raw}", amount={amount}

Respond with ONLY a JSON object, no prose:
{{"display_name": "<clean business name>", "category": "<one valid category>", "confidence": <0.0-1.0>}}"""

    raw = call_llm(prompt).strip()
    raw = raw.replace("```json", "").replace("```", "").strip()
    try:
        data = json.loads(raw)
        cat = data["category"]
        name = (data.get("display_name") or display_name).strip()
        conf = float(data.get("confidence", 0.5))
        if cat not in ALL_CATEGORIES:
            return name, "needs_review", 0.0
        return name, cat, conf
    except Exception:
        return display_name, "needs_review", 0.0


def seed_known_defaults(conn):
    """
    Lock defaults for mixed/known merchants so they skip the LLM and stay consistent.
    These are the big stores that sell across categories (default to the dominant line;
    split exceptions in the dashboard) plus a few stable household merchants. Matched by
    the merchant display_name set by the importer's fingerprint.
    """
    defaults = [
        ("Amazon%",          "shopping"),
        ("Target%",          "groceries"),
        ("Walmart%",         "groceries"),
        ("Wm Supercenter%",  "groceries"),
        ("Costco%",          "kid_expenses"),
        ("Neighborhoodn%",   "housing"),      # HOA
        ("Holistic Tree%",   "housing"),      # landscaping/property
        ("Google Google Store%", "insurance"),   # Pixel device insurance
        ("Angel%",           "home_entertainment"),
        ("Home Depot%",      "housing"),    # home improvement
        ("Lowe's%",          "housing"),    # home improvement (store, not the card payment)
        ("Floor and Decor%", "housing"),    # flooring/home improvement
    ]
    with conn.cursor() as cur:
        for pattern, cat in defaults:
            cur.execute(
                "UPDATE merchants SET default_category=%s, locked=true, updated_at=now() "
                "WHERE display_name ILIKE %s AND locked=false",
                (cat, pattern),
            )
    conn.commit()


def run(dsn: str):
    conn = psycopg.connect(dsn)
    seed_known_defaults(conn)   # lock known merchant defaults before categorizing
    with conn.cursor() as cur:
        # Transactions needing a category: NULL or 'uncategorized', not already corrected.
        cur.execute(
            """
            SELECT t.id, t.merchant_id, m.display_name, t.merchant_raw, t.amount,
                   m.default_category, m.locked
            FROM transactions t
            JOIN merchants m ON m.id = t.merchant_id
            WHERE t.is_deleted = false
              AND t.user_corrected = false
              AND (t.category IS NULL OR t.category = 'uncategorized')
            ORDER BY t.id
            """
        )
        rows = cur.fetchall()

    print(f"{len(rows)} transactions to categorize")
    n_cache = n_llm = 0
    for txn_id, merchant_id, display_name, merchant_raw, amount, default_cat, locked in rows:
        if locked and default_cat:
            category, confidence = default_cat, 1.0
            n_cache += 1
        else:
            new_name, category, confidence = categorize_merchant(conn, display_name, merchant_raw, float(amount))
            n_llm += 1
            # Seed the merchant default + clean display name (UNLOCKED — only a human lock makes it permanent).
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE merchants SET default_category = COALESCE(default_category, %s), "
                    "display_name = %s, updated_at = now() WHERE id = %s AND locked = false",
                    (category, new_name, merchant_id),
                )
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE transactions SET category = %s, confidence = %s WHERE id = %s",
                (category, confidence, txn_id),
            )
        conn.commit()

    print(f"Done. {n_cache} from locked cache, {n_llm} via LLM.")
    conn.close()


if __name__ == "__main__":
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("Set DATABASE_URL")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("Set ANTHROPIC_API_KEY")
    run(dsn)
