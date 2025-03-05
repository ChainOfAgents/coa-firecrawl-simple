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
  
  return await getScrapeQueue().addJob(jobId, webScraperOptions, {
    ...options,
    priority: jobPriority,
    jobId,
  });
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

export function waitForJob(jobId: string, timeout: number) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let retryCount = 0;
    
    const int = setInterval(async () => {
      // Check for timeout
      if (Date.now() >= start + timeout) {
        clearInterval(int);
        Logger.error(`Job wait timeout for job ${jobId} after ${timeout}ms`);
        reject(new Error("Job wait timeout"));
        return;
      }

      try {
        // Set a timeout for this specific Redis command
        const getJobPromise = getScrapeQueue().getJob(jobId);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Redis command timeout')), 3000)
        );
        
        const job = await Promise.race([getJobPromise, timeoutPromise]);
        
        if (!job) {
          Logger.error(`Job ${jobId} not found`);
          clearInterval(int);
          reject(new Error(`Job ${jobId} not found`));
          return;
        }
        
        // Get job state with timeout protection
        const getStatePromise = (job as any).getState();
        const stateTimeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Get state command timeout')), 3000)
        );
        
        const state = await Promise.race([getStatePromise, stateTimeoutPromise]);
        Logger.debug(`Job ${jobId} state: ${state}`);
        
        if (state === 'completed') {
          clearInterval(int);
          // Type assertion to handle the unknown type
          const returnData = (job as any).returnvalue;
          Logger.info(`Job ${jobId} completed successfully in ${Date.now() - start}ms`);
          resolve(returnData);
        } else if (state === 'failed') {
          clearInterval(int);
          // Type assertion to handle the unknown type
          const failReason = (job as any).failedReason || 'Unknown error';
          Logger.error(`Job ${jobId} failed: ${failReason}`);
          reject(new Error(`Job ${jobId} failed: ${failReason}`));
        }
      } catch (error) {
        // Handle Redis timeouts
        if (error.message.includes('timeout')) {
          retryCount++;
          Logger.error(`Redis timeout (attempt ${retryCount}) checking job ${jobId}: ${error.message}`);
          
          // If we've had too many timeouts, abort
          if (retryCount > 10) {
            clearInterval(int);
            Logger.error(`Too many Redis timeouts (${retryCount}) for job ${jobId}`);
            reject(new Error("Redis connection unstable"));
          }
        } else {
          // Handle other errors
          Logger.error(`Error checking job state for ${jobId}: ${error.message}`);
          retryCount++;
        }
      }
    }, 250); // Poll every 250ms
  });
}
