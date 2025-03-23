# Firecrawl Architecture: Airflow Integration with PostgreSQL and Google Cloud Storage

## Executive Summary

This document outlines the architecture for rearchitecting the Firecrawl web scraping system to utilize Apache Airflow for workflow management, PostgreSQL for metadata storage, and Google Cloud Storage (GCS) for content storage. The design supports a multi-tenant architecture with hierarchical organization of data and various content types.

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Components](#architecture-components)
3. [Multi-Tenant Data Model](#multi-tenant-data-model)
4. [Storage Strategy](#storage-strategy)
5. [Workflow Management with Airflow](#workflow-management-with-airflow)
6. [API Service Design](#api-service-design)
7. [Security Considerations](#security-considerations)
8. [Deployment Strategy](#deployment-strategy)
9. [Monitoring and Logging](#monitoring-and-logging)
10. [Future Extensibility](#future-extensibility)

## System Overview

The Firecrawl system is being rearchitected to improve scalability, performance, and maintainability. Key changes include:

- Replacing the current worker service with Apache Airflow for workflow management
- Using PostgreSQL for all metadata storage (leveraging existing tenant/application/agent data)
- Storing content data in Google Cloud Storage buckets
- Supporting a multi-tenant hierarchy with flexible content types

### Current vs. Future Architecture

**Current Architecture:**
- API service for client requests
- BullMQ for job queuing
- Worker service for processing jobs
- Firestore for data storage

**Future Architecture:**
- API service for client requests
- Airflow for workflow management and job processing
- PostgreSQL for metadata storage
- Google Cloud Storage for content storage

## Architecture Components

![Architecture Diagram](https://mermaid.ink/img/pako:eNqFkk9rwzAMxb-K0WkdpPkDYYcNtsPGYIUdejG2aILqyMOWYSj97nPSZKVjbBfL0k_vPVmXhDXXhBnLzgTbDdp5rOCNnUMFrXOeKnhGZ9Fq2MHGwPYKXnpnPKqLzWcNW2fQU3VrjXXYwxZbhxU8oFN-qODRGPxADfvOOAcVvKJvUcMBe_QfqGHXGjRUwQs6i_aMGvbGdkTVrfVoTxU8oW_Qn1DDwbiWqLqzHn1_Vf0_-5_qYIwjqh6sxe7Lmf-qHoxriaon9NhdVX-Zx9aaM1H1bHrsvtVX1dEYR1S9WI_2R_2XeTK2JarW6LG_qv4yj8Z1RNUbeuyu6r_Ms7EdUfWOHs2X-g_mRRTJhGdCZCLNRJqKVIpUiCwVaZKIJBbxWCTjOB6N43gUx-NRlIzjcTSKR1GSjJIoTpJRHI_iOE6iJImSKEmSKEmSKEmSKE6TKE6TKE6TKE6TKE6TKE6T6Afz2Mto?type=png)

### Key Components:

1. **API Service**
   - Entry point for client requests
   - Authenticates and authorizes users
   - Triggers Airflow workflows
   - Provides status updates and result retrieval

2. **Apache Airflow**
   - Manages workflow execution
   - Provides DAGs for different content types
   - Handles task scheduling and retry logic
   - Monitors workflow progress

3. **PostgreSQL Database**
   - Stores tenant, application, and agent data
   - Manages knowledge collection metadata
   - Tracks content status and references

4. **Google Cloud Storage**
   - Stores raw content (HTML, PDFs, text files)
   - Stores processed content (Markdown, extracted text)
   - Organizes content in a hierarchical structure

5. **Content Processors**
   - HTML to Markdown converter
   - PDF text extractor
   - Web crawler
   - Text processor

## Multi-Tenant Data Model

The system supports a hierarchical multi-tenant model:

1. **Current Structure:**
   - Tenant → Application → Agent → Knowledge Collection[1-n]

2. **Future Structure:**
   - Tenant → Application → Knowledge Collection[1-n]

Each knowledge collection can contain various content types:
- Single webpage
- Multiple webpages (crawl)
- PDF files
- Text files

See [Data Model](data-model.md) for detailed database schema and relationships.
