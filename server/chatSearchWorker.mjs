import { parentPort, workerData } from 'node:worker_threads';
import { ChatSearchStore } from './chatSearchStore.mjs';

const store = new ChatSearchStore(workerData.sourcePath, workerData.searchPath);
const sync = () => void store.sync().catch(error => parentPort.postMessage({ warning: String(error) }));
parentPort.on('message', message => {
  try {
    if (message.type === 'sync') { sync(); return; }
    const result = message.type === 'threadHits'
      ? store.searchThreadHits(message.threadId, message.query, message.limit)
      : store.search(message.owners, message.query, message.options);
    parentPort.postMessage({ id: message.id, result });
  } catch (error) { parentPort.postMessage({ id: message.id, error: String(error) }); }
});
sync();
setInterval(sync, 2000).unref();
