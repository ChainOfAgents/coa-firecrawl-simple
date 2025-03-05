import { Request, Response } from "express";
import { Logger } from "../../../lib/logger";
import { getScrapeQueue } from "../../../services/queue-service";
import { checkAlerts } from "../../../services/alerts";
import { QueueJob } from "../../../services/queue/types";

export async function cleanBefore24hCompleteJobsController(
  req: Request,
  res: Response
) {
  Logger.info("🐂 Cleaning jobs older than 24h");
  try {
    const scrapeQueue = getScrapeQueue();
    const batchSize = 10;
    const numberOfBatches = 9; // Adjust based on your needs
    const completedJobsPromises: Promise<QueueJob[]>[] = [];
    for (let i = 0; i < numberOfBatches; i++) {
      completedJobsPromises.push(
        scrapeQueue.getJobs(["completed"])
      );
    }
    const completedJobs: QueueJob[] = (
      await Promise.all(completedJobsPromises)
    ).flat();
    const before24hJobs =
      completedJobs.filter(
        (job) => job.timestamp < Date.now() - 24 * 60 * 60 * 1000
      ) || [];

    let count = 0;

    if (!before24hJobs) {
      return res.status(200).send(`No jobs to remove.`);
    }

    for (const job of before24hJobs) {
      try {
        await scrapeQueue.removeJob(job.id);
        count++;
      } catch (jobError) {
        Logger.error(`🐂 Failed to remove job with ID ${job.id}: ${jobError}`);
      }
    }
    return res.status(200).send(`Removed ${count} completed jobs.`);
  } catch (error) {
    Logger.error(`🐂 Failed to clean last 24h complete jobs: ${error}`);
    return res.status(500).send("Failed to clean jobs");
  }
}

export async function checkQueuesController(req: Request, res: Response) {
  try {
    await checkAlerts();
    return res.status(200).send("Alerts initialized");
  } catch (error) {
    Logger.debug(`Failed to initialize alerts: ${error}`);
    return res.status(500).send("Failed to initialize alerts");
  }
}

// Use this as a "health check" that way we dont destroy the server
export async function queuesController(req: Request, res: Response) {
  try {
    const scrapeQueue = getScrapeQueue();

    const [webScraperActive] = await Promise.all([
      scrapeQueue.getActiveCount(),
    ]);

    const noActiveJobs = webScraperActive === 0;
    // 200 if no active jobs, 503 if there are active jobs
    return res.status(noActiveJobs ? 200 : 503).json({
      webScraperActive,
      noActiveJobs,
    });
  } catch (error) {
    Logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
