const IORedis = require('ioredis');
const { Queue } = require('bullmq');

// Get Redis URL from environment or command line
const redisUrl = process.env.REDIS_URL || process.argv[2] || 'redis://localhost:6379';

// Create a diagnostic job that will be easy to identify
const testJobData = {
  test: true,
  timestamp: new Date().toISOString(),
  message: 'Diagnostic test job'
};

async function testRedisConnection() {
  console.log(`Testing Redis connection to ${redisUrl}...`);
  
  try {
    // Test basic Redis connection
    const redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
    });
    
    // Ping Redis
    const pingResult = await redis.ping();
    console.log(`Redis ping result: ${pingResult}`);
    
    // Try to set and get a key
    await redis.set('test-key', 'test-value');
    const value = await redis.get('test-key');
    console.log(`Redis set/get test: ${value === 'test-value' ? 'SUCCESS' : 'FAILED'}`);
    
    // Create a test queue
    const testQueue = new Queue('diagnostic-test-queue', {
      connection: redis,
    });
    
    // Add a job to the queue
    console.log('Adding test job to queue...');
    const job = await testQueue.add('diagnostic', testJobData);
    console.log(`Test job added with ID: ${job.id}`);
    
    // Get the job from the queue to verify it was added
    const fetchedJob = await testQueue.getJob(job.id);
    console.log(`Fetched job data: ${JSON.stringify(fetchedJob.data)}`);
    
    // Clean up
    await fetchedJob.remove();
    await redis.del('test-key');
    await testQueue.close();
    await redis.quit();
    
    console.log('Redis connection and queue tests completed successfully!');
    return true;
  } catch (error) {
    console.error(`Error testing Redis: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

testRedisConnection()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
  });
