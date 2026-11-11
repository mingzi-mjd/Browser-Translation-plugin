const core = require("../core.js");
(async () => {
  for (const engine of ["google", "microsoft"]) {
    const result = await core.translate(engine, "Hello world", "zh-CN");
    if (!/[\u3400-\u9fff]/u.test(result)) throw new Error(engine + ": unexpected response");
    console.log(engine + ": " + result);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
