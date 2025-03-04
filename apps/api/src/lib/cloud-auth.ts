import axios from "axios";
import { exec } from "child_process";
import { promisify } from "util";
import { Logger } from "./logger";

const execPromise = promisify(exec);

/**
 * Utility functions for Google Cloud authentication
 */
export class CloudAuth {
  /**
   * Gets an ID token for authenticating with Google Cloud Run services
   * @param audience The audience (target service URL)
   * @returns A Google Cloud ID token
   */
  static async getIdToken(audience?: string): Promise<string> {
    try {
      // For local development, use gcloud CLI
      if (process.env.NODE_ENV !== 'production') {
        try {
          const { stdout } = await execPromise('gcloud auth print-identity-token');
          return stdout.trim();
        } catch (error) {
          Logger.warn(`Failed to get local ID token: ${error}. Will try metadata server.`);
        }
      }
      
      // For production (Cloud Run), use metadata server
      const targetAudience = audience || process.env.PLAYWRIGHT_MICROSERVICE_URL || '';
      
      try {
        // Increase timeout to 15 seconds
        const response = await axios.get(
          `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(targetAudience)}`,
          {
            headers: {
              'Metadata-Flavor': 'Google'
            },
            timeout: 15000 // Increased timeout from 5000ms to 15000ms
          }
        );
        return response.data;
      } catch (metadataError) {
        Logger.error(`Failed to get ID token from metadata server: ${metadataError}`);
        
        // If the puppeteer service allows unauthenticated access, we can proceed without a token
        if (process.env.PLAYWRIGHT_MICROSERVICE_URL) {
          Logger.warn(`Proceeding without authentication token. This is only acceptable if the puppeteer service allows unauthenticated access.`);
          return '';
        }
        
        throw metadataError;
      }
    } catch (error) {
      Logger.error(`Failed to get ID token: ${error}`);
      return '';
    }
  }
}
