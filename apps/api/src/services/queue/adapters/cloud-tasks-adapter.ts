import { CloudTasksClient } from '@google-cloud/tasks';
import { QueueProvider, QueueJob, QueueJobData, QueueJobOptions, QueueJobResult } from '../types';
import { stateManager } from '../../state-management/firestore-state';
import { Logger } from '../../../lib/logger';
import { v4 as uuidv4 } from 'uuid';

// Cloud Tasks configuration
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.CLOUD_TASKS_LOCATION;
const queueId = process.env.CLOUD_TASKS_QUEUE;
const serviceUrl = process.env.CLOUD_TASKS_SERVICE_URL;
const serviceAccountEmail = process.env.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL;

// Initialize Cloud Tasks client
const client = new CloudTasksClient();

export class CloudTasksJob implements QueueJob {
  constructor(
    private taskName: string,
    public data: QueueJobData,
    public opts: QueueJobOptions
  ) {
    // Ensure data has at least a url property
    if (!this.data.url) {
      this.data.url = 'unknown';
      Logger.warn(`[CLOUD-TASKS] Created job with missing url, setting to 'unknown'`);
    }
  }

  get id(): string {
    // Use the jobId from options if available, otherwise use the Cloud Tasks ID
    return this.opts.jobId || this.taskName.split('/').pop()!;
  }

  get name(): string {
    return this.data.name || '';
  }

  progress: number | object = 0;
  timestamp: number = Date.now();

  async getState(): Promise<string> {
    return stateManager.getJobState(this.id);
  }

  async updateProgress(progress: number | object): Promise<void> {
    this.progress = progress;
    await stateManager.updateJobProgress(this.id, progress);
  }

  async moveToCompleted(returnValue: any): Promise<void> {
    await stateManager.markJobCompleted(this.id, returnValue);
  }

  async moveToFailed(error: Error): Promise<void> {
    await stateManager.markJobFailed(this.id, error);
  }
}

export class CloudTasksAdapter implements QueueProvider {
  private parent: string;
  private completeCallback?: (jobId: string, result: QueueJobResult) => void;
  private failedCallback?: (jobId: string, error: Error) => void;

  constructor(queueName: string) {
    if (!projectId || !location || !queueId || !serviceUrl || !serviceAccountEmail) {
      throw new Error('Missing required Cloud Tasks configuration');
    }
    this.parent = client.queuePath(projectId, location, queueId);
  }

  async addJob(name: string, data: QueueJobData, options: QueueJobOptions = {}): Promise<string> {
    try {
      // Use the provided jobId or generate a new one if not provided
      const originalJobId = options.jobId || uuidv4();
      
      const task = {
        name: '',
        httpRequest: {
          httpMethod: 'POST' as const,
          url: `${serviceUrl}/tasks/process`,
          headers: {
            'Content-Type': 'application/json',
          },
          // Include the originalJobId in the task data so the worker knows which job to update
          body: Buffer.from(JSON.stringify({ 
            name, 
            data, 
            options: { ...options, jobId: originalJobId } 
          })).toString('base64'),
          oidcToken: {
            serviceAccountEmail: serviceAccountEmail,
            audience: serviceUrl
          }
        },
      };

      if (options.scheduledTime) {
        const scheduleTime = new Date(options.scheduledTime);
        task['scheduleTime'] = {
          seconds: scheduleTime.getTime() / 1000,
        };
      }

      const [response] = await client.createTask({
        parent: this.parent,
        task,
      });

      const cloudTasksId = response.name!.split('/').pop()!;
      
      // Store the mapping between originalJobId and cloudTasksId in the job data
      const jobData = {
        ...data,
        cloudTasksId: cloudTasksId // Store the Cloud Tasks ID in the job data
      };
      
      // Create the job state using the originalJobId, not the Cloud Tasks ID
      await stateManager.createJob(originalJobId, name, jobData, options);
      
      Logger.debug(`Created Cloud Tasks job with original ID ${originalJobId} and Cloud Tasks ID ${cloudTasksId}`);
      
      // Return the originalJobId, not the Cloud Tasks ID
      return originalJobId;
    } catch (error) {
      Logger.error(`[CLOUD-TASKS] Error creating task: ${error}`);
      throw error;
    }
  }

  async getJob(jobId: string): Promise<QueueJob | null> {
    try {
      // First, get the job data from Firestore to find the Cloud Tasks ID
      const jobState = await stateManager.getJobData(jobId);
      if (!jobState) {
        Logger.error(`[CLOUD-TASKS] Job ${jobId} not found in Firestore`);
        return null;
      }
      
      // Use the cloudTasksId from the job data if available
      const cloudTasksId = jobState.data?.cloudTasksId || jobId;
      const taskName = `${this.parent}/tasks/${cloudTasksId}`;
      
      try {
        const [task] = await client.getTask({ name: taskName });
        
        // Create a CloudTasksJob instance
        try {
          const bodyString = Buffer.from(task.httpRequest!.body as string, 'base64').toString();
          const bodyData = JSON.parse(bodyString);
          
          return new CloudTasksJob(
            task.name!,
            bodyData.data && typeof bodyData.data === 'object' ? 
              bodyData.data : 
              { url: 'unknown', ...bodyData.data },
            bodyData.options || { jobId }
          );
        } catch (parseError) {
          Logger.error(`[CLOUD-TASKS] Error parsing task body for job ${jobId}: ${parseError}`);
          
          // Fall back to using the Firestore data
          return new CloudTasksJob(
            taskName,
            jobState.data && typeof jobState.data === 'object' ? 
              jobState.data : 
              { url: 'unknown', ...jobState.data },
            { jobId }
          );
        }
      } catch (error) {
        Logger.error(`[CLOUD-TASKS] Error getting task ${cloudTasksId} for job ${jobId}: ${error}`);
        
        // Even if we can't get the task from Cloud Tasks, we can still return a job based on Firestore data
        return new CloudTasksJob(
          taskName,
          jobState.data && typeof jobState.data === 'object' ? 
            jobState.data : 
            { url: 'unknown', ...jobState.data },
          { jobId }
        );
      }
    } catch (error) {
      Logger.error(`[CLOUD-TASKS] Error getting job ${jobId}: ${error}`);
      return null;
    }
  }

  async removeJob(jobId: string): Promise<void> {
    try {
      const taskName = `${this.parent}/tasks/${jobId}`;
      await client.deleteTask({ name: taskName });
      await stateManager.removeJob(jobId);
    } catch (error) {
      Logger.error(`[CLOUD-TASKS] Error removing task ${jobId}: ${error}`);
      throw error;
    }
  }

  async processJob(jobId: string, processor: (job: QueueJob) => Promise<QueueJobResult>): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    try {
      const result = await processor(job);
      await job.moveToCompleted(result);
      
      if (this.completeCallback) {
        this.completeCallback(jobId, result);
      }
    } catch (error) {
      await job.moveToFailed(error);
      
      if (this.failedCallback) {
        this.failedCallback(jobId, error);
      }
      
      throw error;
    }
  }

  async getJobState(jobId: string): Promise<string> {
    return await stateManager.getJobState(jobId);
  }

  async getJobResult(jobId: string): Promise<any> {
    return await stateManager.getJobResult(jobId);
  }

  async getJobError(jobId: string): Promise<Error | null> {
    const error = await stateManager.getJobError(jobId);
    return error ? new Error(error) : null;
  }

  async updateJobProgress(jobId: string, progress: number | object): Promise<void> {
    await stateManager.updateJobProgress(jobId, progress);
  }

  async getActiveCount(): Promise<number> {
    // Cloud Tasks doesn't provide a direct way to get active count
    Logger.warn('[CLOUD-TASKS] getActiveCount operation not supported');
    return 0;
  }

  async getWaitingCount(): Promise<number> {
    // Cloud Tasks doesn't provide a direct way to get waiting count
    Logger.warn('[CLOUD-TASKS] getWaitingCount operation not supported');
    return 0;
  }

  async addBulk(jobs: { name: string; data: QueueJobData; opts?: QueueJobOptions }[]): Promise<string[]> {
    const jobIds: string[] = [];
    for (const job of jobs) {
      const jobId = await this.addJob(job.name, job.data, job.opts);
      jobIds.push(jobId);
    }
    return jobIds;
  }

  async getJobs(types: string[]): Promise<QueueJob[]> {
    // Cloud Tasks doesn't provide a way to list tasks by type
    Logger.warn('[CLOUD-TASKS] getJobs operation not supported');
    return [];
  }

  async pause(): Promise<void> {
    // Cloud Tasks doesn't support queue-level pause
    Logger.warn('[CLOUD-TASKS] Pause operation not supported');
  }

  async resume(): Promise<void> {
    // Cloud Tasks doesn't support queue-level pause
    Logger.warn('[CLOUD-TASKS] Resume operation not supported');
  }

  onJobComplete(callback: (jobId: string, result: QueueJobResult) => void): void {
    this.completeCallback = callback;
  }

  onJobFailed(callback: (jobId: string, error: Error) => void): void {
    this.failedCallback = callback;
  }
}
