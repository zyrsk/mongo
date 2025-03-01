/**
 * Tests that shard merge works with different journal compressor options.
 *
 * @tags: [
 *   incompatible_with_macos,
 *   incompatible_with_windows_tls,
 *   requires_majority_read_concern,
 *   requires_persistence,
 *   serverless,
 *   featureFlagShardMerge
 * ]
 */

import {TenantMigrationTest} from "jstests/replsets/libs/tenant_migration_test.js";
import {
    isShardMergeEnabled,
    makeTenantDB,
    makeX509OptionsForTest,
} from "jstests/replsets/libs/tenant_migration_util.js";

load("jstests/libs/uuid_util.js");

function runTest(nodeJournalCompressorOptions) {
    jsTestLog("Testing tenant migration for the following journal compressor options: " +
              tojson(nodeJournalCompressorOptions));

    // Allow donor to run data consistency checks after migration commit.
    const donorSetParamOptions = {
        setParameter:
            {"failpoint.tenantMigrationDonorAllowsNonTimestampedReads": tojson({mode: "alwaysOn"})}
    };
    const donorRst = new ReplSetTest({
        nodes: 1,
        name: 'donorRst',
        serverless: true,
        nodeOptions: Object.assign(
            makeX509OptionsForTest().donor, nodeJournalCompressorOptions, donorSetParamOptions)
    });
    donorRst.startSet();
    donorRst.initiate();

    // Note: including this explicit early return here due to the fact that multiversion
    // suites will execute this test without featureFlagShardMerge enabled (despite the
    // presence of the featureFlagShardMerge tag above), which means the test will attempt
    // to run a multi-tenant migration and fail.
    if (!isShardMergeEnabled(donorRst.getPrimary().getDB("admin"))) {
        donorRst.stopSet();
        jsTestLog("Skipping Shard Merge-specific test");
        quit();
    }

    const recipientRst = new ReplSetTest({
        nodes: 1,
        name: 'recipientRst',
        serverless: true,
        nodeOptions: Object.assign(makeX509OptionsForTest().recipient, nodeJournalCompressorOptions)
    });
    recipientRst.startSet();
    recipientRst.initiate();

    const tenantMigrationTest = new TenantMigrationTest({donorRst, recipientRst});

    const tenantId = ObjectId();
    const tenantDB = makeTenantDB(tenantId.str, "testDB");
    const collName = "testColl";

    // Do a majority write.
    tenantMigrationTest.insertDonorDB(tenantDB, collName);

    const migrationOpts = {
        migrationIdString: extractUUIDFromObject(UUID()),
        tenantIds: [tenantId],
    };

    TenantMigrationTest.assertCommitted(tenantMigrationTest.runMigration(migrationOpts));

    tenantMigrationTest.stop();
    recipientRst.stopSet();
    donorRst.stopSet();
}

["snappy", "zlib", "zstd"].forEach(option => runTest({"wiredTigerJournalCompressor": option}));
