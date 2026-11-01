// Modified by the RobotPool maintainers (https://github.com/RobotPool/homebridge-lg-thinq):
// see NOTICE and the git history for the changes made to this file.
import crypto from 'crypto';
import { DateTime } from 'luxon';
import qs from 'qs';
import { URL } from 'url';
import {
  AuthenticationError,
  ManualProcessNeededErrorCode,
  NotConnectedError,
  TokenError,
  TokenExpiredError,
} from '../errors/index.js';
import * as constants from './constants.js';
import { Gateway } from './Gateway.js';
import { requestClient } from './request.js';
import { Session } from './Session.js';
import { Logger } from 'homebridge';
import { createNoopLogger } from './noopLogger.js';

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (typeof value === 'number') {
    return value.toString();
  }

  return null;
}

function authResponseData(err: unknown): Record<string, unknown> | null {
  const response = recordValue(err)?.response;
  return recordValue(recordValue(response)?.data);
}

function errorCause(err: unknown): unknown {
  return recordValue(err)?.cause;
}

export function authErrorCode(err: unknown): string | null {
  const data = authResponseData(err);
  const error = recordValue(data?.error);

  return stringValue(error?.code)
    || stringValue(data?.resultCode)
    || stringValue(recordValue(err)?.code)
    || (errorCause(err) ? authErrorCode(errorCause(err)) : null);
}

export function authErrorMessage(err: unknown, fallback: string): string {
  const data = authResponseData(err);
  const error = recordValue(data?.error);

  return stringValue(error?.message)
    || stringValue(data?.message)
    || stringValue(data?.error_description)
    || stringValue(data?.returnMsg)
    || (err instanceof Error ? stringValue(err.message) : null)
    || (errorCause(err) ? authErrorMessage(errorCause(err), fallback) : null)
    || fallback;
}

function authError<T extends Error>(
  context: string,
  err: unknown,
  ErrorClass: new (message: string) => T = AuthenticationError as unknown as new (message: string) => T,
): T {
  const message = authErrorMessage(err, 'Request failed.');
  const error = new ErrorClass(`${context}: ${message}`);
  (error as Error & { cause?: unknown }).cause = err;

  return error;
}

/**
 * EMP OAuth endpoint that turns an LG account login session into an
 * authorization code. Requests to it are signed with the `OAUTH_SECRETKEY`
 * of LG's SPX login service.
 */
export const EMP_OAUTH_AUTHORIZE_URL = 'https://emp-oauth.lgecloud.com/emp/oauth2/authorize/empsession';

/**
 * Redirect URI that LG accepts for the browser login used by `thinq auth`
 * (nVuln/homebridge-lg-thinq#402, ollo69/ha-smartthinq-sensors#1016).
 */
export const BROWSER_LOGIN_REDIRECT_URI = 'https://kr.m.lgaccount.com/login/iabClose';

/**
 * Query parameters of the SPX signature service. LG removed
 * `searchKey?key_name=OAUTH_SECRETKEY&sever_type=OP`, which used to hand the
 * secret to the client, and now signs the string server-side. The values mirror
 * `LGMNetwork.loadSignature` in LG's own SPX login page
 * (`/spx/resources/js/net/network.js`, `/spx/resources/js/controller/oauth2.js`),
 * including LG's `sever_type` spelling.
 */
export const EMP_SIGNATURE_PARAMS = {
  kind: 'oauth2',
  key_name: 'OAUTH_SECRETKEY',
  sever_type: 'OP',
} as const;

// Base64 HMAC as returned by the signature service (28 characters for HMAC-SHA1).
// Anything else, such as the HTML 404 page LG serves for removed routes, is rejected.
const EMP_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{16,128}={0,2}$/;

function httpsBaseUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      return null;
    }

    return url.href.endsWith('/') ? url.href : url.href + '/';
  } catch {
    return null;
  }
}

/**
 * Reads `code` and `oauth2_backend_url` from the redirect URI returned by the EMP
 * authorize call. LG sometimes percent-encodes the redirect URI once more, so a
 * second, decoded attempt is made when the first parse finds no code.
 */
export function parseAuthorizeRedirect(redirectUri: string): { code: string; backendUrl: string | null } {
  const candidates = [redirectUri];
  try {
    const decoded = decodeURIComponent(redirectUri);
    if (decoded !== redirectUri) {
      candidates.push(decoded);
    }
  } catch {
    // keep the original value only
  }

  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }

    const code = stringValue(url.searchParams.get('code'));
    if (code) {
      const backend = url.searchParams.get('oauth2_backend_url');
      const backendUrl = httpsBaseUrl(backend);
      if (backend && !backendUrl) {
        throw new TokenError('LG OAuth authorization failed: invalid oauth2_backend_url in redirect.');
      }

      return { code, backendUrl };
    }
  }

  throw new TokenError('LG OAuth authorization failed: redirect did not include an authorization code.');
}

// LG access tokens last one hour; used when a token response omits or garbles `expires_in`.
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

function tokenExpiresIn(value: unknown): number {
  const seconds = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TOKEN_LIFETIME_SECONDS;
}

/**
 * Handles authentication with the LG ThinQ API.
 * This class manages login, token refresh, and user session handling.
 */
export class Auth {
  /**
   * The base URL for the LG API, determined by the user's country code.
   */
  public lgeapi_url: string;

  /**
   * Creates a new `Auth` instance.
   *
   * @param gateway - The `Gateway` instance containing API endpoint information.
   * @param logger - The logger instance for logging debug and error messages.
   */
  public constructor(
    protected gateway: Gateway,
    public logger: Logger = createNoopLogger(),
  ) {
    this.lgeapi_url = `https://${this.gateway.country_code.toLowerCase()}.lgeapi.com/`;
  }

  /**
   * Logs in to the LG ThinQ API using the provided username and password.
   *
   * @param username - The user's username.
   * @param password - The user's password.
   * @returns A promise that resolves with a `Session` instance.
   */
  public async login(username: string, password: string) {
    // get signature and timestamp in login form
    const hash = crypto.createHash('sha512');

    return this.loginStep2(username, hash.update(password).digest('hex'));
  }

  /**
   * Performs the second step of the login process using an encrypted password.
   *
   * @param username - The user's username.
   * @param encrypted_password - The encrypted password.
   * @param extra_headers - Optional additional headers for the request.
   * @returns A promise that resolves with a `Session` instance.
   */
  public async loginStep2(username: string, encrypted_password: string, extra_headers?: any) {
    const headers: Record<string, string> = this.defaultEmpHeaders;

    const preLoginData = {
      'user_auth2': encrypted_password,
      'log_param': 'login request / user_id : ' + username + ' / third_party : null / svc_list : SVC202,SVC710 / 3rd_service : ',
    };
    const preLogin = await requestClient.post(this.gateway.login_base_url + 'preLogin', qs.stringify(preLoginData), { headers })
      .then(res => res.data)
      .catch(err => {
        throw authError('LG pre-login failed', err);
      });

    headers['X-Signature'] = preLogin.signature;
    headers['X-Timestamp'] = preLogin.tStamp;

    const data = {
      'user_auth2': preLogin.encrypted_pw,
      'password_hash_prameter_flag': 'Y',
      'svc_list': 'SVC202,SVC710', // SVC202=LG SmartHome, SVC710=EMP OAuth
      ...extra_headers,
    };

    // try login with username and hashed password
    const loginUrl = this.gateway.emp_base_url + 'emp/v2.0/account/session/' + encodeURIComponent(username);
    const account = await requestClient.post(loginUrl, qs.stringify(data), { headers }).then(res => res.data.account).catch(err => {
      const code = authErrorCode(err);
      const message = authErrorMessage(err, 'LG account login failed.');

      if (code === 'MS.001.03') {
        throw new AuthenticationError('Your account was already used to registered in ' + message + '.');
      }

      throw new AuthenticationError(message);
    });

    if (!stringValue(account?.loginSessionID) || !stringValue(account?.userID)) {
      throw new AuthenticationError('LG account login failed: response did not include a login session.');
    }

    const timestamp = DateTime.utc().toRFC2822();
    const empData = {
      account_type: account.userIDType,
      client_id: constants.CLIENT_ID,
      country_code: account.country,
      redirect_uri: 'lgaccount.lgsmartthinq:/',
      response_type: 'code',
      state: '12345',
      username: account.userID,
    };
    const empUrl = new URL(EMP_OAUTH_AUTHORIZE_URL + '?' + qs.stringify(empData));
    // The string to sign is the exact path and query we send, then the date header value.
    const signature = await this.requestEmpSignature(`${empUrl.pathname}${empUrl.search}\n${timestamp}`);
    const empHeaders = {
      'lgemp-x-app-key': constants.OAUTH_CLIENT_KEY,
      'lgemp-x-date': timestamp,
      'lgemp-x-session-key': account.loginSessionID,
      'lgemp-x-signature': signature,
      'Accept': 'application/json',
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Access-Control-Allow-Origin': '*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',

      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36 Edg/93.0.961.44',
    };
    // create emp session and get access token
    const authorize = await requestClient.get(empUrl.href, {
      headers: empHeaders,
    }).then(res => res.data).catch(err => {
      throw authError('LG OAuth authorization failed', err);
    });
    if (authorize?.status !== 1 || authorize.lgoauth_error_code || typeof authorize.redirect_uri !== 'string') {
      const reason = stringValue(authorize?.message) || stringValue(authorize?.lgoauth_error_code) || 'unexpected response from LG.';
      const error = new TokenError(`LG OAuth authorization failed: ${reason}`);
      (error as Error & { code?: string }).code = stringValue(authorize?.lgoauth_error_code) || undefined;
      throw error;
    }

    const redirect = parseAuthorizeRedirect(authorize.redirect_uri);

    return this.exchangeAuthorizationCode(redirect.code, redirect.backendUrl, empData.redirect_uri);
  }

  /**
   * Exchanges an EMP OAuth authorization code for access and refresh tokens.
   *
   * @param code - The authorization code from the authorize redirect.
   * @param backendUrl - The `oauth2_backend_url` from the redirect, if any.
   * @param redirectUri - The redirect URI the code was issued for.
   * @returns A promise that resolves with a `Session` instance.
   */
  public async exchangeAuthorizationCode(code: string, backendUrl: string | null, redirectUri: string) {
    const timestamp = DateTime.utc().toRFC2822();
    const tokenData = {
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    };

    const requestUrl = '/oauth/1.0/oauth2/token?' + qs.stringify(tokenData);

    const res = await requestClient.post(
      (backendUrl || this.lgeapi_url) + 'oauth/1.0/oauth2/token',
      qs.stringify(tokenData),
      {
        headers: {
          'x-lge-app-os': 'ADR',
          'x-lge-appkey': constants.CLIENT_ID,
          'x-lge-oauth-signature': this.signature(`${requestUrl}\n${timestamp}`, constants.OAUTH_SECRET_KEY),
          'x-lge-oauth-date': timestamp,
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    ).catch(err => {
      throw authError('LG token exchange failed', err);
    });
    const token = res.data;
    const accessToken = stringValue(token?.access_token);
    const refreshToken = stringValue(token?.refresh_token);
    const expiresIn = tokenExpiresIn(token?.expires_in);

    if (!accessToken || !refreshToken) {
      throw new TokenError('LG token exchange failed: response did not include access and refresh tokens.');
    }

    this.lgeapi_url = httpsBaseUrl(stringValue(token.oauth2_backend_url)) || backendUrl || this.lgeapi_url;

    return new Session(
      accessToken,
      refreshToken,
      Session.expiryTimestampFromExpiresIn(expiresIn),
    );
  }

  /**
   * Asks LG's SPX signature service to sign an EMP OAuth request.
   *
   * @param message - The string to sign: request path and query, a newline, then the `lgemp-x-date` value.
   * @returns The Base64 signature for the `lgemp-x-signature` header.
   */
  public async requestEmpSignature(message: string): Promise<string> {
    const signatureUrl = this.gateway.login_base_url + 'signature?' + qs.stringify({
      kind: EMP_SIGNATURE_PARAMS.kind,
      timestamp: message,
      key_name: EMP_SIGNATURE_PARAMS.key_name,
      sever_type: EMP_SIGNATURE_PARAMS.sever_type,
    });

    const body = await requestClient.get(signatureUrl, {
      headers: { 'Accept': 'text/plain, */*' },
      responseType: 'text',
      // keep the raw body: the service answers with plain text, not JSON
      transformResponse: [(data: unknown) => data],
    }).then(res => res.data).catch(err => {
      throw authError('LG OAuth signature request failed', err);
    });

    const signature = typeof body === 'string' ? body.trim() : '';
    if (!EMP_SIGNATURE_PATTERN.test(signature)) {
      throw new AuthenticationError('LG OAuth signature request failed: unexpected response from the LG signature service.');
    }

    return signature;
  }

  /**
   * Retrieves the default headers for EMP requests.
   */
  public get defaultEmpHeaders() {
    return {
      'Accept': 'application/json',
      'X-Application-Key': constants.APPLICATION_KEY,
      'X-Client-App-Key': constants.CLIENT_ID,
      'X-Lge-Svccode': 'SVC709',
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'X-Device-Language-Type': 'IETF',
      'X-Device-Publish-Flag': 'Y',
      'X-Device-Country': this.gateway.country_code,
      'X-Device-Language': this.gateway.language_code,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  /**
   * Handles new terms and conditions that require user agreement.
   *
   * @param accessToken - The access token for the session.
   */
  public async handleNewTerm(accessToken: string) {
    const showTermUrl = 'common/showTerms?callback_url=lgaccount.lgsmartthinq:/updateTerms'
      + '&country=VN&language=en-VN&division=ha:T20&terms_display_type=3&svc_list=SVC202';
    const showTermHtml = await requestClient.get(this.gateway.login_base_url + showTermUrl, {
      headers: {
        'X-Login-Session': accessToken,
      },
    }).then(res => res.data);

    const headers = {
      ...this.defaultEmpHeaders,
      'X-Login-Session': accessToken,
      'X-Signature': showTermHtml.match(/signature[\s]+:[\s]+"([^"]+)"/)[1],
      'X-Timestamp': showTermHtml.match(/tStamp[\s]+:[\s]+"([^"]+)"/)[1],
    };

    const accountTermUrl = 'emp/v2.0/account/user/terms?opt_term_cond=001&term_data=SVC202&itg_terms_use_flag=Y&dummy_terms_use_flag=Y';
    const accountTerms = (await requestClient.get(this.gateway.emp_base_url + accountTermUrl, { headers })
      .then(res => {
        return res.data.account?.terms;
      }))
      .map((term: any) => {
        return term.termsID;
      });

    const termInfoUrl = 'emp/v2.0/info/terms?opt_term_cond=001&only_service_terms_flag=&itg_terms_use_flag=Y&term_data=SVC202';
    const infoTerms = await requestClient.get(this.gateway.emp_base_url + termInfoUrl, { headers }).then(res => {
      return res.data.info.terms;
    });

    const newTermAgreeNeeded = infoTerms.filter((term: any) => {
      return accountTerms.indexOf(term.termsID) === -1;
    }).map((term: any) => {
      return [term.termsType, term.termsID, term.defaultLang].join(':');
    }).join(',');

    if (newTermAgreeNeeded) {
      const updateAccountTermUrl = 'emp/v2.0/account/user/terms';
      await requestClient.post(this.gateway.emp_base_url + updateAccountTermUrl, qs.stringify({ terms: newTermAgreeNeeded }), {
        headers,
      });
    }
  }

  /**
   * Retrieves the JSession ID for ThinQ v1 API compatibility.
   *
   * @param accessToken - The access token for the session.
   * @returns A promise that resolves with the JSession ID.
   */
  public async getJSessionId(accessToken: string) {
    // login to old gateway also - thinq v1
    const memberLoginUrl = this.gateway.thinq1_url + 'member/login';
    const memberLoginHeaders = {
      'x-thinq-application-key': 'wideq',
      'x-thinq-security-key': 'nuts_securitykey',
      'Accept': 'application/json',
      'x-thinq-token': accessToken,
    };
    const memberLoginData = {
      countryCode: this.gateway.country_code,
      langCode: this.gateway.language_code,
      loginType: 'EMP',
      token: accessToken,
    };

    return await requestClient.post(memberLoginUrl, { lgedmRoot: memberLoginData }, {
      headers: memberLoginHeaders,
    })
      .then(res => res.data)
      .then(data => data.lgedmRoot.jsessionId)
      .catch(err => {
        const message = typeof err?.message === 'string' ? err.message : String(err);
        this.logger.debug(
          message.startsWith(ManualProcessNeededErrorCode)
            ? 'Please open the native LG App and sign in to your account to see what happened,'
            + ' maybe new agreement need your accept. Then try restarting Homebridge.'
            : message,
        );
        this.logger.info('Failed to login to old thinq v1 gateway. See debug logs for more details. Continuing anyways.');
      });
  }

  /**
   * Refreshes the access token using the refresh token.
   *
   * @param session - The current `Session` instance.
   * @returns A promise that resolves with the updated `Session` instance.
   */
  public async refreshNewToken(session: Session) {
    try {
      const gateway = await requestClient.post('https://kic.lgthinq.com:46030/api/common/gatewayUriList', {
        lgedmRoot: {
          countryCode: this.gateway.country_code,
          langCode: this.gateway.language_code,
        },
      }, {
        headers: {
          'Accept': 'application/json',
          'x-thinq-application-key': 'wideq',
          'x-thinq-security-key': 'nuts_securitykey',
        },
      }).then(res => res.data.lgedmRoot);

      this.lgeapi_url = httpsBaseUrl(stringValue(gateway?.oauthUri)) || this.lgeapi_url;
    } catch (err) {
      // ignore this error
    }

    const tokenUrl = this.lgeapi_url + 'oauth/1.0/oauth2/token';
    const data = {
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    };

    const timestamp = DateTime.utc().toRFC2822();

    const requestUrl = '/oauth/1.0/oauth2/token' + qs.stringify(data, { addQueryPrefix: true });
    const signature = this.signature(`${requestUrl}\n${timestamp}`, constants.OAUTH_SECRET_KEY);

    const headers = {
      'x-lge-app-os': 'ADR',
      'x-lge-appkey': constants.CLIENT_ID,
      'x-lge-oauth-signature': signature,
      'x-lge-oauth-date': timestamp,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const resp = await requestClient.post(tokenUrl, qs.stringify(data), { headers }).then(resp => resp.data).catch(err => {
      // keep network and expiry errors as they are so callers can still retry on them
      if (err instanceof NotConnectedError || err instanceof TokenExpiredError) {
        throw err;
      }

      throw authError('LG token refresh failed', err, TokenError);
    });

    const accessToken = stringValue(resp?.access_token);
    const expiresIn = tokenExpiresIn(resp?.expires_in);
    if (!accessToken) {
      throw new TokenError('LG token refresh failed: response did not include a new access token.');
    }

    session.newTokenFromExpiresIn(accessToken, expiresIn);

    return session;
  }

  /**
   * Retrieves the user's unique number from the LG API.
   *
   * @param accessToken - The access token for the session.
   * @returns A promise that resolves with the user's unique number.
   */
  public async getUserNumber(accessToken: string) {
    const profileUrl = this.lgeapi_url + 'users/profile';
    const timestamp = DateTime.utc().toRFC2822();
    const signature = this.signature(`/users/profile\n${timestamp}`, constants.OAUTH_SECRET_KEY);

    const headers = {
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + accessToken,
      'X-Lge-Svccode': 'SVC202',
      'X-Application-Key': constants.APPLICATION_KEY,
      'lgemp-x-app-key': constants.CLIENT_ID,
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'x-lge-oauth-date': timestamp,
      'x-lge-oauth-signature': signature,
    };

    const resp = await requestClient.get(profileUrl, { headers }).then(resp => resp.data);
    if (resp.status === 2) {
      throw new AuthenticationError(resp.message);
    }

    return resp.account.userNo as string;
  }

  /**
   * Constructs the login URL for the LG ThinQ API.
   *
   * @returns The login URL.
   */
  public async getLoginUrl() {
    const params = {
      country: this.gateway.country_code,
      language: this.gateway.language_code,
      client_id: constants.CLIENT_ID,
      svc_list: constants.SVC_CODE,
      svc_integrated: 'Y',
      redirect_uri: 'lgaccount.lgsmartthinq:/',
      show_thirdparty_login: 'LGE,MYLG,GGL,AMZ,FBK,APPL',
      division: 'ha:T20',
      callback_url: 'lgaccount.lgsmartthinq:/',
      oauth2State: '12345',
      show_select_country: 'N',
    };

    return this.gateway.login_base_url + 'login/signIn' + qs.stringify(params, { addQueryPrefix: true });
  }

  /**
   * Generates a signature for API requests.
   *
   * @param message - The message to sign.
   * @param secret - The secret key used for signing.
   * @returns The generated signature.
   */
  protected signature(message: string, secret: string) {
    return crypto.createHmac('sha1', Buffer.from(secret)).update(message).digest('base64');
  }
}
