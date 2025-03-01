/**
 * Test the behavior of per-batch writeConcern in dbCheck.
 *
 * @tags: [
 *   # We need persistence as we temporarily restart nodes.
 *   requires_persistence,
 *   assumes_against_mongod_not_mongos,
 * ]
 */

import {checkHealthlog, resetAndInsert, runDbCheck} from "jstests/replsets/libs/dbcheck_utils.js";

(function() {
"use strict";

const replSet = new ReplSetTest({
    name: "dbCheckWriteConcern",
    nodes: 2,
    nodeOptions: {setParameter: {dbCheckHealthLogEveryNBatches: 1}},
    settings: {
        // Prevent the primary from stepping down when we temporarily shut down the secondary.
        electionTimeoutMillis: 120000
    }
});
replSet.startSet();
replSet.initiate();

const dbName = "dbCheck-writeConcern";
const collName = "test";
const primary = replSet.getPrimary();
const db = primary.getDB(dbName);
const coll = db[collName];
const healthlog = db.getSiblingDB('local').system.healthlog;

// Validate that w:majority behaves normally.
(function testWMajority() {
    // Insert 1000 docs and run a few small batches to ensure we wait for write concern between
    // each one.
    const nDocs = 1000;
    const maxDocsPerBatch = 100;
    resetAndInsert(replSet, db, collName, nDocs);

    const dbCheckParameters = {maxDocsPerBatch: maxDocsPerBatch};
    runDbCheck(replSet, db, collName, dbCheckParameters);

    // Confirm dbCheck logs the expected number of batches.
    checkHealthlog(
        healthlog, {operation: "dbCheckBatch", severity: "info"}, nDocs / maxDocsPerBatch);

    // Confirm there are no warnings or errors.
    checkHealthlog(healthlog, {operation: "dbCheckBatch", severity: "warning"}, 0);
    checkHealthlog(healthlog, {operation: "dbCheckBatch", severity: "error"}, 0);
})();

// Validate that w:2 behaves normally.
(function testW2() {
    // Insert 1000 docs and run a few small batches to ensure we wait for write concern between
    // each one.
    const nDocs = 1000;
    const maxDocsPerBatch = 100;
    const writeConcern = {w: 2};
    resetAndInsert(replSet, db, collName, nDocs);

    const dbCheckParameters = {
        maxDocsPerBatch: maxDocsPerBatch,
        batchWriteConcern: {w: 'majority'}
    };
    runDbCheck(replSet, db, collName, dbCheckParameters);

    // Confirm dbCheck logs the expected number of batches.
    checkHealthlog(
        healthlog, {operation: "dbCheckBatch", severity: "info"}, nDocs / maxDocsPerBatch);

    // Confirm there are no warnings or errors.
    checkHealthlog(healthlog, {operation: "dbCheckBatch", severity: "warning"}, 0);
    checkHealthlog(healthlog, {operation: "dbCheckBatch", severity: "error"}, 0);
})();

// Validate that dbCheck completes with w:majority even when the secondary is down and a wtimeout is
// specified.
(function testWMajorityUnavailable() {
    // Insert 1000 docs and run a few small batches to ensure we wait for write concern between
    // each one.
    const nDocs = 1000;
    const maxDocsPerBatch = 100;
    resetAndInsert(replSet, db, collName, nDocs);

    // Stop the secondary and expect that the dbCheck batches still complete on the primary.
    const secondaryConn = replSet.getSecondary();
    const secondaryNodeId = replSet.getNodeId(secondaryConn);
    replSet.stop(secondaryNodeId, {forRestart: true /* preserve dbPath */});

    const writeConcern = {w: 'majority', wtimeout: 10};
    const dbCheckParameters = {maxDocsPerBatch: maxDocsPerBatch, batchWriteConcern: writeConcern};
    runDbCheck(replSet, db, collName, dbCheckParameters);

    // Confirm dbCheck logs the expected number of batches.
    checkHealthlog(
        healthlog, {operation: "dbCheckBatch", severity: "info"}, nDocs / maxDocsPerBatch);

    // Confirm dbCheck logs a warning for every batch.
    checkHealthlog(
        healthlog, {operation: "dbCheckBatch", severity: "warning"}, nDocs / maxDocsPerBatch);

    // There should be no errors.
    checkHealthlog(healthlog, {operation: "dbCheckBatch", severity: "error"}, 0);

    replSet.start(secondaryNodeId, {}, true /*restart*/);
    replSet.awaitNodesAgreeOnPrimaryNoAuth();
    replSet.awaitReplication();
})();

// Validate that an invalid 'w' setting still allows dbCheck to succeed when presented with a
// wtimeout.
(function testW3Unavailable() {
    // Insert 1000 docs and run a few small batches to ensure we wait for write concern between
    // each one.
    const nDocs = 1000;
    const maxDocsPerBatch = 100;
    resetAndInsert(replSet, db, collName, nDocs);

    // Stop the secondary and expect that the dbCheck batches still complete on the primary.
    const secondaryConn = replSet.getSecondary();
    const secondaryNodeId = replSet.getNodeId(secondaryConn);
    replSet.stop(secondaryNodeId, {forRestart: true /* preserve dbPath */});

    const writeConcern = {w: 3, wtimeout: 10};
    const dbCheckParameters = {maxDocsPerBatch: maxDocsPerBatch, batchWriteConcern: writeConcern};
    runDbCheck(replSet, db, collName, dbCheckParameters);

    // Confirm dbCheck logs the expected number of batches.
    checkHealthlog(
        healthlog, {operation: "dbCheckBatch", severity: "info"}, nDocs / maxDocsPerBatch);

    // Confirm dbCheck logs a warning for every batch.
    checkHealthlog(
        healthlog, {operation: "dbCheckBatch", severity: "warning"}, nDocs / maxDocsPerBatch);

    // There should be no errors.
    checkHealthlog(healthlog, {operation: "dbCheckBatch", severity: "error"}, 0);
})();

replSet.stopSet();
})();
