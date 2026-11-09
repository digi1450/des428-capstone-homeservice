// Test-only second SQLite connection. No bootstrap/reset: the parent owns the fixture file.
import {parentPort,workerData} from 'node:worker_threads';
process.env.NODE_ENV='test';
process.env.DB_PATH=workerData.database;
const control=new Int32Array(workerData.control);
const {closeDb}=await import('../lib/db/index.js');
try {
  const {acceptBid}=await import('../lib/modules/bidding/service.js');
  parentPort.postMessage('ready');
  if(Atomics.wait(control,0,0,5000)==='timed-out')throw Error('bid precheck was not reached');
  acceptBid(workerData.jobId,workerData.bidId,workerData.customerId);
  Atomics.store(control,1,1);
} catch(error) {
  Atomics.store(control,1,2);
  parentPort.postMessage({error:error.message});
} finally {
  closeDb();
  Atomics.notify(control,1);
}
