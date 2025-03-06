import { Request, Response } from "express";
import { Logger } from "../../lib/logger";
import {
  legacyDocumentConverter,
  legacyScrapeOptions,
  RequestWithAuth,
  ScrapeRequest,
  scrapeRequestSchema,
  ScrapeResponse,
} from "./types";
import { Document } from "../../lib/entities";
import { v4 as uuidv4 } from "uuid";
import { addScrapeJobRaw, waitForJob } from "../../services/queue-jobs";
import { getJobPriority } from "../../lib/job-priority";
import { PlanType } from "../../types";
import { redisRateLimitClient } from "../../services/rate-limiter";

// Default team ID for system-generated requests
const DEFAULT_TEAM_ID = 'system';

/**
 * @openapi
 * /v1/scrape:
 *   post:
 *     tags:
 *       - Scraping
 *     summary: Scrape a single webpage
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *               waitUntil:
 *                 type: string
 *                 enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2']
 *               timeout:
 *                 type: integer
 *                 minimum: 1000
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 jobId:
 *                   type: string
 */
export async function scrapeController(
  req: RequestWithAuth<{}, ScrapeResponse, ScrapeRequest>,
  res: Response<ScrapeResponse>
) {
  req.body = scrapeRequestSchema.parse(req.body);

  const origin = req.body.origin;
  const timeout = req.body.timeout;
  const pageOptions = legacyScrapeOptions(req.body);
  const jobId = uuidv4();

  // Log the request details
  Logger.debug(`Scrape request: url=${req.body.url}, timeout=${timeout}ms, jobId=${jobId}`);

  // Get team_id from auth, defaulting to a system team ID if undefined
  const team_id = req.auth?.team_id || DEFAULT_TEAM_ID;

  const jobPriority = await getJobPriority({
    plan: req.auth.plan as PlanType,
    team_id,
    basePriority: 10,
  });

  await addScrapeJobRaw(
    {
      url: req.body.url,
      mode: "single_urls",
      crawlerOptions: {},
      team_id, // Use the safely handled team_id
      pageOptions,
      origin: req.body.origin,
      is_scrape: true,
    },
    {},
    jobId,
    jobPriority
  );

  Logger.debug(`Job ${jobId} added to queue with priority ${jobPriority}`);

  let doc: any | undefined;
  try {
    const startTime = Date.now();
    Logger.debug(`[SCRAPE-CONTROLLER] Waiting for job ${jobId} with timeout ${timeout}ms`);
    
    // Get the job result (don't try to access [0] directly)
    const result = await waitForJob(jobId, timeout);
    const duration = Date.now() - startTime;
    Logger.debug(`[SCRAPE-CONTROLLER] Job ${jobId} completed in ${duration}ms`);
    
    // Log detailed information about the result
    Logger.debug(`[SCRAPE-CONTROLLER] Result type: ${typeof result}`);
    
    if (result === null || result === undefined) {
      Logger.error(`[SCRAPE-CONTROLLER] Result is ${result} for job ${jobId}`);
      doc = undefined;
    } else if (typeof result === 'object') {
      Logger.debug(`[SCRAPE-CONTROLLER] Result keys: ${Object.keys(result).join(', ')}`);
      
      // Check if it's an array
      if (Array.isArray(result)) {
        Logger.debug(`[SCRAPE-CONTROLLER] Result is an array with ${result.length} items`);
        doc = result[0]; // Take the first element if it's an array
      } else {
        // Check if it has a docs array
        if (result.docs && Array.isArray(result.docs) && result.docs.length > 0) {
          Logger.debug(`[SCRAPE-CONTROLLER] Result has docs array with ${result.docs.length} items`);
          doc = result.docs[0]; // Take the first doc from the docs array
          Logger.debug(`[SCRAPE-CONTROLLER] Using first doc from docs array: ${JSON.stringify(doc)}`);
        } else {
          // Use the result itself as the doc
          Logger.debug(`[SCRAPE-CONTROLLER] Using result as doc`);
          doc = result;
        }
      }
    } else {
      Logger.error(`[SCRAPE-CONTROLLER] Unexpected result type: ${typeof result}`);
      doc = undefined;
    }
    
    // Log detailed information about the doc
    Logger.debug(`[SCRAPE-CONTROLLER] Doc result type: ${typeof doc}`);
    if (doc === null || doc === undefined) {
      Logger.error(`[SCRAPE-CONTROLLER] Doc is ${doc} for job ${jobId}`);
    } else if (typeof doc === 'object') {
      Logger.debug(`[SCRAPE-CONTROLLER] Doc keys: ${Object.keys(doc).join(', ')}`);
      
      // Check if it's an array
      if (Array.isArray(doc)) {
        Logger.debug(`[SCRAPE-CONTROLLER] Doc is an array with ${doc.length} items`);
      } else {
        // Log some key properties if they exist
        if ('content' in doc) {
          Logger.debug(`[SCRAPE-CONTROLLER] Doc has content of length: ${doc.content.length}`);
        }
        if ('metadata' in doc) {
          Logger.debug(`[SCRAPE-CONTROLLER] Doc has metadata: ${JSON.stringify(doc.metadata)}`);
        }
      }
    }
  } catch (e) {
    Logger.error(`[SCRAPE-CONTROLLER] Error in scrapeController: ${e}`);
    if (e instanceof Error && e.message.includes("timeout")) {
      return res.status(408).json({
        success: false,
        error: "Request timed out",
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `(Internal server error) - ${e && e?.message ? e.message : e}`,
      });
    }
  }

  if (!doc) {
    console.error("[SCRAPE-CONTROLLER] !!! PANIC DOC IS", doc, jobId);
    Logger.error(`[SCRAPE-CONTROLLER] Document is null or undefined for job ${jobId}`);
    // Create a minimal valid document without using the constructor
    const emptyDoc: Document = {
      content: "No content available",
      metadata: { sourceURL: req.body.url || "" },
      createdAt: new Date(),
      updatedAt: new Date(),
      type: "empty"
    };
    
    return res.status(200).json({
      success: true,
      warning: "No page found",
      data: emptyDoc
    });
  }

  // Check if doc is an array and extract the first element if it is
  if (Array.isArray(doc)) {
    console.log(`[SCRAPE-CONTROLLER] Job ${jobId} result is an array with ${doc.length} items`);
    Logger.debug(`[SCRAPE-CONTROLLER] Job ${jobId} result is an array with ${doc.length} items`);
    
    if (doc.length > 0) {
      Logger.debug(`[SCRAPE-CONTROLLER] First array item type: ${typeof doc[0]}`);
      if (typeof doc[0] === 'object' && doc[0] !== null) {
        Logger.debug(`[SCRAPE-CONTROLLER] First array item keys: ${Object.keys(doc[0]).join(', ')}`);
      }
    } else {
      Logger.warn(`[SCRAPE-CONTROLLER] Result array is empty for job ${jobId}`);
    }
    
    doc = doc[0]; // Take the first element
  }

  // If doc is still not valid after array extraction, return with a warning
  if (!doc) {
    console.error("[SCRAPE-CONTROLLER] !!! PANIC DOC IS STILL UNDEFINED AFTER ARRAY CHECK", jobId);
    Logger.error(`[SCRAPE-CONTROLLER] Document is still null or undefined after array check for job ${jobId}`);
    // Create a minimal valid document without using the constructor
    const emptyDoc: Document = {
      content: "No content available",
      metadata: { sourceURL: req.body.url || "" },
      createdAt: new Date(),
      updatedAt: new Date(),
      type: "empty"
    };
    
    return res.status(200).json({
      success: true,
      warning: "No valid document found in result",
      data: emptyDoc
    });
  }

  delete doc.index;
  delete doc.provider;

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

  return res.status(200).json({
    success: true,
    data: legacyDocumentConverter(doc),
    scrape_id: origin?.includes("website") ? jobId : undefined,
  });
}
