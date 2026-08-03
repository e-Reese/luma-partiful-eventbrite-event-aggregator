import type { Metadata } from 'next';
import { Instrument_Serif, Inter } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

const display = Instrument_Serif({
  weight: '400',
  subsets: ['latin'],
  style: ['normal', 'italic'],
  variable: '--font-serif-display',
  display: 'swap',
});

const body = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'The San Francisco Register — everything happening, in one place',
  description:
    'Every public event in San Francisco from Luma, Partiful and Eventbrite, collected every three hours.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen bg-paper text-ink">
        <div className="mx-auto max-w-[46rem] px-6">
          <header className="border-b border-ink pb-3 pt-10">
            <Link href="/" className="block">
              <h1 className="font-display text-[2.75rem] leading-[0.95] tracking-[-0.02em]">
                The San Francisco Register
              </h1>
            </Link>
            <p className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-quiet">
              Luma · Partiful · Eventbrite — collected every three hours
            </p>
          </header>

          {children}

          <footer className="mt-16 border-t border-rule py-8">
            <p className="font-display text-[15px] italic leading-relaxed text-quiet">
              Every listing links back to its original page. Attendance is sampled
              every three hours and recorded only when it moves, so a single figure
              means the number has held steady since we first saw it.
            </p>
            <p className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-faint">
              A reading of public event pages · Not affiliated with any listed platform
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
