import axios, { AxiosInstance } from 'axios';
import {
  ManualProcessNeeded,
  ManualProcessNeededErrorCode,
  MonitorError,
  NotConnectedError,
  TokenExpiredErrorCode,
  TokenExpiredError,
  NotConnectedErrorCodes,
} from '../errors/index.js';
import axiosRetry from 'axios-retry';

const MAX_REQUESTS_COUNT = 1;
const INTERVAL_MS = 10;
let PENDING_REQUESTS = 0;

const releaseRequestSlot = () => {
  PENDING_REQUESTS = Math.max(0, PENDING_REQUESTS - 1);
};

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function responseErrorMessage(err: any, fallback: string): string {
  return stringValue(err.response?.data?.error?.message)
    || stringValue(err.response?.data?.message)
    || stringValue(err.response?.data?.returnMsg)
    || stringValue(err.message)
    || fallback;
}

function errorWithCause<T extends Error>(error: T, cause: unknown): T {
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

/**
 * LG's AWS load balancer in front of the SPX login service rejects POST requests
 * that carry Axios' default `axios/<version>` User-Agent with an HTML 403
 * (nVuln/homebridge-lg-thinq#402). Identify as the HTTP client of the Android
 * ThinQ app instead, which matches the `X-Device-Platform: ADR` headers we send.
 */
export const DEFAULT_USER_AGENT = 'okhttp/4.12.0';

/**
 * Hide request details from errors before they reach logs.
 *
 * Axios errors carry the full request config (headers such as `Authorization`,
 * `x-emp-token`, `x-thinq-token`, form bodies with `refresh_token` or the
 * hashed password), the raw `ClientRequest` and the response headers
 * (`set-cookie`). `util.inspect`, which Homebridge's logger and `console` use,
 * prints every enumerable property, so these fields are made non-enumerable.
 * They stay readable for code that needs them.
 */
export function hideSensitiveRequestDetails<T>(err: T): T {
  const hide = (target: unknown, keys: string[]) => {
    if (target === null || typeof target !== 'object') {
      return;
    }

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor && descriptor.enumerable && descriptor.configurable) {
        Object.defineProperty(target, key, { ...descriptor, enumerable: false });
      }
    }
  };

  hide(err, ['config', 'request']);
  hide((err as { response?: unknown } | null)?.response, ['config', 'request', 'headers']);

  // AxiosError#toJSON serializes the whole request config, so JSON.stringify would bring it back
  if (err !== null && typeof err === 'object' && typeof (err as { toJSON?: unknown }).toJSON === 'function') {
    Object.defineProperty(err, 'toJSON', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function (this: { name?: unknown; message?: unknown; code?: unknown; status?: unknown; response?: { status?: unknown } }) {
        return {
          name: this.name,
          message: this.message,
          code: this.code,
          status: this.response?.status ?? this.status,
        };
      },
    });
  }

  return err;
}

const client = axios.create();
client.defaults.timeout = 60000; // 60s timeout
client.defaults.headers.common['User-Agent'] = DEFAULT_USER_AGENT;

client.interceptors.request.use((config) => {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (PENDING_REQUESTS < MAX_REQUESTS_COUNT) {
        PENDING_REQUESTS++;
        clearInterval(interval);
        resolve(config);
      }
    }, INTERVAL_MS);
  });
});

client.interceptors.response.use((response) => {
  releaseRequestSlot();
  return response;
}, (err) => {
  releaseRequestSlot();
  return Promise.reject(err);
});

axiosRetry(client, {
  retries: 2, // try 3 times
  retryDelay: (retryCount) => {
    return retryCount * 2000;
  },
  retryCondition: (err) => {
    if (err.code?.indexOf('ECONN') === 0) {
      return true;
    }

    return err.response !== undefined && [500, 501, 502, 503, 504].includes(err.response.status);
  },
  shouldResetTimeout: true, // reset timeout each retries
});

client.interceptors.response.use((response) => {
  // thinq1 response
  if (typeof response.data === 'object' && 'lgedmRoot' in response.data && 'returnCd' in response.data.lgedmRoot) {
    const data = response.data.lgedmRoot;
    const code = data.returnCd as string;
    if (NotConnectedErrorCodes.includes(code)) {
      throw new NotConnectedError(data.returnMsg || '');
    } else if (code === TokenExpiredErrorCode) {
      throw new TokenExpiredError(data.returnMsg);
    } else if (code !== '0000') {
      throw new MonitorError(data.returnMsg ? code + ' - ' + data.returnMsg : code);
    }
  }

  return response;
}, (err) => {
  hideSensitiveRequestDetails(err);

  if (!err.response) {
    throw errorWithCause(new NotConnectedError(responseErrorMessage(err, 'Network request failed.')), err);
  } else if (err.response.data?.resultCode === '9999') {
    throw errorWithCause(new NotConnectedError(responseErrorMessage(err, 'ThinQ service is not connected.')), err);
  } else if (err.response.data?.resultCode === TokenExpiredErrorCode) {
    throw errorWithCause(new TokenExpiredError(responseErrorMessage(err, 'ThinQ token expired.')), err);
  } else if (err.response.data?.resultCode === ManualProcessNeededErrorCode) {
    throw errorWithCause(
      new ManualProcessNeeded('Please open the native LG App and sign in to your account to see what happened, ' +
        'maybe new agreement need your accept. Then try restarting Homebridge.'),
      err,
    );
  }
  return Promise.reject(err);
});

export const requestClient = client as AxiosInstance;
