import { Logger } from '../lib/logger';
import { stateManager } from '../services/state-management/firestore-state';

// Set up logging
console.log('Setting up logging...');
Logger.setLevel('debug');

// Job ID to update - replace with an actual job ID from your Firestore
const jobId = '0232ceaa-d5c8-4024-9a64-c5692d6db378';

async function testUpdateJob() {
  try {
    console.log(`Testing job status update for job: ${jobId}`);
    
    // First, mark the job as started
    console.log('Marking job as started...');
    await stateManager.markJobStarted(jobId);
    console.log('Job marked as started successfully');
    
    // Then, create a mock result
    const mockResult = {
      success: true,
      message: 'Job completed successfully',
      data: {
        url: 'https://agentman.ai',
        content: 'Test content',
        timestamp: new Date().toISOString()
      }
    };
    
    // Mark the job as completed
    console.log('Marking job as completed...');
    await stateManager.markJobCompleted(jobId, mockResult);
    console.log('Job marked as completed successfully');
    
    console.log('Test completed successfully!');
  } catch (error) {
    console.error('Error updating job:', error);
  }
}

// Run the test
testUpdateJob().catch(console.error);
