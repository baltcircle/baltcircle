// Проверка формы SQL настоящим диалектом drizzle, без Postgres.
//
// Весь остальной storage тестируется на замоканных db/pool: SQL там никто не
// компилирует и не исполняет, поэтому запрос, который Postgres отвергает
// целиком, в тестах выглядит совершенно здоровым. Так прожили два бага сразу —
// несуществующая колонка bikes.updated_at и ANY(${ids}) — и оба вместе больше
// двух недель держали истечение броней полностью нерабочим.
//
// Здесь компилируется ровно то, что уходит в базу, и проверяются те свойства,
// которые видны на уровне текста запроса.
import { describe, expect, it } from "vitest";
import { sql, inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { reservations } from "@shared/schema";

const dialect = new PgDialect();
const compile = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(q).sql;

describe("форма сырых SQL-запросов sweep", () => {
  it("массив в sql-шаблоне разворачивается в список параметров, а не в массив", () => {
    // Документация к багу, а не к drizzle: именно это поведение и сломало
    // sweep. ANY(($1, $2)) — конструктор строки, Postgres отвечает
    // «op ANY/ALL (array) requires array on right side».
    const compiled = compile(sql`SELECT 1 WHERE id = ANY(${[1, 2]})`);

    expect(compiled).toContain("ANY(($1, $2))");
    expect(compiled).not.toContain("ANY($1)");
  });

  it("inArray даёт валидный IN-список", () => {
    const compiled = compile(inArray(reservations.id, [1, 2]).getSQL());

    expect(compiled).toMatch(/in \(\$1, \$2\)/i);
    expect(compiled).not.toContain("ANY(");
  });

  it("у bikes нет колонки updated_at ни в одном запросе storage", async () => {
    // Единственная возможная защита при замоканной БД: колонки нет ни в схеме,
    // ни в миграциях, и любой UPDATE bikes, который её упоминает, падает
    // целиком вместе со всей своей транзакцией.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), "server", "storage");
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const line of text.split("\n")) {
        if (/UPDATE bikes/i.test(line) && /updated_at/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
