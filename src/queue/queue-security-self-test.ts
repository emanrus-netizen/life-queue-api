import "dotenv/config";

import assert from "node:assert/strict";

import request from 'supertest';

import {
    app
} from "../app";

import {
    prisma
} from "../db/prisma";


/**
 * Queue API integration/security self-test.
 *
 * Unlike a unit test, this intentionally uses:
 *
 * - real Express routes
 * - real Zod validation
 * - real requireAuth middleware
 * - real session tokens
 * - real Prisma queries
 * - real PostgreSQL ownership constraints
 *
 * The purpose is to prove that account
 * isolation works across the whole backend.
 */

async function run() {

    console.log(
        "🧪 Running Queue API security tests...",
    );

    /**
     * Generate unique test identities so repeated
     * runs do not collide with earlier runs.
     */

    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const emailA =
        `queue-test-a-${runId}@example.com`;

    const emailB =
        `queue-test-b-${runId}@example.com`;


    /**
     * This password only belongs to disposable
     * automated test accounts.
     *
     * Never reuse a real user's credentials in
     * an integration test.
     */
    const password =
        "QueueTest123!";


    const taskId =
        `queue-security-${runId}`;

    let userAId: string | null = null;
    let userBId: string | null = null;

    try {
        /**
         * -----------------------------------------
         * 1. Anonymous access is blocked
         * -----------------------------------------
         */

        const anonymousGet = await request(
            app,
        ).get("/queue-items");

        assert.equal(
            anonymousGet.status,
            401,
            "Anonymous GET /queue-items should return 401.",
        )

        assert.equal(
            anonymousGet.body.error?.code,
            "UNAUTHORIZED",

        )

        console.log(
            "✅ Anonymous queue access is blocked.",
        );


        /**
         * -----------------------------------------
         * 2. Register Account A through REAL API
         * -----------------------------------------
         */

        const registerA = await request(
            app
        ).post("/auth/register")
            .send({
                email: emailA,
                password,
                displayName: "Queue Test A",
            });

        assert.equal(
            registerA.status,
            201,
            `Account A registration failed: ${JSON.stringify(
                registerA.body,
            )}`,
        );

        const tokenA = registerA.body.session?.token;

        userAId = registerA.body.user?.id ?? null;

        assert.equal(
            typeof tokenA,
            "string",
            "Account A should receive a session token."
        );

        assert.equal(
            typeof userAId,
            "string",
            "Account A should receive a user ID.",
        )

        console.log("✅ Account A registered through real auth flow.",)

        /**
         * -----------------------------------------
         * 3. Register Account B
         * -----------------------------------------
         */

        const registerB = await request(
            app
        ).post(
            "/auth/register"
        ).send({
            email: emailB,
            password,
            displayName: "Queue Test B",

        });

        assert.equal(
            registerB.status,
            201,
            `Account B register failed: ${JSON.stringify(
                registerB.body,
            )}`
        );

        const tokenB = registerB.body.session?.token;

        userBId = registerB.body.user?.id ?? null;

        assert.equal(
            typeof tokenB,
            "string",
            "Account B should receive a session token."
        );

        assert.equal(
            typeof userBId,
            "string",
            "Account B should recieve a user ID."
        );

        console.log("✅ Account B registered through real auth flow.",);



        /**
         * -----------------------------------------
         * 4. Account A creates a task
         * -----------------------------------------
         */

        const createA = await request(
            app,
        ).post("/queue-items")
            .set(
                "Authorization",
                `Bearer ${tokenA}`
            ).send({
                id:
                    taskId,

                title:
                    "Account A Security Task",

                description:
                    "Account B must never access this.",

                priority:
                    "HIGH",

                context:
                    "COMPUTER",

                createdAt:
                    new Date()
                        .toISOString(),
            });
        assert.equal(
            createA.status,
            201,
            `Account A task creation failed: ${JSON.stringify(
                createA.body,
            )}`,
        )

        assert.equal(
            createA.body
                .item?.id,
            taskId,
        );


        /**
         * IMPORTANT:
         *
         * The database owner must be derived from
         * Account A's authenticated session.
         */

        assert.equal(
            createA.body.item?.userId,
            userAId
        )


        console.log(
            "✅ Account A can create its own QueueItem.",
        );


        /**
         * -----------------------------------------
         * 5. Account A can read its task
         * -----------------------------------------
         */

        const getA = await request(app)
            .get("/queue-items").set(
                "Authorization",
                `Bearer ${tokenA}`,
            );

        assert.equal(
            getA.status,
            200,
        );

        assert.equal(
            Array.isArray(getA.body.items),
            true
        );

        assert.equal(
            getA.body.items.some(
                (
                    item: {
                        id: string
                    }
                ) => item.id === taskId
            ),
            true,
        )

        console.log(
            "✅ Account A can read its own QueueItem.",
        );


        /**
         * -----------------------------------------
         * 6. Account B cannot see A's task
         * -----------------------------------------
         */

        const getB = await request(app)
            .get("/queue-items").set(
                "Authorization",
                `Bearer ${tokenB}`
            );

        assert.equal(
            getB.status,
            200,
        );

        assert.equal(
            getB.body.items.some(
                (
                    item: {
                        id: string
                    }
                ) => item.id === taskId
            ),
            false,
            "Account B should not see Account A's task."
        );

        console.log(
            "✅ Account B cannot read Account A's QueueItem.",
        );

        const attackPatch = await request(
            app
        ).patch(
            `/queue-items/${taskId}`
        ).set(
            "Authorization",
            `Bearer ${tokenB}`
        ).send({
            title: "Account B hacked this"
        });

        assert.equal(
            attackPatch.status,
            404
        );

        assert.equal(
            attackPatch.body.error?.code,
            "QUEUE_ITEM_NOT_FOUND"
        );
        console.log(
            "✅ Account B cannot modify Account A's QueueItem.",
        );


        /**
         * -----------------------------------------
         * 8. Verify attack did not modify database
         * -----------------------------------------
         */

        const itemAfterAttack =
            await prisma
                .queueItem
                .findUnique({
                    where: {
                        id:
                            taskId,
                    },
                });

        assert.ok(
            itemAfterAttack,
            "Account A task should still exist.",
        );

        assert.equal(
            itemAfterAttack.title,
            "Account A Security Task",
            "Cross-account PATCH must not alter the task.",
        );

        assert.equal(
            itemAfterAttack.userId,
            userAId,
            "Cross-account attack must not alter ownership.",
        );
        /**
         * -----------------------------------------
         * Account A can start its ACTIVE task
         * -----------------------------------------
         */
        const startA =
            await request(
                app,
            )
                .post(
                    `/queue-items/${taskId}/start`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            startA.status,
            200,
        );


        assert.equal(
            startA.body
                .item?.status,
            "IN_PROGRESS",
        );


        assert.equal(
            typeof startA.body
                .item?.startedAt,
            "string",
        );


        console.log(
            "✅ Account A can transition ACTIVE → IN_PROGRESS.",
        );
        /**
         * -----------------------------------------
         * IN_PROGRESS cannot be started again
         * -----------------------------------------
         */
        const startAgain =
            await request(
                app,
            )
                .post(
                    `/queue-items/${taskId}/start`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            startAgain.status,
            409,
        );

        /**
         * -----------------------------------------
         * Account B cannot start Account A's task
         * -----------------------------------------
         */
        const startByB =
            await request(
                app,
            )
                .post(
                    `/queue-items/${taskId}/start`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenB}`,
                );


        assert.equal(
            startByB.status,
            404,
        );


        assert.equal(
            startByB.body
                .error?.code,
            "QUEUE_ITEM_NOT_FOUND",
        );


        console.log(
            "✅ Account B cannot start Account A's QueueItem.",
        );


        assert.equal(
            startAgain.body
                .error?.code,
            "INVALID_QUEUE_ITEM_TRANSITION",
        );


        console.log(
            "✅ IN_PROGRESS QueueItem cannot be started twice.",
        );

        console.log(
            "✅ Failed cross-account attack leaves database unchanged.",
        );

        /**
         * -----------------------------------------
         * 9. Account A CAN update its own task
         * -----------------------------------------
         */

        const updateA = await request(
            app
        ).patch(
            `/queue-items/${taskId}`,
        ).set(
            "Authorization",
            `Bearer ${tokenA}`
        ).send({
            priority: "URGENT"
        })

        assert.equal(
            updateA.status,
            200
        )

        assert.equal(
            updateA.body.item?.priority,
            "URGENT"
        )

        console.log(
            "✅ Account A can modify its own QueueItem.",
        );

        /**
 * -----------------------------------------
 * General PATCH cannot rewrite lifecycle
 * -----------------------------------------
 *
 * Lifecycle changes must eventually go through
 * dedicated command endpoints.
 */
        const illegalLifecyclePatch =
            await request(
                app,
            )
                .patch(
                    `/queue-items/${taskId}`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    status:
                        "COMPLETED",

                    completedAt:
                        new Date()
                            .toISOString(),
                });


        assert.equal(
            illegalLifecyclePatch.status,
            400,
        );


        assert.equal(
            illegalLifecyclePatch.body
                .error?.code,
            "INVALID_QUEUE_ITEM",
        );


        console.log(
            "✅ General PATCH cannot rewrite QueueItem lifecycle.",
        );

        const illegalEstimatePatch =
            await request(
                app,
            )
                .patch(
                    `/queue-items/${taskId}`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    estimatedMinutes:
                        999,
                });


        assert.equal(
            illegalEstimatePatch.status,
            400,
        );


        console.log(
            "✅ Original task estimate cannot be rewritten through PATCH.",
        );
        /**
         * -----------------------------------------
         * 10. userId injection is rejected
         * -----------------------------------------
         *
         * Account B deliberately asks the server
         * to create a task under Account A.
         *
         * Zod .strict() must reject this field.
         */

        const ownershipInjection = await request(
            app
        ).post(
            "/queue-items"
        ).set(
            "Authorization",
            `Bearer ${tokenB}`
        ).send({
            id:
                `malicious-${runId}`,

            userId:
                userAId,

            title:
                "Try stealing ownership",

            description:
                "",

            status:
                "ACTIVE",

            priority:
                "NORMAL",

            context:
                "ANYWHERE",

            createdAt:
                new Date()
                    .toISOString(),
        });

        assert.equal(
            ownershipInjection.status,
            400,
        );

        assert.equal(
            ownershipInjection.body.error?.code,
            "INVALID_QUEUE_ITEM",
        );

        console.log(
            "✅ Client-supplied userId is rejected.",
        );

        /**
         * -----------------------------------------
         * 11. Ensure malicious record never existed
         * -----------------------------------------
         */

        const maliciousRecord =
            await prisma
                .queueItem
                .findUnique({
                    where: {
                        id:
                            `malicious-${runId}`,
                    },
                });
        assert.equal(
            maliciousRecord,
            null,
            "Rejected ownership-injection request must not create a row.",
        );

        console.log(
            "✅ Ownership injection creates no database record.",
        );

        const completeByB =
            await request(
                app,
            )
                .post(
                    `/queue-items/${taskId}/complete`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenB}`,
                );


        assert.equal(
            completeByB.status,
            404,
        );


        assert.equal(
            completeByB.body
                .error?.code,
            "QUEUE_ITEM_NOT_FOUND",
        );


        console.log(
            "✅ Account B cannot complete Account A's QueueItem.",
        );
        const completeA =
            await request(
                app,
            )
                .post(
                    `/queue-items/${taskId}/complete`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            completeA.status,
            200,
        );


        assert.equal(
            completeA.body
                .item?.status,
            "COMPLETED",
        );


        assert.equal(
            typeof completeA.body
                .item?.completedAt,
            "string",
        );


        /**
         * Completed work no longer has an active timer.
         */
        assert.equal(
            completeA.body
                .item?.timerEndsAt,
            null,
        );


        console.log(
            "✅ Account A can transition IN_PROGRESS → COMPLETED.",
        );
        const startedAt =
            new Date(
                completeA.body
                    .item.startedAt,
            );


        const completedAt =
            new Date(
                completeA.body
                    .item.completedAt,
            );


        assert.equal(
            completedAt.getTime() >=
            startedAt.getTime(),
            true,
            "Completion time must not be before start time.",
        );


        console.log(
            "✅ Completion timestamp occurs after the task started.",
        );

        const completeAgain =
            await request(
                app,
            )
                .post(
                    `/queue-items/${taskId}/complete`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            completeAgain.status,
            409,
        );


        assert.equal(
            completeAgain.body
                .error?.code,
            "INVALID_QUEUE_ITEM_TRANSITION",
        );


        assert.equal(
            completeAgain.body
                .error?.currentStatus,
            "COMPLETED",
        );


        console.log(
            "✅ COMPLETED QueueItem cannot be completed twice.",
        );

        const restartCompleted =
            await request(
                app,
            )
                .post(
                    `/queue-items/${taskId}/start`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            restartCompleted.status,
            409,
        );


        console.log(
            "✅ COMPLETED QueueItem cannot be started again.",
        );

        assert.equal(
            createA.body
                .item?.status,
            "ACTIVE",
        );


        assert.equal(
            createA.body
                .item?.startedAt,
            null,
        );


        assert.equal(
            createA.body
                .item?.completedAt,
            null,
        );


        console.log(
            "✅ New QueueItem always begins in a clean ACTIVE state.",
        );
        const lifecycleInjection =
            await request(
                app,
            )
                .post(
                    "/queue-items",
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    id:
                        `lifecycle-injection-${runId}`,

                    title:
                        "Fake completed task",

                    description:
                        "",

                    priority:
                        "NORMAL",

                    context:
                        "ANYWHERE",

                    createdAt:
                        new Date()
                            .toISOString(),

                    status:
                        "COMPLETED",

                    completedAt:
                        new Date()
                            .toISOString(),
                });


        assert.equal(
            lifecycleInjection.status,
            400,
        );


        assert.equal(
            lifecycleInjection.body
                .error?.code,
            "INVALID_QUEUE_ITEM",
        );


        console.log(
            "✅ QueueItem creation cannot bypass lifecycle commands.",
        );

        const injectedRecord =
            await prisma.queueItem.findUnique({
                where: {
                    id:
                        `lifecycle-injection-${runId}`,
                },
            });


        assert.equal(
            injectedRecord,
            null,
        );


        console.log(
            "✅ Rejected lifecycle injection creates no database row.",
        );

        const snoozeTaskId =
            `queue-snooze-${runId}`;

        const createSnoozeTask =
            await request(
                app,
            )
                .post(
                    "/queue-items",
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    id:
                        snoozeTaskId,

                    title:
                        "Snooze Security Task",

                    description:
                        "",

                    priority:
                        "NORMAL",

                    context:
                        "ANYWHERE",

                    createdAt:
                        new Date()
                            .toISOString(),
                });


        assert.equal(
            createSnoozeTask.status,
            201,
        );
        const snoozeUntil =
            new Date(
                Date.now() +
                30 * 60_000,
            );

        const snoozeByB =
            await request(
                app,
            )
                .post(
                    `/queue-items/${snoozeTaskId}/snooze`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenB}`,
                )
                .send({
                    deferUntil:
                        snoozeUntil.toISOString(),
                });


        assert.equal(
            snoozeByB.status,
            404,
        );


        console.log(
            "✅ Account B cannot snooze Account A's QueueItem.",
        );

        const snoozeA =
            await request(
                app,
            )
                .post(
                    `/queue-items/${snoozeTaskId}/snooze`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    deferUntil:
                        snoozeUntil.toISOString(),
                });


        assert.equal(
            snoozeA.status,
            200,
        );


        assert.equal(
            snoozeA.body
                .item?.status,
            "ACTIVE",
        );


        assert.equal(
            snoozeA.body
                .item?.deferUntil,
            snoozeUntil.toISOString(),
        );


        console.log(
            "✅ Snooze keeps QueueItem ACTIVE and sets deferUntil.",
        );

        const startWhileSnoozed =
            await request(
                app,
            )
                .post(
                    `/queue-items/${snoozeTaskId}/start`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            startWhileSnoozed.status,
            409,
        );


        assert.equal(
            startWhileSnoozed.body
                .error?.code,
            "QUEUE_ITEM_DEFERRED",
        );


        console.log(
            "✅ Snoozed QueueItem cannot be started before deferUntil.",
        );

        const pastSnooze =
            await request(
                app,
            )
                .post(
                    `/queue-items/${snoozeTaskId}/snooze`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    deferUntil:
                        new Date(
                            Date.now() -
                            60_000,
                        ).toISOString(),
                });


        assert.equal(
            pastSnooze.status,
            400,
        );


        assert.equal(
            pastSnooze.body
                .error?.code,
            "INVALID_SNOOZE_TIME",
        );


        console.log(
            "✅ Snooze cannot use a past deferUntil timestamp.",
        );

        /**
 * -----------------------------------------
 * Expired snooze becomes startable
 * -----------------------------------------
 *
 * We directly move deferUntil into the past
 * as TEST SETUP so we don't need to wait
 * 30 minutes in an automated test.
 *
 * The actual behavior is still exercised
 * through the real /start API.
 */
        await prisma.queueItem.update({
            where: {
                id:
                    snoozeTaskId,
            },

            data: {
                deferUntil:
                    new Date(
                        Date.now() -
                        60_000,
                    ),
            },
        });


        const startAfterSnooze =
            await request(
                app,
            )
                .post(
                    `/queue-items/${snoozeTaskId}/start`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            startAfterSnooze.status,
            200,
        );


        assert.equal(
            startAfterSnooze.body
                .item?.status,
            "IN_PROGRESS",
        );


        /**
         * Once the expired snooze has served its
         * purpose, /start should clear the boundary.
         */
        assert.equal(
            startAfterSnooze.body
                .item?.deferUntil,
            null,
        );


        console.log(
            "✅ QueueItem becomes startable after snooze expires.",
        );


        console.log(
            "✅ Starting after snooze clears the old deferUntil.",
        );

        const cancelTaskId =
            `queue-cancel-${runId}`;
        const createCancelTask =
            await request(
                app,
            )
                .post(
                    "/queue-items",
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    id:
                        cancelTaskId,

                    title:
                        "Cancel Security Task",

                    description:
                        "",

                    priority:
                        "NORMAL",

                    context:
                        "ANYWHERE",

                    createdAt:
                        new Date()
                            .toISOString(),
                });


        assert.equal(
            createCancelTask.status,
            201,
        );
        const cancelByB =
            await request(
                app,
            )
                .post(
                    `/queue-items/${cancelTaskId}/cancel`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenB}`,
                );


        assert.equal(
            cancelByB.status,
            404,
        );


        assert.equal(
            cancelByB.body
                .error?.code,
            "QUEUE_ITEM_NOT_FOUND",
        );


        console.log(
            "✅ Account B cannot cancel Account A's QueueItem.",
        );
        const cancelA =
            await request(
                app,
            )
                .post(
                    `/queue-items/${cancelTaskId}/cancel`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            cancelA.status,
            200,
        );


        assert.equal(
            cancelA.body
                .item?.status,
            "CANCELLED",
        );


        assert.equal(
            cancelA.body
                .item?.deferUntil,
            null,
        );


        assert.equal(
            cancelA.body
                .item?.timerEndsAt,
            null,
        );


        assert.equal(
            cancelA.body
                .item?.completedAt,
            null,
        );


        console.log(
            "✅ Account A can transition ACTIVE → CANCELLED.",
        );

        const cancelAgain =
            await request(
                app,
            )
                .post(
                    `/queue-items/${cancelTaskId}/cancel`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            cancelAgain.status,
            409,
        );


        assert.equal(
            cancelAgain.body
                .error?.currentStatus,
            "CANCELLED",
        );


        console.log(
            "✅ CANCELLED QueueItem cannot be cancelled twice.",
        );

        const startCancelled =
            await request(
                app,
            )
                .post(
                    `/queue-items/${cancelTaskId}/start`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                );


        assert.equal(
            startCancelled.status,
            409,
        );


        console.log(
            "✅ CANCELLED QueueItem cannot be started.",
        );

        const historicalTaskId =
            `historical-${runId}`;


        const historicalCreatedAt =
            new Date(
                Date.now() -
                60 * 60_000,
            );


        const historicalStartedAt =
            new Date(
                historicalCreatedAt.getTime() +
                30 * 60_000,
            );


        const historicalCompletedAt =
            new Date(
                historicalStartedAt.getTime() +
                5 * 60_000,
            );

        const importHistory =
            await request(
                app,
            )
                .post(
                    "/queue-items/import",
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    items: [
                        {
                            id:
                                historicalTaskId,

                            title:
                                "Historical completed task",

                            description:
                                "",

                            status:
                                "COMPLETED",

                            priority:
                                "NORMAL",

                            estimatedMinutes:
                                15,

                            context:
                                "ANYWHERE",

                            createdAt:
                                historicalCreatedAt
                                    .toISOString(),

                            startedAt:
                                historicalStartedAt
                                    .toISOString(),

                            timerEndsAt:
                                new Date(
                                    historicalStartedAt.getTime() +
                                    15 * 60_000,
                                ).toISOString(),

                            completedAt:
                                historicalCompletedAt
                                    .toISOString(),
                        },
                    ],
                });


        assert.equal(
            importHistory.status,
            200,
        );


        assert.equal(
            importHistory.body
                .imported?.[0]?.status,
            "COMPLETED",
        );


        assert.equal(
            importHistory.body
                .imported?.[0]?.userId,
            userAId,
        );


        console.log(
            "✅ Historical QueueItem imports under authenticated owner.",
        );
        const repeatImport =
            await request(
                app,
            )
                .post(
                    "/queue-items/import",
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    items: [
                        {
                            id:
                                historicalTaskId,

                            title:
                                "Historical completed task",

                            description:
                                "",

                            status:
                                "COMPLETED",

                            priority:
                                "NORMAL",

                            estimatedMinutes:
                                15,

                            context:
                                "ANYWHERE",

                            createdAt:
                                historicalCreatedAt
                                    .toISOString(),

                            startedAt:
                                historicalStartedAt
                                    .toISOString(),

                            timerEndsAt:
                                new Date(
                                    historicalStartedAt.getTime() +
                                    15 * 60_000,
                                ).toISOString(),

                            completedAt:
                                historicalCompletedAt
                                    .toISOString(),
                        },
                    ],
                });


        assert.equal(
            repeatImport.status,
            200,
        );


        assert.equal(
            repeatImport.body
                .imported.length,
            0,
        );


        assert.equal(
            repeatImport.body
                .skippedIds.includes(
                    historicalTaskId,
                ),
            true,
        );


        console.log(
            "✅ Repeating historical import does not duplicate QueueItems.",
        );

        const invalidHistory =
            await request(
                app,
            )
                .post(
                    "/queue-items/import",
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    items: [
                        {
                            id:
                                `invalid-history-${runId}`,

                            title:
                                "Impossible completed task",

                            description:
                                "",

                            status:
                                "COMPLETED",

                            priority:
                                "NORMAL",

                            context:
                                "ANYWHERE",

                            createdAt:
                                new Date()
                                    .toISOString(),

                            /**
                             * COMPLETED without startedAt or
                             * completedAt must be rejected.
                             */
                        },
                    ],
                });


        assert.equal(
            invalidHistory.status,
            400,
        );


        console.log(
            "✅ Invalid historical lifecycle cannot be imported.",
        );

        await testExtendQueueItemSecurity(
            tokenA,
            tokenB,
        );
        console.log(
            "\n🎉 Queue API security tests passed.",
        );
    } finally {
        /**
         * -----------------------------------------
         * TEST CLEANUP
         * -----------------------------------------
         *
         * User → Session and User → QueueItem both
         * use onDelete: Cascade.
         *
         * Therefore deleting the disposable users
         * cleans up:
         *
         * - sessions
         * - QueueItems
         *
         * created by this test.
         */

        const testUserIds =
            [
                userAId,
                userBId,
            ].filter(
                (
                    id,
                ): id is string => id !== null,
            );

        if (
            testUserIds.length > 0
        ) {
            await prisma.user.deleteMany({
                where: {
                    id: {
                        in: testUserIds
                    }
                }
            });
        }

        await prisma.$disconnect();
    }
}

run().catch(
    error => {
        console.error(
            "\n❌ Queue API security test failed:",
            error
        );
        process.exitCode = 1;
    }
);

async function testExtendQueueItemSecurity(
    tokenA: string,
    tokenB: string,
) {
    const suffix =
        Date.now().toString(36);


    /**
     * Small test-only helper.
     *
     * We create tasks through the REAL HTTP API,
     * not directly through Prisma.
     *
     * That means these tests exercise:
     *
     * route
     * → requireAuth
     * → Zod
     * → service
     * → Prisma/PostgreSQL
     */
    async function createTestTask(
        token: string,
        id: string,
        estimatedMinutes = 10,
    ) {
        const response =
            await request(app)
                .post(
                    "/queue-items",
                )
                .set(
                    "Authorization",
                    `Bearer ${token}`,
                )
                .send({
                    id,

                    title:
                        `Extend security test ${id}`,

                    description:
                        "Temporary automated test task.",

                    priority:
                        "NORMAL",

                    estimatedMinutes,

                    context:
                        "ANYWHERE",

                    createdAt:
                        new Date().toISOString(),
                });


        assert.equal(
            response.status,
            201,
            `Expected QueueItem creation to return 201. Body: ${JSON.stringify(response.body)}`,
        );


        return response.body.item;
    }


    /**
     * --------------------------------------------------
     * 1. OWNER CAN EXTEND AN IN_PROGRESS TASK
     * --------------------------------------------------
     */
    const extendTaskId =
        `extend-owner-${suffix}`;


    await createTestTask(
        tokenA,
        extendTaskId,
        10,
    );


    const startResponse =
        await request(app)
            .post(
                `/queue-items/${extendTaskId}/start`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            );


    assert.equal(
        startResponse.status,
        200,
    );


    assert.equal(
        startResponse.body.item.status,
        "IN_PROGRESS",
    );


    const timerBefore =
        new Date(
            startResponse.body.item.timerEndsAt,
        );


    assert.equal(
        startResponse.body.item.estimatedMinutes,
        10,
    );


    console.log(
        "✅ owner starts task",
    );


    const extendResponse =
        await request(app)
            .post(
                `/queue-items/${extendTaskId}/extend`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            )
            .send({
                additionalMinutes:
                    15,
            });


    assert.equal(
        extendResponse.status,
        200,
        JSON.stringify(
            extendResponse.body,
        ),
    );


    assert.equal(
        extendResponse.body.item.status,
        "IN_PROGRESS",
    );


    console.log(
        "✅ owner extends IN_PROGRESS task",
    );


    const timerAfter =
        new Date(
            extendResponse.body.item.timerEndsAt,
        );


    assert.ok(
        timerAfter.getTime() >
        timerBefore.getTime(),
    );


    /**
     * Because the original deadline was still in
     * the future, the backend should add exactly
     * 15 minutes to that deadline.
     */
    assert.equal(
        timerAfter.getTime() -
        timerBefore.getTime(),

        15 * 60_000,
    );


    console.log(
        "✅ timerEndsAt moves forward",
    );


    /**
     * Extension must NEVER rewrite the original
     * estimate.
     */
    assert.equal(
        extendResponse.body.item.estimatedMinutes,
        10,
    );


    console.log(
        "✅ estimatedMinutes does NOT change",
    );


    /**
     * --------------------------------------------------
     * 2. ACTIVE TASK CANNOT BE EXTENDED
     * --------------------------------------------------
     */
    const activeTaskId =
        `extend-active-${suffix}`;


    await createTestTask(
        tokenA,
        activeTaskId,
    );


    const activeExtendResponse =
        await request(app)
            .post(
                `/queue-items/${activeTaskId}/extend`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            )
            .send({
                additionalMinutes:
                    15,
            });


    assert.equal(
        activeExtendResponse.status,
        409,
    );


    assert.equal(
        activeExtendResponse.body.error.code,
        "INVALID_QUEUE_ITEM_TRANSITION",
    );


    console.log(
        "✅ ACTIVE task cannot be extended → 409",
    );


    /**
     * --------------------------------------------------
     * 3. COMPLETED TASK CANNOT BE EXTENDED
     * --------------------------------------------------
     */
    const completedTaskId =
        `extend-completed-${suffix}`;


    await createTestTask(
        tokenA,
        completedTaskId,
    );


    const startCompletedTask =
        await request(app)
            .post(
                `/queue-items/${completedTaskId}/start`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            );


    assert.equal(
        startCompletedTask.status,
        200,
    );


    const completeResponse =
        await request(app)
            .post(
                `/queue-items/${completedTaskId}/complete`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            );


    assert.equal(
        completeResponse.status,
        200,
    );


    const completedExtendResponse =
        await request(app)
            .post(
                `/queue-items/${completedTaskId}/extend`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            )
            .send({
                additionalMinutes:
                    15,
            });


    assert.equal(
        completedExtendResponse.status,
        409,
    );


    assert.equal(
        completedExtendResponse.body.error.code,
        "INVALID_QUEUE_ITEM_TRANSITION",
    );


    assert.equal(
        completedExtendResponse.body.error.currentStatus,
        "COMPLETED",
    );


    console.log(
        "✅ COMPLETED task cannot be extended → 409",
    );


    /**
     * --------------------------------------------------
     * 4. ACCOUNT ISOLATION
     * --------------------------------------------------
     *
     * Account B should receive exactly the same
     * public behavior as an unknown ID.
     *
     * We do NOT want:
     *
     * 403 "belongs to another user"
     *
     * because that leaks resource existence.
     */
    const crossAccountResponse =
        await request(app)
            .post(
                `/queue-items/${extendTaskId}/extend`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenB}`,
            )
            .send({
                additionalMinutes:
                    15,
            });


    assert.equal(
        crossAccountResponse.status,
        404,
    );


    assert.equal(
        crossAccountResponse.body.error.code,
        "QUEUE_ITEM_NOT_FOUND",
    );


    console.log(
        "✅ Account B extending Account A task → 404",
    );


    const missingResponse =
        await request(app)
            .post(
                `/queue-items/definitely-missing-${suffix}/extend`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenB}`,
            )
            .send({
                additionalMinutes:
                    15,
            });


    assert.equal(
        missingResponse.status,
        404,
    );


    assert.equal(
        missingResponse.body.error.code,
        "QUEUE_ITEM_NOT_FOUND",
    );


    /**
     * Their externally visible behavior should
     * match.
     */
    assert.deepEqual(
        crossAccountResponse.body,
        missingResponse.body,
    );


    console.log(
        "✅ nonexistent task → same 404",
    );


    /**
     * --------------------------------------------------
     * 5. INVALID MINUTE VALUES
     * --------------------------------------------------
     */
    for (
        const invalidMinutes of
        [
            0,
            -15,
            1.5,
        ]
    ) {
        const response =
            await request(app)
                .post(
                    `/queue-items/${extendTaskId}/extend`,
                )
                .set(
                    "Authorization",
                    `Bearer ${tokenA}`,
                )
                .send({
                    additionalMinutes:
                        invalidMinutes,
                });


        assert.equal(
            response.status,
            400,
            `Expected ${invalidMinutes} to be rejected.`,
        );


        assert.equal(
            response.body.error.code,
            "INVALID_EXTEND_TIME",
        );
    }


    console.log(
        "✅ additionalMinutes = 0 → 400",
    );

    console.log(
        "✅ additionalMinutes = -15 → 400",
    );

    console.log(
        "✅ additionalMinutes = 1.5 → 400",
    );


    /**
     * --------------------------------------------------
     * 6. LIFECYCLE FIELD INJECTION
     * --------------------------------------------------
     *
     * Requires extendQueueItemSchema to be .strict().
     *
     * The client is allowed to submit ONLY:
     *
     * {
     *   additionalMinutes
     * }
     */
    const injectedTimerResponse =
        await request(app)
            .post(
                `/queue-items/${extendTaskId}/extend`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            )
            .send({
                additionalMinutes:
                    15,

                timerEndsAt:
                    "2099-01-01T00:00:00.000Z",
            });


    assert.equal(
        injectedTimerResponse.status,
        400,
    );


    assert.equal(
        injectedTimerResponse.body.error.code,
        "INVALID_EXTEND_TIME",
    );


    console.log(
        "✅ injected timerEndsAt rejected",
    );


    /**
     * Ownership must never come from request.body.
     */
    const injectedUserResponse =
        await request(app)
            .post(
                `/queue-items/${extendTaskId}/extend`,
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            )
            .send({
                additionalMinutes:
                    15,

                userId:
                    "attacker-controlled-user-id",
            });


    assert.equal(
        injectedUserResponse.status,
        400,
    );


    assert.equal(
        injectedUserResponse.body.error.code,
        "INVALID_EXTEND_TIME",
    );


    console.log(
        "✅ injected userId rejected",
    );


    /**
     * --------------------------------------------------
     * 7. FINAL PERSISTENCE CHECK
     * --------------------------------------------------
     *
     * Invalid injection attempts must not have
     * changed the valid timer established earlier.
     */
    const queueResponse =
        await request(app)
            .get(
                "/queue-items",
            )
            .set(
                "Authorization",
                `Bearer ${tokenA}`,
            );


    assert.equal(
        queueResponse.status,
        200,
    );


    const persistedItem =
        queueResponse.body.items.find(
            (
                item: {
                    id: string;
                    estimatedMinutes:
                    number | null;
                    timerEndsAt:
                    string | null;
                },
            ) =>
                item.id ===
                extendTaskId,
        );


    assert.ok(
        persistedItem,
        "Expected extended QueueItem to still exist.",
    );


    assert.equal(
        persistedItem.estimatedMinutes,
        10,
    );


    assert.equal(
        new Date(
            persistedItem.timerEndsAt,
        ).getTime(),
        timerAfter.getTime(),
    );


    console.log(
        "✅ invalid requests did not mutate persisted timer",
    );
}