import "dotenv/config";

import assert from "node:assert/strict";
import request from "supertest";

import { app } from "../app";
import { prisma } from "../db/prisma";

/**
 * End-to-end API/security self-test.
 *
 * We exercise the REAL Express routes with two temporary accounts.
 * Nothing is mocked: authentication, Prisma, and PostgreSQL all participate.
 *
 * Run from life-queue-api/:
 *   npx tsx src/routine/routine-security-self-test.ts
 *
 * IMPORTANT: Run only against a development/test database.
 */
async function run() {
    console.log("🧪 Running Routine API security tests...");

    const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const emailA = `routine-test-a-${runId}@example.com`;
    const emailB = `routine-test-b-${runId}@example.com`;
    const password = "QueueTest123!";
    const routineId = `routine-security-${runId}`;
    const sessionId = `routine-session-${runId}`;

    // Remember the disposable accounts for cleanup, even if a test fails.
    let userAId: string | null = null;
    let userBId: string | null = null;

    try {
        // ------------------------------------------------------------
        // 1. ANONYMOUS ACCESS MUST BE BLOCKED
        // ------------------------------------------------------------
        const anonymousGet = await request(app).get("/routines");

        assert.equal(anonymousGet.status, 401);
        assert.equal(anonymousGet.body.error?.code, "UNAUTHORIZED");
        console.log("✅ Anonymous Routine access is blocked.");

        // ------------------------------------------------------------
        // 2. REGISTER TWO DIFFERENT USERS THROUGH REAL AUTH
        // ------------------------------------------------------------
        const registerA = await request(app)
            .post("/auth/register")
            .send({ email: emailA, password, displayName: "Routine Test A" });

        assert.equal(
            registerA.status,
            201,
            `Account A registration failed: ${JSON.stringify(registerA.body)}`,
        );

        const tokenA: string | undefined = registerA.body.session?.token;
        userAId = registerA.body.user?.id ?? null;

        assert.equal(typeof tokenA, "string");
        assert.equal(typeof userAId, "string");
        console.log("✅ Account A registered through real auth flow.");

        const registerB = await request(app)
            .post("/auth/register")
            .send({ email: emailB, password, displayName: "Routine Test B" });

        assert.equal(
            registerB.status,
            201,
            `Account B registration failed: ${JSON.stringify(registerB.body)}`,
        );

        const tokenB: string | undefined = registerB.body.session?.token;
        userBId = registerB.body.user?.id ?? null;

        assert.equal(typeof tokenB, "string");
        assert.equal(typeof userBId, "string");
        console.log("✅ Account B registered through real auth flow.");

        // ------------------------------------------------------------
        // 3. CREATE + READ: ROUTINES ARE ACCOUNT-SCOPED
        // ------------------------------------------------------------
        const createA = await request(app)
            .post("/routines")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                id: routineId,
                name: "Study TypeScript",
                description: "Improve my TypeScript skills",
                targetSessionsPerWeek: 3,
                preferredMinutes: 30,
                preferredTime: "EVENING",
                context: "COMPUTER",
                energy: "MEDIUM",
                createdAt: new Date().toISOString(),
            });

        assert.equal(
            createA.status,
            201,
            `Account A routine creation failed: ${JSON.stringify(createA.body)}`,
        );
        assert.equal(createA.body.routine?.id, routineId);
        // Ownership must come from the verified token, not the request body.
        assert.equal(createA.body.routine?.userId, userAId);
        console.log("✅ Account A can create its own Routine.");

        const getA = await request(app)
            .get("/routines")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(getA.status, 200);
        assert.equal(Array.isArray(getA.body.routines), true);
        assert.equal(
            getA.body.routines.some((routine: { id: string }) => routine.id === routineId),
            true,
        );
        console.log("✅ Account A can read its own Routine.");

        const getB = await request(app)
            .get("/routines")
            .set("Authorization", `Bearer ${tokenB}`);

        assert.equal(getB.status, 200);
        assert.equal(Array.isArray(getB.body.routines), true);
        assert.equal(
            getB.body.routines.some((routine: { id: string }) => routine.id === routineId),
            false,
            "Account B must not see Account A's routine.",
        );
        console.log("✅ Account B cannot read Account A's Routine.");

        // A client must not be allowed to choose a different routine owner.
        const forgedCreate = await request(app)
            .post("/routines")
            .set("Authorization", `Bearer ${tokenB}`)
            .send({
                id: `routine-forged-${runId}`,
                name: "Forged Routine",
                userId: userAId,
                targetSessionsPerWeek: 3,
                preferredMinutes: 30,
                preferredTime: "ANYTIME",
                context: "ANYWHERE",
                createdAt: new Date().toISOString(),
            });

        assert.equal(forgedCreate.status, 400);
        assert.equal(forgedCreate.body.error?.code, "INVALID_ROUTINE");
        console.log("✅ Client cannot forge routine ownership.");

        // ------------------------------------------------------------
        // 4. UPDATE: PARTIAL CHANGES + OWNERSHIP CHECKS
        // ------------------------------------------------------------
        const updateA = await request(app)
            .patch(`/routines/${routineId}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ name: "Advanced TypeScript", preferredMinutes: 45 });

        assert.equal(updateA.status, 200, JSON.stringify(updateA.body));
        assert.equal(updateA.body.routine?.name, "Advanced TypeScript");
        assert.equal(updateA.body.routine?.preferredMinutes, 45);
        // A PATCH must not reset an unspecified weekly target.
        assert.equal(updateA.body.routine?.targetSessionsPerWeek, 3);
        console.log("✅ Account A can update its own Routine.");

        const forbiddenUpdate = await request(app)
            .patch(`/routines/${routineId}`)
            .set("Authorization", `Bearer ${tokenB}`)
            .send({ name: "Hacked Routine" });

        assert.equal(forbiddenUpdate.status, 404);
        console.log("✅ Account B cannot update Account A's Routine.");

        // Check the rejected request did not modify the underlying record.
        const verifyA = await request(app)
            .get("/routines")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(verifyA.status, 200);
        const savedRoutine = verifyA.body.routines.find(
            (routine: { id: string }) => routine.id === routineId,
        );
        assert.equal(savedRoutine?.name, "Advanced TypeScript");
        console.log("✅ Unauthorized update did not modify the Routine.");

        const forgedUpdate = await request(app)
            .patch(`/routines/${routineId}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ userId: userBId });

        assert.equal(forgedUpdate.status, 400);
        assert.equal(forgedUpdate.body.error?.code, "INVALID_ROUTINE_UPDATE");
        console.log("✅ Routine ownership cannot be reassigned.");

        // ------------------------------------------------------------
        // 5. DEACTIVATE → REJECT START → REACTIVATE
        // ------------------------------------------------------------
        const deactivate = await request(app)
            .patch(`/routines/${routineId}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ isActive: false });

        assert.equal(deactivate.status, 200);
        assert.equal(deactivate.body.routine?.isActive, false);
        console.log("✅ Routine can be deactivated without deletion.");

        const inactiveStart = await request(app)
            .post("/routine-sessions")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                id: `inactive-session-${runId}`,
                routineId,
                startedAt: new Date().toISOString(),
            });

        assert.equal(inactiveStart.status, 409);
        assert.equal(inactiveStart.body.error?.code, "ROUTINE_SESSION_CONFLICT");
        console.log("✅ Inactive routines cannot be started.");

        const reactivate = await request(app)
            .patch(`/routines/${routineId}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ isActive: true });

        assert.equal(reactivate.status, 200);
        assert.equal(reactivate.body.routine?.isActive, true);
        console.log("✅ Routine reactivated successfully.");

        // ------------------------------------------------------------
        // 6. START: NEW SESSION IS IN_PROGRESS
        // ------------------------------------------------------------
        const startA = await request(app)
            .post("/routine-sessions")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                id: sessionId,
                routineId,
                startedAt: new Date().toISOString(),
            });

        assert.equal(
            startA.status,
            201,
            `Session start failed: ${JSON.stringify(startA.body)}`,
        );
        assert.equal(startA.body.session?.id, sessionId);
        assert.equal(startA.body.session?.userId, userAId);
        assert.equal(startA.body.session?.status, "IN_PROGRESS");
        console.log("✅ Account A can start its own RoutineSession.");

        const forbiddenStart = await request(app)
            .post("/routine-sessions")
            .set("Authorization", `Bearer ${tokenB}`)
            .send({
                id: `forbidden-session-${runId}`,
                routineId,
                startedAt: new Date().toISOString(),
            });

        assert.equal(forbiddenStart.status, 404);
        console.log("✅ Account B cannot start Account A's routine.");

        const getSessionsB = await request(app)
            .get("/routine-sessions")
            .set("Authorization", `Bearer ${tokenB}`);

        assert.equal(getSessionsB.status, 200);
        assert.equal(Array.isArray(getSessionsB.body.sessions), true);
        assert.equal(
            getSessionsB.body.sessions.some(
                (session: { id: string }) => session.id === sessionId,
            ),
            false,
        );
        console.log("✅ Account B cannot read Account A's RoutineSession.");

        // ------------------------------------------------------------
        // 7. EXTEND: MUST RUN WHILE SESSION IS *IN_PROGRESS*
        // ------------------------------------------------------------
        // When the session is completed, extensions must be rejected.
        // Therefore these tests MUST come BEFORE the completion tests.
        const previousDeadline: string | null =
            startA.body.session?.timerEndsAt ?? null;
        const occurredAt = new Date().toISOString();

        // Match the mobile rule: extend from the existing future deadline,
        // or from the action time when the timer has already expired.
        const extensionBase = Math.max(
            Date.parse(occurredAt),
            previousDeadline ? Date.parse(previousDeadline) : Date.parse(occurredAt),
        );
        const newDeadline = new Date(extensionBase + 15 * 60_000).toISOString();

        const extensionPayload = {
            expectedTimerEndsAt: previousDeadline,
            timerEndsAt: newDeadline,
            occurredAt,
        };

        const forbiddenExtend = await request(app)
            .post(`/routine-sessions/${sessionId}/extend`)
            .set("Authorization", `Bearer ${tokenB}`)
            .send(extensionPayload);

        assert.equal(forbiddenExtend.status, 404);
        console.log("✅ Account B cannot extend A's session.");

        const extendA = await request(app)
            .post(`/routine-sessions/${sessionId}/extend`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send(extensionPayload);

        assert.equal(extendA.status, 200, JSON.stringify(extendA.body));
        assert.equal(extendA.body.session?.timerEndsAt, newDeadline);
        console.log("✅ Account A can extend its session timer.");

        // Retrying the SAME request must not extend the timer again.
        const retryExtend = await request(app)
            .post(`/routine-sessions/${sessionId}/extend`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send(extensionPayload);

        assert.equal(retryExtend.status, 200);
        assert.equal(retryExtend.body.session?.timerEndsAt, newDeadline);
        console.log("✅ Duplicate extension does not add extra time.");

        // A stale request with the OLD expected deadline must not overwrite
        // the newer saved deadline.
        const staleExtend = await request(app)
            .post(`/routine-sessions/${sessionId}/extend`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...extensionPayload,
                timerEndsAt: new Date(Date.parse(newDeadline) + 10 * 60_000).toISOString(),
            });

        assert.equal(staleExtend.status, 409);
        assert.equal(staleExtend.body.error?.code, "SESSION_TIMER_CONFLICT");
        console.log("✅ Stale extension cannot overwrite timer changes.");

        const verifyExtension = await request(app)
            .get("/routine-sessions")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(verifyExtension.status, 200);
        const persistedSession = verifyExtension.body.sessions.find(
            (session: { id: string }) => session.id === sessionId,
        );
        assert.equal(persistedSession?.timerEndsAt, newDeadline);
        console.log("✅ Extended timer deadline persists in PostgreSQL.");

        // ------------------------------------------------------------
        // 8. COMPLETE: ONLY AFTER EXTENSION TESTS
        // ------------------------------------------------------------
        const forbiddenComplete = await request(app)
            .post(`/routine-sessions/${sessionId}/complete`)
            .set("Authorization", `Bearer ${tokenB}`)
            .send({ completedAt: new Date().toISOString() });

        assert.equal(forbiddenComplete.status, 404);
        console.log("✅ Account B cannot complete A's session.");

        const completedAt = new Date().toISOString();
        const completeA = await request(app)
            .post(`/routine-sessions/${sessionId}/complete`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ completedAt });

        assert.equal(completeA.status, 200, JSON.stringify(completeA.body));
        assert.equal(completeA.body.session?.status, "COMPLETED");
        assert.equal(completeA.body.session?.completedAt, completedAt);
        assert.equal(completeA.body.session?.timerEndsAt, newDeadline);
        console.log("✅ Account A can complete its session.");

        // Identical duplicate completion preserves the original timestamp.
        const retryComplete = await request(app)
            .post(`/routine-sessions/${sessionId}/complete`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ completedAt });

        assert.equal(retryComplete.status, 200);
        assert.equal(retryComplete.body.session?.completedAt, completedAt);
        console.log("✅ Duplicate completion preserves original time.");

        // Rhythm reads completed session history instead of stored streak totals.
        const historyA = await request(app)
            .get("/routine-sessions")
            .set("Authorization", `Bearer ${tokenA}`);

        assert.equal(historyA.status, 200);
        assert.equal(Array.isArray(historyA.body.sessions), true);
        const savedSession = historyA.body.sessions.find(
            (session: { id: string }) => session.id === sessionId,
        );
        assert.equal(savedSession?.status, "COMPLETED");
        assert.equal(savedSession?.completedAt, completedAt);
        assert.equal(savedSession?.timerEndsAt, newDeadline);
        console.log("✅ Completed session remains in Rhythm history.");

        // Once completed, the session must reject all timer extensions.
        const extendCompleted = await request(app)
            .post(`/routine-sessions/${sessionId}/extend`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send(extensionPayload);

        assert.equal(extendCompleted.status, 409);
        assert.equal(
            extendCompleted.body.error?.code,
            "INVALID_SESSION_TRANSITION",
        );


        console.log("✅ Completed RoutineSession cannot be extended.");
        /**
         * CONCURRENCY TEST:
         *
         * Two requests attempt to start different
         * sessions for the same user simultaneously.
         *
         * PostgreSQL must allow exactly one.
         *
         * We run this after completion so no previous
         * session is still IN_PROGRESS.
         */
        const concurrentStartedAt =
            new Date().toISOString();

        const concurrentPayload = (suffix: string) => ({
            id: `concurrent-${suffix}-${runId}`,
            routineId,
            startedAt: concurrentStartedAt,
        });

        const [firstStart, secondStart] =
            await Promise.all([
                request(app)
                    .post("/routine-sessions")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .send(concurrentPayload("a")),

                request(app)
                    .post("/routine-sessions")
                    .set("Authorization", `Bearer ${tokenA}`)
                    .send(concurrentPayload("b")),
            ]);

        /**
         * We cannot predict which request wins.
         *
         * But exactly one must succeed and
         * exactly one must return a conflict.
         */
        const statuses = [
            firstStart.status,
            secondStart.status,
        ].sort((a, b) => a - b);

        assert.deepEqual(
            statuses,
            [201, 409],
        );

        /**
         * Verify the database actually contains
         * only one active session.
         */
        const activeCount =
            await prisma.routineSession.count({
                where: {
                    userId: userAId!,
                    status: "IN_PROGRESS",
                },
            });

        assert.equal(
            activeCount,
            1,
        );

        console.log(
            "✅ Concurrent starts cannot create multiple active sessions.",
        );

        /**
 * Verify that concurrency protection exists
 * in PostgreSQL, not only in application code.
 */
        const indexes = await prisma.$queryRaw<
            Array<{ indexname: string }>
        >`
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = current_schema()
    AND tablename = 'RoutineSession'
    AND indexname =
      'RoutineSession_one_active_per_user'
`;

        assert.equal(
            indexes.length,
            1,
            "Expected the database-level active-session constraint.",
        );

        console.log(
            "✅ PostgreSQL enforces one active session per user.",
        );

        /**
 * -----------------------------------------
 * ROUTINE SYNC IDEMPOTENCY TEST
 * -----------------------------------------
 */
        const syncRoutineId =
            `sync-routine-${runId}`;

        const syncOperation = {
            operationId: `rsync-${runId}`,
            kind: "CREATE_ROUTINE",

            entityId: syncRoutineId,

            occurredAt: new Date().toISOString(),

            payload: {
                id: syncRoutineId,
                name: "Offline Programming",
                targetSessionsPerWeek: 3,
                preferredMinutes: 30,
                preferredTime: "EVENING",
                context: "COMPUTER",
                createdAt: new Date().toISOString(),
            },
        };

        /**
         * First delivery creates the routine
         * and saves a server receipt.
         */
        const firstSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(syncOperation);

        assert.equal(
            firstSync.status,
            200,
            JSON.stringify(firstSync.body),
        );

        assert.equal(
            firstSync.body.ack?.operationId,
            syncOperation.operationId,
        );

        console.log(
            "✅ First routine sync operation acknowledged.",
        );

        /**
         * Retry the EXACT same logical operation.
         */
        const secondSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(syncOperation);

        assert.equal(secondSync.status, 200);

        assert.deepEqual(
            secondSync.body.ack,
            firstSync.body.ack,
        );

        const routineCount =
            await prisma.lifeRoutine.count({
                where: {
                    id: syncRoutineId,
                    userId: userAId!,
                },
            });

        assert.equal(
            routineCount,
            1,
            "Duplicate delivery must not create another routine.",
        );

        console.log(
            "✅ Identical retry does not create a duplicate.",
        );

        /**
         * Same operationId but altered payload
         * must be rejected.
         */
        const tamperedSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...syncOperation,

                payload: {
                    ...syncOperation.payload,
                    name: "Changed Without New Operation ID",
                },
            });

        assert.equal(tamperedSync.status, 409);

        assert.equal(
            tamperedSync.body.error?.code,
            "OPERATION_ID_REUSED",
        );

        console.log(
            "✅ Operation ID cannot be reused with different data.",
        );

        /**
         * The database should contain exactly
         * one receipt for Account A's operation.
         */
        const receiptCount =
            await prisma.routineSyncReceipt.count({
                where: {
                    userId: userAId!,
                    operationId: syncOperation.operationId,
                },
            });

        assert.equal(receiptCount, 1);

        console.log(
            "✅ Routine sync receipt persisted exactly once.",
        );


        /**
         * -----------------------------------------
         * UPDATE_ROUTINE SYNC TESTS
         * -----------------------------------------
         *
         * Reuse the routine created by our earlier
         * CREATE_ROUTINE sync operation.
         */
        const updateOperation = {
            operationId: `rsync-update-${runId}`,

            kind: "UPDATE_ROUTINE",

            entityId: syncRoutineId,

            occurredAt: new Date().toISOString(),

            payload: {
                name: "Advanced Offline Programming",
                preferredMinutes: 60,
            },
        };

        /**
         * Test 1: Account A can synchronize an update.
         */
        const firstUpdateSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(updateOperation);

        assert.equal(
            firstUpdateSync.status,
            200,
            JSON.stringify(firstUpdateSync.body),
        );

        assert.equal(
            firstUpdateSync.body.ack?.operationId,
            updateOperation.operationId,
        );

        const updatedRoutine =
            await prisma.lifeRoutine.findFirst({
                where: {
                    id: syncRoutineId,
                    userId: userAId!,
                },
            });

        assert.equal(
            updatedRoutine?.name,
            "Advanced Offline Programming",
        );

        assert.equal(
            updatedRoutine?.preferredMinutes,
            60,
        );

        // An omitted field should keep its old value.
        assert.equal(
            updatedRoutine?.targetSessionsPerWeek,
            3,
        );

        console.log(
            "✅ Routine UPDATE operation synchronized.",
        );

        /**
         * Test 2: Repeating the exact operation
         * returns the original acknowledgment.
         */
        const retryUpdateSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(updateOperation);

        assert.equal(
            retryUpdateSync.status,
            200,
        );

        assert.deepEqual(
            retryUpdateSync.body.ack,
            firstUpdateSync.body.ack,
        );

        console.log(
            "✅ Duplicate UPDATE returns original ACK.",
        );

        /**
         * Test 3: Same operation ID with different
         * content must be rejected.
         */
        const tamperedUpdateSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...updateOperation,

                payload: {
                    name: "Tampered Name",
                },
            });

        assert.equal(
            tamperedUpdateSync.status,
            409,
        );

        assert.equal(
            tamperedUpdateSync.body.error?.code,
            "OPERATION_ID_REUSED",
        );

        console.log(
            "✅ UPDATE operation ID cannot be reused.",
        );

        /**
         * Test 4: Account B cannot update
         * Account A's routine.
         *
         * Use a NEW operation ID because this
         * represents a distinct attempted action.
         */
        const forbiddenUpdateSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenB}`)
            .send({
                ...updateOperation,

                operationId: `rsync-forbidden-${runId}`,

                payload: {
                    name: "Unauthorized Name",
                },
            });

        assert.equal(
            forbiddenUpdateSync.status,
            404,
        );

        console.log(
            "✅ Account B cannot sync changes to A's routine.",
        );

        /**
         * Test 5: No unauthorized or tampered
         * request changed the saved routine.
         */
        const verifySyncedRoutine =
            await prisma.lifeRoutine.findFirst({
                where: {
                    id: syncRoutineId,
                    userId: userAId!,
                },
            });

        assert.equal(
            verifySyncedRoutine?.name,
            "Advanced Offline Programming",
        );

        console.log(
            "✅ Rejected sync writes leave routine unchanged.",
        );

        /**
         * Test 6: Exactly one receipt was stored
         * for the successful UPDATE action.
         */
        const updateReceiptCount =
            await prisma.routineSyncReceipt.count({
                where: {
                    userId: userAId!,
                    operationId: updateOperation.operationId,
                },
            });

        assert.equal(
            updateReceiptCount,
            1,
        );

        console.log(
            "✅ UPDATE receipt persisted exactly once.",
        );

        /**
         * -----------------------------------------
         * START_SESSION SYNC TESTS
         * -----------------------------------------
         */

        /**
         * TEST SETUP:
         *
         * The concurrency test intentionally left
         * one session IN_PROGRESS.
         *
         * Finish it before testing a new start.
         */
        const activeBeforeSync =
            await prisma.routineSession.findFirst({
                where: {
                    userId: userAId!,
                    status: "IN_PROGRESS",
                },
            });

        assert.ok(
            activeBeforeSync,
            "Expected an active session from the concurrency test.",
        );

        const finishPrevious = await request(app)
            .post(
                `/routine-sessions/${activeBeforeSync.id}/complete`,
            )
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                completedAt: new Date().toISOString(),
            });

        assert.equal(
            finishPrevious.status,
            200,
            JSON.stringify(finishPrevious.body),
        );

        /**
         * Build one logical START operation.
         *
         * The exact payload must be reused
         * for every retry.
         */
        const syncSessionId =
            `sync-session-${runId}`;

        const syncStartedAt =
            new Date().toISOString();

        const syncTimerEndsAt =
            new Date(
                Date.parse(syncStartedAt) + 30 * 60_000,
            ).toISOString();

        const startSyncOperation = {
            operationId: `rsync-start-${runId}`,

            kind: "START_SESSION",

            entityId: syncSessionId,

            occurredAt: syncStartedAt,

            payload: {
                id: syncSessionId,
                routineId: syncRoutineId,
                startedAt: syncStartedAt,
                timerEndsAt: syncTimerEndsAt,
            },
        };


        /**
         * TEST 1:
         * Account A can synchronize START.
         */
        const firstStartSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(startSyncOperation);

        assert.equal(
            firstStartSync.status,
            200,
            JSON.stringify(firstStartSync.body),
        );

        assert.equal(
            firstStartSync.body.ack?.operationId,
            startSyncOperation.operationId,
        );

        console.log(
            "✅ START_SESSION operation acknowledged.",
        );


        /**
         * TEST 2:
         * PostgreSQL preserved the original
         * offline timestamp and timer deadline.
         */
        const savedSyncSession =
            await prisma.routineSession.findFirst({
                where: {
                    id: syncSessionId,
                    userId: userAId!,
                },
            });

        assert.equal(
            savedSyncSession?.status,
            "IN_PROGRESS",
        );

        assert.equal(
            savedSyncSession?.startedAt.toISOString(),
            syncStartedAt,
        );

        assert.equal(
            savedSyncSession?.timerEndsAt?.toISOString(),
            syncTimerEndsAt,
        );

        console.log(
            "✅ START preserves original session timestamps.",
        );


        /**
         * TEST 3:
         * Retry the EXACT operation.
         *
         * The server should acknowledge it without
         * creating another session.
         */
        const retryStartSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(startSyncOperation);

        assert.equal(
            retryStartSync.status,
            200,
        );

        assert.deepEqual(
            retryStartSync.body.ack,
            firstStartSync.body.ack,
        );

        const sessionCount =
            await prisma.routineSession.count({
                where: {
                    id: syncSessionId,
                    userId: userAId!,
                },
            });

        assert.equal(sessionCount, 1);

        console.log(
            "✅ Duplicate START does not create another session.",
        );


        /**
         * TEST 4:
         * Reusing the same operationId with changed
         * data must fail.
         */
        const tamperedStart = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...startSyncOperation,

                payload: {
                    ...startSyncOperation.payload,

                    timerEndsAt: new Date(
                        Date.parse(syncTimerEndsAt) +
                        15 * 60_000,
                    ).toISOString(),
                },
            });

        assert.equal(
            tamperedStart.status,
            409,
        );

        assert.equal(
            tamperedStart.body.error?.code,
            "OPERATION_ID_REUSED",
        );

        console.log(
            "✅ START operation ID cannot be reused.",
        );


        /**
         * TEST 5:
         * Account B cannot start Account A's routine
         * using the sync endpoint.
         */
        const forbiddenStartSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenB}`)
            .send({
                ...startSyncOperation,

                operationId: `rsync-forbidden-start-${runId}`,

                entityId: `forbidden-start-${runId}`,

                payload: {
                    ...startSyncOperation.payload,
                    id: `forbidden-start-${runId}`,
                },
            });

        assert.equal(
            forbiddenStartSync.status,
            404,
        );

        console.log(
            "✅ Account B cannot sync START for A's routine.",
        );


        /**
         * TEST 6:
         * A second different START cannot create
         * another active session.
         */
        const secondActiveStart = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...startSyncOperation,

                operationId: `rsync-second-start-${runId}`,

                entityId: `second-start-${runId}`,

                payload: {
                    ...startSyncOperation.payload,
                    id: `second-start-${runId}`,
                },
            });

        assert.equal(
            secondActiveStart.status,
            409,
        );

        assert.equal(
            secondActiveStart.body.error?.code,
            "ROUTINE_SESSION_CONFLICT",
        );

        console.log(
            "✅ Sync cannot create two active sessions.",
        );


        /**
         * TEST 7:
         * Exactly one receipt exists for
         * the successful START operation.
         */
        const startReceiptCount =
            await prisma.routineSyncReceipt.count({
                where: {
                    userId: userAId!,
                    operationId: startSyncOperation.operationId,
                },
            });

        assert.equal(startReceiptCount, 1);

        console.log(
            "✅ START receipt persisted exactly once.",
        );


        /**
         * EXTEND_SESSION SYNC TESTS
         *
         * The previous START sync test created
         * syncSessionId as IN_PROGRESS.
         *
         * We can extend that same session.
         */
        const extendOccurredAt =
            new Date().toISOString();

        const syncExtendedEndsAt = new Date(
            Math.max(
                Date.parse(syncTimerEndsAt),
                Date.parse(extendOccurredAt),
            ) + 15 * 60_000,
        ).toISOString();

        const extendSyncOperation = {
            operationId: `rsync-extend-${runId}`,
            kind: "EXTEND_SESSION",
            entityId: syncSessionId,
            occurredAt: extendOccurredAt,

            payload: {
                expectedTimerEndsAt: syncTimerEndsAt,
                timerEndsAt: syncExtendedEndsAt,
            },
        };

        /**
         * Account B must not extend A's session.
         */
        const forbiddenExtendSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenB}`)
            .send(extendSyncOperation);

        assert.equal(forbiddenExtendSync.status, 404);

        console.log(
            "✅ Account B cannot sync EXTEND for A's session.",
        );

        /**
         * First delivery updates the deadline.
         */
        const firstExtendSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(extendSyncOperation);

        assert.equal(
            firstExtendSync.status,
            200,
            JSON.stringify(firstExtendSync.body),
        );

        console.log(
            "✅ EXTEND_SESSION operation acknowledged.",
        );

        /**
         * A retry returns the original ACK.
         */
        const retryExtendSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(extendSyncOperation);

        assert.equal(retryExtendSync.status, 200);

        assert.deepEqual(
            retryExtendSync.body.ack,
            firstExtendSync.body.ack,
        );

        console.log(
            "✅ Duplicate EXTEND does not extend twice.",
        );

        /**
         * Reusing the operation ID with changed
         * data must not be accepted.
         */
        const tamperedExtendSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...extendSyncOperation,
                payload: {
                    ...extendSyncOperation.payload,
                    timerEndsAt: new Date(
                        Date.parse(syncExtendedEndsAt) +
                        5 * 60_000,
                    ).toISOString(),
                },
            });

        assert.equal(tamperedExtendSync.status, 409);

        assert.equal(
            tamperedExtendSync.body.error?.code,
            "OPERATION_ID_REUSED",
        );

        console.log(
            "✅ EXTEND operation ID cannot be reused.",
        );

        /**
         * A different operation based on the OLD
         * deadline cannot overwrite the new one.
         */
        const staleExtendSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...extendSyncOperation,
                operationId: `rsync-stale-extend-${runId}`,
                payload: {
                    ...extendSyncOperation.payload,
                    timerEndsAt: new Date(
                        Date.parse(syncExtendedEndsAt) +
                        10 * 60_000,
                    ).toISOString(),
                },
            });

        assert.equal(staleExtendSync.status, 409);

        assert.equal(
            staleExtendSync.body.error?.code,
            "SESSION_TIMER_CONFLICT",
        );

        console.log(
            "✅ Stale EXTEND cannot overwrite the timer.",
        );

        /**
         * Check the actual database state.
         */
        const extendedSyncSession =
            await prisma.routineSession.findFirst({
                where: {
                    id: syncSessionId,
                    userId: userAId!,
                },
            });

        assert.equal(
            extendedSyncSession?.timerEndsAt?.toISOString(),
            syncExtendedEndsAt,
        );

        const extendReceiptCount =
            await prisma.routineSyncReceipt.count({
                where: {
                    userId: userAId!,
                    operationId: extendSyncOperation.operationId,
                },
            });

        assert.equal(extendReceiptCount, 1);

        console.log(
            "✅ Extended deadline and receipt persisted.",
        );

        /**
         * COMPLETE_SESSION SYNC TESTS
         *
         * We reuse syncSessionId from the earlier
         * START and EXTEND tests.
         *
         * It should still be IN_PROGRESS.
         */
        const syncCompletedAt =
            new Date().toISOString();

        const completeSyncOperation = {
            operationId: `rsync-complete-${runId}`,
            kind: "COMPLETE_SESSION",
            entityId: syncSessionId,
            occurredAt: syncCompletedAt,

            payload: {
                completedAt: syncCompletedAt,
            },
        };

        /**
         * Account B cannot complete A's session.
         */
        const forbiddenCompleteSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenB}`)
            .send(completeSyncOperation);

        assert.equal(forbiddenCompleteSync.status, 404);

        console.log(
            "✅ Account B cannot sync COMPLETE for A's session.",
        );

        /**
         * Completion before the original start
         * must be rejected.
         */
        const invalidCompleteSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...completeSyncOperation,
                operationId: `rsync-invalid-complete-${runId}`,
                payload: {
                    completedAt: new Date(
                        Date.parse(syncStartedAt) - 60_000,
                    ).toISOString(),
                },
            });

        assert.equal(invalidCompleteSync.status, 400);

        assert.equal(
            invalidCompleteSync.body.error?.code,
            "INVALID_COMPLETION_TIME",
        );

        console.log(
            "✅ Completion before Start is rejected.",
        );

        /**
         * First successful completion.
         */
        const firstCompleteSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(completeSyncOperation);

        assert.equal(
            firstCompleteSync.status,
            200,
            JSON.stringify(firstCompleteSync.body),
        );

        assert.equal(
            firstCompleteSync.body.ack?.operationId,
            completeSyncOperation.operationId,
        );

        console.log(
            "✅ COMPLETE_SESSION operation acknowledged.",
        );

        /**
         * Verify PostgreSQL saved the real
         * completion timestamp.
         */
        const completedSyncSession =
            await prisma.routineSession.findFirst({
                where: {
                    id: syncSessionId,
                    userId: userAId!,
                },
            });

        assert.equal(
            completedSyncSession?.status,
            "COMPLETED",
        );

        assert.equal(
            completedSyncSession?.completedAt?.toISOString(),
            syncCompletedAt,
        );

        assert.equal(
            completedSyncSession?.timerEndsAt?.toISOString(),
            syncExtendedEndsAt,
        );

        console.log(
            "✅ Completion time and extended deadline persisted.",
        );

        /**
         * Retrying the same logical operation
         * must return the original ACK.
         */
        const retryCompleteSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send(completeSyncOperation);

        assert.equal(retryCompleteSync.status, 200);

        assert.deepEqual(
            retryCompleteSync.body.ack,
            firstCompleteSync.body.ack,
        );

        console.log(
            "✅ Duplicate COMPLETE returns original ACK.",
        );

        /**
         * The same operation ID cannot be
         * reused with a different completion time.
         */
        const tamperedCompleteSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...completeSyncOperation,
                payload: {
                    completedAt: new Date(
                        Date.parse(syncCompletedAt) + 30_000,
                    ).toISOString(),
                },
            });

        assert.equal(tamperedCompleteSync.status, 409);

        assert.equal(
            tamperedCompleteSync.body.error?.code,
            "OPERATION_ID_REUSED",
        );

        console.log(
            "✅ COMPLETE operation ID cannot be reused.",
        );

        /**
         * A different operation cannot complete
         * an already-completed session.
         */
        const secondCompleteSync = await request(app)
            .post("/routine-sync/operations")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({
                ...completeSyncOperation,
                operationId: `rsync-second-complete-${runId}`,
            });

        assert.equal(secondCompleteSync.status, 409);

        assert.equal(
            secondCompleteSync.body.error?.code,
            "INVALID_SESSION_TRANSITION",
        );

        console.log(
            "✅ Completed session rejects a second completion.",
        );

        /**
         * Verify the successful operation created
         * exactly one receipt.
         */
        const completeReceiptCount =
            await prisma.routineSyncReceipt.count({
                where: {
                    userId: userAId!,
                    operationId: completeSyncOperation.operationId,
                },
            });

        assert.equal(completeReceiptCount, 1);

        console.log(
            "✅ COMPLETE receipt persisted exactly once.",
        );


        console.log("\n🎉 All Routine API security tests passed!");
    } finally {
        // These are test-only accounts. Cascading relations remove their
        // sessions, routines, and RoutineSessions when the users are deleted.
        // Never aim this test at a production database.
        const testUserIds = [userAId, userBId].filter(
            (id): id is string => id !== null,
        );

        try {
            if (testUserIds.length > 0) {
                await prisma.user.deleteMany({
                    where: {
                        id: { in: testUserIds },
                    },
                });
            }
        } finally {
            await prisma.$disconnect();
        }
    }
}

run().catch((error: unknown) => {
    console.error("\n❌ Routine API security test failed:", error);
    process.exitCode = 1;
});
