import assert from "node:assert/strict";

import request from "supertest";

import {
    app,
} from "../app";

import {
    prisma,
} from "../db/prisma";


/**
 * These tests intentionally exercise the HTTP API,
 * not only the service functions.
 *
 * That means we verify the entire security path:
 *
 * Authorization header
 *        ↓
 * requireAuth
 *        ↓
 * authenticated userId
 *        ↓
 * /queue-sync
 *        ↓
 * transaction
 *        ↓
 * QueueItem mutation + receipt
 */
async function registerTestUser(
  label: string,
) {
  const unique =
    `${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  const email =
    `queue-sync-${label}-${unique}@example.com`;

  const response =
    await request(app)
      .post(
        "/auth/register",
      )
      .send({
        email,

        password:
          "QueueSyncTest123!",

        displayName:
          `Queue Sync ${label}`,
      });


  assert.equal(
    response.status,
    201,
    `Expected registration to return 201. Body: ${JSON.stringify(
      response.body,
    )}`,
  );


  assert.ok(
    response.body.user?.id,
    "Registration must return user.id.",
  );


  assert.ok(
    response.body.session?.token,
    "Registration must return session.token.",
  );


  return {
    email,

    userId:
      response.body.user.id as string,

    token:
      response.body.session.token as string,
  };
}


/**
 * Helper for authenticated requests.
 */
function auth(
  token: string,
) {
  return {
    Authorization:
      `Bearer ${token}`,
  };
}


/**
 * Create a normal ACTIVE QueueItem.
 *
 * We deliberately use POST /queue-items here.
 *
 * The sync test should not depend on CREATE sync
 * before testing lifecycle idempotency.
 */
async function createQueueItem(
  token: string,
  id: string,
  title: string,
  estimatedMinutes = 10,
) {
  const response =
    await request(app)
      .post(
        "/queue-items",
      )
      .set(
        auth(
          token,
        ),
      )
      .send({
        id,

        title,

        description:
          "Queue sync self-test item",

        priority:
          "NORMAL",

        estimatedMinutes,

        context:
          "ANYWHERE",

        createdAt:
          new Date()
            .toISOString(),
      });


  assert.equal(
    response.status,
    201,
    `Expected QueueItem creation to succeed. Body: ${JSON.stringify(
      response.body,
    )}`,
  );


  return response.body.item;
}


/**
 * Start through the existing normal lifecycle API.
 *
 * This gives EXTEND a valid IN_PROGRESS task.
 */
async function startQueueItem(
  token: string,
  id: string,
) {
  const response =
    await request(app)
      .post(
        `/queue-items/${id}/start`,
      )
      .set(
        auth(
          token,
        ),
      );


  assert.equal(
    response.status,
    200,
    `Expected QueueItem start to succeed. Body: ${JSON.stringify(
      response.body,
    )}`,
  );


  return response.body.item;
}


function minutesBetween(
  later:
    string | Date,

  earlier:
    string | Date,
) {
  return (
    new Date(
      later,
    ).getTime() -

    new Date(
      earlier,
    ).getTime()
  ) / 60_000;
}


async function run() {
  console.log(
    "\n🧪 Running Queue sync tests...\n",
  );


  const accountA =
    await registerTestUser(
      "A",
    );

  const accountB =
    await registerTestUser(
      "B",
    );


  try {
    /**
     * ========================================================
     * SETUP
     * ========================================================
     */

    const extendItemId =
      `queue_sync_extend_${Date.now()}`;

    await createQueueItem(
      accountA.token,
      extendItemId,
      "Sync extend test",
      10,
    );


    const startedExtendItem =
      await startQueueItem(
        accountA.token,
        extendItemId,
      );


    assert.ok(
      startedExtendItem.timerEndsAt,
      "Started timer test item must have timerEndsAt.",
    );


    /**
     * Keep this timestamp stable.
     *
     * Every retry of the SAME operation must contain
     * exactly the same occurredAt.
     */
    const extendOccurredAt =
      new Date()
        .toISOString();


    const extendOperation = {
      operationId:
        `qsync_extend_${Date.now()}`,

      entityId:
        extendItemId,

      type:
        "EXTEND",

      occurredAt:
        extendOccurredAt,

      payload: {
        additionalMinutes:
          15,
      },
    } as const;


    /**
     * ========================================================
     * 1. AUTHENTICATED OWNERSHIP
     * ========================================================
     *
     * Account B attempts to mutate Account A's task.
     *
     * Expected:
     *
     * same behavior as nonexistent resource:
     * 404 QUEUE_ITEM_NOT_FOUND
     *
     * We must not reveal:
     *
     * "This exists, but somebody else owns it."
     */

    const crossAccountResponse =
      await request(app)
        .post(
          "/queue-sync",
        )
        .set(
          auth(
            accountB.token,
          ),
        )
        .send({
          operationId:
            `qsync_cross_account_${Date.now()}`,

          entityId:
            extendItemId,

          type:
            "EXTEND",

          occurredAt:
            new Date()
              .toISOString(),

          payload: {
            additionalMinutes:
              15,
          },
        });


    assert.equal(
      crossAccountResponse.status,
      404,
    );

    assert.equal(
      crossAccountResponse.body
        .error?.code,
      "QUEUE_ITEM_NOT_FOUND",
    );


    const itemAfterAttack =
      await prisma.queueItem
        .findFirst({
          where: {
            id:
              extendItemId,

            userId:
              accountA.userId,
          },
        });


    assert.ok(
      itemAfterAttack,
    );


    assert.equal(
      itemAfterAttack.status,
      "IN_PROGRESS",
    );


    console.log(
      "✅ authenticated ownership",
    );


    /**
     * ========================================================
     * 2. FIRST SUCCESSFUL SYNC
     * ========================================================
     */

    const firstResponse =
      await request(app)
        .post(
          "/queue-sync",
        )
        .set(
          auth(
            accountA.token,
          ),
        )
        .send(
          extendOperation,
        );


    assert.equal(
      firstResponse.status,
      200,
      JSON.stringify(
        firstResponse.body,
      ),
    );


    assert.equal(
      firstResponse.body
        .alreadyApplied,
      false,
    );


    const firstTimerEndsAt =
      firstResponse.body
        .item?.timerEndsAt;


    assert.ok(
      firstTimerEndsAt,
      "First EXTEND must return timerEndsAt.",
    );


    /**
     * The deadline should have gained approximately
     * 15 minutes.
     *
     * Because EXTEND uses either:
     *
     * old timerEndsAt
     *
     * or
     *
     * occurredAt when the timer already expired,
     *
     * we mainly care that one extension happened.
     */
    const firstExtensionMinutes =
      minutesBetween(
        firstTimerEndsAt,

        startedExtendItem
          .timerEndsAt,
      );


    assert.ok(
      firstExtensionMinutes >=
        14.9,
      `Expected roughly +15 minutes. Received ${firstExtensionMinutes}.`,
    );


    /**
     * ========================================================
     * 3. DURABLE RECEIPT
     * ========================================================
     */

    const receipt =
      await prisma.queueSyncReceipt
        .findUnique({
          where: {
            userId_operationId: {
              userId:
                accountA.userId,

              operationId:
                extendOperation
                  .operationId,
            },
          },
        });


    assert.ok(
      receipt,
      "Successful sync must persist a receipt.",
    );


    assert.equal(
      receipt.entityId,
      extendItemId,
    );

    assert.equal(
      receipt.kind,
      "EXTEND",
    );


    assert.equal(
      receipt.occurredAt
        .toISOString(),
      extendOccurredAt,
    );


    console.log(
      "✅ durable receipt",
    );


    /**
     * ========================================================
     * 4. SAFE RETRY
     * ========================================================
     *
     * Send the EXACT same logical operation again.
     */

    const retryResponse =
      await request(app)
        .post(
          "/queue-sync",
        )
        .set(
          auth(
            accountA.token,
          ),
        )
        .send(
          extendOperation,
        );


    assert.equal(
      retryResponse.status,
      200,
    );


    assert.equal(
      retryResponse.body
        .alreadyApplied,
      true,
    );


    console.log(
      "✅ safe retry",
    );


    /**
     * ========================================================
     * 5. SAME OPERATION CANNOT EXECUTE TWICE
     * ========================================================
     */

    const itemAfterRetry =
      await prisma.queueItem
        .findFirst({
          where: {
            id:
              extendItemId,

            userId:
              accountA.userId,
          },
        });


    assert.ok(
      itemAfterRetry
        ?.timerEndsAt,
    );


    assert.equal(
      itemAfterRetry.timerEndsAt
        .toISOString(),

      new Date(
        firstTimerEndsAt,
      ).toISOString(),

      "Retry must not extend the timer a second time.",
    );


    const receiptCount =
      await prisma.queueSyncReceipt
        .count({
          where: {
            userId:
              accountA.userId,

            operationId:
              extendOperation
                .operationId,
          },
        });


    assert.equal(
      receiptCount,
      1,
      "One logical operation must produce exactly one receipt.",
    );


    console.log(
      "✅ same operation cannot execute twice",
    );


    /**
     * ========================================================
     * 6. SAME ID CANNOT REPRESENT DIFFERENT MUTATION
     * ========================================================
     *
     * Same operationId
     *
     * but:
     *
     * +15 → +30
     *
     * must be rejected.
     */

    const conflictResponse =
      await request(app)
        .post(
          "/queue-sync",
        )
        .set(
          auth(
            accountA.token,
          ),
        )
        .send({
          ...extendOperation,

          payload: {
            additionalMinutes:
              30,
          },
        });


    assert.equal(
      conflictResponse.status,
      409,
    );


    assert.equal(
      conflictResponse.body
        .error?.code,
      "SYNC_OPERATION_CONFLICT",
    );


    const itemAfterConflict =
      await prisma.queueItem
        .findFirst({
          where: {
            id:
              extendItemId,

            userId:
              accountA.userId,
          },
        });


    assert.ok(
      itemAfterConflict
        ?.timerEndsAt,
    );


    assert.equal(
      itemAfterConflict.timerEndsAt
        .toISOString(),

      itemAfterRetry.timerEndsAt
        .toISOString(),

      "Conflicting reuse of operationId must not mutate the timer.",
    );


    console.log(
      "✅ same ID cannot represent different mutations",
    );


    /**
     * ========================================================
     * 7. ATOMIC MUTATION + RECEIPT
     * ========================================================
     *
     * Try COMPLETE on an ACTIVE task.
     *
     * The sync service creates the receipt before
     * executing the mutation, but both happen inside
     * ONE transaction.
     *
     * COMPLETE fails
     *       ↓
     * transaction rolls back
     *       ↓
     * receipt must NOT exist
     */

    const atomicItemId =
      `queue_sync_atomic_${Date.now()}`;

    await createQueueItem(
      accountA.token,
      atomicItemId,
      "Atomic rollback test",
    );


    const failedOperationId =
      `qsync_atomic_${Date.now()}`;


    const failedSync =
      await request(app)
        .post(
          "/queue-sync",
        )
        .set(
          auth(
            accountA.token,
          ),
        )
        .send({
          operationId:
            failedOperationId,

          entityId:
            atomicItemId,

          type:
            "COMPLETE",

          occurredAt:
            new Date()
              .toISOString(),

          payload:
            null,
        });


    assert.equal(
      failedSync.status,
      409,
    );


    assert.equal(
      failedSync.body
        .error?.code,
      "INVALID_QUEUE_ITEM_TRANSITION",
    );


    const failedReceipt =
      await prisma.queueSyncReceipt
        .findUnique({
          where: {
            userId_operationId: {
              userId:
                accountA.userId,

              operationId:
                failedOperationId,
            },
          },
        });


    assert.equal(
      failedReceipt,
      null,
      "Failed mutation must roll back its receipt.",
    );


    const atomicItem =
      await prisma.queueItem
        .findFirst({
          where: {
            id:
              atomicItemId,

            userId:
              accountA.userId,
          },
        });


    assert.equal(
      atomicItem?.status,
      "ACTIVE",
      "Failed COMPLETE must not partially mutate the QueueItem.",
    );


    console.log(
      "✅ atomic mutation + receipt",
    );


    /**
     * ========================================================
     * 8. OFFLINE TIMESTAMPS PRESERVED
     * ========================================================
     *
     * Pretend the user started this task two minutes
     * ago while offline.
     *
     * The request reaches the server now.
     *
     * startedAt must still equal the historical
     * occurredAt value.
     */

    const timestampItemId =
      `queue_sync_time_${Date.now()}`;

    await createQueueItem(
      accountA.token,
      timestampItemId,
      "Offline timestamp test",
      10,
    );


    const offlineStartAt =
      new Date(
        Date.now() -
        2 * 60_000,
      );


    const startSyncResponse =
      await request(app)
        .post(
          "/queue-sync",
        )
        .set(
          auth(
            accountA.token,
          ),
        )
        .send({
          operationId:
            `qsync_offline_start_${Date.now()}`,

          entityId:
            timestampItemId,

          type:
            "START",

          occurredAt:
            offlineStartAt
              .toISOString(),

          payload:
            null,
        });


    assert.equal(
      startSyncResponse.status,
      200,
      JSON.stringify(
        startSyncResponse.body,
      ),
    );


    assert.equal(
      new Date(
        startSyncResponse.body
          .item.startedAt,
      ).toISOString(),

      offlineStartAt
        .toISOString(),

      "START must preserve offline occurredAt as startedAt.",
    );


    /**
     * Also prove completion uses its own historical
     * timestamp rather than server arrival time.
     */
    const offlineCompleteAt =
      new Date(
        offlineStartAt
          .getTime() +
        60_000,
      );


    const completeSyncResponse =
      await request(app)
        .post(
          "/queue-sync",
        )
        .set(
          auth(
            accountA.token,
          ),
        )
        .send({
          operationId:
            `qsync_offline_complete_${Date.now()}`,

          entityId:
            timestampItemId,

          type:
            "COMPLETE",

          occurredAt:
            offlineCompleteAt
              .toISOString(),

          payload:
            null,
        });


    assert.equal(
      completeSyncResponse.status,
      200,
      JSON.stringify(
        completeSyncResponse.body,
      ),
    );


    assert.equal(
      new Date(
        completeSyncResponse.body
          .item.completedAt,
      ).toISOString(),

      offlineCompleteAt
        .toISOString(),

      "COMPLETE must preserve offline occurredAt as completedAt.",
    );


    console.log(
      "✅ offline timestamps preserved",
    );


    /**
     * ========================================================
     * 9. ENDPOINT REALLY REQUIRES AUTHENTICATION
     * ========================================================
     */

    const anonymousResponse =
      await request(app)
        .post(
          "/queue-sync",
        )
        .send({
          operationId:
            `qsync_anonymous_${Date.now()}`,

          entityId:
            extendItemId,

          type:
            "EXTEND",

          occurredAt:
            new Date()
              .toISOString(),

          payload: {
            additionalMinutes:
              15,
          },
        });


    assert.equal(
      anonymousResponse.status,
      401,
    );


    console.log(
      "✅ sync endpoint requires authentication",
    );


    console.log(
      "\n🎉 Queue sync self-test passed!\n",
    );

    console.log(
      "✅ durable receipt",
    );

    console.log(
      "✅ authenticated ownership",
    );

    console.log(
      "✅ atomic mutation + receipt",
    );

    console.log(
      "✅ safe retry",
    );

    console.log(
      "✅ same operation cannot execute twice",
    );

    console.log(
      "✅ same ID cannot represent different mutations",
    );

    console.log(
      "✅ offline timestamps preserved\n",
    );

  } finally {
    /**
     * Keep the development DB tidy.
     *
     * QueueItems / sessions / sync receipts should
     * disappear through their user relations when
     * User uses onDelete: Cascade.
     *
     * If your User model has another Restrict
     * relationship, remove this cleanup and let
     * your normal test cleanup handle it instead.
     */
    await prisma.user.deleteMany({
      where: {
        id: {
          in: [
            accountA.userId,
            accountB.userId,
          ],
        },
      },
    });


    await prisma.$disconnect();
  }
}


run().catch(
  error => {
    console.error(
      "\n❌ Queue sync self-test failed.\n",
      error,
    );

    process.exitCode =
      1;
  },
);