import { Firestore, FieldValue } from '@google-cloud/firestore';
import { QueueJobData, QueueJobOptions, QueueJobResult } from '../queue/types';
import { Logger } from '../../lib/logger';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) {
  throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');
}

// Log Firestore initialization
Logger.info(`Initializing Firestore with project ID: ${projectId}`);

let db: Firestore;
try {
  db = new Firestore({
    projectId,
    // Enable ignoreUndefinedProperties to prevent Firestore errors with undefined values
    ignoreUndefinedProperties: true,
  });
  
  Logger.info('Firestore initialized successfully');
} catch (error) {
  Logger.error(`Error initializing Firestore: ${error}`);
  throw error;
}

export interface JobState {
  id: string;
  name: string;
  data: QueueJobData;
  options: QueueJobOptions;
  status: string;
  progress: number | object;
  result?: QueueJobResult;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrawlState {
  id: string;
  status: string;
  totalUrls: number;
  completedUrls: number;
  failedUrls: number;
  urls: string[];
  completedJobs: string[];
  failedJobs: string[];
  startTime: Date;
  endTime?: Date;
  originUrl: string;
  crawlerOptions: any;
  pageOptions: any;
  team_id: string;
  plan: string;
  robots?: string;
  cancelled?: boolean;
  createdAt: Date;
  expiresAt: Date;
}

export interface CrawlJob {
  url: string;
  jobId: string;
  status?: string;
  error?: string;
  timestamp?: number;
}

// Helper function to remove undefined values from an object recursively
function removeUndefinedValues(obj: any): any {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => removeUndefinedValues(item));
  }

  const result = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value !== undefined) {
        result[key] = removeUndefinedValues(value);
      }
    }
  }
  return result;
}

export class FirestoreStateManager {
  private jobsCollection = db.collection('jobs');
  private crawlsCollection = db.collection('crawls');
  private crawlJobsCollection = db.collection('crawl_jobs');
  private lockedUrlsCollection = db.collection('locked_urls');
  private teamJobsCollection = db.collection('team_jobs');

  private removeUndefinedValues(obj: any): any {
    return removeUndefinedValues(obj);
  }

  async createJob(jobId: string, name: string, data: QueueJobData, options: QueueJobOptions): Promise<void> {
    try {
      // Ensure team_id is set to prevent Firestore errors
      if (!data.team_id) {
        data.team_id = 'system';
        Logger.debug(`[STATE-MANAGER] Setting default team_id 'system' for job ${jobId}`);
      }
      
      // Clean the data by removing undefined values
      const cleanData = this.removeUndefinedValues(data);
      const cleanOptions = this.removeUndefinedValues(options);
      
      Logger.debug(`[STATE-MANAGER] Creating job state for ${jobId} with data: ${JSON.stringify(cleanData)}`);
      
      const jobState: JobState = {
        id: jobId,
        name,
        data: cleanData,
        options: cleanOptions,
        status: 'waiting',
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await this.jobsCollection.doc(jobId).set(jobState);
      Logger.debug(`[STATE-MANAGER] Created job state for ${jobId}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error creating job state for ${jobId}: ${error}`);
      Logger.error(`[STATE-MANAGER] Error details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async markJobStarted(jobId: string): Promise<void> {
    try {
      await this.jobsCollection.doc(jobId).update({
        status: 'active',
        updatedAt: new Date(),
      });
      Logger.debug(`[STATE-MANAGER] Marked job ${jobId} as started`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error marking job ${jobId} as started: ${error}`);
      throw error;
    }
  }

  async markJobCompleted(jobId: string, result: QueueJobResult): Promise<void> {
    try {
      // Clean the result by removing undefined values
      const cleanResult = this.removeUndefinedValues(result);
      
      Logger.debug(`[STATE-MANAGER] Marking job ${jobId} as completed with result: ${JSON.stringify(cleanResult).substring(0, 200)}...`);
      
      // Check if the job exists first
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      if (!jobDoc.exists) {
        Logger.warn(`[STATE-MANAGER] Job ${jobId} does not exist in Firestore, creating it before marking as completed`);
        // Create a minimal job record if it doesn't exist
        await this.jobsCollection.doc(jobId).set({
          id: jobId,
          status: 'created',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      } else {
        Logger.debug(`[STATE-MANAGER] Job ${jobId} exists with status: ${(jobDoc.data() as JobState).status}`);
      }
      
      // Handle large result objects by breaking them into smaller updates
      try {
        // First update the status and progress without the result
        const statusUpdate = {
          status: 'completed',
          progress: 100,
          updatedAt: new Date(),
        };
        
        Logger.debug(`[STATE-MANAGER] Updating job ${jobId} status to completed`);
        await this.jobsCollection.doc(jobId).update(statusUpdate);
        Logger.info(`[STATE-MANAGER] Successfully updated job ${jobId} status to completed`);
        
        // Then try to update the result separately
        try {
          // Limit the size of the result to avoid Firestore document size limits (1MB)
          const resultStr = JSON.stringify(cleanResult);
          Logger.debug(`[STATE-MANAGER] Result size for job ${jobId}: ${resultStr.length} bytes`);
          
          // Firestore limit is 1MB, but we'll use 990KB as a safe threshold
          if (resultStr.length > 990000) {
            Logger.warn(`[STATE-MANAGER] Result for job ${jobId} is too large (${resultStr.length} bytes), truncating`);
            // Create a simplified version of the result
            const truncatedResult = {
              success: cleanResult.success,
              message: cleanResult.message || 'Result truncated due to size',
              truncated: true,
              originalSize: resultStr.length,
              // Keep essential data and truncate content if present
              docs: cleanResult.docs?.map(doc => {
                if (doc.content) {
                  // Allow up to 1000KB per document for content
                  const maxContentSize = 1000000;
                  return {
                    ...doc,
                    content: doc.content.substring(0, maxContentSize) + (doc.content.length > maxContentSize ? '... [TRUNCATED]' : ''),
                    contentTruncated: doc.content.length > maxContentSize,
                    originalContentLength: doc.content.length
                  };
                }
                return doc;
              })
            };
            
            await this.jobsCollection.doc(jobId).update({
              result: truncatedResult
            });
            Logger.debug(`[STATE-MANAGER] Updated job ${jobId} with truncated result`);
          } else {
            await this.jobsCollection.doc(jobId).update({
              result: cleanResult
            });
            Logger.debug(`[STATE-MANAGER] Updated job ${jobId} with full result`);
          }
        } catch (resultError) {
          Logger.error(`[STATE-MANAGER] Error updating result for job ${jobId}: ${resultError}`);
          // Try with a minimal result object
          await this.jobsCollection.doc(jobId).update({
            result: {
              success: cleanResult.success,
              message: 'Result too large to store in Firestore',
              error: resultError.message
            }
          });
          Logger.debug(`[STATE-MANAGER] Updated job ${jobId} with minimal result after error`);
        }
      } catch (updateError) {
        Logger.error(`[STATE-MANAGER] Error updating job ${jobId} status: ${updateError}`);
        // Try one more time with a minimal update
        await this.jobsCollection.doc(jobId).update({
          status: 'completed',
          updatedAt: new Date(),
        });
      }

      // Update crawl state if this is part of a crawl
      if (jobDoc.exists) {
        const jobData = jobDoc.data() as JobState;
        if (jobData?.data?.crawl_id) {
          try {
            await this.updateCrawlProgress(jobData.data.crawl_id, jobId, true);
          } catch (crawlError) {
            Logger.error(`[STATE-MANAGER] Error updating crawl progress for job ${jobId}: ${crawlError}`);
          }
        }
      }
      
      Logger.debug(`[STATE-MANAGER] Successfully marked job ${jobId} as completed`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error marking job ${jobId} as completed: ${error}`);
      Logger.error(`[STATE-MANAGER] Error details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async markJobFailed(jobId: string, error: Error): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Marking job ${jobId} as failed`);
      
      // Check if the job exists first
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      if (!jobDoc.exists) {
        Logger.warn(`[STATE-MANAGER] Job ${jobId} does not exist in Firestore, creating it before marking as failed`);
        // Create a minimal job record if it doesn't exist
        await this.jobsCollection.doc(jobId).set({
          id: jobId,
          status: 'created',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      
      // Handle the update in a more resilient way
      try {
        await this.jobsCollection.doc(jobId).update({
          status: 'failed',
          error: error.message,
          updatedAt: new Date(),
        });
        Logger.debug(`[STATE-MANAGER] Marked job ${jobId} as failed`);
      } catch (updateError) {
        Logger.error(`[STATE-MANAGER] Error updating job ${jobId} status to failed: ${updateError}`);
        // Try one more time with a minimal update
        await this.jobsCollection.doc(jobId).update({
          status: 'failed',
          updatedAt: new Date(),
        });
      }

      // Update crawl state if this is part of a crawl
      if (jobDoc.exists) {
        const jobData = jobDoc.data() as JobState;
        if (jobData?.data?.crawl_id) {
          try {
            await this.updateCrawlProgress(jobData.data.crawl_id, jobId, false);
          } catch (crawlError) {
            Logger.error(`[STATE-MANAGER] Error updating crawl progress for failed job ${jobId}: ${crawlError}`);
          }
        }
      }
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error marking job ${jobId} as failed: ${error}`);
      Logger.error(`[STATE-MANAGER] Error details: ${JSON.stringify(error)}`);
      throw error;
    }
  }

  async updateJobProgress(jobId: string, progress: number | object): Promise<void> {
    try {
      // Clean the progress by removing undefined values if it's an object
      const cleanProgress = typeof progress === 'object' ? this.removeUndefinedValues(progress) : progress;
      
      await this.jobsCollection.doc(jobId).update({
        progress: cleanProgress,
        updatedAt: new Date(),
      });
      Logger.debug(`[STATE-MANAGER] Updated job ${jobId} progress`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error updating job ${jobId} progress: ${error}`);
      throw error;
    }
  }

  async getJobState(jobId: string): Promise<string> {
    try {
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      if (!jobDoc.exists) {
        Logger.error(`[STATE-MANAGER] Job ${jobId} not found`);
        return 'unknown';
      }
      
      const jobData = jobDoc.data() as JobState;
      return jobData.status;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting job state for ${jobId}: ${error}`);
      return 'unknown';
    }
  }

  async getJobResult(jobId: string): Promise<any> {
    try {
      Logger.debug(`[STATE-MANAGER] Getting result for job ${jobId}`);
      
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      
      if (!jobDoc.exists) {
        Logger.error(`[STATE-MANAGER] Job ${jobId} not found when getting result`);
        return null;
      }
      
      const jobData = jobDoc.data() as JobState;
      Logger.debug(`[STATE-MANAGER] Job ${jobId} data retrieved, keys: ${Object.keys(jobData).join(', ')}`);
      Logger.debug(`[STATE-MANAGER] Job ${jobId} status: ${jobData.status}`);
      
      if (!jobData.result) {
        Logger.warn(`[STATE-MANAGER] Job ${jobId} exists but has no result field`);
        // Log all fields to help diagnose the issue
        Logger.debug(`[STATE-MANAGER] Job ${jobId} complete data: ${JSON.stringify(jobData, null, 2)}`);
        return null;
      }
      
      const resultType = typeof jobData.result;
      Logger.debug(`[STATE-MANAGER] Retrieved result for job ${jobId}, result type: ${resultType}`);
      
      if (resultType === 'object') {
        Logger.debug(`[STATE-MANAGER] Result object keys: ${Object.keys(jobData.result).join(', ')}`);
        
        if (Array.isArray(jobData.result)) {
          Logger.debug(`[STATE-MANAGER] Result is an array with ${jobData.result.length} items`);
          
          // Log info about the first few items if it's an array
          if (jobData.result.length > 0) {
            const sampleSize = Math.min(3, jobData.result.length);
            for (let i = 0; i < sampleSize; i++) {
              const item = jobData.result[i];
              Logger.debug(`[STATE-MANAGER] Result array item ${i} type: ${typeof item}`);
              if (typeof item === 'object' && item !== null) {
                Logger.debug(`[STATE-MANAGER] Result array item ${i} keys: ${Object.keys(item).join(', ')}`);
              }
            }
          }
        } else {
          // Log some info about the result object
          if (jobData.result.docs) {
            Logger.debug(`[STATE-MANAGER] Result contains docs array with ${jobData.result.docs.length} items`);
            
            // Log info about the first few docs if available
            if (jobData.result.docs.length > 0) {
              const sampleSize = Math.min(3, jobData.result.docs.length);
              for (let i = 0; i < sampleSize; i++) {
                const doc = jobData.result.docs[i];
                Logger.debug(`[STATE-MANAGER] Doc ${i} type: ${typeof doc}`);
                if (typeof doc === 'object' && doc !== null) {
                  Logger.debug(`[STATE-MANAGER] Doc ${i} keys: ${Object.keys(doc).join(', ')}`);
                  if (doc.content) {
                    Logger.debug(`[STATE-MANAGER] Doc ${i} has content of length: ${doc.content.length}`);
                  }
                }
              }
            }
          }
          
          // Log success and message fields if they exist
          if ('success' in jobData.result) {
            Logger.debug(`[STATE-MANAGER] Result success: ${jobData.result.success}`);
          }
          if ('message' in jobData.result) {
            Logger.debug(`[STATE-MANAGER] Result message: ${jobData.result.message}`);
          }
        }
      }
      
      return jobData.result;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting job result for ${jobId}: ${error}`);
      Logger.error(`[STATE-MANAGER] Error details: ${JSON.stringify(error)}`);
      return null;
    }
  }

  async getJobError(jobId: string): Promise<string | null> {
    try {
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      if (!jobDoc.exists) {
        Logger.error(`[STATE-MANAGER] Job ${jobId} not found when getting error`);
        return null;
      }
      
      const jobData = jobDoc.data() as JobState;
      return jobData.error || null;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting job error for ${jobId}: ${error}`);
      return null;
    }
  }

  async getJobData(jobId: string): Promise<JobState | null> {
    try {
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      if (!jobDoc.exists) {
        Logger.error(`[STATE-MANAGER] Job ${jobId} not found when getting job data`);
        return null;
      }
      
      return jobDoc.data() as JobState;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting job data for ${jobId}: ${error}`);
      return null;
    }
  }

  async getJob(jobId: string): Promise<JobState | null> {
    return this.getJobData(jobId);
  }

  async removeJob(jobId: string): Promise<void> {
    try {
      await this.jobsCollection.doc(jobId).delete();
      Logger.debug(`[STATE-MANAGER] Removed job ${jobId}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error removing job ${jobId}: ${error}`);
      throw error;
    }
  }

  async createCrawl(crawlId: string, urls: string[]): Promise<void> {
    try {
      const crawlState: CrawlState = {
        id: crawlId,
        status: 'pending',
        totalUrls: urls.length,
        completedUrls: 0,
        failedUrls: 0,
        urls,
        completedJobs: [],
        failedJobs: [],
        startTime: new Date(),
        originUrl: '',
        crawlerOptions: {},
        pageOptions: {},
        team_id: '',
        plan: '',
        createdAt: new Date(),
        expiresAt: new Date(),
      };

      await this.crawlsCollection.doc(crawlId).set(crawlState);
      Logger.debug(`[STATE-MANAGER] Created crawl state for ${crawlId}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error creating crawl state for ${crawlId}: ${error}`);
      throw error;
    }
  }

  async getCrawlState(crawlId: string): Promise<CrawlState | null> {
    try {
      const doc = await this.crawlsCollection.doc(crawlId).get();
      return doc.exists ? (doc.data() as CrawlState) : null;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting crawl state for ${crawlId}: ${error}`);
      throw error;
    }
  }

  private async updateCrawlProgress(crawlId: string, jobId: string, success: boolean): Promise<void> {
    const crawlRef = this.crawlsCollection.doc(crawlId);
    
    try {
      await db.runTransaction(async (transaction) => {
        const crawlDoc = await transaction.get(crawlRef);
        if (!crawlDoc.exists) {
          throw new Error(`Crawl ${crawlId} not found`);
        }

        const crawlData = crawlDoc.data() as CrawlState;
        const updates: Partial<CrawlState> = {
          completedUrls: success ? crawlData.completedUrls + 1 : crawlData.completedUrls,
          failedUrls: success ? crawlData.failedUrls : crawlData.failedUrls + 1,
          completedJobs: success ? [...crawlData.completedJobs, jobId] : crawlData.completedJobs,
          failedJobs: success ? crawlData.failedJobs : [...crawlData.failedJobs, jobId],
        };

        // Check if crawl is complete
        if (updates.completedUrls! + updates.failedUrls! === crawlData.totalUrls) {
          updates.status = 'completed';
          updates.endTime = new Date();
        }

        transaction.update(crawlRef, updates);
      });

      Logger.debug(`[STATE-MANAGER] Updated crawl progress for ${crawlId}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error updating crawl progress for ${crawlId}: ${error}`);
      throw error;
    }
  }

  // Crawl State Management Methods (replacing Redis-based implementation)

  async saveCrawl(id: string, crawl: Omit<CrawlState, 'id' | 'status' | 'totalUrls' | 'completedUrls' | 'failedUrls' | 'urls' | 'completedJobs' | 'failedJobs' | 'startTime' | 'endTime' | 'expiresAt'>): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Saving crawl ${id}`);
      
      // Calculate expiration date (24 hours from now)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);
      
      // Create or update the crawl document
      const crawlData = this.removeUndefinedValues({
        ...crawl,
        id,
        status: 'created',
        totalUrls: 0,
        completedUrls: 0,
        failedUrls: 0,
        urls: [],
        completedJobs: [],
        failedJobs: [],
        startTime: new Date(),
        createdAt: new Date(),
        expiresAt,
      });
      
      await this.crawlsCollection.doc(id).set(crawlData);
      Logger.debug(`[STATE-MANAGER] Crawl ${id} saved successfully`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error saving crawl ${id}: ${error}`);
      throw error;
    }
  }

  async getCrawl(id: string): Promise<CrawlState | null> {
    try {
      Logger.debug(`[STATE-MANAGER] Getting crawl ${id}`);
      
      const crawlDoc = await this.crawlsCollection.doc(id).get();
      
      if (!crawlDoc.exists) {
        Logger.debug(`[STATE-MANAGER] Crawl ${id} not found`);
        return null;
      }
      
      return crawlDoc.data() as CrawlState;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting crawl ${id}: ${error}`);
      throw error;
    }
  }

  async getCrawlExpiry(id: string): Promise<Date> {
    try {
      Logger.debug(`[STATE-MANAGER] Getting expiry for crawl ${id}`);
      
      const crawlDoc = await this.crawlsCollection.doc(id).get();
      
      if (!crawlDoc.exists) {
        Logger.debug(`[STATE-MANAGER] Crawl ${id} not found, returning current date`);
        return new Date();
      }
      
      const crawlData = crawlDoc.data() as CrawlState;
      return crawlData.expiresAt;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting crawl expiry ${id}: ${error}`);
      throw error;
    }
  }

  async addCrawlJob(id: string, jobId: string): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Adding job ${jobId} to crawl ${id}`);
      
      // Add the job ID to the crawl's urls array
      await this.crawlsCollection.doc(id).update({
        urls: FieldValue.arrayUnion(jobId)
      });
      
      // Create a crawl job document
      await this.crawlJobsCollection.doc(`${id}_${jobId}`).set({
        crawlId: id,
        jobId,
        status: 'created',
        timestamp: Date.now()
      });
      
      Logger.debug(`[STATE-MANAGER] Job ${jobId} added to crawl ${id}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error adding job ${jobId} to crawl ${id}: ${error}`);
      throw error;
    }
  }

  async addCrawlJobs(id: string, jobIds: string[]): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Adding ${jobIds.length} jobs to crawl ${id}`);
      
      // Add the job IDs to the crawl's urls array
      await this.crawlsCollection.doc(id).update({
        urls: FieldValue.arrayUnion(...jobIds)
      });
      
      // Create batch operations for adding crawl jobs
      const batch = db.batch();
      
      for (const jobId of jobIds) {
        const docRef = this.crawlJobsCollection.doc(`${id}_${jobId}`);
        batch.set(docRef, {
          crawlId: id,
          jobId,
          status: 'created',
          timestamp: Date.now()
        });
      }
      
      await batch.commit();
      Logger.debug(`[STATE-MANAGER] ${jobIds.length} jobs added to crawl ${id}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error adding jobs to crawl ${id}: ${error}`);
      throw error;
    }
  }

  async addCrawlJobDone(id: string, jobId: string): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Marking job ${jobId} as done for crawl ${id}`);
      
      // Update the crawl job status
      await this.crawlJobsCollection.doc(`${id}_${jobId}`).update({
        status: 'completed',
        timestamp: Date.now()
      });
      
      // Add the job ID to the crawl's completedJobs array
      await this.crawlsCollection.doc(id).update({
        completedJobs: FieldValue.arrayUnion(jobId),
        completedUrls: FieldValue.increment(1)
      });
      
      Logger.debug(`[STATE-MANAGER] Job ${jobId} marked as done for crawl ${id}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error marking job ${jobId} as done for crawl ${id}: ${error}`);
      throw error;
    }
  }

  async getDoneJobsOrderedLength(id: string): Promise<number> {
    try {
      Logger.debug(`[STATE-MANAGER] Getting completed jobs count for crawl ${id}`);
      
      const crawlDoc = await this.crawlsCollection.doc(id).get();
      
      if (!crawlDoc.exists) {
        Logger.debug(`[STATE-MANAGER] Crawl ${id} not found, returning 0`);
        return 0;
      }
      
      const crawlData = crawlDoc.data() as CrawlState;
      return crawlData.completedJobs.length;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting completed jobs count for crawl ${id}: ${error}`);
      throw error;
    }
  }

  async getDoneJobsOrdered(id: string, start = 0, end = -1): Promise<string[]> {
    try {
      Logger.debug(`[STATE-MANAGER] Getting completed jobs for crawl ${id} from ${start} to ${end}`);
      
      const crawlDoc = await this.crawlsCollection.doc(id).get();
      
      if (!crawlDoc.exists) {
        Logger.debug(`[STATE-MANAGER] Crawl ${id} not found, returning empty array`);
        return [];
      }
      
      const crawlData = crawlDoc.data() as CrawlState;
      const completedJobs = crawlData.completedJobs;
      
      // Handle negative end index
      const actualEnd = end < 0 ? completedJobs.length : end;
      
      return completedJobs.slice(start, actualEnd);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting completed jobs for crawl ${id}: ${error}`);
      throw error;
    }
  }

  async isCrawlFinished(id: string): Promise<boolean> {
    try {
      Logger.debug(`[STATE-MANAGER] Checking if crawl ${id} is finished`);
      
      const crawlDoc = await this.crawlsCollection.doc(id).get();
      
      if (!crawlDoc.exists) {
        Logger.debug(`[STATE-MANAGER] Crawl ${id} not found, returning true`);
        return true;
      }
      
      const crawlData = crawlDoc.data() as CrawlState;
      const isFinished = crawlData.totalUrls > 0 && 
                         (crawlData.completedUrls + crawlData.failedUrls) >= crawlData.totalUrls;
      
      Logger.debug(`[STATE-MANAGER] Crawl ${id} finished: ${isFinished}`);
      return isFinished;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error checking if crawl ${id} is finished: ${error}`);
      throw error;
    }
  }

  async finishCrawl(id: string): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Finishing crawl ${id}`);
      
      await this.crawlsCollection.doc(id).update({
        status: 'completed',
        endTime: new Date()
      });
      
      Logger.debug(`[STATE-MANAGER] Crawl ${id} marked as finished`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error finishing crawl ${id}: ${error}`);
      throw error;
    }
  }

  async getCrawlJobs(crawlId: string): Promise<CrawlJob[]> {
    try {
      Logger.debug(`[STATE-MANAGER] Getting jobs for crawl ${crawlId}`);
      
      const snapshot = await this.crawlJobsCollection
        .where('crawlId', '==', crawlId)
        .get();
      
      if (snapshot.empty) {
        Logger.debug(`[STATE-MANAGER] No jobs found for crawl ${crawlId}`);
        return [];
      }
      
      const jobs: CrawlJob[] = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        jobs.push({
          url: data.url || '',
          jobId: data.jobId,
          status: data.status,
          error: data.error,
          timestamp: data.timestamp
        });
      });
      
      return jobs;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting jobs for crawl ${crawlId}: ${error}`);
      throw error;
    }
  }

  async lockURL(url: string, crawlId: string): Promise<boolean> {
    try {
      Logger.debug(`[STATE-MANAGER] Attempting to lock URL ${url} for crawl ${crawlId}`);
      
      // Check if URL is already locked
      const urlDoc = await this.lockedUrlsCollection.doc(this.hashUrl(url)).get();
      
      if (urlDoc.exists) {
        Logger.debug(`[STATE-MANAGER] URL ${url} is already locked`);
        return false;
      }
      
      // Lock the URL
      await this.lockedUrlsCollection.doc(this.hashUrl(url)).set({
        url,
        crawlId,
        timestamp: Date.now(),
        // Set TTL for 24 hours
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
      
      Logger.debug(`[STATE-MANAGER] URL ${url} locked successfully for crawl ${crawlId}`);
      return true;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error locking URL ${url} for crawl ${crawlId}: ${error}`);
      return false;
    }
  }

  async lockURLs(id: string, urls: string[]): Promise<boolean> {
    try {
      Logger.debug(`[STATE-MANAGER] Attempting to lock ${urls.length} URLs for crawl ${id}`);
      
      // Create batch operations for locking URLs
      const batch = db.batch();
      const now = Date.now();
      const expiresAt = new Date(now + 24 * 60 * 60 * 1000);
      
      for (const url of urls) {
        const docRef = this.lockedUrlsCollection.doc(this.hashUrl(url));
        batch.set(docRef, {
          url,
          crawlId: id,
          timestamp: now,
          expiresAt
        });
      }
      
      await batch.commit();
      Logger.debug(`[STATE-MANAGER] ${urls.length} URLs locked successfully for crawl ${id}`);
      return true;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error locking URLs for crawl ${id}: ${error}`);
      return false;
    }
  }

  // Helper method to hash URLs for use as document IDs
  private hashUrl(url: string): string {
    // Simple hash function for URL
    let hash = 0;
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `url_${Math.abs(hash).toString(16)}`;
  }

  /**
   * Add a job to a team's active jobs
   * @param teamId Team ID
   * @param jobId Job ID
   */
  async addTeamJob(teamId: string, jobId: string): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Adding job ${jobId} to team ${teamId}`);
      
      await this.teamJobsCollection.doc(`${teamId}_${jobId}`).set({
        teamId,
        jobId,
        timestamp: Date.now(),
        // Set TTL for 10 minutes
        expiresAt: new Date(Date.now() + 10 * 60 * 1000)
      });
      
      Logger.debug(`[STATE-MANAGER] Job ${jobId} added to team ${teamId}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error adding job ${jobId} to team ${teamId}: ${error}`);
      throw error;
    }
  }

  /**
   * Remove a job from a team's active jobs
   * @param teamId Team ID
   * @param jobId Job ID
   */
  async removeTeamJob(teamId: string, jobId: string): Promise<void> {
    try {
      Logger.debug(`[STATE-MANAGER] Removing job ${jobId} from team ${teamId}`);
      
      await this.teamJobsCollection.doc(`${teamId}_${jobId}`).delete();
      
      Logger.debug(`[STATE-MANAGER] Job ${jobId} removed from team ${teamId}`);
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error removing job ${jobId} from team ${teamId}: ${error}`);
      throw error;
    }
  }

  /**
   * Get the number of active jobs for a team
   * @param teamId Team ID
   * @returns Number of active jobs
   */
  async getTeamJobCount(teamId: string): Promise<number> {
    try {
      Logger.debug(`[STATE-MANAGER] Getting job count for team ${teamId}`);
      
      const snapshot = await this.teamJobsCollection
        .where('teamId', '==', teamId)
        .where('expiresAt', '>', new Date())
        .get();
      
      const count = snapshot.size;
      Logger.debug(`[STATE-MANAGER] Team ${teamId} has ${count} active jobs`);
      
      return count;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting job count for team ${teamId}: ${error}`);
      return 0;
    }
  }
}

export const stateManager = new FirestoreStateManager();
