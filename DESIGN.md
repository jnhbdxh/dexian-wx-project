---
name: 得闲 SPA 运营后台
description: 面向门店现场人员的清晰、克制、可追踪操作界面
colors:
  brand-deep: "#173f2b"
  brand: "#286444"
  brand-interactive: "#347653"
  brand-soft: "#deebe2"
  canvas: "#f2f5f2"
  surface: "#ffffff"
  ink-muted: "#647168"
  line: "#d9e1dc"
  warning: "#a85b13"
  danger: "#b63d35"
typography:
  display:
    fontFamily: "PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "clamp(28px, 4vw, 38px)"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  body:
    fontFamily: "PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.5
rounded:
  field: "9px"
  control: "10px"
  panel: "16px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.surface}"
    rounded: "{rounded.field}"
    height: "44px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.brand-deep}"
    rounded: "{rounded.panel}"
    padding: "{spacing.lg}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.brand-deep}"
    rounded: "{rounded.field}"
    height: "44px"
  status-positive:
    backgroundColor: "{colors.brand-soft}"
    textColor: "{colors.brand}"
    rounded: "{rounded.pill}"
---

# Design System: 得闲 SPA 运营后台

## Overview

**Creative North Star: “安静清楚的门店值班台”**

界面服务于营业现场的操作人员，以低干扰的浅色画布、明确的深绿色主动作和紧凑但不拥挤的信息层级，让状态、影响和下一步在数秒内可见。品牌表达来自稳重的绿色、克制的圆角和细致的反馈文案，不依赖装饰性图形。

**Key Characteristics:**

- 操作名称直接说明业务结果。
- 风险说明紧邻高影响操作，成功、待处理和故障使用不同语义色。
- 主要工作区在桌面并排，在窄屏按操作顺序纵向展开。

## Colors

主色使用沉稳的森林绿；背景与边界保持低对比，橙色只承担时间压力和人工待办，红色只承担失败。

**The Semantic Accent Rule.** 绿色表示可执行或已生效，橙色表示需要关注但业务仍然保留，红色表示失败或无法继续。

## Typography

中文界面使用系统内置的黑体工作字体，避免网络字体影响门店环境下的加载和清晰度。

- **Display:** 页面唯一一级标题使用流体字号、紧行高和轻微负字距。
- **Title:** 面板标题约 21–25px，承担当前对象或任务名称。
- **Body:** 正文以 14px、约 1.6 行高为主。
- **Label:** 字段、状态和辅助标记使用 12–13px，并通过字重而非全大写增强层级。

## Layout

页面内容最大宽度为 1240px。桌面工作台采用主次双栏：登记或队列位于左侧，业务详情位于右侧；820px 以下转为单栏，560px 以下列表改为横向可滑动选择。基础间距以 8px 为起点，常用组合为 12、16、24 和 32px。

**The Action Order Rule.** 窄屏先呈现需要填写或判断的动作，再呈现受影响对象和跟进信息。

## Elevation & Depth

深度来自白色面板、细边界和带垂直偏移的低透明度环境阴影。面板阴影用于区分工作层级，不用于制造悬浮装饰。

## Shapes

字段使用约 9px 圆角，提醒与按钮使用约 10px 圆角，主要面板使用 14–16px 圆角。状态标记使用胶囊形；选中列表项通过背景和单一方向的内嵌强调表现。

## Components

### Buttons

- 主按钮使用深绿色底和白字，宽度服从所在动作区。
- 次要按钮使用白底、细边界和深绿文字。
- 所有移动端关键按钮和输入区域至少 44px 高；焦点显示绿色半透明外圈。

### Cards / Containers

- 主要工作面板使用白色、1px 灰绿边界、16px 圆角和柔和环境阴影。
- 面板内部依靠分隔线和留白组织内容，避免重复嵌套卡片。

### Inputs / Fields

- 输入控件使用近白底、灰绿边框和 9px 圆角。
- 聚焦时变为白底、绿色边框及浅绿色焦点环。
- 禁用状态降低透明度并使用不可用光标，但保留文字可读性。

### Navigation

- 顶部品牌、当前人员和跨工作台动作保持在同一行。
- 结果未知或关键请求执行中时，离开、刷新和重复提交入口应禁用。

### Operational Alerts

- 高影响动作前使用浅橙背景说明实际业务后果。
- 异步错误必须同时说明当前结果是否明确，以及操作人员应重试、刷新还是联系店长。

## Do's and Don'ts

### Do:

- **Do** 以“确认接待”“确认并立即生效”等真实业务结果命名按钮。
- **Do** 在同一视区展示对象、状态、影响数量和下一步。
- **Do** 将服务端事实与可重试凭据保留到明确结果返回。

### Don't:

- **Don't** 把“待人工跟进”写成“已解决”或暗示系统已经完成改期。
- **Don't** 用颜色替代文字状态，也不要把 401、403、并发繁忙和网络故障混为一类。
- **Don't** 为简单操作增加模态框、装饰图标或额外步骤。
