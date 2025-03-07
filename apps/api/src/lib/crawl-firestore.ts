/**
 * Firestore-based crawl state management
 * This module replaces the Redis-based crawl state management in crawl-redis.ts
 */

import { v4 as uuidv4 } from 'uuid';
import { Logger } from './logger';
import { stateManager } from '../services/state-management/firestore-state';
import { WebCrawler } from "../scraper/WebScraper/crawler";

export interface StoredCrawl {
  id: string;
  originUrl: string;
  crawlerOptions: any;
  pageOptions: any;
  team_id: string;
  plan: string;
  robots?: string;
  cancelled?: boolean;
  createdAt: Date;
}

export interface CrawlJob {
  id: string;
  url: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
  result?: any;
  error?: string;
}

/**
 * Save a crawl object to Firestore
 * @param id Crawl ID
 * @param crawl Crawl object
 */
export async function saveCrawl(id: string, crawl: StoredCrawl): Promise<void> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Saving crawl ${id}`);
    await stateManager.saveCrawl(id, crawl);
    Logger.debug(`[CRAWL-FIRESTORE] Crawl ${id} saved successfully`);
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error saving crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Get a crawl object from Firestore
 * @param id Crawl ID
 * @returns Crawl object or null if not found
 */
export async function getCrawl(id: string): Promise<StoredCrawl | null> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Getting crawl ${id}`);
    const crawl = await stateManager.getCrawl(id);
    
    if (!crawl) {
      Logger.debug(`[CRAWL-FIRESTORE] Crawl ${id} not found`);
      return null;
    }
    
    // Convert to StoredCrawl interface
    const storedCrawl: StoredCrawl = {
      id: crawl.id,
      originUrl: crawl.originUrl,
      crawlerOptions: crawl.crawlerOptions,
      pageOptions: crawl.pageOptions,
      team_id: crawl.team_id,
      plan: crawl.plan,
      robots: crawl.robots,
      cancelled: crawl.cancelled,
      createdAt: crawl.createdAt,
    };
    
    return storedCrawl;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error getting crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Add a job to a crawl
 * @param id Crawl ID
 * @param jobId Job ID
 */
export async function addCrawlJob(id: string, jobId: string): Promise<void> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Adding job ${jobId} to crawl ${id}`);
    await stateManager.addCrawlJob(id, jobId);
    Logger.debug(`[CRAWL-FIRESTORE] Job ${jobId} added to crawl ${id}`);
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error adding job ${jobId} to crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Add multiple jobs to a crawl
 * @param id Crawl ID
 * @param jobIds Array of job IDs
 */
export async function addCrawlJobs(id: string, jobIds: string[]): Promise<void> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Adding ${jobIds.length} jobs to crawl ${id}`);
    await stateManager.addCrawlJobs(id, jobIds);
    Logger.debug(`[CRAWL-FIRESTORE] ${jobIds.length} jobs added to crawl ${id}`);
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error adding jobs to crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Mark a job as done in a crawl
 * @param id Crawl ID
 * @param jobId Job ID
 */
export async function addCrawlJobDone(id: string, jobId: string): Promise<void> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Marking job ${jobId} as done for crawl ${id}`);
    await stateManager.addCrawlJobDone(id, jobId);
    Logger.debug(`[CRAWL-FIRESTORE] Job ${jobId} marked as done for crawl ${id}`);
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error marking job ${jobId} as done for crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Get the number of completed jobs for a crawl
 * @param id Crawl ID
 * @returns Number of completed jobs
 */
export async function getDoneJobsOrderedLength(id: string): Promise<number> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Getting completed jobs count for crawl ${id}`);
    const count = await stateManager.getDoneJobsOrderedLength(id);
    Logger.debug(`[CRAWL-FIRESTORE] Crawl ${id} has ${count} completed jobs`);
    return count;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error getting completed jobs count for crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Get completed jobs for a crawl
 * @param id Crawl ID
 * @param start Start index
 * @param end End index
 * @returns Array of job IDs
 */
export async function getDoneJobsOrdered(id: string, start = 0, end = -1): Promise<string[]> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Getting completed jobs for crawl ${id} from ${start} to ${end}`);
    const jobs = await stateManager.getDoneJobsOrdered(id, start, end);
    Logger.debug(`[CRAWL-FIRESTORE] Got ${jobs.length} completed jobs for crawl ${id}`);
    return jobs;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error getting completed jobs for crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Check if a crawl is finished
 * @param id Crawl ID
 * @returns True if crawl is finished, false otherwise
 */
export async function isCrawlFinished(id: string): Promise<boolean> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Checking if crawl ${id} is finished`);
    const isFinished = await stateManager.isCrawlFinished(id);
    Logger.debug(`[CRAWL-FIRESTORE] Crawl ${id} finished: ${isFinished}`);
    return isFinished;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error checking if crawl ${id} is finished: ${error}`);
    throw error;
  }
}

/**
 * Mark a crawl as finished
 * @param id Crawl ID
 */
export async function finishCrawl(id: string): Promise<void> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Finishing crawl ${id}`);
    await stateManager.finishCrawl(id);
    Logger.debug(`[CRAWL-FIRESTORE] Crawl ${id} marked as finished`);
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error finishing crawl ${id}: ${error}`);
    throw error;
  }
}

/**
 * Lock a URL for a crawl
 * @param url URL to lock
 * @param crawlId Crawl ID
 * @returns True if URL was locked, false if already locked
 */
export async function lockURL(url: string, crawlId: string): Promise<boolean> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Attempting to lock URL ${url} for crawl ${crawlId}`);
    const result = await stateManager.lockURL(url, crawlId);
    Logger.debug(`[CRAWL-FIRESTORE] URL ${url} lock result: ${result}`);
    return result;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error locking URL ${url} for crawl ${crawlId}: ${error}`);
    return false;
  }
}

/**
 * Lock multiple URLs for a crawl
 * @param id Crawl ID
 * @param urls Array of URLs to lock
 * @returns True if all URLs were locked, false otherwise
 */
export async function lockURLs(id: string, urls: string[]): Promise<boolean> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Attempting to lock ${urls.length} URLs for crawl ${id}`);
    const result = await stateManager.lockURLs(id, urls);
    Logger.debug(`[CRAWL-FIRESTORE] URLs lock result: ${result}`);
    return result;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error locking URLs for crawl ${id}: ${error}`);
    return false;
  }
}

/**
 * Generate a unique ID for a crawl
 * @returns Unique ID
 */
export function generateCrawlId(): string {
  return uuidv4();
}

/**
 * Convert a stored crawl to a WebCrawler instance
 * @param id Crawl ID
 * @param sc Stored crawl object
 * @returns WebCrawler instance
 */
export function crawlToCrawler(id: string, sc: StoredCrawl): WebCrawler {
  const crawler = new WebCrawler({
    jobId: id,
    initialUrl: sc.originUrl,
    includes: sc.crawlerOptions?.includes ?? [],
    excludes: sc.crawlerOptions?.excludes ?? [],
    maxCrawledLinks: sc.crawlerOptions?.maxCrawledLinks ?? 1000,
    maxCrawledDepth: sc.crawlerOptions?.maxDepth ?? 10,
    limit: sc.crawlerOptions?.limit ?? 10000,
    allowExternalLinks: sc.crawlerOptions?.allowExternalLinks ?? false,
    crawlId: id,
  });

  if (sc.robots !== undefined) {
    try {
      crawler.importRobotsTxt(sc.robots);
    } catch (_) {}
  }

  return crawler;
}

/**
 * Get the expiry date for a crawl
 * @param id Crawl ID
 * @returns Expiry date or null if not found
 */
export async function getCrawlExpiry(id: string): Promise<Date | null> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Getting crawl expiry for ${id}`);
    const expiry = await stateManager.getCrawlExpiry(id);
    return expiry;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error getting crawl expiry for ${id}: ${error}`);
    return null;
  }
}

/**
 * Get jobs for a crawl
 * @param crawlId Crawl ID
 * @returns Array of crawl jobs
 */
export async function getCrawlJobs(crawlId: string): Promise<any[]> {
  try {
    Logger.debug(`[CRAWL-FIRESTORE] Getting jobs for crawl ${crawlId}`);
    const jobs = await stateManager.getCrawlJobs(crawlId);
    return jobs;
  } catch (error) {
    Logger.error(`[CRAWL-FIRESTORE] Error getting jobs for crawl ${crawlId}: ${error}`);
    return [];
  }
}
