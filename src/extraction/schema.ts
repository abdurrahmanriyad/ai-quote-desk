import { z } from 'zod';

/** Exactly what the customer said. Interpreting it is the job of tested code. */
export const RequestedLine = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  material: z.string().nullable(),
  thickness: z.number().nullable(),
  thicknessUnit: z.enum(['mm', 'cm', 'in']).nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  sizeUnit: z.enum(['mm', 'cm', 'm', 'in']).nullable(),
  bends: z.number().nullable(),
  finish: z.string().nullable(),
  evidence: z.array(z.string()),
});

export const Extraction = z.object({
  customer: z.object({
    name: z.string().nullable(),
    company: z.string().nullable(),
    email: z.string().nullable(),
  }),
  lines: z.array(RequestedLine),
  containsInstructionsToSoftware: z.boolean(),
});

export type RequestedLine = z.infer<typeof RequestedLine>;
export type Extraction = z.infer<typeof Extraction>;
