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
      try {
        if (Date.now() >= start + timeout) {
          clearInterval(int);
          Logger.error(`Job wait timeout for job ${jobId} after ${timeout}ms`);
          reject(new Error("Job wait timeout"));
          return;
        }

        // Use Promise.all to run both queries in parallel with timeout protection
        const queue = getScrapeQueue();
        try {
          const [state, job] = await Promise.all([
            Promise.race([
              queue.getJobState(jobId),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Redis command timeout')), 4000))
            ]),
            Promise.race([
              queue.getJob(jobId),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Redis command timeout')), 4000))
            ])
          ]);
          
          // Log state for debugging
          Logger.debug(`Job ${jobId} current state: ${state}`);

          if (state === "completed" && job) {
            clearInterval(int);
            Logger.info(`Job ${jobId} completed successfully in ${Date.now() - start}ms`);
            resolve(job.returnvalue);
          } else if (state === "failed") {
            clearInterval(int);
            const failedReason = job ? job.failedReason : "Unknown failure reason";
            Logger.error(`Job ${jobId} failed: ${failedReason}`);
            reject(failedReason);
          }
        } catch (timeoutError) {
          // If Redis times out, log it but don't fail the job yet
          retryCount++;
          Logger.error(`Redis timeout (attempt ${retryCount}) checking job ${jobId}: ${timeoutError.message}`);
          
          // If we've had too many timeouts, abort
          if (retryCount > 10) {
            clearInterval(int);
            Logger.error(`Too many Redis timeouts (${retryCount}) for job ${jobId}`);
            reject(new Error("Redis connection unstable"));
          }
        }
      } catch (error) {
        Logger.error(`Error checking job state for ${jobId}: ${error.message}`);
        // Don't reject here, just log the error and continue trying
        retryCount++;
      }
    }, 250); // Reduced from 500ms to 250ms for quicker detection
  });
} 
