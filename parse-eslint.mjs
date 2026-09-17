import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync("eslint-report.json", "utf8"));
const out = [];
for (const f of data) {
  for (const m of f.messages) {
    if (m.ruleId === "@typescript-eslint/no-unused-vars") {
      const file = f.filePath.replace(process.cwd() + "\\", "").replace(/^./, "");
      out.push(`${file}:${m.line} ${m.message}`);
    }
  }
}
console.log("total:", out.length);
out.forEach((s) => console.log(s));
