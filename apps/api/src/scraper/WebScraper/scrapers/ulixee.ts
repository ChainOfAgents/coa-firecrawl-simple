import axios from "axios";
import { universalTimeout } from "../global";
import { Logger } from "../../../lib/logger";

/**
 * Scrapes a URL with Ulixee microservice
 * @param url The URL to scrape
 * @param waitFor Optional wait time in milliseconds
 * @param headers Optional headers to send with the request
 * @returns The scraped content
 */
export async function scrapeWithUlixee(
  url: string,
  waitFor?: number,
  headers?: Record<string, string>
): Promise<{ content: string; pageStatusCode?: number; pageError?: string }> {
  const logParams = {
    url,
    scraper: "ulixee",
    success: false,
    response_code: null,
    time_taken_seconds: null,
    error_message: null,
    html: "",
    startTime: Date.now(),
  };

  if (!process.env.ULIXEE_MICROSERVICE_URL) {
    Logger.error("Ulixee: ULIXEE_MICROSERVICE_URL not set");
    return {
      content: "",
      pageStatusCode: null,
      pageError: "ULIXEE_MICROSERVICE_URL not set",
    };
  }

  try {
    const response = await axios.post(
      process.env.ULIXEE_MICROSERVICE_URL,
      {
        url,
        waitFor: waitFor || 0,
        headers: headers || {},
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: universalTimeout,
      }
    );

    if (response.status !== 200) {
      Logger.error(
        `Ulixee: Failed to fetch url: ${url} with status: ${response.status}`
      );
      logParams.error_message = response.statusText;
      logParams.response_code = response.status;
      return {
        content: "",
        pageStatusCode: response.status,
        pageError: response.statusText,
      };
    }

    const { html, statusCode, error } = response.data;
    logParams.success = !error;
    logParams.html = html || "";
    logParams.response_code = statusCode;
    
    return { 
      content: html || "", 
      pageStatusCode: statusCode, 
      pageError: error || null 
    };
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      logParams.error_message = "Request timed out";
      Logger.error(`Ulixee: Request timed out for ${url} after ${universalTimeout}ms`);
    } else {
      logParams.error_message = error.message || error;
      Logger.error(`Ulixee: Failed to fetch url: ${url} | Error: ${error}`);
    }
    return {
      content: "",
      pageStatusCode: null,
      pageError: logParams.error_message,
    };
  } finally {
    const endTime = Date.now();
    logParams.time_taken_seconds = (endTime - logParams.startTime) / 1000;
  }
}
