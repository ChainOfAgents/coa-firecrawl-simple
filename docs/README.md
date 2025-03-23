# Firecrawl Architecture Documentation

## Overview

This documentation set outlines the architecture for rearchitecting the Firecrawl web scraping system to utilize Apache Airflow for workflow management, PostgreSQL for metadata storage, and Google Cloud Storage (GCS) for content storage. The design supports a multi-tenant architecture with hierarchical organization of data and various content types.

## Table of Contents

1. [Architecture Overview](architecture-overview.md)
   - System overview
   - Architecture components
   - Multi-tenant data model
   - High-level architecture diagram

2. [Data Model](data-model.md)
   - PostgreSQL database schema
   - JSON structure examples
   - Google Cloud Storage structure
   - Entity relationships

3. [Airflow Integration](airflow-integration.md)
   - Airflow architecture
   - DAG design strategy
   - Content type-specific DAGs
   - Custom operators

4. [API Service](api-service.md)
   - API endpoints structure
   - Controller implementation
   - Authentication and authorization
   - Error handling

5. [Storage Strategy](storage-strategy.md)
   - Storage components
   - Content type storage patterns
   - Google Cloud Storage implementation
   - Content storage service

6. [Implementation Roadmap](implementation-roadmap.md)
   - Phased implementation approach
   - Resource requirements
   - Success metrics
   - Future enhancements

## Key Features

- **Multi-tenant Architecture**: Support for both current (Tenant/Application/Agent/Knowledge_collection) and future (Tenant/Application/Knowledge_collection) hierarchies
- **Content Type Flexibility**: Support for various content types including webpages, PDFs, text files, and website crawls
- **Workflow Management**: Apache Airflow for managing and monitoring content processing workflows
- **Hybrid Storage**: PostgreSQL for metadata and Google Cloud Storage for content data
- **Scalable Design**: Architecture designed for horizontal scaling and performance optimization

## Getting Started

To understand the architecture:

1. Start with the [Architecture Overview](architecture-overview.md) to get a high-level understanding
2. Review the [Data Model](data-model.md) to understand the database schema and storage structure
3. Explore the [Airflow Integration](airflow-integration.md) to learn about workflow management
4. Study the [API Service](api-service.md) to understand the client interface
5. Examine the [Storage Strategy](storage-strategy.md) for details on content storage
6. Follow the [Implementation Roadmap](implementation-roadmap.md) for a phased approach to implementation

## Architecture Diagram

```
┌─────────────────┐
│                 │
│  API Service    │◄────── Client Requests
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐    ┌─────────────────┐
│                 │    │                 │
│  Airflow DAGs   │◄───┤ Content Parser  │
│  & Operators    │    │                 │
│                 │    └─────────────────┘
└────────┬────────┘
         │
         ▼
┌────────────────────────────────────┐
│                                    │
│            Storage Layer           │
│                                    │
├────────────────┬───────────────────┤
│                │                   │
│   PostgreSQL   │   Google Cloud    │
│   (Metadata)   │   Storage (Data)  │
│                │                   │
└────────────────┴───────────────────┘
```
