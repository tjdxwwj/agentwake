const APPROVAL_PATTERNS = [
  /waiting for user (approval|confirmation|allow)/i,
  /awaiting user (approval|confirmation)/i,
  /requires user (approval|confirmation)/i,
  /permission required/i,
  /waiting for (your )?approval/i,
  /pending (user )?approval/i,
  /user (action|input|response) required/i,
  /approve or reject/i,
  /waiting for (user )?(to )?(confirm|approve|allow|accept)/i,
  /tool (call |execution )?(requires|needs) (user )?(approval|confirmation)/i,
  /paused.{0,20}(approval|confirmation|user)/i,
  /blocked.{0,20}waiting.{0,20}user/i,
  /ask_user_question/i,
  /等待用户允许/,
  /等待用户确认/,
  /需要用户授权/,
  /等待.*审批/,
  /等待.*批准/,
  /需要.*确认/,
];

export function isApprovalWaitingText(input: string): boolean {
  const value = input.trim();
  if (!value) {
    return false;
  }
  return APPROVAL_PATTERNS.some((pattern) => pattern.test(value));
}
