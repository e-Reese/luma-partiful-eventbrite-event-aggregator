import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'SF Events — aggregated from Luma, Partiful & Eventbrite',
  description:
    'Search public San Francisco events collected from Luma, Partiful and Eventbrite, refreshed every three hours.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-ink">
        <header className="border-b border-line">
          <div className="mx-auto flex max-w-5xl items-baseline justify-between gap-4 px-5 py-4">
            <Link href="/" className="text-[15px] font-semibold tracking-tight">
              SF Events
              <span className="ml-2 font-mono text-[11px] font-normal text-muted">
                luma · partiful · eventbrite
              </span>
            </Link>
            <a
              href="https://github.com"
              className="font-mono text-[11px] text-muted hover:text-accent"
            >
              about
            </a>
          </div>
        </header>

        <main className="mx-auto max-w-5xl px-5 py-6">{children}</main>

        <footer className="mx-auto max-w-5xl px-5 pb-10 pt-4">
          <p className="border-t border-line pt-4 font-mono text-[11px] leading-relaxed text-muted">
            Aggregated from public event pages. Counts are sampled every three hours and
            recorded only when they change, so a flat line means genuinely no movement.
            All links point back to the original listing.
          </p>
        </footer>
      </body>
    </html>
  );
}
