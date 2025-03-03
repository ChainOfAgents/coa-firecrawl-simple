import axios from "axios";
import { generateRequestParams } from "../single_url";
import { universalTimeout } from "../global";
import { Logger } from "../../../lib/logger";
import { CloudAuth } from "../../../lib/cloud-auth";

/**
 * Scrapes a URL with Playwright
 * @param url The URL to scrape
 * @param waitFor The time to wait for the page to load
 * @param headers The headers to send with the request
 * @param pageOptions The options for the page
 * @returns The scraped content
 */
export async function scrapeWithPlaywright(
  url: string,
  waitFor: number = 0,
  headers?: Record<string, string>,
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  const startTime = Date.now();
  Logger.info(`🎭 [Playwright] Starting scrape for URL: ${url}`);
  
  try {
    Logger.debug(`🎭 [Playwright] Generating request parameters for ${url}`);
    const reqParams = await generateRequestParams(url);
    const waitParam = reqParams["params"]?.wait ?? waitFor;
    Logger.debug(`🎭 [Playwright] Wait parameter: ${waitParam}ms`);
    
    // Get authentication token
    Logger.debug(`🎭 [Playwright] Getting Cloud Auth token`);
    const idToken = await CloudAuth.getIdToken();
    const authHeader = idToken ? { "Authorization": `Bearer ${idToken}` } : {};
    Logger.debug(`🎭 [Playwright] Auth token ${idToken ? 'obtained' : 'not available'}`);

    Logger.info(`🎭 [Playwright] Making request to Puppeteer service for ${url}`);
    const response = await axios.post(
      process.env.PLAYWRIGHT_MICROSERVICE_URL,
      {
        url: url,
        wait_after_load: waitParam,
        headers: headers,
      },
      {
        headers: {
          "Content-Type": "application/json",
          ...authHeader
        },
        timeout: universalTimeout + waitParam,
        transformResponse: [(data) => data],
      }
    );
    Logger.info(`🎭 [Playwright] Received response from Puppeteer service: Status ${response.status}`);

    if (response.status !== 200) {
      Logger.error(
        `🎭 [Playwright] Failed response for ${url} | Status: ${response.status}, Error: ${response.data?.pageError}`
      );
      return {
        content: "",
        pageStatusCode: response.data?.pageStatusCode,
        pageError: response.data?.pageError,
      };
    }

    const textData = response.data;
    try {
      Logger.debug(`🎭 [Playwright] Parsing response data for ${url}`);
      const data = JSON.parse(textData);
      const html = data.content;
      
      const htmlLength = html ? html.length : 0;
      Logger.info(`🎭 [Playwright] Successfully parsed response for ${url}. HTML length: ${htmlLength} chars`);
      
      return {
        content: html ?? "",
        pageStatusCode: data.pageStatusCode,
        pageError: data.pageError,
      };
    } catch (jsonError) {
      Logger.error(
        `🎭 [Playwright] JSON parse error for ${url} | Error: ${jsonError.message}`
      );
      return {
        content: "",
        pageStatusCode: null,
        pageError: jsonError.message,
      };
    }
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      Logger.error(`🎭 [Playwright] Request timeout for ${url} after ${universalTimeout}ms`);
    } else {
      Logger.error(
        `🎭 [Playwright] Request failed for ${url} | Error: ${error.message}`
      );
    }
    return {
      content: "",
      pageStatusCode: null,
      pageError: error.message,
    };
  } finally {
    const duration = Date.now() - startTime;
    Logger.info(`🎭 [Playwright] Scraping completed for ${url} in ${duration}ms`);
  }
}
