import { PageOptions } from "./../../lib/entities";
import { Request, Response } from "express";
import { authenticateUser } from "../auth";
import { PlanType, RateLimiterMode } from "../../types";
import { Document } from "../../lib/entities";
import {
  defaultPageOptions,
  defaultTimeout,
  defaultOrigin,
} from "../../lib/default-values";
import { addScrapeJobRaw, waitForJob, getScrapeQueue } from "../../services/queue-jobs";
import { v4 as uuidv4 } from "uuid";
import { Logger } from "../../lib/logger";
import { getJobPriority } from "../../lib/job-priority";

export async function scrapeHelper(
  jobId: string,
  req: Request,
  team_id: string,
  crawlerOptions: any,
  pageOptions: PageOptions,
  timeout: number,
  plan?: PlanType
): Promise<{
  success: boolean;
  error?: string;
  data?: Document;
  returnCode: number;
}> {
  const url = req.body.url;
  if (typeof url !== "string") {
    return { success: false, error: "Url is required", returnCode: 400 };
  }

  const jobPriority = await getJobPriority({
    plan: plan,
    team_id: team_id,
    basePriority: 10,
  });

  await addScrapeJobRaw(
    {
      url,
      mode: "single_urls",
      crawlerOptions,
      team_id,
      pageOptions,
      origin: req.body.origin ?? defaultOrigin,
      is_scrape: true,
    },
    {},
    jobId,
    jobPriority
  );

  let doc;

  const err = (async () => {
    try {
      doc = (await waitForJob(jobId, timeout))[0];
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Job wait")) {
        return {
          success: false,
          error: "Request timed out",
          returnCode: 408,
        };
      } else if (
        typeof e === "string" &&
        (e.includes("Error generating completions: ") ||
          e.includes("Invalid schema for function") ||
          e.includes(
            "LLM extraction did not match the extraction schema you provided."
          ))
      ) {
        return {
          success: false,
          error: e,
          returnCode: 500,
        };
      } else {
        throw e;
      }
    }
    return null;
  })();

  if (err !== null) {
    return err;
  }

  // Clean up the job
  const queue = getScrapeQueue();
  await queue.removeJob(jobId);

  if (!doc) {
    console.error("!!! PANIC DOC IS", doc, jobId);
    return {
      success: true,
      error: "No page found",
      returnCode: 200,
      data: doc,
    };
  }

  delete doc.index;
  delete doc.provider;

  return {
    success: true,
    data: doc,
    returnCode: 200,
  };
}

export async function scrapeController(req: Request, res: Response) {
  try {
    let earlyReturn = false;
    // make sure to authenticate user first, Bearer <token>
    const { success, team_id, error, status, plan } = await authenticateUser(
      req,
      res,
      RateLimiterMode.Scrape
    );
    if (!success) {
      return res.status(status).json({ error });
    }

    const crawlerOptions = req.body.crawlerOptions ?? {};
    const pageOptions = { ...defaultPageOptions, ...req.body.pageOptions };
    let timeout = req.body.timeout ?? defaultTimeout;

    const jobId = uuidv4();

    const result = await scrapeHelper(
      jobId,
      req,
      team_id,
      crawlerOptions,
      pageOptions,
      timeout,
      plan
    );
    let doc = result.data;
    if (!pageOptions || !pageOptions.includeRawHtml) {
      if (doc && doc.rawHtml) {
        delete doc.rawHtml;
      }
    }

    if (pageOptions && pageOptions.includeExtract) {
      if (!pageOptions.includeMarkdown && doc && doc.markdown) {
        delete doc.markdown;
      }
    }

    return res.status(result.returnCode).json(result);
  } catch (error) {
    Logger.error(error);
    return res.status(500).json({
      error:
        typeof error === "string"
          ? error
          : error?.message ?? "Internal Server Error",
    });
  }
}
