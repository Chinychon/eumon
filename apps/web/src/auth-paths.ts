/** Better Auth endpoints that list a workspace's people; they only check membership, so Clients must be stopped first. */
const ROSTER = /^\/api\/auth\/organization\/(get-full-organization|list-members|list-invitations)\/?$/;

export const isRosterPath = (pathname: string) => ROSTER.test(pathname);
