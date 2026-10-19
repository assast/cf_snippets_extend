# Docker 部署与 D1 迁移

Docker 版本使用 Node.js 24 和本地 SQLite，复用 `public/_worker.js` 及现有前端。API 路径、登录方式和订阅 token 保持兼容；无需 Cloudflare 运行时或数据库。原 Pages 部署入口仍可使用。

## 启动

```bash
cp .env.example .env
# 修改 .env 中的 API_KEY；迁移时沿用原 API_KEY 即可继续登录。
mkdir -p data
sudo chown 1000:1000 data
docker compose pull
docker compose up -d
```

默认监听 `127.0.0.1:58180`，访问 `http://127.0.0.1:58180`。远程访问时将 `BIND_IP` 设置为服务器内网 IP，或通过反向代理提供 HTTPS。NC 使用 `BIND_IP=10.144.144.10`，栈目录 `/docker/dockge/stacks/cf-snippets-extend`。

数据库持久化在 `./data/snippets.sqlite`，运行用户为 UID/GID `1000:1000`。不要删除 `data` 目录。`API_KEY` 为必填项，不要提交 `.env`、SQL 备份或数据库文件。

可选配置：`IMAGE` 固定镜像版本，`HTTP_PORT` 修改宿主端口，`PAGES_HOSTNAME` 指定原 Pages 域名以便 Clash 转换识别本地订阅。反向代理应传递 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`。

## GitHub Actions 镜像

推送 `main` 自动运行测试并构建 `linux/amd64`、`linux/arm64` 镜像，发布到：

```text
ghcr.io/assast/cf_snippets_extend:latest
ghcr.io/assast/cf_snippets_extend:sha-<短提交哈希>
```

`v*` 标签同时发布语义版本标签。也可在 Actions 手动运行 `Docker image`。工作流使用内置 `GITHUB_TOKEN`，无需额外仓库密钥。首次发布后需保证 GHCR 包公开可读，或在服务器配置具有 `read:packages` 权限的登录。更新执行 `docker compose pull && docker compose up -d`；回退可将 `IMAGE` 改为历史 `sha-*` 标签后重新启动。

## 从 Cloudflare D1 完整迁移

迁移前暂停旧端写入及自动导入/测速任务，避免导出后发生新写入。保留旧服务和原始 SQL 备份，完成数据核对后再切换访问入口。单纯更换运行环境无需修改订阅 token；若更换域名，客户端订阅地址的域名也需更新。

1. 用有权限的 Cloudflare 账号导出远程数据库：

   ```bash
   mkdir -p backups
   wrangler d1 export <数据库名称或绑定名称> --remote --output backups/cloudflare-d1.sql
   chmod 600 backups/cloudflare-d1.sql
   ```

2. 停止目标容器，将 SQL 导入**尚不存在的新文件**。脚本拒绝覆盖现有数据库，检查 SQLite 完整性并输出各表记录数。保留所有表字段、ID、时间戳、订阅 token 和会话，首次启动沿用原应用的结构升级逻辑。

   ```bash
   docker compose stop
   # 容器以 UID 1000 运行；单文件只读挂载避免开放整个备份目录。
   sudo chown 1000:1000 backups/cloudflare-d1.sql
   docker compose run --rm --no-deps \
     -v "$PWD/backups/cloudflare-d1.sql:/backup.sql:ro" \
     cf-snippets-extend \
     node server/import-d1.mjs /backup.sql /data/snippets.sqlite
   docker compose up -d
   ```

3. 检查 `docker compose ps`、`docker compose logs --tail 50`、`curl -f http://127.0.0.1:58180/healthz`（NC 使用内网 IP），登录核对记录数与黑名单，比较原订阅与新订阅输出。确认后再修改域名及写入方的 API 地址。

运行期间备份 SQLite 应使用 SQLite 在线备份接口或先停止容器再复制整个 `data` 目录，避免遗漏 WAL 中的数据。

## 本地开发与验证

```bash
npm test
API_KEY=local-test DATABASE_PATH=./data/snippets.sqlite PORT=3000 npm start
docker build -t cf-snippets-extend:local .
```

测试包含原有黑名单和订阅测试，以及 SQLite 事务回滚、D1 SQL 导入、鉴权、订阅生成、重启持久化和 TCP Web Streams 兼容性。`GET /healthz` 用于容器健康检查。
