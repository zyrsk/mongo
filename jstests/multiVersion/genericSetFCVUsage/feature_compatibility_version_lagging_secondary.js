// Tests that a primary with upgrade featureCompatibilityVersion cannot connect with a secondary
// with a lower binary version.
(function() {
"use strict";

load("jstests/libs/write_concern_util.js");

const latest = "latest";

function runTest(downgradeVersion) {
    jsTestLog("Running test with downgradeVersion: " + downgradeVersion);
    const downgradeFCV = binVersionToFCV(downgradeVersion);
    // Start a new replica set with two latest version nodes.
    let rst = new ReplSetTest({
        nodes: [{binVersion: latest}, {binVersion: latest, rsConfig: {priority: 0}}],
        settings: {chainingAllowed: false}
    });
    rst.startSet();
    rst.initiate();

    let primary = rst.getPrimary();
    let latestSecondary = rst.getSecondary();

    // The default WC is majority and stopServerReplication will prevent satisfying any majority
    // writes.
    assert.commandWorked(primary.adminCommand(
        {setDefaultRWConcern: 1, defaultWriteConcern: {w: 1}, writeConcern: {w: "majority"}}));

    // Set the featureCompatibilityVersion to the downgrade version so that a downgrade node can
    // join the set.
    assert.commandWorked(primary.getDB("admin").runCommand(
        {setFeatureCompatibilityVersion: downgradeFCV, confirm: true}));

    // Add a downgrade node to the set.
    let downgradeSecondary = rst.add({binVersion: downgradeVersion, rsConfig: {priority: 0}});
    rst.reInitiate();

    // Wait for the downgrade secondary to finish initial sync.
    rst.awaitSecondaryNodes();
    rst.awaitReplication();
    rst.waitForAllNewlyAddedRemovals();

    // Stop replication on the downgrade secondary.
    stopServerReplication(downgradeSecondary);

    // Set the featureCompatibilityVersion to the upgrade version. This will not replicate to
    // the downgrade secondary, but the downgrade secondary will no longer be able to
    // communicate with the rest of the set.
    assert.commandWorked(
        primary.adminCommand({setFeatureCompatibilityVersion: latestFCV, confirm: true}));

    // Shut down the latest version secondary.
    rst.stop(latestSecondary);

    // The primary should step down, since it can no longer see a majority of the replica set.
    rst.waitForState(primary, ReplSetTest.State.SECONDARY);

    restartServerReplication(downgradeSecondary);
    rst.stopSet();
}

runTest('last-continuous');
runTest('last-lts');
})();
