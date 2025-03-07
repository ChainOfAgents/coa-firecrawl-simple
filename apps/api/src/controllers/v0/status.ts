import { Request, Response } from "express";
import { authenticateUser } from "../auth";
import { getScrapeQueue } from "../../services/queue-service";
import { getCrawl, getCrawlJobs } from "../../lib/crawl-firestore";
import { Logger } from "../../lib/logger";
import { getJobs } from "../../controllers/v1/crawl-status";
import { RateLimiterMode } from "../../types";

export async function crawlJobStatusPreviewController(req: Request, res: Response) {
  try {
    const { success, team_id, error, status } = await authenticateUser(req, res, RateLimiterMode.CrawlStatus);
    if (!success) {
      return res.status(status).json({ error });
    }

    const jobId = req.params.jobId;
    const sc = await getCrawl(jobId);
    if (!sc) {
      return res.status(404).json({ error: "Job not found" });
    }

    const jobIDs = await getCrawlJobs(jobId);
    const jobs = await getJobs(jobId, jobIDs.map(j => j.jobId));

    const jobStatuses = await Promise.all(jobs.map(x => x.getState()));
    const jobStatus = sc.cancelled ? "failed" : jobStatuses.every(x => x === "completed") ? "completed" : jobStatuses.some(x => x === "failed") ? "failed" : "active";

    const data = jobs.map(x => Array.isArray(x.returnvalue) ? x.returnvalue[0] : x.returnvalue);

    if (
      jobs.length > 0 &&
      jobs[0].data &&
      jobs[0].data.pageOptions &&
      !jobs[0].data.pageOptions.includeRawHtml
    ) {
      data.forEach(item => {
        if (item) {
          delete item.rawHtml;
        }
      });
    }

    res.json({
      status: jobStatus,
      current: jobStatuses.filter(x => x === "completed" || x === "failed").length,
      total: jobs.length,
      data: jobStatus === "completed" ? data : null,
      partial_data: jobStatus === "completed" ? [] : data.filter(x => x !== null),
    });
  } catch (error) {
    Logger.error(error);
    return res.status(500).json({ error: error.message });
  }
}
