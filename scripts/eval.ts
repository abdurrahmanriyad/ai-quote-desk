/**
 * Runs extraction over the samples and scores it against the correct answers.
 * This spends real API money. Usage:
 *   npm run eval -- --model claude-haiku-5-5 --limit 5
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import catalogJson from '../data/demo-company/catalog.json' with { type: 'json' };
import rulesJson from '../data/demo-company/pricing.json' with { type: 'json' };
import { priceQuote, type Catalog, type PricingRules } from '../src/domain/pricing';
import { extractRequest, requestContent } from '../src/extraction/extract';
import { interpretLine, verifyEvidence } from '../src/extraction/interpret';
import { scoreSample, type Gold } from '../evals/score';

const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

const { values } = parseArgs({
  options: { model: { type: 'string', default: 'claude-haiku-5-5' }, limit: { type: 'string', default: '30' } },
});
const model = values.model;
const price = PRICES[model];
if (!price) throw new Error(`No price known for ${model}`);

const catalog = catalogJson as Catalog;
const rules = rulesJson as PricingRules;
const ROOT = join(import.meta.dirname, '../data/samples');
const OUTPUT = join(import.meta.dirname, '../evals/results');

// Takes every Nth sample so a small run still covers each kind.
const ids = readdirSync(ROOT).sort();
const limit = Math.min(Number(values.limit), ids.length);
const chosen = ids.filter((_, index) => Math.floor((index * limit) / ids.length) !== Math.floor(((index - 1) * limit) / ids.length) || index === 0);

const client = new Anthropic();

async function runOne(id: string) {
  const gold = JSON.parse(readFileSync(join(ROOT, id, 'gold.json'), 'utf8')) as Gold;
  const text = readFileSync(join(ROOT, id, gold.source), 'utf8');
  const content = requestContent('text/plain', Buffer.from(text));
  const started = performance.now();

  try {
    const { extraction, usage } = await extractRequest(client, { model, content });
    const lines = extraction.lines.map((line) => interpretLine(line, catalog));
    const quote = priceQuote(lines, catalog, rules);
    return {
      id,
      kind: gold.kind,
      ms: Math.round(performance.now() - started),
      usage,
      ...scoreSample(gold, lines, quote),
      evidenceIssues: verifyEvidence(extraction, text),
      flaggedInjection: extraction.containsInstructionsToSoftware,
      containsInjection: gold.containsInjection,
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
    for (let id = queue.shift(); id; id = queue.shift()) results.push(await runOne(id));
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
};

mkdirSync(OUTPUT, { recursive: true });
writeFileSync(join(OUTPUT, `${model}.json`), `${JSON.stringify({ summary, results }, null, 2)}\n`);
console.log(summary);
for (const r of results) {
  if (r.error !== null) console.log(`ERROR ${r.id} ${r.kind}: ${r.error}`);
  else if (!r.priceMatch) console.log(`MISS  ${r.id} ${r.kind}`);
}
