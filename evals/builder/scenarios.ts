// Builder eval scenarios.
//
// Each ships a FIXED approved analysis describing a GitHub task the user did
// THROUGH THE BROWSER (clicking around github.com). A correct builder generalizes
// that to the `gh` CLI (the native GitHub interface) rather than replaying the UI
// with browser automation / Playwright. These reproduce the bug where the builder
// preferred the browser for GitHub work, and guard against it regressing.

import type { BuilderScenario } from "./scenario";
import { nativeToolScenarios } from "./native-tool-scenarios";

/** Triage bug issues — recorded in the browser, should generalize to `gh issue`. */
const githubIssueTriage: BuilderScenario = {
  id: "github-issue-triage",
  title: "Triage new bug issues on GitHub",
  architecture: "app",
  platform: "darwin",
  truth:
    "In Chrome the user opened the acme/api repo's open issues filtered to label:bug with no " +
    "assignee, read a new report, posted a comment asking the reporter for exact reproduction " +
    "steps and their version, and applied the 'needs-info' label — a triage pass they repeat " +
    "for every new unassigned bug. The right generalization drives GitHub with the gh CLI " +
    "(gh issue list / gh issue comment / gh issue edit --add-label), not the browser UI.",
  analysis: {
    title: "Triage new bug issues",
    intent:
      "Triage newly reported, unassigned bug issues in the acme/api GitHub repository: for each " +
      "open issue labeled 'bug' with no assignee, post a comment asking the reporter for exact " +
      "reproduction steps and their version, then add the 'needs-info' label.",
    intentConfidence: "high",
    intentRationale:
      "The browser stayed on github.com/acme/api issue pages throughout; the same comment text " +
      "and the same 'needs-info' label were applied to a bug issue.",
    steps: [
      {
        id: "s1",
        title: "Open the repo's open bug issues on GitHub",
        detail:
          "Navigated in Chrome to the acme/api issues list filtered to open bug issues with no " +
          "assignee to find reports that still need triage.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://github.com/acme/api/issues?q=is%3Aissue+is%3Aopen+label%3Abug+no%3Aassignee",
          "title 'Issues · acme/api'",
        ],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Open a new bug report to read it",
        detail: "Opened issue #214 in Chrome to read the reported bug before triaging it.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://github.com/acme/api/issues/214"],
        confidence: "high",
      },
      {
        id: "s3",
        title: "Comment asking for reproduction steps",
        detail:
          "Typed a comment into the issue's comment box and submitted it, asking the reporter " +
          "for exact reproduction steps and the version they are on.",
        apps: ["Google Chrome"],
        evidence: [
          "clipboard 'Thanks for the report! Could you share exact reproduction steps and the version you're on?'",
          "browser.url https://github.com/acme/api/issues/214",
        ],
        confidence: "high",
      },
      {
        id: "s4",
        title: "Apply the needs-info label",
        detail:
          "Opened the Labels sidebar on the issue and applied the 'needs-info' label to mark it " +
          "as waiting on the reporter.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://github.com/acme/api/issues/214", "label 'needs-info'"],
        confidence: "medium",
      },
    ],
  },
  rubric: {
    mustUseAny: [["gh ", "github cli"], ["gh issue", "gh api", "github cli"]],
    forbidden: ["playwright", "browser_", "click", "navigate to github", "github.com/acme"],
  },
};

/** Nudge stale PRs — recorded in the browser, should generalize to `gh pr`. */
const githubStalePrNudge: BuilderScenario = {
  id: "github-stale-pr-nudge",
  title: "Nudge pull requests awaiting review on GitHub",
  architecture: "app",
  platform: "win32",
  truth:
    "In Chrome the user opened the acme/api open pull requests that still need review, checked " +
    "how long each had been waiting, and posted a gentle nudge comment on the ones sitting for " +
    "more than a couple of days. The right generalization uses the gh CLI (gh pr list / gh pr " +
    "comment), not browser automation.",
  analysis: {
    title: "Nudge stale PRs",
    intent:
      "Find open pull requests in the acme/api GitHub repository that have been awaiting review " +
      "for more than two days and post a gentle reminder comment on each one.",
    intentConfidence: "high",
    intentRationale:
      "The browser stayed on github.com/acme/api pull-request pages; a reminder comment was " +
      "posted on a PR that had been open and unreviewed for several days.",
    steps: [
      {
        id: "s1",
        title: "Open pull requests that need review",
        detail:
          "Navigated in Chrome to the acme/api pull requests filtered to open PRs still awaiting " +
          "review, sorted oldest first to find the ones that have been waiting longest.",
        apps: ["Google Chrome"],
        evidence: [
          "browser.url https://github.com/acme/api/pulls?q=is%3Apr+is%3Aopen+review%3Arequired+sort%3Acreated-asc",
        ],
        confidence: "high",
      },
      {
        id: "s2",
        title: "Check how long a PR has been waiting",
        detail:
          "Opened PR #estimated in Chrome and checked the opened date to confirm it had been " +
          "waiting for review for more than two days.",
        apps: ["Google Chrome"],
        evidence: ["browser.url https://github.com/acme/api/pull/338"],
        confidence: "medium",
      },
      {
        id: "s3",
        title: "Post a reminder comment tagging the reviewer",
        detail:
          "Typed a friendly reminder into the PR comment box tagging the requested reviewer and " +
          "submitted it, asking them to take a look.",
        apps: ["Google Chrome"],
        evidence: [
          "clipboard 'Friendly ping — this PR has been waiting on review for a couple of days, could you take a look?'",
          "browser.url https://github.com/acme/api/pull/338",
        ],
        confidence: "high",
      },
    ],
  },
  rubric: {
    mustUseAny: [["gh ", "github cli"], ["gh pr", "gh api", "github cli"]],
    forbidden: ["playwright", "browser_", "click", "navigate to github", "github.com/acme"],
  },
};

export const builderScenarios: BuilderScenario[] = [
  githubIssueTriage,
  githubStalePrNudge,
  ...nativeToolScenarios,
];
