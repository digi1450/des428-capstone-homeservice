// The single wrapper every route handler is built with. It derives a request id, runs the handler,
// stamps X-Request-Id on whatever response comes back, and funnels any thrown error through
// toResponse so status + body + logging stay uniform. This is the App Router analogue of Ride's
// requestId + errorHandler middleware pair.
import { requestId } from "./requestId.js";
import { toResponse } from "./respond.js";
import {requestSpan,traceFields} from '../telemetry/context.js';
import {logger} from '../logger.js';

export function handle(fn) {
  return async (req, ctx = {}) => {
    const id = requestId(req);
    return requestSpan(req,id,async span=>{
    const start=performance.now();let status=500;
    try {
      const res = await fn(req, ctx, id);
      status=res?.status??500;
      if (res && res.headers && !res.headers.get("X-Request-Id")) {
        res.headers.set("X-Request-Id", id);
      }
      return res;
    } catch (err) {
      const res=toResponse(err,id);status=res.status;return res;
    } finally {
      span.setAttribute('http.response.status_code',status);
      if(status>=500)span.setStatus({code:2});
      logger.info({event:'http_request',...traceFields(),method:req.method,path:new URL(req.url).pathname,statusCode:status,durationMs:Math.round((performance.now()-start)*100)/100},'http request');
    }
    });
  };
}
