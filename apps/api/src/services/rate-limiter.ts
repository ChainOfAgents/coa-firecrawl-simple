import { RateLimiterRedis } from "rate-limiter-flexible";
import { RateLimiterMode } from "../../src/types";
import Redis from "ioredis";
import { Logger } from "../lib/logger";

const RATE_LIMITS = {
  crawl: {
    default: 3,
    free: 2,
    starter: 10,
    standard: 5,
    standardOld: 40,
    scale: 50,
    hobby: 3,
    standardNew: 10,
    standardnew: 10,
    growth: 50,
    growthdouble: 50,
  },
  scrape: {
    default: 20,
    free: 10,
    starter: 100,
    standard: 100,
    standardOld: 100,
    scale: 500,
    hobby: 20,
    standardNew: 100,
    standardnew: 100,
    growth: 1000,
    growthdouble: 1000,
  },
  search: {
    default: 20,
    free: 5,
    starter: 50,
    standard: 50,
    standardOld: 40,
    scale: 500,
    hobby: 10,
    standardNew: 50,
    standardnew: 50,
    growth: 500,
    growthdouble: 500,
  },
  map:{
    default: 20,
    free: 5,
    starter: 50,
    standard: 50,
    standardOld: 50,
    scale: 500,
    hobby: 10,
    standardNew: 50,
    standardnew: 50,
    growth: 500,
    growthdouble: 500,
  },
  preview: {
    free: 5,
    default: 5,
  },
  account: {
    free: 100,
    default: 100,
  },
  crawlStatus: {
    free: 150,
    default: 250,
  },
  testSuite: {
    free: 10000,
    default: 10000,
  },
};

// Use Redis URL from environment
const redisRateLimitUrl = process.env.REDIS_RATE_LIMIT_URL;
if (!redisRateLimitUrl) {
  Logger.error('[RATE-LIMITER] REDIS_RATE_LIMIT_URL environment variable is not set');
  throw new Error('REDIS_RATE_LIMIT_URL environment variable is required');
}

Logger.info(`[RATE-LIMITER] Using Redis URL from environment`);

// Initialize Redis client with robust configuration
export const redisRateLimitClient = new Redis(redisRateLimitUrl, {
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
  // Add GCP-specific settings
  enableOfflineQueue: true,
  showFriendlyErrorStack: true,
  // Disable client name setting which is not supported on GCP Redis
  enableAutoPipelining: false,
  username: '', // Disable client name setting
  keyPrefix: '' // Disable key prefix
});

// Add connection event handlers
redisRateLimitClient.on('connect', () => {
  Logger.debug(`[RATE-LIMITER] Redis client connected successfully`);
});

redisRateLimitClient.on('error', (err) => {
  Logger.error(`[RATE-LIMITER] Redis client error: ${err.message}`);
});

redisRateLimitClient.on('ready', () => {
  Logger.debug(`[RATE-LIMITER] Redis client ready`);
});

redisRateLimitClient.on('reconnecting', () => {
  Logger.debug(`[RATE-LIMITER] Redis client reconnecting`);
});

const createRateLimiter = (keyPrefix, points) =>
  new RateLimiterRedis({
    storeClient: redisRateLimitClient,
    keyPrefix,
    points,
    duration: 60, // Duration in seconds
  });

export const serverRateLimiter = createRateLimiter(
  "server",
  RATE_LIMITS.account.default
);

export const testSuiteRateLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "test-suite",
  points: 10000,
  duration: 60, // Duration in seconds
});

export const devBRateLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "dev-b",
  points: 1200,
  duration: 60, // Duration in seconds
});

export const manualRateLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "manual",
  points: 2000,
  duration: 60, // Duration in seconds
});

export const scrapeStatusRateLimiter = new RateLimiterRedis({
  storeClient: redisRateLimitClient,
  keyPrefix: "scrape-status",
  points: 400,
  duration: 60, // Duration in seconds
});

const testSuiteTokens = ["a01ccae", "6254cf9", "0f96e673", "23befa1b", "69141c4"];

const manual = ["69be9e74-7624-4990-b20d-08e0acc70cf6"];

export function getRateLimiter(
  mode: RateLimiterMode,
  token: string,
  plan?: string,
  teamId?: string
) {
  
  if (testSuiteTokens.some(testToken => token.includes(testToken))) {
    return testSuiteRateLimiter;
  }

  if(teamId && teamId === process.env.DEV_B_TEAM_ID) {
    return devBRateLimiter;
  }

  if(teamId && manual.includes(teamId)) {
    return manualRateLimiter;
  }

  const rateLimitConfig = RATE_LIMITS[mode];

  if (!rateLimitConfig) return serverRateLimiter;

  const planKey = plan ? plan.replace("-", "") : "default";
  const points = rateLimitConfig[planKey] || rateLimitConfig.default || rateLimitConfig;

  return createRateLimiter(`${mode}-${planKey}`, points);
}