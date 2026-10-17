import bcrypt from "bcryptjs"



/**
 * bcrypt work factor.
 *
 * Higher values make password hashing slower.
 *
 * That is intentional:
 *
 * If our database were ever leaked,
 * attackers should not be able to test millions
 * of password guesses cheaply.
 */

const PASSWORD_CONST = 12

/**
 * Converts a raw password into a one-way hash.
 *
 * Example:
 *
 * "my-secret-password"
 *
 * becomes something like:
 *
 * "$2b$12$..."
 *
 * We store ONLY the hash in PostgreSQL.
 */

export async function hashPassword(password: string) {
    return bcrypt.hash(password, PASSWORD_CONST)
}

/**
 * Checks a password during login.
 *
 * IMPORTANT:
 *
 * We do NOT:
 *
 * hash(password) === storedHash
 *
 * because bcrypt uses a random salt.
 *
 * bcrypt.compare() reads the salt and cost
 * information from the stored hash and safely
 * performs the comparison for us.
 */

export async function verifyPassword(
    password: string,
    passwordHash: string
) {
    return bcrypt.compare(password, passwordHash)
}


