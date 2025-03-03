import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { Logger } from "../lib/logger";

let scrapeQueue: Queue;

// For testing - use hardcoded Redis URL that matches the API service
const hardcodedRedisURL = 'redis://10.155.240.35:6379';
Logger.info(`[QUEUE-SERVICE] [HARDCODED] Using Redis URL: ${hardcodedRedisURL}`);
Logger.info(`[QUEUE-SERVICE] Original env REDIS_URL value was: ${process.env.REDIS_URL || 'not set'}`);

// Initialize the Redis connection for BullMQ
export const redisConnection = new Redis(hardcodedRedisURL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  autoResubscribe: true,
});

// Add connection event handlers
redisConnection.on('connect', () => {
  Logger.info(`Redis client connected successfully to: ${hardcodedRedisURL}`);
});

redisConnection.on('error', (err) => {
  Logger.error(`Redis client error with URL ${hardcodedRedisURL}: ${err.message}`);
  // Debug full error
  Logger.error(`Full error: ${JSON.stringify(err)}`);
});

redisConnection.on('ready', () => {
  Logger.info(`Redis client ready on: ${hardcodedRedisURL}`);
});

redisConnection.on('reconnecting', () => {
  Logger.info(`Redis client reconnecting to: ${hardcodedRedisURL}`);
});

export const scrapeQueueName = "{scrapeQueue}";

export function getScrapeQueue(): Queue<any> {
  if (!scrapeQueue) {
    Logger.info(`Creating scrapeQueue with Redis connection to: ${hardcodedRedisURL}`);
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
