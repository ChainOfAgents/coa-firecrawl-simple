# Airflow Integration for Firecrawl

## Overview

Apache Airflow will serve as the workflow management system for Firecrawl, replacing the current worker service and BullMQ job queue. This document outlines the Airflow integration architecture, DAG design, and implementation details.

## Airflow Architecture

```
┌─────────────────┐
│                 │
│  API Service    │◄────── Client Requests
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│                 │
│  Airflow API    │
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│                 │
│  Airflow DAGs   │
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Task Operators │
└─────────────────┘
```

### Components:

1. **Airflow Webserver**: Web UI for monitoring and managing workflows
2. **Airflow Scheduler**: Schedules and triggers workflow execution
3. **Airflow Workers**: Execute tasks in the workflows
4. **Airflow Database**: Stores metadata about DAGs, tasks, and executions
5. **Airflow API**: Allows programmatic interaction with Airflow

## DAG Design Strategy

The DAG design follows a dynamic pattern based on the multi-tenant hierarchy:

```
tenant_<tenant_id>_app_<app_id>[_agent_<agent_id>]_<content_type>_processor
```

For example:
- `tenant_123_app_456_agent_789_webpage_processor`
- `tenant_123_app_456_pdf_processor` (future structure without agent)

### DAG Generation

DAGs are dynamically generated based on tenant configurations:

```python
# Helper function to create tenant-specific DAGs
def create_tenant_dag(tenant_id, app_id, agent_id=None, **kwargs):
    """
    Dynamically creates a DAG for a specific tenant hierarchy.
    """
    dag_id = f"tenant_{tenant_id}_app_{app_id}"
    if agent_id:
        dag_id += f"_agent_{agent_id}"
    
    dag_id += f"_{kwargs.get('content_type', 'generic')}_processor"
    
    default_args = {
        'owner': 'firecrawl',
        'depends_on_past': False,
        'email_on_failure': False,
        'email_on_retry': False,
        'retries': 1,
        'retry_delay': timedelta(minutes=5),
        'tenant_id': tenant_id,
        'app_id': app_id,
        'agent_id': agent_id,
    }
    
    with DAG(
        dag_id,
        default_args=default_args,
        description=f'Process content for {dag_id}',
        schedule_interval=None,
        start_date=datetime(2023, 1, 1),
        catchup=False,
        tags=['firecrawl', f'tenant_{tenant_id}', kwargs.get('content_type', 'generic')],
    ) as dag:
        # Task selection based on content type
        if kwargs.get('content_type') == 'webpage':
            # Tasks for single webpage processing
            fetch_task = WebpageFetchOperator(...)
            process_task = HtmlToMarkdownOperator(...)
            store_task = GCSMultiTenantStorageOperator(...)
            
            fetch_task >> process_task >> store_task
            
        elif kwargs.get('content_type') == 'crawl':
            # Tasks for website crawling
            # Similar structure but with crawl-specific operators
            pass
            
        # Add metadata update task at the end
        update_metadata_task = PostgresMetadataOperator(...)
        
        # Connect the last task to metadata update
        if 'store_task' in locals():
            store_task >> update_metadata_task
        
        return dag

# Create DAGs for each tenant/app/agent combination
tenant_configs = Variable.get("tenant_configs", deserialize_json=True)
for config in tenant_configs:
    globals()[f"dag_{config['tenant_id']}_{config['app_id']}_{config.get('content_type', 'generic')}"] = create_tenant_dag(**config)
```

## Content Type-Specific DAGs

### 1. Webpage Processing DAG

```python
def create_webpage_processing_dag(tenant_id, app_id, agent_id=None):
    dag_id = f"tenant_{tenant_id}_app_{app_id}"
    if agent_id:
        dag_id += f"_agent_{agent_id}"
    
    dag_id += "_webpage_processor"
    
    with DAG(...) as dag:
        # Task 1: Fetch webpage
        fetch_task = WebpageFetchOperator(
            task_id='fetch_webpage',
            url="{{ dag_run.conf['url'] }}",
            tenant_id=tenant_id,
            app_id=app_id,
            agent_id=agent_id,
        )
        
        # Task 2: Process HTML to Markdown
        process_task = HtmlToMarkdownOperator(
            task_id='process_webpage',
            tenant_id=tenant_id,
            app_id=app_id,
            agent_id=agent_id,
        )
        
        # Task 3: Store in GCS
        store_task = GCSMultiTenantStorageOperator(
            task_id='store_content',
            tenant_id=tenant_id,
            app_id=app_id,
            agent_id=agent_id,
            collection_id="{{ dag_run.conf['collection_id'] }}",
            content_id="{{ dag_run.conf['content_id'] }}",
            content_type='webpage',
        )
        
        # Task 4: Update metadata in PostgreSQL
        update_metadata_task = PostgresMetadataOperator(
            task_id='update_metadata',
            tenant_id=tenant_id,
            app_id=app_id,
            agent_id=agent_id,
            collection_id="{{ dag_run.conf['collection_id'] }}",
            content_id="{{ dag_run.conf['content_id'] }}",
        )
        
        # Define task dependencies
        fetch_task >> process_task >> store_task >> update_metadata_task
        
        return dag
```

### 2. PDF Processing DAG

```python
def create_pdf_processing_dag(tenant_id, app_id, agent_id=None):
    # Similar structure to webpage processing but with PDF-specific operators
    # ...
    
    # Task 1: Extract text from PDF
    extract_text_task = PDFTextExtractionOperator(...)
    
    # Task 2: Process extracted text
    process_text_task = TextProcessingOperator(...)
    
    # Task 3: Store processed content
    store_task = GCSMultiTenantStorageOperator(...)
    
    # Task 4: Update metadata
    update_metadata_task = PostgresMetadataOperator(...)
    
    # Define task dependencies
    extract_text_task >> process_text_task >> store_task >> update_metadata_task
```

### 3. Crawl Processing DAG

```python
def create_crawl_processing_dag(tenant_id, app_id, agent_id=None):
    # ...
    
    # Task 1: Discover URLs (sitemap or crawl)
    discover_urls_task = DiscoverUrlsOperator(...)
    
    # Task 2: Create scrape tasks for each URL
    create_tasks_task = PythonOperator(
        python_callable=create_scrape_tasks,
        # ...
    )
    
    # Task 3: Wait for all scrape tasks to complete
    wait_for_completion_task = PythonOperator(
        python_callable=wait_for_scrape_tasks,
        # ...
    )
    
    # Task 4: Aggregate results
    aggregate_results_task = PythonOperator(
        python_callable=aggregate_crawl_results,
        # ...
    )
    
    # Task 5: Update metadata
    update_metadata_task = PostgresMetadataOperator(...)
    
    # Define task dependencies
    discover_urls_task >> create_tasks_task >> wait_for_completion_task >> aggregate_results_task >> update_metadata_task
```

## Custom Operators

### 1. GCS Multi-Tenant Storage Operator

```python
class GCSMultiTenantStorageOperator(BaseOperator):
    """
    Operator that stores content in Google Cloud Storage following the multi-tenant hierarchy.
    """
    
    def __init__(
        self,
        tenant_id,
        app_id,
        collection_id,
        content_id,
        content_type,
        agent_id=None,
        *args,
        **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.tenant_id = tenant_id
        self.app_id = app_id
        self.agent_id = agent_id
        self.collection_id = collection_id
        self.content_id = content_id
        self.content_type = content_type
        
    def execute(self, context):
        # Get processed content from XCom
        task_instance = context['task_instance']
        result = task_instance.xcom_pull(task_ids='process_webpage')
        
        # Create GCS client
        storage_client = storage.Client()
        bucket = storage_client.bucket('firecrawl-content')
        
        # Define base path based on tenant hierarchy
        if self.agent_id:
            # Current structure with agent
            base_path = f"tenant_{self.tenant_id}/application_{self.app_id}/agent_{self.agent_id}/collection_{self.collection_id}/"
        else:
            # Future structure without agent
            base_path = f"tenant_{self.tenant_id}/application_{self.app_id}/collection_{self.collection_id}/"
        
        # Store raw content
        raw_path = f"{base_path}raw/{self.content_id}"
        if self.content_type == 'webpage':
            raw_blob = bucket.blob(f"{raw_path}.html")
            raw_blob.upload_from_string(
                result['html'],
                content_type='text/html'
            )
        
        # Store processed content
        processed_path = f"{base_path}processed/{self.content_id}"
        processed_blob = bucket.blob(f"{processed_path}.md")
        processed_blob.upload_from_string(
            result['markdown'],
            content_type='text/markdown'
        )
        
        # Store metadata
        metadata_path = f"{base_path}metadata/{self.content_id}.json"
        metadata_blob = bucket.blob(metadata_path)
        metadata_blob.upload_from_string(
            json.dumps({
                'title': result.get('title', ''),
                'url': result.get('url', ''),
                'processed_at': datetime.now().isoformat(),
                'word_count': len(result['markdown'].split()),
                'content_type': self.content_type,
                'storage_paths': {
                    'raw': f"{raw_path}.html",
                    'processed': f"{processed_path}.md",
                    'metadata': metadata_path
                }
            }),
            content_type='application/json'
        )
        
        # Return the GCS paths for downstream tasks
        return {
            'bucket': 'firecrawl-content',
            'raw_path': f"{raw_path}.html",
            'processed_path': f"{processed_path}.md",
            'metadata_path': metadata_path
        }
```

### 2. PostgreSQL Metadata Operator

```python
class PostgresMetadataOperator(BaseOperator):
    """
    Operator that updates metadata in PostgreSQL.
    """
    
    def __init__(
        self,
        tenant_id,
        app_id,
        collection_id,
        content_id,
        agent_id=None,
        conn_id='postgres_default',
        *args,
        **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.tenant_id = tenant_id
        self.app_id = app_id
        self.agent_id = agent_id
        self.collection_id = collection_id
        self.content_id = content_id
        self.conn_id = conn_id
        
    def execute(self, context):
        # Get processed data from XCom
        task_instance = context['task_instance']
        gcs_paths = task_instance.xcom_pull(task_ids='store_content')
        
        # Connect to PostgreSQL
        conn = psycopg2.connect(os.environ.get('DATABASE_URL'))
        cursor = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        
        try:
            # Update content status and storage paths
            cursor.execute(
                """
                UPDATE knowledge_content 
                SET status = %s, 
                    storage = %s,
                    updated_at = NOW() 
                WHERE id = %s 
                RETURNING *
                """,
                [
                    'completed',
                    json.dumps(gcs_paths),
                    self.content_id
                ]
            )
            
            # Get metadata from GCS
            storage_client = storage.Client()
            bucket = storage_client.bucket(gcs_paths['bucket'])
            metadata_blob = bucket.blob(gcs_paths['metadata_path'])
            metadata_content = json.loads(metadata_blob.download_as_string())
            
            # Update content metadata
            cursor.execute(
                """
                UPDATE knowledge_content 
                SET metadata = %s,
                    updated_at = NOW() 
                WHERE id = %s
                """,
                [
                    json.dumps(metadata_content),
                    self.content_id
                ]
            )
            
            # Commit the transaction
            conn.commit()
            
            return {
                'content_id': self.content_id,
                'status': 'completed',
                'storage_paths': gcs_paths,
                'metadata': metadata_content
            }
            
        except Exception as e:
            conn.rollback()
            self.log.error(f"Error updating PostgreSQL: {e}")
            
            # Update content status to failed
            try:
                cursor.execute(
                    """
                    UPDATE knowledge_content 
                    SET status = %s,
                        updated_at = NOW() 
                    WHERE id = %s
                    """,
                    [
                        'failed',
                        self.content_id
                    ]
                )
                conn.commit()
            except:
                conn.rollback()
                
            raise
            
        finally:
            cursor.close()
            conn.close()
```

## Airflow Client for API Service

```typescript
// src/services/airflow-client.ts
import axios from 'axios';
import { Logger } from '../lib/logger';

export class AirflowClient {
  private baseUrl: string;
  private username: string;
  private password: string;

  constructor() {
    this.baseUrl = process.env.AIRFLOW_API_URL || 'http://localhost:8080/api/v1';
    this.username = process.env.AIRFLOW_USERNAME || 'airflow';
    this.password = process.env.AIRFLOW_PASSWORD || 'airflow';
  }

  private getAuthHeader() {
    const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
    return { Authorization: `Basic ${auth}` };
  }

  async triggerDag(dagId: string, conf: any = {}): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/dags/${dagId}/dagRuns`,
        {
          conf: conf
        },
        {
          headers: {
            ...this.getAuthHeader(),
            'Content-Type': 'application/json'
          }
        }
      );

      Logger.info(`Triggered DAG ${dagId} with run ID ${response.data.dag_run_id}`);
      return response.data.dag_run_id;
    } catch (error) {
      Logger.error(`Error triggering DAG ${dagId}: ${error.message}`);
      throw new Error(`Failed to trigger Airflow DAG: ${error.message}`);
    }
  }

  async getDagRunStatus(dagId: string, dagRunId: string): Promise<any> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/dags/${dagId}/dagRuns/${dagRunId}`,
        {
          headers: this.getAuthHeader()
        }
      );

      return response.data;
    } catch (error) {
      Logger.error(`Error getting DAG run status: ${error.message}`);
      throw new Error(`Failed to get Airflow DAG run status: ${error.message}`);
    }
  }
}
```

## Deployment Considerations

1. **Airflow Infrastructure**
   - Deploy Airflow using Kubernetes or Docker Compose
   - Configure proper resource allocation for workers
   - Set up proper authentication and network security

2. **DAG Deployment**
   - Store DAG definitions in a version-controlled repository
   - Use CI/CD pipelines to deploy DAGs to Airflow
   - Implement testing for DAGs and operators

3. **Monitoring and Logging**
   - Configure Airflow to send logs to a centralized logging system
   - Set up alerts for failed DAGs and tasks
   - Implement metrics collection for performance monitoring
