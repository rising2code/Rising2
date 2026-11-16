// Worker thread: builds one navigation map so the editor window stays responsive.
import { parentPort, workerData } from 'node:worker_threads';
import { buildNavmesh } from './navbuild.mjs';

let last = 0;
try {
  const result = await buildNavmesh(workerData, (done, total) => {
    const now = Date.now();
    if (now - last > 200 || done === total) { last = now; parentPort.postMessage({ progress: [done, total] }); }
  });
  parentPort.postMessage({ result });
} catch (e) {
  parentPort.postMessage({ error: e.stack || String(e) });
}
