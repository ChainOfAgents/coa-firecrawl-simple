import { QueueProvider, QueueJobData, QueueJobOptions } from './queue/types';
import { BullAdapter } from './queue/adapters/bull-adapter';
import { CloudTasksAdapter } from './queue/adapters/cloud-tasks-adapter';
import { stateManager } from './state-management/firestore-state';
import { Logger } from '../lib/logger';

// Queue configuration
export const SCRAPE_QUEUE_NAME = 'scrape';
export const QUEUE_PROVIDER = process.env.QUEUE_PROVIDER || 'bull';
export const IS_LOCAL = process.env.NODE_ENV === 'development';

// Initialize queue provider
let queueProvider: QueueProvider;

// Export queue provider instance
export function getScrapeQueue(): QueueProvider {
  return queueProvider;
}

if (QUEUE_PROVIDER === 'cloud-tasks') {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  const location = process.env.CLOUD_TASKS_LOCATION;
  const queue = process.env.CLOUD_TASKS_QUEUE;
  const serviceUrl = process.env.CLOUD_TASKS_SERVICE_URL;

  if (!project || !location || !queue || !serviceUrl) {
    throw new Error('Missing required Cloud Tasks configuration');
  }

  queueProvider = new CloudTasksAdapter(SCRAPE_QUEUE_NAME);
  Logger.info('[QUEUE-SERVICE] Using Cloud Tasks provider');
} else {
  // Only initialize BullAdapter if we're using Bull
  try {
    queueProvider = new BullAdapter(SCRAPE_QUEUE_NAME);
    Logger.info('[QUEUE-SERVICE] Using BullMQ provider');
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Failed to initialize BullAdapter: ${error.message}`);
    throw new Error(`Failed to initialize BullAdapter: ${error.message}. Make sure REDIS_URL is set when using Bull queue provider.`);
  }
}

// Set up event handlers
queueProvider.onJobComplete(async (jobId, result) => {
  try {
    await stateManager.markJobCompleted(jobId, result);
    Logger.debug(`[QUEUE-SERVICE] Job ${jobId} completed`);
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Error marking job ${jobId} as completed: ${error}`);
  }
});

queueProvider.onJobFailed(async (jobId, error) => {
  try {
    await stateManager.markJobFailed(jobId, error);
    Logger.debug(`[QUEUE-SERVICE] Job ${jobId} failed`);
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Error marking job ${jobId} as failed: ${error}`);
  }
});

// Helper function to create a job
export async function createJob(
  name: string,
  data: QueueJobData,
  options: QueueJobOptions = {}
): Promise<string> {
  try {
    // Create job in queue provider
    const jobId = await queueProvider.addJob(name, data, options);
    Logger.debug(`[QUEUE-SERVICE] Created job ${jobId}`);

    // Create job state in Firestore
    await stateManager.createJob(jobId, name, data, options);

    return jobId;
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Error creating job: ${error}`);
    throw error;
  }
}

// Helper function to get job state
export async function getJobState(jobId: string): Promise<string> {
  try {
    return await queueProvider.getJobState(jobId);
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Error getting job state for ${jobId}: ${error}`);
    throw error;
  }
}

// Helper function to get queue stats
export async function getQueueStats() {
  try {
    const activeCount = await queueProvider.getActiveCount?.() || 0;
    const waitingCount = await queueProvider.getWaitingCount?.() || 0;

    return {
      active: activeCount,
      waiting: waitingCount
    };
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Error getting queue stats: ${error}`);
    throw error;
  }
}

export { queueProvider };

// Re-export Redis connection from bull-adapter only if using Bull
export let redisConnection = null;
if (QUEUE_PROVIDER === 'bull') {
  try {
    // Import only if using Bull
    const { redisConnection: bullRedisConnection } = require('./queue/adapters/bull-adapter');
    redisConnection = bullRedisConnection;
  } catch (error) {
    Logger.warn('[QUEUE-SERVICE] Failed to import Redis connection from bull-adapter');
  }
}