import "dotenv/config";
import { CustomError } from "../lib/custom-error";
import {
  getScrapeQueue,
  SCRAPE_QUEUE_NAME,
} from "./queue-service";
import { logtail } from "./logtail";
import { startWebScraperPipeline } from "../main/runWebScraper";
import { Logger } from "../lib/logger";
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
} from "../lib/crawl-firestore";
import { StoredCrawl, CrawlJob } from "../lib/crawl-firestore";
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
import { QueueJob } from "./queue/types";
configDotenv();

// Set up a simple HTTP server for Cloud Run health checks
const app = express();
// Use the PORT environment variable provided by Cloud Run
const port = process.env.PORT || 8080;
const host = process.env.HOST || "0.0.0.0";

/**
 * Health check endpoint for Cloud Run
 * This endpoint is used by Cloud Run to determine if the worker service is healthy
 * It returns a 200 OK response with a simple message
 */
app.get("/health", (req, res) => {
  res.status(200).send("Worker is healthy");
});

// Start the HTTP server
try {
  Logger.info(`Attempting to start worker server on ${host}:${port}`);
  const server = app.listen(Number(port), host, () => {
    Logger.info(`Worker healthcheck server listening on ${host}:${port}`);
    Logger.info(`Health check available at http://${host}:${port}/health`);
  });

  server.on('error', (error) => {
    Logger.error(`Server error: ${error.message}`);
    console.error('Worker server failed to start:', error);
  });
} catch (error) {
  Logger.error(`Failed to start worker server: ${error.message}`);
  console.error('Exception during worker server startup:', error);
  throw error;
}

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

export async function processJobInternal(token: string, job: QueueJob) {
  Logger.info(`[Job ${job.id}] Starting job processing`);
  
  try {
    const result = await processJob(job, token);
    
    try {
      try {
        await job.moveToCompleted(result.docs);
        Logger.info(`[Job ${job.id}] Successfully completed job`);
        
        const state = await getScrapeQueue().getJobState(job.id);
      } catch (e) {
        Logger.error(`[Job ${job.id}] Error moving job to completed state: ${e.message}`);
        try {
          await job.updateProgress(100);
          
          await getScrapeQueue().addJob(
            job.name,
            { ...job.data, completed: true, success: true, docs: result.docs },
            { jobId: job.id, priority: job.opts.priority }
          );
          Logger.info(`[Job ${job.id}] Successfully completed job using alternative method`);
          
          const state = await getScrapeQueue().getJobState(job.id);
        } catch (altError) {
          Logger.error(`[Job ${job.id}] Alternative completion strategy failed: ${altError.message}`);
          try {
            await getScrapeQueue().removeJob(job.id);
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
    try {
      Logger.info(`[Job ${job.id}] Moving job to failed state`);
      await job.moveToFailed(e);
      Logger.info(`[Job ${job.id}] Successfully moved job to failed state`);
    } catch (moveError) {
      Logger.error(`[Job ${job.id}] Error moving job to failed state: ${moveError.message}`);
    }
    throw e;
  }
}

async function processJob(job: QueueJob, token: string) {
  const startTime = Date.now();
  Logger.info(`[Job ${job.id}] Starting web scraper pipeline`);

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

      if (!success) {
        Logger.error(`[Job ${job.id}] Pipeline failed: ${message}`);
        throw new Error(message);
      }

      // Handle crawl-related functionality
      if (job.data.crawl_id) {
        Logger.info(`[Job ${job.id}] Processing crawl ID: ${job.data.crawl_id}`);
        await addCrawlJobDone(job.data.crawl_id, job.id);

        const sc = await getCrawl(job.data.crawl_id) as StoredCrawl;
        await processCrawlLinks(job, docs, sc);
      }

      return { success: true, docs };
    } finally {
      await deleteJobPriority(job.data.team_id, job.id);
    }
  } catch (error) {
    Logger.error(`[Job ${job.id}] Job processing failed: ${error.message}`);
    throw error;
  }
}

async function processCrawlLinks(job: QueueJob, docs: any[], sc: StoredCrawl) {
  Logger.info(`[Job ${job.id}] Processing links for crawl ID: ${job.data.crawl_id}`);
  const crawler = crawlToCrawler(job.data.crawl_id, sc);
  
  if (!job.data.sitemapped && !sc.cancelled) {
    const links = docs.map((doc) => doc.url).filter((url) => url);
    const existingJobs: CrawlJob[] = await getCrawlJobs(job.data.crawl_id);
    const existingUrls = new Set(existingJobs.map(j => j.url));
    const newLinks = links.filter((url) => !existingUrls.has(url));

    Logger.info(
      `[Job ${job.id}] Found ${newLinks.length} new links to crawl for crawl ID: ${job.data.crawl_id}`
    );

    for (const url of newLinks) {
      try {
        // Check if URL is locked (being processed by another crawler)
        const isLocked = await lockURL(url, job.data.crawl_id);
        if (!isLocked) {
          Logger.info(`[Job ${job.id}] URL ${url} is already being processed, skipping`);
          continue;
        }

        // Add new job for this URL
        const jobId = uuidv4();
        const jobPriority = 10;
        await addScrapeJobRaw(
          {
            url,
            crawlerOptions: crawler,
            team_id: job.data.team_id,
            pageOptions: job.data.pageOptions,
            origin: job.data.origin,
            crawl_id: job.data.crawl_id,
            sitemapped: true,
          },
          {
            priority: jobPriority,
          },
          jobId,
          jobPriority
        );
        await addCrawlJob(job.data.crawl_id, jobId);
      } catch (error) {
        Logger.error(`[Job ${job.id}] Error processing URL ${url}: ${error.message}`);
      }
    }
  }

  await finishCrawl(job.data.crawl_id);
}

let isShuttingDown = false;

process.on("SIGINT", () => {
  Logger.info("Received SIGINT. Shutting down gracefully...");
  isShuttingDown = true;
  process.exit(0);
});

async function workerFun(
  queueName: string,
  processJobInternal: (token: string, job: QueueJob) => Promise<any>,
) {
  let consecutiveEmptyPolls = 0;
  let currentInterval = BASE_EMPTY_INTERVAL;

  while (!isShuttingDown) {
    try {
      // Check system resources
      const monitor = await systemMonitor;
      const { cpu, memory } = await monitor.getSystemMetrics();
      
      if (cpu > MAX_CPU || memory > MAX_RAM) {
        Logger.info(`High resource usage detected - CPU: ${cpu.toFixed(2)}, Memory: ${memory.toFixed(2)}`);
        await sleep(cantAcceptConnectionInterval);
        continue;
      }

      const queue = getScrapeQueue();
      const token = uuidv4();

      const job = await queue.getNextJob();
      
      if (!job) {
        consecutiveEmptyPolls++;
        if (consecutiveEmptyPolls >= MAX_EMPTY_POLLS) {
          currentInterval = Math.min(currentInterval * 2, cantAcceptConnectionInterval);
        }
        await sleep(currentInterval);
        continue;
      }

      consecutiveEmptyPolls = 0;
      currentInterval = BASE_EMPTY_INTERVAL;

      try {
        await processJobInternal(token, job);
      } catch (error) {
        Logger.error(`Error processing job ${job.id}: ${error.message}`);
        if (error.stack) {
          Logger.error(`Error stack trace: ${error.stack}`);
        }
        // Wait longer on error
        await sleep(connectionMonitorInterval * 2);
      }
    } catch (error) {
      Logger.error(`Worker error: ${error.message}`);
      if (error.stack) {
        Logger.error(`Error stack trace: ${error.stack}`);
      }
      await sleep(cantAcceptConnectionInterval);
    }
  }
}

workerFun(SCRAPE_QUEUE_NAME, processJobInternal);