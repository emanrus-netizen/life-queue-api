
import "dotenv/config";

import assert from "node:assert/strict";
import request from "supertest";

import { app } from "../app";
import { prisma } from "../db/prisma";

/**
 * Development database only.
 *
 * Creates temporary accounts and removes
 * them after the tests finish.
 */
async function run() {
  console.log("🧪 Testing Daily Rhythm API...");

  const runId = `${Date.now()}-${Math.random()}`;
  const password = "QueueTest123!";
  const createdUserIds: string[] = [];

  const schedule = {
    wakeTime: "07:00",
    workStartTime: "09:00",
    workEndTime: "17:00",
    sleepTime: "23:00",
    timeZone: "Asia/Manila",
  };

  try {
    // Anonymous users cannot read schedules.
    const anonymous = await request(app)
      .get("/user-schedule");

    assert.equal(anonymous.status, 401);
    console.log("✅ Anonymous access blocked.");

    const registerA = await request(app)
      .post("/auth/register")
      .send({
        email: `schedule-a-${runId}@example.com`,
        password,
        displayName: "Schedule Test A",
      });

    const registerB = await request(app)
      .post("/auth/register")
      .send({
        email: `schedule-b-${runId}@example.com`,
        password,
        displayName: "Schedule Test B",
      });

    assert.equal(registerA.status, 201);
    assert.equal(registerB.status, 201);

    const tokenA: string = registerA.body.session.token;
    const tokenB: string = registerB.body.session.token;

    createdUserIds.push(
      registerA.body.user.id,
      registerB.body.user.id,
    );

    console.log("✅ Two test accounts registered.");

    // An account with no schedule gets null.
    const empty = await request(app)
      .get("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`);

    assert.equal(empty.status, 200);
    assert.equal(empty.body.schedule, null);

    console.log("✅ New account has no schedule.");

    const firstOperation = {
      operationId: `schedule-create-${runId}`,
      expectedVersion: 0,
      schedule,
    };

    // Reject invalid time.
    const invalid = await request(app)
      .put("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        ...firstOperation,
        schedule: {
          ...schedule,
          wakeTime: "29:90",
        },
      });

    assert.equal(invalid.status, 400);
    console.log("✅ Invalid time rejected.");

    // First save.
    const first = await request(app)
      .put("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(firstOperation);

    assert.equal(
      first.status,
      200,
      JSON.stringify(first.body),
    );

    assert.equal(first.body.schedule.wakeTime, "07:00");
    assert.equal(first.body.schedule.version, 1);

    console.log("✅ Schedule created.");

    // Identical retry must not apply twice.
    const retry = await request(app)
      .put("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(firstOperation);

    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, first.body);

    console.log("✅ Duplicate operation is idempotent.");

    // Same ID with changed data must fail.
    const tampered = await request(app)
      .put("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        ...firstOperation,
        schedule: {
          ...schedule,
          wakeTime: "08:00",
        },
      });

    assert.equal(tampered.status, 409);
    assert.equal(
      tampered.body.error.code,
      "OPERATION_ID_REUSED",
    );

    console.log("✅ Operation ID reuse rejected.");

    // A different operation with an old version
    // cannot overwrite the saved schedule.
    const stale = await request(app)
      .put("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        operationId: `schedule-stale-${runId}`,
        expectedVersion: 0,
        schedule: {
          ...schedule,
          wakeTime: "05:00",
        },
      });

    assert.equal(stale.status, 409);
    assert.equal(
      stale.body.error.code,
      "SCHEDULE_VERSION_CONFLICT",
    );

    console.log("✅ Stale schedule update rejected.");

    // Correct next update.
    const updated = await request(app)
      .put("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({
        operationId: `schedule-update-${runId}`,
        expectedVersion: 1,
        schedule: {
          ...schedule,
          wakeTime: "06:30",
        },
      });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.schedule.version, 2);
    assert.equal(updated.body.schedule.wakeTime, "06:30");

    console.log("✅ Valid update increments version.");

    // Replaying the original write after another
    // update still returns its ORIGINAL receipt.
    const oldRetry = await request(app)
      .put("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`)
      .send(firstOperation);

    assert.equal(oldRetry.status, 200);
    assert.deepEqual(oldRetry.body, first.body);

    console.log("✅ Old acknowledged write replays safely.");

    // Account B cannot see A's schedule.
    const accountB = await request(app)
      .get("/user-schedule")
      .set("Authorization", `Bearer ${tokenB}`);

    assert.equal(accountB.status, 200);
    assert.equal(accountB.body.schedule, null);

    console.log("✅ Account B cannot read A's schedule.");

    const loaded = await request(app)
      .get("/user-schedule")
      .set("Authorization", `Bearer ${tokenA}`);

    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.schedule.version, 2);
    assert.equal(loaded.body.schedule.wakeTime, "06:30");

    console.log("✅ Updated schedule restored.");

    const receiptCount =
      await prisma.userScheduleSyncReceipt.count({
        where: {
          userId: createdUserIds[0],
        },
      });

    assert.equal(receiptCount, 2);

    console.log("✅ Only successful operations have receipts.");
    console.log("🎉 All Daily Rhythm API tests passed!");
  } finally {
    // These are disposable test accounts.
    await prisma.user.deleteMany({
      where: {
        id: {
          in: createdUserIds,
        },
      },
    });

    await prisma.$disconnect();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
