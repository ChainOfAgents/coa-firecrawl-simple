import { QueueProvider } from './types';
import { CloudTasksAdapter } from './adapters/cloud-tasks-adapter';

export function getQueueProvider(queueName: string): QueueProvider {
  // Always use Cloud Tasks
  return new CloudTasksAdapter(queueName);
}

// Export a default instance for the scrape queue
export const scrapeQueueProvider = getQueueProvider('scrapeQueue');
