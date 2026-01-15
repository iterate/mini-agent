# MITM Proxy Setup

This document describes how to set up an HTTPS-intercepting MITM proxy for testing and development.

## Overview

The proxy intercepts HTTPS traffic, allowing you to:
- Inject headers on outgoing requests
- Modify response bodies (for text content)
- Log all HTTPS traffic

## Quick Start

```bash
# Start the proxy
bun run test/mitm-proxy.ts

# In another terminal, test it:
export https_proxy=http://localhost:8080
curl --cacert .http-mitm-proxy/certs/ca.pem https://httpbin.org/headers
```

## Client Compatibility

| Client | Works | Notes |
|--------|-------|-------|
| **curl** | ✅ | `--cacert path/to/ca.pem` |
| **wget** | ✅ | `--ca-certificate=path/to/ca.pem` |
| **Python urllib** | ✅ | `ssl.load_verify_locations(ca_path)` |
| **Node.js/Bun** | ✅ | `NODE_EXTRA_CA_CERTS=path/to/ca.pem` |
| **npm** | ✅ | Requires explicit config (see below) |
| **Go http.Client** | ⚠️ | See "Go Compatibility" below |
| **gh CLI** | ⚠️ | Uses Go internally |

## Configuration by Client

### curl

```bash
export https_proxy=http://localhost:8080
curl --cacert .http-mitm-proxy/certs/ca.pem https://example.com
```

### wget

```bash
export HTTPS_PROXY=http://localhost:8080
wget --ca-certificate=.http-mitm-proxy/certs/ca.pem https://example.com
```

### Python

```python
import urllib.request
import ssl

proxy = urllib.request.ProxyHandler({'https': 'http://localhost:8080'})
ctx = ssl.create_default_context()
ctx.load_verify_locations('.http-mitm-proxy/certs/ca.pem')
https = urllib.request.HTTPSHandler(context=ctx)
opener = urllib.request.build_opener(proxy, https)

response = opener.open('https://example.com')
```

### Node.js / Bun

```bash
export NODE_EXTRA_CA_CERTS=.http-mitm-proxy/certs/ca.pem
export https_proxy=http://localhost:8080
node my-script.js
```

Or programmatically with undici:

```typescript
import { ProxyAgent } from 'undici'
import { readFileSync } from 'node:fs'

const dispatcher = new ProxyAgent({
  uri: 'http://localhost:8080',
  requestTls: { ca: readFileSync('.http-mitm-proxy/certs/ca.pem') }
})

const response = await fetch('https://example.com', { dispatcher })
```

### npm

npm ignores `https_proxy` env var. Configure explicitly:

```bash
npm config set proxy http://localhost:8080
npm config set https-proxy http://localhost:8080
npm config set cafile .http-mitm-proxy/certs/ca.pem
npm config set strict-ssl false

npm install some-package
```

To clean up after testing:

```bash
npm config delete proxy https-proxy cafile strict-ssl
```

## Go Compatibility

**Issue:** http-mitm-proxy uses node-forge for certificate generation, which can produce certificates with negative serial numbers. Go's `crypto/x509` package rejects these as invalid.

**Workaround:** Use mkcert for certificate generation:

```bash
# Install mkcert
apt-get install mkcert

# Create CA
CAROOT=.mkcert-ca mkcert -install

# Use mkcert proxy variant
bun run test/mitm-proxy-mkcert.ts

# Set SSL_CERT_FILE for Go clients
export SSL_CERT_FILE=.mkcert-ca/rootCA.pem
export HTTPS_PROXY=http://localhost:8080
```

**Note:** Even with mkcert certs, Go clients may encounter "too many transfer encodings" errors due to HTTP/1.x transport strictness. This is a known limitation.

## System-Wide Trust

To avoid passing CA cert path to every command:

### Linux (Debian/Ubuntu)

```bash
cp .http-mitm-proxy/certs/ca.pem /usr/local/share/ca-certificates/mitm-proxy.crt
update-ca-certificates
```

### macOS

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  .http-mitm-proxy/certs/ca.pem
```

## Response Modification

The proxy uses `Proxy.gunzip` to automatically decompress gzip/deflate responses before modification. Modifies these content types:
- `text/html`
- `text/plain`
- `application/json`

Binary content (images, tarballs) passes through unmodified.

## Files

| File | Purpose |
|------|---------|
| `test/mitm-proxy.ts` | Basic proxy (node-forge certs) |
| `test/mitm-proxy-mkcert.ts` | Proxy with mkcert certs (Go-compatible) |
| `.http-mitm-proxy/certs/` | Auto-generated certificates |
| `.mkcert-ca/` | mkcert CA (if using mkcert variant) |

## Troubleshooting

### "certificate verify failed"
- Ensure CA cert is trusted (system-wide or per-command)
- Check the correct CA path is being used

### npm install fails with Z_DATA_ERROR
- Earlier versions corrupted compressed responses
- Fixed by using `Proxy.gunzip` for automatic decompression

### Go "negative serial number"
- Use mkcert proxy variant instead of default
- Or upgrade to http-mitm-proxy version that fixes node-forge cert generation

### Go "too many transfer encodings"
- Known issue with Go's strict HTTP/1.x parsing
- Workaround: use HTTP/2 where possible
