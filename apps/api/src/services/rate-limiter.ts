import { RateLimiterMemory } from "rate-limiter-flexible";
import { RateLimiterMode } from "../../src/types";
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
};

/**
 * UnlimitedRateLimiter - A dummy rate limiter that never limits requests
 * This replaces both Redis and Memory-based rate limiters
 */
class UnlimitedRateLimiter {
  points = UNLIMITED_POINTS;
  duration = 60;

  constructor(options: any) {
    Logger.info('[RATE-LIMITER] Using unlimited rate limiter');
  }

  get = async (key: string) => ({ 
    remainingPoints: UNLIMITED_POINTS, 
    msBeforeNext: 0 
  });

  consume(key: string, pointsToConsume = 1): Promise<any> {
    return Promise.resolve({
      remainingPoints: UNLIMITED_POINTS,
      msBeforeNext: 0
    });
  }

  block(key: string, secDuration: number): Promise<any> {
    return Promise.resolve();
  }

  penalty(key: string, points: number): Promise<any> {
    return Promise.resolve();
  }

  reward(key: string, points: number): Promise<any> {
    return Promise.resolve();
  }
}

// Create a rate limiter instance
// @param keyPrefix Prefix for the rate limiter keys
// @param points Number of points (requests) allowed in the duration
// @returns RateLimiter instance
function createRateLimiter(keyPrefix: string, points: number) {
  Logger.info(`[RATE-LIMITER] Creating unlimited rate limiter for ${keyPrefix}`);
  return new UnlimitedRateLimiter({
    keyPrefix,
    points,
    duration: 60 * 60 // 1 hour
  });
}

const testSuiteTokens = ["a01ccae", "6254cf9", "0f96e673", "23befa1b", "69141c4"];
const manual = process.env.MANUAL_TEAM_IDS ? process.env.MANUAL_TEAM_IDS.split(",") : [];

// Get a rate limiter for a specific mode, token, plan, and team ID
export function getRateLimiter(
  mode: RateLimiterMode,
  token: string,
  plan?: string,
  teamId?: string
) {
  const points = RATE_LIMITS[mode][plan] || RATE_LIMITS[mode].default;
  return createRateLimiter(`${mode}:${token}`, points);
}

// Export standard rate limiters using the unlimited implementation
export const serverRateLimiter = createRateLimiter(
  "server",
  UNLIMITED_POINTS
);

export const defaultRateLimiter = createRateLimiter(
  "default",
  UNLIMITED_POINTS
);

export const testSuiteRateLimiter = createRateLimiter(
  "test",
  UNLIMITED_POINTS
);