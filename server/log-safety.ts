// Keep untrusted message text on one logical log line, including in pretty readers.
export function sanitizeLogMessage(message: string): string {
  return message
    .replace(/[\r\n]/g, "")
    // eslint-disable-next-line no-control-regex -- deliberately strip terminal and line controls
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, "");
}
