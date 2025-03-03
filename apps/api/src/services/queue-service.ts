import { Queue } from "bullmq";
import { Logger } from "../lib/logger";
import IORedis from "ioredis";

let scrapeQueue: Queue;

// Hardcode Redis URL for testing purposes
// Add extensive logging to track the Redis URL being used
// Using hardcoded Redis IP from the environment variables in cloudbuild-worker.yaml
const redisURL = 'redis://10.130.67.11:6379'; // Hardcoded Redis URL for testing
Logger.info(`[HARDCODED] Using Redis URL: ${redisURL}`);
Logger.info(`Original env REDIS_URL value was: ${process.env.REDIS_URL || 'not set'}`);

export const redisConnection = new IORedis(redisURL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    Logger.info(`Redis connection retry attempt #${times}, retrying in ${delay}ms. URL: ${redisURL}`);
    return delay;
  },
  reconnectOnError: (err) => {
    Logger.error(`Redis connection error: ${err.message}. URL: ${redisURL}. Reconnecting...`);
    return true;
  }
});

// Add connection event handlers
redisConnection.on('connect', () => {
  Logger.info(`Redis client connected successfully to: ${redisURL}`);
});

redisConnection.on('error', (err) => {
  Logger.error(`Redis client error with URL ${redisURL}: ${err.message}`);
  // Debug full error
  Logger.error(`Full error: ${JSON.stringify(err)}`);
});

redisConnection.on('ready', () => {
  Logger.info(`Redis client ready on: ${redisURL}`);
});

redisConnection.on('reconnecting', () => {
  Logger.info(`Redis client reconnecting to: ${redisURL}`);
});

export const scrapeQueueName = "{scrapeQueue}";

export function getScrapeQueue(): Queue<any> {
  if (!scrapeQueue) {
    Logger.info(`Creating scrapeQueue with Redis connection to: ${redisURL}`);
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
