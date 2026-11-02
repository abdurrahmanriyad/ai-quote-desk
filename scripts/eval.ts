/**
 * Runs extraction over the samples and scores it against the correct answers.
 * This spends real API money. Usage:
 *   npm run eval -- --model claude-haiku-5-5 --limit 5
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import catalogJson from '../data/demo-company/catalog.json' with { type: 'json' };
import rulesJson from '../data/demo-company/pricing.json' with { type: 'json' };
import { priceQuote, type Catalog, type PricingRules } from '../src/domain/pricing';
import { extractRequest, requestContent } from '../src/extraction/extract';
import { interpretationNotes, interpretLine, verifyEvidence } from '../src/extraction/interpret';
import { MODEL_PRICES } from '../src/usage/index';
import { scoreSample, type Gold } from '../evals/score';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-haiku-5-5' },
    limit: { type: 'string', default: '1000' },
    set: { type: 'string', default: 'samples' },
    split: { type: 'string', default: 'dev' },
    'max-usd': { type: 'string', default: '3' },
    'confirm-test': { type: 'boolean', default: false },
  },
});
const model = values.model;
const known = MODEL_PRICES[model];
if (!known) throw new Error(`No price known for ${model}`);
const price = known;

const catalog = catalogJson as Catalog;
const rules = rulesJson as PricingRules;
const ROOT = join(import.meta.dirname, '../data', values.set);
const isEvalSet = values.set === 'eval-set';
if (isEvalSet && values.split === 'test' && !values['confirm-test']) {
  throw new Error('The test split is for final runs only. Pass --confirm-test to use it.');
}
const maxUsd = Number(values['max-usd']);
const OUTPUT = join(import.meta.dirname, '../evals/results');

// Takes every Nth sample so a small run still covers each kind.
const ids = readdirSync(ROOT)
  .sort()
  .filter(
    (id) =>
      !isEvalSet ||
      (JSON.parse(readFileSync(join(ROOT, id, 'gold.json'), 'utf8')) as Gold & { split: string }).split === values.split,
  );
const limit = Math.min(Number(values.limit), ids.length);
const chosen = ids.filter((_, index) => Math.floor((index * limit) / ids.length) !== Math.floor(((index - 1) * limit) / ids.length) || index === 0);

const MEDIA_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.csv': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
};

const client = new Anthropic();
let spentUsd = 0;

async function runOne(id: string) {
  const gold = JSON.parse(readFileSync(join(ROOT, id, 'gold.json'), 'utf8')) as Gold;
  const bytes = readFileSync(join(ROOT, id, gold.source));
  const mediaType = MEDIA_TYPES[extname(gold.source)]!;
  const isText = mediaType === 'text/plain';
  const content = requestContent(mediaType, bytes);
  const started = performance.now();

  try {
    const { extraction, usage } = await extractRequest(client, { model, content });
    spentUsd += (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
    const lines = extraction.lines.map((line) => interpretLine(line, catalog));
    const quote = priceQuote(lines, catalog, rules);
    return {
      id,
      kind: gold.kind,
      ms: Math.round(performance.now() - started),
      usage,
      ...scoreSample(gold, lines, quote),
      evidenceIssues: isText ? verifyEvidence(extraction, bytes.toString('utf8')) : [],
      notes: interpretationNotes(extraction, catalog),
      flaggedInjection: extraction.containsInstructionsToSoftware,
      containsInjection: gold.containsInjection,
      quotePriced: quote.ok,
      lines,
      expectedLines: gold.lines,
      error: null,
    };
  } catch (error) {
    return { id, kind: gold.kind, error: error instanceof Error ? error.message : String(error) };
  }
}

const results: Awaited<ReturnType<typeof runOne>>[] = [];
const queue = [...chosen];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (spentUsd >= maxUsd) throw new Error(`Stopped at the $${maxUsd} spending limit`);
      results.push(await runOne(id));
    }
  }),
);
results.sort((a, b) => a.id.localeCompare(b.id));

const done = results.filter((r): r is Extract<typeof r, { error: null }> => r.error === null);
const sum = (pick: (r: (typeof done)[number]) => number) => done.reduce((total, r) => total + pick(r), 0);
const rate = (count: number, total: number) => (total ? Number((count / total).toFixed(3)) : null);
const inputTokens = sum((r) => r.usage.inputTokens);
const outputTokens = sum((r) => r.usage.outputTokens);
const costUsd = (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
const latencies = done.map((r) => r.ms).sort((a, b) => a - b);

const summary = {
  model,
  samples: results.length,
  errors: results.length - done.length,
  quoteOutcomeAccuracy: rate(done.filter((r) => r.priceMatch).length, results.length),
  fieldAccuracy: rate(sum((r) => r.fieldsCorrect), sum((r) => r.fieldsTotal)),
  lineCountAccuracy: rate(done.filter((r) => r.linesMatch).length, done.length),
  evidenceClean: rate(done.filter((r) => r.evidenceIssues.length === 0).length, done.length),
  injectionsFlagged: `${done.filter((r) => r.containsInjection && r.flaggedInjection).length}/${done.filter((r) => r.containsInjection).length}`,
  falseInjectionFlags: done.filter((r) => !r.containsInjection && r.flaggedInjection).length,
  costUsd: Number(costUsd.toFixed(4)),
  costPerRequestUsd: Number((costUsd / Math.max(done.length, 1)).toFixed(5)),
  latencyP50Ms: latencies[Math.floor(latencies.length / 2)] ?? null,
  // The dangerous failure: a wrong quote that reaches a reviewer with no warning.
  silentlyWrong: done.filter((r) => !r.priceMatch && r.quotePriced && r.evidenceIssues.length === 0 && r.notes.length === 0 && !r.flaggedInjection).length,
};

const byKind = Object.fromEntries(
  [...new Set(results.map((r) => r.kind))].map((kind) => {
    const inKind = done.filter((r) => r.kind === kind);
    return [kind, `${inKind.filter((r) => r.priceMatch).length}/${results.filter((r) => r.kind === kind).length}`];
  }),
);

mkdirSync(OUTPUT, { recursive: true });
const name = isEvalSet ? `eval-${values.split}-${model}` : model;
writeFileSync(join(OUTPUT, `${name}.json`), `${JSON.stringify({ summary, byKind, results }, null, 2)}\n`);
console.log(summary);
console.log(byKind);
for (const r of results) {
  if (r.error !== null) console.log(`ERROR ${r.id} ${r.kind}: ${r.error}`);
  else if (!r.priceMatch) console.log(`MISS  ${r.id} ${r.kind}${r.quotePriced ? ' (priced)' : ''}`);
}
