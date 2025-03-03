#!/bin/bash

# Redis connectivity test script
REDIS_IP="10.155.240.35"
REDIS_PORT="6379"

echo "Testing Redis connectivity to $REDIS_IP:$REDIS_PORT..."

# Check if redis-cli is installed
if ! command -v redis-cli &> /dev/null; then
    echo "redis-cli not found. Installing Redis CLI..."
    brew install redis
fi

# Test basic connectivity
echo "Testing PING..."
redis-cli -h $REDIS_IP -p $REDIS_PORT PING

# Check Redis info
echo -e "\nChecking Redis INFO..."
redis-cli -h $REDIS_IP -p $REDIS_PORT INFO | grep -E 'redis_version|connected_clients|used_memory_human|maxmemory_human|maxmemory_policy'

# Check eviction policy
echo -e "\nChecking eviction policy..."
EVICTION_POLICY=$(redis-cli -h $REDIS_IP -p $REDIS_PORT CONFIG GET maxmemory-policy | tail -n 1)
echo "Current eviction policy: $EVICTION_POLICY"

if [ "$EVICTION_POLICY" != "noeviction" ]; then
    echo "WARNING: Eviction policy is $EVICTION_POLICY. It should be 'noeviction' for BullMQ to work properly."
    echo "To fix this, run: redis-cli -h $REDIS_IP -p $REDIS_PORT CONFIG SET maxmemory-policy noeviction"
    echo "To make it persistent: redis-cli -h $REDIS_IP -p $REDIS_PORT CONFIG REWRITE"
fi

# Test job key existence for a specific job ID
if [ -n "$1" ]; then
    JOB_ID=$1
    echo -e "\nChecking for job $JOB_ID in Redis..."
    
    # Check for job in BullMQ
    echo "Checking BullMQ job keys..."
    redis-cli -h $REDIS_IP -p $REDIS_PORT KEYS "*:$JOB_ID*"
    
    # Check job state
    echo -e "\nChecking job state..."
    redis-cli -h $REDIS_IP -p $REDIS_PORT TYPE "{scrapeQueue}:$JOB_ID"
fi

echo -e "\nTesting completed."
