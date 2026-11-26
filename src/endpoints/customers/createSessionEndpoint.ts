import { addDataAndFileToRequest, Endpoint } from 'payload';
// Internal utilities – error helpers and typed response wrapper
import { getApiError, ResponseError } from '@/utils/common';
// Middleware that validates the JWT and attaches req.user + req.context.tenantId
import { customEndpointAuth } from '@/middleware/auth/customEndpoint';
import { ApiResponseErrorType, IApiResponse } from '@/types/common';
import { createLogger } from '@/services/logger/LoggerService';
import { HttpStatus } from '@/types/common';

export type CustomerSessionField = 'uploadAgentSession' | 'onboardingChatSession';

/**
 * Factory function that creates a reusable POST endpoint for storing
 * a session ID on the authenticated customer's document.
 *
 * Used for both the AI upload-agent widget and the onboarding chat widget.
 */
export const createSessionEndpoint = (
  path: string,
  field: CustomerSessionField,
  loggerName: string,
): Endpoint => {
  const logger = createLogger(loggerName);

  return {
    path,
    method: 'post',
    handler: customEndpointAuth(async (req) => {
      const tenantId = req.context.tenantId as string;

      // 1. Parse multipart/JSON body
      try {
        await addDataAndFileToRequest(req);
      } catch (err) {
        logger.error(`<${tenantId}> Invalid request body or file`, { error: err });
        return Response.json(
          {
            success: false,
            status: HttpStatus.BAD_REQUEST,
            error: getApiError(ApiResponseErrorType.BAD_REQUEST),
          } as IApiResponse<never>,
          { status: HttpStatus.BAD_REQUEST },
        );
      }

      // 2. Business logic
      try {
        const user = req.user!;

        // Guard: only customers may call this endpoint
        if (user.collection !== 'customers') {
          logger.warn(`<${tenantId}> Forbidden: user collection is "${user.collection}", expected "customers"`);
          return ResponseError.forbidden();
        }

        const { sessionId } = req.data || {};

        // Validate sessionId
        if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
          logger.warn(`<${tenantId}> Missing or invalid sessionId in request body`);
          return Response.json(
            { error: 'Valid sessionId required' },
            { status: HttpStatus.BAD_REQUEST },
          );
        }

        const trimmedSessionId = sessionId.trim();

        // Persist the session ID on the customer document
        await req.payload.update({
          collection: 'customers',
          id: user.id,
          data: {
            [field]: trimmedSessionId,
          },
          overrideAccess: true,
        });

        logger.info(`<${tenantId}> Updated ${field} for customer ${user.id}`);
        return Response.json({ success: true, [field]: trimmedSessionId });
      } catch (error: unknown) {
        logger.error(`<${tenantId}> Error updating ${field}`, { error });
        return ResponseError.internalServerError();
      }
    }),
  };
};

// Concrete endpoint instances created from the factory
export const postUploadAgentSession = createSessionEndpoint(
  '/upload-agent-session',
  'uploadAgentSession',
  'PostUploadAgentSession',
);

export const postOnboardingChatSession = createSessionEndpoint(
  '/onboarding-chat-session',
  'onboardingChatSession',
  'PostOnboardingChatSession',
);
