/**
 * Test that tenant migration commands only require and use certificate fields, and require SSL to
 * to be enabled when 'tenantMigrationDisableX509Auth' server parameter is false (default).
 * Note: If a migration is started and SSL is not enabled on the recipient, we will repeatedly get
 * back HostUnreachable on the donor side.
 *
 * @tags: [
 *   incompatible_with_macos,
 *   # Shard merge protocol will be tested by tenant_migration_shard_merge_ssl_configuration.js.
 *   incompatible_with_shard_merge,
 *   requires_majority_read_concern,
 *   requires_persistence,
 *   serverless,
 * ]
 */

import {TenantMigrationTest} from "jstests/replsets/libs/tenant_migration_test.js";
import {
    getCertificateAndPrivateKey,
    makeMigrationCertificatesForTest,
    makeX509OptionsForTest,
} from "jstests/replsets/libs/tenant_migration_util.js";

load("jstests/libs/uuid_util.js");

const kTenantId = ObjectId().str;
const kReadPreference = {
    mode: "primary"
};
const kValidMigrationCertificates = makeMigrationCertificatesForTest();
const kExpiredMigrationCertificates = {
    donorCertificateForRecipient:
        getCertificateAndPrivateKey("jstests/libs/tenant_migration_donor_expired.pem"),
    recipientCertificateForDonor:
        getCertificateAndPrivateKey("jstests/libs/tenant_migration_recipient_expired.pem")
};

(() => {
    jsTest.log(
        "Test that certificate fields are required when tenantMigrationDisableX509Auth=false");
    const tenantMigrationTest = new TenantMigrationTest({name: jsTestName()});

    const donorPrimary = tenantMigrationTest.getDonorPrimary();
    const recipientPrimary = tenantMigrationTest.getRecipientPrimary();

    jsTest.log("Test that donorStartMigration requires 'donorCertificateForRecipient' when  " +
               "tenantMigrationDisableX509Auth=false");
    assert.commandFailedWithCode(donorPrimary.adminCommand({
        donorStartMigration: 1,
        migrationId: UUID(),
        recipientConnectionString: tenantMigrationTest.getRecipientRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference,
        recipientCertificateForDonor: kValidMigrationCertificates.recipientCertificateForDonor,
    }),
                                 ErrorCodes.InvalidOptions);

    jsTest.log("Test that donorStartMigration requires 'recipientCertificateForDonor' when  " +
               "tenantMigrationDisableX509Auth=false");
    assert.commandFailedWithCode(donorPrimary.adminCommand({
        donorStartMigration: 1,
        migrationId: UUID(),
        recipientConnectionString: tenantMigrationTest.getRecipientRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference,
        donorCertificateForRecipient: kValidMigrationCertificates.donorCertificateForRecipient,
    }),
                                 ErrorCodes.InvalidOptions);

    jsTest.log("Test that recipientSyncData requires 'recipientCertificateForDonor' when " +
               "tenantMigrationDisableX509Auth=false");
    assert.commandFailedWithCode(recipientPrimary.adminCommand({
        recipientSyncData: 1,
        migrationId: UUID(),
        donorConnectionString: tenantMigrationTest.getDonorRst().getURL(),
        tenantId: kTenantId,
        startMigrationDonorTimestamp: Timestamp(1, 1),
        readPreference: kReadPreference
    }),
                                 ErrorCodes.InvalidOptions);

    jsTest.log("Test that recipientForgetMigration requires 'recipientCertificateForDonor' when " +
               "tenantMigrationDisableX509Auth=false");
    assert.commandFailedWithCode(recipientPrimary.adminCommand({
        recipientForgetMigration: 1,
        migrationId: UUID(),
        donorConnectionString: tenantMigrationTest.getDonorRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference
    }),
                                 ErrorCodes.InvalidOptions);

    tenantMigrationTest.stop();
})();

(() => {
    jsTest.log("Test that donorStartMigration fails if SSL is not enabled on the donor and " +
               "tenantMigrationDisableX509Auth=false");
    const donorRst = new ReplSetTest({nodes: 1, name: "donor", serverless: true});
    donorRst.startSet();
    donorRst.initiate();

    const tenantMigrationTest = new TenantMigrationTest({name: jsTestName(), donorRst});

    const donorPrimary = tenantMigrationTest.getDonorPrimary();

    assert.commandFailedWithCode(donorPrimary.adminCommand({
        donorStartMigration: 1,
        migrationId: UUID(),
        recipientConnectionString: tenantMigrationTest.getRecipientRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference,
        donorCertificateForRecipient: kValidMigrationCertificates.donorCertificateForRecipient,
        recipientCertificateForDonor: kValidMigrationCertificates.recipientCertificateForDonor,
    }),
                                 ErrorCodes.IllegalOperation);

    donorRst.stopSet();
    tenantMigrationTest.stop();
})();

(() => {
    jsTest.log("Test that recipientSyncData fails if SSL is not enabled on the recipient and " +
               "tenantMigrationDisableX509Auth=false");
    const recipientRst = new ReplSetTest({nodes: 1, name: "recipient", serverless: true});
    recipientRst.startSet();
    recipientRst.initiate();

    const tenantMigrationTest = new TenantMigrationTest({name: jsTestName(), recipientRst});

    const recipientPrimary = tenantMigrationTest.getRecipientPrimary();

    assert.commandFailedWithCode(recipientPrimary.adminCommand({
        recipientSyncData: 1,
        migrationId: UUID(),
        donorConnectionString: tenantMigrationTest.getDonorRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference,
        startMigrationDonorTimestamp: Timestamp(1, 1),
        recipientCertificateForDonor: kValidMigrationCertificates.recipientCertificateForDonor,
    }),
                                 ErrorCodes.IllegalOperation);

    recipientRst.stopSet();
    tenantMigrationTest.stop();
})();

(() => {
    jsTest.log("Test that recipientSyncData doesn't require 'recipientCertificateForDonor' when " +
               "tenantMigrationDisableX509Auth=true");
    const migrationX509Options = makeX509OptionsForTest();
    const recipientRst = new ReplSetTest({
        nodes: 1,
        name: "recipient",
        serverless: true,
        nodeOptions: Object.assign(migrationX509Options.recipient,
                                   {setParameter: {tenantMigrationDisableX509Auth: true}})
    });

    recipientRst.startSet();
    recipientRst.initiate();

    const tenantMigrationTest = new TenantMigrationTest({name: jsTestName(), recipientRst});
    const recipientPrimary = tenantMigrationTest.getRecipientPrimary();

    assert.commandWorked(recipientPrimary.adminCommand({
        recipientSyncData: 1,
        migrationId: UUID(),
        donorConnectionString: tenantMigrationTest.getDonorRst().getURL(),
        tenantId: kTenantId,
        startMigrationDonorTimestamp: Timestamp(1, 1),
        readPreference: kReadPreference
    }));

    recipientRst.stopSet();
    tenantMigrationTest.stop();
})();

(() => {
    jsTest.log(
        "Test that recipientForgetMigration doesn't require 'recipientCertificateForDonor' when " +
        "tenantMigrationDisableX509Auth=true");
    const migrationX509Options = makeX509OptionsForTest();
    const recipientRst = new ReplSetTest({
        nodes: 1,
        name: "recipient",
        serverless: true,
        nodeOptions: Object.assign(migrationX509Options.recipient,
                                   {setParameter: {tenantMigrationDisableX509Auth: true}})
    });

    recipientRst.startSet();
    recipientRst.initiate();

    const tenantMigrationTest = new TenantMigrationTest({name: jsTestName(), recipientRst});

    const recipientPrimary = tenantMigrationTest.getRecipientPrimary();

    assert.commandWorked(recipientPrimary.adminCommand({
        recipientForgetMigration: 1,
        migrationId: UUID(),
        donorConnectionString: tenantMigrationTest.getDonorRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference
    }));

    recipientRst.stopSet();
    tenantMigrationTest.stop();
})();

(() => {
    jsTest.log("Test that donorStartMigration doesn't require certificate fields when " +
               "tenantMigrationDisableX509Auth=true");
    const migrationX509Options = makeX509OptionsForTest();
    const donorRst = new ReplSetTest({
        nodes: 1,
        name: "donor",
        serverless: true,
        nodeOptions: Object.assign(migrationX509Options.donor,
                                   {setParameter: {tenantMigrationDisableX509Auth: true}})
    });
    const recipientRst = new ReplSetTest({
        nodes: 1,
        name: "recipient",
        serverless: true,
        nodeOptions: Object.assign(migrationX509Options.recipient,
                                   {setParameter: {tenantMigrationDisableX509Auth: true}})
    });

    donorRst.startSet();
    donorRst.initiate();

    recipientRst.startSet();
    recipientRst.initiate();

    const tenantMigrationTest =
        new TenantMigrationTest({name: jsTestName(), donorRst, recipientRst});

    const migrationId = UUID();
    const donorStartMigrationCmdObj = {
        donorStartMigration: 1,
        migrationIdString: extractUUIDFromObject(migrationId),
        recipientConnectionString: tenantMigrationTest.getRecipientRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference
    };
    const stateRes =
        assert.commandWorked(tenantMigrationTest.runMigration(donorStartMigrationCmdObj));
    assert.eq(stateRes.state, TenantMigrationTest.DonorState.kCommitted);
    assert.commandWorked(
        donorRst.getPrimary().adminCommand({donorForgetMigration: 1, migrationId: migrationId}));

    donorRst.stopSet();
    recipientRst.stopSet();
    tenantMigrationTest.stop();
})();

(() => {
    jsTest.log("Test that tenant migration doesn't fail if SSL is not enabled on the donor and " +
               "the recipient and tenantMigrationDisableX509Auth=true");

    const donorRst = new ReplSetTest({
        nodes: 1,
        name: "donor",
        serverless: true,
        nodeOptions: {setParameter: {tenantMigrationDisableX509Auth: true}}
    });
    const recipientRst = new ReplSetTest({
        nodes: 1,
        name: "recipient",
        serverless: true,
        nodeOptions: {setParameter: {tenantMigrationDisableX509Auth: true}}
    });

    donorRst.startSet();
    donorRst.initiate();

    recipientRst.startSet();
    recipientRst.initiate();

    const tenantMigrationTest =
        new TenantMigrationTest({name: jsTestName(), donorRst, recipientRst});

    const donorStartMigrationCmdObj = {
        donorStartMigration: 1,
        migrationIdString: extractUUIDFromObject(UUID()),
        recipientConnectionString: tenantMigrationTest.getRecipientRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference
    };

    const stateRes =
        assert.commandWorked(tenantMigrationTest.runMigration(donorStartMigrationCmdObj));
    assert.eq(stateRes.state, TenantMigrationTest.DonorState.kCommitted);

    donorRst.stopSet();
    recipientRst.stopSet();
    tenantMigrationTest.stop();
})();

(() => {
    jsTest.log(
        "Test that input certificate fields are not used when tenantMigrationDisableX509Auth=true");
    const migrationX509Options = makeX509OptionsForTest();
    const donorRst = new ReplSetTest({
        nodes: 1,
        name: "donor",
        serverless: true,
        nodeOptions: Object.assign(migrationX509Options.donor,
                                   {setParameter: {tenantMigrationDisableX509Auth: true}})
    });
    const recipientRst = new ReplSetTest({
        nodes: 1,
        name: "recipient",
        serverless: true,
        nodeOptions: Object.assign(migrationX509Options.recipient,
                                   {setParameter: {tenantMigrationDisableX509Auth: true}})
    });

    donorRst.startSet();
    donorRst.initiate();

    recipientRst.startSet();
    recipientRst.initiate();

    const tenantMigrationTest =
        new TenantMigrationTest({name: jsTestName(), donorRst, recipientRst});

    const donorStartMigrationCmdObj = {
        donorStartMigration: 1,
        migrationIdString: extractUUIDFromObject(UUID()),
        recipientConnectionString: tenantMigrationTest.getRecipientRst().getURL(),
        tenantId: kTenantId,
        readPreference: kReadPreference,
        donorCertificateForRecipient: kExpiredMigrationCertificates.donorCertificateForRecipient,
        recipientCertificateForDonor: kExpiredMigrationCertificates.recipientCertificateForDonor,
    };
    const stateRes =
        assert.commandWorked(tenantMigrationTest.runMigration(donorStartMigrationCmdObj));
    assert.eq(stateRes.state, TenantMigrationTest.DonorState.kCommitted);

    donorRst.stopSet();
    recipientRst.stopSet();
    tenantMigrationTest.stop();
})();
