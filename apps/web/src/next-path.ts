/** Where to go after signing in: a path on this site, never another origin (`//x`, `/\x`, a scheme, or tabs/newlines that browsers strip). */
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\u0000-\u001f\u007f\s]/.test(value)) return "/";
  try {
    return new URL(value, "http://x").origin === "http://x" ? value : "/";
  } catch {
    return "/";
  }
}
