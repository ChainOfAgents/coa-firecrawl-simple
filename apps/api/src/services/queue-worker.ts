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

const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 15000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

const cantAcceptConnectionInterval =
  Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 2000;
const connectionMonitorInterval =
  Number(process.env.CONNECTION_MONITOR_INTERVAL) || 10;
const gotJobInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 20;

// Get environment variables for resource thresholds with much higher defaults
const MAX_CPU = Number(process.env.MAX_CPU) || 0.95; // 95% CPU usage threshold
const MAX_RAM = Number(process.env.MAX_RAM) || 0.95; // 95% RAM usage threshold

const processJobInternal = async (token: string, job: Job) => {
  const extendLockInterval = setInterval(async () => {
    Logger.info(`🐂 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  await addJobPriority(job.data.team_id, job.id);
  let err = null;
  try {
    const result = await processJob(job, token);
    try {
      await job.moveToCompleted(result.docs, token, false);
    } catch (e) {}
  } catch (error) {
    console.log("Job failed, error:", error);
    err = error;
    await job.moveToFailed(error, token, false);
  } finally {
    await deleteJobPriority(job.data.team_id, job.id);
    clearInterval(extendLockInterval);
  }

  return err;
};

let isShuttingDown = false;

process.on("SIGINT", () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  isShuttingDown = true;
});

const workerFun = async (
  queueName: string,
  processJobInternal: (token: string, job: Job) => Promise<any>,
) => {
  Logger.info(`🔄 Starting worker for queue: ${queueName}`);
  
  // For testing - use hardcoded Redis URL
  const hardcodedRedisURL = 'redis://10.130.67.11:6379';
  Logger.info(`🔄 [HARDCODED] Using Redis URL: ${hardcodedRedisURL}`);
  Logger.info(`🔄 Original env REDIS_URL value was: ${process.env.REDIS_URL || 'not set'}`);
  
  try {
    // Test Redis connection
    const pingResponse = await redisConnection.ping();
    Logger.info(`🔄 Redis connection test: ${pingResponse}`);
  } catch (error) {
    Logger.error(`🔄 Redis connection test failed: ${error.message}`);
  }
  
  const worker = new Worker(queueName, null, {
    connection: redisConnection,
    lockDuration: 1 * 60 * 1000,
    stalledInterval: 30 * 1000,
    maxStalledCount: 10,
  });

  worker.on('error', err => {
    Logger.error(`🔄 Worker error: ${err.message}`);
  });

  worker.on('failed', (job, err) => {
    Logger.error(`🔄 Job ${job?.id} failed: ${err.message}`);
  });

  worker.on('completed', job => {
    Logger.info(`🔄 Job ${job?.id} completed successfully`);
  });

  worker.startStalledCheckTimer();
  Logger.info(`🔄 Started stalled job check timer`);

  const monitor = await systemMonitor;
  Logger.info(`🔄 System resource monitor initialized`);

  let attemptCount = 0;
  
  while (true) {
    if (isShuttingDown) {
      console.log("No longer accepting new jobs. SIGINT");
      break;
    }
    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();
    
    if (!canAcceptConnection) {
      Logger.debug(`🔄 Cannot accept connection due to resource constraints. CPU/RAM limits reached.`);
      await sleep(cantAcceptConnectionInterval);
      continue;
    }

    try {
      Logger.debug(`🔄 Attempt #${++attemptCount} to get next job from queue ${queueName}`);
      const job = await worker.getNextJob(token);
      
      if (job) {
        Logger.info(`🔄 Got job ${job.id} from queue. Data: ${JSON.stringify({
          url: job.data.url,
          mode: job.data.mode,
          team_id: job.data.team_id,
          jobId: job.id,
          priority: job.opts.priority
        })}`);
        
        processJobInternal(token, job);
        Logger.debug(`🔄 Job ${job.id} processing started`);
        await sleep(gotJobInterval);
      } else {
        // Only log every 10 attempts to reduce log noise
        if (attemptCount % 10 === 0) {
          Logger.debug(`🔄 No jobs available in queue ${queueName} after ${attemptCount} attempts`);
        }
        await sleep(connectionMonitorInterval);
      }
    } catch (error) {
      Logger.error(`🔄 Error getting next job: ${error.message}`);
      await sleep(connectionMonitorInterval);
    }
  }
};

workerFun(scrapeQueueName, processJobInternal);

async function processJob(job: Job, token: string) {
  const startTime = Date.now();
  Logger.info(`🐂 Worker processing job ${job.id} - URL: ${job.data.url}`);

  if (
    job.data.url &&
    (job.data.url.includes("researchhub.com") ||
      job.data.url.includes("ebay.com") ||
      job.data.url.includes("youtube.com"))
  ) {
    Logger.info(`🐂 Blocking job ${job.id} with URL ${job.data.url}`);
    const data = {
      success: false,
      docs: [],
      project_id: job.data.project_id,
      error:
        "URL is blocked. Suspecious activity detected. Please contact hello@firecrawl.com if you believe this is an error.",
    };
    await job.moveToCompleted(data.docs, token, false);
    return data;
  }

  try {
    job.updateProgress({
      current: 1,
      total: 100,
      current_step: "SCRAPING",
      current_url: "",
    });
    const start = Date.now();
    Logger.debug(`🐂 Job ${job.id} - Starting web scraper pipeline`);
    
    const { success, message, docs } = await startWebScraperPipeline({
      job,
      token,
    });
    
    const scrapeDuration = Date.now() - start;
    Logger.info(`🐂 Job ${job.id} - Web scraper pipeline completed in ${scrapeDuration}ms - Success: ${success}, Message: ${message}`);

    if (!success) {
      Logger.error(`🐂 Job ${job.id} failed: ${message}`);
      throw new Error(message);
    }
    
    const docsCount = docs ? docs.length : 0;
    Logger.info(`🐂 Job ${job.id} - Retrieved ${docsCount} documents`);
    
    const end = Date.now();
    const totalDuration = end - startTime;
    Logger.info(`🐂 Job ${job.id} - Total processing time: ${totalDuration}ms`);

    // Fix TypeScript issue - check for Document type first
    const firstDoc = docs[0] as Document;
    const rawHtml = firstDoc && 'rawHtml' in firstDoc ? firstDoc.rawHtml : "";
    Logger.debug(`🐂 Job ${job.id} - Raw HTML length: ${rawHtml ? rawHtml.length : 0} characters`);

    const data = {
      success,
      result: {
        links: docs.map((doc) => {
          return {
            content: doc,
            source: doc?.metadata?.sourceURL ?? doc?.url ?? "",
          };
        }),
      },
      project_id: job.data.project_id,
      error: message /* etc... */,
      docs,
    };

    if (job.data.crawl_id) {
      Logger.debug(`🐂 Job ${job.id} - Updating crawl job status for crawl ID: ${job.data.crawl_id}`);
      await addCrawlJobDone(job.data.crawl_id, job.id);

      const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;

      if (!job.data.sitemapped) {
        if (!sc.cancelled) {
          const crawler = crawlToCrawler(job.data.crawl_id, sc);

          // Fix TypeScript issue - safely access metadata
          const firstDoc = docs[0] as Document;
          const sourceURL = firstDoc && 'metadata' in firstDoc ? firstDoc.metadata?.sourceURL : undefined;
          const finalURL = sourceURL || ('url' in firstDoc ? firstDoc.url : "");

          const links = crawler.extractLinksFromHTML(
            rawHtml,
            finalURL,
          );

          for (const link of links) {
            if (await lockURL(job.data.crawl_id, sc, link)) {
              const jobPriority = await getJobPriority({
                plan: sc.plan as PlanType,
                team_id: sc.team_id,
                basePriority: job.data.crawl_id ? 20 : 10,
              });
              Logger.debug(`🐂 Adding scrape job for link ${link}`);
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

      await finishCrawl(job.data.crawl_id);
    }

    Logger.info(`🐂 Job done ${job.id}`);
    return data;
  } catch (error) {
    Logger.error(`🐂 Job errored ${job.id} - ${error}`);

    if (error instanceof CustomError) {
      Logger.error(error.message);

      logtail.error("Custom error while ingesting", {
        job_id: job.id,
        error: error.message,
        dataIngestionJob: error.dataIngestionJob,
      });
    }
    Logger.error(error);
    if (error.stack) {
      Logger.error(error.stack);
    }

    logtail.error("Overall error ingesting", {
      job_id: job.id,
      error: error.message,
    });

    const data = {
      success: false,
      docs: [],
      project_id: job.data.project_id,
      error:
        "Something went wrong... Contact help@mendable.ai or try again." /* etc... */,
    };

    return data;
  }
}
