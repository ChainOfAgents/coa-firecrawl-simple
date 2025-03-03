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

Logger.info(`[QUEUE-SERVICE] Using Redis URL from environment: ${redisUrl}`);

// Initialize the Redis connection for BullMQ
export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  autoResubscribe: true,
});

// Add connection event handlers
redisConnection.on('connect', () => {
  Logger.info(`Redis client connected successfully to: ${redisUrl}`);
});

redisConnection.on('error', (err) => {
  Logger.error(`Redis client error: ${err.message}`);
  // Debug full error
  Logger.error(`Full error: ${JSON.stringify(err)}`);
});

redisConnection.on('ready', () => {
  Logger.info(`Redis client ready`);
});

redisConnection.on('reconnecting', () => {
  Logger.info(`Redis client reconnecting`);
});

export const scrapeQueueName = "{scrapeQueue}";

export function getScrapeQueue(): Queue<any> {
  if (!scrapeQueue) {
    Logger.info(`Creating scrapeQueue with Redis connection`);
    scrapeQueue = new Queue(scrapeQueueName, {
      connection: redisConnection,
      defaultJobOptions: {
        removeOnComplete: {
          age: 90000, // 25 hours
        },
        removeOnFail: {
          age: 90000, // 25 hours
        },
      },
    });
    Logger.info("Web scraper queue created successfully");
  }
  return scrapeQueue;
}
