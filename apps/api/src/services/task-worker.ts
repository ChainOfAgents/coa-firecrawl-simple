import express from 'express';
import { Logger } from '../lib/logger';
import { startWebScraperPipeline } from '../main/runWebScraper';
import { stateManager } from './state-management/firestore-state';
import { QueueJobData, QueueJobOptions, QueueJob } from './queue/types';
import { CloudTasksJob } from './queue/adapters/cloud-tasks-adapter';

const app = express();
const port = process.env.PORT || 3002; // Worker service port
const host = process.env.HOST || '0.0.0.0';

console.log(`Starting worker service on ${host}:${port}`);
Logger.info(`Starting worker service on ${host}:${port}`);
Logger.info(`Environment: ${process.env.NODE_ENV}`);
Logger.info(`Log level: ${process.env.LOGGING_LEVEL}`);
Logger.info(`Cloud Tasks Queue: ${process.env.CLOUD_TASKS_QUEUE}`);
Logger.info(`Cloud Tasks Service URL: ${process.env.CLOUD_TASKS_SERVICE_URL}`);

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  Logger.info('[WORKER] Health check');
  console.log('[WORKER] Health check');
  res.status(200).send('Worker is healthy');
});

// Task processing endpoint
app.post('/tasks/process', async (req, res) => {
  console.log(`[WORKER] Received task request: ${JSON.stringify({
    headers: req.headers,
    body: req.body
  }, null, 2)}`);
  
  Logger.info(`[WORKER] Received task request`);
  
  const taskName = req.header('X-CloudTasks-TaskName');
  const queueName = req.header('X-CloudTasks-QueueName');

  if (!taskName) {
    Logger.error('[WORKER] Missing task name in request');
    console.error('[WORKER] Missing task name in request');
    return res.status(400).send('Missing task name');
  }

  // Get the Cloud Tasks ID from the task name
  const cloudTasksId = taskName.split('/').pop()!;
  
  try {
    // Validate the request body
    const { name, data, options } = req.body;
    
    if (!data) {
      Logger.error(`[WORKER] Missing data in request for task ${cloudTasksId}`);
      console.error(`[WORKER] Missing data in request for task ${cloudTasksId}`);
      return res.status(400).json({ 
        success: false, 
        error: 'Missing data in request' 
      });
    }
    
    // Use the original job ID from the options, not the Cloud Tasks ID
    const jobId = options?.jobId || cloudTasksId;
    
    Logger.info(`[WORKER] Processing task ${jobId} (Cloud Tasks ID: ${cloudTasksId}) from queue ${queueName}`);
    console.log(`[WORKER] Processing task ${jobId} (Cloud Tasks ID: ${cloudTasksId}) from queue ${queueName}`);

    try {
      // Create a job instance with the required data
      const job: QueueJob = new CloudTasksJob(taskName, {
        ...data,
        name: name || 'default'
      }, {
        ...options,
        jobId
      });

      Logger.info(`[WORKER] Created job instance for ${jobId}`);
      console.log(`[WORKER] Created job instance for ${jobId}`);

      // Mark job as started
      try {
        await stateManager.markJobStarted(jobId);
        Logger.info(`[WORKER] Marked job ${jobId} as started`);
        console.log(`[WORKER] Marked job ${jobId} as started`);
      } catch (firestoreError) {
        // Log the error but continue with the job
        Logger.error(`[WORKER] Error marking job ${jobId} as started in Firestore: ${firestoreError}`);
        console.error(`[WORKER] Error marking job ${jobId} as started in Firestore: ${firestoreError}`);
        Logger.error(`[WORKER] Firestore error details: ${JSON.stringify(firestoreError)}`);
        console.error(`[WORKER] Firestore error details: ${JSON.stringify(firestoreError)}`);
        
        // Check if the job exists in Firestore
        try {
          const jobDoc = await stateManager.getJob(jobId);
          if (!jobDoc) {
            Logger.error(`[WORKER] Job ${jobId} does not exist in Firestore, creating it now`);
            // Create the job if it doesn't exist
            await stateManager.createJob(
              jobId,
              job.name,
              job.data,
              job.opts
            );
            // Try marking it as started again
            await stateManager.markJobStarted(jobId);
            Logger.info(`[WORKER] Created and marked job ${jobId} as started`);
          } else {
            Logger.info(`[WORKER] Job ${jobId} exists in Firestore with status: ${jobDoc.status}`);
          }
        } catch (checkError) {
          Logger.error(`[WORKER] Error checking job ${jobId} in Firestore: ${checkError}`);
        }
      }

      // Process the job
      Logger.info(`[WORKER] Starting web scraper pipeline for ${jobId}`);
      console.log(`[WORKER] Starting web scraper pipeline for ${jobId}`);
      
      let result;
      try {
        // Ensure the job has the correct jobId in its options
        if (job.opts.jobId !== jobId) {
          Logger.warn(`[WORKER] Job ID mismatch: ${job.opts.jobId} vs ${jobId}, updating job options`);
          job.opts.jobId = jobId;
        }
        
        result = await startWebScraperPipeline({ 
          job,
          token: jobId // Using jobId as token since we don't need BullMQ's token system
        });

        Logger.info(`[WORKER] Web scraper pipeline completed for ${jobId}: ${JSON.stringify(result)}`);
        console.log(`[WORKER] Web scraper pipeline completed for ${jobId}: ${JSON.stringify(result)}`);

        if (!result.success) {
          throw new Error(result.message || 'Job failed');
        }

        // Mark job as completed
        try {
          // Log the result size to help diagnose potential issues
          const resultSize = JSON.stringify(result).length;
          Logger.info(`[WORKER] Result size for job ${jobId}: ${resultSize} bytes`);
          
          await stateManager.markJobCompleted(jobId, result);
          Logger.info(`[WORKER] Marked job ${jobId} as completed`);
          console.log(`[WORKER] Marked job ${jobId} as completed`);
        } catch (firestoreError) {
          // Log the error but continue with the job
          Logger.error(`[WORKER] Error marking job ${jobId} as completed in Firestore: ${firestoreError}`);
          console.error(`[WORKER] Error marking job ${jobId} as completed in Firestore: ${firestoreError}`);
          Logger.error(`[WORKER] Firestore error details: ${JSON.stringify(firestoreError)}`);
          console.error(`[WORKER] Firestore error details: ${JSON.stringify(firestoreError)}`);
          
          // Try again with a simplified result
          try {
            const simplifiedResult = {
              success: result.success,
              message: result.message || 'Job completed successfully',
              simplifiedResult: true
            };
            
            Logger.info(`[WORKER] Trying again with simplified result for job ${jobId}`);
            await stateManager.markJobCompleted(jobId, simplifiedResult);
            Logger.info(`[WORKER] Successfully marked job ${jobId} as completed with simplified result`);
          } catch (retryError) {
            Logger.error(`[WORKER] Failed to mark job ${jobId} as completed even with simplified result: ${retryError}`);
          }
        }

        // Respond with success
        res.status(200).json({ success: true, jobId });
      } catch (error) {
        Logger.error(`[WORKER] Error processing task ${jobId}: ${error}`);
        console.error(`[WORKER] Error processing task ${jobId}: ${error}`);
        
        // Mark job as failed
        try {
          await stateManager.markJobFailed(jobId, error);
          Logger.info(`[WORKER] Marked job ${jobId} as failed`);
          console.log(`[WORKER] Marked job ${jobId} as failed`);
        } catch (firestoreError) {
          // Log the error but continue with the job
          Logger.error(`[WORKER] Error marking job ${jobId} as failed in Firestore: ${firestoreError}`);
          console.error(`[WORKER] Error marking job ${jobId} as failed in Firestore: ${firestoreError}`);
        }

        // Still return 200 to acknowledge the task
        // Cloud Tasks will not retry if we return 200
        res.status(200).json({ 
          success: false, 
          jobId,
          error: error.message 
        });
      }
    } catch (error) {
      // This catches errors in parsing the request body or other setup issues
      Logger.error(`[WORKER] Error handling task ${cloudTasksId}: ${error}`);
      console.error(`[WORKER] Error handling task ${cloudTasksId}: ${error}`);
      
      // Return 200 to acknowledge the task but indicate failure
      res.status(200).json({ 
        success: false, 
        error: `Error handling task: ${error.message}` 
      });
    }
  } catch (error) {
    // This catches errors in parsing the request body or other setup issues
    Logger.error(`[WORKER] Error handling task ${cloudTasksId}: ${error}`);
    console.error(`[WORKER] Error handling task ${cloudTasksId}: ${error}`);
    
    // Return 200 to acknowledge the task but indicate failure
    res.status(200).json({ 
      success: false, 
      error: `Error handling task: ${error.message}` 
    });
  }
});

// Add a test endpoint to simulate receiving a task
app.post('/test/task', async (req, res) => {
  Logger.info('[WORKER] Received test task request');
  console.log('[WORKER] Received test task request');
  
  try {
    // Create a mock task name
    const mockTaskName = `projects/test-project/locations/us-west2/queues/test-queue/tasks/test-task-${Date.now()}`;
    
    // Extract data from request or use defaults
    const { name = 'test-job', url = 'https://example.com', jobId = `test-${Date.now()}` } = req.body;
    
    // Log the mock task
    Logger.info(`[WORKER] Processing mock task ${jobId} with name ${name} and URL ${url}`);
    console.log(`[WORKER] Processing mock task ${jobId} with name ${name} and URL ${url}`);
    
    // Create a job instance with the test data
    const job = new CloudTasksJob(
      mockTaskName,
      { url, name },
      { jobId }
    );
    
    // Mark job as started
    try {
      await stateManager.markJobStarted(jobId);
      Logger.info(`[WORKER] Marked test job ${jobId} as started`);
    } catch (firestoreError) {
      // Log the error but continue with the job
      Logger.error(`[WORKER] Error marking test job ${jobId} as started in Firestore: ${firestoreError}`);
      console.error(`[WORKER] Error marking test job ${jobId} as started in Firestore: ${firestoreError}`);
      Logger.error(`[WORKER] Firestore error details: ${JSON.stringify(firestoreError)}`);
      console.error(`[WORKER] Firestore error details: ${JSON.stringify(firestoreError)}`);
      
      // Check if the job exists in Firestore
      try {
        const jobDoc = await stateManager.getJob(jobId);
        if (!jobDoc) {
          Logger.error(`[WORKER] Job ${jobId} does not exist in Firestore, creating it now`);
          // Create the job if it doesn't exist
          await stateManager.createJob(
            jobId,
            job.name,
            job.data,
            job.opts
          );
          // Try marking it as started again
          await stateManager.markJobStarted(jobId);
          Logger.info(`[WORKER] Created and marked job ${jobId} as started`);
        } else {
          Logger.info(`[WORKER] Job ${jobId} exists in Firestore with status: ${jobDoc.status}`);
        }
      } catch (checkError) {
        Logger.error(`[WORKER] Error checking job ${jobId} in Firestore: ${checkError}`);
      }
    }

    // Simulate processing (without actually running the scraper)
    Logger.info(`[WORKER] Simulating processing for test job ${jobId}`);
    
    // Mark job as completed with mock result
    const mockResult = {
      success: true,
      message: 'Test job completed successfully',
      data: { testData: 'This is test data' }
    };
    
    try {
      await stateManager.markJobCompleted(jobId, mockResult);
      Logger.info(`[WORKER] Marked test job ${jobId} as completed`);
    } catch (firestoreError) {
      // Log the error but continue with the job
      Logger.error(`[WORKER] Error marking test job ${jobId} as completed in Firestore: ${firestoreError}`);
      console.error(`[WORKER] Error marking test job ${jobId} as completed in Firestore: ${firestoreError}`);
    }

    // Respond with success
    res.status(200).json({ 
      success: true, 
      jobId,
      message: 'Test task processed successfully',
      result: mockResult
    });
  } catch (error) {
    Logger.error(`[WORKER] Error processing test task: ${error}`);
    console.error(`[WORKER] Error processing test task: ${error}`);
    
    res.status(500).json({ 
      success: false, 
      error: `Error processing test task: ${error.message}` 
    });
  }
});

// Start the server
app.listen(Number(port), host, () => {
  Logger.info(`Worker service listening on port ${port}`);
  console.log(`Worker service listening on port ${port}`);
});
