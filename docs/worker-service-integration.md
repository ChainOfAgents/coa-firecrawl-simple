# Worker Service Integration for Chain of Agents

## Overview

This document outlines the design for integrating the Worker service into the Chain of Agents system. The Worker service will handle web scraping operations and update the status in the PostgreSQL database using the knowledge endpoints.

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│ API Service │────▶│ Worker      │────▶│ Google Cloud Storage│
└─────────────┘     │  Service    │     └─────────────────────┘
                    └──────┬──────┘
                           │
                           ▼
                    ┌──────────────┐
                    │  PostgreSQL  │
                    │  Database    │
                    └──────────────┘
```

## Components

### 1. API Service

The API service acts as the entry point for client requests and is responsible for:
- Accepting scraping requests from clients
- Validating user access to tenant/application/agent resources
- Creating initial database records for knowledge collections and sources
- Forwarding scraping requests to the Worker service
- Returning job IDs and status information to clients

### 2. Worker Service

The Worker service is responsible for:
- Receiving scraping requests from the API service
- Executing the appropriate scraping strategy based on the mode (single_urls, sitemap, crawl)
- Storing scraped content in Google Cloud Storage
- Updating job status in PostgreSQL via the knowledge endpoints API
- Handling errors and retries

### 3. Scraper Implementations

The Worker service includes three scraper implementations:
- **SingleUrlScraper**: Scrapes content from a single URL
- **SitemapScraper**: Extracts URLs from a sitemap and scrapes each one
- **WebCrawler**: Recursively crawls a website starting from a seed URL

### 4. Storage Components

- **PostgreSQL Database**: Stores metadata about knowledge collections and sources
- **Google Cloud Storage**: Stores the actual scraped content

## Data Flow

1. Client sends a request to the API service to create a knowledge source
2. API service validates the request and creates a record in the database with PENDING status
3. API service forwards the request to the Worker service
4. Worker service updates the source status to PROCESSING
5. Worker service executes the appropriate scraping strategy
6. Worker service uploads the scraped content to Google Cloud Storage
7. Worker service updates the source status to COMPLETED (or FAILED if an error occurs)
8. Client can query the API service for the status of the job

## Implementation Details

### 1. Worker Service Implementation

```typescript
// worker/index.ts
import express from 'express';
import { ScraperFactory } from './scrapers/scraper-factory';
import { GCPBucketConnector } from './connectors/gcp-bucket';
import { KnowledgeEndpointClient } from './clients/knowledge-endpoint-client';

const app = express();
app.use(express.json());

// Endpoint to handle scraping requests
app.post('/api/scrape', async (req, res) => {
  const { 
    job_id,
    url, 
    mode, 
    options, 
    tenant_id, 
    application_id, 
    agent_id,
    collection_id,
    source_id
  } = req.body;
  
  try {
    // Update job status to STARTED
    const knowledgeClient = new KnowledgeEndpointClient();
    await knowledgeClient.updateSourceStatus(
      source_id, collection_id, tenant_id, application_id, agent_id, 
      'PROCESSING', 'Scraping started'
    );
    
    // Create appropriate scraper based on mode
    const scraper = ScraperFactory.createScraper(mode, {
      playwrightServiceUrl: process.env.PLAYWRIGHT_SERVICE_URL,
      ulixeeServiceUrl: process.env.ULIXEE_SERVICE_URL
    });
    
    // Execute scraping
    const scrapedContent = await scraper.scrape(url, options);
    
    // Generate filename
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').split('.')[0];
    const filename = `${mode}_${timestamp}.md`;
    
    // Upload to GCS
    const gcp = new GCPBucketConnector();
    const gcsPath = await gcp.uploadFromString(
      'agents_knowledge',
      scrapedContent,
      `${tenant_id}/${application_id}/${agent_id}/${collection_id}/${filename}`
    );
    
    // Update job status to COMPLETED
    await knowledgeClient.updateSourceStatus(
      source_id, collection_id, tenant_id, application_id, agent_id, 
      'COMPLETED', `Content uploaded to ${gcsPath}`
    );
    
    res.status(200).json({ status: 'success', gcs_path: gcsPath });
  } catch (error) {
    console.error('Scraping error:', error);
    
    // Update job status to FAILED
    try {
      const knowledgeClient = new KnowledgeEndpointClient();
      await knowledgeClient.updateSourceStatus(
        source_id, collection_id, tenant_id, application_id, agent_id, 
        'FAILED', `Scraping failed: ${error.message}`
      );
    } catch (updateError) {
      console.error('Failed to update status:', updateError);
    }
    
    res.status(500).json({ status: 'error', message: error.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Worker service listening on port ${PORT}`);
});
```

### 2. Scraper Factory and Implementations

```typescript
// worker/scrapers/scraper-factory.ts
import { SingleUrlScraper } from './single-url-scraper';
import { SitemapScraper } from './sitemap-scraper';
import { WebCrawler } from './web-crawler';

export class ScraperFactory {
  static createScraper(mode: string, config: any) {
    switch (mode) {
      case 'single_urls':
        return new SingleUrlScraper(config);
      case 'sitemap':
        return new SitemapScraper(config);
      case 'crawl':
        return new WebCrawler(config);
      default:
        throw new Error(`Unknown scraper mode: ${mode}`);
    }
  }
}
```

```typescript
// worker/scrapers/single-url-scraper.ts
import axios from 'axios';

export class SingleUrlScraper {
  private playwrightServiceUrl: string;
  
  constructor(config: any) {
    this.playwrightServiceUrl = config.playwrightServiceUrl;
  }
  
  async scrape(url: string, options: any) {
    try {
      // Call Playwright service to scrape the URL
      const response = await axios.post(`${this.playwrightServiceUrl}/scrape`, {
        url,
        options
      });
      
      return response.data.content;
    } catch (error) {
      console.error('Error scraping URL:', error);
      throw error;
    }
  }
}
```

```typescript
// worker/scrapers/sitemap-scraper.ts
import axios from 'axios';
import { parseStringPromise } from 'xml2js';

export class SitemapScraper {
  private playwrightServiceUrl: string;
  
  constructor(config: any) {
    this.playwrightServiceUrl = config.playwrightServiceUrl;
  }
  
  async scrape(sitemapUrl: string, options: any) {
    try {
      // Fetch sitemap XML
      const response = await axios.get(sitemapUrl);
      const sitemapXml = response.data;
      
      // Parse sitemap XML
      const result = await parseStringPromise(sitemapXml);
      const urls = result.urlset.url.map((urlEntry: any) => urlEntry.loc[0]);
      
      // Limit the number of URLs to scrape if specified
      const maxUrls = options.maxUrls || 10;
      const urlsToScrape = urls.slice(0, maxUrls);
      
      // Scrape each URL
      const scrapePromises = urlsToScrape.map(async (url: string) => {
        try {
          const scrapeResponse = await axios.post(`${this.playwrightServiceUrl}/scrape`, {
            url,
            options
          });
          
          return {
            url,
            content: scrapeResponse.data.content,
            success: true
          };
        } catch (error) {
          console.error(`Error scraping URL ${url}:`, error);
          return {
            url,
            content: null,
            success: false,
            error: error.message
          };
        }
      });
      
      const results = await Promise.all(scrapePromises);
      
      // Combine results into a single document
      const combinedContent = results.map(result => {
        if (result.success) {
          return `## ${result.url}\n\n${result.content}\n\n---\n\n`;
        } else {
          return `## ${result.url}\n\nFailed to scrape: ${result.error}\n\n---\n\n`;
        }
      }).join('');
      
      return combinedContent;
    } catch (error) {
      console.error('Error processing sitemap:', error);
      throw error;
    }
  }
}
```

```typescript
// worker/scrapers/web-crawler.ts
import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';

export class WebCrawler {
  private playwrightServiceUrl: string;
  private visitedUrls: Set<string>;
  private results: Array<{url: string, content: string, success: boolean, error?: string}>;
  private maxDepth: number;
  private maxUrls: number;
  
  constructor(config: any) {
    this.playwrightServiceUrl = config.playwrightServiceUrl;
    this.visitedUrls = new Set();
    this.results = [];
    this.maxDepth = 3;
    this.maxUrls = 10;
  }
  
  async scrape(seedUrl: string, options: any) {
    // Set options
    this.maxDepth = options.maxDepth || this.maxDepth;
    this.maxUrls = options.maxUrls || this.maxUrls;
    
    // Start crawling from the seed URL
    await this.crawl(seedUrl, 0);
    
    // Combine results into a single document
    const combinedContent = this.results.map(result => {
      if (result.success) {
        return `## ${result.url}\n\n${result.content}\n\n---\n\n`;
      } else {
        return `## ${result.url}\n\nFailed to scrape: ${result.error}\n\n---\n\n`;
      }
    }).join('');
    
    return combinedContent;
  }
  
  private async crawl(url: string, depth: number) {
    // Check if we've reached the maximum number of URLs
    if (this.visitedUrls.size >= this.maxUrls) {
      return;
    }
    
    // Check if we've reached the maximum depth
    if (depth > this.maxDepth) {
      return;
    }
    
    // Check if we've already visited this URL
    if (this.visitedUrls.has(url)) {
      return;
    }
    
    // Mark URL as visited
    this.visitedUrls.add(url);
    
    try {
      // Scrape the URL
      const response = await axios.post(`${this.playwrightServiceUrl}/scrape`, {
        url,
        options: {}
      });
      
      // Add result
      this.results.push({
        url,
        content: response.data.content,
        success: true
      });
      
      // Extract links from the page
      const links = this.extractLinks(url, response.data.content);
      
      // Crawl each link
      for (const link of links) {
        await this.crawl(link, depth + 1);
      }
    } catch (error) {
      console.error(`Error crawling URL ${url}:`, error);
      
      // Add failed result
      this.results.push({
        url,
        content: '',
        success: false,
        error: error.message
      });
    }
  }
  
  private extractLinks(baseUrl: string, content: string): string[] {
    try {
      const $ = cheerio.load(content);
      const links: string[] = [];
      
      $('a').each((_, element) => {
        const href = $(element).attr('href');
        if (href) {
          try {
            // Resolve relative URLs
            const absoluteUrl = new URL(href, baseUrl).href;
            
            // Only include URLs from the same domain
            const baseUrlObj = new URL(baseUrl);
            const absoluteUrlObj = new URL(absoluteUrl);
            
            if (baseUrlObj.hostname === absoluteUrlObj.hostname) {
              links.push(absoluteUrl);
            }
          } catch (error) {
            // Ignore invalid URLs
          }
        }
      });
      
      return links;
    } catch (error) {
      console.error('Error extracting links:', error);
      return [];
    }
  }
}
```

### 3. Knowledge Endpoint Client

```typescript
// worker/clients/knowledge-endpoint-client.ts
import axios from 'axios';

export class KnowledgeEndpointClient {
  private baseUrl: string;
  
  constructor() {
    this.baseUrl = process.env.API_BASE_URL || 'http://localhost:3001';
  }
  
  async updateSourceStatus(
    source_id: string,
    collection_id: string,
    tenant_id: string,
    application_id: string,
    agent_id: string,
    status: string,
    message: string
  ) {
    try {
      const response = await axios.put(
        `${this.baseUrl}/api/v2/studio/knowledge/collection/${collection_id}/source/${source_id}`,
        {
          message: message
        },
        {
          params: {
            tenant_id,
            application_id,
            agent_id
          },
          headers: {
            'Authorization': `Bearer ${process.env.API_TOKEN}`
          }
        }
      );
      
      return response.data;
    } catch (error) {
      console.error('Error updating source status:', error);
      throw error;
    }
  }
}
```

### 4. API Service Modifications

```typescript
// api/routers_v2/studio/knowledge_endpoints.py (modified)

@router.post(
    "/knowledge/collection/{collection_id}/source",
    response_model=SourceResponse,
    summary="Create source",
    description="Create a new text or URL source in a collection"
)
async def create_source(
    collection_id: str,
    tenant_id: str,
    application_id: str,
    agent_id: int,
    request: CreateSourceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new text or URL source in a collection."""
    logger.debug(f"[CREATE_SOURCE] Request received: collection_id={collection_id}, type={request.type}")
    try:
        # Verify user has access to tenant, application, and agent
        verify_user_tenant_application_agent(
            db=db,
            tenant_id=int(tenant_id),
            application_id=int(application_id),
            agent_id=agent_id,
            current_user=current_user
        )
        
        # Check if collection exists
        collection = db.query(KnowledgeCollection).filter(
            KnowledgeCollection.id == collection_id,
            KnowledgeCollection.agent_id == agent_id
        ).first()
        
        if not collection:
            raise HTTPException(status_code=404, detail="Knowledge collection not found")
        
        # Create source record with pending status
        source = KnowledgeSource(
            id=generate_gcp_friendly_id(request.name),
            name=request.name,
            type=request.type.lower(),
            agent_id=agent_id,
            collection_id=collection_id,
            status=KnowledgeStatus.PENDING.value,
            message="Scraping job queued",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc)
        )
        
        db.add(source)
        db.commit()
        db.refresh(source)
        
        # For URL type sources, send to worker service for scraping
        if request.type.lower() == SourceType.URL.value:
            try:
                # Send request to worker service
                worker_url = settings.WORKER_SERVICE_URL
                response = requests.post(
                    f"{worker_url}/api/scrape",
                    json={
                        "job_id": source.id,
                        "url": request.content,
                        "mode": "single_urls",
                        "options": {},
                        "tenant_id": tenant_id,
                        "application_id": application_id,
                        "agent_id": str(agent_id),
                        "collection_id": collection_id,
                        "source_id": source.id
                    }
                )
                response.raise_for_status()
                
                # Update source status to processing
                source.status = KnowledgeStatus.PROCESSING.value
                source.message = "Scraping job started"
                db.commit()
                db.refresh(source)
                
                logger.info(f"Successfully sent URL scraping job to worker service")
            except Exception as e:
                logger.warning(f"Failed to send job to worker service: {str(e)}. Source will remain in PENDING state.")
                logger.exception("Detailed traceback:")
        
        # For text sources, handle directly
        elif request.type.lower() == SourceType.TEXT.value:
            # Upload content to GCP
            normalized_name = request.name.replace(' ', '_').lower()
            filename = f"text_{normalized_name}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}.md"
            
            gcs_path = upload_source_to_collection_in_gcp(
                tenant_id=tenant_id,
                application_id=application_id,
                agent_id=str(agent_id),
                collection_id=collection_id,
                content=request.content,
                filename=filename
            )
            
            # Update source status to completed
            source.status = KnowledgeStatus.COMPLETED.value
            source.message = f"Content uploaded to {gcs_path}"
            db.commit()
            db.refresh(source)
        
        return SourceResponse(
            **source.to_dict(),
            metadata={"created_by": current_user.email}
        )
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Error creating source: {str(e)}")
        logger.exception("Detailed traceback:")
        raise HTTPException(status_code=500, detail=str(e))
```

## Deployment

### Docker Compose for Local Development

```yaml
version: '3'

services:
  api:
    build: ./api
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - WORKER_SERVICE_URL=http://worker:3002
      - DATABASE_URL=postgresql://user:password@postgres:5432/chainofagents
    depends_on:
      - postgres

  worker:
    build: ./worker
    ports:
      - "3002:3002"
    environment:
      - PORT=3002
      - API_BASE_URL=http://api:3001
      - PLAYWRIGHT_SERVICE_URL=http://playwright:3000
      - ULIXEE_SERVICE_URL=http://ulixee:3003
    depends_on:
      - api
      - playwright
      - ulixee

  playwright:
    build: ./playwright-service
    ports:
      - "3000:3000"
    environment:
      - PORT=3000

  ulixee:
    build: ./ulixee-service
    ports:
      - "3003:3003"
    environment:
      - PORT=3003

  postgres:
    image: postgres:14
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=chainofagents
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  postgres-data:
```

### Cloud Run Deployment

#### Dockerfile for Worker Service

```dockerfile
# worker/Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

ENV PORT=8080
CMD ["npm", "start"]
```

#### Cloud Build Configuration

```yaml
# cloudbuild.yaml
steps:
  # Build and push worker service
  - name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', 'gcr.io/$PROJECT_ID/worker-service:$COMMIT_SHA', './worker']
  
  - name: 'gcr.io/cloud-builders/docker'
    args: ['push', 'gcr.io/$PROJECT_ID/worker-service:$COMMIT_SHA']
  
  # Deploy worker service to Cloud Run
  - name: 'gcr.io/cloud-builders/gcloud'
    args:
      - 'run'
      - 'deploy'
      - 'worker-service'
      - '--image=gcr.io/$PROJECT_ID/worker-service:$COMMIT_SHA'
      - '--region=us-west2'
      - '--platform=managed'
      - '--allow-unauthenticated'
      - '--set-env-vars=API_BASE_URL=${_API_BASE_URL},PLAYWRIGHT_SERVICE_URL=${_PLAYWRIGHT_SERVICE_URL},ULIXEE_SERVICE_URL=${_ULIXEE_SERVICE_URL}'
```

## Security Considerations

### Authentication and Authorization

- Implement token-based authentication between services
- Verify tenant/application/agent access rights
- Use service accounts for GCP resource access

### Rate Limiting and Throttling

- Implement rate limiting to prevent abuse
- Add throttling for external service calls
- Consider implementing a queue for high-volume scenarios

### Error Handling and Resilience

- Implement proper error handling and logging
- Add retry logic for transient failures
- Use circuit breakers for external service calls

## Monitoring and Logging

### Logging Strategy

- Use structured logging with correlation IDs
- Include relevant context in log messages
- Set appropriate log levels for different environments

### Metrics and Monitoring

- Track scraping success rates
- Monitor processing times
- Measure resource utilization

### Alerting

- Set up alerts for high error rates
- Monitor service availability
- Alert on abnormal processing times

## Conclusion

This design provides a comprehensive approach to integrating the Worker service into the Chain of Agents system. By leveraging the existing knowledge endpoints and GCP storage infrastructure, the Worker service can efficiently handle web scraping operations while maintaining proper status updates in the PostgreSQL database.

The modular architecture allows for easy extension to support additional scraping modes and content processing strategies in the future.
