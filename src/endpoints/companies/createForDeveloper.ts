import { AccountType, IUserData } from '@/types/auth';
import { ApiResponseErrorType, HttpStatus, IApiResponse } from '@/types/common';
import { getApiError, ResponseError } from '@/utils/common';
import { Endpoint, PayloadRequest } from 'payload';
import { addDataAndFileToRequest } from 'payload';
import { dataStorageService } from '@/services/data-storage';
import { ONBOARDING_TRIGGERS } from '@/types/common';
import { jwtService } from '@/services/auth';
import { createLogger } from '@/services/logger/LoggerService';
import { campaignsService, employeesService } from '@/services/employees';
import {
  applySystemApiKeyToPresets,
  ensureCompanySystemApiKey,
} from '@/services/akm';
import { ensureCustomerMembershipForCompany } from '@/services/rbac/checkPermission';
import { scrapeService } from '@/services/scrape/index';

const logger = createLogger('CreateForDeveloper');

/**
 * POST /api/companies/create-for-developer
 *
 * Onboards a developer account by:
 *  1. Creating the company document
 *  2. Generating a system API key for the tenant
 *  3. Seeding default data stores
 *  4. Triggering an async website-scraping job
 *  5. Creating a default AI employee + campaign
 *  6. Issuing a new JWT scoped to the new company
 *
 * Each side-effect step uses its own try/catch so a partial failure
 * never aborts the entire onboarding flow.
 */
export const createForDeveloper: Endpoint = {
  path: '/create-for-developer',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const { payload } = req;

    // Parse body
    try {
      await addDataAndFileToRequest(req);
    } catch (err) {
      logger.error('Invalid request body or file', { error: err });
      return Response.json(
        {
          success: false,
          status: HttpStatus.BAD_REQUEST,
          error: getApiError(ApiResponseErrorType.BAD_REQUEST),
        } as IApiResponse<never>,
        { status: HttpStatus.BAD_REQUEST },
      );
    }

    try {
      // Auth guards
      if (!req.user) {
        logger.warn('Unauthorized request - no user');
        return ResponseError.unauthorized();
      }
      if (req.user.collection !== 'customers') {
        logger.warn('Forbidden - user is not a customer');
        return ResponseError.forbidden();
      }

      const customer = req.user;

      if (customer.role !== AccountType.DEVELOPER) {
        logger.warn(`<${customer.id}> Forbidden - customer is not a developer`);
        return ResponseError.forbidden();
      }

      // Destructure and validate payload
      const {
        companyName,
        companyType,
        customIndustry,
        websiteUrl,
        phoneNumber,
        firstName,
        lastName,
        jobTitle,
        workEmail,
      } = req.data as IUserData;

      if (companyType === 'custom' && !customIndustry?.trim()) {
        logger.warn(`<${customer.id}> Missing customIndustry for custom companyType`);
        return Response.json(
          {
            success: false,
            error: { message: 'customIndustry is required when companyType is custom' },
          },
          { status: HttpStatus.BAD_REQUEST },
        );
      }

      // ── Step 1: Create company ────────────────────────────────────────────────
      const company = await payload.create({
        collection: 'companies',
        data: {
          general: {
            general: {
              title:               companyName,
              customerFirstName:   firstName,
              customerLastName:    lastName,
              customerJobTitle:    jobTitle,
              email:               workEmail,
              industry:            companyType,
              customIndustry,
              website:             websiteUrl,
              phone:               phoneNumber || '',
            },
            subscription: {
              subscriptionPlan:   'free',
              subscriptionStatus: 'active',
              paymentStatus:      'pending',
            },
            onboarding: {
              onboardingStage: 'initial',
            },
          },
        },
      });

      const companyId = company.id;

      // ── Step 2: Provision system API key for the tenant ───────────────────────
      const systemApiKey = await ensureCompanySystemApiKey(payload, companyId);

      // Mark most onboarding sections as visited (developer skips them)
      const UNMARKED_TRIGGERS = new Set([
        'knowledge_base',
        'inbox',
        'employees',
        'validation_center_qa',
        'analytics',
        'api_key',
      ]);
      const visitedSections = ONBOARDING_TRIGGERS.filter(
        (trigger) => !UNMARKED_TRIGGERS.has(trigger),
      );

      await payload.update({
        collection: 'customers',
        id: req.user.id,
        data: { company: company.id, visitedSections },
      });

      await ensureCustomerMembershipForCompany(payload, req.user.id, company.id);

      // ── Step 3: Seed default data stores (indexes, storage buckets) ───────────
      try {
        await dataStorageService.seedTenant(company.id, companyType);
      } catch (error) {
        logger.error(`<${companyId}> Seed tenant error`, { error });
      }

      // ── Step 4: Kick off async website scraping ───────────────────────────────
      try {
        await scrapeService.sixtySecondsScraping({
          tenantId:      company.id,
          companyName,
          userFirstName: firstName,
          userLastName:  lastName,
          workEmail,
          userJobtitle:  jobTitle,
          websiteUrl,
        });
      } catch (error) {
        logger.error(`<${companyId}> Start scraping hook error`, { error });
      }

      // ── Step 5: Create default AI employee + campaign ─────────────────────────
      try {
        logger.info(`<${companyId}> Creating default General Helper employee`);
        const employee = await employeesService.createEmployee(payload, {
          tenantId: company.id,
          name:     'General Helper',
          role:     'generalHelper',
        });

        // Campaign is only wired up when the workflow service is configured
        if (process.env.RMS_API_URL) {
          const webhook = (process.env.N8N_GENERAL_HELPER_WEBHOOK_URL || '').replace(
            '{{tenant_id}}',
            company.id,
          );
          logger.info(`<${companyId}> Creating campaign for General Helper employee`, {
            employeeId: employee.id,
          });
          await campaignsService.createCampaign({
            tenantId:  company.id,
            expertId:  employee.id,
            name:      "General Helper's Campaign",
            n8nCampaignWebhook: webhook,
            paramPresets: applySystemApiKeyToPresets(
              {
                employeeName:    'General Helper',
                role:            'You are a general-purpose AI assistant for the company',
                tonality:        'Professional and friendly',
                format:          'Concise and clear responses',
                mentionPromotion: '',
                initialMessage:  'Hi! How can I help you today?',
                dontTellCustomers: '',
                handoverToHuman: 'Transfer to a human agent when the customer explicitly requests it',
              },
              'generalHelper',
              systemApiKey,
            ),
          });
        }
        logger.info(`<${companyId}> Default employee and campaign created`);
      } catch (error) {
        logger.error(`<${companyId}> Error creating default employee/campaign`, { error });
      }

      await ensureCustomerMembershipForCompany(payload, req.user.id, company.id);

      // ── Step 6: Issue a new JWT scoped to the new company ─────────────────────
      const accessToken = await jwtService.generateToken(
        { id: customer.id, email: customer.email, companyId: company.id },
        'access',
      );

      logger.info(`<${companyId}> Company created successfully for developer`, {
        customerId: customer.id,
      });

      return Response.json(
        {
          success: true,
          status: HttpStatus.OK,
          data: {
            companyId: company.id,
            message:   'Company created successfully',
            accessToken,
          },
        } as IApiResponse,
        { status: HttpStatus.OK },
      );
    } catch (error: any) {
      logger.error('Error creating company for developer', { error });
      return ResponseError.internalServerError();
    }
  },
};
