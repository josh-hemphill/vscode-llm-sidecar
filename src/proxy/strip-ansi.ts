/** Removes ANSI escape sequences so piped proxy logs read cleanly in the Output panel. */
const ANSI_ESCAPE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE, "");
