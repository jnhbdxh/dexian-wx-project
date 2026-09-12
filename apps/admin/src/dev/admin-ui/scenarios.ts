export const receptionScenarios = [
  ["normal", "正常查询与跨日多人详情"],
  ["long-content", "长名称、长编号与项目"],
  ["refresh-failure", "刷新失败 · 保留旧数据"],
  ["query-failure", "新条件查询失败"],
  ["initial-failure", "首次加载失败"],
  ["page-failure", "翻页失败 · 页码不变"],
  ["append", "加载更多"],
  ["append-failure", "追加失败 · 已有记录保留"],
  ["detail-failure", "列表成功 · 详情失败"],
  ["denied", "无查看权限"],
  ["read-only", "可查看 · 不可确认"],
  ["identity", "切换身份后清除数据"],
  ["unknown", "确认结果未知 · 原操作核实"],
  ["success-refresh-failure", "确认成功 · 列表刷新失败"],
  ["remove", "处理后移出当前列表"],
] as const;
export const leaveScenarios = [
  ["normal", "明确成功"],
  ["follow-up", "已保存 · 仍有待处理接待"],
  ["failure", "明确失败 · 未保存"],
  ["unknown", "结果未知 · 核实后成功"],
] as const;

export type DemoReception = {
  id: string;
  name: string;
  phone: string;
  state: "待确认" | "已确认" | "已过期";
  serviceDates: string[];
  time: string;
  conflict: boolean;
  guests: Array<{
    name: string;
    project: string;
    therapist: string;
    location: string;
    time: string;
    price: string;
  }>;
};
export const DEMO_MARKER = "DEXIAN_ADMIN_UI_DEMO_ONLY_20260912";
export function receptionFixtures(): DemoReception[] {
  return Array.from({ length: 6 }, (_, index) => ({
    id: `DEMO-20260915-${String(index + 1).padStart(4, "0")}`,
    name: [
      "林女士（示例）",
      "陈先生（示例）",
      "周女士（示例）",
      "吴女士（示例）",
      "许先生（示例）",
      "叶女士（示例）",
    ][index]!,
    phone: index % 2 === 0 ? "138****0628" : "未绑定联系电话",
    state: index === 1 ? "已确认" : index === 2 ? "已过期" : "待确认",
    serviceDates: index === 0 ? ["2026-09-14", "2026-09-15"] : ["2026-09-15"],
    time: index === 0 ? "09/14 23:30 — 09/15 00:30" : "09/15 14:00 — 15:00",
    conflict: index === 1,
    guests: [
      {
        name: "第 1 位",
        project: "舒缓护理",
        therapist: "小满",
        location: "青竹房 · 1 号床",
        time: index === 0 ? "09/14 23:30 — 09/15 00:30" : "09/15 14:00 — 15:00",
        price: "¥95.00",
      },
      ...(index === 0
        ? [
            {
              name: "第 2 位",
              project: "肩颈护理",
              therapist: "清禾",
              location: "青竹房 · 2 号床",
              time: "09/14 23:45 — 09/15 00:25",
              price: "¥65.00",
            },
          ]
        : []),
    ],
  }));
}
