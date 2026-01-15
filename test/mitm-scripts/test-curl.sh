#!/bin/bash
# Test MITM proxy with curl
# Args: $1 = proxy port, $2 = CA cert path

set -e

PROXY_PORT="${1:-8080}"
CA_CERT="${2:-.http-mitm-proxy/certs/ca.pem}"

# Test 1: Check injected header via httpbin
RESPONSE=$(https_proxy="http://localhost:$PROXY_PORT" \
  curl -s --cacert "$CA_CERT" https://httpbin.org/headers)

if echo "$RESPONSE" | grep -q "X-Proxy-Injected"; then
  echo "✓ Header injection working"
else
  echo "✗ Header injection failed"
  echo "$RESPONSE"
  exit 1
fi

# Test 2: Check response body modification
RESPONSE=$(https_proxy="http://localhost:$PROXY_PORT" \
  curl -s --cacert "$CA_CERT" https://example.com)

if echo "$RESPONSE" | grep -q "MITM_PROXY_MARKER"; then
  echo "✓ Response modification working"
else
  echo "✗ Response modification failed"
  exit 1
fi

echo "curl tests passed"
