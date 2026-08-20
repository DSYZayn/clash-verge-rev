# Clash Verge Team Worker

团队版 API Worker：位于 Cloudflare Access 自托管应用（Managed OAuth）之后，校验
Cloudflare 注入的 `Cf-Access-Jwt-Assertion`，在 D1 中查询用户授权，然后把受管的
Clash 配置发给桌面端。真实订阅 URL 只存在于 Worker Secret，客户端永远拿不到。

## 绑定

| 绑定 | 类型 | 说明 |
| --- | --- | --- |
| `TEAM_DB` | D1 | 团队成员与审计事件，首次部署自动创建/迁移 |
| `RESOURCE_CACHE` | KV | 上游订阅内容缓存，首次部署自动创建 |
| `UPSTREAM_SUBSCRIPTION_URL` | Secret | 真实订阅 URL，只在 Dashboard 或 wrangler 设置 |
| `TEAM_DOMAIN` / `ACCESS_AUD` | vars（dashboard 管理） | Access 团队域名与 AUD；在 Worker 的 Variables and Secrets 设置，`keep_vars` 保证重新部署不覆盖 |

## 推荐部署：连接 GitHub（Workers Builds）

参考 NodeWarden 的做法：仓库即配置，push 即部署。

1. 打开 Cloudflare Dashboard → **Workers & Pages** → 新建 Worker（或进入已有的
   `clash-verge-rev`）→ **Settings → Builds → Connect to Git**。
   注意：dashboard 里 Worker 的名字必须与本目录 wrangler.toml 的 `name`
   完全一致（当前为 `clash-verge-rev`），否则每次部署都会落到另一个
   同名新 Worker 上，你连接的这一个永远收不到更新。
2. 选择仓库 `DSYZayn/clash-verge-rev`。本仓库是 monorepo，**必须**把这个
   Worker 的构建参数指向子目录：

   | 设置项 | 值 |
   | --- | --- |
   | Root directory | `team-worker` |
   | Build command | `npm ci` |
   | Deploy command（生产分支） | `npm run deploy` |
   | Deploy command（非生产分支） | `npm run deploy:preview` |
   | Build variables | `SKIP_DEPENDENCY_INSTALL=1` |
   | Production branch | 你的集成分支（如 `main`） |

   `SKIP_DEPENDENCY_INSTALL=1` 必须设置：Cloudflare 的自动依赖安装固定发生在
   **仓库根目录**（与 Root directory 无关），会用根项目的 pnpm 安装整个桌面端
   依赖树。跳过它之后，`team-worker` 的依赖由 Build command 里的 `npm ci`
   自行负责。
3. 建议在 **Settings → Build → Build watch paths** 把 include 设为
   `team-worker/*`，这样客户端代码的提交不会触发 Worker 重建。
4. 之后每次向生产分支 push 都会自动构建部署。首次部署时
   `scripts/ensure-resources.cjs` 会按名称查找或创建 D1 数据库
   `clash-verge-team` 与 KV 命名空间 `clash-verge-rev-resource-cache`，
   把返回的 id 临时写进本次构建使用的 wrangler.toml，并应用全部 D1 migrations。
   重复部署幂等，已存在的资源直接复用。
5. 在 Worker → **Settings → Variables and Secrets** 添加三个变量：

   | 变量 | 类型 | 内容 |
   | --- | --- | --- |
   | `TEAM_DOMAIN` | Text | Access 团队域名，如 `https://your-team.cloudflareaccess.com` |
   | `ACCESS_AUD` | Text | Access 应用的 Application Audience (AUD) tag |
   | `UPSTREAM_SUBSCRIPTION_URL` | Secret | 真实订阅 URL |

   保存后立即生效；`keep_vars` 保证之后每次 push 重新部署时都保留这里的
   最新值。未配置时 Worker 会返回 503 提示。
6. 自定义域名：Worker → **Settings → Domains & Routes** → 添加
   `clash-sub.dongsy.com.cn`。wrangler.toml 不声明 routes，dashboard 里绑定的
   域名不会被后续部署冲掉。

### 注意事项

- 在本机跑过 `npm run deploy` 后，本地 `wrangler.toml` 会被写入真实资源 id。
  **不要提交这个改动**：仓库里保持纯名称声明，任何账号连接仓库后才能自助开通
  全套资源。
- 如果 Workers Builds 的构建身份没有创建 D1/KV 的权限（部署日志报权限错误），
  在 Dashboard 手工创建同名资源即可——下次构建会按名称复用；或者改用下方的
  GitHub Action 兜底路径。
- `DEFAULT_TEAM_NAME`、`CACHE_TTL_SECONDS` 仍在 wrangler.toml 的 `[vars]`
  里管理：dashboard 里的同名变量会在下次部署时被覆盖回仓库值，要改就改仓库。
- 兜底：`docs/team-deployment.zh-CN.md` 里的 **Deploy Team Worker** Action 使用
  `team-production` Environment 中的 `CLOUDFLARE_API_TOKEN` 等资源 id 变量，
  走 `deploy:ci` 路径，与 Workers Builds 互不冲突（同一个 Worker 名字）。
  该路径所需的 GitHub Environment 变量已精简，启用前按部署文档第 3 节重建。

## 本地开发

```powershell
npm install
npm run dev
```

本地只有 `/healthz` 可直接访问；其余端点需要 Access 注入的断言头，完整链路请用
已部署且受 Access 保护的域名测试。本地跑 `npm run deploy` 前先 `npx wrangler
login`，并把 `.env.example` 复制为 `.env` 填好（`.env` 已被 git 忽略）。

## 用户开通

无需手动添加用户：通过 Access 认证的用户在首次请求时自动建档（`enabled = 1`，
并写入 `user_provisioned` 审计事件）。成员资格由 Access 策略控制；D1 里的
`enabled = 0` 是单用户封禁开关。流量字段为 `NULL` 时客户端显示上游
`Subscription-Userinfo`，要覆盖就填字节数和 Unix 秒时间戳。

如需提前预置显示名/团队/额度，可手动插入 `access_subject` 为 `pending:邮箱`
的记录，Worker 在用户首次成功请求时会自动把它替换为 Access 的稳定 `sub`。

## 端点

| 端点 | 认证 | 说明 |
| --- | --- | --- |
| `GET /healthz` | 无 | 存活探测 |
| `GET /v1/desktop/account` | Access JWT（首登自动建档） | 账户与额度信息 |
| `GET /v1/desktop/profile` | Access JWT（首登自动建档） | 受管 Clash YAML（ETag/304） |
