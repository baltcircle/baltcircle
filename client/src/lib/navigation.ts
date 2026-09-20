export function isNavItemActive(location: string, href: string): boolean {
  const path = location.replace(/\/+$/, "") || "/";
  const target = href.replace(/\/+$/, "") || "/";
  // Home pages are exact matches; only actual sections own nested routes.
  return target === "/" || target === "/admin"
    ? path === target
    : path === target || path.startsWith(target + "/");
}
