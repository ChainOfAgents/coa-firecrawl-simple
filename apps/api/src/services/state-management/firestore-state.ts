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
}

// Helper function to remove undefined values from an object recursively
const removeUndefinedValues = (obj: any): any => {
  if (obj === null || obj === undefined) {
    return null;
  }
  
  if (typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => removeUndefinedValues(item));
  }
  
  const result: Record<string, any> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = removeUndefinedValues(obj[key]);
    }
  }
  return result;
};

export class FirestoreStateManager {
  private jobsCollection = db.collection('jobs');
  private crawlsCollection = db.collection('crawls');

  async createJob(jobId: string, name: string, data: QueueJobData, options: QueueJobOptions): Promise<void> {
    try {
      // Ensure team_id is set to prevent Firestore errors
      if (!data.team_id) {
        data.team_id = 'system';
        Logger.debug(`[STATE-MANAGER] Setting default team_id 'system' for job ${jobId}`);
      }
      
      // Clean the data by removing undefined values
      const cleanData = removeUndefinedValues(data);
      const cleanOptions = removeUndefinedValues(options);
      
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
      const cleanResult = removeUndefinedValues(result);
      
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
      const cleanProgress = typeof progress === 'object' ? removeUndefinedValues(progress) : progress;
      
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
      Logger.debug(`[STATE-MANAGER] Job ${jobId} document exists: ${jobDoc.exists}`);
      
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
}

export const stateManager = new FirestoreStateManager();
