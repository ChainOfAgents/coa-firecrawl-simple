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

// Initialize the Redis connection for BullMQ with robust connection settings
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
    Logger.error(`[QUEUE-SERVICE] Stack trace: ${err.stack}`);
    
    // For specific errors that might indicate Redis server compatibility issues
    if (err.message.includes('unknown command') || 
        err.message.includes('ERR unknown command')) {
      Logger.error('[QUEUE-SERVICE] Redis compatibility issue detected: your Redis server may not support all commands needed');
      return true; // Always reconnect for command compatibility issues
    }
    
    // Also reconnect for timeouts
    if (err.message.includes('timeout') || err.message.includes('timed out')) {
      Logger.error('[QUEUE-SERVICE] Redis timeout detected, will reconnect');
      return true;
    }
    
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
  connectTimeout: 10000,
  commandTimeout: 5000,
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
    });
    Logger.info("[QUEUE-SERVICE] Web scraper queue created successfully");
  }
  return scrapeQueue;
}
