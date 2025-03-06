import { Firestore, FieldValue } from '@google-cloud/firestore';
import { QueueJobData, QueueJobOptions, QueueJobResult } from '../queue/types';
import { Logger } from '../../lib/logger';

const projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) {
  throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');
}

const db = new Firestore({
  projectId,
  // Enable ignoreUndefinedProperties to prevent Firestore errors with undefined values
  ignoreUndefinedProperties: true,
});

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
      // Clean the data by removing undefined values
      const cleanData = removeUndefinedValues(data);
      const cleanOptions = removeUndefinedValues(options);
      
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
      
      await this.jobsCollection.doc(jobId).update({
        status: 'completed',
        result: cleanResult,
        progress: 100,
        updatedAt: new Date(),
      });
      Logger.debug(`[STATE-MANAGER] Marked job ${jobId} as completed`);

      // Update crawl state if this is part of a crawl
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      const jobData = jobDoc.data() as JobState;
      if (jobData?.data?.crawl_id) {
        await this.updateCrawlProgress(jobData.data.crawl_id, jobId, true);
      }
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error marking job ${jobId} as completed: ${error}`);
      throw error;
    }
  }

  async markJobFailed(jobId: string, error: Error): Promise<void> {
    try {
      await this.jobsCollection.doc(jobId).update({
        status: 'failed',
        error: error.message,
        updatedAt: new Date(),
      });
      Logger.debug(`[STATE-MANAGER] Marked job ${jobId} as failed`);

      // Update crawl state if this is part of a crawl
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      const jobData = jobDoc.data() as JobState;
      if (jobData?.data?.crawl_id) {
        await this.updateCrawlProgress(jobData.data.crawl_id, jobId, false);
      }
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error marking job ${jobId} as failed: ${error}`);
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
      const jobDoc = await this.jobsCollection.doc(jobId).get();
      if (!jobDoc.exists) {
        Logger.error(`[STATE-MANAGER] Job ${jobId} not found when getting result`);
        return null;
      }
      
      const jobData = jobDoc.data() as JobState;
      return jobData.result;
    } catch (error) {
      Logger.error(`[STATE-MANAGER] Error getting job result for ${jobId}: ${error}`);
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
