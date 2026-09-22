/** Filter the live analytics response without another request or dropping idle parking. */
export function filterParkingUsage<T extends { city: string }>(rows: T[], city: string): T[] {
  return city === "all" ? rows : rows.filter((row) => row.city === city);
}
