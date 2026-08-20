# 团队版生产部署指南

本方案使用同一个 Cloudflare Access 自托管应用完成登录和 API 保护：桌面端通过
Managed OAuth + PKCE 打开系统浏览器，用户继续使用现有的 Casdoor 身份源登录。
Cloudflare 给桌面端返回不透明 access token，并在 API 请求到达 Worker 前将其解析成
`Cf-Access-Jwt-Assertion`。Worker 验证该 JWT 后，再用 D1 做第二层用户授权。

真实订阅 URL 只保存在 Cloudflare Worker Secret 中。GitHub 构建产物只包含团队 API
域名，不包含上游订阅 URL。

## 需要提前准备

1. 一个已接入 Cloudflare 的域名，以及准备用作 API 的子域名，例如
   `clash-sub.dongsy.com.cn`。
2. Cloudflare Zero Trust team domain，例如
   `https://your-team.cloudflareaccess.com`。
3. 现有 Casdoor 身份源，以及准备允许登录的邮箱或用户组。
4. 真实订阅 URL。它只会写入 GitHub Environment Secret 和 Cloudflare Worker Secret。
5. 一个 Cloudflare API Token。建议只授权目标账户和目标 Zone，并至少授予：
   Workers Scripts Edit、Workers KV Storage Edit、D1 Edit，以及目标 Zone 的
   Workers Routes Edit。若自定义域名创建时报权限错误，再为该 Zone 增加 DNS Edit。
6. 可选的应用签名材料。没有签名材料也能生成测试安装包，但 Windows/macOS 会显示
   未签名警告，macOS 正式分发还需要 Apple Developer 证书和公证凭据。

## 1. 创建 D1 与 KV（通常可跳过）

采用下文第 4 节的 **Workers Builds（连接 GitHub）** 部署时，D1 数据库和 KV
命名空间会由 `team-worker/scripts/ensure-resources.cjs` 在首次部署时自动按名称
创建或复用，本节操作可以跳过。只有构建身份权限不足、或想完全手工控制资源时
才需要本节。

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

1. Application domain 填 API 子域名，例如 `clash-sub.dongsy.com.cn`。
2. 保留 Casdoor 作为身份提供方，添加 Allow policy，按邮箱或 Casdoor 用户组放行。
   不要为整个域名设置 Bypass policy。
3. 在 **Advanced settings** 开启 **Managed OAuth**。
4. 开启动态客户端注册和 **Allow loopback clients** (`127.0.0.1`)。
5. Access token lifetime 建议 5–15 分钟；Grant session duration 建议 7–14 天。
6. 保存后复制该应用的 **Application Audience (AUD) tag**。

开启 Managed OAuth 后，应用域名下的 `/.well-known/oauth-authorization-server`
会返回包含 `authorization_endpoint`、`token_endpoint`、`registration_endpoint`
和 S256 PKCE 的 JSON，客户端默认就从这里发现元数据，无需额外配置。如果它返回
302 登录页而不是 JSON，说明该 Access 应用还没有开启 Managed OAuth。

桌面端不直接接入 Casdoor SDK。浏览器打开 Cloudflare 的授权地址后，Access 会继续
使用你已配置的 Casdoor 登录流程。

## 3. 填写 GitHub `team-production` Environment

这个 Environment 服务两条流水线：

- **Team Edition Build（客户端构建）**：只需要 `WORKER_CUSTOM_DOMAIN`（或
  `TEAM_API_BASE_URL`）和可选的 `TEAM_*` 变量。
- **Deploy Team Worker（Worker 兜底部署）**：只有不使用 Workers Builds 时才需要，
  依赖 `CLOUDFLARE_ACCOUNT_ID`、`TEAM_DOMAIN`、`ACCESS_AUD`、
  `D1_DATABASE_ID`、`KV_NAMESPACE_ID` 变量和 `CLOUDFLARE_API_TOKEN`、
  `UPSTREAM_SUBSCRIPTION_URL` Secrets。

推荐路径（Workers Builds）下，`TEAM_DOMAIN`/`ACCESS_AUD`/
`UPSTREAM_SUBSCRIPTION_URL` 都在 Cloudflare Dashboard 的 Worker 变量里管理，
D1/KV 自动创建，因此 GitHub 侧最少只需填 `WORKER_CUSTOM_DOMAIN`（客户端构建
用）。

仓库已经创建 `team-production` Environment。打开：

**Settings > Environments > team-production > Environment variables / secrets**

### 客户端构建（Team Edition Build）

必须填写：

| 名称 | 示例/含义 |
| --- | --- |
| `WORKER_CUSTOM_DOMAIN` | `https://clash-sub.dongsy.com.cn`，必须带 `https://`；客户端的 `api_base_url` 由它生成 |

可选：

| 名称 | 默认值/用途 |
| --- | --- |
| `TEAM_API_BASE_URL` | 可不填，默认使用 `WORKER_CUSTOM_DOMAIN` |
| `TEAM_OAUTH_CLIENT_ID` | 保持空值即可使用动态客户端注册 |
| `TEAM_OAUTH_RESOURCE` | 可不填，默认使用 API origin |
| `TEAM_PROFILE_NAME` | `Team Network`（已设置） |
| `TEAM_SYNC_INTERVAL_MINUTES` | `360`（已设置） |

当前 Environment 已按此精简：仅保留 `TEAM_PROFILE_NAME` 和
`TEAM_SYNC_INTERVAL_MINUTES`，其余按需添加。

### Worker 兜底部署（Deploy Team Worker Action）

以下条目只服务 4b 的兜底 Action，Workers Builds 主路径下用不到，已从
Environment 中精简。需要启用兜底路径时按此重建：

| 名称 | 示例/含义 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |
| `D1_DATABASE_ID` | D1 database ID |
| `KV_NAMESPACE_ID` | KV production namespace ID |
| `KV_PREVIEW_NAMESPACE_ID` | 未填时使用 production KV ID |
| `D1_DATABASE_NAME` | `clash-verge-team` |
| `WORKER_NAME` | `clash-verge-rev`（必须与 wrangler.toml 的 name 一致） |
| `DEFAULT_TEAM_NAME` | 团队显示名称（也可直接改 wrangler.toml） |
| `CACHE_TTL_SECONDS` | `300`（也可直接改 wrangler.toml） |
| `TEAM_DOMAIN` / `ACCESS_AUD` | 不填则保留 dashboard 中管理的值（keep_vars） |

以及 Secrets：`CLOUDFLARE_API_TOKEN`（最小权限 API Token）、
`UPSTREAM_SUBSCRIPTION_URL`（真实订阅 URL，Action 会同步为 Worker Secret）。

可以用已登录的 GitHub CLI 写入客户端构建必需的变量：

```powershell
gh variable set WORKER_CUSTOM_DOMAIN --env team-production -R DSYZayn/clash-verge-rev
```

`GITHUB_TOKEN` 由 GitHub Actions 自动生成，不需要准备。

可选的客户端签名 Secrets：

- `TAURI_PRIVATE_KEY`、`TAURI_KEY_PASSWORD`：Tauri updater 签名。当前团队构建关闭了
  updater artifacts 并清空了上游更新地址，因此测试构建不要求这两个值。若以后启用
  私有自动更新，需要同时配置自己的更新地址、公钥和这两个签名 Secret。
- `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、
  `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`：macOS 正式签名/公证。当前团队流水线
  默认生成未签名 DMG；只有准备好完整证书后才应把这些变量接入签名步骤，不能只填空值。

## 4. 部署 Worker

两条路径二选一，二者操作的是同一个 Worker，互不冲突。

### 4a. Workers Builds：连接 GitHub，push 即部署（推荐）

1. Cloudflare Dashboard → **Workers & Pages** → 新建 Worker（或打开已有的
   `clash-verge-rev`）→ **Settings → Builds → Connect to Git**，选择本仓库。
   注意：dashboard 里 Worker 的名字必须和 `team-worker/wrangler.toml` 的
   `name` 一致（当前为 `clash-verge-rev`），否则部署会落到另一个 Worker 上。
2. 子项目识别参数（monorepo 必填）：
   - Root directory：`team-worker`
   - Build command：`npm ci`
   - Deploy command：`npm run deploy`（非生产分支用 `npm run deploy:preview`）
   - Build variables：`SKIP_DEPENDENCY_INSTALL=1`（必须，原因见常见故障）
   - Production branch：你的集成分支
3. 可选：Build watch paths 的 include 设为 `team-worker/*`，避免客户端代码
   提交触发 Worker 重建。
4. 首次 push 触发部署时，`ensure-resources.cjs` 自动创建/复用 D1 与 KV 并应用
   migrations；之后每次 push 自动更新。
5. 在 Worker 的 **Settings → Variables and Secrets** 添加：
   - `TEAM_DOMAIN`（Text）：Access 团队域名，如 `https://your-team.cloudflareaccess.com`
   - `ACCESS_AUD`（Text）：Access 应用的 Application Audience (AUD) tag
   - `UPSTREAM_SUBSCRIPTION_URL`（Secret）：真实订阅 URL

   保存后立即生效；wrangler.toml 启用了 `keep_vars`，之后每次重新部署都会
   保留这里的最新值。
6. 在 **Settings → Domains & Routes** 绑定 `clash-sub.dongsy.com.cn` 自定义域名。
   wrangler.toml 不声明 routes，dashboard 绑定的域名不会被后续部署冲掉。

### 4b. Deploy Team Worker Action（兜底）

适合构建身份权限不足、或希望从 GitHub Secret 同步上游 URL 的场景。该路径所需的 Environment 变量已按客户端构建精简，
首次使用前按第 3 节"Worker 兜底部署"表格重建。打开仓库
**Actions > Deploy Team Worker > Run workflow**：

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

## 5. 用户开通与管理

**无需手动添加用户。** 任何能通过 Cloudflare Access 认证的用户，首次登录时会
在 D1 自动建档（记录 Access `sub`、邮箱、显示名，`enabled = 1`），并写入一条
`user_provisioned` 审计事件。成员资格由 Access 应用的策略（Casdoor 登录规则）
决定；D1 表只用于额度覆盖、审计和封禁。

流量字段保持 `NULL` 时，客户端显示上游响应中的 `Subscription-Userinfo`。若要
在 D1 中覆盖某用户额度，`quota_upload`、`quota_download`、`quota_total` 使用
字节，`quota_expire` 使用 Unix 秒时间戳：

```sql
UPDATE users SET quota_total = 1099511627776, updated_at = CURRENT_TIMESTAMP
WHERE lower(email) = lower('user@example.com');
```

封禁用户（下次请求即被 403 拒绝）：

```sql
UPDATE users SET enabled = 0, updated_at = CURRENT_TIMESTAMP
WHERE lower(email) = lower('user@example.com');
```

如需提前预建档（预置显示名/团队/额度），仍可手动插入 `access_subject` 为
`pending:邮箱` 的记录，Worker 会在该用户首次成功请求时把它替换为 Access 的
稳定 `sub`。

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
- 客户端提示 invalid OAuth discovery metadata：应用域名下的
  `/.well-known/oauth-authorization-server` 返回的是 302 登录页而不是 JSON，
  说明该 Access 应用未开启 Managed OAuth。在 Advanced settings 开启 Managed
  OAuth 即可，无需重新构建客户端；同时确认已开启动态客户端注册和
  Allow loopback clients，否则换 token 阶段仍会失败。
- 动态注册失败：没有开启动态客户端注册或 Allow loopback clients。
- Bearer 请求仍为 401：`TEAM_OAUTH_RESOURCE` 与受保护 API origin 不一致，或 token
  已过期。
- Worker 返回 401（Access assertion verification failed）：`TEAM_DOMAIN` 或 `ACCESS_AUD`
  与签发 token 的 Access 应用不匹配。到 Cloudflare Dashboard 的 Worker >
  Observability/Logs 查看 `access assertion verification failed` 的具体原因。
- Worker 返回 503（bindings missing）：D1/KV 绑定没有生效。绑定由部署脚本自动挂接，
  push 触发一次重新部署即可；若仍存在，检查 Worker > Settings > Bindings。
- Worker 返回 560：D1 schema 初始化失败，Worker 日志里有 `database schema init failed` 详情。
- Worker 返回 561：D1 用户查询失败，Worker 日志里有 `user lookup failed` 详情。
- Worker 返回 403：该用户被禁用（`enabled = 0`），或 Access JWT 缺少 `sub`。
- JWT audience 错误：`ACCESS_AUD` 不是保护当前 API 域名的那个 Access 应用 AUD。
- Worker 返回 502：上游 URL 不可访问，或返回内容超过 10 MiB。
- Worker Action 无权限创建自定义域名：为 API Token 增加目标 Zone 的 Workers
  Routes Edit；若仍失败，再增加 DNS Edit。
- 构建出的客户端显示“团队功能尚未配置”：`WORKER_CUSTOM_DOMAIN` 和
  `TEAM_API_BASE_URL` 都未在 `team-production` Environment 中设置。
- Workers Builds 构建失败、日志提示找不到 Wrangler 配置或依赖：Root directory
  没有设为 `team-worker`。
- Workers Builds 报 `No preset version installed for command pnpm`：仓库根目录
  `.tool-versions` 钉住了构建镜像未预装的 Node 版本。仓库已改为
  `nodejs 24.18.0`（镜像预装 22.23.2 / 24.18.0）；若 Cloudflare 以后更新镜像
  预装版本，需要同步调整这个文件。
- Workers Builds 日志出现 `pnpm install --frozen-lockfile` 且失败或极慢：
  Cloudflare 的自动依赖安装固定发生在仓库根目录（与 Root directory 无关），会
  拉起整个桌面端的 pnpm 依赖树。在 **Settings → Build → Build variables and
  secrets** 加 `SKIP_DEPENDENCY_INSTALL=1` 跳过它；`team-worker` 的依赖由
  Build command 里的 `npm ci` 负责。
- Workers Builds 部署日志报 D1/KV 权限错误：在 Dashboard 手工创建同名资源后重新
  触发构建，或改用 4b 的 Action 路径。
- 客户端代码的 push 也触发 Worker 重建：把 Build watch paths 的 include 设为
  `team-worker/*`。
- 请求返回 503、提示 Worker is not configured：Worker 的 Variables and
  Secrets 里还没设置 `TEAM_DOMAIN`/`ACCESS_AUD`，或值里仍带占位符。
- 请求持续 401、日志提示 issuer/audience 不匹配：`TEAM_DOMAIN` 必须是
  `https://你的团队.cloudflareaccess.com`（无路径、无结尾斜杠），
  `ACCESS_AUD` 必须是保护当前 API 域名的那个 Access 应用的 AUD tag。
- Dashboard 里改的变量在一次 push 部署后被覆盖回旧值：确认 wrangler.toml
  保留了 `keep_vars = true`，且 `[vars]` 里没有同名条目。
