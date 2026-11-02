'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { LineRequest } from '../src/domain/pricing';
import { catalog, context, REVIEWER, rules } from '../src/app-context';
import { IntakeError } from '../src/intake/files';
import { receiveRequest } from '../src/intake/cases';
import { approveQuote, ReviewError, saveCorrections } from '../src/review/review';

export async function uploadRequest(form: FormData) {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) redirect('/?error=Choose a file first');

  const { db, storage, enqueue, tenantId } = await context();
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
  const { db, tenantId } = await context();
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
    await saveCorrections({ db, catalog, rules }, { tenantId, caseId, lines, reviewer: REVIEWER });
  } catch (error) {
    if (error instanceof ReviewError) redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  revalidatePath(`/cases/${caseId}`);
  redirect(`/cases/${caseId}`);
}

export async function approve(caseId: string, form: FormData) {
  const { db, tenantId } = await context();
  try {
    await approveQuote(db, {
      tenantId,
      caseId,
      reviewer: REVIEWER,
      acknowledgedIssues: form.get('acknowledged') === 'on',
    });
  } catch (error) {
    if (error instanceof ReviewError) redirect(`/cases/${caseId}?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
  revalidatePath('/');
  redirect(`/cases/${caseId}`);
}
