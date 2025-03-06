import { Queue, Job, QueueOptions } from 'bullmq';
import { QueueProvider, QueueJob, QueueJobData, QueueJobOptions, QueueJobResult } from '../types';
import { Logger } from '../../../lib/logger';
import { Redis, RedisOptions } from 'ioredis';

// Only initialize Redis if we're actually using Bull as the queue provider
const queueProvider = process.env.QUEUE_PROVIDER || 'bull';
let redisConnection: Redis | null = null;

if (queueProvider === 'bull') {
  // Initialize Redis connection with GCP-compatible settings
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    Logger.error('[QUEUE-SERVICE] REDIS_URL environment variable is not set');
    if (queueProvider === 'bull') {
      throw new Error('REDIS_URL environment variable is required when using Bull queue provider');
    }
  }

  const redisOptions: RedisOptions = {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    autoResubscribe: true,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
    reconnectOnError(err) {
      const targetError = 'READONLY';
      return err.message.includes(targetError);
    },
    connectTimeout: 30000,
    commandTimeout: 30000,
    enableOfflineQueue: true,
    showFriendlyErrorStack: true,
    lazyConnect: true,
    enableAutoPipelining: false,
  };

  // Add GCP Redis compatibility settings that aren't in the type definition
  redisConnection = new Redis(redisUrl, {
    ...redisOptions,
    // GCP Redis compatibility settings
    disableClientSetname: true,
    clientName: '',
    username: '',
    keyPrefix: ''
  } as any); // Type assertion needed for custom Redis options
}

export class BullQueueJob implements QueueJob {
  constructor(private job: Job) {}

  get id(): string {
    return this.job.id;
  }

  get name(): string {
    return this.job.name;
  }

  get data(): QueueJobData {
    return this.job.data;
  }

  get opts(): QueueJobOptions {
    const { backoff, removeOnComplete, removeOnFail, ...otherOpts } = this.job.opts;
    return {
      ...otherOpts,
      backoff: typeof backoff === 'object' ? {
        type: backoff.type as 'fixed' | 'exponential',
        delay: backoff.delay
      } : undefined,
      removeOnComplete: typeof removeOnComplete === 'object' ? {
        age: removeOnComplete.age || 90000
      } : !!removeOnComplete,
      removeOnFail: typeof removeOnFail === 'object' ? {
        age: removeOnFail.age || 90000
      } : !!removeOnFail
    };
  }

  get progress(): number | object {
    return this.job.progress;
  }

  get returnvalue(): QueueJobResult | undefined {
    return this.job.returnvalue;
  }

  get timestamp(): number {
    return this.job.timestamp;
  }

  async getState(): Promise<string> {
    return this.job.getState();
  }

  async updateProgress(progress: number | object): Promise<void> {
    await this.job.updateProgress(progress);
  }

  async moveToCompleted(returnValue: any): Promise<void> {
    await this.job.moveToCompleted(returnValue, this.job.token, false);
  }

  async moveToFailed(error: Error): Promise<void> {
    await this.job.moveToFailed(error, this.job.token);
  }
}

export class BullAdapter implements QueueProvider {
  private queue: Queue;
  private completeCallback?: (jobId: string, result: QueueJobResult) => void;
  private failedCallback?: (jobId: string, error: Error) => void;

  constructor(queueName: string) {
    if (queueProvider !== 'bull') {
      throw new Error('BullAdapter can only be used with Bull queue provider');
    }
    
    if (!redisConnection) {
      throw new Error('Redis connection not initialized. Make sure REDIS_URL is set when using Bull queue provider');
    }

    const queueOptions: QueueOptions = {
      connection: redisConnection,
      defaultJobOptions: {
        removeOnComplete: {
          age: 90000, // 25 hours
        },
        removeOnFail: {
          age: 90000, // 25 hours
        },
        attempts: 3,
        backoff: {
          type: 'exponential' as const,
          delay: 1000,
        },
      }
    };

    this.queue = new Queue(queueName, queueOptions);

    // Set up event handlers
    this.queue.on('completed' as any, async (job: Job, result: any) => {
      if (this.completeCallback) {
        this.completeCallback(job.id, result);
      }
    });

    this.queue.on('failed' as any, async (job: Job, error: Error) => {
      if (this.failedCallback) {
        this.failedCallback(job.id, error);
      }
    });

    // Log Redis connection events
    if (redisConnection) {
      redisConnection.on('connect', () => {
        Logger.debug(`[QUEUE-SERVICE] Redis client connected successfully`);
      });

      redisConnection.on('error', (err) => {
        Logger.error(`[QUEUE-SERVICE] Redis client error: ${err.message}`);
      });
    }
  }

  async addJob(name: string, data: QueueJobData, options: QueueJobOptions = {}): Promise<string> {
    const { backoff, removeOnComplete, removeOnFail, ...otherOpts } = options;
    const job = await this.queue.add(name, data, {
      ...otherOpts,
      backoff: backoff ? {
        type: backoff.type,
        delay: backoff.delay
      } : undefined,
      removeOnComplete: typeof removeOnComplete === 'object' ? {
        age: removeOnComplete.age
      } : removeOnComplete,
      removeOnFail: typeof removeOnFail === 'object' ? {
        age: removeOnFail.age
      } : removeOnFail
    });
    return job.id;
  }

  async addBulk(jobs: { name: string; data: QueueJobData; opts?: QueueJobOptions }[]): Promise<string[]> {
    const bulkJobs = jobs.map(({ name, data, opts = {} }) => ({
      name,
      data,
      opts: {
        ...opts,
        backoff: opts.backoff ? {
          type: opts.backoff.type,
          delay: opts.backoff.delay
        } : undefined,
        removeOnComplete: typeof opts.removeOnComplete === 'object' ? {
          age: opts.removeOnComplete.age
        } : opts.removeOnComplete,
        removeOnFail: typeof opts.removeOnFail === 'object' ? {
          age: opts.removeOnFail.age
        } : opts.removeOnFail
      }
    }));
    
    const addedJobs = await this.queue.addBulk(bulkJobs);
    return addedJobs.map(job => job.id);
  }

  async getJob(jobId: string): Promise<QueueJob | null> {
    const job = await this.queue.getJob(jobId);
    return job ? new BullQueueJob(job) : null;
  }

  async removeJob(jobId: string): Promise<void> {
    await this.queue.remove(jobId);
  }

  async processJob(jobId: string, processor: (job: QueueJob) => Promise<QueueJobResult>): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    
    try {
      const result = await processor(job);
      await job.moveToCompleted(result);
    } catch (error) {
      await job.moveToFailed(error);
      throw error;
    }
  }

  async getJobState(jobId: string): Promise<string> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return 'unknown';
    }
    return await job.getState();
  }

  async getJobResult(jobId: string): Promise<any> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return null;
    }
    return job.returnvalue;
  }

  async getJobError(jobId: string): Promise<Error | null> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      return null;
    }
    if (job.failedReason) {
      return new Error(job.failedReason);
    }
    return null;
  }

  async updateJobProgress(jobId: string, progress: number | object): Promise<void> {
    const job = await this.getJob(jobId);
    if (job) {
      await job.updateProgress(progress);
    }
  }

  async getActiveCount(): Promise<number> {
    return await this.queue.getActiveCount();
  }

  async getWaitingCount(): Promise<number> {
    return await this.queue.getWaitingCount();
  }

  async pause(): Promise<void> {
    await this.queue.pause();
  }

  async resume(): Promise<void> {
    await this.queue.resume();
  }

  onJobComplete(callback: (jobId: string, result: QueueJobResult) => void): void {
    this.completeCallback = callback;
  }

  onJobFailed(callback: (jobId: string, error: Error) => void): void {
    this.failedCallback = callback;
  }
}

// Export Redis connection for rate limiter
export { redisConnection };
