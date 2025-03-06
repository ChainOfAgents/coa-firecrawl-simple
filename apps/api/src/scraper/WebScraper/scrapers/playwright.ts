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

    const idToken = await CloudAuth.getIdToken();
    const authHeader = idToken ? { "Authorization": `Bearer ${idToken}` } : {};

    const response = await axios.post(
      process.env.PLAYWRIGHT_MICROSERVICE_URL,
      {
        url: url,
        additionalWaitTime: waitParam,
        timeout: universalTimeout,
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
      // Handle different response formats from the Ulixee service
      // The Ulixee service returns html in the 'html' field, not 'content'
      const html = data.content || data.html || "";
      const pageStatusCode = data.pageStatusCode || data.status || 200;
      const pageError = data.pageError || data.error || "";

      if (pageError) {
        Logger.warn(`Page error for ${url}: ${pageError}`);
      }

      return {
        content: html,
        pageStatusCode,
        pageError,
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
