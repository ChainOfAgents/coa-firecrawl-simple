import { QueueProvider, QueueJobData, QueueJobOptions } from './queue/types';
import { CloudTasksAdapter } from './queue/adapters/cloud-tasks-adapter';
import { stateManager } from './state-management/firestore-state';
import { Logger } from '../lib/logger';

// Queue configuration
export const SCRAPE_QUEUE_NAME = 'scrape';
export const IS_LOCAL = process.env.NODE_ENV === 'development';

// Initialize queue provider
let queueProvider: QueueProvider;

// Export queue provider instance
export function getScrapeQueue(): QueueProvider {
  return queueProvider;
}

// Always use Cloud Tasks
const project = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.CLOUD_TASKS_LOCATION;
const queue = process.env.CLOUD_TASKS_QUEUE;
const serviceUrl = process.env.CLOUD_TASKS_SERVICE_URL;

if (!project || !location || !queue || !serviceUrl) {
  throw new Error('Missing required Cloud Tasks configuration');
}

queueProvider = new CloudTasksAdapter(SCRAPE_QUEUE_NAME);
Logger.info('[QUEUE-SERVICE] Using Cloud Tasks provider');

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
  } catch (err) {
    Logger.error(`[QUEUE-SERVICE] Error marking job ${jobId} as failed: ${err}`);
  }
});

/**
 * Helper function to create a job
 */
export async function createJob(
  name: string,
  data: QueueJobData,
  options: QueueJobOptions = {}
): Promise<string> {
  try {
    const jobId = options.jobId || `${name}-${Date.now()}`;
    
    // Create job state in Firestore
    await stateManager.createJob(jobId, name, data, options);
    
    // Add job to queue
    const queueJobId = await queueProvider.addJob(name, data, { ...options, jobId });
    
    return queueJobId;
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Error creating job: ${error}`);
    throw error;
  }
}

/**
 * Helper function to get job state
 */
export async function getJobState(jobId: string): Promise<string> {
  return stateManager.getJobState(jobId);
}

/**
 * Helper function to get queue stats
 */
export async function getQueueStats() {
  try {
    const activeCount = await queueProvider.getActiveCount();
    const waitingCount = await queueProvider.getWaitingCount();
    
    return {
      active: activeCount,
      waiting: waitingCount,
    };
  } catch (error) {
    Logger.error(`[QUEUE-SERVICE] Error getting queue stats: ${error}`);
    return {
      active: 0,
      waiting: 0,
    };
  }
}

export { queueProvider };