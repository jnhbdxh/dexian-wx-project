# 得闲小程序与管理系统

阶段 0 的工程、环境、身份认证和今日工作台角色授权已经完成。核心业务设计评审已经关闭，当前预约纵向切片已实现资源、班次、不可用限制、可约查询、待确认预占、后台确认接口和运营确认页面；真实请假后端事务及运营登记、结果核实、冲突查看与定位页面也已实现。自动分配、改期、取消、请假撤销、实际服务、资金、礼品卡及退款仍待后续切片实现。

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

- `POST /api/v1/availability/queries`：按明确选择的美容师、房间、床位和开始时间查询可约候选。
- `POST /api/v1/receptions`：凭候选令牌创建 10 分钟待确认预占，必须同时提供 `Idempotency-Key` 请求头。

后台确认接口：

- `POST /api/v1/admin/receptions/:receptionId/confirm`：将未过期的整组预占确认，要求员工会话、`receptions.confirm` 权限、CSRF 请求头、`Idempotency-Key` 及 `If-Match: "<version>"`。确认成功后原 `held` 占用原位变为 `confirmed`；锁等待期间过期则整组失效并返回 `RECEPTION_EXPIRED`。

管理后台 `/dashboard` 提供待确认列表、服务与资源明细、服务端时间校准的倒计时和确认操作。401 会返回登录页；403、已过期、版本变化、资源繁忙及网络／服务异常分别给出对应处理指引。网络结果未知或资源繁忙时，页面重试会复用同一个幂等键。

请假登记后端接口：

- `POST /api/v1/admin/leaves`：登记美容师已经确定的真实请假，要求员工会话、`scheduling.leave.write` 权限、CSRF 请求头及 `Idempotency-Key`。请假保存后立即生效；相交的未过期待确认接待整组转为 `invalidated` 并释放全部占用，已确认接待及原占用保持不变并生成去重的冲突记录。自然过期的接待按 `expired` 处理，不计入请假失效数量。

该接口已经覆盖请假与确认并发、幂等等待跨过截止时间、多人组跨日期扩锁及锁超时回滚。`GET /api/v1/admin/scheduling/leave-workbench` 返回当前门店可选美容师及尚待人工跟进的已确认接待冲突。

管理后台 `/scheduling` 提供真实请假登记、未知结果同键核实、冲突查看和接待定位。未核实请求会在当前浏览器标签页中保留，刷新或重新登录后继续使用原幂等键；普通路由离开会被阻止。冲突列表按稳定游标继续加载并显示数据库准确总数，跨日区间会完整显示起止日期。页面不会自动换人，也不提供解决、撤销、改期或取消动作，请勿据此认为冲突处理业务已经完整闭环。

候选令牌由 `BOOKING_TOKEN_SECRET` 签名；开发、测试和生产必须使用各自独立的密钥，且不得提交密钥。

预约前必须完成时长配置：项目可以明确设置准备、美容师整理、场地清洁和休息分钟数，也可以留空继承门店默认值；美容师最终休息取项目／门店值与美容师最低休息的较大值。未配置的项目值和门店默认值均为空时，对应功能暂不可用，不能静默按 0 处理。

只有整数 `0` 才表示明确不需要对应时长；所有金额接口统一使用“整数分的十进制字符串”。

只有数据库结构发生变化时才运行 `pnpm db:generate` 生成新迁移。正常启动只执行 `pnpm db:migrate`，不要重新生成已有迁移。

### 0002 迁移边界

`0002_loving_cannonball.sql` 当前只支持尚无预约明细的开发数据库。迁移会在任何结构变更前检查 `reception_guests`；如果已有记录，将明确中止，不删除历史数据，也不会使用当前配置伪造历史规则快照。此时应停止部署，并基于可信历史数据单独准备和评审回填迁移。
