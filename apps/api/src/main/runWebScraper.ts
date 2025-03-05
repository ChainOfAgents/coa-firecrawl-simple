import { WebScraperOptions, RunWebScraperParams, RunWebScraperResult } from "../types";
import { WebScraperDataProvider } from "../scraper/WebScraper";
import { Progress } from "../lib/entities";
import { Document } from "../lib/entities";
import { Logger } from "../lib/logger";
import { QueueJob } from "../services/queue/types";
import { configDotenv } from "dotenv";
configDotenv();

export async function startWebScraperPipeline({
  job,
  token,
}: {
  job: QueueJob;
  token: string;
}) {
  let partialDocs: Document[] = [];
  Logger.info(`🌐 Starting web scraper pipeline for job ${job.id} - URL: ${job.data.url}`);
  
  try {
    Logger.debug(`🌐 Job ${job.id} - Mode: ${job.data.mode}, Team ID: ${job.data.team_id}`);
    
    const startTime = Date.now();
    const result = await runWebScraper({
      url: job.data.url,
      mode: job.data.mode,
      crawlerOptions: job.data.crawlerOptions,
      pageOptions: {
        ...job.data.pageOptions,
        ...(job.data.crawl_id
          ? {
              includeRawHtml: true,
            }
          : {}),
      },
      webhookUrl: job.data.webhookUrl,
      webhookMetadata: job.data.webhookMetadata,
      inProgress: (progress) => {
        Logger.debug(`🌐 Job ${job.id} in progress - Status: ${progress.status}, Current: ${progress.current}/${progress.total}`);
        if (progress.currentDocument) {
          partialDocs.push(progress.currentDocument);
          if (partialDocs.length > 50) {
            partialDocs = partialDocs.slice(-50);
          }
          job.updateProgress({ ...progress, partialDocs: partialDocs });
        }
      },
      onSuccess: (result, mode) => {
        const duration = Date.now() - startTime;
        Logger.info(`🌐 Job ${job.id} completed in ${duration}ms - Mode: ${mode}, Result count: ${Array.isArray(result) ? result.length : 0}`);
      },
      onError: (error) => {
        Logger.error(`🌐 Job ${job.id} failed - Error: ${error.message}`);
        job.moveToFailed(error);
      },
      team_id: job.data.team_id,
      bull_job_id: job.id.toString(),
      priority: job.opts.priority,
      is_scrape: job.data.is_scrape ?? false,
      crawl_id: job.data.crawl_id,
    });
    
    Logger.info(`🌐 Job ${job.id} - Web scraper completed - Success: ${result.success}, Docs: ${result.docs?.length || 0}`);
    return result;
  } catch (error) {
    Logger.error(`🌐 Job ${job.id} - Web scraper pipeline failed with error: ${error.message}`);
    throw error;
  }
}

export async function runWebScraper({
  url,
  mode,
  crawlerOptions,
  pageOptions,
  webhookUrl,
  webhookMetadata,
  inProgress,
  onSuccess,
  onError,
  team_id,
  bull_job_id,
  crawl_id,
  priority,
  is_scrape = false,
}: RunWebScraperParams): Promise<RunWebScraperResult> {
  try {
    const provider = new WebScraperDataProvider();
    if (mode === "crawl") {
      provider.setOptions({
        jobId: bull_job_id,
        mode: mode,
        urls: [url],
        crawlerOptions: crawlerOptions,
        pageOptions: pageOptions,
        webhookUrl: webhookUrl,
        webhookMetadata: webhookMetadata,
        bullJobId: bull_job_id,
        crawlId: crawl_id,
        priority,
      });
    } else {
      provider.setOptions({
        jobId: bull_job_id,
        mode: mode,
        urls: url.split(","),
        crawlerOptions: crawlerOptions,
        pageOptions: pageOptions,
        webhookUrl: webhookUrl,
        webhookMetadata: webhookMetadata,
        crawlId: crawl_id,
        teamId: team_id,
      });
    }
    const docs = (await provider.getDocuments(false, (progress: Progress) => {
      inProgress(progress);
    })) as Document[];

    if (docs.length === 0) {
      return {
        success: true,
        message: "No pages found",
        docs: [],
      };
    }

    // remove docs with empty content
    const filteredDocs = crawlerOptions.returnOnlyUrls
      ? docs.map((doc) => {
          if (doc.metadata.sourceURL) {
            return { url: doc.metadata.sourceURL };
          }
        })
      : docs;

    // This is where the returnvalue from the job is set
    onSuccess(filteredDocs, mode);

    // this return doesn't matter too much for the job completion result
    return { success: true, message: "", docs: filteredDocs };
  } catch (error) {
    onError(error);
    return { success: false, message: error.message, docs: [] };
  }
}
