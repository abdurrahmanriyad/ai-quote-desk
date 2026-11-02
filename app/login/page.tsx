import type { Metadata } from 'next';
import { logIn } from '../actions';

export const metadata: Metadata = { title: 'Sign in · AI Quote Desk' };

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  return (
    <form action={logIn} className="login">
      <h1>Sign in</h1>
      {error && <p className="alert" role="alert">{error}</p>}
      <label>Email<input type="email" name="email" autoComplete="username" required /></label>
      <label>Password<input type="password" name="password" autoComplete="current-password" required /></label>
      <button>Sign in</button>
    </form>
  );
}
