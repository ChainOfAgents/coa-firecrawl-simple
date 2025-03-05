import express from 'express';
import { Logger } from '../lib/logger';
import { startWebScraperPipeline } from '../main/runWebScraper';
import { stateManager } from './state-management/firestore-state';
import { QueueJobData, QueueJobOptions, QueueJob } from './queue/types';
import { CloudTasksJob } from './queue/adapters/cloud-tasks-adapter';

const app = express();
const port = process.env.PORT || 3002; // Worker service port
const host = process.env.HOST || '0.0.0.0';

// Parse JSON bodies
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Worker is healthy');
});

// Task processing endpoint
app.post('/tasks/process', async (req, res) => {
  const { name, data, options } = req.body;
  const taskName = req.header('X-CloudTasks-TaskName');
  const queueName = req.header('X-CloudTasks-QueueName');

  if (!taskName) {
    Logger.error('[WORKER] Missing task name in request');
    return res.status(400).send('Missing task name');
  }

  const jobId = taskName.split('/').pop()!;
  Logger.info(`[WORKER] Processing task ${jobId} from queue ${queueName}`);

  try {
    // Create a job instance with the required data
    const job: QueueJob = new CloudTasksJob(taskName, {
      ...data,
      name: name || 'default'
    }, {
      ...options,
      jobId
    });

    // Mark job as started
    await stateManager.markJobStarted(jobId);

    // Process the job
    const result = await startWebScraperPipeline({ 
      job,
      token: jobId // Using jobId as token since we don't need BullMQ's token system
    });

    if (!result.success) {
      throw new Error(result.message || 'Job failed');
    }

    // Mark job as completed
    await stateManager.markJobCompleted(jobId, result);

    // Respond with success
    res.status(200).json({ success: true, jobId });
  } catch (error) {
    Logger.error(`[WORKER] Error processing task ${jobId}: ${error}`);
    
    // Mark job as failed
    await stateManager.markJobFailed(jobId, error);

    // Still return 200 to acknowledge the task
    // Cloud Tasks will not retry if we return 200
    res.status(200).json({ 
      success: false, 
      jobId,
      error: error.message 
    });
  }
});

// Start the server
app.listen(Number(port), host, () => {
  Logger.info(`Worker service listening on port ${port}`);
});
