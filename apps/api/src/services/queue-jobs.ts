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
    
    const int = setInterval(async () => {
      try {
        if (Date.now() >= start + timeout) {
          clearInterval(int);
          Logger.error(`Job wait timeout for job ${jobId} after ${timeout}ms`);
          reject(new Error("Job wait timeout"));
          return;
        }

        // Use Promise.all to run both queries in parallel
        const queue = getScrapeQueue();
        const [state, job] = await Promise.all([
          queue.getJobState(jobId),
          queue.getJob(jobId)
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
      } catch (error) {
        Logger.error(`Error checking job state for ${jobId}: ${error.message}`);
        // Don't reject here, just log the error and continue trying
      }
    }, 250); // Reduced from 500ms to 250ms for quicker detection
  });
} 
