import { getCompanyOwnerCustomerId } from '@/services/rbac';
import { Company, Customer } from '@/payload-types';
import { ApiResponseErrorType, HttpStatus, IApiResponse } from '@/types/common';
import { extractId, getApiError, getCompanyMembershipIds } from '@/utils/common';
import { Endpoint } from 'payload';
import { AccountType } from '@/types/auth';
import { getRbacEnrichmentForMe } from '@/services/rbac/checkPermission';
import { customEndpointAuth } from '@/middleware/auth';
import { createLogger } from '@/services/logger/LoggerService';
import { getCompanySystemApiKey } from '@/services/akm';

const logger = createLogger('GetMe');

/**
 * GET /api/companies/me
 *
 * Returns the authenticated customer's full profile enriched with:
 *  - their primary company data (sensitive fields excluded via `populate`)
 *  - RBAC permissions (role, preset, isOwner, permission list)
 *  - active AI session IDs for embedded chat widgets
 *  - owner contact email (shown when the company was deleted and the caller is not the owner)
 */
export const getMe: Endpoint = {
  path: '/me',
  method: 'get',
  handler: customEndpointAuth(async (req) => {
    const { payload } = req;
    try {
      // Fetch the authenticated customer; apply access control, exclude sensitive company fields
      const customerQuery = await payload.find({
        collection: 'customers',
        where: { id: { equals: req.user.id } },
        overrideAccess: false,   // enforce collection-level access rules
        user: req.user,
        populate: {
          companies: {
            phone: false,          // strip PII / internal fields
            paymentStatus: false,
            general: {
              employees: false,
            },
            knowledgeBase: false,
          },
        },
        pagination: false,
        limit: 1,
        depth: 1,
      });

      const {
        id,
        company,
        companyMemberships,
        role,
        email,
        visitedSections,
        uploadAgentSession,
        onboardingChatSession,
      } = customerQuery.docs[0];

      const companyId  = extractId(company) || '';
      const customerId = id;
      const ownCompanyId = getCompanyMembershipIds(companyMemberships)[0] || '';

      // Load the tenant's system API key (non-fatal if unavailable)
      let systemApiKey: string | null = null;
      try {
        systemApiKey = await getCompanySystemApiKey(payload, companyId);
      } catch (error) {
        logger.warn(`<${companyId}> Failed to load system API key for /me`, { error });
      }

      // Build RBAC enrichment (permissions, preset slug, ownership flag)
      const rbac = await getRbacEnrichmentForMe(
        payload,
        customerId,
        companyId,
        customerQuery.docs[0] as Customer,
      );

      // If the company was soft-deleted and the caller is not the owner,
      // expose the owner's email so they can contact them.
      let ownerEmail = null;
      if (company && (company as Company).deleted && !rbac.isCompanyOwner) {
        const ownerId = await getCompanyOwnerCustomerId(payload, companyId);
        if (ownerId) {
          const ownerDoc = await payload.findByID({
            collection: 'customers',
            id: ownerId,
            depth: 0,
          });
          ownerEmail = (ownerDoc as Customer).email;
        }
      }

      logger.info(`<${companyId}> User profile retrieved successfully`);
      return Response.json(
        {
          ...company as Company,
          customerId,
          email,
          role: role || AccountType.BUSINESS,
          isDemoCompany: !!(company as Company)?.isDemo,
          visitedSections,
          systemApiKey,
          uploadAgentSession:    uploadAgentSession    ?? null,
          onboardingChatSession: onboardingChatSession ?? null,
          ownerEmail,
          rbac: {
            staffRoleName:  rbac.staffRoleName,
            presetSlug:     rbac.presetSlug,
            isCompanyOwner: rbac.isCompanyOwner,
            permissions:    rbac.permissions,
          },
        },
        { status: 200 },
      );
    } catch (error) {
      logger.error('Error get companies me', { error });
      return Response.json(
        {
          success: false,
          status: HttpStatus.INTERNAL_SERVER_ERROR,
          error: getApiError(ApiResponseErrorType.INTERNAL_SERVER_ERROR),
        } as IApiResponse,
        { status: HttpStatus.INTERNAL_SERVER_ERROR },
      );
    }
  }),
};
