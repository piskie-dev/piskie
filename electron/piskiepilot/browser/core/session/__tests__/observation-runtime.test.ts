import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

async function workerResult(filename: string, method: string, params: object): Promise<unknown> {
  const worker = new Worker(new URL(`../../../third_party/devtools-frontend-61277fe/${filename}`, import.meta.url));
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('fixture worker timed out')); }, 5_000);
      worker.on('error', error => { clearTimeout(timer); reject(error); });
      worker.on('message', message => {
        if (message === 'workerReady') { worker.postMessage({ method, params }); return; }
        if (typeof message === 'object' && message && 'event' in message) return;
        clearTimeout(timer); resolve(message);
      });
    });
  } finally { await worker.terminate(); }
}

describe('distributed fixed frontend observation workers', () => {
  it('loads the formatter worker at its product-relative URL and parses JS scopes in Node', async () => {
    const result = await workerResult('formatter-worker.js', 'javaScriptScopeTree', {
      content: 'function fixture(value) { return value + 1; }', sourceType: 'script',
    });
    expect(result).toMatchObject({ kind: 3, variables: [{ name: 'fixture' }],
      children: [{ kind: 2, name: 'fixture', variables: expect.arrayContaining([{ name: 'value', kind: 1, offsets: expect.any(Array) }]) }] });
  });
  it('loads the wasm fallback worker at its product-relative URL and disassembles valid fixture bytes', async () => {
    const result = await workerResult('wasmparser-worker.js', 'disassemble', {
      content: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]).toString('base64'),
    });
    expect(result).toMatchObject({ method: 'disassemble', result: { lines: ['(module', ')'] } });
  });
});
