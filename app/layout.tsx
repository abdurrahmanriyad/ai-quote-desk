import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { logOut } from './actions';
import { getViewer } from '../src/app-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Quote Desk',
  description: 'Turn messy quote requests into drafts a person approves.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const viewer = await getViewer();

  return (
    <html lang="en">
      <body>
        <header className="site">
          <Link href="/" className="brand">
            AI Quote Desk
          </Link>
          {viewer?.canEdit ? (
            <form action={logOut} className="account">
              <span className="tag">{viewer.email}</span>
              <button className="link">Sign out</button>
            </form>
          ) : (
            <span className="tag">
              {viewer ? 'Read-only demo · fictional data · ' : ''}
              <Link href="/login">Sign in</Link>
            </span>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
