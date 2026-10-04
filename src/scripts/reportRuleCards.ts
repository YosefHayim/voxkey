import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkRuleCards, ruleCardIds } from "./checkRuleCards.js";

const repositoryRoot = resolve(process.argv[2] || process.cwd());
const guidePath = join(repositoryRoot, "CODE-STYLE.md");

if (!existsSync(guidePath)) {
  process.stdout.write(`${repositoryRoot}\n  missing: ${guidePath}\n`);
  process.exitCode = 1;
} else {
  const guide = readFileSync(guidePath, "utf8");
  const violations = checkRuleCards({ guide });

  for (const violation of violations) {
    process.stdout.write(`  CODE-STYLE.md:${violation.line}  ${violation.message}\n`);
  }

  const cardCount = ruleCardIds(guide).length;
  process.stdout.write(
    violations.length === 0
      ? `${repositoryRoot}\n  OK — ${cardCount} rule card(s) conform\n`
      : `${repositoryRoot}\n  ${violations.length} format violation(s) across ${cardCount} rule card(s)\n`,
  );
  process.exitCode = violations.length > 0 ? 1 : 0;
}
