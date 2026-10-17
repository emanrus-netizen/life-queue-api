import {
    hashPassword,
    verifyPassword,
} from "./password.js";

import {
    createSessionExpiry,
    createSessionToken,
    hashSessionToken,
    isSessionExpired,
} from "./session-token.js";

import {
    normalizeEmail,
    registerInputSchema,
} from "./auth-validation.js";



function assertEqual<T>(
    actual: T,
    expected: T,
    message: string
) {
    if (actual !== expected) {
        throw new Error(
            [
                `❌ ${message}`,
                `Expected: ${String(expected)}`,
                `Recieved: ${String(actual)}`,

            ].join("\n")
        )
    }
    console.log(`✅ ${message}`)
}

function assert(
    condition: boolean,
    message: string
) {
    if (!condition) {
        throw new Error(`❌ ${message}`,)
    }
    console.log(
        `✅ ${message}`,
    );
}


async function run() {
    console.log(
        "🧪 Running Life Queue auth security tests...",
    );

    /*
     * EMAIL
     */

    assertEqual(normalizeEmail("  Emmanuel@Example.COM "), "emmanuel@example.com", "Email normalization trims and lowercases.",)

    const validRegistration = registerInputSchema.safeParse({
        email: "email@example.com",
        password: "strong-password",
        displayName: "Emmanuel"
    })

    assert(
        validRegistration.success,
        "Valid registration input is accepted.",
    )

    const shortPassword = registerInputSchema.safeParse({
        email: "eman@example.com",
        password: "123"
    })

    assert(!shortPassword.success, "Short registration passwords are rejected.",)

    /*
  * PASSWORD
  */

    const password =
        "life-queue-test-password";

    const passwordHash = await hashPassword(password)

    assert(
        passwordHash !== password,
        "Raw password is not stored directly.",
    )

    assert(
        await verifyPassword(
            password, passwordHash
        ),
        "Correct password verifies.",
    )

    assert(
        !(
            await verifyPassword(
                "wrong-password",
                passwordHash
            )
        ),
        "Incorrect password is rejected.",
    )

    /*
    * SESSION TOKENS
    */

    const tokenA = createSessionToken()

    const tokenB = createSessionToken()

    assertEqual(
        tokenA.length,
        64,
        "Session token contains 32 random bytes encoded as hex.",
    )

    const tokenHash = hashSessionToken(
        tokenA
    )

    assert(
        tokenHash !== tokenA,
        "Database session hash differs from raw token.",
    )

    assertEqual(
        tokenHash,
        hashSessionToken(tokenA),
        "Database session hash differs from raw token.",
    )

    /*
    * EXPIRY
    */

    const fixedNow = new Date(
        2026,
        9,
        3,
        12,
        0,
        0,
    );

    const expiresAt = createSessionExpiry(fixedNow)

    assert(
        expiresAt.getTime() >
        fixedNow.getTime(),
        "New session expires in the future.",
    );

    assert(
        !isSessionExpired(
            expiresAt,
            fixedNow,
        ),
        "Fresh session is not expired.",
    );

    const afterExpiry =
        new Date(
            expiresAt.getTime() +
            1,
        );
    assert(
        isSessionExpired(
            expiresAt,
            afterExpiry,
        ),
        "Session is expired after its expiry timestamp.",
    );

    console.log(
        "🔥 All Life Queue auth security tests passed!",
    );
}


run().catch(
    error => {
        console.error(
            error,
        );

        process.exitCode =
            1;
    },
);