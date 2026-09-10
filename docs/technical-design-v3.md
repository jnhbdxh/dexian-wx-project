# 得闲小程序与管理系统技术设计 V3 核心业务修订版

## 1 文档状态

- 阶段 0：允许实施环境、鉴权骨架和基础工程。
- 预约、资金、礼品卡、退款和任务结果提交：完成本版复核前不得进入生产实现。
- V1、V2 保留为评审历史；与本版冲突的资源占用、期限、退款、任务、候选方案、配置和状态规则，以本版为准。
- 本版只修订第二轮评审指出的边界，不增加中间件，不改变技术栈。

## 2 正常分配、不可用限制和真实事实分表

### 2.1 三类记录的职责

| 记录                    | 保存内容                                                             | 是否允许与其他类型重叠                   | 数据库保护               |
| ----------------------- | -------------------------------------------------------------------- | ---------------------------------------- | ------------------------ |
| `resource_allocations`  | 待确认和已确认接待的正常资源分配，包括准备、服务、整理、清洁和纯休息 | 不允许同一资源的两份正常分配重叠         | 排斥约束                 |
| `resource_restrictions` | 请假、午休、培训、停业、设备故障等不可用限制                         | 允许与已确认分配、其他限制及必要休息重叠 | 外键、区间和状态约束     |
| `resource_actual_facts` | 已发生的实际服务、实际整理和真实超时                                 | 允许与后续已确认分配重叠                 | 外键、区间和事实修订记录 |

新增可约和正常改期必须同时检查三张表。任何一条有效记录发生区间相交，都可能使候选资源不可用。系统没有绕过这些检查的“强制预约”入口。

突发事实可以形成冲突，但不能被数据库拒绝：

- 美容师突然请假：保存 restriction；已有确认 allocation 保留并生成冲突待办；待确认接待整组失效。
- 实际服务超时：保存或延长 actual fact；后续已确认 allocation 保留并生成冲突待办；阻止新的重叠预约。
- 午休覆盖必要休息：restriction 与 allocation 中的 rest 可以重叠；算法按连续不可工作区间的并集判断休息是否满足，不把分钟数相加。

### 2.2 统一资源和正常分配 DDL

所有资源仍通过统一 `resources` 表引用。资源和业务对象都使用带门店列的组合外键，防止跨店关联。

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

CREATE TYPE allocation_segment_kind AS ENUM (
  'prepare', 'service', 'cleanup', 'rest'
);

CREATE TYPE allocation_state AS ENUM (
  'held', 'confirmed', 'inactive'
);

CREATE TABLE resource_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  reception_id uuid NOT NULL,
  reception_guest_id uuid,
  segment_kind allocation_segment_kind NOT NULL,
  allocation_state allocation_state NOT NULL,
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
  FOREIGN KEY (store_id, reception_id)
    REFERENCES receptions(store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, reception_id, reception_guest_id)
    REFERENCES reception_guests(store_id, reception_id, id) ON DELETE RESTRICT,
  CHECK (end_at > start_at),
  CHECK (
    (allocation_state = 'held' AND expires_at IS NOT NULL)
    OR (allocation_state <> 'held' AND expires_at IS NULL)
  )
);

ALTER TABLE resource_allocations
  ADD CONSTRAINT normal_resource_allocation_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    occupied_range WITH &&
  )
  WHERE (allocation_state IN ('held', 'confirmed'));
```

`receptions` 必须有 `UNIQUE(store_id, id)`，`reception_guests` 必须有 `UNIQUE(store_id, reception_id, id)`。美容师和床位分配必须指向具体顾客；多人整房独占可以只归属接待，因此 `reception_guest_id` 可空。约束触发器根据资源类型校验这一规则。床位扩展表使用组合外键引用同店房间资源；延迟约束触发器校验床位父级一定是房间。被历史记录引用的资源只能停用，不能删除。

### 2.3 不可用限制和实际事实

```sql
CREATE TYPE restriction_kind AS ENUM (
  'leave', 'meal_break', 'training', 'store_closed',
  'equipment_fault', 'other_unavailable'
);

CREATE TABLE resource_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  resource_id uuid,
  restriction_kind restriction_kind NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  reason_private text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id)
    REFERENCES stores(id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, resource_id)
    REFERENCES resources(store_id, id) ON DELETE RESTRICT,
  CHECK (end_at > start_at),
  CHECK (
    (restriction_kind = 'store_closed' AND resource_id IS NULL)
    OR (restriction_kind <> 'store_closed' AND resource_id IS NOT NULL)
  )
);

CREATE TYPE actual_fact_kind AS ENUM (
  'actual_service', 'actual_cleanup', 'actual_rest'
);

CREATE TABLE resource_actual_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  reception_id uuid NOT NULL,
  reception_guest_id uuid NOT NULL,
  fact_kind actual_fact_kind NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  supersedes_fact_id uuid,
  recorded_by uuid NOT NULL REFERENCES staff_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, id),
  FOREIGN KEY (store_id, resource_id)
    REFERENCES resources(store_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, reception_id, reception_guest_id)
    REFERENCES reception_guests(store_id, reception_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (store_id, supersedes_fact_id)
    REFERENCES resource_actual_facts(store_id, id) ON DELETE RESTRICT,
  CHECK (end_at > start_at)
);
```

实际事实只追加，不覆盖。更正记录通过同门店组合外键 `supersedes_fact_id` 指向旧事实，读取时使用最新有效链。门店停业使用 `resource_id IS NULL` 的门店级 restriction；其他限制必须指向具体资源。顾客侧不返回 `reason_private`。

### 2.4 冲突待办

`resource_conflicts` 保存事实与承诺的冲突关系，包括门店、资源、左侧记录、右侧记录、发现时间、严重程度、处理状态和处理说明。它不是放行冲突的开关。

保存 restriction 或 actual fact 后，在同一事务中查找受影响记录：

- 待确认接待：按整组接待失效，停用该接待全部 held allocation；
- 已确认接待：保留全部 allocation，建立冲突待办；
- 尚不存在的预约：后续可约查询直接视为不可用。

AT14、AT15、AT19 分别验证休息覆盖、请假冲突和真实超时。

## 3 当前时间、截止和整组过期

### 3.1 判定时点

期限判断不使用 `transaction_timestamp()`。规则如下：

| 动作               | 判定时点                                                                      |
| ------------------ | ----------------------------------------------------------------------------- |
| 接待确认           | 取得全部相关日期锁后执行 `SELECT clock_timestamp()`，以返回值作为本次决策时间 |
| 过期物化           | 与确认使用同一锁后决策时间                                                    |
| 任务领取           | 实际更新任务行时使用 `clock_timestamp()`                                      |
| 任务续租和结果写回 | 最终条件更新语句执行时使用 `clock_timestamp()`                                |
| 审计创建时间       | 可以使用 `transaction_timestamp()`，不参与期限成败判断                        |

确认流程必须先锁定再取时间。若事务在 10:29:59 开始、10:30:01 才取得锁，决策时间为 10:30:01，截止 10:30:00 的申请按过期处理，不能确认。

### 3.2 整组过期物化

过期以接待为单位，不按单个占用片段处理：

1. 在日期锁内按候选范围查找 `pending` 且 `confirmation_deadline <= decision_now` 的接待；
2. 读取每个接待的全部 held allocation，验证其日期均已锁定；
3. 插入唯一业务事件 `reception.expired`；
4. 把接待改为 `expired`；
5. 把该接待全部 held allocation 改为 `inactive` 并清空 `expires_at`；
6. 同一事务提交。

若发现该接待存在未锁日期，整个事务回滚，补齐日期集合后重新开始。多人和跨日接待不会出现部分过期。

## 4 稳定的预约锁范围

### 4.1 拓扑锁

每个门店有唯一 `lock_key integer`，并保留 `-2147483648` 作为资源拓扑与配置锁的第二键；自然日期键不会使用该值。

- 预约、改期、排班、请假：先取得门店拓扑共享事务锁，再取得日期事务锁。
- 发布会改变占用计算的配置、修改床房父子关系或停用资源：取得门店拓扑独占事务锁。
- 锁顺序固定为“拓扑锁 → 日期升序锁”。

这样预约锁内重读配置和资源关系时，它们不会被同时发布或改动。

### 4.2 保守日期范围

系统限制一位顾客从最早准备开始到最晚纯休息结束的单次正常占用跨度不超过 24 小时。跨日服务仍被支持，但不支持单次跨越多日的服务项目。

新建预约对所选服务开始自然日 `D`，固定锁定 `D-1`、`D`、`D+1`。多人预约取所有服务开始日三日集合的并集。改期锁定原安排与目标安排集合的并集。

锁内重读配置、重新选择美容师并计算最终区间后，必须验证全部 allocation 日期属于已锁集合：

- 属于：继续写入；
- 超出：回滚，根据完整实际日期集合重新开始；
- 违反 24 小时系统上限：返回 `INVALID_SERVICE_DURATION_CONFIG` 并关闭该项目预约入口。

实际超时和多日请假不受 24 小时正常项目限制。它们根据已经确定的事实区间锁定全部相交自然日，然后保存 restriction 或 actual fact。

## 5 退款类型、额度预留和恢复

### 5.1 一期支持边界

| 类型       | 一期处理方式                                                                 |
| ---------- | ---------------------------------------------------------------------------- |
| 纯资产退款 | 支付来源全部为余额或奖励；在批准事务中直接恢复原来源                         |
| 纯现金退款 | 支付来源全部为微信现金；批准时预留现金可退额度，渠道异步完成                 |
| 混合退款   | 一期不开启混合支付，因此不创建混合退款；未来启用混合支付前另行增加分腿状态机 |

充值退余属于纯现金退款，但计算基础是对应充值资产来源的剩余权益；服务订单的余额支付退款属于纯资产恢复。两个入口和状态机不能混用。

### 5.2 申请与批准

申请阶段的预览只用于说明，不占用额度。批准时必须在固定锁顺序内重新读取并重新计算：

```text
现金可预留额度 = 原成功支付
              - 已成功现金退款
              - 其他处理中现金退款预留

资产可恢复额度 = 原订单来源分配
              - 已成功恢复
              - 其他处理中恢复预留
```

不足时拒绝批准并返回新的可退明细。批准不能直接使用旧预览。

相关字段满足：

```sql
CHECK (cash_refunded_amount >= 0),
CHECK (cash_refund_reserved_amount >= 0),
CHECK (
  cash_refunded_amount + cash_refund_reserved_amount <= paid_amount
),
CHECK (asset_restored_amount >= 0),
CHECK (asset_restore_reserved_amount >= 0),
CHECK (
  asset_restored_amount + asset_restore_reserved_amount <= allocated_amount
);
```

并发批准两笔退款时锁定相同支付或资产分配行，只有仍有剩余额度的事务能成功预留。

### 5.3 纯资产恢复

有权限人员批准时，在一个数据库事务中完成：

1. 重新计算可恢复额度；
2. 锁定原订单分配和原资产来源；
3. 将 `consumed` 减少、`available` 增加；
4. 更新分配的 `asset_restored_amount`；
5. 插入唯一资产流水和审计记录；
6. 退款请求从 `requested` 直接变为 `succeeded`。

没有渠道任务，也不经过 `processing`。

### 5.4 纯现金退款

批准事务完成：

1. 重新计算现金可退额度；
2. 增加 `cash_refund_reserved_amount`；
3. 退款请求变为 `approved`；
4. 使用稳定商户退款单号创建唯一 job；
5. 与以上业务变化同事务提交。

worker 调用渠道后：

- 成功：预留减少、成功退款增加，退款变为 `succeeded`；
- 明确失败：预留释放，退款变为 `failed`；
- 未知：预留保持，退款变为 `unknown` 并继续查询；
- 自动查询达到上限：变为 `manual_review`，预留仍保持。

人工处理 `manual_review` 只能选择：

- 查询并确认渠道成功，然后按成功路径提交；
- 取得渠道明确失败或不存在的证据后释放预留；
- 继续保留限制并稍后查询。

不能仅凭操作人员判断释放未知退款。迟到成功通知按稳定商户退款单号定位原请求；只要预留仍在，按成功路径完成。若数据不一致，进入资金异常待办，禁止创建第二笔补偿退款。

充值退余批准时，还要在同一事务中把对应充值来源的可用权益转为冻结。渠道结果未知或进入人工处理时保持冻结；确认成功后由冻结转为作废；取得渠道明确失败结果后才恢复为可用。这样顾客不能在现金退款处理中再次消费同一份权益。

### 5.5 修正后的资金演算

以下是两个互相独立的测试场景。

**场景 A 充值退余：**实付 9500 分、入账 10000 分，已消费 4000 分，剩余 6000 分。测试规则为按原现金比例退余，批准时冻结 6000 分权益并预留 5700 分现金；渠道成功后权益转作废、现金成功退款 5700 分。

**场景 B 服务订单资产退款：**另一独立测试账户有余额来源 10000 分，服务订单从该来源消费 2000 分，退款 500 分。批准事务把 500 分从已消费恢复到同一来源可用余额，不产生微信退款。

## 6 任务所有权与业务结果原子提交

### 6.1 必需任务不丢失

业务记录与其必需 job 在同一个数据库事务中创建，并通过 `UNIQUE(dedup_key)` 防重复。例如批准现金退款、写入退款额度预留和创建退款 job 同事务提交；任何一步失败全部回滚。

### 6.2 内部任务时序

以奖励发放为例：

```text
领取 job 并获得 lease_token
→ 开始业务结果事务
→ 锁定 job，校验 token、running 和 clock_timestamp() < lease_until
→ 按资金锁顺序锁定订单、账户和来源
→ 插入唯一 business_event 和奖励来源流水
→ 条件更新 job 为 succeeded，再次校验 token 和当前 clock_timestamp()
→ 若更新 0 行，抛错并回滚整个事务
→ 提交
```

旧 worker 不能留下奖励入账、流水或业务事件。

### 6.3 渠道退款回写时序

外部调用不放在数据库事务内。worker 使用稳定商户退款单号调用或查询微信后，再执行：

```text
开始结果事务
→ 锁定 job，校验 token、状态和当前租约
→ 按固定顺序锁定退款、订单和支付分配
→ 根据已验证渠道结果更新预留、成功额和退款状态
→ 条件更新 job 最终状态，再次校验 token 和 clock_timestamp()
→ 更新 0 行则抛错，业务变更一并回滚
→ 提交
```

若外部调用成功但 worker 在写回前失去租约，旧 worker 不能提交。新 worker 使用同一商户退款单号先查询渠道结果，再完成唯一写回。

### 6.4 租约条件

任务领取、续租和最终写回使用 `clock_timestamp()`：

```sql
WHERE id = $job_id
  AND status = 'running'
  AND lease_token = $lease_token
  AND lease_until > clock_timestamp()
```

执行预计超过租约一半时主动续租。默认最多自动尝试 8 次；达到上限进入 `manual_review`。

## 7 礼品卡与赠送批次

### 7.1 状态拆分

礼品卡本体状态：`available`、`in_transfer`、`received`、`refund_processing`、`refunded`。

每次赠送创建独立 `gift_transfer_batches`：

| 字段                   | 含义                                  |
| ---------------------- | ------------------------------------- |
| `gift_card_id`         | 礼品卡                                |
| `sender_customer_id`   | 发起赠送时持有人                      |
| `share_token_hash`     | 分享凭据哈希，不保存明文              |
| `expires_at`           | 本批次领取截止                        |
| `status`               | pending、received、expired、withdrawn |
| `receiver_customer_id` | 成功领取人，可空                      |
| `version`              | 并发版本                              |

### 7.2 本人自用

本人自用要求：当前登录顾客是卡当前持有人、卡状态为 `available`、卡不在退款中。事务锁定礼品卡后生成资产来源，卡变为 `received`。

### 7.3 赠送领取

领取要求同时满足：

- 登录顾客身份有效；
- 分享令牌匹配当前 pending 批次；
- 批次属于礼品卡当前赠送批次；
- `clock_timestamp() < expires_at`；
- 卡状态为 `in_transfer`；
- 领取规则允许当前领取人。

到期任务延迟不会放宽期限。领取成功后批次为 `received`，卡为 `received`，并生成唯一资产来源。

### 7.4 到期回卡和再次使用

到期时批次改为 `expired`，礼品卡本体恢复为 `available`，持有人仍为发起赠送者。因此可以再次赠送、本人使用或申请退款。“已退回卡包”是由最近批次 `expired` 推导的展示状态，不是阻塞后续操作的卡本体终态。

退款失败恢复时重新读取当前时间和赠送批次：已过期批次不能恢复为 pending，卡恢复为 `available`；仍有效且产品允许恢复赠送时才可恢复为 `in_transfer`。

### 7.5 正确方向的唯一来源约束

资产来源保存 `origin_gift_card_id`：

```sql
ALTER TABLE asset_sources
  ADD COLUMN origin_gift_card_id uuid
    REFERENCES gift_cards(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX asset_sources_one_per_gift_card
  ON asset_sources(origin_gift_card_id)
  WHERE origin_gift_card_id IS NOT NULL;
```

该约束保证同一礼品卡历史上最多创建一个资产来源，即使礼品卡记录的展示字段被修改，也不能产生第二份权益。

## 8 候选方案和报价变化

### 8.1 可信候选凭据

查询可约不保存资源，但返回服务端签名的短期 `candidateToken`。令牌载荷包含：

- 顾客 ID 和会话 ID；
- 门店、规范化预约意图及其 SHA-256；
- 逐人项目、时长、开始时间和候选人员；
- 同房硬要求等顾客可见约束；
- 逐人房间、床位分配；
- 逐人报价明细、总价和配置版本 ID；
- 签发时间和 5 分钟有效期。

令牌使用服务端 HMAC 签名，客户端不能修改。它只证明“服务端曾给出该候选”，不代表资源已保留。

### 8.2 提交时比较

创建预约提交原始业务意图和 `candidateToken`。服务端验证签名、期限、顾客、会话和意图哈希，再在日期锁内重新分配和报价。

以下顾客可见结果发生变化时不创建预约，返回 `409 CANDIDATE_CHANGED`：

- 服务时间、项目或逐人服务时长；
- 指定或已展示的美容师；
- 同房硬要求无法满足；
- 顾客可见房型；
- 原价、优惠或应付金额。

响应包含 `changedFields`、新逐人明细和新的 `candidateToken`，顾客确认后重新提交。仅内部床号变化且房型、同房要求、人员、时长和价格均不变时，可以继续创建。

查询和创建成功响应都返回逐人：项目明细、服务分钟数、美容师、顾客可见房型、原价、各项优惠、应付分摊和所用配置版本。

## 9 按配置类型确定规则

不再使用统一的“人员优先”规则。

| 配置类型         | 选择或合并规则                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------ |
| 项目休息         | 项目明确设置时使用项目值；未设置时使用门店默认；再与美容师个人最低休息取较大值             |
| 准备和整理       | 项目值优先；未设置时使用门店默认；若实际执行者规则要求更长，取更长值                       |
| 价格             | 按已发布的有限价格类型决定，如人员项目价、人员等级价、项目基础价；同一价格类型必须唯一命中 |
| 优惠             | 按配置的适用条件和固定叠加顺序计算，不用覆盖优先级代替计算顺序                             |
| 权限             | 角色权限并集后再应用显式禁止和金额阈值，不按作用域简单覆盖                                 |
| 房间和资源硬限制 | 所有适用限制同时满足，不互相覆盖                                                           |

数值列使用 nullable 表示“未设置”，整数 `0` 表示“明确为零”。配置发布前校验所有类型能产生唯一、可解释的结果。报价同时保存配置版本 ID 和最终计算快照。

## 10 补充状态和操作边界

### 10.1 接待动作

| 动作           | 前置条件                                           | 结果                                                               |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| 前台直接确认   | 有权限、完整资源可用、客户资料可选                 | 直接创建 `confirmed` 接待和 allocation，不经过 pending             |
| 调整确认期限   | `pending` 且尚未到期；新期限不超过本次工作准备开始 | 更新接待截止及全部 held allocation 的 `expires_at`，记录版本和原因 |
| 核实完成并补录 | 服务尚未有开始事实，但前台能提供实际开始和结束     | 一次录入完整实际事实，标记 `backfilled`，无需机械补点“开始服务”    |
| 核实完成并结算 | 服务事实和资金分别保存                             | 一个页面可连续办理，但完成事实不因扣款失败而撤销                   |

### 10.2 订单结算状态判定顺序

一期不主动提供部分付款和超额付款入口，但保留异常恢复状态。每次按以下互斥顺序推导：

1. 已确认成功收款大于应收：`overpaid_review`；禁止继续收款并生成异常待办。
2. 存在会改变最终金额的 `processing` 或 `unknown` 交易：`payment_pending`。
3. 原成功收款大于 0，且成功退款或资产恢复等于原成功收款：`refunded`。
4. 成功退款大于 0 且小于原成功收款：`partially_refunded`。
5. 当前净收款等于应收且应收大于 0：`paid`。
6. 当前净收款大于 0 且小于应收：`partially_paid_review`。
7. 其他情况：`unpaid`。

全额退款不会再同时命中 `unpaid`。部分付款只作为异常恢复状态，由前台补足或按授权取消，不伪装成结算成功。

## 11 全局锁顺序和幂等作用域

### 11.1 锁顺序

同一事务需要多种业务主记录时使用以下全序：

1. `jobs`，仅任务结果事务；
2. `business_events`；
3. `receptions`；
4. `gift_cards`；
5. `orders`；
6. `refund_requests`；
7. `payment_transactions`；
8. `asset_accounts`；
9. `asset_sources`；
10. 资产或支付分配；
11. 商品库存；
12. 插入流水和审计记录。

同表多行按 UUID 字节序升序。业务事务创建新 job 时只插入，不锁既有 job；修改或完成既有 job 的事务必须从 job 所有权校验开始，避免锁环。

### 11.2 幂等键作用域

唯一约束为：

```text
actor_type + actor_id + operation_type + idempotency_key
```

同一作用域保存规范化请求哈希和原响应。相同哈希返回原结果；不同哈希返回 `IDEMPOTENCY_KEY_REUSED`。微信回调另按商户订单号和渠道交易号唯一，不依赖顾客提供的幂等键。

## 12 修订后的关键用例

以下均为待实现、待执行用例，不表示已经测试通过。

| 用例                     | 完整前置条件                                          | 预期结果                                                          |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- |
| 截止前开事务、截止后得锁 | 10:29:59 开始；截止 10:30:00；10:30:01 取得日期锁     | 锁后 `clock_timestamp()` 判定过期，整组 allocation 失效，不能确认 |
| 清理任务停机后重新预约   | held 已过期但仍持久化；worker 停止                    | 写事务整组物化过期，新预约可正常插入                              |
| 午休覆盖纯休息 AT14      | 服务后需休息 15 分钟；已有午休 restriction 覆盖该区间 | 连续休息满足，不重复顺延；两类记录允许重叠                        |
| 请假撞确认接待 AT15      | 已确认 allocation；新增重叠 leave restriction         | 请假保存成功，原接待占用保留，生成冲突待办，阻止新增              |
| 真实超时 AT19            | 实际服务延长并撞后单                                  | actual fact 保存成功，后单保留并产生冲突，新的重叠预约被拒绝      |
| 锁内换人跨日             | 预选人员休息不过零点；锁内最终人员休息跨零点          | D-1/D/D+1 已保守锁定；若仍超界则回滚补锁                          |
| 两笔现金退款并发批准     | 原现金可退 1000 分，两笔各申请 800 分                 | 首笔预留 800，第二笔重算后失败，不会向渠道多退                    |
| 纯资产退款               | 原来源消费 2000 分，本次恢复 500 分                   | 批准事务直接恢复来源、更新分配和流水，无渠道 job                  |
| 旧 worker 回写           | A 外调后租约失效，B 获得新 token                      | A 的任务和所有业务修改整体回滚；B 查询同一业务号后唯一提交        |
| 礼品卡过期领取           | 分享批次已过期，清理任务未运行                        | 领取按 `clock_timestamp()` 失败；到期事务使卡恢复 available       |
| 候选价格变化             | 查询价 121200 分，提交重算 130000 分                  | 不创建预约，返回差异和新 token，等待顾客再次确认                  |

## 13 阶段 0 放行范围

阶段 0 可以立即实施：

- pnpm workspace、Node.js 版本固定和依赖锁文件；
- Fastify API、worker 启动入口和健康检查；
- Vue 管理后台和微信原生小程序空壳；
- PostgreSQL 连接、通用迁移框架和测试数据库；
- 统一日志、请求追踪、错误响应和环境配置校验；
- 后台员工、角色、权限和会话骨架；
- 顾客会话接口骨架及模拟身份；
- CI 中的格式、类型、单元测试和迁移检查。

阶段 0 不创建本版仍待复核的预约、资金、礼品卡和退款核心表，不实现相关业务事务。

## 14 第三轮复核清单

- [ ] 正常分配受到排斥约束，突发限制和真实冲突仍可如实保存；
- [ ] AT14、AT15、AT19 有明确存储路径；
- [ ] 所有期限判断在取得锁后使用实际数据库当前时间；
- [ ] 过期以整组接待原子物化；
- [ ] 锁内重算不会越出未持有的日期范围；
- [ ] 纯资产退款与现金渠道退款路径分离；
- [ ] 已成功和处理中退款共同占用上限；
- [ ] 旧任务租约不能提交任何业务结果；
- [ ] 必需 job 与业务记录同事务创建；
- [ ] 礼品卡领取校验批次期限，回卡后可以继续使用；
- [ ] 同一礼品卡最多生成一个资产来源；
- [ ] 候选方案绑定身份和意图，价格变化必须重新确认；
- [ ] 休息、价格、优惠和权限分别使用自己的确定规则；
- [ ] 订单结算状态互斥且有固定判定顺序；
- [ ] 用例表明确标记为待执行，而非既有测试证据。
