import { CloudTasksClient } from '@google-cloud/tasks';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../lib/logger';
import { stateManager } from '../services/state-management/firestore-state';

// Set up logging
console.log('Setting up logging...');

// Cloud Tasks configuration
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const location = process.env.CLOUD_TASKS_LOCATION || 'us-west2';
const queueId = process.env.CLOUD_TASKS_QUEUE || 'crawlweb-tasks-queue';
const serviceUrl = process.env.CLOUD_TASKS_SERVICE_URL;
const serviceAccountEmail = process.env.CLOUD_TASKS_SERVICE_ACCOUNT_EMAIL;

if (!projectId || !serviceUrl) {
  throw new Error('Missing required environment variables: GOOGLE_CLOUD_PROJECT, CLOUD_TASKS_SERVICE_URL');
}

// Initialize Cloud Tasks client
const client = new CloudTasksClient();

async function createTask() {
  try {
    console.log('Creating Cloud Task...');
    console.log(`Project ID: ${projectId}`);
    console.log(`Queue ID: ${queueId}`);
    console.log(`Service URL: ${serviceUrl}`);
    
    // Generate a unique job ID
    const jobId = uuidv4();
    console.log(`Generated job ID: ${jobId}`);
    
    // Create a job in Firestore first
    await stateManager.createJob(
      jobId,
      jobId, // Using jobId as name for simplicity
      {
        url: 'https://agentman.ai',
        mode: 'single_urls',
        team_id: 'system',
        is_scrape: true,
        origin: 'api',
        pageOptions: {
          includeRawHtml: true,
          includeMarkdown: false,
          screenshot: false,
          waitFor: 0,
        },
      },
      {
        priority: 10,
        jobId,
      }
    );
    console.log(`Created job in Firestore: ${jobId}`);
    
    // Construct the fully qualified queue name
    const parent = client.queuePath(projectId, location, queueId);
    console.log(`Queue path: ${parent}`);
    
    // Build the task
    const task = {
      httpRequest: {
        httpMethod: 'POST' as const,
        url: `${serviceUrl}/tasks/process`,
        headers: {
          'Content-Type': 'application/json',
        },
        body: Buffer.from(
          JSON.stringify({
            name: jobId,
            data: {
              url: 'https://agentman.ai',
              mode: 'single_urls',
              team_id: 'system',
              is_scrape: true,
              origin: 'api',
              pageOptions: {
                includeRawHtml: true,
                includeMarkdown: false,
                screenshot: false,
                waitFor: 0,
              },
            },
            options: {
              priority: 10,
              jobId,
            },
          })
        ).toString('base64'),
        oidcToken: serviceAccountEmail ? {
          serviceAccountEmail,
        } : undefined,
      },
    };
    
    console.log(`Creating task: ${JSON.stringify(task, null, 2)}`);
    
    // Send create task request
    const response = await client.createTask({ parent, task });
    console.log(`Created task: ${response[0].name}`);
    console.log('Task details:', JSON.stringify(response[0], null, 2));
    
    console.log('Cloud Task created successfully!');
    console.log(`Check the Firestore document for job ID: ${jobId}`);
    
    return jobId;
  } catch (error) {
    console.error('Error creating Cloud Task:', error);
    throw error;
  }
}

// Run the function
createTask().catch(console.error);
