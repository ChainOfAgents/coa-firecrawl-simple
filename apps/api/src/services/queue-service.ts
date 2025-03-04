import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Logger } from "../lib/logger";

let scrapeQueue: Queue;

// Use environment variable for Redis URL
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  Logger.error('[QUEUE-SERVICE] REDIS_URL environment variable is not set');
  throw new Error('REDIS_URL environment variable is required');
}

Logger.debug(`[QUEUE-SERVICE] Using Redis URL from environment: ${redisUrl}`);

// Initialize the Redis connection for BullMQ with GCP-compatible settings
export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  autoResubscribe: true,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 2000);
    Logger.debug(`[QUEUE-SERVICE] Retrying connection after ${delay}ms (attempt ${times})`);
    return delay;
  },
  reconnectOnError(err) {
    Logger.error(`[QUEUE-SERVICE] Error during connection: ${err.message}`);
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
  connectTimeout: 10000,
  commandTimeout: 5000,
  // Add GCP-specific settings
  enableOfflineQueue: true,
  showFriendlyErrorStack: true,
  // Disable client name setting which is not supported on GCP Redis
  enableAutoPipelining: false,
});

// Add connection event handlers
redisConnection.on('connect', () => {
  Logger.debug(`[QUEUE-SERVICE] Redis client connected successfully to: ${redisUrl}`);
});

redisConnection.on('error', (err) => {
  Logger.error(`[QUEUE-SERVICE] Redis client error: ${err.message}`);
  // Debug full error
  Logger.error(`[QUEUE-SERVICE] Full error: ${JSON.stringify(err)}`);
});

redisConnection.on('ready', () => {
  Logger.debug(`[QUEUE-SERVICE] Redis client ready`);
});

redisConnection.on('reconnecting', () => {
  Logger.debug(`[QUEUE-SERVICE] Redis client reconnecting`);
});

export const scrapeQueueName = "{scrapeQueue}";

export function getScrapeQueue(): Queue<any> {
  if (!scrapeQueue) {
    Logger.info(`[QUEUE-SERVICE] Creating scrapeQueue with Redis connection`);
    scrapeQueue = new Queue(scrapeQueueName, {
      connection: redisConnection,
      defaultJobOptions: {
        removeOnComplete: {
          age: 90000, // 25 hours
        },
        removeOnFail: {
          age: 90000, // 25 hours
        },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
      },
      // Add GCP-specific settings
      settings: {
        lockDuration: 30000,
        stalledInterval: 30000,
        maxStalledCount: 1,
      }
    });
    Logger.info("[QUEUE-SERVICE] Web scraper queue created successfully");
  }
  return scrapeQueue;
}