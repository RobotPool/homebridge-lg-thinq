import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import { inspect } from 'util';
import type { Logger } from 'homebridge';
import { API } from './API.js';
import * as constants from './constants.js';
import { requestClient } from './request.js';
import { EMP_BASE, FakeLgCloud, OAUTH_BACKEND, SPX_BASE } from '../testing/fakeLgCloud.js';

const originalAdapter = requestClient.defaults.adapter;

const SECRETS = {
  username: 'api-leak-check@example.com',
  password: 'api-leak-check-password',
  empSecret: 'api-emp-secret',
  accessToken: 'api-access-token-0001',
  refreshToken: 'api-refresh-token-0002',
  refreshedAccessToken: 'api-access-token-0003',
  loginSessionId: 'api-login-session-0004',
  cookie: 'api-cookie-0005',
};

const THINQ2 = 'https://aic-service.lgthinq.com:46030/v1';
const THINQ1 = 'https://aic.lgthinq.com:46030/api';

const routeKey = (method: string, url: string) => {
  const parsed = new URL(url);
  return `${method} ${parsed.origin}${parsed.pathname}`;
};

/** Adds the gateway, ThinQ1 session, profile and device list routes used by API.ready(). */
const withThinQServices = (lg: FakeLgCloud) => {
  lg.overrides.set(routeKey('GET', constants.GATEWAY_URL), () => ({
    status: 200,
    data: {
      resultCode: '0000',
      result: {
        empTermsUri: EMP_BASE,
        empSpxUri: SPX_BASE,
        thinq2Uri: THINQ2,
        thinq1Uri: THINQ1,
        countryCode: 'US',
        languageCode: 'en-US',
      },
    },
  }));
  lg.overrides.set(`POST ${THINQ1}/member/login`, () => ({
    status: 200,
    data: { lgedmRoot: { returnCd: '0000', jsessionId: 'jsession-1' } },
  }));
  lg.overrides.set(`GET ${OAUTH_BACKEND}users/profile`, (call) => {
    const token = call.headers.authorization;
    if (token !== `Bearer ${SECRETS.accessToken}` && token !== `Bearer ${SECRETS.refreshedAccessToken}`) {
      return { status: 200, data: { status: 2, message: 'Invalid token.' } };
    }
    return { status: 200, data: { status: 1, account: { userNo: 'US2601010000001' } } };
  });
  lg.overrides.set(`GET ${THINQ2}/service/homes`, () => ({
    status: 200,
    data: { resultCode: '0000', result: { item: [{ homeId: 'home-1' }] } },
  }));
  return lg;
};

const makeLogger = (lines: string[]): Logger => {
  const write = (...args: unknown[]) => {
    lines.push(args.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: Infinity }))).join(' '));
  };
  return { debug: write, info: write, warn: write, error: write, log: write, success: write } as unknown as Logger;
};

describe('API authentication with a simulated LG cloud', () => {
  let lg: FakeLgCloud;
  let logs: string[];

  beforeEach(() => {
    lg = withThinQServices(new FakeLgCloud(SECRETS).withAccount());
    requestClient.defaults.adapter = lg.adapter;
    logs = [];
  });

  afterEach(() => {
    requestClient.defaults.adapter = originalAdapter;
  });

  test('account mode: ready() logs in with username and password', async () => {
    const api = new API('US', 'en-US', makeLogger(logs));
    api.setUsernamePassword(SECRETS.username, SECRETS.password);

    await api.ready();

    expect(lg.callsTo('/spx/signature')).toHaveLength(1);
    expect(lg.callsTo('/spx/searchKey')).toHaveLength(0);
    expect(lg.callsTo('/users/profile')).toHaveLength(1);
    expect(api.client_id).toMatch(/^[0-9a-f]{64}$/);
  });

  test('token mode: ready() refreshes the configured refresh token without password login', async () => {
    const api = new API('US', 'en-US', makeLogger(logs));
    api.setRefreshToken(SECRETS.refreshToken);

    await api.ready();

    expect(lg.callsTo('/spx/preLogin')).toHaveLength(0);
    expect(lg.callsTo('/spx/signature')).toHaveLength(0);
    const profile = lg.callsTo('/users/profile')[0];
    expect(profile.headers.authorization).toBe(`Bearer ${SECRETS.refreshedAccessToken}`);
  });

  test('an expired access token is refreshed once and the request is retried', async () => {
    let homeCalls = 0;
    lg.overrides.set(`GET ${THINQ2}/service/homes/home-1`, (call) => {
      homeCalls++;
      // the first call reports the token as expired; the retry must carry a refreshed token
      if (homeCalls === 1 || call.headers['x-emp-token'] !== SECRETS.refreshedAccessToken) {
        return { status: 400, data: { resultCode: '0102', result: 'token expired' } };
      }
      return { status: 200, data: { resultCode: '0000', result: { devices: [{ deviceId: 'washer-1', deviceType: 201 }] } } };
    });

    const api = new API('US', 'en-US', makeLogger(logs));
    api.setUsernamePassword(SECRETS.username, SECRETS.password);
    await api.ready();

    const devices = await api.getListDevices();

    expect(devices).toEqual([{ deviceId: 'washer-1', deviceType: 201 }]);
    expect(homeCalls).toBe(2);
    expect(lg.callsTo('/oauth/1.0/oauth2/token').map(call => new URLSearchParams(call.body).get('grant_type')))
      // login, the refresh ready() always does, then the refresh triggered by the expired token
      .toEqual(['authorization_code', 'refresh_token', 'refresh_token']);
  });

  test('a rejected refresh token fails ready() with a clear message and no secrets in logs', async () => {
    const api = new API('US', 'en-US', makeLogger(logs));
    api.setRefreshToken('revoked-refresh-token');

    let caught: unknown;
    try {
      await api.ready();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('LG token refresh failed: The refresh token is invalid.');
    const text = logs.join('\n') + inspect(caught, { depth: Infinity }) + JSON.stringify(caught);
    for (const secret of ['revoked-refresh-token', SECRETS.cookie, constants.API_KEY]) {
      expect(text).not.toContain(secret);
    }
  });

  test('request errors logged by the API do not contain tokens, cookies or the password', async () => {
    lg.overrides.set(`GET ${THINQ2}/service/homes/home-1`, () => ({ status: 500, data: { resultCode: '9000', result: 'boom' } }));

    const api = new API('US', 'en-US', makeLogger(logs));
    api.setUsernamePassword(SECRETS.username, SECRETS.password);
    await api.ready();

    await expect(api.getListDevices()).rejects.toThrow();

    const text = logs.join('\n');
    expect(text).toContain('Request failed with status code 500');
    for (const secret of [
      SECRETS.password, SECRETS.accessToken, SECRETS.refreshToken, SECRETS.refreshedAccessToken,
      SECRETS.loginSessionId, SECRETS.cookie, constants.API_KEY,
    ]) {
      expect(text).not.toContain(secret);
    }
  }, 20000);
});
