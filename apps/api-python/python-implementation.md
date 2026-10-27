# Cloud-Based Implementation for Firecrawl Worker

This document outlines how to implement a serverless, cloud-based worker for the Firecrawl application using Google Cloud Platform (GCP) Cloud Functions and Apache Airflow for orchestration.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [GCP Cloud Functions](#gcp-cloud-functions)
3. [Airflow DAG Implementation](#airflow-dag-implementation)
4. [Data Storage](#data-storage)
5. [API Integration](#api-integration)
6. [Deployment and Testing](#deployment-and-testing)

## Architecture Overview

Instead of running a dedicated worker service that polls a Redis queue, this implementation uses:

1. **GCP Cloud Functions** - Serverless functions that handle web scraping tasks
2. **Apache Airflow** - For workflow orchestration, scheduling, and monitoring
3. **Cloud Firestore** - For storing job data and results
4. **Cloud Storage** - For storing larger artifacts like screenshots and HTML content

This architecture provides several advantages:
- Serverless scaling based on demand
- No need to manage worker infrastructure
- Built-in monitoring and logging
- Cost optimization (pay only for what you use)

### System Flow

1. API receives scraping/crawling requests
2. API creates a job record in Firestore
3. Airflow DAG monitors for new jobs and orchestrates the workflow
4. Cloud Functions perform the actual scraping work
5. Results are stored in Firestore/Cloud Storage
6. API can query job status and results directly from Firestore

## GCP Cloud Functions

### 1. Scraper Function

Create a Cloud Function that performs the actual web scraping:

```python
# main.py
import os
import json
import time
import base64
from typing import Dict, Any
import functions_framework
from google.cloud import firestore
from google.cloud import storage
import requests
from bs4 import BeautifulSoup
import html2text
from playwright.sync_api import sync_playwright

# Initialize clients
db = firestore.Client()
storage_client = storage.Client()
bucket_name = os.environ.get('STORAGE_BUCKET', 'firecrawl-content')
bucket = storage_client.bucket(bucket_name)

@functions_framework.http
def scrape_url(request):
    """HTTP Cloud Function that scrapes a URL.
    
    Args:
        request (flask.Request): The request object.
        
    Returns:
        The response text, or any set of values that can be turned into a
        Response object using `make_response`.
    """
    # Parse request data
    request_json = request.get_json(silent=True)
    
    if not request_json or 'job_id' not in request_json or 'url' not in request_json:
        return {'error': 'Invalid request: missing job_id or url'}, 400
    
    job_id = request_json['job_id']
    url = request_json['url']
    scrape_options = request_json.get('scrapeOptions', {})
    formats = scrape_options.get('formats', ['markdown'])
    
    # Update job status
    job_ref = db.collection('jobs').document(job_id)
    job_ref.update({
        'status': 'processing',
        'updated_at': firestore.SERVER_TIMESTAMP,
        'current_url': url
    })
    
    # Perform scraping
    try:
        result = {
            'url': url,
            'formats': {},
            'success': True,
            'timestamp': int(time.time())
        }
        
        # Use Playwright for browser automation
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={'width': 1280, 'height': 800},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            )
            page = context.new_page()
            
            # Navigate to URL
            page.goto(url, wait_until='networkidle', timeout=30000)
            
            # Wait additional time if specified
            if scrape_options.get('waitFor'):
                page.wait_for_timeout(scrape_options['waitFor'])
            
            # Get page content and title
            content = page.content()
            title = page.title()
            result['title'] = title
            
            # Process different formats
            if 'rawHtml' in formats:
                # Store HTML in Cloud Storage
                html_blob = bucket.blob(f'jobs/{job_id}/pages/{base64.b64encode(url.encode()).decode()}.html')
                html_blob.upload_from_string(content, content_type='text/html')
                result['formats']['rawHtml'] = html_blob.public_url
            
            if 'markdown' in formats:
                # Convert HTML to markdown
                h = html2text.HTML2Text()
                h.ignore_links = False
                markdown = h.handle(content)
                
                # Store markdown in Firestore (if small) or Cloud Storage (if large)
                if len(markdown) < 1048576:  # 1MB limit for Firestore
                    result['formats']['markdown'] = markdown
                else:
                    md_blob = bucket.blob(f'jobs/{job_id}/pages/{base64.b64encode(url.encode()).decode()}.md')
                    md_blob.upload_from_string(markdown, content_type='text/markdown')
                    result['formats']['markdown'] = md_blob.public_url
            
            if 'screenshot' in formats:
                # Take screenshot
                screenshot = page.screenshot(full_page=True)
                
                # Store screenshot in Cloud Storage
                screenshot_blob = bucket.blob(f'jobs/{job_id}/pages/{base64.b64encode(url.encode()).decode()}.png')
                screenshot_blob.upload_from_string(screenshot, content_type='image/png')
                result['formats']['screenshot'] = screenshot_blob.public_url
            
            # Clean up
            page.close()
            browser.close()
        
        # Store result in Firestore
        doc_ref = db.collection('jobs').document(job_id).collection('pages').document(base64.b64encode(url.encode()).decode())
        doc_ref.set(result)
        
        # Update job with success
        job_ref.update({
            'pages_completed': firestore.Increment(1),
            'updated_at': firestore.SERVER_TIMESTAMP
        })
        
        return {'success': True, 'result': result}
        
    except Exception as e:
        # Log error and update job
        error_message = str(e)
        job_ref.update({
            'errors': firestore.ArrayUnion([{
                'url': url,
                'error': error_message,
                'timestamp': int(time.time())
            }]),
            'updated_at': firestore.SERVER_TIMESTAMP
        })
        
        return {'success': False, 'error': error_message}, 500
```

### 2. Crawl Initiator Function

Create a function that initiates a crawl job:

```python
# crawl_initiator.py
import os
import json
import time
import uuid
from typing import Dict, Any, List
import functions_framework
from google.cloud import firestore
import requests
from urllib.parse import urlparse, urljoin
from bs4 import BeautifulSoup

# Initialize Firestore client
db = firestore.Client()

@functions_framework.http
def initiate_crawl(request):
    """HTTP Cloud Function that initiates a crawl job.
    
    Args:
        request (flask.Request): The request object.
        
    Returns:
        The response text, or any set of values that can be turned into a
        Response object using `make_response`.
    """
    # Parse request data
    request_json = request.get_json(silent=True)
    
    if not request_json or 'url' not in request_json:
        return {'error': 'Invalid request: missing url'}, 400
    
    url = request_json['url']
    limit = request_json.get('limit', 10)
    scrape_options = request_json.get('scrapeOptions', {})
    exclude_paths = request_json.get('excludePaths', [])
    include_paths = request_json.get('includePaths', [])
    max_depth = request_json.get('maxDepth', 2)
    allow_external_links = request_json.get('allowExternalLinks', False)
    
    # Create a new job
    job_id = str(uuid.uuid4())
    job_data = {
        'id': job_id,
        'url': url,
        'limit': limit,
        'scrapeOptions': scrape_options,
        'excludePaths': exclude_paths,
        'includePaths': include_paths,
        'maxDepth': max_depth,
        'allowExternalLinks': allow_external_links,
        'status': 'pending',
        'pages_completed': 0,
        'pages_total': 0,  # Will be updated by the discovery process
        'created_at': firestore.SERVER_TIMESTAMP,
        'updated_at': firestore.SERVER_TIMESTAMP,
        'expires_at': firestore.SERVER_TIMESTAMP + datetime.timedelta(days=7)
    }
    
    # Save job to Firestore
    db.collection('jobs').document(job_id).set(job_data)
    
    # Return job ID
    return {
        'success': True,
        'id': job_id,
        'url': f"https://{os.environ.get('API_DOMAIN', 'api.firecrawl.dev')}/v1/crawl/{job_id}"
    }
```

### 3. Job Status Function

Create a function to check job status:

```python
# job_status.py
import os
import json
from typing import Dict, Any
import functions_framework
from google.cloud import firestore

# Initialize Firestore client
db = firestore.Client()

@functions_framework.http
def get_job_status(request):
    """HTTP Cloud Function that gets the status of a job.
    
    Args:
        request (flask.Request): The request object.
        
    Returns:
        The response text, or any set of values that can be turned into a
        Response object using `make_response`.
    """
    # Parse request parameters
    job_id = request.path.split('/')[-1]
    skip = request.args.get('skip', default=0, type=int)
    limit = request.args.get('limit', default=20, type=int)
    
    # Get job data
    job_ref = db.collection('jobs').document(job_id)
    job = job_ref.get()
    
    if not job.exists:
        return {'error': 'Job not found'}, 404
    
    job_data = job.to_dict()
    
    # Get pages data with pagination
    pages_query = job_ref.collection('pages').limit(limit).offset(skip)
    pages = [doc.to_dict() for doc in pages_query.stream()]
    
    # Calculate next page URL
    next_url = None
    if len(pages) == limit:
        next_url = f"https://{os.environ.get('API_DOMAIN', 'api.firecrawl.dev')}/v1/crawl/{job_id}?skip={skip + limit}"
    
    # Prepare response
    response = {
        'success': True,
        'status': job_data['status'],
        'completed': job_data['pages_completed'],
        'total': job_data['pages_total'],
        'expiresAt': job_data['expires_at'].isoformat() if 'expires_at' in job_data else None,
        'next': next_url,
        'data': pages
    }
    
    return response
```

## Airflow DAG Implementation

Create an Airflow DAG to orchestrate the crawling process:

```python
# crawl_dag.py
from datetime import datetime, timedelta
from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.providers.google.cloud.operators.functions import CloudFunctionInvokeOperator
from airflow.providers.google.cloud.hooks.firestore import FirestoreHook
from airflow.providers.http.operators.http import SimpleHttpOperator
import json
import requests
from urllib.parse import urlparse, urljoin
from bs4 import BeautifulSoup
import base64

default_args = {
    'owner': 'airflow',
    'depends_on_past': False,
    'email_on_failure': False,
    'email_on_retry': False,
    'retries': 1,
    'retry_delay': timedelta(minutes=5),
}

# Create a DAG that runs every minute to check for new jobs
dag = DAG(
    'firecrawl_processor',
    default_args=default_args,
    description='Process Firecrawl jobs',
    schedule_interval=timedelta(minutes=1),
    start_date=datetime(2025, 1, 1),
    catchup=False,
    tags=['firecrawl'],
)

def get_pending_jobs(**context):
    """Get pending jobs from Firestore."""
    hook = FirestoreHook(project_id='your-gcp-project-id')
    client = hook.get_conn()
    
    # Get jobs with 'pending' status
    query = client.collection('jobs').where('status', '==', 'pending').limit(5)
    jobs = [doc.to_dict() for doc in query.stream()]
    
    if not jobs:
        return []
    
    return jobs

def discover_urls(job_id, base_url, **context):
    """Discover URLs to crawl for a job."""
    hook = FirestoreHook(project_id='your-gcp-project-id')
    client = hook.get_conn()
    
    # Get job data
    job_ref = client.collection('jobs').document(job_id)
    job = job_ref.get().to_dict()
    
    # Parse base URL
    parsed_url = urlparse(base_url)
    base_domain = parsed_url.netloc
    
    # Initialize URL discovery
    to_visit = [base_url]
    discovered = set([base_url])
    urls_to_crawl = []
    
    # Get job parameters
    limit = job.get('limit', 10)
    max_depth = job.get('maxDepth', 2)
    exclude_paths = job.get('excludePaths', [])
    include_paths = job.get('includePaths', [])
    allow_external_links = job.get('allowExternalLinks', False)
    
    # Discover URLs (simplified version)
    current_depth = 0
    
    while to_visit and len(urls_to_crawl) < limit and current_depth <= max_depth:
        current_url = to_visit.pop(0)
        
        try:
            # Fetch page
            response = requests.get(current_url, timeout=10)
            if response.status_code != 200:
                continue
                
            # Parse HTML
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # Find links
            for link in soup.find_all('a', href=True):
                href = link['href']
                absolute_url = urljoin(current_url, href)
                parsed_link = urlparse(absolute_url)
                
                # Apply filters
                if not allow_external_links and parsed_link.netloc != base_domain:
                    continue
                    
                # Check include/exclude paths
                path = parsed_link.path
                if include_paths and not any(path.startswith(include) for include in include_paths):
                    continue
                    
                if any(path.startswith(exclude) for exclude in exclude_paths):
                    continue
                    
                # Add to discovered URLs
                if absolute_url not in discovered:
                    discovered.add(absolute_url)
                    to_visit.append(absolute_url)
                    urls_to_crawl.append(absolute_url)
                    
                    if len(urls_to_crawl) >= limit:
                        break
            
        except Exception as e:
            print(f"Error discovering URLs from {current_url}: {str(e)}")
            
        # Check if we need to increase depth
        if not to_visit and current_depth < max_depth:
            current_depth += 1
    
    # Update job with discovered URLs
    job_ref.update({
        'status': 'discovered',
        'pages_total': len(urls_to_crawl),
        'updated_at': firestore.SERVER_TIMESTAMP
    })
    
    # Store URLs to crawl
    for url in urls_to_crawl:
        url_id = base64.b64encode(url.encode()).decode()
        job_ref.collection('urls_to_crawl').document(url_id).set({
            'url': url,
            'status': 'pending',
            'created_at': firestore.SERVER_TIMESTAMP
        })
    
    return urls_to_crawl

def process_job(job_id, **context):
    """Process a job by triggering scraping for each URL."""
    hook = FirestoreHook(project_id='your-gcp-project-id')
    client = hook.get_conn()
    
    # Get job data
    job_ref = client.collection('jobs').document(job_id)
    job = job_ref.get().to_dict()
    
    # Update job status
    job_ref.update({
        'status': 'processing',
        'updated_at': firestore.SERVER_TIMESTAMP
    })
    
    # Get URLs to crawl
    urls_query = job_ref.collection('urls_to_crawl').where('status', '==', 'pending')
    urls_to_crawl = [doc.to_dict()['url'] for doc in urls_query.stream()]
    
    # Return URLs to be processed by downstream tasks
    return urls_to_crawl

def check_job_completion(job_id, **context):
    """Check if a job is complete."""
    hook = FirestoreHook(project_id='your-gcp-project-id')
    client = hook.get_conn()
    
    # Get job data
    job_ref = client.collection('jobs').document(job_id)
    job = job_ref.get().to_dict()
    
    # Check if all pages are processed
    if job['pages_completed'] >= job['pages_total']:
        # Update job status
        job_ref.update({
            'status': 'completed',
            'updated_at': firestore.SERVER_TIMESTAMP
        })
        
        return True
    
    return False

# Define tasks
get_jobs_task = PythonOperator(
    task_id='get_pending_jobs',
    python_callable=get_pending_jobs,
    provide_context=True,
    dag=dag,
)

# Dynamic task generation based on pending jobs
def generate_job_tasks(job):
    job_id = job['id']
    base_url = job['url']
    
    # Task to discover URLs
    discover_task = PythonOperator(
        task_id=f'discover_urls_{job_id}',
        python_callable=discover_urls,
        op_kwargs={'job_id': job_id, 'base_url': base_url},
        provide_context=True,
        dag=dag,
    )
    
    # Task to process job
    process_task = PythonOperator(
        task_id=f'process_job_{job_id}',
        python_callable=process_job,
        op_kwargs={'job_id': job_id},
        provide_context=True,
        dag=dag,
    )
    
    # Tasks to scrape each URL (will be dynamically generated)
    # This is a placeholder - the actual tasks will be created dynamically
    # based on the output of process_task
    
    # Task to check job completion
    completion_task = PythonOperator(
        task_id=f'check_completion_{job_id}',
        python_callable=check_job_completion,
        op_kwargs={'job_id': job_id},
        provide_context=True,
        dag=dag,
    )
    
    # Set task dependencies
    get_jobs_task >> discover_task >> process_task >> completion_task
    
    return completion_task

# This is a placeholder for dynamic task generation
# In a real implementation, you would use a trigger rule or XCom to pass job data
# between tasks and dynamically generate scraping tasks for each URL
```

## Data Storage

### Firestore Collections Structure

```
jobs/
  {job_id}/
    id: string
    url: string
    limit: number
    scrapeOptions: object
    status: string (pending, discovered, processing, completed, failed)
    pages_completed: number
    pages_total: number
    created_at: timestamp
    updated_at: timestamp
    expires_at: timestamp
    
    pages/
      {url_id}/
        url: string
        title: string
        formats: object
        success: boolean
        timestamp: number
        
    urls_to_crawl/
      {url_id}/
        url: string
        status: string (pending, processing, completed, failed)
        created_at: timestamp
```

### Cloud Storage Structure

```
firecrawl-content/
  jobs/
    {job_id}/
      pages/
        {url_id}.html
        {url_id}.md
        {url_id}.png
```

## API Integration

### 1. Modify Existing API Endpoints

The existing API needs to be modified to work with the new cloud-based architecture:

1. **POST /v1/crawl** - Call the `initiate_crawl` Cloud Function
2. **GET /v1/crawl/{id}** - Call the `get_job_status` Cloud Function

### 2. API Implementation Example

```javascript
// Example of how to modify the existing Node.js API
const express = require('express');
const router = express.Router();
const { Firestore } = require('@google-cloud/firestore');
const axios = require('axios');

const firestore = new Firestore();
const functionsBaseUrl = process.env.FUNCTIONS_BASE_URL || 'https://us-central1-your-project-id.cloudfunctions.net';

// Initiate a crawl
router.post('/crawl', async (req, res) => {
  try {
    // Call the Cloud Function
    const response = await axios.post(`${functionsBaseUrl}/initiate_crawl`, req.body);
    
    // Return the response
    return res.status(200).json(response.data);
  } catch (error) {
    console.error('Error initiating crawl:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate crawl' 
    });
  }
});

// Get crawl status
router.get('/crawl/:id', async (req, res) => {
  try {
    const jobId = req.params.id;
    const skip = req.query.skip || 0;
    
    // Call the Cloud Function
    const response = await axios.get(`${functionsBaseUrl}/get_job_status/${jobId}?skip=${skip}`);
    
    // Return the response
    return res.status(200).json(response.data);
  } catch (error) {
    console.error('Error getting crawl status:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to get crawl status' 
    });
  }
});

module.exports = router;
```

## Deployment and Testing

### 1. Deploying Cloud Functions

```bash
# Deploy the scrape_url function
gcloud functions deploy scrape_url \
  --runtime python39 \
  --trigger-http \
  --allow-unauthenticated \
  --memory 2048MB \
  --timeout 300s \
  --set-env-vars STORAGE_BUCKET=firecrawl-content

# Deploy the initiate_crawl function
gcloud functions deploy initiate_crawl \
  --runtime python39 \
  --trigger-http \
  --allow-unauthenticated \
  --memory 512MB \
  --timeout 60s \
  --set-env-vars API_DOMAIN=api.firecrawl.dev

# Deploy the get_job_status function
gcloud functions deploy get_job_status \
  --runtime python39 \
  --trigger-http \
  --allow-unauthenticated \
  --memory 512MB \
  --timeout 60s \
  --set-env-vars API_DOMAIN=api.firecrawl.dev
```

### 2. Setting Up Airflow on GCP

1. Use Cloud Composer (Google's managed Airflow service)
2. Upload the DAG file to the Cloud Composer environment
3. Configure the necessary connections and variables

### 3. Testing the Implementation

1. **Test the API Integration**:
   ```bash
   curl -X POST https://api.firecrawl.dev/v1/crawl \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer test_api_key_123' \
     -d '{
       "url": "https://docs.firecrawl.dev",
       "limit": 100,
       "scrapeOptions": {
         "formats": ["markdown", "rawHtml"]
       }
     }'
   ```

2. **Monitor the Airflow DAG**:
   - Check the DAG runs in the Cloud Composer UI
   - Verify that tasks are being created and executed

3. **Check Job Status**:
   ```bash
   curl -X GET https://api.firecrawl.dev/v1/crawl/{job_id} \
     -H 'Authorization: Bearer test_api_key_123'
   ```

## Conclusion

This cloud-based implementation leverages GCP Cloud Functions and Airflow for a serverless, scalable architecture that can handle web scraping and crawling tasks efficiently. The use of Firestore and Cloud Storage provides a robust data storage solution, while Airflow orchestrates the workflow to ensure reliable execution.

This approach eliminates the need for dedicated worker services and Redis queues, replacing them with managed cloud services that scale automatically based on demand.
