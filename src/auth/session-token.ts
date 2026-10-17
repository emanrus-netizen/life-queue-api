import {
    createHash,
    randomBytes,
} from "node:crypto";



/**
 * 32 random bytes = 256 bits of randomness.
 *
 * This makes session tokens practically
 * impossible to guess.
 */

const SESSION_TOKEN_BYTES = 32


/**
 * Sessions live for 30 days for now.
 *
 * Later we may make this configurable through
 * environment variables or introduce refresh
 * behavior.
 */

const SESSION_TOKEN_EXPIRATION_DAYS = 30


/**
 * Generate the SECRET given to the client.
 *
 * Example:
 *
 * client receives:
 *
 * "75fb...random..."
 *
 * Only the client gets this raw value.
 */

export function createSessionToken() {
    return randomBytes(SESSION_TOKEN_BYTES).toString("hex")
}



/**
 * Hash a raw session token before storing it
 * in PostgreSQL.
 *
 * SECURITY REASON:
 *
 * If our Session table is ever leaked,
 * an attacker should not immediately obtain
 * credentials they can send to our API.
 *
 *
 * Client:
 *
 * raw token
 *     │
 *     ▼
 * Authorization: Bearer <raw-token>
 *
 *
 * Server:
 *
 * raw token
 *     │
 *     ▼
 * SHA-256
 *     │
 *     ▼
 * compare with Session.tokenHash
 */

export function hashSessionToken(token: string) {
    return createHash("sha256").update(
        token, "utf8"
    ).digest("hex")
}


/**
 * Calculate when a newly-created session
 * expires.
 */

export function createSessionExpiry(
    now = new Date()
) {
    const expiresAt = new Date(now)

    expiresAt.setDate(
        expiresAt.getDate() + SESSION_TOKEN_EXPIRATION_DAYS
    )

    return expiresAt
}


/**
 * Centralize expiry checking so routes don't
 * reinvent this logic differently.
 */

export function isSessionExpired(
    expiresAt: Date,
    now = new Date()
) {
    return (expiresAt.getTime() <= now.getTime())
}