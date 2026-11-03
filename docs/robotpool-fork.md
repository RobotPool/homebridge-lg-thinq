<div align="center">

# Homebridge LG ThinQ - RobotPool edition

LG account login fix for `homebridge-lg-thinq` 2.0.0-beta.8, independently maintained by RobotPool.

[简体中文](robotpool-fork.zh-CN.md) | **English**

</div>

## What this edition fixes

Since September 2026, LG account (email/password) login in `homebridge-lg-thinq@2.0.0-beta.8` fails with one of:

```
LG pre-login failed: Request failed with status code 403
LG OAuth key lookup failed: Request failed with status code 404
```

* **403**: LG's AWS load balancer rejects Axios' default `axios/<version>` User-Agent on `POST /spx/preLogin`. This fork sends `okhttp/4.12.0`.
* **404**: LG removed `spx/searchKey`, which used to hand the OAuth secret key to the client. LG's own login page now asks the server for the finished signature (`GET <spx>/signature?kind=oauth2&timestamp=...&key_name=OAUTH_SECRETKEY&sever_type=OP`). This fork does the same.

Also included: validation of the login, signature, authorize, token exchange and refresh responses with step-specific error messages, a working redirect and code exchange for `thinq auth`, and redaction of tokens, cookies and the hashed password from logged errors. Device support is unchanged from 2.0.0-beta.8, including washers and dryers. Full list: [CHANGELOG](../CHANGELOG.md).

## Verification status

| Item | Status |
| --- | --- |
| Protocol | Taken from LG's public SPX login page JavaScript and matched against community reports (ollo69/ha-smartthinq-sensors#1016, nVuln/homebridge-lg-thinq#402) |
| Automated tests | Login, token exchange and refresh against a simulated LG cloud that checks signatures; 403, 404 and error paths; secret redaction |
| Node.js | Lint, build and the full test suite pass on Node.js 22 and 24 (the versions the plugin supports) |
| Real LG account | **Verified on 2026-11-01** with a US account: email/password login from the Homebridge UI settings page (Homebridge 2.4.0, Docker), then token mode after a restart; a washer and a dryer were discovered and the MQTT connection came up. Other regions are not verified yet; please report results in the [issue tracker](https://github.com/RobotPool/homebridge-lg-thinq/issues). |

## Installation

Requirements are unchanged: Homebridge `^1.11.2` or `^2.0.0`, Node.js `^22.13.0` or `^24.0.0`.

### New installation

In Homebridge UI open **Plugins**, search for `@robotpool/homebridge-lg-thinq`, and install **Homebridge LG ThinQ** published by RobotPool. Then configure it as described in the [README](../README.md#configuration).

From a terminal: `npm install --prefix /var/lib/homebridge @robotpool/homebridge-lg-thinq` (Docker: `--prefix /homebridge`).

### Switching from `homebridge-lg-thinq`

The platform name `LGThinQ` is the same, so your configuration, refresh token and devices are reused. Two plugins cannot register the same platform, so remove the old package first:

1. Optional: Homebridge UI > menu > Backup.
2. Plugins > Homebridge LG ThinQ (`homebridge-lg-thinq`) > menu > **Uninstall**. If asked whether to remove its configuration, **keep it**.
3. Install `@robotpool/homebridge-lg-thinq` as above.
4. Restart Homebridge and check the log for `Successfully connected to the ThinQ API.`

The old package registered its accessories under its own name. After the switch Homebridge may remove and re-add them, so you may need to assign rooms, names or automations again in the Home app.

To check the installed version: `npm ls --prefix /var/lib/homebridge @robotpool/homebridge-lg-thinq` (or `/homebridge`).

### Release tarball

Each [GitHub Release](https://github.com/RobotPool/homebridge-lg-thinq/releases) also carries the package as a `.tgz` with its SHA-256: `npm install --prefix /var/lib/homebridge TARBALL_URL`.

Notes:

* If password login still fails, token mode is an alternative: run `thinq auth`, sign in in the browser, paste the final `https://kr.m.lgaccount.com/login/iabClose?...` URL back (the CLI exchanges the authorization code it contains, or reads a third-party token), and set `auth_mode: "token"` with the printed `refresh_token`.

## Rollback

Nothing in your configuration or Homebridge storage is migrated. Uninstall `@robotpool/homebridge-lg-thinq` (keep the configuration), then install the upstream package and restart Homebridge:

```sh
npm uninstall --prefix /var/lib/homebridge @robotpool/homebridge-lg-thinq
npm install --prefix /var/lib/homebridge homebridge-lg-thinq@2.0.0-beta.8
```

(Use `/homebridge` for Docker.) Upstream 2.0.0-beta.8 has the login bug this edition fixes; an existing refresh token keeps working there until it expires.

## Known limitations

* Real LG cloud login is verified for one US account (see above). Other regions rely on LG's public login page and community reports (an Italian account logged in successfully on 2026-10-28).
* `lgemp-x-date` uses the Homebridge host clock. A host clock that is far off can make LG reject the signature.
* Some regions reported `EMP processing error.` at the authorize step even with valid signatures (Israel, ha-smartthinq-sensors#1016). This fork does not change that step.
* Accounts that sign in with Apple, Google or Facebook cannot use password mode; use token mode.
* Not in this release: HTTP 429 rate limiting (upstream #395), washer/dryer state handling for MQTT deltas (upstream #402 comments), AC keep-alive log noise (upstream #391/#401), and dependency advisories reported by `npm audit` (upstream #401).

## Relationship to upstream

This edition is maintained independently by RobotPool. It is based on [nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) by nVuln and contributors, and is not affiliated with nVuln or LG Electronics. Copyright and license: [LICENSE](../LICENSE) (Apache-2.0) and [NOTICE](../NOTICE), which lists the files changed here.
