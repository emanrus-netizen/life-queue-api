import type {
    PublicAuthUser
} from "../auth/auth-service";

declare global {
    namespace Express {
        interface Request {
            auth?: {
                /**
                * The authenticated Life Queue user.
                *
                * This identity came from a verified
                * server-side Session record.
                *
                * It did NOT come from request.body.
                */
                user: PublicAuthUser;


                /**
                 * We keep the session ID too because
                 * logout will need to revoke exactly
                 * this session.
                 */

                sessionId: string;
            }
        }
    }
}

export { };
