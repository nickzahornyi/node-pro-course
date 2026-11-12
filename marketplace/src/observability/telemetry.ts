import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

// Loaded before the application. Manual instrumentation avoids ESM auto-patching races.
export const memoryExporter = process.env.OBS_DEMO === '1' ? new InMemorySpanExporter() : undefined;
const processors = [];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) processors.push(new BatchSpanProcessor(new OTLPTraceExporter({
  url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`,
})));
if (memoryExporter) processors.push(new BatchSpanProcessor(memoryExporter));
export const provider = new NodeTracerProvider({ resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'marketplace' }), spanProcessors: processors });
provider.register({ propagator: new W3CTraceContextPropagator() });
