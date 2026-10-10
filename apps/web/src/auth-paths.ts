/** Better Auth endpoints that list a workspace's people; they only check membership, so Clients must be stopped first. */
const ROSTER = /^\/api\/auth\/organization\/(get-full-organization|list-members|list-invitations)\/?$/;

export const isRosterPath = (pathname: string) => ROSTER.test(pathname);

/**
 * Every workspace a roster request could be answered for. Better Auth picks `organizationId || active`
 * (and `organizationSlug` on some endpoints), so the guard checks all of them: a Client in any one is refused.
 */
export function requestedWorkspaces(params: URLSearchParams, activeId: string | null | undefined): { ids: string[]; slug: string | null } {
  const ids = [params.get("organizationId"), activeId].filter((id): id is string => Boolean(id));
  return { ids: [...new Set(ids)], slug: params.get("organizationSlug") || null };
}
