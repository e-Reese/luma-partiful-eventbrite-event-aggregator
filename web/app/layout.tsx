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
          <header className="pb-1 pt-10">
            <Link href="/" className="block">
              <h1 className="font-display text-[2.5rem] leading-none tracking-[-0.015em]">
                The San Francisco Register
              </h1>
            </Link>
            <p className="mt-1.5 text-[13px] text-quiet">
              Everything on in the city, from Luma, Partiful and Eventbrite.
            </p>
          </header>

          {children}

          <footer className="mt-14 border-t border-rule py-6">
            <p className="text-[13px] leading-relaxed text-faint">
              Updated every three hours. Every listing links back to its original page.
            </p>
          </footer>
        </div>
      </body>
    </html>
  );
}
