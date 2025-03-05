import { Response } from "express";
import { CrawlStatusParams, CrawlStatusResponse, ErrorResponse, legacyDocumentConverter, RequestWithAuth } from "./types";
import { getCrawl, getCrawlExpiry, getCrawlJobs, getDoneJobsOrdered, getDoneJobsOrderedLength } from "../../lib/crawl-redis";
import { getScrapeQueue } from "../../services/queue-service";
import { configDotenv } from "dotenv";
configDotenv();

/**
 * @openapi
 * /v1/crawl/{jobId}:
 *   get:
 *     tags:
 *       - Crawling
 *     summary: Get crawl job status
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: jobId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [completed, failed, in_progress]
 *                 pages:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       url:
 *                         type: string
 *                       content:
 *                         type: string
 */
export async function getJobs(crawlId: string, jobIds: string[]): Promise<any[]> {
  const queue = getScrapeQueue();
  const jobs = await Promise.all(
    jobIds.map(async (jobId) => {
      try {
        const job = await queue.getJob(jobId);
        if (!job) {
          return {
            jobId,
            status: "not_found",
            timestamp: Date.now(),
          };
        }
        const state = await queue.getJobState(jobId);
        return {
          jobId,
          state,
          timestamp: job.timestamp || Date.now(),
          returnvalue: job.returnvalue,
        };
      } catch (error) {
        console.error(`Error getting job ${jobId}: ${error.message}`);
        return {
          jobId,
          state: "error",
          error: error.message,
          timestamp: Date.now(),
        };
      }
    })
  );
  return jobs;
}

export async function crawlStatusController(req: RequestWithAuth<CrawlStatusParams, undefined, CrawlStatusResponse>, res: Response<CrawlStatusResponse>) {
  try {
    const { team_id } = req.auth;
    const crawlId = req.params.jobId;

    const crawl = await getCrawl(crawlId);
    if (!crawl) {
      return res.status(404).json({ success: false, error: "Job not found" });
    }

    if (crawl.team_id !== team_id) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }

    const jobIDs = await getCrawlJobs(crawlId);
    const jobs = await getJobs(crawlId, jobIDs.map(j => j.jobId));

    const start = typeof req.query.skip === "string" ? parseInt(req.query.skip, 10) : 0;
    const end = typeof req.query.limit === "string" ? (start + parseInt(req.query.limit, 10) - 1) : undefined;

    const status: Exclude<CrawlStatusResponse, ErrorResponse>["status"] = crawl.cancelled ? "cancelled" : jobs.every(x => x.state === "completed") ? "completed" : jobs.some(x => x.state === "failed") ? "failed" : "scraping";
    const doneJobsLength = await getDoneJobsOrderedLength(crawlId);
    const doneJobsOrder = await getDoneJobsOrdered(crawlId, start, end ?? -1);

    let doneJobs = [];

    if (end === undefined) { // determine 10 megabyte limit
      let bytes = 0;
      const bytesLimit = 10485760; // 10 MiB in bytes
      const factor = 100; // chunking for faster retrieval

      for (let i = 0; i < doneJobsOrder.length && bytes < bytesLimit; i += factor) {
        // get current chunk and retrieve jobs
        const currentIDs = doneJobsOrder.slice(i, i+factor);
        const jobs = await getJobs(crawlId, currentIDs);

        // iterate through jobs and add them one them one to the byte counter
        // both loops will break once we cross the byte counter
        for (let ii = 0; ii < jobs.length && bytes < bytesLimit; ii++) {
          const job = jobs[ii];
          doneJobs.push(job);
          bytes += JSON.stringify(legacyDocumentConverter(job.returnvalue)).length;
        }
      }

      // if we ran over the bytes limit, remove the last document
      if (bytes > bytesLimit) {
        doneJobs.splice(doneJobs.length - 1, 1);
      }
    } else {
      doneJobs = await getJobs(crawlId, doneJobsOrder);
    }

    const data = doneJobs.map(x => x.returnvalue);

    const protocol = process.env.ENV === "local" ? req.protocol : "https";
    const nextURL = new URL(`${protocol}://${req.get("host")}/v1/crawl/${req.params.jobId}`);

    nextURL.searchParams.set("skip", (start + data.length).toString());

    if (typeof req.query.limit === "string") {
      nextURL.searchParams.set("limit", req.query.limit);
    }

    if (data.length > 0) {
      if (!doneJobs[0].data.pageOptions.includeRawHtml) {
        for (let ii = 0; ii < doneJobs.length; ii++) {
          if (data[ii]) {
            delete data[ii].rawHtml;
          }
        }
      }
    }

    res.status(200).json({
      success: true,
      status,
      completed: doneJobsLength,
      total: jobIDs.length,
      expiresAt: (await getCrawlExpiry(crawlId)).toISOString(),
      next:
        status !== "scraping" && (start + data.length) === doneJobsLength // if there's not gonna be any documents after this
          ? undefined
          : nextURL.href,
      data: data.map(x => legacyDocumentConverter(x)),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
