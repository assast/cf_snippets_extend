# CFIP API 接口文档

本文档面向自动化脚本和 AI 读取，描述 CFIP（优选 IP/域名）的管理、DNS/节点黑名单和 CF 同步读取接口。

## 通用约定

- 管理接口前缀：`/api`
- 管理接口鉴权：请求头 `X-API-Key: <登录后返回的会话 apiKey>`
- 内部同步接口鉴权：请求头 `X-Internal-Key: <环境变量 API_KEY>`，也支持查询参数 `?key=<API_KEY>`
- 响应格式：管理接口默认返回 JSON，公开订阅接口返回 Base64 文本
- 布尔字段：接口接受 `true`/`false`、`1`/`0`，字符串 `true` 大小写不敏感，数据库中保存为 `1` 或 `0`
- 更新响应中的 `changes` 表示实际更新行数；`changes = 0` 表示请求成功但没有匹配到需要更新的记录。

## CFIP 对象字段

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `id` | number | CFIP ID |
| `address` | string | IP 地址或域名 |
| `port` | number | 端口，默认 `443` |
| `remark` | string | 备注 |
| `name` | string | 订阅节点显示名，优先级高于 `remark` |
| `sort_order` | number | 排序值，默认 `0` |
| `latency` | number | 延迟，建议单位 ms |
| `speed` | number | 速度，建议单位 kB/s |
| `country` | string | 国家/地区代码 |
| `isp` | string | 运营商 |
| `fail_count` | number | 失败次数 |
| `status` | string | `enabled`、`disabled`、`invalid` |
| `sync_blacklisted` | number | DNS 黑名单，`1` 表示已拉黑，`0` 表示允许参与 CF/DNS 同步 |
| `node_blacklisted` | number | 节点黑名单，`1` 表示已拉黑，`0` 表示允许参与订阅生成 |

## 黑名单规则

- `sync_blacklisted = 1` 的 CFIP 会保留在管理接口 `/api/cfip` 中。
- `sync_blacklisted = 1` 的 CFIP 不会从 `/api/internal/cfip` 返回，供 DNS/CF 同步时自动顺延下一条可用记录。
- `node_blacklisted = 1` 的 CFIP 默认不会参与公开订阅和订阅生成接口。
- 如果对应订阅配置开启 `include_blacklisted_cfip = 1`，节点黑名单中的 CFIP 可以参与订阅生成。
- `status`、`sync_blacklisted`、`node_blacklisted` 三者独立：禁用/失效控制状态筛选，DNS 黑名单只控制同步，节点黑名单只控制订阅输出。

## 订阅配置黑名单字段

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `include_blacklisted_cfip` | number | `1` 表示该订阅生成时包含节点黑名单 CFIP，`0` 表示排除，默认 `0` |

该字段适用于：

- `/api/subscribe/config`
- `/api/argo`
- `/api/subscribe/vless/generate`
- `/api/subscribe/ss/generate`

请求体兼容驼峰别名 `includeBlacklistedCfip`。

`/api/subscribe/vless/generate` 和 `/api/subscribe/ss/generate` 未传该字段时保留已有订阅配置值；没有已有配置时按默认 `0` 处理。

公开订阅 URL 也支持临时覆盖该设置：

```text
/sub/{uuid}?include_blacklisted_cfip=1
/sub/ss/{password}?include_blacklisted_cfip=1
/sub/argo/{token}?include_blacklisted_cfip=1
```

URL 参数兼容驼峰别名 `includeBlacklistedCfip`。

## 获取管理列表

- **URL**: `/api/cfip`
- **Method**: `GET`
- **Headers**: `X-API-Key`
- **返回**: 全部 CFIP，包括已拉黑项

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "address": "104.16.123.123",
      "port": 443,
      "remark": "美国优选",
      "name": "US-1",
      "status": "enabled",
      "sync_blacklisted": 0,
      "node_blacklisted": 0
    }
  ]
}
```

## 新增 CFIP

- **URL**: `/api/cfip`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`, `X-API-Key`

```json
{
  "address": "104.16.123.123",
  "port": 443,
  "remark": "美国优选",
  "name": "US-1",
  "status": "enabled",
  "sync_blacklisted": 0,
  "node_blacklisted": 0,
  "sort_order": 1,
  "latency": 150,
  "speed": 5000,
  "country": "US",
  "isp": "Cloudflare"
}
```

## 修改 CFIP

- **URL**: `/api/cfip/{id}`
- **Method**: `PUT`
- **Headers**: `Content-Type: application/json`, `X-API-Key`
- **说明**: 只传需要修改的字段

```json
{
  "latency": 145,
  "speed": 6000,
  "sync_blacklisted": 1,
  "node_blacklisted": 0
}
```

兼容别名：`blacklisted` 等价于 `sync_blacklisted`。

## 单条拉黑/解黑

- **URL**: `/api/cfip/{id}/blacklist`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`, `X-API-Key`
- **ID 要求**: `{id}` 必须是正整数

拉黑：

```json
{ "blacklist_type": "dns", "value": 1 }
```

解黑：

```json
{ "blacklist_type": "node", "value": 0 }
```

响应：

```json
{
  "success": true,
  "data": {
    "id": 12,
    "blacklist_type": "dns",
    "sync_blacklisted": 1,
    "changes": 1
  }
}
```

如果 `{id}` 不存在，接口仍返回 `success: true`，但 `data.changes` 为 `0`。

兼容写法：

- DNS 黑名单可继续传 `sync_blacklisted` 或旧别名 `blacklisted`
- 节点黑名单可传 `node_blacklisted`

## 批量拉黑/解黑

- **URL**: `/api/cfip/batch/blacklist`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`, `X-API-Key`
- **ID 要求**: `ids` 必须是非空、非重复的正整数数组

```json
{
  "ids": [1, 2, 3],
  "blacklist_type": "node",
  "value": 1
}
```

响应：

```json
{
  "success": true,
  "data": {
    "requested": 3,
    "changes": 3,
    "blacklist_type": "node",
    "node_blacklisted": 1
  }
}
```

`requested` 表示请求中的有效 ID 数量，`changes` 表示实际更新行数。部分 ID 不存在时，`changes` 可能小于 `requested`。

## 按失败次数批量删除

- **URL**: `/api/cfip/batch/delete-by-fail-count`
- **Method**: `POST`
- **Headers**: `Content-Type: application/json`, `X-API-Key`
- **说明**: 删除 `fail_count >= fail_count` 的 CFIP；阈值必须是大于 `0` 的整数。

```json
{
  "fail_count": 3
}
```

兼容字段名：`failCount`、`min_fail_count`、`threshold`。

响应：

```json
{
  "success": true,
  "data": {
    "fail_count": 3,
    "changes": 2
  }
}
```

`changes` 表示实际删除行数。

当 D1 免费套餐的每日写入额度耗尽时，返回 **HTTP 429**：

```json
{
  "error": "D1 今日写入额度已用完（删除也占用写入额度），请等待每日 UTC 00:00（北京时间 08:00）重置后重试，或升级 Workers 付费套餐。",
  "code": "D1_DAILY_WRITE_LIMIT_EXCEEDED"
}
```

其他数据库异常返回 **HTTP 500** 和通用 `error` 提示，详细异常记录在服务端日志中。

## 批量状态更新

- **URL**: `/api/cfip/batch/status`
- **Method**: `POST`

```json
{
  "ids": [1, 2, 3],
  "status": "disabled"
}
```

`status` 可选值：`enabled`、`disabled`、`invalid`。

## 批量新增

- **URL**: `/api/cfip/batch`
- **Method**: `POST`
- **Body**: CFIP 对象数组

```json
[
  {
    "address": "104.16.123.123",
    "port": 443,
    "remark": "美国优选",
    "name": "US-1",
    "status": "enabled",
    "sync_blacklisted": 0,
    "node_blacklisted": 0
  }
]
```

## 批量修改

- **URL**: `/api/cfip/batch/update`
- **Method**: `POST`

```json
{
  "items": [
    {
      "id": 1,
      "latency": 120,
      "speed": 7000,
      "sync_blacklisted": 0,
      "node_blacklisted": 0
    }
  ]
}
```

## 内部 CF 同步读取

- **URL**: `/api/internal/cfip`
- **Method**: `GET`
- **Headers**: `X-Internal-Key: <环境变量 API_KEY>`
- **替代鉴权**: `/api/internal/cfip?key=<环境变量 API_KEY>`
- **返回**: 未拉黑的 CFIP 列表

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "address": "104.16.123.123",
      "port": 443,
      "status": "enabled",
      "sync_blacklisted": 0,
      "node_blacklisted": 0
    }
  ]
}
```

## 订阅相关黑名单行为

以下入口默认排除 `node_blacklisted = 1` 的 CFIP；如果对应订阅配置开启 `include_blacklisted_cfip = 1`，则订阅生成会包含节点黑名单 CFIP：

- `/sub/token/{token}`
- `/sub/{uuid}`
- `/sub/ss/{password}`
- `/sub/argo/{token}`
- `/api/subscribe/vless/generate`
- `/api/subscribe/ss/generate`

`/api/internal/cfip` 不受该设置影响，始终只排除 DNS 黑名单中的 CFIP。

`cfipStatus` 仍用于状态筛选：

```text
/sub/{uuid}?cfipStatus=enabled,invalid
```

显式指定 CFIP ID 时，状态不强制检查；节点黑名单是否生效由订阅配置的 `include_blacklisted_cfip` 决定：

```text
/sub/{uuid}?cfip=1,2,3
```

需要临时包含节点黑名单 CFIP 时，可在公开订阅 URL 添加：

```text
/sub/{uuid}?cfip=1,2,3&include_blacklisted_cfip=1
```
