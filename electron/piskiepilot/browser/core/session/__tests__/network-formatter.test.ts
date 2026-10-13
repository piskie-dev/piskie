import { describe, expect, it, vi } from 'vitest';
import type { HTTPRequest } from 'puppeteer-core';
import { NetworkFormatter } from '../network-formatter.js';
import { request, response } from './observation-fixtures.js';

describe('fixed-source network formatting', () => {
  it('truncates only concise URLs and marks actual DevTools selections', async () => {
    const url = `https://fixture.test/${'x'.repeat(300)}`;
    const formatter = await NetworkFormatter.from(request({ url }), { requestId: 3, selectedInDevToolsUI: true });
    expect(formatter.toString()).toBe(`reqid=3 GET ${url.slice(0, 255)}... <truncated> [pending] [selected in the DevTools Network panel]`);
    expect(formatter.toJSON().url).toBe(url);
    expect(formatter.toStringDetailed()).toContain(url);
  });

  it('retains headers by default and independently truncates body strings at 10,000 characters', async () => {
    const body = 'x'.repeat(10_001);
    const formatter = await NetworkFormatter.from(request({ method: 'POST', body,
      headers: { cookie: 'fixture=value' }, response: response(body) }), { requestId: 2, fetchData: true });
    expect(formatter.toJSONDetailed()).toMatchObject({ requestHeaders: { cookie: 'fixture=value' },
      requestBody: `${body.slice(0, 10_000)}... <truncated>`, responseBody: `${body.slice(0, 10_000)}... <truncated>` });
    expect(formatter.toStringDetailed()).toContain('- set-cookie:fixture=value');
  });

  it.each([
    ['', '<empty response>'], [new Uint8Array([255, 254]), '<binary data>'],
  ])('preserves the response marker for %j', async (body, marker) => {
    const formatter = await NetworkFormatter.from(request({ response: response(body) }), { fetchData: true });
    expect(formatter.toJSONDetailed().responseBody).toBe(marker);
  });

  it('retains unavailable request/response markers for browser-discarded bodies', async () => {
    const req = request({ body: '', response: response('body') });
    vi.spyOn(req.response()!, 'buffer').mockRejectedValue(new Error('fixture response discarded'));
    vi.spyOn(req, 'fetchPostData').mockRejectedValue(new Error('fixture request discarded'));
    vi.spyOn(req, 'postData').mockReturnValue(undefined);
    const formatter = await NetworkFormatter.from(req, { fetchData: true });
    expect(formatter.toJSONDetailed()).toMatchObject({ requestBody: '<Request body not available anymore>', responseBody: '<not available anymore>' });
  });

  it('saves untruncated request text and raw binary response with distinct extensions', async () => {
    const saveFile = vi.fn(async (_data, filename, extension) => ({ filename: filename + extension }));
    const body = 'x'.repeat(10_001); const binary = new Uint8Array([255, 254]);
    const formatter = await NetworkFormatter.from(request({ body, response: response(binary) }), { fetchData: true,
      requestFilePath: 'request-body', responseFilePath: 'response-body', saveFile });
    expect(saveFile).toHaveBeenNthCalledWith(1, Buffer.from(body), 'request-body', '.network-request');
    expect(saveFile).toHaveBeenNthCalledWith(2, Buffer.from(binary), 'response-body', '.network-response');
    expect(formatter.toStringDetailed()).toContain('Saved to request-body.network-request.');
    expect(formatter.toStringDetailed()).toContain('Saved to response-body.network-response.');
  });

  it('propagates request writes but flattens response buffer/write failures as upstream does', async () => {
    const saveFile = vi.fn(async () => { throw new Error('fixture write failure'); });
    await expect(NetworkFormatter.from(request({ body: 'request body' }), { fetchData: true,
      requestFilePath: 'request-body', saveFile })).rejects.toThrow('fixture write failure');
    const formatter = await NetworkFormatter.from(request({ response: response('response body') }), {
      fetchData: true, responseFilePath: 'response-body', saveFile,
    });
    expect(formatter.toJSONDetailed().responseBody).toBe('<Response body not available anymore>');
    const noWriter = await NetworkFormatter.from(request({ response: response('response body') }), { fetchData: true, responseFilePath: 'response-body' });
    expect(noWriter.toJSONDetailed().responseBody).toBe('<Response body not available anymore>');
    await expect(NetworkFormatter.from(request({ body: 'request body' }), { fetchData: true,
      requestFilePath: 'request-body' })).rejects.toThrow('no saveFile callback');
  });

  it('keeps reversed redirect IDs/order identical in text and JSON, and failures readable', async () => {
    const first = request({ url: 'https://fixture.test/first', response: response('', 301) });
    const second = request({ url: 'https://fixture.test/second', response: response('', 302) });
    const ids = new Map<HTTPRequest, number>([[first, 1], [second, 2]]);
    const formatter = await NetworkFormatter.from(request({ failure: 'net::ERR_FIXTURE', redirectChain: [first, second] }), {
      requestId: 3, requestIdResolver: req => ids.get(req)!, fetchData: true,
    });
    expect(formatter.toJSONDetailed().redirectChain?.map(req => req.requestId)).toEqual([2, 1]);
    expect(formatter.toStringDetailed()).toContain('### Request failed with\nnet::ERR_FIXTURE');
    expect(formatter.toStringDetailed()).toContain('reqid=2 GET https://fixture.test/second [302]\n  reqid=1 GET https://fixture.test/first [301]');
  });
});
