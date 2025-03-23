# API Service for Firecrawl

## Overview

The API Service serves as the entry point for client requests in the Firecrawl system. It handles authentication, authorization, and triggers the appropriate Airflow workflows for content processing. This document outlines the API endpoints, controllers, and integration with Airflow and PostgreSQL.

## API Endpoints Structure

The API endpoints follow the multi-tenant hierarchy:

```
/api/v1/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content
/api/v1/tenants/:tenantId/applications/:appId/collections/:collectionId/content (future structure)
```

## API Endpoints

### 1. Create Knowledge Collection

```
POST /api/v1/tenants/:tenantId/applications/:appId/agents/:agentId/collections
POST /api/v1/tenants/:tenantId/applications/:appId/collections (future structure)
```

**Request Body:**
```json
{
  "name": "Example Collection",
  "settings": {
    "refresh_frequency": "daily",
    "processing_options": {
      "extract_links": true,
      "include_images": false
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "collection_id": "abc-123-def-456",
  "name": "Example Collection",
  "created_at": "2025-03-14T19:00:00Z"
}
```

### 2. Add Content to Collection

```
POST /api/v1/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content
POST /api/v1/tenants/:tenantId/applications/:appId/collections/:collectionId/content (future structure)
```

**Request Body:**
```json
{
  "contentType": "webpage",
  "url": "https://example.com/page",
  "options": {
    "extract_links": true,
    "include_images": false
  }
}
```

**Response:**
```json
{
  "success": true,
  "content_id": "xyz-789",
  "status": "pending",
  "airflow_run_id": "manual__2025-03-14T19:00:00+00:00"
}
```

### 3. Get Content

```
GET /api/v1/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content/:contentId
GET /api/v1/tenants/:tenantId/applications/:appId/collections/:collectionId/content/:contentId (future structure)
```

**Query Parameters:**
- `format`: `raw`, `processed`, or `metadata` (default: `processed`)

**Response:**
```json
{
  "success": true,
  "content_id": "xyz-789",
  "content_type": "webpage",
  "format": "processed",
  "url": "https://storage.googleapis.com/firecrawl-content/...",
  "expires_at": "2025-03-14T19:15:00Z"
}
```

### 4. List Collection Contents

```
GET /api/v1/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content
GET /api/v1/tenants/:tenantId/applications/:appId/collections/:collectionId/content (future structure)
```

**Query Parameters:**
- `status`: Filter by status (`pending`, `processing`, `completed`, `failed`)
- `contentType`: Filter by content type (`webpage`, `pdf`, `text`, `crawl`)
- `page`: Page number for pagination (default: 1)
- `limit`: Number of items per page (default: 20)

**Response:**
```json
{
  "success": true,
  "collection_id": "abc-123-def-456",
  "items": [
    {
      "content_id": "xyz-789",
      "title": "Example Page",
      "content_type": "webpage",
      "status": "completed",
      "created_at": "2025-03-14T19:00:00Z",
      "updated_at": "2025-03-14T19:05:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "pages": 1
  }
}
```

### 5. Get Content Status

```
GET /api/v1/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content/:contentId/status
GET /api/v1/tenants/:tenantId/applications/:appId/collections/:collectionId/content/:contentId/status (future structure)
```

**Response:**
```json
{
  "success": true,
  "content_id": "xyz-789",
  "status": "completed",
  "airflow_run_id": "manual__2025-03-14T19:00:00+00:00",
  "airflow_status": "success",
  "processing_time": 300,
  "updated_at": "2025-03-14T19:05:00Z"
}
```

## Controller Implementation

### Add Content Controller

```typescript
// src/controllers/v1/content.ts
import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { Storage } from "@google-cloud/storage";
import { RequestWithAuth } from "./types";
import { Logger } from "../../lib/logger";
import { knowledgeCollectionRepository, knowledgeContentRepository } from "../../lib/database/postgres";
import { AirflowClient } from "../../services/airflow-client";

// Add content to a collection
export async function addContentController(
  req: RequestWithAuth<
    { 
      tenantId: string; 
      appId: string; 
      agentId?: string; 
      collectionId: string;
    }, 
    any, 
    {
      contentType: 'webpage' | 'pdf' | 'text' | 'crawl';
      url?: string;
      file?: Buffer;
      options?: any;
    }
  >,
  res: Response
) {
  const { tenantId, appId, agentId, collectionId } = req.params;
  const { contentType, url, file, options } = req.body;
  
  try {
    // Verify collection exists and belongs to the tenant/app/agent
    const collection = await knowledgeCollectionRepository.findById(collectionId);
    
    if (!collection) {
      return res.status(404).json({ success: false, error: 'Collection not found' });
    }
    
    if (collection.tenant_id !== tenantId || 
        collection.application_id !== appId || 
        (agentId && collection.agent_id !== agentId)) {
      return res.status(403).json({ success: false, error: 'Access denied to collection' });
    }
    
    // Generate content ID
    const contentId = uuidv4();
    
    // Create content record in PostgreSQL
    const contentRecord = await knowledgeContentRepository.create({
      id: contentId,
      collection_id: collectionId,
      tenant_id: tenantId,
      application_id: appId,
      agent_id: agentId || null,
      content_type: contentType,
      source_url: url,
      title: url ? new URL(url).hostname : `File-${contentId}`,
      storage: {
        bucket: 'firecrawl-content',
        raw_path: '',
        processed_path: '',
        metadata_path: '',
      },
      metadata: {
        size: file ? file.length : 0,
      },
    });
    
    // If file is provided (PDF or text), upload to GCS first
    if (file) {
      const storage = new Storage();
      const bucket = storage.bucket('firecrawl-content');
      
      let basePath;
      if (agentId) {
        basePath = `tenant_${tenantId}/application_${appId}/agent_${agentId}/collection_${collectionId}/raw/`;
      } else {
        basePath = `tenant_${tenantId}/application_${appId}/collection_${collectionId}/raw/`;
      }
      
      const filePath = `${basePath}${contentId}.${contentType === 'pdf' ? 'pdf' : 'txt'}`;
      const fileBlob = bucket.file(filePath);
      
      await fileBlob.save(file, {
        contentType: contentType === 'pdf' ? 'application/pdf' : 'text/plain',
      });
      
      // Update the raw_path in PostgreSQL
      await knowledgeContentRepository.updateStorage(contentId, {
        bucket: 'firecrawl-content',
        raw_path: filePath,
        processed_path: '',
        metadata_path: '',
      });
    }
    
    // Trigger appropriate Airflow DAG based on content type
    const airflowClient = new AirflowClient();
    const dagId = `tenant_${tenantId}_app_${appId}${agentId ? `_agent_${agentId}` : ''}_${contentType}_processor`;
    
    const dagRunId = await airflowClient.triggerDag(dagId, {
      conf: {
        tenant_id: tenantId,
        app_id: appId,
        agent_id: agentId,
        collection_id: collectionId,
        content_id: contentId,
        url: url,
        options: options,
      }
    });
    
    // Update Airflow run ID in PostgreSQL
    await knowledgeContentRepository.updateAirflowRunId(contentId, dagRunId);
    
    return res.status(200).json({
      success: true,
      content_id: contentId,
      status: 'pending',
      airflow_run_id: dagRunId,
    });
  } catch (error) {
    Logger.error(`Error adding content: ${error}`);
    return res.status(500).json({ success: false, error: 'Failed to add content' });
  }
}
```

### Get Content Controller

```typescript
// Get content from a collection
export async function getContentController(
  req: RequestWithAuth<
    { 
      tenantId: string; 
      appId: string; 
      agentId?: string; 
      collectionId: string;
      contentId: string;
    }, 
    any, 
    any
  >,
  res: Response
) {
  const { tenantId, appId, agentId, collectionId, contentId } = req.params;
  const { format } = req.query; // raw, processed, metadata
  
  try {
    // Get content metadata from PostgreSQL
    const content = await knowledgeContentRepository.findById(contentId);
    
    if (!content) {
      return res.status(404).json({ success: false, error: 'Content not found' });
    }
    
    // Verify tenant/app/collection hierarchy
    if (content.tenant_id !== tenantId || 
        content.application_id !== appId || 
        content.collection_id !== collectionId ||
        (agentId && content.agent_id !== agentId)) {
      return res.status(403).json({ success: false, error: 'Access denied to content' });
    }
    
    // Generate signed URL for the requested format
    const storage = new Storage();
    const bucket = storage.bucket(content.storage.bucket);
    
    let path;
    let contentType;
    
    switch (format) {
      case 'raw':
        path = content.storage.raw_path;
        contentType = content.content_type === 'pdf' ? 'application/pdf' : 
                      content.content_type === 'webpage' ? 'text/html' : 'text/plain';
        break;
      case 'processed':
        path = content.storage.processed_path;
        contentType = 'text/markdown';
        break;
      case 'metadata':
      default:
        path = content.storage.metadata_path;
        contentType = 'application/json';
    }
    
    if (!path) {
      return res.status(404).json({ success: false, error: 'Requested format not available' });
    }
    
    // Generate signed URL with short expiration
    const [signedUrl] = await bucket.file(path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });
    
    // Return the signed URL
    return res.status(200).json({
      success: true,
      content_id: contentId,
      content_type: content.content_type,
      format: format,
      url: signedUrl,
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
    });
  } catch (error) {
    Logger.error(`Error retrieving content: ${error}`);
    return res.status(500).json({ success: false, error: 'Failed to retrieve content' });
  }
}
```

## API Routes Configuration

```typescript
// src/routes/v1/index.ts
import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import * as contentController from '../../controllers/v1/content';

const router = Router();

// Knowledge Collection routes
router.post(
  '/tenants/:tenantId/applications/:appId/agents/:agentId/collections',
  authMiddleware,
  contentController.createCollectionController
);

router.post(
  '/tenants/:tenantId/applications/:appId/collections',
  authMiddleware,
  contentController.createCollectionController
);

// Content routes with agent
router.post(
  '/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content',
  authMiddleware,
  contentController.addContentController
);

router.get(
  '/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content',
  authMiddleware,
  contentController.listContentController
);

router.get(
  '/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content/:contentId',
  authMiddleware,
  contentController.getContentController
);

router.get(
  '/tenants/:tenantId/applications/:appId/agents/:agentId/collections/:collectionId/content/:contentId/status',
  authMiddleware,
  contentController.getContentStatusController
);

// Content routes without agent (future structure)
router.post(
  '/tenants/:tenantId/applications/:appId/collections/:collectionId/content',
  authMiddleware,
  contentController.addContentController
);

router.get(
  '/tenants/:tenantId/applications/:appId/collections/:collectionId/content',
  authMiddleware,
  contentController.listContentController
);

router.get(
  '/tenants/:tenantId/applications/:appId/collections/:collectionId/content/:contentId',
  authMiddleware,
  contentController.getContentController
);

router.get(
  '/tenants/:tenantId/applications/:appId/collections/:collectionId/content/:contentId/status',
  authMiddleware,
  contentController.getContentStatusController
);

export default router;
```

## Authentication and Authorization

The API service uses middleware to authenticate requests and verify that the user has access to the requested tenant, application, and agent.

```typescript
// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Logger } from '../lib/logger';

export interface AuthPayload {
  user_id: string;
  team_id: string;
  plan: string;
}

export interface RequestWithAuth<P = {}, ResBody = any, ReqBody = any> extends Request<P, ResBody, ReqBody> {
  auth: AuthPayload;
}

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as AuthPayload;
    
    // Attach the auth payload to the request
    (req as RequestWithAuth).auth = decoded;
    
    // Verify tenant access
    const { tenantId } = req.params;
    if (tenantId && !(await hasAccessToTenant(decoded.user_id, tenantId))) {
      return res.status(403).json({ success: false, error: 'Access denied to tenant' });
    }
    
    next();
  } catch (error) {
    Logger.error(`Auth error: ${error}`);
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

// Helper function to check if a user has access to a tenant
async function hasAccessToTenant(userId: string, tenantId: string): Promise<boolean> {
  // Implement your tenant access check logic here
  // This could query a user_tenants table in PostgreSQL
  return true; // Placeholder
}
```

## Error Handling

The API service implements consistent error handling across all endpoints:

```typescript
// src/lib/error-handler.ts
import { Request, Response, NextFunction } from 'express';
import { Logger } from './logger';

export class ApiError extends Error {
  statusCode: number;
  
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  Logger.error(`Error: ${err.message}`);
  
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message
    });
  }
  
  return res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
};
```

## Environment Variables

The API service requires the following environment variables:

```
# Database
DATABASE_URL=postgres://username:password@hostname:port/database

# Google Cloud Storage
GCS_BUCKET=firecrawl-content
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json

# Airflow
AIRFLOW_API_URL=http://airflow-webserver:8080/api/v1
AIRFLOW_USERNAME=airflow
AIRFLOW_PASSWORD=airflow

# Authentication
JWT_SECRET=your-jwt-secret
```

## API Service Benefits

1. **Consistent Interface**
   - RESTful API design following multi-tenant hierarchy
   - Standardized response format
   - Proper error handling

2. **Secure Access**
   - JWT-based authentication
   - Tenant-level access control
   - Signed URLs for content access

3. **Scalability**
   - Stateless design for horizontal scaling
   - Efficient database connection pooling
   - Asynchronous workflow triggering

4. **Monitoring**
   - Comprehensive logging
   - Request tracing
   - Performance metrics
