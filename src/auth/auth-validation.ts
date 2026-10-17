import {
    z,
} from "zod"



/**
 * Input validation belongs at the API boundary.
 *
 * PostgreSQL constraints protect the database,
 * but they should not be our first line of
 * validation.
 */

export const registerInputSchema = z.object({
    email: z.string().trim().email("Enter a valid email address.")
        .transform(
            value => normalizeEmail(
                value
            )
        ),
    password: z.string().min(8, "Password must be at least 8 characters.").max(128, "Password too long."),
    displayName: z.string().trim().min(1, "Display name cannot be empty.",).max(80, "Display name is too long.").optional(),

})

export const loginInputSchema = z.object({
    email:
        z
            .string()
            .trim()
            .email(
                "Enter a valid email address.",
            )
            .transform(
                value =>
                    normalizeEmail(
                        value,
                    ),
            ),
    password:
        z
            .string()
            .min(
                1,
                "Password is required.",
            ),
})


/**
 * Email identity should be normalized before
 * it reaches Prisma.
 *
 * Without normalization:
 *
 * Emmanuel@example.com
 *
 * and:
 *
 * emmanuel@example.com
 *
 * could behave like separate identities in
 * some database configurations.
 */

export function normalizeEmail(email: string) {
    return email.trim().toLowerCase()
}

