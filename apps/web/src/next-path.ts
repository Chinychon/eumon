/** Where to go after signing in: a path on this site, never another origin (`//x`, `/\x`, or a scheme). */
export function safeNext(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}
