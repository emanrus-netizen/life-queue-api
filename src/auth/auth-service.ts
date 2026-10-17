import {
    Prisma,
} from "@prisma/client";

import {
    prisma,
} from "../db/prisma.js";


import {
    hashPassword,
    verifyPassword
} from "./password.js";


import {
    createSessionExpiry,
    createSessionToken,
    hashSessionToken,
} from "./session-token.js";

export type RegisterUserInput = {
    email: string;

    password: string;

    displayName?:
    string;
};


export type PublicAuthUser = {
    id: string;

    email: string;

    displayName:
    string | null;
    createdAt:
    Date;
};

export type RegisterUserResult = {
    user: PublicAuthUser,

    /**
     * IMPORTANT:
     *
     * This is the raw session credential.
     *
     * We return it to the client ONCE.
     * PostgreSQL only receives its hash.
     */

    token:
    string;
    expiresAt:
    Date;
}

export class EmailAlreadyExistsError extends Error {
    constructor() {
        super(
            "An account with this email already exists.",
        )
        this.name = "EmailAlreadyExistsError";
    }
}


/**
 * Creates:
 *
 * 1. User
 * 2. Session
 *
 * inside one database transaction.
 *
 * Why a transaction?
 *
 * We do NOT want this:
 *
 * User created ✅
 * Session creation fails ❌
 *
 * leaving a half-finished registration.
 *
 * Either both succeed or neither does.
 */

export async function registerUser(input: RegisterUserInput): Promise<RegisterUserResult> {
    /**
     * This check gives us a friendly error
     * before doing relatively expensive bcrypt work.
     *
     * The database UNIQUE constraint remains the
     * real final protection against race conditions.
     */

    const existingUser = await prisma.user.findUnique({
        where: {
            email: input.email
        },
        select: {
            id: true,
        }
    })

    if (existingUser) {
        throw new EmailAlreadyExistsError()
    }

    const passwordHash = await hashPassword(input.password)

    /**
     * Generate the raw credential outside
     * PostgreSQL.
     */
    const token = createSessionToken()

    const tokenHash = hashSessionToken(token)

    const expiresAt = createSessionExpiry()

    try {
        const result = await prisma.$transaction(
            async (transaction: Prisma.TransactionClient) => {
                const user =
                    await transaction.user.create({
                        data: {
                            email: input.email,
                            displayName: input.displayName ?? null,
                            passwordHash: passwordHash
                        },
                        select: {
                            id: true,
                            email: true,
                            displayName: true,
                            createdAt: true
                        }
                    });

                await transaction.session.create({
                    data: {
                        userId: user.id,
                        tokenHash,
                        expiresAt,
                    }
                });

                return user
            }
        )

        return {
            user: result,
            token,
            expiresAt
        }
    } catch (error) {
        /**
         * The pre-check above is not sufficient
         * by itself.
         *
         * Two registration requests could arrive
         * simultaneously with the same email.
         *
         * PostgreSQL's UNIQUE constraint is the
         * final authority.
         */

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            throw new EmailAlreadyExistsError
        }

        throw error
    }
}
export type LoginUserInput = {
    email: string,
    password: string
}

export type LoginUserResult = {
    user: PublicAuthUser;
    expiresAt: Date;
    token: string;
}


export class InvalidCredentialsError extends Error {
    constructor() {
        super(
            "Email or password is incorrect."
        )

        this.name = "InvalidCredentialsError"
    }
}

/**
 * Authenticate an existing Life Queue user.
 *
 * SECURITY:
 *
 * We intentionally return the same error for:
 *
 * - unknown email
 * - incorrect password
 *
 * This avoids exposing which email addresses
 * are registered.
 */

export async function loginUser(input: LoginUserInput): Promise<LoginUserResult> {
    const user = await prisma.user.findUnique({
        where: {
            email: input.email
        },
        select: {
            id: true,
            passwordHash: true,
            email: true,
            displayName: true,
            createdAt: true
        }
    })

    if (!user) {
        throw new InvalidCredentialsError()
    }

    const passwordMatches = await verifyPassword(input.password, user.passwordHash)

    if (!passwordMatches) {
        throw new InvalidCredentialsError
    }

    /**
   * Successful password verification does NOT
   * mean we reuse an old session.
   *
   * Each successful login creates a fresh,
   * independently revocable session.
   */
    const token = createSessionToken()

    const tokenHash = hashSessionToken(token)

    const expiresAt = createSessionExpiry()

    await prisma.session.create({
        data: {
            userId: user.id,
            tokenHash,
            expiresAt

        }
    })

    return {
        user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            createdAt: user.createdAt
        },
        token,
        expiresAt,
    }
}