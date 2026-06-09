import Link from "next/link";

type Tab = "overview" | "transactions" | "subscriptions";

// NOTE: /subscriptions (SETUP Prompt 6) isn't built yet. It must NOT appear here
// until web/app/subscriptions/page.tsx exists: Next.js prefetches every nav
// <Link>, and a prefetch of a missing route returns a 404 that isn't a valid RSC
// payload. Behind the Cloudflare tunnel that poisons the client router and makes
// the next router.replace() (the month/year/custom-range buttons) silently fail.
// Add the entry back in the same step you add the page.
const LINKS: { href: string; label: string; key: Tab }[] = [
  { href: "/", label: "Overview", key: "overview" },
  { href: "/transactions", label: "Transactions", key: "transactions" },
];

export default function SiteHeader({ active }: { active: Tab }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-background/85 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link
          href="/"
          className="font-display text-lg font-medium tracking-tight text-ink"
        >
          Family Finance
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {LINKS.map((l) =>
            l.key === active ? (
              <span
                key={l.key}
                aria-current="page"
                className="rounded-md bg-surface-2 px-3 py-1.5 font-medium text-ink"
              >
                {l.label}
              </span>
            ) : (
              <Link
                key={l.key}
                href={l.href}
                className="rounded-md px-3 py-1.5 text-muted transition-colors hover:text-ink"
              >
                {l.label}
              </Link>
            ),
          )}
          {/* Persistent manual-add entry point; opens the modal on Transactions. */}
          <Link
            href="/transactions?add=1"
            className="ml-2 rounded-md bg-accent px-3 py-1.5 font-semibold text-[#1a130a] transition-opacity hover:opacity-90"
          >
            + Add expense
          </Link>
        </nav>
      </div>
    </header>
  );
}
