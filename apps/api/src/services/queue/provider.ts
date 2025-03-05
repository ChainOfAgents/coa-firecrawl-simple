import { QueueProvider } from './types';
import { BullAdapter } from './adapters/bull-adapter';
import { CloudTasksAdapter } from './adapters/cloud-tasks-adapter';

export function getQueueProvider(queueName: string): QueueProvider {
  const provider = process.env.QUEUE_PROVIDER || 'bull';
  
  switch (provider.toLowerCase()) {
    case 'cloud-tasks':
      return new CloudTasksAdapter(queueName);
    case 'bull':
    default:
      return new BullAdapter(queueName);
  }
}

// Export a default instance for the scrape queue
export const scrapeQueueProvider = getQueueProvider('scrapeQueue');
