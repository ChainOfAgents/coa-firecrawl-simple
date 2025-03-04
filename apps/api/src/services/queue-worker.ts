import "dotenv/config";
import { CustomError } from "../lib/custom-error";
import {
  getScrapeQueue,
  redisConnection,
  scrapeQueueName,
} from "./queue-service";
import { logtail } from "./logtail";
import { startWebScraperPipeline } from "../main/runWebScraper";
import { Logger } from "../lib/logger";
import { Job, Worker } from "bullmq";
import systemMonitor from "./system-monitor";
import { v4 as uuidv4 } from "uuid";
import {
  addCrawlJob,
  addCrawlJobDone,
  crawlToCrawler,
  finishCrawl,
  getCrawl,
  getCrawlJobs,
  lockURL,
} from "../lib/crawl-redis";
import { StoredCrawl } from "../lib/crawl-redis";
import { addScrapeJobRaw } from "./queue-jobs";
import {
  addJobPriority,
  deleteJobPriority,
  getJobPriority,
} from "../../src/lib/job-priority";
import { PlanType } from "../types";
import { getJobs } from "../../src/controllers/v1/crawl-status";
import { configDotenv } from "dotenv";
import { callWebhook } from "../../src/scraper/WebScraper/single_url";
import express from "express";
import { Document, DocumentUrl } from "../lib/entities";
configDotenv();

// Set up a simple HTTP server for Cloud Run health checks
const app = express();
const port = process.env.PORT || 3002;
const host = process.env.HOST || "0.0.0.0";

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).send("Worker is healthy");
});

// Start the HTTP server
const server = app.listen(Number(port), host, () => {
  Logger.info(`Worker healthcheck server listening on port ${port}`);
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Increase intervals to reduce Redis pressure
const jobLockExtendInterval = Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 30000; // 30s
const jobLockExtensionTime = Number(process.env.JOB_LOCK_EXTENSION_TIME) || 120000; // 2m

// Increase polling intervals
const cantAcceptConnectionInterval = Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 5000; // 5s
const connectionMonitorInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 1000; // 1s
const gotJobInterval = Number(process.env.GOT_JOB_INTERVAL) || 2000; // 2s

// Resource thresholds
const MAX_CPU = Number(process.env.MAX_CPU) || 0.95;
const MAX_RAM = Number(process.env.MAX_RAM) || 0.95;

// Maximum number of consecutive empty queue polls before increasing interval
const MAX_EMPTY_POLLS = 5;
// Base polling interval when queue is empty (in ms)
const BASE_EMPTY_INTERVAL = 1000;

export async function processJobInternal(token: string, job: Job) {
  Logger.info(`[Job ${job.id}] Starting job processing`);
  
  // Set up lock extension interval
  const extendLockInterval = setInterval(async () => {
    try {
      await job.extendLock(token, jobLockExtensionTime);
      Logger.debug(`[Job ${job.id}] Lock extended successfully`);
    } catch (e) {
      Logger.error(`[Job ${job.id}] Failed to extend job lock: ${e.message}`);
    }
  }, jobLockExtendInterval);

  try {
    Logger.debug(`[Job ${job.id}] Processing job with token: ${token}`);
    const result = await processJob(job, token);
    Logger.debug(`[Job ${job.id}] Job processing completed, moving to completion phase`);
    
    try {
      Logger.debug(`[Job ${job.id}] Attempting to move job to completed state`);
      try {
        await job.moveToCompleted(result.docs, token, false);
        Logger.debug(`[Job ${job.id}] Successfully moved job to completed state`);
        
        // Verify job state after completion
        const state = await getScrapeQueue().getJobState(job.id);
        Logger.debug(`[Job ${job.id}] Job state after completion: ${state}`);
      } catch (e) {
        Logger.error(`[Job ${job.id}] Error moving job to completed state: ${e.message}`);
        // Try again with a different approach
        try {
          Logger.debug(`[Job ${job.id}] Attempting alternative completion strategy`);
          await job.updateProgress(100);
          Logger.debug(`[Job ${job.id}] Updated progress to 100%`);
          
          // Update the job data in Redis directly through the queue
          Logger.debug(`[Job ${job.id}] Adding completed job data to queue`);
          await getScrapeQueue().add(
            job.name, 
            { ...job.data, completed: true, success: true, docs: result.docs }, 
            { jobId: job.id, priority: job.opts.priority }
          );
          Logger.debug(`[Job ${job.id}] Alternative completion strategy succeeded`);
          
          // Double check the job state
          const state = await getScrapeQueue().getJobState(job.id);
          Logger.debug(`[Job ${job.id}] Job state after alternative completion: ${state}`);
        } catch (altError) {
          Logger.error(`[Job ${job.id}] Alternative completion strategy failed: ${altError.message}`);
          // Last resort - try to remove the job and mark it as completed
          try {
            Logger.debug(`[Job ${job.id}] Attempting last resort - removing job`);
            await getScrapeQueue().remove(job.id);
            Logger.info(`[Job ${job.id}] Successfully removed job as last resort`);
          } catch (removeError) {
            Logger.error(`[Job ${job.id}] Failed to remove job: ${removeError.message}`);
          }
        }
      }
    } catch (e) {
      Logger.error(`[Job ${job.id}] Final error in job completion process: ${e.message}`);
      throw e;
    }
  } catch (e) {
    Logger.error(`[Job ${job.id}] Error during job processing: ${e.message}`);
    Logger.debug(`[Job ${job.id}] Error stack trace: ${e.stack}`);
    try {
      Logger.info(`[Job ${job.id}] Moving job to failed state`);
      await job.moveToFailed(e, token);
      Logger.info(`[Job ${job.id}] Successfully moved job to failed state`);
    } catch (moveError) {
      Logger.error(`[Job ${job.id}] Error moving job to failed state: ${moveError.message}`);
    }
    throw e;
  } finally {
    clearInterval(extendLockInterval);
  }
}

async function processJob(job: Job, token: string) {
  const startTime = Date.now();
  Logger.info(`[Job ${job.id}] Starting web scraper pipeline`);
  Logger.debug(`[Job ${job.id}] Processing job with data: ${JSON.stringify(job.data)}`);

  // Check blocked URLs
  if (
    job.data.url &&
    (job.data.url.includes("researchhub.com") ||
      job.data.url.includes("ebay.com") ||
      job.data.url.includes("youtube.com"))
  ) {
    Logger.info(`[Job ${job.id}] Blocking job with URL ${job.data.url}`);
    return {
      success: false,
      docs: [],
      project_id: job.data.project_id,
      error: "URL is blocked. Suspicious activity detected. Please contact hello@firecrawl.com if you believe this is an error.",
    };
  }

  try {
    Logger.info(`[Job ${job.id}] Adding job priority`);
    await addJobPriority(job.data.team_id, job.id);

    try {
      // Update progress
      await job.updateProgress({
        current: 1,
        total: 100,
        current_step: "SCRAPING",
        current_url: "",
      });

      Logger.info(`[Job ${job.id}] Starting web scraper pipeline execution`);
      const { success, message, docs } = await startWebScraperPipeline({ job, token });
      Logger.info(`[Job ${job.id}] Web scraper pipeline completed`);
      Logger.debug(`[Job ${job.id}] Pipeline result: success=${success}, message=${message}, docs.length=${docs?.length}`);

      if (!success) {
        Logger.error(`[Job ${job.id}] Pipeline failed: ${message}`);
        throw new Error(message);
      }

      // Handle crawl-related functionality
      if (job.data.crawl_id) {
        Logger.info(`[Job ${job.id}] Processing crawl ID: ${job.data.crawl_id}`);
        await addCrawlJobDone(job.data.crawl_id, job.id);

        const sc = await getCrawl(job.data.crawl_id) as StoredCrawl;
        if (!job.data.sitemapped && !sc.cancelled) {
          await processCrawlLinks(job, docs, sc);
        }
        await finishCrawl(job.data.crawl_id);
      }

      const data = {
        success,
        result: {
          links: docs.map((doc) => ({
            content: doc,
            source: doc?.metadata?.sourceURL ?? doc?.url ?? "",
          })),
        },
        project_id: job.data.project_id,
        error: message,
        docs,
      };

      Logger.info(`[Job ${job.id}] Job completed successfully in ${Date.now() - startTime}ms`);
      return data;
    } finally {
      Logger.info(`[Job ${job.id}] Removing job priority`);
      await deleteJobPriority(job.data.team_id, job.id);
    }
  } catch (error) {
    Logger.error(`[Job ${job.id}] Error in job processing: ${error.message}`);
    Logger.debug(`[Job ${job.id}] Error stack trace: ${error.stack}`);

    if (error instanceof CustomError) {
      logtail.error("Custom error while ingesting", {
        job_id: job.id,
        error: error.message,
        dataIngestionJob: error.dataIngestionJob,
      });
    } else {
      logtail.error("Overall error ingesting", {
        job_id: job.id,
        error: error.message,
      });
    }

    return {
      success: false,
      docs: [],
      project_id: job.data.project_id,
      error: "Something went wrong... Contact help@mendable.ai or try again.",
    };
  }
}

// Helper function for processing crawl links
async function processCrawlLinks(job: Job, docs: any[], sc: StoredCrawl) {
  Logger.info(`[Job ${job.id}] Processing links for crawl ID: ${job.data.crawl_id}`);
  const crawler = crawlToCrawler(job.data.crawl_id, sc);
  
  // Get the source URL from the first document
  const firstDoc = docs[0] as Document;
  const sourceURL = firstDoc?.metadata?.sourceURL || firstDoc?.url;
  const rawHtml = firstDoc?.rawHtml || "";

  if (sourceURL) {
    const links = crawler.extractLinksFromHTML(rawHtml, sourceURL);
    
    for (const link of links) {
      if (await lockURL(job.data.crawl_id, sc, link)) {
        const jobPriority = await getJobPriority({
          plan: sc.plan as PlanType,
          team_id: sc.team_id,
          basePriority: job.data.crawl_id ? 20 : 10,
        });
        
        Logger.debug(`[Job ${job.id}] Adding scrape job for link: ${link}`);
        const newJob = await addScrapeJobRaw(
          {
            url: link,
            mode: "single_urls",
            crawlerOptions: sc.crawlerOptions,
            team_id: sc.team_id,
            pageOptions: sc.pageOptions,
            webhookUrl: job.data.webhookUrl,
            webhookMetadata: job.data.webhookMetadata,
            origin: job.data.origin,
            crawl_id: job.data.crawl_id,
            v1: job.data.v1,
          },
          {},
          uuidv4(),
          jobPriority,
        );

        await addCrawlJob(job.data.crawl_id, newJob.id);
      }
    }
  }
}

let isShuttingDown = false;

process.on("SIGINT", () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  isShuttingDown = true;
});

const workerFun = async (
  queueName: string,
  processJobInternal: (token: string, job: Job) => Promise<any>,
) => {
  Logger.info(`Starting worker for queue: ${queueName}`);
  
  // Use environment variable for Redis URL
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    Logger.error('REDIS_URL environment variable is not set');
    throw new Error('REDIS_URL environment variable is required');
  }
  Logger.info(`Using Redis URL from environment: ${redisUrl}`);
  
  try {
    // Test Redis connection
    const pingResponse = await redisConnection.ping();
    Logger.info(`Redis connection test: ${pingResponse}`);
  } catch (error) {
    Logger.error(`Redis connection test failed: ${error.message}`);
    throw error; // Don't continue if we can't connect to Redis
  }
  
  const worker = new Worker(queueName, null, {
    connection: redisConnection,
    lockDuration: jobLockExtensionTime,
    stalledInterval: 60000, // 1 minute
    maxStalledCount: 1, // Only retry once before considering job stalled
  });

  worker.on('error', err => {
    Logger.error(`Worker error: ${err.message}`);
  });

  worker.on('failed', (job, err) => {
    Logger.error(`Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('completed', job => {
    Logger.info(`Job ${job?.id} completed successfully`);
  });

  worker.startStalledCheckTimer();
  Logger.info(`Started stalled job check timer`);

  const monitor = await systemMonitor;
  Logger.info(`System resource monitor initialized`);

  let attemptCount = 0;
  let emptyQueueCount = 0;
  
  while (true) {
    if (isShuttingDown) {
      Logger.info("No longer accepting new jobs. SIGINT received.");
      break;
    }

    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();
    
    if (!canAcceptConnection) {
      Logger.debug(`Cannot accept connection due to resource constraints. CPU/RAM limits reached.`);
      await sleep(cantAcceptConnectionInterval);
      continue;
    }

    try {
      Logger.debug(`Attempt #${++attemptCount} to get next job from queue ${queueName}`);
      const job = await worker.getNextJob(token);
      
      if (job) {
        emptyQueueCount = 0; // Reset empty queue counter
        Logger.info(`Got job ${job.id}. Mode: ${job.data.mode}, Team: ${job.data.team_id}`);
        
        processJobInternal(token, job);
        Logger.debug(`Job ${job.id} processing started`);
        await sleep(gotJobInterval);
      } else {
        emptyQueueCount++;
        // Calculate exponential backoff interval
        const backoffInterval = Math.min(
          BASE_EMPTY_INTERVAL * Math.pow(2, Math.floor(emptyQueueCount / MAX_EMPTY_POLLS)),
          30000 // Max 30 second interval
        );
        
        // Only log every MAX_EMPTY_POLLS attempts
        if (emptyQueueCount % MAX_EMPTY_POLLS === 0) {
          Logger.debug(`No jobs available after ${emptyQueueCount} attempts. Waiting ${backoffInterval}ms`);
        }
        await sleep(backoffInterval);
      }
    } catch (error) {
      Logger.error(`Error getting next job: ${error.message}`);
      await sleep(connectionMonitorInterval * 2); // Double the interval on error
    }
  }
};

workerFun(scrapeQueueName, processJobInternal);
