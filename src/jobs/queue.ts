import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { failCase, processCase, type Enqueue, type Pipeline } from '../intake/cases';

const QUEUE_NAME = 'quote-cases';

type CaseJob = { tenantId: string; caseId: string };

export type QueueOptions = { connection: ConnectionOptions; prefix?: string; backoffMs?: number };

export function connectionFrom(url = process.env.REDIS_URL): ConnectionOptions {
  if (!url) throw new Error('REDIS_URL is not set');
  const { hostname, port } = new URL(url);
  return { host: hostname, port: Number(port) };
}

export function createCaseQueue(options: QueueOptions) {
  const queue = new Queue<CaseJob>(QUEUE_NAME, {
    connection: options.connection,
    ...(options.prefix ? { prefix: options.prefix } : {}),
  });

  const enqueue: Enqueue = async (job) => {
    await queue.add('process', job, {
      // One job per case: a repeated enqueue can't run the pipeline twice at once.
      jobId: job.caseId,
      attempts: 3,
      backoff: { type: 'exponential', delay: options.backoffMs ?? 1000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  };

  return { queue, enqueue };
}

export function startCaseWorker(deps: Pipeline, options: QueueOptions) {
  const worker = new Worker<CaseJob>(QUEUE_NAME, (job) => processCase(deps, job.data), {
    connection: options.connection,
    concurrency: 4,
    ...(options.prefix ? { prefix: options.prefix } : {}),
  });

  worker.on('failed', (job, error) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      failCase(deps.db, job.data, error.message).catch(console.error);
    }
  });

  return worker;
}
