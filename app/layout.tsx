import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Quote Desk',
  description: 'Turn messy quote requests into drafts a person approves.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site">
          <Link href="/" className="brand">
            AI Quote Desk
          </Link>
          <span className="tag">Northline Fabrication · demo data</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
