import { CloudTasksClient } from '@google-cloud/tasks';
import { QueueProvider, QueueJob, QueueJobData, QueueJobOptions, QueueJobResult } from '../types';
import { stateManager } from '../../state-management/firestore-state';
import { Logger } from '../../../lib/logger';

// Cloud Tasks configuration
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.CLOUD_TASKS_LOCATION;
const queueId = process.env.CLOUD_TASKS_QUEUE;
const serviceUrl = process.env.CLOUD_TASKS_SERVICE_URL;

// Initialize Cloud Tasks client
const client = new CloudTasksClient();

export class CloudTasksJob implements QueueJob {
  constructor(
    private taskName: string,
    public data: QueueJobData,
    public opts: QueueJobOptions
  ) {}

  get id(): string {
    return this.taskName.split('/').pop()!;
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
    if (!projectId || !location || !queueId || !serviceUrl) {
      throw new Error('Missing required Cloud Tasks configuration');
    }
    this.parent = client.queuePath(projectId, location, queueId);
  }

  async addJob(name: string, data: QueueJobData, options: QueueJobOptions = {}): Promise<string> {
    try {
      const task = {
        name: '',
        httpRequest: {
          httpMethod: 'POST' as const,
          url: `${serviceUrl}/tasks/process`,
          headers: {
            'Content-Type': 'application/json',
          },
          body: Buffer.from(JSON.stringify({ name, data, options })).toString('base64'),
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

      const jobId = response.name!.split('/').pop()!;
      await stateManager.createJob(jobId, name, data, options);

      return jobId;
    } catch (error) {
      Logger.error(`[CLOUD-TASKS] Error creating task: ${error}`);
      throw error;
    }
  }

  async getJob(jobId: string): Promise<QueueJob | null> {
    try {
      const taskName = `${this.parent}/tasks/${jobId}`;
      const [task] = await client.getTask({ name: taskName });
      
      if (!task) {
        return null;
      }

      const { name, data, options } = JSON.parse(
        Buffer.from(task.httpRequest!.body as string, 'base64').toString()
      );

      return new CloudTasksJob(task.name!, data, options);
    } catch (error) {
      Logger.error(`[CLOUD-TASKS] Error getting task ${jobId}: ${error}`);
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
