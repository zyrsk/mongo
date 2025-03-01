// Tests that it is illegal to read from system.views and system.profile within a transaction.
// The test runs commands that are not allowed with security token: profile.
// @tags: [
//   not_allowed_with_security_token,uses_transactions, uses_snapshot_read_concern]
(function() {
"use strict";

load("jstests/libs/fixture_helpers.js");  // For 'FixtureHelpers'.

const session = db.getMongo().startSession();

// Use a custom database to avoid conflict with other tests.
const testDB = session.getDatabase("no_reads_from_system_colls_in_txn");
assert.commandWorked(testDB.dropDatabase());

testDB.runCommand({create: "foo", viewOn: "bar", pipeline: []});

session.startTransaction({readConcern: {level: "snapshot"}});
assert.commandFailedWithCode(testDB.runCommand({find: "system.views", filter: {}}),
                             [ErrorCodes.OperationNotSupportedInTransaction, 51071]);
assert.commandFailedWithCode(session.abortTransaction_forTesting(), ErrorCodes.NoSuchTransaction);

session.startTransaction({readConcern: {level: "snapshot"}});
assert.commandFailedWithCode(testDB.runCommand({find: "system.profile", filter: {}}),
                             ErrorCodes.OperationNotSupportedInTransaction);
assert.commandFailedWithCode(session.abortTransaction_forTesting(), ErrorCodes.NoSuchTransaction);

if (FixtureHelpers.isMongos(testDB)) {
    // The rest of the test is concerned with a find by UUID which is not supported against
    // mongos.
    return;
}

const collectionInfos =
    new DBCommandCursor(testDB, assert.commandWorked(testDB.runCommand({listCollections: 1})));
let systemViewsUUID = null;
while (collectionInfos.hasNext()) {
    const next = collectionInfos.next();
    if (next.name === "system.views") {
        systemViewsUUID = next.info.uuid;
    }
}
assert.neq(null, systemViewsUUID, "did not find UUID for system.views");

session.startTransaction({readConcern: {level: "snapshot"}});
assert.commandFailedWithCode(testDB.runCommand({find: systemViewsUUID, filter: {}}),
                             [ErrorCodes.OperationNotSupportedInTransaction, 51070, 7195700]);
assert.commandFailedWithCode(session.abortTransaction_forTesting(), ErrorCodes.NoSuchTransaction);
}());
