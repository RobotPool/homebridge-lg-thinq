import { describe, test, beforeEach, afterEach, expect } from '@jest/globals';
import crypto from 'crypto';
import { inspect } from 'util';
import type { Logger } from 'homebridge';
import {
  Auth, BROWSER_LOGIN_REDIRECT_URI, DEFAULT_TOKEN_LIFETIME_SECONDS, EMP_SIGNATURE_PARAMS, parseAuthorizeRedirect,
} from './Auth.js';
import { Gateway } from './Gateway.js';
import { Session } from './Session.js';
import { DEFAULT_USER_AGENT, redactUrlForLog, requestClient } from './request.js';
import { AuthenticationError, NotConnectedError, TokenError } from '../errors/index.js';
import { EMP_BASE, FakeLgCloud, hmac, OAUTH_BACKEND, SPX_BASE } from '../testing/fakeLgCloud.js';

const originalAdapter = requestClient.defaults.adapter;
const originalUserAgent = requestClient.defaults.headers.common['User-Agent'];

// Distinctive values so a leak into errors or logs is easy to detect.
const SECRETS = {
  username: 'leak-check-user@example.com',
  password: 'Pa55-leak-check-password',
  empSecret: 'emp-secret-known-only-to-fake-lg',
  accessToken: 'access-token-leak-check-0001',
  refreshToken: 'refresh-token-leak-check-0002',
  refreshedAccessToken: 'access-token-leak-check-0003',
  loginSessionId: 'login-session-leak-check-0004',
  cookie: 'cookie-leak-check-0005',
};
const PASSWORD_HASH = crypto.createHash('sha512').update(SECRETS.password).digest('hex');

const makeGateway = () => new Gateway({
  empTermsUri: EMP_BASE,
  empSpxUri: SPX_BASE,
  thinq2Uri: 'https://aic-service.lgthinq.com:46030/v1',
  thinq1Uri: 'https://aic.lgthinq.com:46030/api',
  countryCode: 'US',
  languageCode: 'en-US',
});

const makeLogger = (lines: string[]): Logger => {
  const write = (...args: unknown[]) => {
    lines.push(args.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: Infinity }))).join(' '));
  };
  return { debug: write, info: write, warn: write, error: write, log: write, success: write } as unknown as Logger;
};

const expectNoSecrets = (...values: unknown[]) => {
  const text = values.map(value => {
    if (typeof value === 'string') {
      return value;
    }
    let json: string;
    try {
      json = JSON.stringify(value) ?? '';
    } catch {
      json = '';
    }
    return inspect(value, { depth: Infinity, showHidden: false }) + '\n' + json;
  }).join('\n');

  for (const secret of [
    SECRETS.username, SECRETS.password, PASSWORD_HASH, SECRETS.empSecret, SECRETS.accessToken, SECRETS.refreshToken,
    SECRETS.refreshedAccessToken, SECRETS.loginSessionId, SECRETS.cookie,
  ]) {
    expect(text).not.toContain(secret);
  }
};

const captureError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    return err as Error & { code?: string; cause?: unknown };
  }
  throw new Error('expected promise to reject');
};

describe('Auth OAuth flow against a simulated LG cloud', () => {
  let lg: FakeLgCloud;
  let logs: string[];
  let auth: Auth;

  beforeEach(() => {
    lg = new FakeLgCloud(SECRETS).withAccount();
    requestClient.defaults.adapter = lg.adapter;
    logs = [];
    auth = new Auth(makeGateway(), makeLogger(logs));
  });

  afterEach(() => {
    requestClient.defaults.adapter = originalAdapter;
    requestClient.defaults.headers.common['User-Agent'] = originalUserAgent;
  });

  describe('password login', () => {
    test('signs the EMP authorize request through /spx/signature and returns a session', async () => {
      const session = await auth.login(SECRETS.username, SECRETS.password);

      expect(session).toBeInstanceOf(Session);
      expect(session.accessToken).toBe(SECRETS.accessToken);
      expect(session.refreshToken).toBe(SECRETS.refreshToken);
      expect(session.hasValidToken()).toBe(true);
      expect(auth.lgeapi_url).toBe(OAUTH_BACKEND);

      // the removed endpoint is never used
      expect(lg.callsTo('/spx/searchKey')).toHaveLength(0);

      const [signatureCall] = lg.callsTo('/spx/signature');
      expect(signatureCall.method).toBe('GET');
      expect(signatureCall.url.searchParams.get('kind')).toBe(EMP_SIGNATURE_PARAMS.kind);
      expect(signatureCall.url.searchParams.get('key_name')).toBe('OAUTH_SECRETKEY');
      expect(signatureCall.url.searchParams.get('sever_type')).toBe('OP');

      // the string LG signed is exactly the path, query and date of the authorize request
      const [authorizeCall] = lg.callsTo('/emp/oauth2/authorize/empsession');
      expect(signatureCall.url.searchParams.get('timestamp'))
        .toBe(`${authorizeCall.url.pathname}${authorizeCall.url.search}\n${authorizeCall.headers['lgemp-x-date']}`);
      expect(authorizeCall.headers['lgemp-x-signature']).toBe(hmac(SECRETS.empSecret, signatureCall.url.searchParams.get('timestamp')!));
      expect(authorizeCall.headers['lgemp-x-session-key']).toBe(SECRETS.loginSessionId);
      expect(authorizeCall.url.searchParams.get('username')).toBe(SECRETS.username);
      expect(authorizeCall.url.searchParams.get('client_id')).toBe('LGAO221A02');
      expect(authorizeCall.url.searchParams.get('response_type')).toBe('code');
    });

    test('sends a non-Axios User-Agent so the LG load balancer does not answer 403', async () => {
      await auth.login(SECRETS.username, SECRETS.password);

      const [preLogin] = lg.callsTo('/spx/preLogin');
      expect(preLogin.headers['user-agent']).toBe(DEFAULT_USER_AGENT);
      expect(DEFAULT_USER_AGENT.startsWith('axios/')).toBe(false);
    });

    test('reports a 403 from pre-login with context', async () => {
      requestClient.defaults.headers.common['User-Agent'] = 'axios/1.16.0';

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.message).toBe('LG pre-login failed: Request failed with status code 403');
      expect(lg.callsTo('/spx/signature')).toHaveLength(0);
      expectNoSecrets(err, logs);
    });

    test('reports a 404 from the signature service with context', async () => {
      lg.overrides.set(`GET ${SPX_BASE}/signature`, () => ({ status: 404, data: '<!DOCTYPE html><title>Document</title>' }));

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.message).toBe('LG OAuth signature request failed: Request failed with status code 404');
      expect(lg.callsTo('/emp/oauth2/authorize/empsession')).toHaveLength(0);
      expectNoSecrets(err, logs);
    });

    test.each([
      ['an HTML page', '<!DOCTYPE html><html></html>'],
      ['JSON', { returnData: 'abc' }],
      ['an empty body', ''],
      ['a value with spaces', 'not a signature'],
    ])('rejects %s from the signature service', async (_label, data) => {
      lg.overrides.set(`GET ${SPX_BASE}/signature`, () => ({ status: 200, data }));

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.message).toBe('LG OAuth signature request failed: unexpected response from the LG signature service.');
      expect(lg.callsTo('/emp/oauth2/authorize/empsession')).toHaveLength(0);
    });

    test('surfaces a signature mismatch reported by EMP OAuth', async () => {
      // a signature over some other string: EMP must refuse it
      lg.overrides.set(`GET ${SPX_BASE}/signature`, () => ({ status: 200, data: hmac(SECRETS.empSecret, 'other') }));

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(TokenError);
      expect(err.message).toBe('LG OAuth authorization failed: Signature doesn\'t match request.');
      expect(err.code).toBe('LG.OAUTH.EC.4001');
      expectNoSecrets(err, logs);
    });

    test('surfaces an EMP processing error code', async () => {
      lg.withAccount({ loginSessionID: 'expired-session' });

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(TokenError);
      expect(err.message).toBe('LG OAuth authorization failed: EMP processing error.');
      expect(err.code).toBe('LG.OAUTH.EC.2002');
    });

    test('rejects an account response without a login session', async () => {
      lg.withAccount({ loginSessionID: undefined });

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.message).toBe('LG account login failed: response did not include a login session.');
      expect(lg.callsTo('/spx/signature')).toHaveLength(0);
    });

    test('reports a wrong password from the account step', async () => {
      const err = await captureError(auth.login(SECRETS.username, 'wrong-password'));

      expect(err).toBeInstanceOf(AuthenticationError);
      expect(lg.callsTo('/spx/signature')).toHaveLength(0);
      expectNoSecrets(err, logs);
    });

    test('uses the default token lifetime when expires_in is missing', async () => {
      lg.overrides.set(`POST ${OAUTH_BACKEND}oauth/1.0/oauth2/token`, () => ({
        status: 200,
        data: { access_token: SECRETS.accessToken, refresh_token: SECRETS.refreshToken },
      }));
      const before = Math.round(Date.now() / 1000);

      const session = await auth.login(SECRETS.username, SECRETS.password);

      expect(session.hasValidToken()).toBe(true);
      const expiry = (session as unknown as { expiresIn: number }).expiresIn;
      expect(expiry - before).toBeGreaterThanOrEqual(DEFAULT_TOKEN_LIFETIME_SECONDS - 2);
      expect(expiry - before).toBeLessThanOrEqual(DEFAULT_TOKEN_LIFETIME_SECONDS + 2);
    });

    test('rejects a token response without tokens', async () => {
      lg.overrides.set(`POST ${OAUTH_BACKEND}oauth/1.0/oauth2/token`, () => ({ status: 200, data: { status: 1 } }));

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(TokenError);
      expect(err.message).toBe('LG token exchange failed: response did not include access and refresh tokens.');
    });

    test('reports a failed token exchange with context', async () => {
      lg.overrides.set(`POST ${OAUTH_BACKEND}oauth/1.0/oauth2/token`, () => ({
        status: 401,
        data: { error: { code: 'LG.OAUTH.EC.4001', message: 'Signature doesn\'t match request.' } },
      }));

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.message).toBe('LG token exchange failed: Signature doesn\'t match request.');
      expectNoSecrets(err, logs);
    });

    test('maps network failures during login to an authentication error with context', async () => {
      lg.overrides.set(`GET ${SPX_BASE}/signature`, (_call, config) => {
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', config, isAxiosError: true });
      });

      const err = await captureError(auth.login(SECRETS.username, SECRETS.password));

      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.message).toBe('LG OAuth signature request failed: socket hang up');
      expect(err.cause).toBeInstanceOf(NotConnectedError);
      expectNoSecrets(err, logs);
    }, 15000);
  });

  describe('token refresh', () => {
    test('refreshes the access token with the locally signed OAuth request', async () => {
      const session = new Session('expired-access', SECRETS.refreshToken, 0);

      const refreshed = await auth.refreshNewToken(session);

      expect(refreshed).toBe(session);
      expect(refreshed.accessToken).toBe(SECRETS.refreshedAccessToken);
      expect(refreshed.refreshToken).toBe(SECRETS.refreshToken);
      expect(refreshed.hasValidToken()).toBe(true);
      // refresh does not depend on the SPX key services
      expect(lg.callsTo('/spx/signature')).toHaveLength(0);
      expect(lg.callsTo('/spx/searchKey')).toHaveLength(0);
      const [tokenCall] = lg.callsTo('/oauth/1.0/oauth2/token');
      expect(tokenCall.headers['user-agent']).toBe(DEFAULT_USER_AGENT);
    });

    test('still refreshes when the gateway lookup fails', async () => {
      lg.overrides.set('POST https://kic.lgthinq.com:46030/api/common/gatewayUriList', () => ({ status: 404, data: '' }));
      auth.lgeapi_url = OAUTH_BACKEND;

      const refreshed = await auth.refreshNewToken(new Session('', SECRETS.refreshToken, 0));

      expect(refreshed.accessToken).toBe(SECRETS.refreshedAccessToken);
    });

    test('keeps the current backend when the gateway reply has no oauthUri', async () => {
      lg.overrides.set('POST https://kic.lgthinq.com:46030/api/common/gatewayUriList', () => ({
        status: 200,
        data: { lgedmRoot: { returnCd: '0000' } },
      }));
      auth.lgeapi_url = OAUTH_BACKEND;

      const refreshed = await auth.refreshNewToken(new Session('', SECRETS.refreshToken, 0));

      expect(refreshed.accessToken).toBe(SECRETS.refreshedAccessToken);
      expect(auth.lgeapi_url).toBe(OAUTH_BACKEND);
      expect(lg.callsTo('/oauth/1.0/oauth2/token')[0].url.origin).toBe('https://us.lgeapi.com');
    });

    test('reports an invalid refresh token as a token error', async () => {
      const err = await captureError(auth.refreshNewToken(new Session('', 'revoked-refresh-token', 0)));

      expect(err).toBeInstanceOf(TokenError);
      expect(err.message).toBe('LG token refresh failed: The refresh token is invalid.');
      expectNoSecrets(err, logs);
    });

    test('rejects a refresh response without an access token', async () => {
      lg.overrides.set(`POST ${OAUTH_BACKEND}oauth/1.0/oauth2/token`, () => ({ status: 200, data: { expires_in: '3600' } }));
      const session = new Session('old-access', SECRETS.refreshToken, 0);
      // a refresh response must carry an access token even though expires_in has a default

      const err = await captureError(auth.refreshNewToken(session));

      expect(err).toBeInstanceOf(TokenError);
      expect(err.message).toBe('LG token refresh failed: response did not include a new access token.');
      expect(session.accessToken).toBe('old-access');
    });

    test('keeps network failures as NotConnectedError so callers can retry', async () => {
      lg.overrides.set(`POST ${OAUTH_BACKEND}oauth/1.0/oauth2/token`, (_call, config) => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND us.lgeapi.com'), { code: 'ENOTFOUND', config, isAxiosError: true });
      });

      const err = await captureError(auth.refreshNewToken(new Session('', SECRETS.refreshToken, 0)));

      expect(err).toBeInstanceOf(NotConnectedError);
      expectNoSecrets(err, logs);
    });
  });
});

describe('browser login code exchange (thinq auth)', () => {
  let lg: FakeLgCloud;

  beforeEach(() => {
    lg = new FakeLgCloud(SECRETS);
    requestClient.defaults.adapter = lg.adapter;
  });

  afterEach(() => {
    requestClient.defaults.adapter = originalAdapter;
  });

  test('exchanges the code from the iabClose redirect for tokens', async () => {
    const auth = new Auth(makeGateway());
    const callback = BROWSER_LOGIN_REDIRECT_URI + '?code=auth-code-123&user_number=US1&oauth2_backend_url='
      + encodeURIComponent(OAUTH_BACKEND);

    const redirect = parseAuthorizeRedirect(callback);
    const session = await auth.exchangeAuthorizationCode(redirect.code, redirect.backendUrl, BROWSER_LOGIN_REDIRECT_URI);

    expect(session.refreshToken).toBe(SECRETS.refreshToken);
    const [tokenCall] = lg.callsTo('/oauth/1.0/oauth2/token');
    expect(new URLSearchParams(tokenCall.body).get('redirect_uri')).toBe(BROWSER_LOGIN_REDIRECT_URI);
    // the browser path never touches the SPX key services
    expect(lg.callsTo('/spx/signature')).toHaveLength(0);
  });

  test('reports an expired or reused code', async () => {
    const auth = new Auth(makeGateway());

    const err = await captureError(auth.exchangeAuthorizationCode('used-code', OAUTH_BACKEND, BROWSER_LOGIN_REDIRECT_URI));

    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err.message).toBe('LG token exchange failed: The refresh token is invalid.');
  });
});

describe('redactUrlForLog', () => {
  test('drops query strings and the account id in the session path', () => {
    expect(redactUrlForLog(`${SPX_BASE}/signature?kind=oauth2&timestamp=%2Femp%3Fusername%3Da%40b.c`))
      .toBe(`${SPX_BASE}/signature`);
    expect(redactUrlForLog(`${EMP_BASE}/emp/v2.0/account/session/a%40b.c`))
      .toBe(`${EMP_BASE}/emp/v2.0/account/session/<redacted>`);
    expect(redactUrlForLog(undefined)).toBe('');
  });
});

describe('parseAuthorizeRedirect', () => {
  test('reads the code and backend URL', () => {
    expect(parseAuthorizeRedirect('lgaccount.lgsmartthinq:/?code=abc&oauth2_backend_url=https%3A%2F%2Fus.lgeapi.com%2F'))
      .toEqual({ code: 'abc', backendUrl: 'https://us.lgeapi.com/' });
  });

  test('accepts a redirect URI that was percent-encoded twice', () => {
    const inner = 'https://kr.m.lgaccount.com/login/iabClose?code=xyz&oauth2_backend_url=https%3A%2F%2Feic.lgthinq.com%2F';
    expect(parseAuthorizeRedirect(encodeURIComponent(inner))).toEqual({ code: 'xyz', backendUrl: 'https://eic.lgthinq.com/' });
  });

  test('adds a trailing slash to the backend URL', () => {
    expect(parseAuthorizeRedirect('lgaccount.lgsmartthinq:/?code=a&oauth2_backend_url=https%3A%2F%2Fus.lgeapi.com').backendUrl)
      .toBe('https://us.lgeapi.com/');
  });

  test('allows a missing backend URL', () => {
    expect(parseAuthorizeRedirect('lgaccount.lgsmartthinq:/?code=a')).toEqual({ code: 'a', backendUrl: null });
  });

  test('rejects a redirect without a code', () => {
    expect(() => parseAuthorizeRedirect('lgaccount.lgsmartthinq:/?state=12345')).toThrow(TokenError);
    expect(() => parseAuthorizeRedirect('not a url')).toThrow('redirect did not include an authorization code');
  });

  test('rejects a backend URL that is not HTTPS', () => {
    expect(() => parseAuthorizeRedirect('lgaccount.lgsmartthinq:/?code=a&oauth2_backend_url=http%3A%2F%2Fevil.example%2F'))
      .toThrow('invalid oauth2_backend_url');
  });
});
