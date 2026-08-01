import type { Scenario } from "../scenario";
import { directoryLookup } from "./directory-lookup";
import { expenseReport } from "./expense-report";
import { invoiceExtract } from "./invoice-extract";
import { irrelevantDetour } from "./irrelevant-detour";
import { leadToCrm } from "./lead-to-crm";
import { linuxDeploy } from "./linux-deploy";
import { releaseNotes } from "./release-notes";
import { researchCompile } from "./research-compile";
import { webToSpreadsheet } from "./web-to-spreadsheet";
import { windowsDeploy } from "./windows-deploy";

/** All eval scenarios, in run order. */
export const scenarios: Scenario[] = [
  webToSpreadsheet,
  invoiceExtract,
  researchCompile,
  directoryLookup,
  // Intent-driven relevance: a confident intent must exclude an off-task detour.
  irrelevantDetour,
  // Complex, multi-app business processes:
  expenseReport,
  releaseNotes,
  leadToCrm,
  // Windows-shaped capture (win32 app names + browser.url + pwsh):
  windowsDeploy,
  // Linux-shaped capture (raw X11 WM_CLASS tokens + AT-SPI browser.url + bash):
  linuxDeploy,
];
