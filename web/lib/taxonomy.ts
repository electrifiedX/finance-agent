// The v1 category taxonomy — keep in sync with llm/categorize.py and docs/BRIEF.md §9.
// Shared by the Transactions filters and (later) the edit/split modal.

export const SPENDING_CATEGORIES = [
  "groceries",
  "eating_out",
  "coffee_snacks",
  "utilities",
  "housing",
  "home_entertainment",
  "outings_activities",
  "fitness",
  "medical",
  "wellness",
  "automotive",
  "insurance",
  "toiletries_home",
  "childcare",
  "kid_expenses",
  "pets",
  "travel",
  "giving",
  "gifts",
  "personal_andy",
  "personal_tina",
  "shopping",
  "interest",
  "fees",
  "needs_review",
  "uncategorized",
] as const;

export const NONSPENDING_CATEGORIES = [
  "transfer",
  "income",
  "misc_income",
  "refund",
  "business_expense",
  "cash_withdrawal",
] as const;

export const ALL_CATEGORIES = [
  ...SPENDING_CATEGORIES,
  ...NONSPENDING_CATEGORIES,
] as const;

// txn_type values (db/schema.sql). The edit/add modal exposes all of them so an
// imported guess can be corrected (e.g. a mis-typed "sale" that is really a transfer).
export const TXN_TYPES = [
  "sale",
  "payment",
  "fee",
  "return",
  "transfer",
  "income",
  "business_expense",
  "cash",
] as const;

const NONSPENDING_SET = new Set<string>(NONSPENDING_CATEGORIES);

// txn_types that are never family spending regardless of the chosen category.
const NONSPENDING_TYPES = new Set<string>([
  "payment",
  "transfer",
  "income",
  "business_expense",
  "return",
]);

// Single source of truth for is_spending so the API and UI agree. Category is the
// primary signal (it maps cleanly to the §9 taxonomy); txn_type catches transfers
// /payments/refunds that may still carry a spending-ish category.
export function deriveIsSpending(
  category: string | null | undefined,
  txnType: string | null | undefined,
): boolean {
  if (txnType && NONSPENDING_TYPES.has(txnType)) return false;
  if (category && NONSPENDING_SET.has(category)) return false;
  return true;
}

// Lightweight mirror of importers/common.py fingerprint() for merchants created
// by hand in the UI. We only need enough normalization to collapse the obvious
// "Chipotle" vs "chipotle " duplicates; the heavy bank-string folding lives in
// the Python importer where raw feeds arrive.
export function fingerprint(displayName: string): string {
  return (displayName || "")
    .toUpperCase()
    .replace(/[*#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
