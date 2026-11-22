// Lệnh chạy tay, ví dụ: node src/cli.js process --force
import { processAll } from "./extract.js";
import { classifyPendingImages } from "./images.js";
import { currentGroupId, loginWithSavedCredentials } from "./zalo/client.js";
import { backfillGroup } from "./zalo/backfill.js";

const [cmd, ...args] = process.argv.slice(2);
const force = args.includes("--force");

switch (cmd) {
  case "process": {
    await classifyPendingImages();
    console.log(await processAll(currentGroupId(), { force }));
    break;
  }
  case "backfill": {
    if (!(await loginWithSavedCredentials({ listen: false }))) throw new Error("Chưa đăng nhập Zalo, hãy quét QR trên web trước");
    console.log(await backfillGroup(currentGroupId(), Number(args[0]) || undefined));
    break;
  }
  default:
    console.log("Lệnh: process [--force] | backfill [số ngày]");
}
process.exit(0);
