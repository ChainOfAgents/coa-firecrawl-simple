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

const jobLockExtendInterval = Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 30000; // 30s
const jobLockExtensionTime = Number(process.env.JOB_LOCK_EXTENSION_TIME) || 120000; // 2m
const cantAcceptConnectionInterval = Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 5000; // 5s
const connectionMonitorInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 1000; // 1s
const gotJobInterval = Number(process.env.GOT_JOB_INTERVAL) || 2000; // 2s

// Resource thresholds
const MAX_CPU = Number(process.env.MAX_CPU) || 0.95;
const MAX_RAM = Number(process.env.MAX_RAM) || 0.95;

export async function processJobInternal(token: string, job: Job) {
  Logger.info(`Processing job ${job.id}`);
  
  // Set up lock extension interval
  const extendLockInterval = setInterval(async () => {
    try {
      await job.extendLock(token, jobLockExtensionTime);
    } catch (e) {
      Logger.error(`Failed to extend job lock: ${e.message}`);
    }
  }, jobLockExtendInterval);

  try {
    const result = await processJob(job, token);
    
    try {
      await job.moveToCompleted(result.docs, token, false);
      
      // Verify job state after completion
      const state = await getScrapeQueue().getJobState(job.id);
      Logger.info(`Job ${job.id} completed with state: ${state}`);
    } catch (e) {
      Logger.error(`Error completing job ${job.id}: ${e.message}`);
      throw e;
    }
  } catch (e) {
    Logger.error(`Error processing job ${job.id}: ${e.message}`);
    try {
      await job.moveToFailed(e, token);
    } catch (moveError) {
      Logger.error(`Error moving job ${job.id} to failed state: ${moveError.message}`);
    }
    throw e;
  } finally {
    clearInterval(extendLockInterval);
  }
}

async function processJob(job: Job, token: string) {
  const startTime = Date.now();
  Logger.info(`Starting web scraper pipeline for job ${job.id}`);
  
  try {
    Logger.info(`Adding job priority for job ${job.id}`);
    await addJobPriority(job.data.team_id, job.id);

    try {
      // Update progress
      await job.updateProgress({
        current: 1,
        total: 100,
        current_step: "SCRAPING",
        current_url: "",
      });

      Logger.info(`Starting web scraper pipeline execution for job ${job.id}`);
      const { success, message, docs } = await startWebScraperPipeline({ job, token });
      Logger.info(`Web scraper pipeline completed for job ${job.id}`);
      
      if (!success) {
        Logger.error(`Pipeline failed for job ${job.id}: ${message}`);
        throw new Error(message);
      }

      // Handle crawl-related functionality
      if (job.data.crawl_id) {
        Logger.info(`Processing crawl ID: ${job.data.crawl_id}`);
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

      Logger.info(`Job ${job.id} completed successfully in ${Date.now() - startTime}ms`);
      return data;
    } finally {
      Logger.info(`Removing job priority for job ${job.id}`);
      await deleteJobPriority(job.data.team_id, job.id);
    }
  } catch (error) {
    Logger.error(`Error in job processing for job ${job.id}: ${error.message}`);
    
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
  Logger.info(`Processing links for crawl ID: ${job.data.crawl_id}`);
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
        
        Logger.debug(`Adding scrape job for link: ${link}`);
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
  
  const worker = new Worker(queueName, null, {
    connection: redisConnection,
    lockDuration: jobLockExtensionTime,
    stalledInterval: 60000, // 1 minute
    maxStalledCount: 1,
  });

  worker.on('error', err => {
    Logger.error(`Worker error: ${err.message}`);
  });

  worker.on('failed', (job, err) => {
    Logger.error(`Job ${job?.id} failed: ${err.message}`);
  });

  worker.startStalledCheckTimer();
  const monitor = await systemMonitor;
  
  while (true) {
    if (isShuttingDown) {
      Logger.info("Shutting down worker");
      break;
    }

    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();
    
    if (!canAcceptConnection) {
      await sleep(cantAcceptConnectionInterval);
      continue;
    }

    try {
      const job = await worker.getNextJob(token);
      
      if (job) {
        Logger.info(`Processing job ${job.id}`);
        processJobInternal(token, job);
        await sleep(gotJobInterval);
      } else {
        await sleep(connectionMonitorInterval);
      }
    } catch (error) {
      Logger.error(`Error getting next job: ${error.message}`);
      await sleep(connectionMonitorInterval);
    }
  }
};

workerFun(scrapeQueueName, processJobInternal);
