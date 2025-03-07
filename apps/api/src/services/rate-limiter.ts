import { RateLimiterRedis, RateLimiterMemory } from "rate-limiter-flexible";
import { RateLimiterMode } from "../../src/types";
import Redis from "ioredis";
import { Logger } from "../lib/logger";

// Define high rate limits for unlimited usage
const UNLIMITED_POINTS = 999999;

const RATE_LIMITS = {
  crawl: {
    default: UNLIMITED_POINTS,
    free: UNLIMITED_POINTS,
    starter: UNLIMITED_POINTS,
    standard: UNLIMITED_POINTS,
    standardOld: UNLIMITED_POINTS,
    scale: UNLIMITED_POINTS,
    hobby: UNLIMITED_POINTS,
    standardNew: UNLIMITED_POINTS,
    standardnew: UNLIMITED_POINTS,
    growth: UNLIMITED_POINTS,
    growthdouble: UNLIMITED_POINTS,
  },
  scrape: {
    default: UNLIMITED_POINTS,
    free: UNLIMITED_POINTS,
    starter: UNLIMITED_POINTS,
    standard: UNLIMITED_POINTS,
    standardOld: UNLIMITED_POINTS,
    scale: UNLIMITED_POINTS,
    hobby: UNLIMITED_POINTS,
    standardNew: UNLIMITED_POINTS,
    standardnew: UNLIMITED_POINTS,
    growth: UNLIMITED_POINTS,
    growthdouble: UNLIMITED_POINTS,
  },
  search: {
    default: UNLIMITED_POINTS,
    free: UNLIMITED_POINTS,
    starter: UNLIMITED_POINTS,
    standard: UNLIMITED_POINTS,
    standardOld: UNLIMITED_POINTS,
    scale: UNLIMITED_POINTS,
    hobby: UNLIMITED_POINTS,
    standardNew: UNLIMITED_POINTS,
    standardnew: UNLIMITED_POINTS,
    growth: UNLIMITED_POINTS,
    growthdouble: UNLIMITED_POINTS,
  },
  map: {
    default: UNLIMITED_POINTS,
    free: UNLIMITED_POINTS,
    starter: UNLIMITED_POINTS,
    standard: UNLIMITED_POINTS,
    standardOld: UNLIMITED_POINTS,
    scale: UNLIMITED_POINTS,
    hobby: UNLIMITED_POINTS,
    standardNew: UNLIMITED_POINTS,
    standardnew: UNLIMITED_POINTS,
    growth: UNLIMITED_POINTS,
    growthdouble: UNLIMITED_POINTS,
  },
  account: {
    default: UNLIMITED_POINTS,
    free: UNLIMITED_POINTS,
    starter: UNLIMITED_POINTS,
    standard: UNLIMITED_POINTS,
    standardOld: UNLIMITED_POINTS,
    scale: UNLIMITED_POINTS,
    hobby: UNLIMITED_POINTS,
    standardNew: UNLIMITED_POINTS,
    standardnew: UNLIMITED_POINTS,
    growth: UNLIMITED_POINTS,
    growthdouble: UNLIMITED_POINTS,
  },
};

// Always use the unlimited rate limiter
const isUsingUnlimitedRateLimiter = true;

/**
 * UnlimitedRateLimiter - A dummy rate limiter that never limits requests
 * This replaces both Redis and Memory-based rate limiters
 */
export class UnlimitedRateLimiter {
  points = UNLIMITED_POINTS;
  duration = 60;

  constructor(options: any) {
    Logger.info('[RATE-LIMITER] Using unlimited rate limiter');
  }

  async consume(key: string, pointsToConsume = 1): Promise<any> {
    Logger.debug(`[RATE-LIMITER] Unlimited consume ${pointsToConsume} points for ${key}`);
    return { 
      remainingPoints: UNLIMITED_POINTS - 1, 
      msBeforeNext: 0,
      consumedPoints: pointsToConsume
    };
  }

  async block(key: string, secDuration: number): Promise<any> {
    Logger.debug(`[RATE-LIMITER] Unlimited block ${key} for ${secDuration} seconds (no-op)`);
    return true;
  }

  async penalty(key: string, points: number): Promise<any> {
    Logger.debug(`[RATE-LIMITER] Unlimited penalty ${points} points for ${key} (no-op)`);
    return { 
      remainingPoints: UNLIMITED_POINTS - points, 
      msBeforeNext: 0 
    };
  }

  async reward(key: string, points: number): Promise<any> {
    Logger.debug(`[RATE-LIMITER] Unlimited reward ${points} points for ${key} (no-op)`);
    return { 
      remainingPoints: UNLIMITED_POINTS, 
      msBeforeNext: 0 
    };
  }

  get = async (key: string) => ({ 
    remainingPoints: UNLIMITED_POINTS, 
    msBeforeNext: 0 
  });
}

/**
 * Create a rate limiter instance
 * @param keyPrefix Prefix for the rate limiter keys
 * @param points Number of points (requests) allowed in the duration
 * @returns RateLimiter instance
 */
function createRateLimiter(keyPrefix: string, points: number) {
  Logger.debug(`[RATE-LIMITER] Creating unlimited rate limiter with prefix ${keyPrefix}`);
  
  // Always use the unlimited rate limiter
  return new UnlimitedRateLimiter({
    keyPrefix,
    points: UNLIMITED_POINTS,
    duration: 60
  });
}

const testSuiteTokens = ["a01ccae", "6254cf9", "0f96e673", "23befa1b", "69141c4"];
const manual = process.env.MANUAL_TEAM_IDS ? process.env.MANUAL_TEAM_IDS.split(",") : [];

/**
 * Get a rate limiter for a specific mode, token, plan, and team ID
 */
export function getRateLimiter(
  mode: RateLimiterMode,
  token: string,
  plan?: string,
  teamId?: string
) {
  // Always return unlimited rate limiter regardless of parameters
  return createRateLimiter(`${mode}`, UNLIMITED_POINTS);
}

// Export standard rate limiters using the unlimited implementation
export const serverRateLimiter = createRateLimiter(
  "server",
  UNLIMITED_POINTS
);

export const testSuiteRateLimiter = createRateLimiter(
  "test-suite",
  UNLIMITED_POINTS
);

export const devBRateLimiter = createRateLimiter(
  "dev-b",
  UNLIMITED_POINTS
);

export const manualRateLimiter = createRateLimiter(
  "manual",
  UNLIMITED_POINTS
);

export const scrapeStatusRateLimiter = createRateLimiter(
  "scrape-status",
  UNLIMITED_POINTS
);

// For backward compatibility
export const DummyRateLimiter = UnlimitedRateLimiter;
export let redisRateLimitClient: Redis = null;