import Redis from "ioredis";
import { Logger } from "../lib/logger";

const queueProvider = process.env.QUEUE_PROVIDER || 'bull';
let redisRateLimitClient = null;

// Only initialize Redis if we're not using Cloud Tasks
if (queueProvider !== 'cloud-tasks') {
  // Use environment variables for Redis URLs
  const redisRateLimitUrl = process.env.REDIS_RATE_LIMIT_URL;
  if (!redisRateLimitUrl) {
    Logger.error('[RATE-LIMITER] REDIS_RATE_LIMIT_URL environment variable is not set');
    throw new Error('REDIS_RATE_LIMIT_URL environment variable is required when not using Cloud Tasks');
  }

  Logger.info(`[RATE-LIMITER] Using Redis URL from environment`);

  // Initialize Redis client for rate limiting with robust connection settings
  // Define standard Redis options
  const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    autoResubscribe: true,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 2000);
      Logger.info(`[RATE-LIMITER] Retrying connection after ${delay}ms (attempt ${times})`);
      return delay;
    },
    reconnectOnError(err) {
      Logger.error(`[RATE-LIMITER] Error during connection: ${err.message}`);
      const targetError = 'READONLY';
      if (err.message.includes(targetError)) {
        return true;
      }
      return false;
    },
    connectTimeout: 10000,
    commandTimeout: 5000,
    enableOfflineQueue: true,
    showFriendlyErrorStack: true,
    enableAutoPipelining: false,
  };

  // Create Redis client with both standard and custom options
  redisRateLimitClient = new Redis(redisRateLimitUrl, {
    ...redisOptions,
    // These custom options need to be added with type assertion
  } as any); // Type assertion needed for custom Redis options

  // Add GCP-specific settings that aren't in the type definition
  // We need to set these properties after creating the client
  (redisRateLimitClient as any).options.disableClientSetname = true;
  (redisRateLimitClient as any).options.clientName = '';
  (redisRateLimitClient as any).options.username = '';
  (redisRateLimitClient as any).options.keyPrefix = '';

  // Add event listeners only if Redis client exists
  redisRateLimitClient.on("error", (error) => {
    try {
      if (error.message === "ECONNRESET") {
        Logger.error("[RATE-LIMITER] Connection to Redis Session Rate Limit Store timed out.");
      } else if (error.message === "ECONNREFUSED") {
        Logger.error("[RATE-LIMITER] Connection to Redis Session Rate Limit Store refused!");
      } else Logger.error(`[RATE-LIMITER] Redis error: ${error.message}`);
    } catch (error) {
      Logger.error(`[RATE-LIMITER] Error handling Redis error: ${error}`);
    }
  });

  redisRateLimitClient.on("reconnecting", () => {
    try {
      if (redisRateLimitClient.status === "reconnecting")
        Logger.info("[RATE-LIMITER] Reconnecting to Redis Session Rate Limit Store...");
      else Logger.error("[RATE-LIMITER] Error reconnecting to Redis Session Rate Limit Store.");
    } catch (error) {
      Logger.error(`[RATE-LIMITER] Error handling reconnection: ${error}`);
    }
  });

  // Listen to the 'connect' event to Redis
  redisRateLimitClient.on("connect", () => {
    try {
      Logger.info("[RATE-LIMITER] Connected to Redis Session Rate Limit Store.");
    } catch (error) {
      Logger.error(`[RATE-LIMITER] Error handling connection: ${error}`);
    }
  });
} else {
  Logger.info('[RATE-LIMITER] Using Cloud Tasks, skipping Redis initialization');
}

// Create dummy functions when Redis is not available
const setValue = async (key: string, value: string, expire?: number): Promise<void> => {
  if (queueProvider !== 'cloud-tasks' && redisRateLimitClient) {
    try {
      if (expire) {
        await redisRateLimitClient.set(key, value, "EX", expire);
      } else {
        await redisRateLimitClient.set(key, value);
      }
    } catch (error) {
      Logger.error(`[RATE-LIMITER] Error setting Redis key ${key}: ${error.message}`);
    }
  } else {
    Logger.debug(`[RATE-LIMITER] Dummy setValue called for key: ${key} (Cloud Tasks mode)`);
  }
};

const getValue = async (key: string): Promise<string | null> => {
  if (queueProvider !== 'cloud-tasks' && redisRateLimitClient) {
    try {
      return await redisRateLimitClient.get(key);
    } catch (error) {
      Logger.error(`[RATE-LIMITER] Error getting Redis key ${key}: ${error.message}`);
      return null;
    }
  } else {
    Logger.debug(`[RATE-LIMITER] Dummy getValue called for key: ${key} (Cloud Tasks mode)`);
    return null;
  }
};

const deleteKey = async (key: string): Promise<void> => {
  if (queueProvider !== 'cloud-tasks' && redisRateLimitClient) {
    try {
      await redisRateLimitClient.del(key);
    } catch (error) {
      Logger.error(`[RATE-LIMITER] Error deleting Redis key ${key}: ${error.message}`);
    }
  } else {
    Logger.debug(`[RATE-LIMITER] Dummy deleteKey called for key: ${key} (Cloud Tasks mode)`);
  }
};

export { setValue, getValue, deleteKey };
