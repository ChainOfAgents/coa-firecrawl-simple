import { Request, Response } from "express";
import Redis, { RedisOptions } from "ioredis";
import { Logger } from "../../../lib/logger";

export async function redisHealthController(req: Request, res: Response) {
  // Since we're not using Redis anymore, just return healthy
  Logger.info('[REDIS-HEALTH] Using unlimited rate limiter, Redis not required');
  return res.status(200).json({ 
    status: "healthy", 
    details: { message: "Using unlimited rate limiter, Redis not required" } 
  });
}

export async function checkRedisContent(req: Request, res: Response) {
  // Skip Redis content check if using Cloud Tasks
  if (process.env.QUEUE_PROVIDER === 'cloud-tasks') {
    Logger.info('[REDIS-HEALTH] Using Cloud Tasks, skipping Redis content check');
    return res.json({
      success: true,
      message: "Using Cloud Tasks, Redis not required"
    });
  }

  try {
    // Check if Redis is connected
    // Removed the redisRateLimitClient.status check since we're not using Redis anymore

    // Look for web-scraper-cache keys with pattern matching
    // Removed the redisRateLimitClient.keys call since we're not using Redis anymore
    const keys = [];

    // Get content for each key (limit to first 5 keys for performance)
    const results = [];
    for (const key of keys.slice(0, 5)) {
      // Removed the redisRateLimitClient.get call since we're not using Redis anymore
      const content = null;
      let parsedContent;
      try {
        parsedContent = JSON.parse(content);
        // Truncate the rawHtml to avoid overwhelming response
        if (parsedContent && parsedContent.rawHtml && parsedContent.rawHtml.length > 1000) {
          parsedContent.rawHtml = parsedContent.rawHtml.substring(0, 1000) + '... [truncated]';
        }
      } catch (e) {
        parsedContent = { error: 'Unable to parse JSON', content: content?.substring(0, 100) + '...' };
      }
      
      results.push({
        key,
        content: parsedContent
      });
    }

    return res.json({
      success: true,
      keyCount: keys.length,
      keys: keys.slice(0, 20), // Show first 20 keys
      sampleContent: results
    });
  } catch (error) {
    console.error('[REDIS-HEALTH] Error checking Redis content:', error);
    return res.status(500).json({
      success: false,
      message: 'Error checking Redis content',
      error: error.message
    });
  }
}
