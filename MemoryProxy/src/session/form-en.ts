/**
 * Canonical English strings for session-init forms (opencode + claude-code).
 *
 * Fork-local i18n (option A, acta 2026-09-10): the two harnesses used by the
 * Aria ecosystem render EN, while CB/codex/workbuddy/dsh keep upstream zh.
 * Shared parsers (codebuddy/extractor.ts extractAssetConfirm, codebuddy/init.ts
 * detectWorkbuddyMorePage) match BOTH zh and EN labels so a translated render
 * never breaks answer recognition.
 */

export const EN_SKIP_LABEL = "Skip (no asset linking, proceed without injection)";
export const EN_MORE_LABEL = "More →";

export const EN_ASSET_CONFIRM_YES = "Yes, link team assets";
export const EN_ASSET_CONFIRM_NO = "No, skip asset linking";
export const EN_ASSET_CONFIRM_FORM_TITLE = "Session Init — Link team assets?";
export const EN_TEAM_FORM_TITLE = "Session Init — Select Team";
export const EN_AGENT_TASK_FORM_TITLE = "Session Init — Select Agent & Task";
export const EN_RETRY_FORM_TITLE = "Could not recognize selection, please choose again";

export const EN_SKIP_HINT =
  "(Pick the closest option; custom input is not supported yet. If you skip, no team assets will be injected into this session)";
