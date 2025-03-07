import { Request, Response } from "express";
import { authenticateUser } from "../auth";
import { RateLimiterMode } from "../../../src/types";
import { getScrapeQueue } from "../../../src/services/queue-service";
import { Logger } from "../../../src/lib/logger";
import { getCrawl, getCrawlJobs } from "../../../src/lib/crawl-firestore";
import { configDotenv } from "dotenv";
configDotenv();

export async function getJobs(crawlId: string, ids: string[]) {
  const jobs = (await Promise.all(ids.map(x => getScrapeQueue().getJob(x)))).filter(x => x);

  jobs.forEach(job => {
    job.returnvalue = Array.isArray(job.returnvalue) ? job.returnvalue[0] : job.returnvalue;
  });

  return jobs;
}

export async function crawlStatusController(req: Request, res: Response) {
  try {
    const { success, team_id, error, status } = await authenticateUser(req, res, RateLimiterMode.CrawlStatus);
    if (!success) {
      return res.status(status).json({ error });
    }

    const crawlId = req.params.crawlId;

    const crawl = await getCrawl(crawlId);
    if (!crawl) {
      return res.status(404).json({ error: "Crawl not found" });
    }

    if (crawl.team_id !== team_id) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const jobIDs = await getCrawlJobs(crawlId);
    const jobs = await getJobs(crawlId, jobIDs.map(j => j.jobId));

    return res.json({
      jobs,
      crawl,
    });
  } catch (error) {
    Logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
