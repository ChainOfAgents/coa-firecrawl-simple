import { Job } from 'bullmq';

export interface QueueJobData {
  url: string;
  name?: string;
  crawl_id?: string;
  [key: string]: any;
}

export interface QueueJobBackoff {
  type: 'exponential' | 'fixed';
  delay: number;
}

export interface QueueJobRemoveOption {
  age?: number;
}

export interface QueueJobOptions {
  jobId?: string;
  attempts?: number;
  backoff?: QueueJobBackoff;
  removeOnComplete?: boolean | QueueJobRemoveOption;
  removeOnFail?: boolean | QueueJobRemoveOption;
  [key: string]: any;
}

export interface QueueJobResult {
  success: boolean;
  message?: string;
  data?: any;
}

export interface QueueJob {
  id: string;
  name: string;
  data: QueueJobData;
  opts: QueueJobOptions;
  progress: number | object;
  returnvalue?: QueueJobResult;
  timestamp?: number;
  getState?: () => Promise<string>;
  updateProgress(progress: number | object): Promise<void>;
  moveToCompleted(returnValue: any): Promise<void>;
  moveToFailed(error: Error): Promise<void>;
}

export interface QueueProvider {
  addJob(name: string, data: QueueJobData, options?: QueueJobOptions): Promise<string>;
  getJob(jobId: string): Promise<QueueJob | null>;
  removeJob(jobId: string): Promise<void>;
  processJob(jobId: string, processor: (job: QueueJob) => Promise<QueueJobResult>): Promise<void>;
  getJobState(jobId: string): Promise<string>;
  updateJobProgress(jobId: string, progress: number | object): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  onJobComplete(callback: (jobId: string, result: QueueJobResult) => void): void;
  onJobFailed(callback: (jobId: string, error: Error) => void): void;
  getActiveCount?(): Promise<number>;
  getWaitingCount?(): Promise<number>;
  addBulk?(jobs: { name: string; data: QueueJobData; opts?: QueueJobOptions }[]): Promise<string[]>;
  getJobs?(types: string[]): Promise<QueueJob[]>;
  add?(name: string, data: QueueJobData, options?: QueueJobOptions): Promise<string>;
  getNextJob?(): Promise<QueueJob | null>;
  lockURL?(url: string): Promise<boolean>;
}
