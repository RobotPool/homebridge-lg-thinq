<div align="center">

# Homebridge LG ThinQ - RobotPool 维护版

修复 `homebridge-lg-thinq` 2.0.0-beta.8 的 LG 账号登录问题，由 RobotPool 独立维护。

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

此外还包括：校验登录、签名、授权、Token 交换和刷新这几步的响应，并给出指明具体步骤的错误信息；修正 `thinq auth` 的回调地址，并支持用回调中的授权码换取 Token；在日志打印的错误中隐去 Token、Cookie 和密码哈希。设备支持与 2.0.0-beta.8 相同，包括洗衣机和烘干机。完整列表见 [CHANGELOG](../CHANGELOG.md)。

## 验证状态

| 项目 | 状态 |
| --- | --- |
| 协议 | 取自 LG 公开的 SPX 登录页 JavaScript，并与社区报告核对（ollo69/ha-smartthinq-sensors#1016、nVuln/homebridge-lg-thinq#402） |
| 自动化测试 | 在会校验签名的模拟 LG 云上测试登录、Token 交换和刷新；覆盖 403、404 和各类错误路径，以及敏感信息脱敏 |
| Node.js | 在 Node.js 22 和 24（插件支持的版本）上 lint、构建和全部测试通过 |
| 真实 LG 账号 | **2026-11-01 已验证**：美国账号，在 Homebridge UI 设置页用邮箱密码登录（Homebridge 2.4.0，Docker），之后切换到 Token 模式并重启；洗衣机和烘干机均被发现，MQTT 连接正常。其他地区尚未验证，欢迎在 [Issue](https://github.com/RobotPool/homebridge-lg-thinq/issues) 中反馈。 |

## 安装

运行要求不变：Homebridge `^1.11.2` 或 `^2.0.0`，Node.js `^22.13.0` 或 `^24.0.0`。

### 全新安装

在 Homebridge UI 中打开 **插件**，搜索 `@robotpool/homebridge-lg-thinq`，安装 RobotPool 发布的 **Homebridge LG ThinQ**，然后按 [README](../README.zh-CN.md#配置) 配置。

也可以在终端运行：`npm install --prefix /var/lib/homebridge @robotpool/homebridge-lg-thinq`（Docker 用 `--prefix /homebridge`）。

### 从 `homebridge-lg-thinq` 切换过来

平台名 `LGThinQ` 不变，现有配置、refresh token 和设备都会沿用。两个插件不能注册同一个平台，所以要先卸载旧包：

1. 可选：Homebridge UI > 菜单 > 备份。
2. 插件 > Homebridge LG ThinQ（`homebridge-lg-thinq`）> 菜单 > **卸载**。如果询问是否删除配置，选择**保留**。
3. 按上面的方法安装 `@robotpool/homebridge-lg-thinq`。
4. 重启 Homebridge，在日志中确认出现 `Successfully connected to the ThinQ API.`

旧包是用它自己的包名注册配件的。切换后 Homebridge 可能会移除并重新添加这些配件，届时可能需要在"家庭" App 里重新设置房间、名称或自动化。

查看已安装版本：`npm ls --prefix /var/lib/homebridge @robotpool/homebridge-lg-thinq`（Docker 用 `/homebridge`）。

### Release 安装包

每个 [GitHub Release](https://github.com/RobotPool/homebridge-lg-thinq/releases) 也附带 `.tgz` 安装包及其 SHA-256：`npm install --prefix /var/lib/homebridge TARBALL_URL`。

注意：

* 如果密码登录仍然失败，可以改用 Token 模式：运行 `thinq auth`，在浏览器中登录，把最终跳转到的 `https://kr.m.lgaccount.com/login/iabClose?...` 地址粘贴回终端（CLI 会用其中的授权码换取 Token，或读取第三方登录 Token），然后设置 `auth_mode: "token"`，填入输出的 `refresh_token`。

## 回滚

本版本不会迁移任何配置或 Homebridge 存储数据。卸载 `@robotpool/homebridge-lg-thinq`（保留配置），再安装上游包并重启 Homebridge：

```sh
npm uninstall --prefix /var/lib/homebridge @robotpool/homebridge-lg-thinq
npm install --prefix /var/lib/homebridge homebridge-lg-thinq@2.0.0-beta.8
```

（Docker 用 `/homebridge`。）上游 2.0.0-beta.8 仍有本版本修复的登录问题；已有的 refresh token 在过期前仍可使用。

## 已知限制

* 真实 LG 云登录只验证了一个美国账号（见上文）。其他地区依据 LG 公开登录页和社区报告（2026-10-28 有意大利账号登录成功）。
* `lgemp-x-date` 使用 Homebridge 主机时钟。主机时间偏差太大时，LG 可能拒绝签名。
* 有地区在签名正确的情况下，授权步骤仍返回 `EMP processing error.`（以色列，ha-smartthinq-sensors#1016）。本版本没有改动这一步。
* 使用 Apple、Google 或 Facebook 登录的账号不能用密码模式，请用 Token 模式。
* 本次发布不包含：HTTP 429 限流（上游 #395）、MQTT 增量数据下洗衣机/烘干机状态处理（上游 #402 评论）、空调保活日志噪音（上游 #391/#401）、`npm audit` 报告的依赖漏洞（上游 #401）。

## 与上游的关系

本版本由 RobotPool 独立维护，基于 nVuln 及贡献者的 [nVuln/homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq)，与 nVuln 和 LG Electronics 无关联。版权与许可证见 [LICENSE](../LICENSE)（Apache-2.0）和 [NOTICE](../NOTICE)，NOTICE 中列出了本项目修改过的文件。
