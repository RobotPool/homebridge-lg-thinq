<div align="center">

# Homebridge LG ThinQ - RobotPool maintenance fork

LG account login fix for `homebridge-lg-thinq` 2.0.0-beta.8, maintained in the open until it lands upstream.

[简体中文](robotpool-fork.zh-CN.md) | **English**

</div>

## What this fork fixes

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
| Real LG account | **Not verified by the maintainers.** The maintainers did not log in to a real LG account. Please report results in the issue tracker. |

## Installation

Requirements are unchanged: Homebridge `^1.11.2` or `^2.0.0`, Node.js `^22.13.0` or `^24.0.0`.

The fork keeps the package name `homebridge-lg-thinq` and the platform name `LGThinQ`, so your existing configuration, refresh token and cached accessories keep working. It is installed from the GitHub Release tarball, not from the npm registry.

1. Open the [latest release](https://github.com/RobotPool/homebridge-lg-thinq/releases) and copy the URL of the `homebridge-lg-thinq-<version>.tgz` asset. Optionally compare its SHA-256 with the value in the release notes.
2. Open a terminal on the Homebridge host (Homebridge UI: menu > Terminal) and install into your Homebridge storage directory:

   ```sh
   # Homebridge apt package / Raspberry Pi image
   npm install --prefix /var/lib/homebridge TARBALL_URL

   # Official Docker image (homebridge/homebridge)
   npm install --prefix /homebridge TARBALL_URL
   ```

   Replace `TARBALL_URL` with the URL from step 1. Use your own storage path if it differs.
3. Restart Homebridge, or the LG ThinQ child bridge.
4. Check the log for `Successfully connected to the ThinQ API.`

To check the installed version: `npm ls --prefix /var/lib/homebridge homebridge-lg-thinq` (or `/homebridge`).

Notes:

* The fork version `2.0.0-beta.8.robotpool.1` sorts above upstream `2.0.0-beta.8` and below a future `2.0.0-beta.9`, so Homebridge UI may offer a newer upstream release as an update. Installing it replaces this fork; check that the release contains the login fix first.
* If password login still fails, token mode is an alternative: run `thinq auth`, sign in in the browser, paste the final `https://kr.m.lgaccount.com/login/iabClose?...` URL back (the CLI exchanges the authorization code it contains, or reads a third-party token), and set `auth_mode: "token"` with the printed `refresh_token`.

## Rollback

Nothing in your configuration or Homebridge storage is migrated, so rolling back only reinstalls the upstream package:

```sh
npm install --prefix /var/lib/homebridge homebridge-lg-thinq@2.0.0-beta.8
```

(Use `/homebridge` for Docker.) Or in Homebridge UI: Plugins > Homebridge LG ThinQ > menu > Install Alternate Version > `2.0.0-beta.8`. Restart Homebridge afterwards.

## Known limitations

* Real LG cloud login has not been verified by the maintainers (see above). The fix follows LG's public login page and one community report of a successful login (Italian account, 2026-10-28).
* `lgemp-x-date` uses the Homebridge host clock. A host clock that is far off can make LG reject the signature.
* Some regions reported `EMP processing error.` at the authorize step even with valid signatures (Israel, ha-smartthinq-sensors#1016). This fork does not change that step.
* Accounts that sign in with Apple, Google or Facebook cannot use password mode; use token mode.
* Not in this release: HTTP 429 rate limiting (upstream #395), washer/dryer state handling for MQTT deltas (upstream #402 comments), AC keep-alive log noise (upstream #391/#401), and dependency advisories reported by `npm audit` (upstream #401).

## Relationship to upstream

This fork exists so users can install the fix while it is reviewed upstream. The fix is submitted to [nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq); once an upstream release contains it, switch back to the official package. Copyright and license: [LICENSE](../LICENSE) (Apache-2.0) and [NOTICE](../NOTICE).
