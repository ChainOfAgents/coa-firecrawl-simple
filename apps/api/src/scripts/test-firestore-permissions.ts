import { Firestore } from '@google-cloud/firestore';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from '../lib/logger';

// Set up logging
console.log('Setting up logging...');
// Get project ID from environment
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) {
  throw new Error('GOOGLE_CLOUD_PROJECT environment variable is required');
}

async function testFirestorePermissions() {
  try {
    console.log(`Testing Firestore permissions for project: ${projectId}`);
    
    // Initialize Firestore
    console.log('Initializing Firestore...');
    const db = new Firestore({
      projectId,
      ignoreUndefinedProperties: true,
    });
    console.log('Firestore initialized successfully');
    
    // Test collection access
    console.log('Testing collection access...');
    const jobsCollection = db.collection('jobs');
    const snapshot = await jobsCollection.limit(1).get();
    console.log(`Successfully accessed jobs collection, found ${snapshot.size} documents`);
    
    // Test document creation
    console.log('Testing document creation...');
    const testDocRef = jobsCollection.doc('test-permissions-' + Date.now());
    await testDocRef.set({
      id: testDocRef.id,
      test: true,
      createdAt: new Date(),
    });
    console.log(`Successfully created test document: ${testDocRef.id}`);
    
    // Test document update
    console.log('Testing document update...');
    await testDocRef.update({
      updatedAt: new Date(),
      status: 'test-update',
    });
    console.log(`Successfully updated test document: ${testDocRef.id}`);
    
    // Test document deletion
    console.log('Testing document deletion...');
    await testDocRef.delete();
    console.log(`Successfully deleted test document: ${testDocRef.id}`);
    
    console.log('All Firestore permission tests passed successfully!');
  } catch (error) {
    console.error('Error testing Firestore permissions:', error);
  }
}

// Run the test
testFirestorePermissions().catch(console.error);
