// Readiness of THIS worker: its subscription/publisher plus its owning migration.
import {createServer} from 'node:http';
export function startWorkerHealth({database,isConnected,port=3000}) {
  let stopping=false;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    res.setHeader('cache-control','no-store');
    if(req.url!=='/health/ready'){res.writeHead(404);res.end('{}');return;}
    try{
      if(stopping||!isConnected())throw Error('not ready');
      await database.checkReady();
      if(stopping||!isConnected())throw Error('not ready');
      res.writeHead(200);res.end('{"status":"ready"}');
    }catch{res.writeHead(503);res.end('{"status":"not_ready"}');}
  });
  server.listen(port,'0.0.0.0');
  return {server,close:()=>{stopping=true;return new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();});}};
}
