/**
 * Server builds can use the pretty dynamic route. Static mobile/PWA exports
 * cannot pre-render arbitrary account ids, so they use a query-based static
 * route that resolves the id client-side.
 */
export function accountDetailHref(id: string): string {
  const encoded = encodeURIComponent(id);
  return process.env.NEXT_PUBLIC_SOLO_BUILD === "1"
    ? `/account?id=${encoded}`
    : `/accounts/${encoded}`;
}
