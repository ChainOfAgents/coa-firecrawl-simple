import Redis from "ioredis";
import { Logger } from "../lib/logger";

// Use environment variables for Redis URLs
const redisRateLimitUrl = process.env.REDIS_RATE_LIMIT_URL;
if (!redisRateLimitUrl) {
  Logger.error('[RATE-LIMITER] REDIS_RATE_LIMIT_URL environment variable is not set');
  throw new Error('REDIS_RATE_LIMIT_URL environment variable is required');
}

Logger.info(`[RATE-LIMITER] Using Redis URL from environment: ${redisRateLimitUrl}`);

// Initialize Redis client for rate limiting
const redisRateLimitClient = new Redis(redisRateLimitUrl);

// Listen to 'error' events to the Redis connection
redisRateLimitClient.on("error", (error) => {
  try {
    if (error.message === "ECONNRESET") {
      Logger.error("Connection to Redis Session Rate Limit Store timed out.");
    } else if (error.message === "ECONNREFUSED") {
      Logger.error("Connection to Redis Session Rate Limit Store refused!");
    } else Logger.error(error);
  } catch (error) {}
});

// Listen to 'reconnecting' event to Redis
redisRateLimitClient.on("reconnecting", (err) => {
  try {
    if (redisRateLimitClient.status === "reconnecting")
      Logger.info("Reconnecting to Redis Session Rate Limit Store...");
    else Logger.error("Error reconnecting to Redis Session Rate Limit Store.");
  } catch (error) {}
});

// Listen to the 'connect' event to Redis
redisRateLimitClient.on("connect", (err) => {
  try {
    if (!err) Logger.info("Connected to Redis Session Rate Limit Store!");
  } catch (error) {}
});

// Add connection event handlers
redisRateLimitClient.on('connect', () => {
  Logger.info(`[RATE-LIMITER] Redis client connected successfully to: ${redisRateLimitUrl}`);
});

redisRateLimitClient.on('error', (err) => {
  Logger.error(`[RATE-LIMITER] Redis client error: ${err.message}`);
  // Debug full error
  Logger.error(`[RATE-LIMITER] Full error: ${JSON.stringify(err)}`);
});

redisRateLimitClient.on('ready', () => {
  Logger.info(`[RATE-LIMITER] Redis client ready`);
});

redisRateLimitClient.on('reconnecting', () => {
  Logger.info(`[RATE-LIMITER] Redis client reconnecting`);
});

/**
 * Set a value in Redis with an optional expiration time.
 * @param {string} key The key under which to store the value.
 * @param {string} value The value to store.
 * @param {number} [expire] Optional expiration time in seconds.
 */
const setValue = async (key: string, value: string, expire?: number) => {
  if (expire) {
    await redisRateLimitClient.set(key, value, "EX", expire);
  } else {
    await redisRateLimitClient.set(key, value);
  }
};

/**
 * Get a value from Redis.
 * @param {string} key The key of the value to retrieve.
 * @returns {Promise<string|null>} The value, if found, otherwise null.
 */
const getValue = async (key: string): Promise<string | null> => {
  const value = await redisRateLimitClient.get(key);
  return value;
};

/**
 * Delete a key from Redis.
 * @param {string} key The key to delete.
 */
const deleteKey = async (key: string) => {
  await redisRateLimitClient.del(key);
};

export { setValue, getValue, deleteKey };
