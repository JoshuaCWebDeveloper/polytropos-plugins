export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr: any = err;
  const code = anyErr.code;
  return typeof code === "string" ? code : undefined;
}

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || String(err);
  }
  return String(err ?? "");
}

