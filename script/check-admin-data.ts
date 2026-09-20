// Destructive fixtures ONLY in the dedicated local test database.
// ADMIN_DATA_TEST_DATABASE_URL='postgresql:///takeride_admin_test?host=/var/run/postgresql' npx tsx script/check-admin-data.ts
import assert from "node:assert/strict";

const dsn = process.env.ADMIN_DATA_TEST_DATABASE_URL;
if (!dsn) throw new Error("Set ADMIN_DATA_TEST_DATABASE_URL to the isolated local test database");
const url = new URL(dsn);
if (url.pathname !== "/takeride_admin_test" ||
  !["", "localhost", "127.0.0.1"].includes(url.hostname) ||
  (url.searchParams.has("host") && url.searchParams.get("host") !== "/var/run/postgresql")) {
  throw new Error("Refusing fixtures outside the dedicated local takeride_admin_test database");
}
process.env.DATABASE_URL = dsn;
process.env.SKIP_DEMO_SEED = "1";
const { pool, bootstrapReady } = await import("../server/db/bootstrap");
const { ridesPage, activeAdminRides, usersPage, staffUsers, feedbackPage, rideStats } = await import("../server/storage/admin-read");
try {
  await bootstrapReady;
  // Conversations intentionally have no FK to users, so CASCADE alone does
  // not clear them. Include them explicitly to make repeat runs deterministic.
  await pool.query("TRUNCATE users, bikes, support_conversations RESTART IDENTITY CASCADE");
  await pool.query(`INSERT INTO users(id,name,phone,created_at)
    SELECT 'fixture-'||g, CASE WHEN g=1 THEN 'Old_% needle' ELSE 'Rider '||g END,
      '+710000'||lpad(g::text,5,'0'),g FROM generate_series(1,5002) g`);
  await pool.query("UPDATE users SET role='mechanic' WHERE id='fixture-1'");
  await pool.query(`INSERT INTO bikes(id,model,status,battery,lat,lng,last_seen,idle_hours)
    VALUES ('TEST-1','City','rented',90,54.95,20.47,1,0)`);
  await pool.query(`INSERT INTO rides(bike_id,user_id,started_at,ended_at,start_lat,start_lng,track,tariff,status)
    SELECT 'TEST-1','fixture-1',g+1000,g+2000,54.95,20.47,'[]','h1','completed'
    FROM generate_series(1,600) g`);
  await pool.query(`INSERT INTO rides(bike_id,user_id,started_at,start_lat,start_lng,track,tariff,status)
    VALUES ('TEST-1','fixture-1',1,54.95,20.47,'[]','h1','active')`);
  await pool.query(`INSERT INTO ride_feedback(ride_id,user_id,rating,reasons,comment,created_at)
    SELECT id,user_id,5,ARRAY['legacy_reason'],'needle',started_at FROM rides WHERE status='completed'`);
  await pool.query(`INSERT INTO support_conversations(user_id,created_at)
    SELECT id,created_at FROM users ORDER BY created_at LIMIT 600`);
  await pool.query(`INSERT INTO support_feedback(conversation_id,user_id,rating,created_at)
    SELECT id,user_id,4,1000+id FROM support_conversations`);

  const active = await activeAdminRides();
  assert.equal(active.length, 1);
  assert.equal(active[0].startedAt, 1);
  const rides = await ridesPage({ status: "completed", offset: "550", limit: "50" });
  assert.equal(rides.total, 600);
  assert.equal(rides.items.length, 50);
  assert.equal(rides.counts?.active, 1);
  assert.equal((await ridesPage({ status: "completed", search: "Old_%" })).total, 600);
  assert.equal((await rideStats(0, 9999)).ridesToday, 601);
  assert.equal((await usersPage({ offset: "5000" })).items.length, 2);
  assert.equal((await usersPage({ search: "Old_%" })).items[0].id, "fixture-1");
  assert.equal((await usersPage({})).total, 5002);
  assert.equal((await staffUsers())[0].id, "fixture-1");

  const seen = new Set<string>();
  for (let offset = 0; offset < 1200; offset += 200) {
    const page = await feedbackPage({ limit: "200", offset: String(offset) });
    assert.equal(page.total, 1200);
    assert.equal(page.items.length, 200);
    for (const item of page.items) {
      const key = `${item.kind}-${item.id}`;
      assert.ok(!seen.has(key), `duplicate ${key}`);
      seen.add(key);
    }
  }
  assert.equal(seen.size, 1200);
  const support = await feedbackPage({ category: "Поддержка", rating: "4", direction: "asc" });
  assert.equal(support.total, 600);
  assert.ok(support.items.every((f) => f.kind === "support"));
  assert.ok(support.items[0].createdAt <= support.items[1].createdAt);
  const searched = await feedbackPage({ search: "needle", rating: "5" });
  assert.equal(searched.total, 600);
  assert.ok(searched.categories?.includes("legacy_reason"));
  assert.equal((await feedbackPage({ category: "does-not-exist" })).total, 0);
  assert.equal((await feedbackPage({ search: "%' OR 1=1 --" })).total, 0);
  // Rider regressions share the same guarded, disposable PostgreSQL fixtures.
  const { riderHistory, riderStats } = await import("../server/storage/rider-read");
  const { SupportMixin } = await import("../server/storage/support");
  const { supportPage, rideHistoryCursor } = await import("../shared/rider-data");
  await pool.query("UPDATE rides SET distance_m=1000 WHERE status='completed'");
  assert.deepEqual(await riderStats("fixture-1"), { rides: 601, distanceM: 600000 });
  assert.deepEqual(await riderStats("fixture-2"), { rides: 0, distanceM: 0 });
  await pool.query("UPDATE rides SET is_test=true WHERE id=1");
  assert.equal((await riderStats("fixture-1")).rides, 600);
  const rideIds = new Set<number>();
  let rideBefore: ReturnType<typeof rideHistoryCursor>;
  do {
    const page = await riderHistory("fixture-1", rideBefore);
    assert.ok(page.items.length <= 40);
    for (const ride of page.items) {
      assert.equal(ride.userId, "fixture-1");
      assert.equal(ride.isTest, false);
      assert.ok(!rideIds.has(ride.id));
      rideIds.add(ride.id);
    }
    rideBefore = rideHistoryCursor(page.nextBefore);
  } while (rideBefore);
  assert.equal(rideIds.size, 600);
  assert.equal((await riderHistory("fixture-2")).items.length, 0);
  assert.equal((await riderHistory("' OR 1=1 --")).items.length, 0);

  const supportStorage = new (SupportMixin(class {}))();
  const conv = await supportStorage.ensureSupportConversation("fixture-1");
  await pool.query(`INSERT INTO support_messages(conversation_id,sender_role,body,created_at)
    SELECT $1,'operator','Message '||g,g FROM generate_series(1,357) g`, [conv.id]);
  const messageIds = new Set<number>();
  let before: number | undefined;
  let previousId = Infinity;
  do {
    const rows = await supportStorage.listSupportMessages(conv.id, { latest: true, beforeId: before, limit: 51 });
    const page = supportPage(rows, 50);
    if (!before) assert.equal(page.messages.at(-1)!.body, "Message 357");
    assert.ok(page.messages.every((m, i) => i === 0 || m.id > page.messages[i - 1].id));
    for (const message of page.messages) {
      assert.equal(message.conversationId, conv.id);
      assert.ok(message.id < previousId);
      assert.ok(!messageIds.has(message.id));
      messageIds.add(message.id);
    }
    previousId = page.messages[0]?.id ?? previousId;
    before = page.nextBefore ?? undefined;
  } while (before);
  assert.equal(messageIds.size, 357);
  const other = await supportStorage.ensureSupportConversation("fixture-2");
  assert.equal((await supportStorage.listSupportMessages(other.id, { latest: true })).length, 0);
  console.log("PASS rider: all 600 non-test rides, full totals, 357 chat messages, cursor uniqueness and owner isolation.");
  console.log("PASS: 5002 users, 601 rides, 1200 merged feedback; complete search, counts, stable pages, old active ride, staff, filters and parameterization.");
} finally {
  await pool.end();
}
