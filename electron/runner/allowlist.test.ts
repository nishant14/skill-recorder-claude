import assert from "node:assert/strict";
import test from "node:test";

import {
  allowsApiOperation,
  allowsCapability,
  capabilityRefusal,
  compileAllowlist,
  matchesShell,
  shellRefusal,
} from "./allowlist";

/**
 * The enforcement half of the runner, in isolation: no filesystem, no model, no
 * process. What is being defended is the promise the build flow makes to the user —
 * the `allowed-tools` they approved are the only capabilities the run gets — plus the
 * one deliberate escape hatch: a skill that declares nothing is *unrestricted* rather
 * than useless.
 */

test("Bash patterns gate the shell, OR across patterns, with * spanning spaces", () => {
  const list = compileAllowlist(["Bash(gh *)", "Bash(git status)"]);
  assert.deepEqual(list.shellPatterns, ["gh *", "git status"]);
  assert.equal(list.unrestricted, false);

  assert.equal(matchesShell(list, "gh pr list --limit 5"), true, "* spans spaces");
  assert.equal(matchesShell(list, "git status"), true, "a second pattern is an alternative");
  assert.equal(matchesShell(list, "  gh   pr    list  "), true, "whitespace is collapsed first");

  assert.equal(matchesShell(list, "gh"), false, '"gh *" requires the trailing space');
  assert.equal(matchesShell(list, "ghost --pretend"), false, "no prefix-only matching");
  assert.equal(matchesShell(list, "git push"), false);
  assert.equal(matchesShell(list, "echo hi; gh pr list"), false, "the whole line must match");
});

test("glob metacharacters are literal except * and ?", () => {
  const list = compileAllowlist(["Bash(grep -n 'a.b' *)", "Bash(ls ?)"]);
  assert.equal(matchesShell(list, "grep -n 'a.b' notes.txt"), true);
  assert.equal(matchesShell(list, "grep -n 'axb' notes.txt"), false, "a dot is a dot, not any char");
  assert.equal(matchesShell(list, "ls x"), true);
  assert.equal(matchesShell(list, "ls xy"), false, "? is exactly one character");
});

test("a skill with no allowed-tools is unrestricted: nothing is refused", () => {
  const list = compileAllowlist([]);
  assert.equal(list.unrestricted, true);
  assert.deepEqual(list.shellPatterns, []);
  assert.equal(list.apiOps, null);
  assert.equal(list.allowRead, true);
  assert.equal(list.allowWrite, true);
  assert.equal(list.allowFetch, true);

  assert.equal(matchesShell(list, "anything at all"), true);
  assert.equal(allowsCapability(list, "read_file"), true);
  assert.equal(allowsCapability(list, "write_file"), true);
  assert.equal(allowsCapability(list, "fetch_url"), true);
  assert.equal(allowsApiOperation(list, "createSalesOrder"), true);

  // Blank / whitespace entries are the same as none at all.
  assert.equal(compileAllowlist(["", "   "]).unrestricted, true);
  assert.equal(compileAllowlist(undefined).unrestricted, true);
});

test("a skill that declares anything is held to it — including for shell", () => {
  const list = compileAllowlist(["Read", "api:listCustomers"]);
  assert.equal(list.unrestricted, false);
  assert.equal(list.allowRead, true);
  assert.equal(list.allowWrite, false);
  assert.equal(list.allowFetch, false);
  // No Bash entry at all: a restricted skill may not run commands it never declared.
  assert.equal(matchesShell(list, "ls"), false);
  assert.match(shellRefusal(list), /do not include shell commands/);
  assert.match(shellRefusal(list), /Read, api:listCustomers/);
});

test("the shell refusal names the patterns the model may actually use", () => {
  const list = compileAllowlist(["Bash(gh *)", "Bash(git status)"]);
  const refusal = shellRefusal(list);
  assert.match(refusal, /Bash\(gh \*\), Bash\(git status\)/);
  assert.match(refusal, /not covered by this skill's allowed-tools/);
});

test("capability entries map to the file and web tools, in the spellings that occur", () => {
  const list = compileAllowlist(["Read", "Write", "web_fetch"]);
  assert.equal(list.allowRead, true);
  assert.equal(list.allowWrite, true);
  assert.equal(list.allowFetch, true);

  const alternates = compileAllowlist(["read_file", "WriteFile", "WebFetch"]);
  assert.equal(alternates.allowRead, true);
  assert.equal(alternates.allowWrite, true);
  assert.equal(alternates.allowFetch, true);

  const readOnly = compileAllowlist(["Read"]);
  assert.equal(allowsCapability(readOnly, "read_file"), true);
  assert.equal(allowsCapability(readOnly, "write_file"), false);
  assert.match(capabilityRefusal(readOnly, "write_file"), /do not include write_file/);
  assert.match(capabilityRefusal(readOnly, "write_file"), /they list: Read/);
});

test("api: entries compile to an operation set that restricts call_api", () => {
  const list = compileAllowlist(["api:listCustomers", "api:createSalesOrder", "Bash(gh *)"]);
  assert.deepEqual([...(list.apiOps ?? [])], ["listCustomers", "createSalesOrder"]);
  assert.equal(allowsApiOperation(list, "listCustomers"), true);
  assert.equal(allowsApiOperation(list, "deleteEverything"), false);

  // A skill that names no api: op does not restrict the op set (the tool is only
  // registered when the skill carries a reference at all).
  assert.equal(compileAllowlist(["Read"]).apiOps, null);
  assert.equal(allowsApiOperation(compileAllowlist(["Read"]), "anything"), true);
});

test("unknown entries grant nothing but still turn enforcement on", () => {
  const list = compileAllowlist(["SharePointConnector", "Bash()"]);
  assert.equal(list.unrestricted, false, "the skill declared something, even if we can't map it");
  assert.deepEqual(list.shellPatterns, [], "an empty Bash() is a typo, not a blanket grant");
  assert.equal(matchesShell(list, "ls"), false);
  assert.equal(allowsCapability(list, "read_file"), false);

  // Bare `Bash` with no parentheses *is* a blanket shell grant.
  assert.deepEqual(compileAllowlist(["Bash"]).shellPatterns, ["*"]);
  assert.equal(matchesShell(compileAllowlist(["Bash"]), "rm -rf ./build"), true);
});
