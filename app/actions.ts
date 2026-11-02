'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { LineRequest } from '../src/domain/pricing';
import { cookies } from 'next/headers';
import { AuthError, signIn, signOut } from '../src/auth/index';
import { catalog, context, requireEditor, rules, SESSION_COOKIE } from '../src/app-context';
import { uploadsInLastHour } from '../src/usage/index';
import { IntakeError } from '../src/intake/files';
import { receiveRequest } from '../src/intake/cases';
import { approveQuote, ReviewError, saveCorrections } from '../src/review/review';

const UPLOADS_PER_HOUR = 30;

export async function uploadRequest(form: FormData) {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) redirect('/?error=Choose a file first');

  const { tenantId } = await requireEditor();
  const { db, storage, enqueue } = await context();
  if ((await uploadsInLastHour(db, tenantId)) >= UPLOADS_PER_HOUR) {
    redirect('/?error=Upload limit reached. Try again in an hour.');
  }

  let caseId: string;
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    ({ caseId } = await receiveRequest({ db, storage, enqueue }, { tenantId, filename: file.name, bytes }));
  } catch (error) {
    if (error instanceof IntakeError) redirect(`/?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  redirect(`/cases/${caseId}`);
}

const numberOrNull = (value: FormDataEntryValue | null) => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

const codeOrNull = (value: FormDataEntryValue | null) => String(value ?? '') || null;

export async function saveLines(caseId: string, count: number, form: FormData) {
  const { tenantId, reviewer } = await requireEditor();
  const { db } = await context();
  const lines: LineRequest[] = Array.from({ length: count }, (_, index) => ({
    materialCode: codeOrNull(form.get(`materialCode-${index}`)),
    thicknessMm: numberOrNull(form.get(`thicknessMm-${index}`)),
    widthMm: numberOrNull(form.get(`widthMm-${index}`)),
    heightMm: numberOrNull(form.get(`heightMm-${index}`)),
    quantity: numberOrNull(form.get(`quantity-${index}`)),
    bends: numberOrNull(form.get(`bends-${index}`)),
    finishCode: codeOrNull(form.get(`finishCode-${index}`)),
  }));

  try {
    await saveCorrections({ db, catalog, rules }, { tenantId, caseId, lines, reviewer });
  } catch (error) {
    if (error instanceof ReviewError) redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  revalidatePath(`/cases/${caseId}`);
  redirect(`/cases/${caseId}`);
}

export async function approve(caseId: string, form: FormData) {
  const { tenantId, reviewer } = await requireEditor();
  const { db } = await context();
  try {
    await approveQuote(db, {
      tenantId,
      caseId,
      reviewer,
      acknowledgedIssues: form.get('acknowledged') === 'on',
    });
  } catch (error) {
    if (error instanceof ReviewError) redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  revalidatePath('/');
  redirect(`/cases/${caseId}`);
}

export async function logIn(form: FormData) {
  const { db } = await context();
  let session: Awaited<ReturnType<typeof signIn>>;
  try {
    session = await signIn(db, String(form.get('email') ?? ''), String(form.get('password') ?? ''));
  } catch (error) {
    if (error instanceof AuthError) redirect(`/login?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  (await cookies()).set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: session.maxAgeSeconds,
  });
  redirect('/');
}

export async function logOut() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await signOut((await context()).db, token);
  store.delete(SESSION_COOKIE);
  redirect('/login');
}
