<div align="center">

# Homebridge LG ThinQ - RobotPool 维护版

修复 `homebridge-lg-thinq` 2.0.0-beta.8 的 LG 账号登录问题，在合入上游之前公开维护。

**简体中文** | [English](robotpool-fork.md)

</div>

## 修复了什么

从 2026 年 9 月起，`homebridge-lg-thinq@2.0.0-beta.8` 用 LG 账号（邮箱/密码）登录时会报以下错误之一：

```
LG pre-login failed: Request failed with status code 403
LG OAuth key lookup failed: Request failed with status code 404
```

* **403**：LG 的 AWS 负载均衡器拒绝 `POST /spx/preLogin` 请求中 Axios 默认的 `axios/<版本>` User-Agent。本版本改为发送 `okhttp/4.12.0`。
* **404**：LG 下线了 `spx/searchKey`，这个接口以前会把 OAuth 密钥直接交给客户端。现在 LG 自己的登录页改为向服务端请求已经算好的签名（`GET <spx>/signature?kind=oauth2&timestamp=...&key_name=OAUTH_SECRETKEY&sever_type=OP`），本版本采用同样的方式。

此外还包括：校验每一步认证响应，并给出指明具体步骤的错误信息；修正 `thinq auth` 的回调地址；在日志打印的错误中隐去 Token、Cookie 和密码哈希。设备支持与 2.0.0-beta.8 相同，包括洗衣机和烘干机。完整列表见 [CHANGELOG](../CHANGELOG.md)。

## 验证状态

| 项目 | 状态 |
| --- | --- |
| 协议 | 取自 LG 公开的 SPX 登录页 JavaScript，并与社区报告核对（ollo69/ha-smartthinq-sensors#1016、nVuln/homebridge-lg-thinq#402） |
| 自动化测试 | 在会校验签名的模拟 LG 云上测试登录、Token 交换和刷新；覆盖 403、404 和各类错误路径，以及敏感信息脱敏 |
| Node.js | 在 Node.js 22 和 24（插件支持的版本）上 lint、构建和全部测试通过 |
| 真实 LG 账号 | **维护者未验证。** 维护者没有登录过真实 LG 账号。欢迎在 Issue 中反馈结果。 |

## 安装

运行要求不变：Homebridge `^1.11.2` 或 `^2.0.0`，Node.js `^22.13.0` 或 `^24.0.0`。

本版本保留包名 `homebridge-lg-thinq` 和平台名 `LGThinQ`，现有配置、refresh token 和已缓存的配件都可以继续使用。安装来源是 GitHub Release 中的 tarball，而不是 npm 仓库。

1. 打开[最新 Release](https://github.com/RobotPool/homebridge-lg-thinq/releases)，复制附件 `homebridge-lg-thinq-<版本>.tgz` 的链接。可选：与发布说明中的 SHA-256 值比对。
2. 在 Homebridge 主机上打开终端（Homebridge UI：菜单 > 终端），安装到 Homebridge 存储目录：

   ```sh
   # Homebridge apt 安装包 / 树莓派镜像
   npm install --prefix /var/lib/homebridge TARBALL_URL

   # 官方 Docker 镜像（homebridge/homebridge）
   npm install --prefix /homebridge TARBALL_URL
   ```

   把 `TARBALL_URL` 换成第 1 步复制的链接。存储路径不同的话，换成你自己的路径。
3. 重启 Homebridge，或重启 LG ThinQ 子桥。
4. 在日志中确认出现 `Successfully connected to the ThinQ API.`

查看已安装版本：`npm ls --prefix /var/lib/homebridge homebridge-lg-thinq`（Docker 用 `/homebridge`）。

注意：

* Homebridge UI 可能把上游版本显示为“更新”。安装它会覆盖本版本。
* 如果密码登录仍然失败，可以改用 Token 模式：运行 `thinq auth`，在浏览器中用 LG 邮箱/密码账号登录，把最终跳转到的 `https://kr.m.lgaccount.com/login/iabClose?...` 地址粘贴回终端，然后设置 `auth_mode: "token"`，填入输出的 `refresh_token`。

## 回滚

本版本不会迁移任何配置或 Homebridge 存储数据，回滚只需重新安装上游包：

```sh
npm install --prefix /var/lib/homebridge homebridge-lg-thinq@2.0.0-beta.8
```

（Docker 用 `/homebridge`。）也可以在 Homebridge UI 中操作：插件 > Homebridge LG ThinQ > 菜单 > 安装其他版本 > `2.0.0-beta.8`。完成后重启 Homebridge。

## 已知限制

* 维护者未在真实 LG 云上验证登录（见上文）。本修复依据 LG 公开登录页，以及一份社区成功登录报告（意大利账号，2026-10-28）。
* `lgemp-x-date` 使用 Homebridge 主机时钟。主机时间偏差太大时，LG 可能拒绝签名。
* 有地区在签名正确的情况下，授权步骤仍返回 `EMP processing error.`（以色列，ha-smartthinq-sensors#1016）。本版本没有改动这一步。
* 使用 Apple、Google 或 Facebook 登录的账号不能用密码模式，请用 Token 模式。
* 本次发布不包含：HTTP 429 限流（上游 #395）、MQTT 增量数据下洗衣机/烘干机状态处理（上游 #402 评论）、空调保活日志噪音（上游 #391/#401）、`npm audit` 报告的依赖漏洞（上游 #401）。

## 与上游的关系

这个 Fork 让用户在上游审核期间就能用上修复。修复已提交到 [nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq)；上游发布包含该修复的版本后，请换回官方包。版权与许可证见 [LICENSE](../LICENSE)（Apache-2.0）和 [NOTICE](../NOTICE)。
