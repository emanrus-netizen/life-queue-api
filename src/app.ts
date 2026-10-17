import cors from "cors";

import express, { ErrorRequestHandler } from "express";

import {
    authRouter
} from "./auth/auth-router";

import {
    queueItemRouter
} from "./queue/queue-item-router";
import {
    routineRouter,
} from "./routine/routine-router";

import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import {
    prisma
} from "./db/prisma";
import {
    queueSyncRouter,
} from "./queue/queue-sync-router";
import {
    routineSessionRouter,
} from "./routine/routine-session-router";

import {
    routineSyncRouter,
} from "./routine/routine-sync-router";
import {
    userScheduleRouter,
} from "./schedule/user-schedule-router";

/**
 * Build the Express application separately
 * from starting the HTTP server.
 *
 * Why?
 *
 * Production:
 *
 * server.ts
 *    ↓
 * app.listen(...)
 *
 * Tests:
 *
 * supertest(app)
 *
 * This lets automated tests exercise the real
 * middleware/routes without opening port 4000.
 */

export const app = express();

/**
 * 1. Remove framework identification.
 */
app.disable("x-powered-by");

/**
 * 2. Configure reverse proxy trust.
 *
 * Set TRUST_PROXY_HOPS only after verifying
 * the production hosting topology.
 *
 * Local development defaults to no trusted proxy.
 */
const configuredProxyHops =
    process.env.TRUST_PROXY_HOPS;

if (configuredProxyHops !== undefined) {
    const hops = Number(configuredProxyHops);

    if (
        !Number.isInteger(hops) ||
        hops < 0 ||
        hops > 3
    ) {
        throw new Error(
            "TRUST_PROXY_HOPS must be an integer from 0 to 3.",
        );
    }

    app.set("trust proxy", hops);
}

/**
 * 3. Apply HTTP security headers.
 */
app.use(helmet());

/**
 * 4. Browser CORS allowlist.
 *
 * Native mobile clients normally send
 * requests without a browser Origin header.
 *
 * CORS is not an authentication mechanism.
 */
const allowedOrigins = new Set(
    (process.env.CORS_ORIGINS ?? "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean),
);

app.use(
    cors({
        origin(origin, callback) {
            if (!origin) {
                callback(null, false);
                return;
            }

            callback(
                null,
                allowedOrigins.has(origin),
            );
        },

        methods: [
            "GET",
            "POST",
            "PATCH",
            "PUT",
            "DELETE",
            "OPTIONS",
        ],

        allowedHeaders: [
            "Content-Type",
            "Authorization",
        ],
    }),
);

/**
 * 5. Explicit request body limit.
 *
 * Express already defaults to approximately
 * 100 KB, so this preserves that behavior.
 */
app.use(
    express.json({
        limit: "100kb",
    }),
);

/**
 * 6. Basic IP-based rate limiter for
 * application API endpoints.
 *
 * Authentication endpoints keep their
 * stricter dedicated rate limits.
 */
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 240,

    standardHeaders: "draft-7",
    legacyHeaders: false,

    message: {
        error: {
            code: "RATE_LIMITED",
            message: "Too many requests. Try again shortly.",
        },
    },
});

app.use(
    [
        "/queue-items",
        "/user-schedule",
        "/routines",
        "/routine-sessions",
        "/routine-sync",
        "/queue-sync",
    ],
    apiLimiter,
);

app.use(
    "/auth",
    authRouter
)

app.use(
    "/queue-items", queueItemRouter
);
app.use("/user-schedule", userScheduleRouter);
app.use("/routines", routineRouter);
app.use(
    "/routine-sessions",
    routineSessionRouter,
);

app.use("/routine-sync", routineSyncRouter);

app.get("/health",
    (_request, response) => {
        response.status(200).json({
            status: "ok",
            service: "life-queue-api"
        });
    }
);
app.use(
    "/queue-sync",
    queueSyncRouter,
);

app.get(
    "/health/database",
    async (_request, response) => {
        try {
            await prisma.$queryRaw`Select 1`;

            response.status(200).json({
                status: "ok",
                database: "connected"
            })
        } catch (error) {
            console.error(
                "Database health check failed.",
                error
            );

            response.status(503).json({
                status: "error",
                database: "unavailable"
            });

        }
    }
);


/**
 * Return predictable JSON for errors.
 *
 * Never return internal error details
 * to production clients.
 */
const apiErrorHandler: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    _next,
) => {
    const errorType =
        error &&
            typeof error === "object" &&
            "type" in error
            ? error.type
            : null;

    if (errorType === "entity.too.large") {
        response.status(413).json({
            error: {
                code: "PAYLOAD_TOO_LARGE",
                message: "Request body is too large.",
            },
        });
        return;
    }

    if (errorType === "entity.parse.failed") {
        response.status(400).json({
            error: {
                code: "INVALID_JSON",
                message: "Invalid JSON request body.",
            },
        });
        return;
    }

    if (process.env.NODE_ENV !== "production") {
        console.error("Unhandled API error:", error);
    } else {
        console.error("Unhandled API request failure.");
    }

    response.status(500).json({
        error: {
            code: "INTERNAL_ERROR",
            message: "Something went wrong.",
        },
    });
};

app.use(apiErrorHandler);
