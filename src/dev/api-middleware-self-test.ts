
import "dotenv/config";

import assert from "node:assert/strict";
import request from "supertest";

import { app } from "../app.js";

async function run() {
  console.log(
    "Running Life Queue middleware security tests...",
  );

  // TEST 1: Security headers
  const health = await request(app)
    .get("/health");

  assert.equal(health.status, 200);

  assert.equal(
    health.headers["x-content-type-options"],
    "nosniff",
  );

  assert.equal(
    health.headers["x-powered-by"],
    undefined,
  );

  console.log("✅ Security headers configured.");

  // TEST 2: Oversized JSON
  const oversized = await request(app)
    .post("/auth/login")
    .send({
      email: "test@example.com",
      password: "x".repeat(150_000),
    });

  assert.equal(oversized.status, 413);

  assert.equal(
    oversized.body.error?.code,
    "PAYLOAD_TOO_LARGE",
  );

  console.log("✅ Oversized JSON rejected.");

  // TEST 3: Malformed JSON
  const malformed = await request(app)
    .post("/auth/login")
    .set("Content-Type", "application/json")
    .send('{"email":');

  assert.equal(malformed.status, 400);

  assert.equal(
    malformed.body.error?.code,
    "INVALID_JSON",
  );

  console.log("✅ Malformed JSON rejected.");

  // TEST 4: Unapproved browser origin
  const disallowedOrigin = await request(app)
    .get("/health")
    .set("Origin", "https://unapproved.example");

  assert.equal(disallowedOrigin.status, 200);

  assert.equal(
    disallowedOrigin.headers[
      "access-control-allow-origin"
    ],
    undefined,
  );

  console.log("✅ Unapproved browser origin not allowed.");

  console.log(
    "🎉 API middleware security tests passed!",
  );
}

run().catch(error => {
  console.error("Security test failed:", error);
  process.exitCode = 1;
});
