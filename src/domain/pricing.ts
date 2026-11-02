/**
 * Deterministic quote pricing. The model extracts what the customer asked for;
 * only this code decides what it costs. Missing or unknown input is reported,
 * never guessed, so a quote can't be priced from incomplete data.
 */

export type Material = {
  code: string;
  name: string;
  aliases: string[];
  /** Vague names that match this entry but need a person to confirm. */
  assumedAliases?: string[];
  densityKgPerM3: number;
  costCentsPerKg: number;
  thicknessesMm: number[];
  cutSpeedMmPerMin: number;
};

export type Finish = { code: string; name: string; aliases: string[]; centsPerM2: number };

export type Catalog = { materials: Material[]; finishes: Finish[] };

export type PricingRules = {
  scrapFactor: number;
  machineCentsPerMin: number;
  bendCentsEach: number;
  setupCentsPerLine: number;
  marginRate: number;
  quantityBreaks: { minQuantity: number; discountRate: number }[];
  shippingBands: { maxKg: number; cents: number }[];
  freightQuoteAboveKg: number;
};

/** A rectangular sheet-metal part. Null means the customer hasn't told us yet. */
export type LineRequest = {
  materialCode: string | null;
  thicknessMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number | null;
  bends: number | null;
  finishCode: string | null;
};

export type PricedLine = {
  unitCents: number;
  lineCents: number;
  weightKg: number;
  discountRate: number;
};

export type QuotePrice =
  | {
      ok: true;
      lines: PricedLine[];
      subtotalCents: number;
      shippingCents: number;
      totalCents: number;
    }
  | { ok: true; lines: PricedLine[]; subtotalCents: number; shippingCents: null; totalCents: null; needsFreightQuote: true }
  | { ok: false; problems: string[] };

const positive = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value > 0;

/** Everything that stops a line being priced, in plain words for the reviewer. */
function lineProblems(line: LineRequest, index: number, catalog: Catalog): string[] {
  const label = `Line ${index + 1}`;
  const problems: string[] = [];
  const material = catalog.materials.find((m) => m.code === line.materialCode);

  if (line.materialCode === null) problems.push(`${label}: material is missing`);
  else if (!material) problems.push(`${label}: unknown material ${line.materialCode}`);

  if (!positive(line.thicknessMm)) problems.push(`${label}: thickness is missing`);
  else if (material && !material.thicknessesMm.includes(line.thicknessMm)) {
    problems.push(`${label}: ${line.thicknessMm} mm ${material.name} is not stocked`);
  }

  if (!positive(line.widthMm)) problems.push(`${label}: width is missing`);
  if (!positive(line.heightMm)) problems.push(`${label}: height is missing`);

  if (!positive(line.quantity)) problems.push(`${label}: quantity is missing`);
  else if (!Number.isInteger(line.quantity)) problems.push(`${label}: quantity must be whole`);

  if (line.bends === null) problems.push(`${label}: bend count is missing`);
  else if (!Number.isInteger(line.bends) || line.bends < 0) {
    problems.push(`${label}: bend count must be a whole number`);
  }

  if (line.finishCode === null) problems.push(`${label}: finish is missing`);
  else if (!catalog.finishes.some((f) => f.code === line.finishCode)) {
    problems.push(`${label}: unknown finish ${line.finishCode}`);
  }

  return problems;
}

function discountFor(quantity: number, rules: PricingRules) {
  return rules.quantityBreaks.reduce(
    (rate, step) => (quantity >= step.minQuantity ? step.discountRate : rate),
    0,
  );
}

function priceLine(line: LineRequest, catalog: Catalog, rules: PricingRules): PricedLine {
  // lineProblems has already rejected anything these assertions could hide.
  const material = catalog.materials.find((m) => m.code === line.materialCode)!;
  const finish = catalog.finishes.find((f) => f.code === line.finishCode)!;
  const quantity = line.quantity!;
  const widthMm = line.widthMm!;
  const heightMm = line.heightMm!;

  const areaM2 = (widthMm * heightMm) / 1_000_000;
  const weightKg = areaM2 * (line.thicknessMm! / 1000) * material.densityKgPerM3;
  const perimeterMm = 2 * (widthMm + heightMm);

  const materialCents = weightKg * rules.scrapFactor * material.costCentsPerKg;
  const cuttingCents = (perimeterMm / material.cutSpeedMmPerMin) * rules.machineCentsPerMin;
  const bendingCents = line.bends! * rules.bendCentsEach;
  const finishCents = areaM2 * finish.centsPerM2;

  const unitCost =
    materialCents + cuttingCents + bendingCents + finishCents + rules.setupCentsPerLine / quantity;
  const discountRate = discountFor(quantity, rules);
  const unitCents = Math.round((unitCost / (1 - rules.marginRate)) * (1 - discountRate));

  // Unit price is rounded first, so the printed quote always multiplies out exactly.
  return { unitCents, lineCents: unitCents * quantity, weightKg: weightKg * quantity, discountRate };
}

export function priceQuote(lines: LineRequest[], catalog: Catalog, rules: PricingRules): QuotePrice {
  if (lines.length === 0) return { ok: false, problems: ['The request has no line items'] };

  const problems = lines.flatMap((line, index) => lineProblems(line, index, catalog));
  if (problems.length > 0) return { ok: false, problems };

  const priced = lines.map((line) => priceLine(line, catalog, rules));
  const subtotalCents = priced.reduce((sum, line) => sum + line.lineCents, 0);
  const totalKg = priced.reduce((sum, line) => sum + line.weightKg, 0);
  const band = rules.shippingBands.find((step) => totalKg <= step.maxKg);

  if (!band || totalKg > rules.freightQuoteAboveKg) {
    return {
      ok: true,
      lines: priced,
      subtotalCents,
      shippingCents: null,
      totalCents: null,
      needsFreightQuote: true,
    };
  }

  return {
    ok: true,
    lines: priced,
    subtotalCents,
    shippingCents: band.cents,
    totalCents: subtotalCents + band.cents,
  };
}
