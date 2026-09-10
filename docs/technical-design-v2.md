# 得闲小程序与管理系统技术设计 V2 核心实现复核版

## 1 修订结论

本版保留 V1 的技术栈、模块化单体和分步实施方向，集中补齐第二轮复核要求。若本版与 V1 对预约占用、状态、资金、任务、接口或实施顺序的描述冲突，以本版为准。

本版解决以下问题：

- 过期预占先持久化为非阻挡状态，再参与数据库排斥约束；
- 任务执行使用租约所有权令牌，旧执行者不能覆盖新执行者结果；
- 占用阶段与阻挡生命周期拆分；
- 所有可占用对象统一引用 `resources`；
- 补全状态动作矩阵、资金不变量和固定锁顺序；
- API 金额统一使用“整数分的十进制字符串”；
- 明确配置选择、身份归属、两个接口契约及六组演算；
- 提前身份鉴权，商品交付在支付接入后验收。

生产退款算法、会员数值和经营参数仍可后配；未发布规则只用于明确标注的测试环境。

## 2 核心技术边界

| 层级          | 方案                                             |
| ------------- | ------------------------------------------------ |
| 小程序        | 微信原生框架、TypeScript                         |
| 管理后台      | Vue 3、Vite、TypeScript、Element Plus            |
| API 与 worker | Node.js 24 LTS、Fastify、TypeScript              |
| 运行时校验    | JSON Schema、TypeBox                             |
| 数据库        | PostgreSQL、Drizzle ORM、受控原生 SQL 迁移       |
| 架构          | 模块化单体；API 与 worker 使用同一代码库和数据库 |

一期不引入微服务、Redis、Kafka、通用规则引擎或分布式锁。预约锁、资金原子性、任务队列和幂等均由 PostgreSQL 提供。

## 3 资源与占用的物理模型

### 3.1 统一资源表

房间、床位、美容师和设备先登记为统一资源，再由各自扩展表保存业务属性。占用只能引用真实资源。

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE resource_type AS ENUM (
  'room', 'bed', 'therapist', 'equipment'
);

CREATE TABLE resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  resource_type resource_type NOT NULL,
  parent_resource_id uuid,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, id),
  FOREIGN KEY (store_id, parent_resource_id)
    REFERENCES resources(store_id, id) ON DELETE RESTRICT,
  CHECK (parent_resource_id IS NULL OR parent_resource_id <> id)
);
```

资源扩展表使用 `resource_id` 作为主键和外键。床位资源必须以房间资源为父级；房间、美容师不允许有父级。迁移中增加延迟约束触发器验证父子资源类型，业务服务也执行相同校验。资源被占用或被历史记录引用后只允许停用，不物理删除。

### 3.2 占用字段

`segment_kind` 表示占用原因，`blocking_state` 表示生命周期，两者不得混用。

```sql
CREATE TYPE occupancy_segment_kind AS ENUM (
  'prepare', 'service', 'cleanup', 'rest', 'unavailable'
);

CREATE TYPE occupancy_blocking_state AS ENUM (
  'held', 'confirmed', 'inactive'
);

CREATE TABLE resource_occupancies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  resource_id uuid NOT NULL,
  reception_id uuid REFERENCES receptions(id) ON DELETE RESTRICT,
  reception_guest_id uuid REFERENCES reception_guests(id) ON DELETE RESTRICT,
  unavailability_id uuid REFERENCES unavailabilities(id) ON DELETE RESTRICT,
  segment_kind occupancy_segment_kind NOT NULL,
  blocking_state occupancy_blocking_state NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  occupied_range tstzrange GENERATED ALWAYS AS (
    tstzrange(start_at, end_at, '[)')
  ) STORED,
  expires_at timestamptz,
  inactive_reason text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, resource_id)
    REFERENCES resources(store_id, id) ON DELETE RESTRICT,
  CHECK (end_at > start_at),
  CHECK (num_nonnulls(reception_id, unavailability_id) = 1),
  CHECK (
    (blocking_state = 'held' AND expires_at IS NOT NULL)
    OR (blocking_state <> 'held' AND expires_at IS NULL)
  )
);

ALTER TABLE resource_occupancies
  ADD CONSTRAINT resource_occupancies_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    occupied_range WITH &&
  )
  WHERE (blocking_state IN ('held', 'confirmed'));
```

排斥约束只依赖持久化状态，不使用 `now()`。接待确认时原占用从 `held` 更新为 `confirmed` 并清空 `expires_at`，不创建第二批占用。接待记录单独保留原确认截止时间用于审计和展示。

### 3.3 过期预占处理

所有可能新增或改变占用的事务，在取得门店日期锁后先执行范围内过期物化：

```sql
UPDATE resource_occupancies
SET blocking_state = 'inactive',
    expires_at = NULL,
    inactive_reason = 'expired',
    version = version + 1,
    updated_at = transaction_timestamp()
WHERE store_id = $1
  AND blocking_state = 'held'
  AND expires_at <= transaction_timestamp()
  AND occupied_range && $2::tstzrange;
```

随后重新查询占用并尝试插入。这样即使批量清理任务延迟，数据库排斥约束也不会被已经过期但尚未整理的记录阻挡。

读取待确认记录时，如果 `confirmation_deadline <= database_now`，API 对外返回有效状态 `expired`，不允许确认。需要写入资源时，必须在日期锁事务内把状态和占用正式物化为过期；后台任务只负责批量整理和生成运营待办。

### 3.4 房间与床位规则

- 按床使用：占用具体床位，并检查父房间没有整房独占占用。
- 整房独占：占用房间资源，并检查房间下所有床位均无冲突。
- 任一床位已占用时，不允许新增重叠的整房独占。
- 房间已独占时，不允许新增该房任一床位占用。
- 上述父子检查在门店日期锁内完成；同一资源的直接重叠由排斥约束兜底。

## 4 门店日期事务锁

### 4.1 锁键和日期集合

`stores` 保存数据库生成且全局唯一的 `lock_key integer`。日期键使用自然日与 `2000-01-01` 的天数差。调用 PostgreSQL 双 `integer` 形式的事务级 advisory lock，避免哈希碰撞：

```sql
SELECT pg_advisory_xact_lock(
  $store_lock_key,
  ($local_date - DATE '2000-01-01')::integer
);
```

日期集合按所有资源占用区间计算，而不是只按顾客服务时间：

1. 汇总准备、服务、整理、清洁、纯休息及不可用区间；
2. 取最早开始和最晚结束；
3. 按 `Asia/Shanghai` 找出与左闭右开区间相交的全部自然日；
4. 按日期升序依次加锁。

若结束时间正好为次日 `00:00`，由于上界不包含，不额外锁定次日。跨午夜、休息延伸至次日、排班发布和请假变更均使用同一个日期集合函数。

### 4.2 超时和性能目标

- 单次锁等待上限：1500 毫秒；
- 死锁、序列化失败或排斥约束冲突：最多重试 2 次，使用短随机退避；
- 最终失败返回 `RESOURCE_STATE_CHANGED` 或 `RESOURCE_BUSY_RETRY`；
- 测试环境 20 个并发请求竞争同一时段时，只允许一个成功；
- 单店基准数据下，预约提交接口 P95 目标小于 1000 毫秒，不含客户端网络耗时。

事务内禁止调用微信接口、发送消息、等待用户输入或执行其他外部请求。

### 4.3 新建多人预约

```text
校验身份和请求幂等键
→ 计算所有逐人资源区间和日期集合
→ 开启事务并按日期升序取得门店日期锁
→ 物化候选范围内的过期预占
→ 重新读取排班、请假、配置和当前阻挡占用
→ 一次性分配全部人员、床位、房间和设备
→ 写入接待、逐人安排、报价快照和全部 held 占用
→ 提交
```

任一客户无法安排则事务回滚，不留下接待、报价或部分资源占用。

### 4.4 改期

改期同时计算原安排和新安排涉及的全部日期，按稳定顺序一次取得锁。锁内校验记录版本，物化过期记录，暂时停用原占用并插入新占用；任一步失败则整个事务回滚，原状态和原占用自动恢复。禁止“先取消原预约，再尝试创建新预约”。

## 5 状态动作矩阵

所有可修改业务记录包含 `version integer`。修改接口要求 `If-Match` 或请求体版本；版本不一致返回 `VERSION_CONFLICT`。同一幂等键和相同请求返回原结果，同一键但请求内容不同返回 `IDEMPOTENCY_KEY_REUSED`。

### 5.1 接待确认状态

| 动作     | 前置状态                 | 操作者               | 占用变化                    | 重复操作               |
| -------- | ------------------------ | -------------------- | --------------------------- | ---------------------- |
| 创建申请 | 无                       | 顾客、前台           | 创建 `held` 占用            | 相同幂等键返回原申请   |
| 确认     | `pending` 且未到期       | 前台                 | 原占用改为 `confirmed`      | 已确认返回原成功结果   |
| 拒绝     | `pending`                | 前台                 | 占用改为 `inactive`         | 已拒绝返回原结果       |
| 撤回     | `pending`                | 申请人               | 占用改为 `inactive`         | 已撤回返回原结果       |
| 到期物化 | `pending` 且已到期       | 系统、任一相关写事务 | 占用改为 `inactive`         | 已过期不重复写业务事件 |
| 突发失效 | `pending`                | 排班人员、系统       | 占用改为 `inactive`         | 返回既有失效原因       |
| 取消     | `confirmed` 且服务未开始 | 前台                 | 未发生的占用改为 `inactive` | 已取消返回原结果       |

服务已经开始后不允许使用“取消接待”，必须执行中止服务并记录已发生区间、整理和休息。

请假影响已确认接待时，接待仍为 `confirmed`，原占用仍阻挡资源，同时生成 `conflict_pending` 处理标记；不能为了给别人预约而提前释放。

### 5.2 服务事实状态

| 动作     | 前置状态                 | 操作者         | 结果                                       |
| -------- | ------------------------ | -------------- | ------------------------------------------ |
| 登记到店 | `not_started`            | 前台           | `arrived`                                  |
| 开始服务 | `not_started`、`arrived` | 前台           | `in_service`，保存实际开始时间             |
| 登记超时 | `in_service`             | 前台           | 更新预计占用并生成受影响清单               |
| 核实完成 | `in_service`             | 前台           | `completed_verified`，保存实际结束时间     |
| 中止服务 | `in_service`             | 前台           | `terminated`，保留已发生工作和必要整理休息 |
| 历史更正 | 已结束状态               | 授权前台、店长 | 新增更正记录，不覆盖原事实                 |

时间经过预计结束点不自动改变服务事实状态，也不自动扣款或发奖励。

### 5.3 支付交易状态

| 动作         | 前置状态                           | 执行者               | 结果                |
| ------------ | ---------------------------------- | -------------------- | ------------------- |
| 创建支付     | 无                                 | 顾客、前台           | `created`           |
| 请求支付     | `created`                          | API                  | `processing`        |
| 确认成功     | `created`、`processing`、`unknown` | 已验签回调或主动查询 | `succeeded`         |
| 确认失败     | `created`、`processing`、`unknown` | 已验证结果           | `failed`            |
| 暂无确定结果 | `processing`                       | 查询任务             | `unknown`，继续查询 |

`unknown` 属于支付交易状态，不直接作为订单状态。支付渠道交易号和商户业务单号分别唯一；重复通知只更新同一交易。

### 5.4 订单结算汇总

订单不独立维护一套可随意修改的支付真相，而是从支付、资产扣款和退款明细推导：

```text
已收净额 = 成功现金支付 + 成功资产扣款 - 成功退款或资产恢复
```

| 推导条件                           | 订单结算状态         |
| ---------------------------------- | -------------------- |
| 已收净额为 0，且无处理中交易       | `unpaid`             |
| 存在处理中或未知交易，且尚未足额   | `payment_pending`    |
| 已收净额达到订单应收，成功退款为 0 | `paid`               |
| 成功退款大于 0 且小于原成功收款    | `partially_refunded` |
| 成功退款等于原成功收款             | `refunded`           |

任何累计成功退款不得超过原成功收款。页面可以缓存汇总状态，但每次资金事务必须根据明细重新校验。

### 5.5 礼品卡状态

| 动作       | 前置状态                       | 操作者         | 结果                          |
| ---------- | ------------------------------ | -------------- | ----------------------------- |
| 购卡入账   | 支付成功                       | 系统           | `available`                   |
| 发起赠送   | `available`                    | 当前持有人     | `pending_receive`             |
| 自用或领取 | `available`、`pending_receive` | 合法领取人     | `received` 并生成唯一资产来源 |
| 赠送到期   | `pending_receive`              | 系统           | `returned`，回原持有人卡包    |
| 申请退款   | 可退款状态                     | 合法发起人     | `refund_processing`           |
| 退款成功   | `refund_processing`            | 系统           | `refunded`                    |
| 退款失败   | `refund_processing`            | 系统、人工复核 | 恢复申请前状态                |

领取、到期和退款均锁定同一礼品卡记录，并使用条件更新和版本号。`gift_cards.asset_source_id` 建立唯一约束，保证一张卡最多生成一个有效资产来源。

### 5.6 退款状态

| 动作             | 前置状态                | 操作者           | 结果                       |
| ---------------- | ----------------------- | ---------------- | -------------------------- |
| 申请             | 可退款业务记录          | 顾客、前台       | `requested` 并保存预览     |
| 批准             | `requested`             | 有权限人员       | `approved` 并冻结相关权益  |
| 拒绝             | `requested`             | 有权限人员       | `rejected`                 |
| 提交渠道         | `approved`              | worker           | `processing`               |
| 确认成功         | `processing`、`unknown` | 已验证回调或查询 | `succeeded` 并完成资产调整 |
| 确认失败         | `processing`、`unknown` | 已验证结果       | `failed`，按规则解除冻结   |
| 结果未知         | `processing`            | worker           | `unknown`，保持冻结        |
| 超过自动处理上限 | 任一待处理状态          | worker           | `manual_review`            |

## 6 资金物理约束与锁顺序

### 6.1 API 金额契约

数据库使用 `bigint` 分。所有 JSON 请求和响应统一使用只包含十进制数字的字符串，例如：

```json
{
  "cashPaidCents": "9500",
  "creditedCents": "10000",
  "payableCents": "57880"
}
```

服务端进入领域逻辑前转换为 `bigint` 并校验范围；小程序和管理后台不得使用浮点数计算资金。展示层只负责把分格式化为人民币两位小数。

### 6.2 来源不变量

一期不在账户表重复保存总余额，账户余额直接汇总来源，避免双份余额漂移。每个资产来源保存：

```sql
CHECK (granted_amount >= 0),
CHECK (available_amount >= 0),
CHECK (frozen_amount >= 0),
CHECK (consumed_amount >= 0),
CHECK (voided_amount >= 0),
CHECK (
  granted_amount = available_amount
                 + frozen_amount
                 + consumed_amount
                 + voided_amount
)
```

含义：

- `granted_amount`：该来源最初授予的权益；
- `available_amount`：当前可消费；
- `frozen_amount`：退款或处理中暂不可用；
- `consumed_amount`：当前已被订单消耗且尚未恢复；
- `voided_amount`：充值退余、失效或其他已核准退出的权益。

订单资产分配保存 `allocated_amount` 和 `restored_amount`，并校验 `0 <= restored_amount <= allocated_amount`。现金支付分配保存 `paid_amount` 和 `refunded_amount`，并校验 `0 <= refunded_amount <= paid_amount`。

### 6.3 流水唯一性

- 每个业务请求先建立唯一 `business_events(idempotency_key, request_hash)`；
- 资产流水使用 `UNIQUE (business_event_id, line_no)`；
- 支付使用唯一商户业务单号和唯一渠道交易号；
- 退款使用唯一商户退款单号；
- 礼品卡的有效资产来源 ID 唯一；
- 正常业务流水只允许插入，不允许更新或删除；更正通过反向流水完成。

每条流水保存来源各分量变化，满足：

```text
delta_granted = delta_available
              + delta_frozen
              + delta_consumed
              + delta_voided
```

### 6.4 固定锁顺序

所有资金事务按以下表级顺序加锁；不需要的层级跳过，但不得交换顺序：

1. `business_events`；
2. 业务主记录：`orders`、`gift_cards` 或 `receptions`；
3. `payment_transactions`、`refund_requests`；
4. `asset_accounts`；
5. `asset_sources`；
6. `order_asset_allocations`、`payment_allocations`；
7. 商品库存记录；
8. 插入资产流水和审计记录。

同一表内锁定多行时按 UUID 字节序升序。捕获数据库约束错误后返回稳定业务错误，禁止通过重试绕过余额不足或退款上限。

## 7 后台任务租约协议

### 7.1 字段

`jobs` 至少包含：

| 字段                            | 说明                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| `status`                        | queued、running、retry_wait、succeeded、manual_review、canceled |
| `locked_by`                     | worker 实例 ID                                                  |
| `lease_token`                   | 每次领取生成的新 UUID                                           |
| `lease_until`                   | 当前租约截止时间                                                |
| `attempt_count`、`max_attempts` | 已执行次数和上限                                                |
| `next_run_at`                   | 下次可领取时间                                                  |
| `dedup_key`                     | 业务任务去重键                                                  |
| `external_idempotency_key`      | 微信支付或退款稳定业务单号                                      |
| `last_external_status`          | 最近一次主动查询结果                                            |
| `last_error`                    | 最后错误摘要，不保存密钥或完整支付凭据                          |

### 7.2 领取和写回

领取事务使用 `FOR UPDATE SKIP LOCKED` 选择任务，并在同一 SQL 中更新 `locked_by`、新 `lease_token` 和 `lease_until` 后返回任务。

续租、成功、失败都必须满足：

```sql
WHERE id = $job_id
  AND status = 'running'
  AND lease_token = $lease_token
  AND lease_until > transaction_timestamp()
```

更新影响行数为 0 表示执行者已经失去所有权。旧执行者必须丢弃本地计算结果，不得覆盖新执行者状态。

### 7.3 外部副作用

- 微信支付、退款使用稳定的商户订单号或退款单号；任务重领不得生成新业务号。
- 外部调用超时先记录 `unknown`，后续优先主动查询，不立即重复创建退款。
- 外部调用不放在数据库事务内。
- 调用完成后使用当前租约令牌写回；若令牌失效，任务处理器只查询外部最终状态，不直接重复业务调整。
- 默认最多自动尝试 8 次，指数退避并带随机抖动；仍无法确认时进入 `manual_review`。
- 奖励发放等内部任务同时受 `business_events` 唯一约束保护。

该协议保证 Worker A 租约过期后，不能覆盖 Worker B 的新结果；外部渠道即使已经接收 A 的请求，也通过稳定业务号和主动查询收敛到唯一结果。

## 8 配置确定性与历史版本

配置按业务域建立有限表，不使用任意公式。每个版本包含 `scope_type`、`scope_id`、`effective_from`、`effective_to`、`status` 和版本号。

确定性规则：

1. 同一配置类型、同一作用域的已发布生效区间禁止重叠；
2. 允许发布未来生效版本，但不能修改已经发布的版本；
3. 适用优先级固定为“人员与项目组合 > 人员 > 项目 > 门店默认”；
4. 某配置类型不支持的作用域不允许保存；
5. 同优先级出现多条匹配属于配置错误，关闭对应业务入口并生成后台待办；
6. 停用只影响未来选择，历史记录仍按版本 ID 读取；
7. 组合项目分别保存各组成项目版本，并保存组合计算结果。

报价、订单、充值、礼品卡和退款同时保存：

- 使用的配置版本 ID 列表；
- 完整最终计算明细 JSON；
- 金额、时长和舍入后的最终快照。

因此后续修改配置不会静默改变历史业务。

## 9 身份、会话与授权实体

### 9.1 顾客身份

- `customers`：业务顾客主体；
- `wechat_identities`：`appid + openid` 唯一并归属一个顾客，`unionid` 可空；
- `customer_phone_bindings`：只保存经过微信能力或验证码验证的绑定及历史；
- `customer_sessions`：刷新令牌只保存哈希，支持到期和主动撤销；
- `login_audits`：登录结果、设备摘要、时间和请求追踪号。

账户合并必须经过已验证身份流程，不能按手填手机号自动合并。退出登录、手机号换绑和会话失效不改变已有资产归属。

### 9.2 后台身份

- `staff_users`：后台员工账号及启停状态；
- `roles`、`permissions`、`staff_role_assignments`：门店范围内授权；
- `staff_sessions`：使用 HttpOnly、Secure、SameSite Cookie，会话支持撤销；
- 初始管理员通过部署时的一次性命令创建，不提供公开管理员注册入口。

接口先验证身份和归属，再进入业务事务。阶段 0 必须完成后台账号、角色鉴权基线和顾客会话骨架；阶段 1 完成微信身份绑定后，阶段 2 才允许真实顾客写入预约。

## 10 首个纵向流程 API 契约

### 10.1 查询可约

`POST /api/v1/availability/search`

请求时间统一使用带偏移量的 RFC 3339 字符串。请求中的 `timeZone` 目前只接受 `Asia/Shanghai`。

```json
{
  "storeId": "01991d88-7e6e-7c00-a041-a12b48b88e31",
  "timeZone": "Asia/Shanghai",
  "date": "2026-09-12",
  "guests": [
    {
      "clientGuestId": "guest-1",
      "serviceItemIds": ["01991d8b-12e1-78ad-a680-b92d326533de"],
      "therapistPreference": {
        "mode": "any"
      },
      "roomPreference": {
        "sameRoomGroup": "pair-a",
        "required": true
      }
    },
    {
      "clientGuestId": "guest-2",
      "serviceItemIds": ["01991d8b-12e1-78ad-a680-b92d326533de"],
      "therapistPreference": {
        "mode": "specific",
        "therapistId": "01991d8d-a845-75b1-a85c-0d65cc2a89e9"
      },
      "roomPreference": {
        "sameRoomGroup": "pair-a",
        "required": true
      }
    }
  ]
}
```

成功响应：

```json
{
  "queryFingerprint": "sha256:4efb...",
  "generatedAt": "2026-09-09T15:00:00+08:00",
  "configVersionIds": ["01991d90-1c21-7925-b7c5-6aca1f524201"],
  "options": [
    {
      "optionId": "option-1",
      "serviceStartAt": "2026-09-12T14:00:00+08:00",
      "serviceEndAt": "2026-09-12T15:00:00+08:00",
      "assignments": [
        {
          "clientGuestId": "guest-1",
          "therapistId": "01991d8d-0381-76a9-98c8-2e78dfca8491",
          "roomId": "01991d8e-71d5-7b2c-b411-e871a96d0d25",
          "bedId": "01991d8f-92e1-77f0-85ad-c40604406d19"
        },
        {
          "clientGuestId": "guest-2",
          "therapistId": "01991d8d-a845-75b1-a85c-0d65cc2a89e9",
          "roomId": "01991d8e-71d5-7b2c-b411-e871a96d0d25",
          "bedId": "01991d8f-d257-7351-9c22-37a443a8b94c"
        }
      ],
      "quote": {
        "originalCents": "133200",
        "discountCents": "12000",
        "payableCents": "121200"
      }
    }
  ]
}
```

查询结果只是候选，不保留资源。提交时必须重新计算；客户端不得修改报价或将候选结果当成最终成功依据。

### 10.2 创建多人预约

`POST /api/v1/receptions`

请求头：

```text
Authorization: Bearer <customer-session>
Idempotency-Key: 01991da0-2a5b-7ac8-a394-2465830bf152
Content-Type: application/json
```

请求体：

```json
{
  "storeId": "01991d88-7e6e-7c00-a041-a12b48b88e31",
  "queryFingerprint": "sha256:4efb...",
  "selectedOptionId": "option-1",
  "contact": {
    "name": "张女士",
    "verifiedPhoneBindingId": "01991d9e-7184-73dd-9744-b6c0b722ad25"
  },
  "guests": [
    {
      "clientGuestId": "guest-1",
      "serviceItemIds": ["01991d8b-12e1-78ad-a680-b92d326533de"],
      "therapistId": "01991d8d-0381-76a9-98c8-2e78dfca8491",
      "roomId": "01991d8e-71d5-7b2c-b411-e871a96d0d25",
      "bedId": "01991d8f-92e1-77f0-85ad-c40604406d19",
      "serviceStartAt": "2026-09-12T14:00:00+08:00"
    },
    {
      "clientGuestId": "guest-2",
      "serviceItemIds": ["01991d8b-12e1-78ad-a680-b92d326533de"],
      "therapistId": "01991d8d-a845-75b1-a85c-0d65cc2a89e9",
      "roomId": "01991d8e-71d5-7b2c-b411-e871a96d0d25",
      "bedId": "01991d8f-d257-7351-9c22-37a443a8b94c",
      "serviceStartAt": "2026-09-12T14:00:00+08:00"
    }
  ]
}
```

`201 Created`：

```json
{
  "receptionId": "01991da1-1a18-7a76-afeb-7a542e2e5f61",
  "status": "pending",
  "version": 1,
  "confirmationDeadline": "2026-09-10T11:00:00+08:00",
  "quote": {
    "currency": "CNY",
    "payableCents": "121200",
    "configVersionIds": ["01991d90-1c21-7925-b7c5-6aca1f524201"]
  }
}
```

相同幂等键和相同请求体重放时返回同一业务结果，并设置 `Idempotent-Replayed: true`。相同键但请求体不同返回：

```json
{
  "code": "IDEMPOTENCY_KEY_REUSED",
  "message": "该请求标识已用于另一笔预约",
  "requestId": "req-...",
  "details": {}
}
```

提交时资源已变化返回 `409 RESOURCE_STATE_CHANGED`，响应包含仍可保留的顾客输入，但不泄露员工请假原因。访问他人接待返回 `404`，避免暴露记录是否存在。

后续修改接口使用 `If-Match: "<version>"`；过期版本返回 `409 VERSION_CONFLICT` 并返回当前版本和可执行动作。

## 11 六组关键演算

### 11.1 跨午夜接待

测试配置：准备 10 分钟，服务 60 分钟，美容师整理 5 分钟，纯休息 15 分钟；服务开始为 `2026-09-09 23:50 +08:00`。

| 阶段   | 区间                       |
| ------ | -------------------------- |
| 准备   | 09 日 23:40 至 23:50       |
| 服务   | 09 日 23:50 至 10 日 00:50 |
| 整理   | 10 日 00:50 至 00:55       |
| 纯休息 | 10 日 00:55 至 01:10       |

美容师整体阻挡跨越两个自然日，因此按顺序锁定 09 日和 10 日。零点不拆成两个接待，也不释放资源。相邻预约必须在 10 日 01:10 之后开始其自身准备。

### 11.2 按前台可处理时间计算截止

测试配置：前台可处理时间为每天 09:00-12:00、13:00-18:00；线上保留累计 120 个可处理分钟。顾客在周二 17:30 提交，美容师本次工作准备开始为周三 14:00。

- 周二累计 17:30-18:00，共 30 分钟；
- 周三从 09:00 继续累计 90 分钟；
- 截止时间为周三 10:30；
- 10:30 早于本次工作开始 14:00，因此合法。

如果按累计结果得到 15:00，则最终截止被上限截为 14:00。截止前完全不存在有效处理窗口时，不接受线上申请。

### 11.3 两个入口并发抢同床

小程序请求 A 和前台代约请求 B 都选择同一门店、日期、床位和重叠区间：

1. A 先取得门店日期锁；B 等待；
2. A 物化过期预占、重查资源、插入占用并提交；
3. B 获得锁后重新查询，看到 A 的阻挡占用；
4. B 返回 `RESOURCE_STATE_CHANGED`；
5. 即使应用查询遗漏，排斥约束仍拒绝第二条重叠占用。

最终只有 A 成功，不产生 B 的接待或残留资源。

### 11.4 改期失败保留原安排

原预约为周五 14:00，目标为周六 15:00。事务锁定周五和周六，随后暂时停用原占用并尝试写入周六占用。若周六床位冲突，插入失败导致整个事务回滚；原预约状态、版本和周五占用全部恢复。对外返回改期失败，不出现“原预约被取消”的中间结果。

### 11.5 95 付 100 入后的两类退款

测试算法仅用于验证系统能力，不作为生产退款承诺。

充值来源初始值：现金支付 9500 分，授予权益 10000 分。

**A 充值退余：**消费 4000 分后，来源为可用 6000、已消费 4000。测试配置采用剩余权益按原现金比例退款：

```text
可退现金 = 9500 × 6000 ÷ 10000 = 5700 分
```

批准退款时先把可用 6000 转为冻结 6000；微信确认成功后，冻结转为作废 6000，现金退款累计增加 5700。不会同时恢复这 6000 余额。

**B 服务订单退款：**另一笔订单从该来源消费 2000 分，随后服务订单退款 500 分。成功后将原订单分配的 500 分从 `consumed` 恢复到同一来源的 `available`，不是向微信退 500 分现金。充值退余和订单退款使用不同业务入口及约束。

### 11.6 礼品卡领取、到期与退款竞争

卡处于 `pending_receive`，接收者领取、到期任务和退款任务同时触发：

1. 三方锁定同一礼品卡记录；
2. 第一个成功事务按当前状态进行条件更新；
3. 若领取先成功，生成唯一资产来源并变为 `received`，到期和未领取退款条件失败；
4. 若到期先成功，卡变为 `returned`，领取失败；
5. 若退款先进入 `refund_processing`，领取和到期均被阻止；
6. 唯一资产来源约束和退款业务幂等号防止重复价值。

## 12 调整后的实施顺序

| 阶段 | 交付内容                                                                 | 通过条件                                              |
| ---- | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| 0    | 仓库、版本、环境、日志、数据库迁移；后台账号、角色鉴权基线；顾客会话骨架 | API、worker、后台和小程序骨架可运行，未授权接口被拒绝 |
| 1    | 微信身份绑定；门店、资源、服务、配置和排班基础数据                       | openid 归属唯一，可录入 8 房、床位、8 人及技能        |
| 2    | 可约查询、待确认预约和后台确认                                           | 过期清理延迟、并发抢占和多人原子性测试通过            |
| 3    | 改期、取消、请假、冲突及接待事实                                         | 关键 AT 场景通过                                      |
| 4    | 商品、购物车、订单和库存预留                                             | 不超卖，暂不验收已付款交付                            |
| 5    | 微信支付、充值、余额核销；已付款商品到店交付                             | 重复回调、重复扣款、资金竞争和重复交付测试通过        |
| 6    | 礼品卡、退款和任务异常恢复                                               | 权益竞争、租约失效和退款未知测试通过                  |
| 7    | 会员、评价、邀请和运营配置                                               | 奖励来源、用途和退款回退可追溯                        |
| 8    | 全量验收、备份恢复、部署和运营交接                                       | AT、FT、权限、恢复和生产配置检查通过                  |

## 13 需求和验证映射

| 设计点                       | 需求或验收编号       | 自动化证据                                 |
| ---------------------------- | -------------------- | ------------------------------------------ |
| 过期实时失效并在写事务内物化 | R24、AT05、AT07      | 清理 worker 停止时，新预约仍能占用过期空档 |
| 多入口统一日期锁和排斥约束   | R27、AT10            | 小程序与后台并发抢同床最多一个成功         |
| 多人预约全部成功或失败       | R03、AT10、AT26      | 任一资源冲突后数据库无残留占用             |
| 改期回滚保留原安排           | R29、AT18            | 制造目标冲突后原版本和占用不变             |
| 跨午夜及前后休息             | R04-R09、AT14、AT21  | 09 日至 10 日完整区间演算通过              |
| 支付与入账幂等               | W05、FT01、FT02      | 重复回调只产生一个业务事件和一组流水       |
| 余额非负和固定锁序           | W07-W08、FT03、FT04  | 并发扣款不透支且无死锁                     |
| 礼品卡价值只转移一次         | G04、G07、FT05、FT06 | 领取、到期和退款并发只形成一个合法结果     |
| 退款冻结、查询和累计上限     | F02-F06、FT08-FT10   | 未知结果保持冻结，累计退款不超来源         |
| 任务租约令牌                 | Q01、Q07、FT02、FT09 | Worker A 租约过期后写回影响行数为 0        |
| 配置及历史快照               | P02-P06、AD13、FT15  | 发布新配置后历史报价和退款口径不变         |
| 身份归属和服务端权限         | W01-W02、Q02、FT16   | 访问他人记录及无权限资金操作被拒绝         |

## 14 第二轮复核清单

- [ ] 过期预占与排斥约束不存在时间谓词冲突；
- [ ] 同一占用可以表达“held 的 prepare”和“confirmed 的 service”；
- [ ] 所有占用资源存在数据库外键和门店归属；
- [ ] 接待、服务、支付、订单、礼品卡和退款动作矩阵可执行；
- [ ] 资金来源满足非负、恒等式、唯一事件和退款上限；
- [ ] API 金额不存在 JavaScript `BigInt` JSON 歧义；
- [ ] 旧 worker 的过期租约不能写回；
- [ ] 配置选择结果唯一且历史可回放；
- [ ] 真实预约写入前已具备身份和权限基线；
- [ ] 两个首批接口可以直接进入实现；
- [ ] 六组演算能映射到自动化测试。

## 15 参考资料

- PostgreSQL `CREATE TABLE` 和排斥约束：https://www.postgresql.org/docs/current/sql-createtable.html
- PostgreSQL advisory lock：https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
- PostgreSQL `SELECT` 与 `SKIP LOCKED`：https://www.postgresql.org/docs/current/sql-select.html
- JavaScript `BigInt` JSON 序列化说明：https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/BigInt_not_serializable
