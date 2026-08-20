# 团队版生产部署指南

本方案使用同一个 Cloudflare Access 自托管应用完成登录和 API 保护：桌面端通过
Managed OAuth + PKCE 打开系统浏览器，用户继续使用现有的 Casdoor 身份源登录。
Cloudflare 给桌面端返回不透明 access token，并在 API 请求到达 Worker 前将其解析成
`Cf-Access-Jwt-Assertion`。Worker 验证该 JWT 后，再用 D1 做第二层用户授权。

真实订阅 URL 只保存在 Cloudflare Worker Secret 中。GitHub 构建产物只包含团队 API
域名，不包含上游订阅 URL。

## 需要提前准备

1. 一个已接入 Cloudflare 的域名，以及准备用作 API 的子域名，例如
   `team-api.example.com`。
2. Cloudflare Zero Trust team domain，例如
   `https://your-team.cloudflareaccess.com`。
3. 现有 Casdoor 身份源，以及准备允许登录的邮箱或用户组。
4. 真实订阅 URL。它只会写入 GitHub Environment Secret 和 Cloudflare Worker Secret。
5. 一个 Cloudflare API Token。建议只授权目标账户和目标 Zone，并至少授予：
   Workers Scripts Edit、Workers KV Storage Edit、D1 Edit，以及目标 Zone 的
   Workers Routes Edit。若自定义域名创建时报权限错误，再为该 Zone 增加 DNS Edit。
6. 可选的应用签名材料。没有签名材料也能生成测试安装包，但 Windows/macOS 会显示
   未签名警告，macOS 正式分发还需要 Apple Developer 证书和公证凭据。

## 1. 创建 D1 与 KV

本机登录 Cloudflare 后运行：

```powershell
cd team-worker
npx wrangler login
npx wrangler d1 create clash-verge-team
npx wrangler kv namespace create RESOURCE_CACHE
npx wrangler kv namespace create RESOURCE_CACHE --preview
```

保存命令输出中的 Cloudflare Account ID、D1 database ID、KV namespace ID 和
preview ID。也可以在 Cloudflare Dashboard 中创建同名资源。

不要把这些真实 ID 或真实订阅 URL写回仓库中的 `wrangler.toml`；生产 Action 会从
GitHub Environment 生成临时配置文件。

## 2. 配置 Cloudflare Access

在 **Zero Trust > Access controls > Applications** 中创建或编辑一个
**Self-hosted** 应用：

1. Application domain 填 API 子域名，例如 `team-api.example.com`。
2. 保留 Casdoor 作为身份提供方，添加 Allow policy，按邮箱或 Casdoor 用户组放行。
   不要为整个域名设置 Bypass policy。
3. 在 **Advanced settings** 开启 **Managed OAuth**。
4. 开启动态客户端注册和 **Allow loopback clients** (`127.0.0.1`)。
5. Access token lifetime 建议 5–15 分钟；Grant session duration 建议 7–14 天。
6. 保存后复制该应用的 **Application Audience (AUD) tag**。

最终应能访问以下元数据地址：

```text
https://team-api.example.com/.well-known/oauth-authorization-server
```

桌面端不直接接入 Casdoor SDK。浏览器打开 Cloudflare 的授权地址后，Access 会继续
使用你已配置的 Casdoor 登录流程。

## 3. 填写 GitHub `team-production` Environment

仓库已经创建 `team-production` Environment。打开：

**Settings > Environments > team-production > Environment variables / secrets**

必须填写的 Variables：

| 名称 | 示例/含义 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `TEAM_DOMAIN` | `https://your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | 上一步复制的 Access Application AUD |
| `WORKER_CUSTOM_DOMAIN` | `https://team-api.example.com`，必须带 `https://` |
| `D1_DATABASE_ID` | D1 database ID |
| `KV_NAMESPACE_ID` | KV production namespace ID |

建议或可选的 Variables：

| 名称 | 默认值/用途 |
| --- | --- |
| `KV_PREVIEW_NAMESPACE_ID` | 未填时使用 production KV ID |
| `WORKER_NAME` | `clash-verge-team-api` |
| `D1_DATABASE_NAME` | `clash-verge-team` |
| `DEFAULT_TEAM_NAME` | 团队显示名称 |
| `CACHE_TTL_SECONDS` | `300` |
| `TEAM_API_BASE_URL` | 可不填，默认使用 `WORKER_CUSTOM_DOMAIN` |
| `TEAM_OAUTH_DISCOVERY_URL` | 可不填，默认使用 API 域名下的 OAuth 元数据地址 |
| `TEAM_OAUTH_CLIENT_ID` | 保持空值即可使用动态客户端注册 |
| `TEAM_OAUTH_RESOURCE` | 可不填，默认使用 API origin |
| `TEAM_PROFILE_NAME` | `Team Network` |
| `TEAM_SYNC_INTERVAL_MINUTES` | `360` |

必须填写的 Secrets：

| 名称 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 上面创建的最小权限 Cloudflare API Token |
| `UPSTREAM_SUBSCRIPTION_URL` | 真实订阅 URL |

也可以用已登录的 GitHub CLI 写入，命令会交互式读取 Secret，不会将值写入仓库：

```powershell
gh variable set TEAM_DOMAIN --env team-production -R DSYZayn/clash-verge-rev
gh variable set ACCESS_AUD --env team-production -R DSYZayn/clash-verge-rev
gh variable set WORKER_CUSTOM_DOMAIN --env team-production -R DSYZayn/clash-verge-rev
gh variable set CLOUDFLARE_ACCOUNT_ID --env team-production -R DSYZayn/clash-verge-rev
gh variable set D1_DATABASE_ID --env team-production -R DSYZayn/clash-verge-rev
gh variable set KV_NAMESPACE_ID --env team-production -R DSYZayn/clash-verge-rev
gh secret set CLOUDFLARE_API_TOKEN --env team-production -R DSYZayn/clash-verge-rev
gh secret set UPSTREAM_SUBSCRIPTION_URL --env team-production -R DSYZayn/clash-verge-rev
```

`GITHUB_TOKEN` 由 GitHub Actions 自动生成，不需要准备。

可选的客户端签名 Secrets：

- `TAURI_PRIVATE_KEY`、`TAURI_KEY_PASSWORD`：Tauri updater 签名。当前团队构建关闭了
  上游 updater artifacts，因此测试构建不要求这两个值。
- `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、
  `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`：macOS 正式签名/公证。

## 4. 部署 Worker

打开仓库 **Actions > Deploy Team Worker > Run workflow**：

- 首次部署保持 `apply_migrations=true`。
- 保持 `sync_upstream_secret=true`，Action 会通过标准输入把 GitHub Secret 同步到
  Cloudflare Worker Secret，日志不会输出真实 URL。

Action 会依次校验参数、生成 `wrangler.generated.toml`、执行 D1 migration、部署
Worker、更新上游订阅 Secret，并为 `WORKER_CUSTOM_DOMAIN` 绑定 Worker Custom
Domain。生成文件已被 `.gitignore` 排除。

生产 Action 要求 `WORKER_CUSTOM_DOMAIN` 已填写；这样不会误把客户端配置指向临时的
`workers.dev` 地址。若只是本地开发，可省略该值，生成器会使用 `workers_dev` 模式。

部署后，在未登录状态访问 API 域名应该由 Access 返回 `401` 和
`WWW-Authenticate`/OAuth resource metadata，而不是返回 YAML 或上游 URL。若直接
得到 Worker 内容，说明该域名尚未受到正确的 Access 应用保护。

## 5. 添加可用用户

打开 **Cloudflare > D1 > clash-verge-team > Console**。用户第一次登录前，可以只按
邮箱预授权；Worker 在第一次成功请求时会自动把 `pending:` key 替换为 Cloudflare
Access 的稳定 `sub`：

```sql
INSERT INTO users (
  access_subject, email, display_name, team_name, enabled,
  quota_upload, quota_download, quota_total, quota_expire
) VALUES (
  'pending:user@example.com',
  'user@example.com',
  'Example User',
  'Example Team',
  1,
  NULL, NULL, NULL, NULL
)
ON CONFLICT(email) DO UPDATE SET
  display_name = excluded.display_name,
  team_name = excluded.team_name,
  enabled = 1,
  updated_at = CURRENT_TIMESTAMP;
```

流量字段保持 `NULL` 时，客户端显示上游响应中的 `Subscription-Userinfo`。若要在
D1 中覆盖用户额度，`quota_upload`、`quota_download`、`quota_total` 使用字节，
`quota_expire` 使用 Unix 秒时间戳。

禁用用户：

```sql
UPDATE users SET enabled = 0, updated_at = CURRENT_TIMESTAMP
WHERE lower(email) = lower('user@example.com');
```

## 6. 构建已整合配置的客户端

Worker 和 Access 验证通过后，打开 **Actions > Team Edition Build > Run workflow**。
流水线从同一个 `team-production` Environment 生成 `team-config.json`：

- `api_base_url` 指向受 Access 保护的 Worker 域名；
- OAuth discovery/resource 自动指向该 origin；
- `enabled` 自动设为 `true`；
- 真实订阅 URL 不参与客户端构建。

首次建议只构建 Windows x64。完成后在该次 Action 的 Artifacts 中下载
`clash-verge-team-windows`。安装后打开“团队账户”，选择“浏览器登录”，完成 Casdoor
登录后客户端会自动获取账户信息和受管配置。该配置 UID 固定为 `RTEAMMANAGED`，不在
普通订阅列表显示，并按 `TEAM_SYNC_INTERVAL_MINUTES` 定时更新。

## 常见故障

- OAuth metadata 返回 404/302：Access 应用的域名或 Managed OAuth 配置不正确。
- 动态注册失败：没有开启动态客户端注册或 Allow loopback clients。
- Bearer 请求仍为 401：`TEAM_OAUTH_RESOURCE` 与受保护 API origin 不一致，或 token
  已过期。
- Worker 返回 401：`TEAM_DOMAIN` 错误。
- Worker 返回 403：D1 中没有匹配的邮箱/subject，用户被禁用，或 Casdoor 没有向
  Access 提供 email claim。
- JWT audience 错误：`ACCESS_AUD` 不是保护当前 API 域名的那个 Access 应用 AUD。
- Worker 返回 502：上游 URL 不可访问，或返回内容超过 10 MiB。
- Worker Action 无权限创建自定义域名：为 API Token 增加目标 Zone 的 Workers
  Routes Edit；若仍失败，再增加 DNS Edit。
- 构建出的客户端显示“团队功能尚未配置”：`WORKER_CUSTOM_DOMAIN` 和
  `TEAM_API_BASE_URL` 都未在 `team-production` Environment 中设置。
