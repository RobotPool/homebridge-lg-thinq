import { describe, test, expect, afterEach, jest } from '@jest/globals';
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { MonitorError, NotConnectedError } from '../errors/index.js';
import { inspect } from 'util';
import { AxiosError } from 'axios';
import { DEFAULT_USER_AGENT, hideSensitiveRequestDetails, requestClient } from './request.js';

const originalAdapter = requestClient.defaults.adapter;

const responseFor = (config: InternalAxiosRequestConfig, data: unknown = { ok: true }): AxiosResponse => ({
  config,
  data,
  headers: {},
  status: 200,
  statusText: 'OK',
});

const withTimeout = async <T>(promise: Promise<T>): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('request slot was not released')), 1000);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

describe('request client throttling', () => {
  afterEach(() => {
    requestClient.defaults.adapter = originalAdapter;
    jest.restoreAllMocks();
  });

  test('releases the request slot when a ThinQ1 response is translated into an error', async () => {
    let calls = 0;
    const adapter = jest.fn(async (config: InternalAxiosRequestConfig) => {
      calls++;
      if (calls === 1) {
        return responseFor(config, {
          lgedmRoot: {
            returnCd: '0106',
            returnMsg: 'offline',
          },
        });
      }

      return responseFor(config);
    });

    requestClient.defaults.adapter = adapter as AxiosAdapter;

    await expect(requestClient.get('/thinq1-error')).rejects.toThrow(NotConnectedError);
    await expect(withTimeout(requestClient.get('/after-thinq1-error'))).resolves.toMatchObject({ data: { ok: true } });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  test('releases the request slot when a network error is translated into an error', async () => {
    let calls = 0;
    const adapter = jest.fn(async (config: InternalAxiosRequestConfig) => {
      calls++;
      if (calls === 1) {
        throw new Error('socket closed');
      }

      return responseFor(config);
    });

    requestClient.defaults.adapter = adapter as AxiosAdapter;

    await expect(requestClient.get('/network-error')).rejects.toThrow(NotConnectedError);
    await expect(withTimeout(requestClient.get('/after-network-error'))).resolves.toMatchObject({ data: { ok: true } });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  test('preserves unknown ThinQ1 monitor error codes without undefined text', async () => {
    const adapter = jest.fn(async (config: InternalAxiosRequestConfig) => responseFor(config, {
      lgedmRoot: {
        returnCd: '9998',
      },
    }));

    requestClient.defaults.adapter = adapter as AxiosAdapter;

    await expect(requestClient.get('/unknown-thinq1-error')).rejects.toThrow(new MonitorError('9998'));
  });
});

describe('request client headers and error redaction', () => {
  afterEach(() => {
    requestClient.defaults.adapter = originalAdapter;
  });

  test('sends a non-Axios User-Agent by default but keeps an explicit one', async () => {
    const seen: string[] = [];
    requestClient.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      seen.push(String(config.headers.get('User-Agent')));
      return responseFor(config);
    }) as AxiosAdapter;

    await requestClient.post('https://us.m.lgaccount.com/spx/preLogin', 'a=1');
    await requestClient.get('https://aic-service.lgthinq.com:46030/v1/service/homes', { headers: { 'User-Agent': 'okhttp/3.14.9' } });

    expect(seen).toEqual([DEFAULT_USER_AGENT, 'okhttp/3.14.9']);
    expect(DEFAULT_USER_AGENT).not.toMatch(/^axios\//);
  });

  test('errors keep request config readable but out of inspect and JSON output', async () => {
    const secret = 'Bearer redaction-check-token';
    requestClient.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      const response = {
        ...responseFor(config, { resultCode: '9000' }),
        status: 401,
        headers: { 'set-cookie': ['SESSION=redaction-check-cookie'] },
        request: { _header: 'authorization: ' + secret },
      };
      throw new AxiosError('Request failed with status code 401', AxiosError.ERR_BAD_REQUEST, config, response.request, response);
    }) as AxiosAdapter;

    let caught: AxiosError | undefined;
    try {
      await requestClient.post('https://us.lgeapi.com/oauth/1.0/oauth2/token', 'refresh_token=redaction-check-refresh', {
        headers: { Authorization: secret },
      });
    } catch (err) {
      caught = err as AxiosError;
    }

    expect(caught).toBeInstanceOf(AxiosError);
    const output = inspect(caught, { depth: Infinity }) + JSON.stringify(caught) + JSON.stringify({ cause: caught });
    expect(output).toContain('Request failed with status code 401');
    expect(output).toContain('9000');
    for (const value of ['redaction-check-token', 'redaction-check-cookie', 'redaction-check-refresh']) {
      expect(output).not.toContain(value);
    }
    // still available to code that needs it
    expect(caught?.config?.url).toBe('https://us.lgeapi.com/oauth/1.0/oauth2/token');
    expect(caught?.response?.status).toBe(401);
    expect(JSON.parse(JSON.stringify(caught))).toMatchObject({ status: 401, code: AxiosError.ERR_BAD_REQUEST });
  });

  test('hideSensitiveRequestDetails ignores values that are not objects', () => {
    expect(hideSensitiveRequestDetails(null)).toBeNull();
    expect(hideSensitiveRequestDetails('text')).toBe('text');
    const plain = { config: { headers: { Authorization: 'x' } } };
    expect(Object.keys(hideSensitiveRequestDetails(plain))).toEqual([]);
  });
});
