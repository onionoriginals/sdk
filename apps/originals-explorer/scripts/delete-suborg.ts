/**
 * Delete a Turnkey sub-organization
 * Usage: bun run scripts/delete-suborg.ts <email>
 */

import 'dotenv/config';
import { Turnkey } from '@turnkey/sdk-server';

const email = process.argv[2];

if (!email) {
  console.error('Usage: bun run scripts/delete-suborg.ts <email>');
  process.exit(1);
}

const turnkeyClient = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY!,
  apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY!,
  defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID!,
});

async function deleteSubOrgForEmail(email: string) {
  try {
    console.log(`🔍 Looking for sub-org for ${email}...`);

    // Get sub-org IDs filtered by email
    const result = await turnkeyClient.apiClient().getSubOrgIds({
      organizationId: process.env.TURNKEY_ORGANIZATION_ID!,
      filterType: 'EMAIL',
      filterValue: email,
    });

    const subOrgIds = result.organizationIds || [];

    if (subOrgIds.length === 0) {
      console.log('❌ No sub-org found for this email');
      return;
    }

    console.log(`Found ${subOrgIds.length} sub-org(s):`);
    subOrgIds.forEach((id, i) => {
      console.log(`  ${i + 1}. ${id}`);
    });

    // Delete each matching sub-org
    for (const subOrgId of subOrgIds) {
      console.log(`\n🗑️  Deleting ${subOrgId}...`);

      try {
        await turnkeyClient.apiClient().deleteSubOrganization({
          organizationId: subOrgId,
        });
        console.log(`✅ Deleted ${subOrgId}`);
      } catch (err: any) {
        console.error(`❌ Failed to delete ${subOrgId}:`, err.message);
      }
    }

    console.log('\n✨ Done!');

  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

deleteSubOrgForEmail(email);
