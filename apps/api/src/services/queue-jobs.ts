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
        } else {
          // Get the job state and log it for debugging
          const state = await getScrapeQueue().getJobState(jobId);
          const elapsedTime = Date.now() - start;
          
          if (elapsedTime % 10000 === 0) { // Log every 10 seconds
            Logger.debug(`Waiting for job ${jobId}, state: ${state}, elapsed: ${elapsedTime}ms`);
          }
          
          if (state === "completed") {
            clearInterval(int);
            const job = await getScrapeQueue().getJob(jobId);
            if (!job) {
              Logger.error(`Job ${jobId} not found after completion`);
              reject(new Error("Job not found after completion"));
            } else {
              Logger.debug(`Job ${jobId} completed successfully in ${Date.now() - start}ms`);
              resolve(job.returnvalue);
            }
          } else if (state === "failed") {
            clearInterval(int);
            const job = await getScrapeQueue().getJob(jobId);
            const failedReason = job ? job.failedReason : "Unknown failure reason";
            Logger.error(`Job ${jobId} failed: ${failedReason}`);
            reject(failedReason);
          }
        }
      } catch (error) {
        Logger.error(`Error checking job ${jobId} state: ${error}`);
        // Don't reject here, just log the error and continue trying
      }
    }, 500);
  });
}
