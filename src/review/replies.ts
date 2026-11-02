/** Reply drafts come from templates, so nothing the model read can steer the wording. */

const greeting = (name: string | null) => `Hi ${name?.split(' ')[0] ?? 'there'},`;

/** Customers don't know our line numbers, so questions name the part they asked for. */
const forCustomer = (problem: string, parts: string[]) =>
  problem.replace(/^Line (\d+): /, (_, line: string) => `${parts[Number(line) - 1] ?? 'Your item'}: `);

export function clarificationEmail(
  name: string | null,
  problems: string[],
  parts: string[],
  company: string,
) {
  const questions = problems.map((problem) => `- ${forCustomer(problem, parts)}`).join('\n');
  return `${greeting(name)}

Thanks for your request. Before we can prepare a quote, we need to confirm a few details:

${questions}

Reply here when you can, and we'll send the quote.

${company}`;
}

export function quoteEmail(name: string | null, quoteNumber: number, validDays: number, company: string) {
  return `${greeting(name)}

Quote ${quoteNumber} is attached. It's valid for ${validDays} days. Reply to this email if you'd like to go ahead or change anything.

${company}`;
}
