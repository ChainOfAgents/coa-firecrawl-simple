import { Request, Response } from "express";
import Redis, { RedisOptions } from "ioredis";
import { Logger } from "../../../lib/logger";
import { redisRateLimitClient } from "../../../services/rate-limiter";

export async function redisHealthController(req: Request, res: Response) {
  // Skip Redis health check if using Cloud Tasks
  if (process.env.QUEUE_PROVIDER === 'cloud-tasks') {
    Logger.info('[REDIS-HEALTH] Using Cloud Tasks, skipping Redis health check');
    return res.status(200).json({ status: "healthy", details: { message: "Using Cloud Tasks, Redis not required" } });
  }

  const retryOperation = async (operation, retries = 3) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt === retries) throw error;
        Logger.warn(`Attempt ${attempt} failed: ${error.message}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
      }
    }
  };

  try {
    // Use Redis URL from environment
    if (process.env.QUEUE_PROVIDER !== 'bull') {
      return res.status(200).send('OK');
    }
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }
    Logger.info(`[REDIS-HEALTH] Using Redis URL from environment`);
    
    const redisOptions: RedisOptions = {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy(times) {
        const delay = Math.min(times * 200, 2000);
        return delay;
      },
      reconnectOnError(err) {
        const targetError = 'READONLY';
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      }
    };
    
    // Add GCP-specific settings that aren't in the type definition
    const queueRedis = new Redis(redisUrl, {
      ...redisOptions,
      // These options aren't in the type definition but are needed for GCP Redis
      disableClientSetname: true, // Prevents 'client setname' command from being sent
      clientName: '', // Sets an empty client name
      username: '', // Disable client name setting
      keyPrefix: '', // Disable key prefix
      enableAutoPipelining: false // Disables auto pipelining
    } as any); // Type assertion needed for custom Redis options

    const testKey = "test";
    const testValue = "test";

    // Test queueRedis
    let queueRedisHealth;
    try {
      await retryOperation(() => queueRedis.set(testKey, testValue));
      queueRedisHealth = await retryOperation(() => queueRedis.get(testKey));
      await retryOperation(() => queueRedis.del(testKey));
    } catch (error) {
      Logger.error(`[REDIS-HEALTH] queueRedis health check failed: ${error}`);
      queueRedisHealth = null;
    }

    // Test redisRateLimitClient
    let redisRateLimitHealth;
    try {
      await retryOperation(() => redisRateLimitClient.set(testKey, testValue));
      redisRateLimitHealth = await retryOperation(() =>
        redisRateLimitClient.get(testKey)
      );
      await retryOperation(() => redisRateLimitClient.del(testKey));
    } catch (error) {
      Logger.error(`[REDIS-HEALTH] redisRateLimitClient health check failed: ${error}`);
      redisRateLimitHealth = null;
    }

    const healthStatus = {
      queueRedis: queueRedisHealth === testValue ? "healthy" : "unhealthy",
      redisRateLimitClient:
        redisRateLimitHealth === testValue ? "healthy" : "unhealthy",
    };

    if (
      healthStatus.queueRedis === "healthy" &&
      healthStatus.redisRateLimitClient === "healthy"
    ) {
      Logger.info("[REDIS-HEALTH] Both Redis instances are healthy");
      return res.status(200).json({ status: "healthy", details: healthStatus });
    } else {
      Logger.info(
        `[REDIS-HEALTH] Redis instances health check: ${JSON.stringify(healthStatus)}`
      );
      return res
        .status(500)
        .json({ status: "unhealthy", details: healthStatus });
    }
  } catch (error) {
    Logger.error(`[REDIS-HEALTH] Redis health check failed: ${error}`);
    return res
      .status(500)
      .json({ status: "unhealthy", message: error.message });
  }
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
    if (redisRateLimitClient.status !== 'ready') {
      return res.status(500).json({
        success: false,
        message: 'Redis client is not ready',
        redisStatus: redisRateLimitClient.status
      });
    }

    // Look for web-scraper-cache keys with pattern matching
    const keys = await redisRateLimitClient.keys('web-scraper-cache:*');
    
    // Get content for each key (limit to first 5 keys for performance)
    const results = [];
    for (const key of keys.slice(0, 5)) {
      const content = await redisRateLimitClient.get(key);
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
