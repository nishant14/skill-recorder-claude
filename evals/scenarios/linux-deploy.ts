// Scenario: deploy a web app to Azure from Ubuntu, then log the live URL.
// A Linux-shaped devops flow that exercises the describer on raw X11 WM_CLASS
// tokens rather than display names ("firefox_firefox", "Xfce4-terminal", "Code"),
// POSIX paths, a bash shell, and browser.url events shaped like the AT-SPI2
// provider emits them (address-bar strings read from the accessibility tree).
// Marked platform: "linux" so the session meta is stamped as Linux.
//
// The app names are deliberately unfriendly: `electron/collectors/linux-active-window.ts`
// reports the *last* WM_CLASS string verbatim and there is no normalization layer,
// so the describer has to cope with them as-is.

import { appActivate, clipboard, marker, recorder, terminal, visit, type Scenario } from "../scenario";

const FIREFOX = "firefox_firefox";
const TERMINAL = "Xfce4-terminal";
const CODE = "Code";
const REPO = "/home/dana/repos/contoso-crm";
const TERM_TITLE = "Terminal - dana@ubuntu: ~/repos/contoso-crm";
const PORTAL = "https://portal.azure.com/#home";
const PORTAL_TITLE = "Home - Microsoft Azure — Mozilla Firefox";
const LIVE_URL = "https://contoso-crm.azurewebsites.net/";
const LIVE_TITLE = "Contoso CRM — Mozilla Firefox";
const LOG_TITLE = "deployments.md - contoso-crm - Visual Studio Code";

export const linuxDeploy: Scenario = {
  id: "linux-deploy",
  platform: "linux",
  title: "Deploy a web app to Azure and log the live URL (Linux)",
  truth:
    "On Ubuntu, the user opened the Azure Portal in Firefox, then used a terminal (bash) to sign in " +
    "with the Azure CLI and deploy the Contoso CRM web app with `az webapp up`. They copied the " +
    "resulting site URL (https://contoso-crm.azurewebsites.net), opened it in Firefox to verify the " +
    "deployment was live, and pasted the URL into a deployments.md tracking file in VS Code.",
  build: () => [
    recorder(0),
    ...visit(900, FIREFOX, PORTAL, PORTAL_TITLE), // check the resource group in the portal
    appActivate(3000, TERMINAL, TERM_TITLE), // focus the terminal to run the CLI
    terminal(3300, "az login", REPO, { shell: "bash" }),
    terminal(6000, "az webapp up --name contoso-crm --resource-group web-prod --runtime NODE:20-lts", REPO, {
      shell: "bash",
      durationMs: 52000,
    }),
    clipboard(9000, "https://contoso-crm.azurewebsites.net"), // copy the deployed URL
    ...visit(11000, FIREFOX, LIVE_URL, LIVE_TITLE), // open it to verify it is live
    appActivate(14000, CODE, LOG_TITLE), // paste the URL into the deployment log (inferred)
    marker(15500, "contoso-crm deployed and verified live"),
    recorder(17000),
  ],
  rubric: {
    intentKeywordsAny: [
      ["deploy", "deployment", "publish", "ship"],
      ["azure"],
      ["web app", "webapp", "app", "site"],
    ],
    minSteps: 4,
    maxSteps: 9,
    expectedApps: ["firefox", "terminal"],
    orderedActions: [
      ["azure portal", "portal", "azure"],
      ["az webapp", "webapp up", "deploy", "az cli", "azure cli", "az "],
      ["copy", "copied", "clipboard"],
      ["verify", "verified", "live", "azurewebsites", "open"],
      ["vs code", "vscode", "visual studio code", "code", "deployments.md", "log", "tracking"],
    ],
    mustMentionAny: [
      ["azure"],
      ["url", "link", "address", "azurewebsites", "contoso-crm"],
    ],
    forbidden: ["skill recorder"],
  },
};
