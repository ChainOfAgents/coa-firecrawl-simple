import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../lib/logger';
import { stateManager } from '../services/state-management/firestore-state';

// Set up logging
console.log('Setting up logging...');
async function testJobStatusFlow() {
  try {
    // Generate a unique job ID
    const jobId = uuidv4();
    console.log(`Testing job status flow with job ID: ${jobId}`);
    
    // Step 1: Create a job (status: waiting)
    console.log('Step 1: Creating job (status: waiting)');
    await stateManager.createJob(
      jobId,
      'test-job',
      {
        url: 'https://example.com',
        mode: 'single_urls',
        team_id: 'system',
        is_scrape: true,
      },
      {
        priority: 10,
        jobId,
      }
    );
    
    // Verify job was created with status 'waiting'
    let job = await stateManager.getJob(jobId);
    console.log(`Job created with status: ${job?.status}`);
    
    // Step 2: Mark job as started (status: active)
    console.log('Step 2: Marking job as started (status: active)');
    await stateManager.markJobStarted(jobId);
    
    // Verify job status is 'active'
    job = await stateManager.getJob(jobId);
    console.log(`Job status after markJobStarted: ${job?.status}`);
    
    // Step 3: Mark job as completed (status: completed)
    console.log('Step 3: Marking job as completed (status: completed)');
    await stateManager.markJobCompleted(jobId, {
      success: true,
      message: 'Job completed successfully',
      docs: [
        {
          url: 'https://example.com',
          title: 'Example Domain',
          hasContent: true,
          contentLength: 1000,
        }
      ]
    });
    
    // Verify job status is 'completed'
    job = await stateManager.getJob(jobId);
    console.log(`Job status after markJobCompleted: ${job?.status}`);
    console.log(`Job result: ${JSON.stringify(job?.result, null, 2)}`);
    
    console.log('Job status flow test completed successfully!');
    return jobId;
  } catch (error) {
    console.error('Error in job status flow test:', error);
    throw error;
  }
}

// Run the test
testJobStatusFlow().catch(console.error);
