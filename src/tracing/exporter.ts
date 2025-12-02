/**
 * Custom Fetch-based OTLP Exporter
 *
 * Bun-compatible OTLP exporter with better error logging than the default.
 */
import { diag } from "@opentelemetry/api"
import { type ExportResult, ExportResultCode } from "@opentelemetry/core"
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer"
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base"

export interface FetchExporterOptions {
  name: string
  url: string
  headers: Record<string, string>
}

export class FetchOtlpExporter implements SpanExporter {
  private readonly name: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly serializer = JsonTraceSerializer

  constructor(options: FetchExporterOptions) {
    this.name = options.name
    this.url = options.url
    this.headers = {
      ...options.headers,
      "Content-Type": "application/json"
    }
    diag.info(`[${this.name}] Configured exporter → ${this.url}`)
  }

  export(spans: Array<ReadableSpan>, resultCallback: (result: ExportResult) => void): void {
    const body = this.serializer.serializeRequest(spans)
    if (!body) {
      diag.error(`[${this.name}] Failed to serialize ${spans.length} spans`)
      resultCallback({ code: ExportResultCode.FAILED })
      return
    }

    fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body
    })
      .then(async (response) => {
        if (response.ok) {
          diag.debug(`[${this.name}] Successfully exported ${spans.length} spans`)
          resultCallback({ code: ExportResultCode.SUCCESS })
        } else {
          const text = await response.text().catch(() => "(no body)")
          console.error(`[${this.name}] Export failed: HTTP ${response.status} - ${text}`)
          diag.error(`[${this.name}] Export failed: HTTP ${response.status} - ${text}`)
          resultCallback({ code: ExportResultCode.FAILED })
        }
      })
      .catch((error) => {
        console.error(`[${this.name}] Export error:`, error)
        diag.error(`[${this.name}] Export error: ${error}`)
        resultCallback({ code: ExportResultCode.FAILED })
      })
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

