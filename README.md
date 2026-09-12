# 得闲小程序与管理系统

阶段 0 的工程、环境、身份认证和今日工作台角色授权已经完成。核心业务设计评审已经关闭，当前预约纵向切片已实现资源、班次、不可用限制、可约查询、房间床位自动安排、待确认预占、后台确认接口和运营确认页面；真实请假后端事务及运营登记、结果核实、冲突查看与定位页面也已实现。微信登录、短信验证与支付联调骨架已完成，包含主动查单、异常重试、过期预支付凭证恢复和人工复核状态；真实短信渠道、微信商户配置及生产域名仍需在权限、模板、域名和密钥下发后联调，因此暂不具备生产上线条件。自动更换美容师、改期、取消、请假撤销、实际服务、充值、余额、礼品卡及退款仍待后续切片实现。

## 工程目录

- `apps/api`：Fastify API 和 worker
- `apps/admin`：Vue 管理后台
- `apps/miniprogram`：微信原生小程序
- `docs`：需求对应的技术设计和评审版本

## 本地启动

要求 Node.js `24.14.1`、pnpm `11.19.0` 和 Docker。

1. 在仓库根目录将 `.env.example` 复制为 `.env`，将 `BOOTSTRAP_ADMIN_PASSWORD` 改为仅供本机使用的长密码。API、worker、迁移和管理员初始化命令都会自动读取这个根目录文件；操作系统中已有的同名环境变量优先。
2. 启动数据库：`docker compose up -d postgres`
3. 安装依赖：`pnpm install`
4. 执行仓库已有迁移：`pnpm db:migrate`
5. 创建本地初始管理员：`pnpm --filter @dexian/api admin:bootstrap`
6. 启动 API：`pnpm dev:api`
7. 启动管理后台：`pnpm dev:admin`

小程序目录可由微信开发者工具直接导入；仓库配置使用游客 AppID。首次导入前若 `apps/miniprogram/project.private.config.json` 不存在，请先创建该文件并写入 `{"appid":"你的真实 AppID"}`；也可以导入后在开发者工具的“详情 → 基本信息”中填写，随后确认真实 AppID 已写入这个被 Git 忽略的私有文件。发布前请再核对它属于目标小程序账号。

本地联调时小程序请求 `http://127.0.0.1:3000`，需先启动 API，并在微信开发者工具中关闭“校验合法域名”。游客 AppID 且后端未配置微信登录时，小程序会自动使用仅在非生产环境开放的开发登录；正式发布前必须配置 HTTPS 业务域名及真实微信登录参数。

## 验证命令

```text
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

接口存活检查：`GET http://127.0.0.1:3000/health/live`

数据库就绪检查：`GET http://127.0.0.1:3000/health/ready`

角色授权检查：登录后访问 `GET http://127.0.0.1:3000/api/v1/admin/operations/overview`。未登录返回 401；没有 `operations.overview.read` 权限返回 403。

预约首个切片提供以下顾客接口：

- `GET /api/v1/booking/catalog`：返回启用门店、项目及具备相应技能的美容师，不公开房间和床位。
- `POST /api/v1/availability/queries`：按顾客选择的项目、美容师和开始时间查询可约候选；房间和床位由门店规则自动安排。
- `POST /api/v1/receptions`：凭候选令牌按已发布政策计算线上确认期限并创建待确认预占；期限累计营业时间与前台处理时间的交集，且不晚于整组最早准备开始。请求必须同时提供 `Idempotency-Key` 请求头。
- `GET /api/v1/receptions`：按当前顾客身份分页返回预约历史和最新状态；支持 `after` 游标，不公开房间、床位或其他顾客记录。
- `GET /api/v1/receptions/:receptionId`：返回当前顾客的一条预约详情；待确认记录超过服务端截止时间后按已过期展示，请假导致的待确认失效会返回对应原因。

后台确认接口：

- `POST /api/v1/admin/receptions/:receptionId/confirm`：将未过期的整组预占确认，要求员工会话、`receptions.confirm` 权限、CSRF 请求头、`Idempotency-Key` 及 `If-Match: "<version>"`。确认成功后原 `held` 占用原位变为 `confirmed`；锁等待期间过期则整组失效并返回 `RECEPTION_EXPIRED`。

管理后台 `/dashboard` 提供待确认列表、服务与资源明细、服务端时间校准的倒计时和确认操作。401 会返回登录页；403、已过期、版本变化、资源繁忙及网络／服务异常分别给出对应处理指引。网络结果未知或资源繁忙时，页面重试会复用同一个幂等键。

请假登记后端接口：

- `POST /api/v1/admin/leaves`：登记美容师已经确定的真实请假，要求员工会话、`scheduling.leave.write` 权限、CSRF 请求头及 `Idempotency-Key`。请假保存后立即生效；相交的未过期待确认接待整组转为 `invalidated` 并释放全部占用，已确认接待及原占用保持不变并生成去重的冲突记录。自然过期的接待按 `expired` 处理，不计入请假失效数量。

该接口已经覆盖请假与确认并发、幂等等待跨过截止时间、多人组跨日期扩锁及锁超时回滚。`GET /api/v1/admin/scheduling/leave-workbench` 返回当前门店可选美容师及尚待人工跟进的已确认接待冲突。

管理后台 `/scheduling` 提供真实请假登记、未知结果同键核实、冲突查看和接待定位。未核实请求会在当前浏览器标签页中保留，刷新或重新登录后继续使用原幂等键；普通路由离开会被阻止。冲突列表按稳定游标继续加载并显示数据库准确总数，跨日区间会完整显示起止日期。页面不会自动换人，也不提供解决、撤销、改期或取消动作，请勿据此认为冲突处理业务已经完整闭环。

候选令牌使用 `BOOKING_TOKEN_SECRET` 进行认证加密；开发、测试和生产必须使用各自独立的密钥，且不得提交密钥。

## 微信与短信待联调接口

- `POST /api/v1/customer/auth/wechat-login`：用小程序 `wx.login` 返回的临时 code 换取顾客会话，并按 `appid + openid` 幂等绑定顾客。
- `POST /api/v1/customer/phone-verifications`：发送 6 位验证码；同一账号或手机号 60 秒内不可重发，每小时最多 5 次。
- `POST /api/v1/customer/phone-verifications/:verificationId/confirm`：校验验证码并生成可追溯的手机号绑定；验证码 5 分钟有效，最多尝试 5 次且只能使用一次。
- `POST /api/v1/payments/wechat`：为当前顾客已确认的接待创建微信 JSAPI 支付，必须提供 `Idempotency-Key`；金额只读取服务端报价快照，并发请求只有取得租约的一方会调用微信。
- `GET /api/v1/payments/:paymentId`：查询服务端支付状态；状态到达复核时间时会受控查询微信，小程序不能把 `wx.requestPayment` 的成功回调直接当作到账事实。
- `POST /api/v1/payments/wechat/notify`：微信支付通知地址；使用原始请求体验签、AES-256-GCM 解密并校验 AppID、商户号、金额、币种和 openid，重复通知只完成同一支付。
- `GET /api/v1/admin/payments/review`：按门店分页查看 `unknown/manual_review` 异常支付及最后一次渠道结果，要求异常支付查看权限。
- `POST /api/v1/admin/payments/:paymentId/reconcile`：由运营人员对单笔异常支付重新向微信查单，要求 CSRF 校验和异常支付重查权限；该操作不会创建新支付单或再次扣款。

worker 每 15 秒领取到期的 `created/processing/unknown` 支付任务并按商户订单号查单；连续异常达到上限后转为 `manual_review`，由管理后台“异常支付”工作台继续处理。`prepay_id` 只在 2 小时有效期内复用，签名参数每次请求重新生成。收款截止时间取接待最晚服务结束时间加 `PAYMENT_COLLECTION_GRACE_MINUTES`，该值必须由经营方确认；截止后会关闭微信已存在但仍未支付的订单，关单失败会保留为未知状态继续核实。

开发环境默认把短信验证码输出到 API 日志；测试环境必须注入测试发送器，生产环境未接入真实短信厂商时发送接口返回 `SMS_NOT_CONFIGURED`。若短信供应商响应超时，错误响应仍携带 `verificationId` 与有效期，用户收到短信后可以继续验证。微信配置采用整组校验，缺少任一项会在启动时明确报错。私钥、公钥及 API v3 密钥不得提交仓库。

预约前必须完成时长配置：项目可以明确设置准备、美容师整理、场地清洁和休息分钟数，也可以留空继承门店默认值；美容师最终休息取项目／门店值与美容师最低休息的较大值。未配置的项目值和门店默认值均为空时，对应功能暂不可用，不能静默按 0 处理。

只有整数 `0` 才表示明确不需要对应时长；所有金额接口统一使用“整数分的十进制字符串”。

只有数据库结构发生变化时才运行 `pnpm db:generate` 生成新迁移。正常启动只执行 `pnpm db:migrate`，不要重新生成已有迁移。

### 0005 → 支付迁移发布顺序

`0006_classy_cloak.sql` 已按线上登记哈希保持不变，禁止继续修改。`pnpm db:migrate` 检测到数据库恰好停在可信的 `0005` 时，会先在独立事务提交 `manual_review` 枚举值，再在第二个事务完成字段、约束和历史数据升级，并以原始哈希登记 `0006`；随后由 Drizzle 执行 `0007`。上线前仍应先备份并在数据库副本演练该命令，不要单独执行 `0006`。

历史支付的收款宽限时间无法从旧快照可靠还原，因此升级时不会套用当前配置：旧 `prepay_id` 与过期时间一并清空，所有 `created/processing/unknown` 历史交易进入 `manual_review`。运营重查只能接受微信返回的成功、关闭或退款终态；微信仍未给出终态时继续保留人工复核，不会根据占位截止时间自动关单。新订单继续按“最晚服务结束时间 + `PAYMENT_COLLECTION_GRACE_MINUTES`”计算。

### 0002 迁移边界

`0002_loving_cannonball.sql` 当前只支持尚无预约明细的开发数据库。迁移会在任何结构变更前检查 `reception_guests`；如果已有记录，将明确中止，不删除历史数据，也不会使用当前配置伪造历史规则快照。此时应停止部署，并基于可信历史数据单独准备和评审回填迁移。
