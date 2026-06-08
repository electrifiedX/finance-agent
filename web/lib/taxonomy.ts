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
