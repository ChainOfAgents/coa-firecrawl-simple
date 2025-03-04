import { Job } from "bullmq";
import { getScrapeQueue } from "./queue-service";
import { Logger } from "../lib/logger";

export async function addScrapeJobRaw(
  webScraperOptions: any,
  options: any,
  jobId: string,
  jobPriority: number = 10
): Promise<Job> {
  return await getScrapeQueue().add(jobId, webScraperOptions, {
    ...options,
    priority: jobPriority,
    jobId,
  });
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
