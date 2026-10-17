import type {
    NextFunction,
    Request,
    Response,
} from "express";

import {
    prisma
} from "../db/prisma";

import {
    hashSessionToken, isSessionExpired
} from "./session-token";



/**
 * Protect an API route by requiring a valid
 * Life Queue session.
 *
 * SECURITY:
 *
 * The client sends only the raw session token.
 *
 * We NEVER accept:
 *
 * {
 *   "userId": "trust-me"
 * }
 *
 * as proof of identity.
 */

export async function requireAuth(
    request: Request,
    response: Response,
    next: NextFunction
) {
    /**
     * Expected header:
     *
     * Authorization: Bearer abc123...
     */

    const authorization = request.headers.authorization

    if (
        !authorization
    ) {
        sendUnauthorized(
            response,
        );

        return;
    }
    const [
        scheme,
        token
    ] = authorization.split(" ")

    if (scheme !== "Bearer" || !token) {
        sendUnauthorized(
            response
        );

        return;
    }

    /**
     * PostgreSQL contains only the token hash.
     *
     * So hash the presented token before lookup.
     */

    const tokenHash = hashSessionToken(
        token
    );

    try {
        const session = await prisma.session.findUnique({
            where: ({
                tokenHash
            }),
            select: {
                id: true,
                expiresAt: true,

                user: {
                    select: {
                        id: true,
                        email: true,
                        displayName: true,
                        createdAt: true
                    }
                }
            }
        });

        if (!session) {
            sendUnauthorized(
                response
            )
            return;
        }

        /**
         * A token can exist in the database but
         * still no longer be valid.
         */

        if (isSessionExpired(session.expiresAt)) {
            await prisma.session.delete({
                where: {
                    id: session.id
                }
            });

            sendUnauthorized(
                response
            );
            return;
        }

        /**
        * From this point onward, downstream routes
        * have a VERIFIED identity.
        */
        request.auth = {
            user:
                session.user,

            sessionId:
                session.id,
        };


        next();
    } catch (error) {
        console.error(
            "Authentication middleware failed:",
            error,
        );


        response.status(
            500,
        ).json({
            error: {
                code:
                    "INTERNAL_ERROR",

                message:
                    "Unable to authenticate request.",
            },
        });
    }
}


/**
 * Deliberately use the same public response for:
 *
 * - no token
 * - malformed token
 * - unknown token
 * - expired token
 *
 * We don't need to reveal which part failed.
 */

function sendUnauthorized(
    response:
        Response,
) {
    response.status(
        401,
    ).json({
        error: {
            code:
                "UNAUTHORIZED",

            message:
                "Authentication is required.",
        },
    });
}

