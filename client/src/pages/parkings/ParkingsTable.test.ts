import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "client/src/pages/parkings/ParkingsTable.tsx"), "utf8");

describe("parking city headings", () => {
  it("left-aligns city group labels without changing column alignment", () => {
    const groupCell = source.match(/data-testid=\{`parking-city-group-\$\{city\}`\}>\s*<TableCell([^>]*)>/)?.[1];
    expect(groupCell).toBeDefined();
    expect(groupCell).toContain("text-left");
    expect(groupCell).not.toContain("text-center");
    expect(source).toContain('<TableHead className="text-center">Название</TableHead>');
    expect(source).toContain('<TableHead className="text-center">Занято / Вмест.</TableHead>');
  });
  it("uses bold black city labels with readable dark-theme contrast", () => {
    const labelClass = source.match(/<span className="([^"]+)">\s*\{city\}/)?.[1];
    expect(labelClass).toContain("font-bold");
    expect(labelClass).toContain("text-black");
    expect(labelClass).toContain("dark:text-white");
    expect(labelClass).not.toContain("text-muted-foreground");
  });
});
