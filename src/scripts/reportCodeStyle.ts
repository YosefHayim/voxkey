import { checkCodeStyle } from "./checkCodeStyle.js";

const violations = checkCodeStyle(process.cwd());
const countsByRule = new Map<string, number>();
for (const violation of violations) {
  process.stdout.write(`${violation.file}:${violation.line}  ${violation.ruleId}  ${violation.message}\n`);
  countsByRule.set(violation.ruleId, (countsByRule.get(violation.ruleId) || 0) + 1);
}

const summary = [...countsByRule]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .map(([ruleId, count]) => `  ${String(count).padStart(4)}  ${ruleId}`)
  .join("\n");
process.stdout.write(
  violations.length === 0
    ? "\nMaintained application, tooling, and placement rules are clean.\n"
    : `\n${violations.length} violation(s)\n${summary}\n`,
);
process.exitCode = violations.length > 0 ? 1 : 0;
