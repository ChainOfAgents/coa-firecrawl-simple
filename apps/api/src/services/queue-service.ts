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
    }
    
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) {
      return true;
    }
    return false;
  },
  connectTimeout: 10000,
  commandTimeout: 5000,
  enableOfflineQueue: true,
  maxScriptsCachingSize: 100,
  // Use this option only for Redis servers with limited command support
  connectionName: null, // Disable client name setting
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

export const scrapeQueueName = "scrapeQueue"; // Changed from {scrapeQueue} to avoid prefix issues

export function getScrapeQueue(): Queue<any> {
  if (!scrapeQueue) {
    Logger.info(`[QUEUE-SERVICE] Creating scrapeQueue with Redis connection`);

    // Add additional options for BullMQ to handle Redis compatibility issues
    const bullMQOptions = {
      connection: redisConnection,
      prefix: 'bull', // Simplified prefix without curly braces
      skipLockDuringDisconnection: true,
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
    };

    try {
      scrapeQueue = new Queue(scrapeQueueName, bullMQOptions);
      Logger.info("[QUEUE-SERVICE] Web scraper queue created successfully");
    } catch (err) {
      Logger.error(`[QUEUE-SERVICE] Failed to create queue: ${err.message}`);
      Logger.error(`[QUEUE-SERVICE] Stack trace: ${err.stack}`);
      
      // If we get a specific Redis error, try a different approach
      if (err.message.includes('unknown command') || err.message.includes('ERR unknown command')) {
        Logger.info("[QUEUE-SERVICE] Attempting to create queue with alternative configuration");
        // Try with even more basic configuration
        bullMQOptions.prefix = 'bull'; // Use a very simple prefix
        scrapeQueue = new Queue(scrapeQueueName, bullMQOptions);
        Logger.info("[QUEUE-SERVICE] Web scraper queue created with alternative configuration");
      } else {
        // Re-throw any other errors
        throw err;
      }
    }
  }
  return scrapeQueue;
}
