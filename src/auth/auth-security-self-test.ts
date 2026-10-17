import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { app } from "../app";
import { prisma } from "../db/prisma";

/**
 * Life Queue authentication security self-test.
 *
 * Run from the BACKEND root (life-queue-api):
 *   $env:LIFE_QUEUE_AUTH_TEST_DB = "YES"   # PowerShell, after verifying DATABASE_URL
 *   npx tsx src/auth/auth-security-self-test.ts
 *
 * IMPORTANT:
 * - Use a dedicated DEVELOPMENT / TEST PostgreSQL database, NEVER production.
 * - Run this as a standalone process. Express rate-limit's memory counters are
 *   per process and per client IP. Other suites must not consume this budget.
 * - Assumes authRouter has registerLimiter = 3/hour/IP and
 *   loginLimiter = 5/15-min/IP, both applied BEFORE route handlers.
 * - Does not mock authentication, Prisma, or PostgreSQL.
 * - Deletes only the randomly named test account created by this script.
 */

const API = "/auth";

function assertNoPrivateUserFields(
  user: unknown,
  context: string,
): void {
  assert.ok(user && typeof user === "object", `${context}: missing user`);

  const value = user as Record<string, unknown>;
  for (const field of ["password", "passwordHash", "token", "tokenHash"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(value, field),
      false,
      `${context}: user response exposes ${field}`,
    );
  }
}

function readToken(body: unknown, context: string): string {
  const value = body as {
    session?: { token?: unknown; expiresAt?: unknown };
  };

  assert.equal(
    typeof value.session?.token,
    "string",
    `${context}: session token missing`,
  );
  assert.ok(
    (value.session!.token as string).length > 0,
    `${context}: session token empty`,
  );

  // The credential belongs in the session response, not the public user shape.
  assert.equal(
    typeof value.session?.expiresAt,
    "string",
    `${context}: session expiry missing`,
  );
  assert.ok(
    Number.isFinite(Date.parse(value.session!.expiresAt as string)),
    `${context}: session expiry invalid`,
  );

  return value.session!.token as string;
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

async function run(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run auth security tests in production.");
  }
  if (process.env.LIFE_QUEUE_AUTH_TEST_DB !== "YES") {
    throw new Error(
      "Confirm a development/test DATABASE_URL, then set LIFE_QUEUE_AUTH_TEST_DB=YES for this run.",
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required: point it to a TEST database.");
  }

  const runId = randomUUID();
  const email = `auth-security-${runId}@example.com`;
  const password = "QueueTest123!";
  let userId: string | null = null;

  console.log("🧪 Running Life Queue auth security tests...");
  console.log("⚠️  Make sure DATABASE_URL points to a development/test database.");

  try {
    // 1. Authentication must be required on protected routes.
    const anonymousMe = await request(app).get(`${API}/me`);
    assert.equal(anonymousMe.status, 401);
    assert.equal(anonymousMe.body.error?.code, "UNAUTHORIZED");

    const anonymousLogout = await request(app).post(`${API}/logout`);
    assert.equal(anonymousLogout.status, 401);

    const fabricatedToken = await request(app)
      .get(`${API}/me`)
      .set("Authorization", bearer("definitely-not-a-real-session-token"));
    assert.equal(fabricatedToken.status, 401);
    console.log("✅ Protected endpoints reject anonymous/invalid sessions.");

    // 2. Registration attempts 1, 2, and 3 consume the configured budget.
    // Malformed input should be rejected by Zod, but still count toward limits.
    const invalidRegister = await request(app)
      .post(`${API}/register`)
      .send({});
    assert.equal(invalidRegister.status, 400);
    assert.equal(invalidRegister.body.error?.code, "INVALID_INPUT");
    console.log("✅ Invalid registration is rejected.");

    const registered = await request(app)
      .post(`${API}/register`)
      .send({ email, password, displayName: "Auth Security Test" });

    assert.equal(
      registered.status,
      201,
      `Registration expected 201, got ${registered.status} (${registered.body.error?.code ?? "no error code"}).`,
    );
    userId = registered.body.user?.id ?? null;
    assert.equal(typeof userId, "string");
    assert.equal(registered.body.user.email, email);
    assertNoPrivateUserFields(registered.body.user, "Registration");
    const registrationToken = readToken(registered.body, "Registration");
    console.log("✅ Registration returns safe user fields and a session.");

    const duplicate = await request(app)
      .post(`${API}/register`)
      .send({ email, password, displayName: "Duplicate" });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error?.code, "EMAIL_ALREADY_EXISTS");
    console.log("✅ Duplicate email registration is rejected.");

    // Fourth request from the same IP must be rate-limited before validation.
    const blockedRegister = await request(app)
      .post(`${API}/register`)
      .send({});
    assert.equal(blockedRegister.status, 429);
    assert.equal(blockedRegister.body.error?.code, "RATE_LIMITED");
    console.log("✅ Registration limiter blocks request 4 (3/hour/IP).");

    // 3. Login attempts 1 through 5 consume its independent budget.
    const invalidLogin = await request(app)
      .post(`${API}/login`)
      .send({});
    assert.equal(invalidLogin.status, 400);
    assert.equal(invalidLogin.body.error?.code, "INVALID_INPUT");

    const wrongPassword = await request(app)
      .post(`${API}/login`)
      .send({ email, password: "WrongPassword123!" });
    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.error?.code, "INVALID_CREDENTIALS");
    console.log("✅ Invalid login payload and incorrect credentials are rejected.");

    const login1 = await request(app)
      .post(`${API}/login`)
      .send({ email, password });
    assert.equal(login1.status, 200);
    assertNoPrivateUserFields(login1.body.user, "Login");
    const loginToken1 = readToken(login1.body, "Login 1");

    const login2 = await request(app)
      .post(`${API}/login`)
      .send({ email, password });
    assert.equal(login2.status, 200);
    const loginToken2 = readToken(login2.body, "Login 2");

    assert.notEqual(loginToken1, loginToken2);
    assert.notEqual(registrationToken, loginToken1);
    assert.notEqual(registrationToken, loginToken2);

    const fifthLogin = await request(app)
      .post(`${API}/login`)
      .send({ email, password: "WrongPassword123!" });
    assert.equal(fifthLogin.status, 401);

    const blockedLogin = await request(app)
      .post(`${API}/login`)
      .send({ email, password });
    assert.equal(blockedLogin.status, 429);
    assert.equal(blockedLogin.body.error?.code, "RATE_LIMITED");
    console.log("✅ Login limiter blocks request 6 (5/15min/IP).");

    // 4. Issued credentials must work on /me, and public responses stay safe.
    for (const token of [registrationToken, loginToken1, loginToken2]) {
      const me = await request(app)
        .get(`${API}/me`)
        .set("Authorization", bearer(token));
      assert.equal(me.status, 200);
      assert.equal(me.body.user?.id, userId);
      assertNoPrivateUserFields(me.body.user, "/auth/me");
    }
    console.log("✅ All active sessions can read only their authenticated identity.");

    // 5. DB must contain token hashes, not raw bearer credentials.
    // This relies on the tokenHash field from Life Queue's Prisma Session model.
    const storedSessions = await prisma.session.findMany({
      where: { userId: userId! },
      select: { tokenHash: true },
    });
    assert.equal(storedSessions.length, 3);
    for (const stored of storedSessions) {
      for (const rawToken of [registrationToken, loginToken1, loginToken2]) {
        assert.notEqual(stored.tokenHash, rawToken);
      }
      assert.ok(stored.tokenHash.length > 0);
    }
    console.log("✅ Session records do not store raw bearer tokens.");

    // 6. Logout must revoke ONLY the current session; other sessions survive.
    const logout = await request(app)
      .post(`${API}/logout`)
      .set("Authorization", bearer(registrationToken));
    assert.equal(logout.status, 204);

    const revoked = await request(app)
      .get(`${API}/me`)
      .set("Authorization", bearer(registrationToken));
    assert.equal(revoked.status, 401);

    const stillActive = await request(app)
      .get(`${API}/me`)
      .set("Authorization", bearer(loginToken1));
    assert.equal(stillActive.status, 200);

    const anotherStillActive = await request(app)
      .get(`${API}/me`)
      .set("Authorization", bearer(loginToken2));
    assert.equal(anotherStillActive.status, 200);
    console.log("✅ Logout revokes only the current session.");

    const repeatedLogout = await request(app)
      .post(`${API}/logout`)
      .set("Authorization", bearer(registrationToken));
    assert.equal(repeatedLogout.status, 401);
    console.log("✅ Revoked tokens cannot log out again or access /me.");

    console.log("\n🎉 All Life Queue auth security tests passed!");
  } finally {
    // Only delete this run's randomly named user, even if an assertion fails.
    // Never run this test against a production database.
    try {
      await prisma.user.deleteMany({ where: { email } });
    } finally {
      await prisma.$disconnect();
    }
  }
}

run().catch((error: unknown) => {
  // Never print request passwords or bearer tokens in assertion messages.
  console.error("\n❌ Life Queue auth security test failed:", error);
  process.exitCode = 1;
});
