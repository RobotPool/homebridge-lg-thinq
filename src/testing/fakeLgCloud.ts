/**
 * In-memory stand-in for the LG cloud endpoints used during login and token
 * refresh. It is installed as the Axios adapter of `requestClient`, so tests
 * exercise the real interceptors, URL building and header handling.
 *
 * The fake verifies signatures the way LG does: the EMP authorize call must be
 * signed with a key that only the fake signature service knows, over the exact
 * path, query and date of the request it receives. Test-only: excluded from the
 * TypeScript build (tsconfig `exclude`) and from the npm package (`.npmignore`).
 */
import crypto from 'crypto';
import qs from 'qs';
import { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import * as constants from '../lib/constants.js';

export const SPX_BASE = 'https://us.m.lgaccount.com/spx';
export const EMP_BASE = 'https://us.emp.lgaccount.com';
export const OAUTH_BACKEND = 'https://us.lgeapi.com/';

export interface FakeCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

export interface FakeLgOptions {
  username: string;
  password: string;
  /** Key the fake signature service signs with. Never given to the client. */
  empSecret: string;
  accessToken: string;
  refreshToken: string;
  refreshedAccessToken: string;
  loginSessionId: string;
  cookie: string;
}

type Handler = (call: FakeCall, config: InternalAxiosRequestConfig) => { status: number; data: unknown; headers?: Record<string, string> };

export const hmac = (secret: string, message: string) =>
  crypto.createHmac('sha1', Buffer.from(secret)).update(message).digest('base64');

export class FakeLgCloud {
  public calls: FakeCall[] = [];
  public overrides = new Map<string, Handler>();
  private preLoginSignature = 'pre-login-signature';
  private authCode = 'auth-code-123';

  constructor(public options: FakeLgOptions) {}

  public get adapter(): AxiosAdapter {
    return async (config) => this.handle(config);
  }

  public callsTo(path: string) {
    return this.calls.filter(call => call.url.pathname === path);
  }

  private async handle(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
    const url = new URL(config.url as string);
    const headers: Record<string, string> = {};
    const rawHeaders = AxiosHeaders.from(config.headers).toJSON();
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (value !== undefined && value !== null) {
        headers[key.toLowerCase()] = String(value);
      }
    }
    const body = typeof config.data === 'string' ? config.data : config.data === undefined ? '' : JSON.stringify(config.data);
    const call: FakeCall = { method: (config.method || 'get').toUpperCase(), url, headers, body };
    this.calls.push(call);

    const key = `${call.method} ${url.origin}${url.pathname}`;
    const handler = this.overrides.get(key) || this.routes[key];
    const result = handler
      ? handler.call(this, call, config)
      : { status: 404, data: '<!DOCTYPE html><html><head><title>Document</title></head></html>' };

    const response: AxiosResponse = {
      config,
      data: result.data,
      status: result.status,
      statusText: String(result.status),
      headers: { 'set-cookie': [`JSESSIONID=${this.options.cookie}`], ...(result.headers || {}) },
      // looks like a Node ClientRequest that still holds the outgoing headers
      request: { _header: Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') },
    };

    if (result.status >= 200 && result.status < 300) {
      return response;
    }

    throw new AxiosError(
      `Request failed with status code ${result.status}`,
      result.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      response.request,
      response,
    );
  }

  private routes: Record<string, Handler> = {
    [`POST ${SPX_BASE}/preLogin`]: (call) => {
      // LG's AWS load balancer blocks Axios' default User-Agent (Axios adds it when none is set)
      const userAgent = call.headers['user-agent'] || 'axios/1.x';
      if (userAgent.startsWith('axios/')) {
        return { status: 403, data: '<html><head><title>403 Forbidden</title></head></html>', headers: { server: 'awselb/2.0' } };
      }

      const form = qs.parse(call.body);
      const expected = crypto.createHash('sha512').update(this.options.password).digest('hex');
      if (form.user_auth2 !== expected) {
        return { status: 400, data: { error: { code: 'MS.001.16', message: 'Invalid password.' } } };
      }

      return { status: 200, data: { signature: this.preLoginSignature, tStamp: '1793550000', encrypted_pw: 'encrypted-' + expected.slice(0, 8) } };
    },

    [`GET ${SPX_BASE}/searchKey`]: () => ({ status: 404, data: '<!DOCTYPE html><html><head><title>Document</title></head></html>' }),

    [`GET ${SPX_BASE}/signature`]: (call) => {
      const params = call.url.searchParams;
      const message = params.get('timestamp');
      if (params.get('kind') !== 'oauth2' || params.get('key_name') !== 'OAUTH_SECRETKEY' || params.get('sever_type') !== 'OP' || !message) {
        return { status: 400, data: '<html>Bad Request</html>' };
      }

      return { status: 200, data: hmac(this.options.empSecret, message) + '\n', headers: { 'content-type': 'text/plain;charset=UTF-8' } };
    },

    ['GET https://emp-oauth.lgecloud.com/emp/oauth2/authorize/empsession']: (call) => {
      const date = call.headers['lgemp-x-date'];
      const expected = hmac(this.options.empSecret, `${call.url.pathname}${call.url.search}\n${date}`);
      if (call.headers['lgemp-x-signature'] !== expected) {
        return { status: 200, data: { status: 2, message: 'Signature doesn\'t match request.', lgoauth_error_code: 'LG.OAUTH.EC.4001' } };
      }
      if (call.headers['lgemp-x-session-key'] !== this.options.loginSessionId) {
        return { status: 200, data: { status: 2, message: 'EMP processing error.', lgoauth_error_code: 'LG.OAUTH.EC.2002' } };
      }

      const redirect = 'lgaccount.lgsmartthinq:/?' + qs.stringify({
        code: this.authCode,
        user_number: 'US2601010000001',
        oauth2_backend_url: OAUTH_BACKEND,
      });
      return { status: 200, data: { status: 1, redirect_uri: redirect } };
    },

    [`POST ${OAUTH_BACKEND}oauth/1.0/oauth2/token`]: (call) => {
      const expected = hmac(constants.OAUTH_SECRET_KEY, `/oauth/1.0/oauth2/token?${call.body}\n${call.headers['x-lge-oauth-date']}`);
      if (call.headers['x-lge-oauth-signature'] !== expected) {
        return { status: 401, data: { error: { code: 'LG.OAUTH.EC.4001', message: 'Signature doesn\'t match request.' } } };
      }

      const form = qs.parse(call.body);
      if (form.grant_type === 'authorization_code' && form.code === this.authCode) {
        return {
          status: 200,
          data: {
            access_token: this.options.accessToken,
            refresh_token: this.options.refreshToken,
            expires_in: '3600',
            oauth2_backend_url: OAUTH_BACKEND,
          },
        };
      }
      if (form.grant_type === 'refresh_token' && form.refresh_token === this.options.refreshToken) {
        return { status: 200, data: { access_token: this.options.refreshedAccessToken, expires_in: '3600' } };
      }

      return { status: 400, data: { error: 'invalid_grant', error_description: 'The refresh token is invalid.' } };
    },

    ['POST https://kic.lgthinq.com:46030/api/common/gatewayUriList']: () => ({
      status: 200,
      data: { lgedmRoot: { returnCd: '0000', oauthUri: OAUTH_BACKEND.replace(/\/$/, '') } },
    }),
  };

  /** Registers the account session route for the configured user. */
  public withAccount(account: Record<string, unknown> = {}) {
    const path = `${EMP_BASE}/emp/v2.0/account/session/${encodeURIComponent(this.options.username)}`;
    this.overrides.set(`POST ${path}`, (call) => {
      if (call.headers['x-signature'] !== this.preLoginSignature) {
        return { status: 400, data: { error: { code: 'MS.001.01', message: 'Invalid signature.' } } };
      }

      return {
        status: 200,
        data: {
          account: {
            userID: this.options.username,
            userIDType: 'LGE',
            country: 'US',
            loginSessionID: this.options.loginSessionId,
            ...account,
          },
        },
      };
    });

    return this;
  }
}
