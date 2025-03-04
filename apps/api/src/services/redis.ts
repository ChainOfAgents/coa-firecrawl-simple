import Redis from "ioredis";
import { Logger } from "../lib/logger";

// Use environment variables for Redis URLs
const redisRateLimitUrl = process.env.REDIS_RATE_LIMIT_URL;
if (!redisRateLimitUrl) {
  Logger.error('[RATE-LIMITER] REDIS_RATE_LIMIT_URL environment variable is not set');
  throw new Error('REDIS_RATE_LIMIT_URL environment variable is required');
}

Logger.info(`[RATE-LIMITER] Using Redis URL from environment: ${redisRateLimitUrl}`);

// Initialize Redis client for rate limiting with robust connection settings
const redisRateLimitClient = new Redis(redisRateLimitUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  autoResubscribe: true,
  connectionName: null, // Disable client name setting to avoid 'CLIENT SETNAME' command
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
});

// Listen to 'error' events to the Redis connection
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

// Listen to 'reconnecting' event to Redis
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
    Logger.info("[RATE-LIMITER] Connected to Redis Session Rate Limit Store!");
  } catch (error) {
    Logger.error(`[RATE-LIMITER] Error handling connect event: ${error}`);
  }
});

redisRateLimitClient.on('ready', () => {
  Logger.info(`[RATE-LIMITER] Redis client ready`);
});

/**
 * Set a value in Redis with an optional expiration time.
 * @param {string} key The key under which to store the value.
 * @param {string} value The value to store.
 * @param {number} [expire] Optional expiration time in seconds.
 */
const setValue = async (key: string, value: string, expire?: number) => {
  try {
    if (expire) {
      await redisRateLimitClient.set(key, value, "EX", expire);
    } else {
      await redisRateLimitClient.set(key, value);
    }
  } catch (error) {
    Logger.error(`[RATE-LIMITER] Error setting value: ${error.message}`);
    throw error;
  }
};

/**
 * Get a value from Redis.
 * @param {string} key The key of the value to retrieve.
 * @returns {Promise<string|null>} The value, if found, otherwise null.
 */
const getValue = async (key: string): Promise<string | null> => {
  try {
    const value = await redisRateLimitClient.get(key);
    return value;
  } catch (error) {
    Logger.error(`[RATE-LIMITER] Error getting value: ${error.message}`);
    throw error;
  }
};

/**
 * Delete a key from Redis.
 * @param {string} key The key to delete.
 */
const deleteKey = async (key: string) => {
  try {
    await redisRateLimitClient.del(key);
  } catch (error) {
    Logger.error(`[RATE-LIMITER] Error deleting key: ${error.message}`);
    throw error;
  }
};

export { setValue, getValue, deleteKey };
