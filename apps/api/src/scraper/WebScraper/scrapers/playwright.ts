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
 * @returns The scraped content
 */
export async function scrapeWithPlaywright(
  url: string,
  waitFor: number = 0,
  headers?: Record<string, string>,
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  try {
    const reqParams = await generateRequestParams(url);
    const waitParam = reqParams["params"]?.wait ?? waitFor;

    // Get authentication token
    let idToken;
    try {
      idToken = await CloudAuth.getIdToken();
    } catch (authError) {
      Logger.error(`Failed to get authentication token: ${authError.message}`);
      idToken = null;
    }
    // Only add Authorization header if we have a token
    const authHeader = idToken ? { "Authorization": `Bearer ${idToken}` } : {};
    
    Logger.debug(`Calling puppeteer service for URL: ${url}`);
    Logger.debug(`Using authentication: ${idToken ? 'Yes' : 'No'}`);
    
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

    if (response.status !== 200) {
      Logger.error(
        `Failed response for ${url} | Status: ${response.status}, Error: ${response.data?.pageError}`
      );
      return {
        content: "",
        pageStatusCode: response.data?.pageStatusCode,
        pageError: response.data?.pageError,
      };
    }

    const textData = response.data;
    try {
      const data = JSON.parse(textData);
      const html = data.content;

      return {
        content: html ?? "",
        pageStatusCode: data.pageStatusCode,
        pageError: data.pageError,
      };
    } catch (jsonError) {
      Logger.error(
        `JSON parse error for ${url} | Error: ${jsonError.message}`
      );
      return {
        content: "",
        pageStatusCode: null,
        pageError: jsonError.message,
      };
    }
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      Logger.error(`Request timeout for ${url} after ${universalTimeout}ms`);
    } else {
      Logger.error(
        `Request failed for ${url} | Error: ${error.message}`
      );
    }
    return {
      content: "",
      pageStatusCode: null,
      pageError: error.message,
    };
  }
}
