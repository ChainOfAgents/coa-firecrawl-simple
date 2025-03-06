import express from "express";
import type { Request, Response } from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import Hero, { Resource, WebsocketResource } from "@ulixee/hero";
import HeroCore from "@ulixee/hero-core";
import { TransportBridge } from "@ulixee/net";
import { ConnectionToHeroCore } from "@ulixee/hero";
import { URL } from "url";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

dotenv.config();

// Performance optimization: Create a pool of Hero instances
const HERO_POOL_SIZE = process.env.HERO_MAX_CONCURRENT_BROWSERS ? parseInt(process.env.HERO_MAX_CONCURRENT_BROWSERS) : 5;
const heroPool: Hero[] = [];
let busyHeroes = 0;
let isPoolInitialized = false;

// Setup Ulixee Hero Core
const core = new HeroCore();
const bridge = new TransportBridge();
core.addConnection(bridge.transportToCore);
const connectionToCore = new ConnectionToHeroCore(bridge.transportToClient);

// Configure proxy
const proxyUrl = process.env.PROXY_URL || '';
const proxyUsername = process.env.PROXY_USERNAME || '';
const proxyPassword = process.env.PROXY_PASSWORD || '';

if (proxyUrl && proxyUsername && proxyPassword) {
  const proxyUrlObj = new URL(proxyUrl);
  proxyUrlObj.username = proxyUsername;
  proxyUrlObj.password = proxyPassword;
  process.env.PROXY_URL = proxyUrlObj.toString();
}

// Get Chrome path from environment or use default
const chromePath = process.env.CHROME_PATH || '';
const noChromeSandbox = process.env.CHROME_SANDBOX === 'false';

console.log(`Chrome path: ${chromePath || 'Using default'}`);
console.log(`Chrome sandbox disabled: ${noChromeSandbox}`);

const app = express();
// Use the PORT environment variable provided by Cloud Run
const port = process.env.PORT || 8080;
console.log(`Starting server on port ${port}`);

app.use(bodyParser.json());

// Initialize the hero pool
const initializeHeroPool = async (): Promise<void> => {
  if (isPoolInitialized) {
    console.log("Hero pool already initialized");
    return;
  }
  
  console.log(`Initializing hero pool with ${HERO_POOL_SIZE} instances`);
  
  try {
    // Create initial instances - start with more instances to pre-warm the pool
    const initialSize = Math.min(HERO_POOL_SIZE, 5); // Increased from 2 to 5 for better pre-warming
    const promises = [];
    
    for (let i = 0; i < initialSize; i++) {
      promises.push(createHeroInstance());
    }
    
    await Promise.all(promises);
    isPoolInitialized = true;
    console.log(`Hero pool initialized with ${heroPool.length} instances`);
    
    // Set up periodic cleanup to prevent memory leaks
    setInterval(() => {
      console.log(`Running pool maintenance. Current pool size: ${heroPool.length}`);
      // Remove any stale instances that might be causing memory leaks
      if (heroPool.length > 0) {
        const instance = heroPool.pop();
        if (instance) {
          instance.close().catch(e => console.error('Error closing hero during maintenance:', e));
          // Create a fresh instance to replace it
          createHeroInstance().catch(e => console.error('Failed to create replacement hero during maintenance:', e));
        }
      }
    }, 30 * 60 * 1000); // Run every 30 minutes
  } catch (error) {
    console.error("Error initializing hero pool:", error);
    throw error;
  }
};

// Get a hero instance from the pool or create a new one
async function getHeroInstance(proxy_url?: string): Promise<{ hero: Hero; release: () => void }> {
  // Make sure the pool is initialized
  if (!isPoolInitialized) {
    await initializeHeroPool();
  }
  
  try {
    console.log(`Getting Hero instance. Pool size: ${heroPool.length}, Busy: ${busyHeroes}`);
    
    // First try to get from the pool
    if (heroPool.length > 0) {
      const hero = heroPool.pop()!;
      busyHeroes += 1;
      
      return {
        hero,
        release: () => {
          try {
            // Check if the hero is still connected - use a try/catch since we don't know the exact API
            try {
              // Try to access a property or method to see if it's still alive
              hero.sessionId;
              heroPool.push(hero);
            } catch (e) {
              console.log('Hero instance disconnected, not returning to pool');
              // Create a new instance to replace it
              createHeroInstance().catch(e => console.error('Failed to create replacement hero:', e));
            }
          } catch (error) {
            console.error('Error releasing hero:', error);
          } finally {
            busyHeroes -= 1;
          }
        }
      };
    }
    
    // If no instances in the pool and we're at max capacity, wait for one to be released
    if (busyHeroes >= HERO_POOL_SIZE) {
      console.log('Waiting for a hero instance to be released...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getHeroInstance(proxy_url);
    }
    
    // Otherwise create a new instance
    console.log('Creating new Hero instance');
    busyHeroes += 1;
    
    // Create hero with proxy if provided
    let hero: Hero;
    
    const heroOptions: any = {
      connectionToCore,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/109.0",
      upstreamProxyUrl: proxy_url || proxyUrl,
      upstreamProxyUseLocalDns: true,
      viewport: { width: 1280, height: 800 },
      blockedResourceTypes: ['Image', 'Font', 'Stylesheet', 'Media'], // Block resource types at Hero level
      defaultBlockedResourceTypes: ['Image', 'Font', 'Stylesheet', 'Media'], // Set default blocked resources
      timezoneId: 'America/New_York', // Set a consistent timezone
      locale: 'en-US', // Set a consistent locale
    };
    
    // Add noChromeSandbox if needed
    if (noChromeSandbox) {
      heroOptions.noChromeSandbox = true;
    }
    
    // Add chromePath if provided
    if (chromePath) {
      heroOptions.executablePath = chromePath;
    }
    
    // Add performance optimization flags
    heroOptions.launchArgs = [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-default-apps',
      '--no-default-browser-check',
      '--disable-breakpad',
      '--disable-translate',
      '--disable-features=TranslateUI',
      '--disable-sync',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox'
    ];
    
    hero = new Hero(heroOptions);
    
    return {
      hero,
      release: () => {
        try {
          // Check if the hero is still connected - use a try/catch since we don't know the exact API
          try {
            // Try to access a property or method to see if it's still alive
            hero.sessionId;
            heroPool.push(hero);
          } catch (e) {
            console.log('New hero instance disconnected, not adding to pool');
            // Create a new instance to replace it
            createHeroInstance().catch(e => console.error('Failed to create replacement hero:', e));
          }
        } catch (error) {
          console.error('Error releasing hero:', error);
        } finally {
          busyHeroes -= 1;
        }
      }
    };
  } catch (error) {
    console.error('Error getting hero instance:', error);
    busyHeroes -= 1;
    throw error;
  }
}

// Create a new hero instance for the pool
async function createHeroInstance(): Promise<void> {
  try {
    const heroOptions: any = {
      connectionToCore,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/109.0",
      upstreamProxyUrl: proxyUrl,
      upstreamProxyUseLocalDns: true,
      viewport: { width: 1280, height: 800 },
      blockedResourceTypes: ['Image', 'Font', 'Stylesheet', 'Media'], // Block resource types at Hero level
      defaultBlockedResourceTypes: ['Image', 'Font', 'Stylesheet', 'Media'], // Set default blocked resources
      timezoneId: 'America/New_York', // Set a consistent timezone
      locale: 'en-US', // Set a consistent locale
    };
    
    // Add noChromeSandbox if needed
    if (noChromeSandbox) {
      heroOptions.noChromeSandbox = true;
    }
    
    // Add chromePath if provided
    if (chromePath) {
      heroOptions.executablePath = chromePath;
    }
    
    // Add performance optimization flags
    heroOptions.launchArgs = [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-default-apps',
      '--no-default-browser-check',
      '--disable-breakpad',
      '--disable-translate',
      '--disable-features=TranslateUI',
      '--disable-sync',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox'
    ];
    
    const hero = new Hero(heroOptions);
    heroPool.push(hero);
    console.log(`Added new hero to pool. Pool size: ${heroPool.length}`);
  } catch (error) {
    console.error('Error creating hero instance:', error);
  }
}

// Middleware to validate request URL
const validateUrl = (req: Request, res: Response, next: Function) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }
  try {
    new URL(url);
    next();
  } catch (error) {
    return res.status(400).json({ error: "Invalid URL" });
  }
};

// Scrape endpoint
app.post("/scrape", validateUrl, async (req: Request, res: Response) => {
  const { url, timeout = 30000, proxy_url, headers = {}, cookies = [], waitForSelector, additionalWaitTime = 0, blockResources = true } = req.body;
  
  console.log(`Scraping ${url}`);
  const startTime = Date.now();
  
  let heroInstance: Hero | null = null;
  let release: (() => void) | null = null;
  let retries = 0;
  const maxRetries = 3;
  
  while (retries < maxRetries) {
    try {
      // Get a hero instance
      const heroResult = await getHeroInstance(proxy_url);
      heroInstance = heroResult.hero;
      release = heroResult.release;
      
      // Set up the tab with a timeout
      const tabPromise = heroInstance.newTab();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Tab creation timed out after ${timeout}ms`)), timeout);
      });
      
      const tab = await Promise.race([tabPromise, timeoutPromise]);
      
      // Set cookies if provided
      if (cookies.length > 0) {
        // Use cookieStorage to set cookies
        const cookieStorage = await tab.cookieStorage;
        for (const cookie of cookies) {
          try {
            // First try to remove any existing cookie with the same name
            await cookieStorage.removeItem(cookie.name).catch(() => {
              // Ignore errors when removing cookies that don't exist
              console.debug(`No existing cookie found for ${cookie.name}`);
            });
            
            // Then add the new cookie
            await cookieStorage.setItem(
              cookie.name, 
              cookie.value, 
              {
                expires: cookie.expires,
                httpOnly: cookie.httpOnly || false,
                secure: cookie.secure || false,
                sameSite: cookie.sameSite as any || 'Lax'
              }
            ).catch(err => {
              console.warn(`Failed to set cookie ${cookie.name}:`, err);
            });
          } catch (cookieError) {
            console.warn(`Failed to set cookie ${cookie.name}:`, cookieError);
            // Continue even if cookie setting fails
          }
        }
      }
      
      // Block unnecessary resources to improve performance
      if (blockResources) {
        tab.on('resource', (resource: Resource | WebsocketResource) => {
          if (resource instanceof Resource) {
            const resourceType = resource.type;
            if (resourceType === 'Image' || resourceType === 'Font' || resourceType === 'Stylesheet' || resourceType === 'Media') {
              // Just log the resource type - we can't directly block it
              console.debug(`Detected resource of type: ${resourceType} - ${resource.url}`);
            }
          }
        });
      }
      
      // Navigate to the URL with a timeout
      await tab.goto(url, {
        timeoutMs: timeout,
        // Use referrer instead of headers
        referrer: headers['referer'] || headers['referrer']
      });
      
      // Wait for selector if provided
      if (waitForSelector) {
        try {
          // Use waitForElement instead of waitForSelector
          const element = tab.querySelector(waitForSelector);
          await tab.waitForElement(element, { 
            timeoutMs: 3000, // Reduced from 5000ms to 3000ms
            waitForVisible: true 
          });
        } catch (err) {
          console.log(`Selector ${waitForSelector} not found within timeout`);
        }
      }
      
      // Wait for additional time if specified
      if (additionalWaitTime > 0) {
        // Use waitForMillis instead of waitForTimeout
        await tab.waitForMillis(Math.min(additionalWaitTime, 2000)); // Reduced from 5000ms to 2000ms
      }
      
      // Wait for page to stabilize with a more robust approach
      try {
        // First try to wait for painting stable with a longer timeout
        await Promise.race([
          tab.waitForPaintingStable({ timeoutMs: 5000 }),
          tab.waitForMillis(3000) // Fallback if painting never stabilizes
        ]);
      } catch (stabilizeError) {
        // If waiting for painting stable fails, log and continue anyway
        console.warn(`Page stabilization timed out for ${url}: ${stabilizeError.message}`);
        // Give the page a bit more time anyway
        await tab.waitForMillis(2000);
      }
      
      // Get the HTML content
      const html = await tab.document.documentElement.innerHTML;
      
      // Close the tab
      await tab.close();
      
      // Return the result
      const endTime = Date.now();
      console.log(`Scraping completed in ${endTime - startTime}ms`);
      
      // Release the hero instance back to the pool
      if (release) release();
      
      return res.json({
        html,
        url: tab.url,
        status: 200,
        headers: {},
        timing: {
          total: endTime - startTime
        }
      });
    } catch (error: unknown) {
      console.error(`Error during scraping (attempt ${retries + 1}/${maxRetries}):`, error);
      
      // Try to capture more context about the error
      let errorContext = {};
      let errorMessage = error instanceof Error ? error.message : String(error);
      
      try {
        if (heroInstance) {
          // Try to get the current URL if possible
          const tabs = await heroInstance.tabs;
          if (tabs.length > 0) {
            const currentTab = tabs[0];
            errorContext = {
              currentUrl: await currentTab.url.catch(() => 'unknown'),
              statusCode: await currentTab.lastCommandId.catch(() => 'unknown')
            };
          }
        }
      } catch (contextError) {
        console.warn('Failed to capture error context:', contextError);
      }
      
      // Close the current hero instance if it failed
      if (heroInstance) {
        try {
          await heroInstance.close().catch(e => console.error("Error closing hero:", e));
        } catch (closeError) {
          console.error("Error during hero close:", closeError);
        }
      }
      
      // Don't release back to pool if there was an error
      release = null;
      
      retries++;
      
      // If we've reached max retries, return an error
      if (retries >= maxRetries) {
        return res.status(500).json({
          error: errorMessage || "An error occurred during scraping",
          url,
          status: 500,
          context: errorContext
        });
      }
      
      // Wait before retrying
      console.log(`Retrying in 1 second... (attempt ${retries}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
});

// Health check endpoint for Cloud Run
// This endpoint is used by Cloud Run to determine if the Ulixee service is healthy
// It returns a 200 OK response with a JSON object
app.get("/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  // Close all hero instances
  for (const hero of heroPool) {
    await hero.close().catch(console.error);
  }
  await HeroCore.shutdown().catch(console.error);
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down server...');
  // Close all hero instances
  for (const hero of heroPool) {
    await hero.close().catch(console.error);
  }
  await HeroCore.shutdown().catch(console.error);
  process.exit(0);
});

// Initialize the pool at server startup
initializeHeroPool().catch(console.error);
