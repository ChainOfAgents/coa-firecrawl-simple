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
  const startTime = Date.now();
  let lastState = '';
  
  Logger.debug(`[QUEUE-JOBS] Starting to wait for job ${jobId} with timeout ${timeout}ms`);
  
  while (Date.now() - startTime < timeout) {
    try {
      // Get the current job state
      const jobState = await getScrapeQueue().getJobState(jobId);
      
      // Log state changes
      if (jobState !== lastState) {
        Logger.debug(`[QUEUE-JOBS] Job ${jobId} state: ${jobState}`);
        lastState = jobState;
      }
      
      // Check if the job is completed or failed
      if (jobState === 'completed') {
        Logger.debug(`[QUEUE-JOBS] Job ${jobId} is completed, retrieving result`);
        
        // Get the job result
        const result = await getScrapeQueue().getJobResult(jobId);
        Logger.debug(`[QUEUE-JOBS] Job ${jobId} result retrieved: ${result ? 'has data' : 'null or undefined'}`);
        
        if (result) {
          // Log information about the result
          const resultType = typeof result;
          Logger.debug(`[QUEUE-JOBS] Job ${jobId} result type: ${resultType}`);
          
          if (resultType === 'object') {
            if (Array.isArray(result)) {
              Logger.debug(`[QUEUE-JOBS] Job ${jobId} result is an array with ${result.length} items`);
            } else if (result !== null) {
              Logger.debug(`[QUEUE-JOBS] Job ${jobId} result keys: ${Object.keys(result).join(', ')}`);
              
              // Check if result has docs field
              if (result.docs) {
                Logger.debug(`[QUEUE-JOBS] Job ${jobId} result has docs array with ${result.docs.length} items`);
              }
            }
          }
        }
        
        // If result is null or undefined, wait a bit longer and try again
        if (!result) {
          Logger.warn(`[QUEUE-JOBS] Job ${jobId} has completed state but no result, waiting for result to be available`);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }
        
        Logger.debug(`[QUEUE-JOBS] Successfully retrieved result for job ${jobId}`);
        return result;
      } else if (jobState === 'failed') {
        // Get the job error
        Logger.debug(`[QUEUE-JOBS] Job ${jobId} is failed, retrieving error`);
        const error = await getScrapeQueue().getJobError(jobId);
        
        if (error) {
          Logger.error(`[QUEUE-JOBS] Job ${jobId} failed with error: ${error.message}`);
          throw error;
        } else {
          Logger.error(`[QUEUE-JOBS] Job ${jobId} failed without an error message`);
          throw new Error(`Job ${jobId} failed without an error message`);
        }
      } else if (jobState === 'unknown' || jobState === 'not_found') {
        Logger.error(`[QUEUE-JOBS] Job ${jobId} not found`);
        throw new Error(`Job ${jobId} not found`);
      } else {
        // For other states (created, waiting, active), log the time spent waiting
        const elapsedTime = Date.now() - startTime;
        const remainingTime = timeout - elapsedTime;
        
        if (elapsedTime % 5000 < 200) { // Log approximately every 5 seconds
          Logger.debug(`[QUEUE-JOBS] Still waiting for job ${jobId}, state: ${jobState}, elapsed: ${elapsedTime}ms, remaining: ${remainingTime}ms`);
        }
      }
      
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      // If the error is about the job not being found, throw it immediately
      if (error.message && error.message.includes('not found')) {
        Logger.error(`[QUEUE-JOBS] Error: ${error.message}`);
        throw error;
      }
      
      // For other errors, log and continue trying
      Logger.error(`[QUEUE-JOBS] Error checking job ${jobId} state: ${error}`);
      Logger.error(`[QUEUE-JOBS] Error details: ${JSON.stringify(error)}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // If we've reached here, the job has timed out
  const errorMessage = `Timeout waiting for job ${jobId} after ${timeout}ms`;
  Logger.error(`[QUEUE-JOBS] ${errorMessage}`);
  throw new Error(errorMessage);
}
