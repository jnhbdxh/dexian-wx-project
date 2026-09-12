import { loadConfig } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { WechatPayHttpGateway } from "./integrations/wechat/payment.js";
import { reconcileDuePayments } from "./modules/payment/service.js";

const config = loadConfig();
const database = createDatabase(config);

await database.pool.query("select 1");
const paymentGateway = config.wechatPay
  ? new WechatPayHttpGateway(config.wechatPay)
  : undefined;
let paymentReconciliationRunning = false;

const reconcilePayments = async () => {
  if (!paymentGateway || !config.wechatPay || paymentReconciliationRunning) {
    return;
  }
  paymentReconciliationRunning = true;
  try {
    await reconcileDuePayments(database, paymentGateway, config.wechatPay);
  } catch (error) {
    console.error("Failed to reconcile WeChat Pay orders", error);
  } finally {
    paymentReconciliationRunning = false;
  }
};

await reconcilePayments();
console.log(
  paymentGateway
    ? "Worker is ready; WeChat Pay reconciliation is enabled"
    : "Worker is ready; WeChat Pay reconciliation is disabled",
);

const heartbeat = setInterval(() => void reconcilePayments(), 15_000);

const shutdown = async () => {
  clearInterval(heartbeat);
  await database.pool.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
