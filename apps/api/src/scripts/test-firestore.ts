import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../lib/logger';
import { stateManager } from '../services/state-management/firestore-state';

// Set up logging
console.log('Setting up logging...');
async function testFirestore() {
  try {
    console.log('Testing Firestore integration...');
    
    // Generate a unique job ID
    const jobId = uuidv4();
    console.log(`Created test job ID: ${jobId}`);
    
    // Create a job in Firestore
    await stateManager.createJob(
      jobId,
      'test-job',
      {
        url: 'https://example.com',
        mode: 'single_urls',
        team_id: 'system',
      },
      {
        priority: 10,
        jobId,
      }
    );
    console.log(`Created job in Firestore: ${jobId}`);
    
    // Mark job as started
    await stateManager.markJobStarted(jobId);
    console.log(`Marked job as started: ${jobId}`);
    
    // Update job progress
    await stateManager.updateJobProgress(jobId, { progress: 50 });
    console.log(`Updated job progress: ${jobId}`);
    
    // Mark job as completed
    await stateManager.markJobCompleted(jobId, {
      success: true,
      message: 'Job completed successfully',
      data: {
        url: 'https://example.com',
        content: 'Test content',
      },
    });
    console.log(`Marked job as completed: ${jobId}`);
    
    console.log('Firestore test completed successfully!');
  } catch (error) {
    console.error('Error testing Firestore:', error);
  }
}

// Run the test
testFirestore().catch(console.error);
