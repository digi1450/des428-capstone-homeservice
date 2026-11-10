import {NodeSDK} from '@opentelemetry/sdk-node';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
const key=Symbol.for('edemand.telemetry.sdk');
export function startTelemetry(){
 if(!process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT||globalThis[key])return;
 const sdk=new NodeSDK({serviceName:process.env.OTEL_SERVICE_NAME||'edemand',autoDetectResources:false,
  instrumentations:[],metricReaders:[],logRecordProcessors:[],
  traceExporter:new OTLPTraceExporter({url:process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT})});
 sdk.start();globalThis[key]=sdk;
 const stop=()=>sdk.shutdown().catch(()=>{});
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
