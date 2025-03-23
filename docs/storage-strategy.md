# Storage Strategy for Firecrawl

## Overview

This document outlines the storage strategy for the Firecrawl system, which uses a combination of PostgreSQL for metadata storage and Google Cloud Storage (GCS) for content storage. This hybrid approach optimizes for both cost and performance while supporting the multi-tenant architecture.

## Storage Components

### 1. PostgreSQL Database

PostgreSQL serves as the primary database for storing:
- Tenant, application, and agent data (existing)
- Knowledge collection metadata
- Content metadata and references
- Processing status and configuration

### 2. Google Cloud Storage

Google Cloud Storage is used for storing the actual content data:
- Raw content (HTML, PDFs, text files)
- Processed content (Markdown, extracted text)
- Content metadata (JSON)

## Storage Hierarchy in Google Cloud Storage

```
gs://firecrawl-content/
├── tenant_<tenant_id>/
│   ├── application_<app_id>/
│   │   ├── agent_<agent_id>/  # Optional in future structure
│   │   │   ├── collection_<collection_id>/
│   │   │   │   ├── raw/
│   │   │   │   │   ├── <content_id>.<extension>
│   │   │   │   │   └── ...
│   │   │   │   ├── processed/
│   │   │   │   │   ├── <content_id>.json
│   │   │   │   │   ├── <content_id>.md
│   │   │   │   │   └── ...
│   │   │   │   └── metadata/
│   │   │   │       └── <content_id>.json
│   │   │   └── ...
│   │   └── collection_<collection_id>/  # For future structure without agent
│   │       ├── raw/
│   │       ├── processed/
│   │       └── metadata/
│   └── ...
└── shared/
    └── <shared_resources>
```

## Content Type Storage Patterns

### 1. Webpage Content

**Raw Storage:**
- File: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/raw/<content_id>.html`
- Content-Type: `text/html`

**Processed Storage:**
- File: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/processed/<content_id>.md`
- Content-Type: `text/markdown`

**Metadata Storage:**
- File: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/metadata/<content_id>.json`
- Content-Type: `application/json`

### 2. PDF Content

**Raw Storage:**
- File: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/raw/<content_id>.pdf`
- Content-Type: `application/pdf`

**Processed Storage:**
- Text: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/processed/<content_id>.txt`
- Markdown: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/processed/<content_id>.md`

**Metadata Storage:**
- File: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/metadata/<content_id>.json`
- Content-Type: `application/json`

### 3. Crawl Content

**Raw Storage:**
- Index: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/raw/<content_id>/index.json`
- Pages: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/raw/<content_id>/<page_id>.html`

**Processed Storage:**
- Index: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/processed/<content_id>/index.json`
- Pages: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/processed/<content_id>/<page_id>.md`

**Metadata Storage:**
- File: `tenant_<tenant_id>/application_<app_id>/agent_<agent_id>/collection_<collection_id>/metadata/<content_id>.json`
- Content-Type: `application/json`

## Google Cloud Storage Implementation

### 1. GCS Client Setup

```typescript
// src/lib/storage/gcs.ts
import { Storage } from '@google-cloud/storage';
import { Logger } from '../logger';

export class GCSClient {
  private storage: Storage;
  private bucketName: string;

  constructor() {
    this.storage = new Storage();
    this.bucketName = process.env.GCS_BUCKET || 'firecrawl-content';
  }

  async uploadFile(path: string, content: string | Buffer, contentType: string): Promise<string> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(path);
      
      await file.save(content, {
        contentType: contentType,
        metadata: {
          cacheControl: 'public, max-age=3600',
        },
      });
      
      Logger.info(`Uploaded file to GCS: ${path}`);
      return path;
    } catch (error) {
      Logger.error(`Error uploading to GCS: ${error.message}`);
      throw new Error(`Failed to upload to GCS: ${error.message}`);
    }
  }

  async downloadFile(path: string): Promise<Buffer> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(path);
      
      const [content] = await file.download();
      return content;
    } catch (error) {
      Logger.error(`Error downloading from GCS: ${error.message}`);
      throw new Error(`Failed to download from GCS: ${error.message}`);
    }
  }

  async generateSignedUrl(path: string, expirationMinutes: number = 15): Promise<string> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(path);
      
      const [url] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expirationMinutes * 60 * 1000,
      });
      
      return url;
    } catch (error) {
      Logger.error(`Error generating signed URL: ${error.message}`);
      throw new Error(`Failed to generate signed URL: ${error.message}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(path);
      
      await file.delete();
      Logger.info(`Deleted file from GCS: ${path}`);
    } catch (error) {
      Logger.error(`Error deleting from GCS: ${error.message}`);
      throw new Error(`Failed to delete from GCS: ${error.message}`);
    }
  }

  async fileExists(path: string): Promise<boolean> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(path);
      
      const [exists] = await file.exists();
      return exists;
    } catch (error) {
      Logger.error(`Error checking file existence: ${error.message}`);
      throw new Error(`Failed to check file existence: ${error.message}`);
    }
  }
}
```

### 2. Multi-Tenant Path Generator

```typescript
// src/lib/storage/path-generator.ts
export class StoragePathGenerator {
  /**
   * Generate storage paths for a content item
   */
  static generateContentPaths(
    tenantId: string,
    appId: string,
    collectionId: string,
    contentId: string,
    contentType: string,
    agentId?: string
  ): {
    basePath: string;
    rawPath: string;
    processedPath: string;
    metadataPath: string;
  } {
    // Define base path based on tenant hierarchy
    let basePath;
    if (agentId) {
      // Current structure with agent
      basePath = `tenant_${tenantId}/application_${appId}/agent_${agentId}/collection_${collectionId}/`;
    } else {
      // Future structure without agent
      basePath = `tenant_${tenantId}/application_${appId}/collection_${collectionId}/`;
    }
    
    // Define file extensions based on content type
    let rawExt, processedExt;
    switch (contentType) {
      case 'webpage':
        rawExt = 'html';
        processedExt = 'md';
        break;
      case 'pdf':
        rawExt = 'pdf';
        processedExt = 'md';
        break;
      case 'text':
        rawExt = 'txt';
        processedExt = 'md';
        break;
      case 'crawl':
        // For crawls, we use directories
        return {
          basePath,
          rawPath: `${basePath}raw/${contentId}/index.json`,
          processedPath: `${basePath}processed/${contentId}/index.json`,
          metadataPath: `${basePath}metadata/${contentId}.json`,
        };
      default:
        rawExt = 'bin';
        processedExt = 'json';
    }
    
    return {
      basePath,
      rawPath: `${basePath}raw/${contentId}.${rawExt}`,
      processedPath: `${basePath}processed/${contentId}.${processedExt}`,
      metadataPath: `${basePath}metadata/${contentId}.json`,
    };
  }
  
  /**
   * Generate storage path for a crawl page
   */
  static generateCrawlPagePath(
    tenantId: string,
    appId: string,
    collectionId: string,
    contentId: string,
    pageId: string,
    isProcessed: boolean = false,
    agentId?: string
  ): string {
    // Define base path based on tenant hierarchy
    let basePath;
    if (agentId) {
      // Current structure with agent
      basePath = `tenant_${tenantId}/application_${appId}/agent_${agentId}/collection_${collectionId}/`;
    } else {
      // Future structure without agent
      basePath = `tenant_${tenantId}/application_${appId}/collection_${collectionId}/`;
    }
    
    const type = isProcessed ? 'processed' : 'raw';
    const ext = isProcessed ? 'md' : 'html';
    
    return `${basePath}${type}/${contentId}/${pageId}.${ext}`;
  }
}
```

## Content Storage Service

```typescript
// src/services/content-storage.ts
import { GCSClient } from '../lib/storage/gcs';
import { StoragePathGenerator } from '../lib/storage/path-generator';
import { Logger } from '../lib/logger';
import { knowledgeContentRepository } from '../lib/database/postgres';

export class ContentStorageService {
  private gcsClient: GCSClient;
  
  constructor() {
    this.gcsClient = new GCSClient();
  }
  
  /**
   * Store webpage content
   */
  async storeWebpageContent(
    tenantId: string,
    appId: string,
    collectionId: string,
    contentId: string,
    html: string,
    markdown: string,
    metadata: any,
    agentId?: string
  ): Promise<any> {
    try {
      // Generate storage paths
      const paths = StoragePathGenerator.generateContentPaths(
        tenantId,
        appId,
        collectionId,
        contentId,
        'webpage',
        agentId
      );
      
      // Upload raw HTML
      await this.gcsClient.uploadFile(
        paths.rawPath,
        html,
        'text/html'
      );
      
      // Upload processed markdown
      await this.gcsClient.uploadFile(
        paths.processedPath,
        markdown,
        'text/markdown'
      );
      
      // Upload metadata
      await this.gcsClient.uploadFile(
        paths.metadataPath,
        JSON.stringify(metadata),
        'application/json'
      );
      
      // Update storage paths in PostgreSQL
      await knowledgeContentRepository.updateStorage(contentId, {
        bucket: this.gcsClient.bucketName,
        raw_path: paths.rawPath,
        processed_path: paths.processedPath,
        metadata_path: paths.metadataPath,
      });
      
      // Update content status to completed
      await knowledgeContentRepository.updateStatus(contentId, 'completed');
      
      return {
        content_id: contentId,
        storage: {
          bucket: this.gcsClient.bucketName,
          raw_path: paths.rawPath,
          processed_path: paths.processedPath,
          metadata_path: paths.metadataPath,
        },
      };
    } catch (error) {
      Logger.error(`Error storing webpage content: ${error.message}`);
      
      // Update content status to failed
      await knowledgeContentRepository.updateStatus(contentId, 'failed');
      
      throw new Error(`Failed to store webpage content: ${error.message}`);
    }
  }
  
  /**
   * Store PDF content
   */
  async storePdfContent(
    tenantId: string,
    appId: string,
    collectionId: string,
    contentId: string,
    pdfBuffer: Buffer,
    extractedText: string,
    markdown: string,
    metadata: any,
    agentId?: string
  ): Promise<any> {
    try {
      // Generate storage paths
      const paths = StoragePathGenerator.generateContentPaths(
        tenantId,
        appId,
        collectionId,
        contentId,
        'pdf',
        agentId
      );
      
      // Upload raw PDF
      await this.gcsClient.uploadFile(
        paths.rawPath,
        pdfBuffer,
        'application/pdf'
      );
      
      // Upload processed markdown
      await this.gcsClient.uploadFile(
        paths.processedPath,
        markdown,
        'text/markdown'
      );
      
      // Upload extracted text
      const textPath = paths.processedPath.replace('.md', '.txt');
      await this.gcsClient.uploadFile(
        textPath,
        extractedText,
        'text/plain'
      );
      
      // Upload metadata
      await this.gcsClient.uploadFile(
        paths.metadataPath,
        JSON.stringify(metadata),
        'application/json'
      );
      
      // Update storage paths in PostgreSQL
      await knowledgeContentRepository.updateStorage(contentId, {
        bucket: this.gcsClient.bucketName,
        raw_path: paths.rawPath,
        processed_path: paths.processedPath,
        text_path: textPath,
        metadata_path: paths.metadataPath,
      });
      
      // Update content status to completed
      await knowledgeContentRepository.updateStatus(contentId, 'completed');
      
      return {
        content_id: contentId,
        storage: {
          bucket: this.gcsClient.bucketName,
          raw_path: paths.rawPath,
          processed_path: paths.processedPath,
          text_path: textPath,
          metadata_path: paths.metadataPath,
        },
      };
    } catch (error) {
      Logger.error(`Error storing PDF content: ${error.message}`);
      
      // Update content status to failed
      await knowledgeContentRepository.updateStatus(contentId, 'failed');
      
      throw new Error(`Failed to store PDF content: ${error.message}`);
    }
  }
  
  /**
   * Get content by ID
   */
  async getContent(
    contentId: string,
    format: 'raw' | 'processed' | 'metadata' = 'processed'
  ): Promise<{ url: string; expires_at: Date }> {
    try {
      // Get content from PostgreSQL
      const content = await knowledgeContentRepository.findById(contentId);
      
      if (!content) {
        throw new Error('Content not found');
      }
      
      // Get the appropriate path based on format
      let path;
      switch (format) {
        case 'raw':
          path = content.storage.raw_path;
          break;
        case 'processed':
          path = content.storage.processed_path;
          break;
        case 'metadata':
          path = content.storage.metadata_path;
          break;
      }
      
      if (!path) {
        throw new Error(`${format} format not available for this content`);
      }
      
      // Generate signed URL
      const expirationMinutes = 15;
      const url = await this.gcsClient.generateSignedUrl(path, expirationMinutes);
      
      return {
        url,
        expires_at: new Date(Date.now() + expirationMinutes * 60 * 1000),
      };
    } catch (error) {
      Logger.error(`Error getting content: ${error.message}`);
      throw new Error(`Failed to get content: ${error.message}`);
    }
  }
}
```

## Benefits of Hybrid Storage Strategy

### 1. Cost Optimization

- **PostgreSQL**: Efficient for storing structured metadata and relationships
- **GCS**: Cost-effective for storing large content files
- **Reduced Database Load**: Keeping large content out of the database

### 2. Performance

- **Query Performance**: Fast metadata queries in PostgreSQL
- **Content Delivery**: GCS provides high-throughput content delivery
- **Caching**: GCS supports CDN integration for frequently accessed content

### 3. Scalability

- **Independent Scaling**: Database and storage can scale independently
- **Unlimited Storage**: GCS provides virtually unlimited storage capacity
- **Multi-Region**: GCS supports multi-region deployment for global access

### 4. Security

- **Access Control**: Fine-grained IAM permissions for GCS buckets
- **Signed URLs**: Temporary access to content without exposing credentials
- **Encryption**: Data encrypted at rest and in transit

### 5. Operational Benefits

- **Backup and Recovery**: Simplified backup strategy for both systems
- **Monitoring**: Separate monitoring for database and storage performance
- **Cost Tracking**: Clear separation of database and storage costs

## Implementation Considerations

### 1. Consistency

To maintain consistency between PostgreSQL and GCS:

- Use transactions when updating PostgreSQL records
- Implement retry logic for GCS operations
- Consider implementing a reconciliation process to detect and fix inconsistencies

### 2. Error Handling

Robust error handling is essential:

- Handle GCS operation failures gracefully
- Update content status in PostgreSQL when storage operations fail
- Implement proper logging for debugging

### 3. Cleanup

Implement a cleanup process to remove orphaned files:

- When content is deleted from PostgreSQL, remove corresponding files from GCS
- Consider implementing a soft delete strategy with a retention period
- Run periodic cleanup jobs to ensure storage efficiency
