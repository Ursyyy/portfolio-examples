import { adminOrCustomer, adminRestrictedAccess } from '@/access';
import { authenticateCustomer } from '@/middleware/auth';
import { filterRolesBySiblingCompany, getCustomerPanelURL } from '@/utils/common';
import type { CollectionConfig } from 'payload';
import { AccountType } from '@/types/auth';
import { ONBOARDING_TRIGGERS } from '@/types/common';
import {
  postMarkVisited,
  removeCustomer,
  postUploadAgentSession,
  postOnboardingChatSession,
} from '@/endpoints/customers';
import { templateEngine } from '@/providers/email';
import { forgetCustomerInNotifications } from '@/services/notifications';

/**
 * Payload CMS collection definition for the `customers` collection.
 *
 * Key design decisions:
 *  - Custom JWT authentication strategy (`customer-token-strategy`) so the
 *    standard Payload session cookie is not used.
 *  - `companyMemberships` array drives multi-tenant RBAC: each entry links
 *    a customer to a company with a specific role preset.
 *  - `visitedSections` tracks onboarding progress for developer accounts.
 *  - Two session-ID fields (`uploadAgentSession`, `onboardingChatSession`)
 *    store opaque IDs for embedded AI chat widgets.
 */
export const Customers: CollectionConfig = {
  slug: 'customers',
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'actions'],
  },
  access: {
    ...adminRestrictedAccess,
    read:   adminOrCustomer,
    delete: adminOrCustomer,
  },
  hooks: {
    // Use a dedicated service instead of cascadeDelete because there can be
    // thousands of notification records per customer.
    afterDelete: [
      async ({ req, id }) => {
        await forgetCustomerInNotifications(req.payload, String(id), undefined, req);
      },
    ],
  },
  auth: {
    forgotPassword: {
      generateEmailHTML: async ({ token } = {}) => {
        const resetLink = `${getCustomerPanelURL()}/auth/reset-password?token=${token}`;
        return templateEngine.render('password-reset', {
          resetLink,
          expiresIn: '1 hour',
        });
      },
    },
    removeTokenFromResponses: true,  // never expose raw JWT in API responses
    useSessions: false,              // stateless – JWT only
    strategies: [
      {
        name: 'customer-token-strategy',
        authenticate: authenticateCustomer,
      },
    ],
  },
  fields: [
    { name: 'firstName', type: 'text' },
    { name: 'lastName',  type: 'text' },
    {
      name:     'email',
      type:     'email',
      index:    true,
      required: true,
      unique:   true,
    },
    {
      name: 'phoneNumber',
      type: 'text',
      admin: { description: 'Optional contact phone number' },
    },
    {
      name: 'role',
      type: 'select',
      options: [
        { label: 'Business',   value: AccountType.BUSINESS },
        { label: 'Developer',  value: AccountType.DEVELOPER },
      ],
      defaultValue: AccountType.BUSINESS,
      required: true,
      admin: {
        description: 'Account type: Business (single company) or Developer (multiple companies)',
      },
    },
    {
      name:       'company',
      type:       'relationship',
      relationTo: 'companies',
      required:   true,
      hasMany:    false,
      admin: { description: 'Primary / current company' },
    },
    {
      name:    'visitedSections',
      type:    'select',
      hasMany: true,
      options: ONBOARDING_TRIGGERS.map((s) => ({ label: s, value: s })),
      admin:   { description: 'Onboarding sections the developer has visited' },
    },
    {
      // Multi-tenant RBAC: a customer can belong to multiple companies
      // each with a different role preset.
      name: 'companyMemberships',
      type: 'array',
      admin: { description: 'Per-company RBAC role assignment' },
      fields: [
        {
          name:       'company',
          type:       'relationship',
          relationTo: 'companies',
          required:   true,
        },
        {
          name:          'role',
          type:          'relationship',
          relationTo:    'roles',
          required:      true,
          filterOptions: filterRolesBySiblingCompany,
        },
      ],
    },
    {
      name: 'uploadAgentSession',
      type: 'text',
      admin: { description: 'Active session ID for the AI upload-agent chat widget' },
    },
    {
      name: 'onboardingChatSession',
      type: 'text',
      admin: { description: 'Active session ID for the onboarding / internal chat widget' },
    },
    {
      // Admin-panel UI component for impersonating a customer (admin only)
      name: 'actions',
      type: 'ui',
      admin: {
        components: {
          Cell: '@/components/ImpersonateCustomer',
        },
      },
    },
  ],
  endpoints: [
    postMarkVisited,
    removeCustomer,
    postUploadAgentSession,
    postOnboardingChatSession,
  ],
};
