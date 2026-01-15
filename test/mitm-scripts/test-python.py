#!/usr/bin/env python3
"""Test MITM proxy with Python urllib."""

import json
import ssl
import sys
import urllib.request


def main():
    proxy_port = sys.argv[1] if len(sys.argv) > 1 else "8080"
    ca_cert = sys.argv[2] if len(sys.argv) > 2 else ".http-mitm-proxy/certs/ca.pem"

    # Set up proxy and SSL context
    proxy_handler = urllib.request.ProxyHandler(
        {"https": f"http://localhost:{proxy_port}"}
    )
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(ca_cert)
    https_handler = urllib.request.HTTPSHandler(context=ctx)
    opener = urllib.request.build_opener(proxy_handler, https_handler)

    # Test 1: Header injection
    response = opener.open("https://httpbin.org/headers")
    data = json.loads(response.read().decode())

    if "X-Proxy-Injected" in data.get("headers", {}):
        print("✓ Header injection working")
    else:
        print("✗ Header injection failed")
        print(data)
        sys.exit(1)

    # Test 2: Response modification
    response = opener.open("https://example.com")
    body = response.read().decode()

    if "MITM_PROXY_MARKER" in body:
        print("✓ Response modification working")
    else:
        print("✗ Response modification failed")
        sys.exit(1)

    print("Python tests passed")


if __name__ == "__main__":
    main()
