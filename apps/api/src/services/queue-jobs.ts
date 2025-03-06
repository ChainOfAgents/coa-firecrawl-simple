import { QueueJobData, QueueJobOptions } from "./queue/types";
import { getScrapeQueue } from "./queue-service";
import { Logger } from "../lib/logger";
import { v4 as uuidv4 } from 'uuid';

// Export getScrapeQueue for use in other files
export { getScrapeQueue } from "./queue-service";

// Default team ID for system-generated requests
const DEFAULT_TEAM_ID = 'system';

export async function addScrapeJobRaw(
  webScraperOptions: QueueJobData,
  options: QueueJobOptions,
  jobId: string,
  jobPriority: number = 10
): Promise<string> {
  // Ensure team_id is defined
  if (webScraperOptions && webScraperOptions.team_id === undefined) {
    webScraperOptions.team_id = DEFAULT_TEAM_ID;
    Logger.debug(`Setting default team_id (${DEFAULT_TEAM_ID}) for job ${jobId}`);
  }
  
  // Add the job to the queue
  const queueJobId = await getScrapeQueue().addJob(jobId, webScraperOptions, {
    ...options,
    priority: jobPriority,
    jobId,
  });
  
  // Log if the queue provider returned a different job ID
  if (queueJobId !== jobId) {
    Logger.warn(`Queue provider returned a different job ID (${queueJobId}) than requested (${jobId})`);
  }
  
  // Always return the original jobId for consistency
  return jobId;
}

/**
 * Add a scrape job to the queue
 * @param url URL to scrape
 * @param options Job options
 * @returns Job ID
 */
export async function addScrapeJob(
  url: string,
  options: {
    team_id?: string;
    user_id?: string;
    priority?: number;
    delay?: number;
    ttl?: number;
    timeout?: number;
    removeLinks?: boolean;
    maxLinks?: number;
    maxDepth?: number;
    followLinks?: boolean;
    waitTime?: number;
    proxy?: string;
    userAgent?: string;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    [key: string]: any;
  } = {}
): Promise<string> {
  const data = {
    url,
    team_id: options.team_id || DEFAULT_TEAM_ID, // Use default team_id if undefined
    user_id: options.user_id,
    removeLinks: options.removeLinks,
    maxLinks: options.maxLinks,
    maxDepth: options.maxDepth,
    followLinks: options.followLinks,
    waitTime: options.waitTime,
    proxy: options.proxy,
    userAgent: options.userAgent,
    cookies: options.cookies,
    headers: options.headers,
  };

  const jobOptions = {
    priority: options.priority,
    delay: options.delay,
    ttl: options.ttl,
    timeout: options.timeout,
  };

  const jobId = uuidv4(); // Generate a unique job ID
  return addScrapeJobRaw(data, jobOptions, jobId, options.priority);
}

export async function waitForJob(jobId: string, timeout = 60000): Promise<any> {
  Logger.debug(`Waiting for job ${jobId} with timeout ${timeout}ms`);
  
  const startTime = Date.now();
  let lastState = '';
  
  while (Date.now() - startTime < timeout) {
    try {
      // Get the current job state
      const jobState = await getScrapeQueue().getJobState(jobId);
      
      // Log state changes
      if (jobState !== lastState) {
        Logger.debug(`Job ${jobId} state: ${jobState}`);
        lastState = jobState;
      }
      
      // Check if the job is completed or failed
      if (jobState === 'completed') {
        // Get the job result
        const result = await getScrapeQueue().getJobResult(jobId);
        return result;
      } else if (jobState === 'failed') {
        // Get the job error
        const error = await getScrapeQueue().getJobError(jobId);
        if (error) {
          throw error;
        } else {
          throw new Error(`Job ${jobId} failed without an error message`);
        }
      } else if (jobState === 'unknown' || jobState === 'not_found') {
        throw new Error(`Job ${jobId} not found`);
      }
      
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      // If the error is about the job not being found, throw it immediately
      if (error.message && error.message.includes('not found')) {
        throw error;
      }
      
      // For other errors, log and continue trying
      Logger.error(`Error checking job ${jobId} state: ${error}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // If we've reached here, the job has timed out
  throw new Error(`Timeout waiting for job ${jobId} after ${timeout}ms`);
}
