/**
 * Verifies the fsync with lock+unlock command on mongos.
 * @tags: [
 *   requires_fsync,
 *   featureFlagClusterFsyncLock,
 *   uses_parallel_shell,
 * ]
 */

import {ConfigShardUtil} from "jstests/libs/config_shard_util.js";

(function() {
"use strict";

const dbName = "test";
const collName = "collTest";
const ns = dbName + "." + collName;
const st = new ShardingTest({
    shards: 2,
    mongos: 1,
    mongosOptions: {setParameter: {featureFlagClusterFsyncLock: true}},
    config: 1,
    configShard: true,
    enableBalancer: true
});
const adminDB = st.s.getDB('admin');

function waitUntilOpCountIs(opFilter, num, st) {
    assert.soon(() => {
        let ops = st.s.getDB('admin')
                      .aggregate([
                          {$currentOp: {}},
                          {$match: opFilter},
                      ])
                      .toArray();
        if (ops.length != num) {
            jsTest.log("Num operations: " + ops.length + ", expected: " + num);
            jsTest.log(ops);
            return false;
        }
        return true;
    });
}

let collectionCount = 1;
const performFsyncLockUnlockWithReadWriteOperations = function() {
    // lock then unlock
    assert.commandWorked(st.s.adminCommand({fsync: 1, lock: true}));

    // Make sure writes are blocked. Spawn a write operation in a separate shell and make sure it
    // is blocked. There is really no way to do that currently, so just check that the write didn't
    // go through.
    let codeToRun = () => {
        assert.commandWorked(db.getSiblingDB("test").getCollection("collTest").insert({x: 1}));
    };

    let writeOpHandle = startParallelShell(codeToRun, st.s.port);

    waitUntilOpCountIs({op: 'insert', ns: 'test.collTest', waitingForLock: true}, 1, st);

    // Make sure reads can still run even though there is a pending write and also that the write
    // didn't get through.
    assert.eq(collectionCount, coll.count());
    assert.commandWorked(st.s.adminCommand({fsyncUnlock: 1}));

    writeOpHandle();

    // ensure writers are allowed after the cluster is unlocked
    assert.commandWorked(coll.insert({x: 1}));
    collectionCount += 2;
    assert.eq(coll.count(), collectionCount);

    // Ensure that fsync (lock: false) still works by performing a write after invoking the command,
    // and checking the write is successful, showing the cluster does not need to be unlocked.
    assert.commandWorked(st.s.adminCommand({fsync: 1, lock: false}));
    assert.commandWorked(coll.insert({x: 2}));
    collectionCount += 1;
    assert.eq(coll.count(), collectionCount);
};

jsTest.log("Insert some data.");
const coll = st.s0.getDB(dbName)[collName];
assert.commandWorked(coll.insert({x: 1}));

// unlock before lock should fail
let ret = assert.commandFailed(st.s.adminCommand({fsyncUnlock: 1}));
const errmsg = "fsyncUnlock called when not locked";
assert.eq(ret.errmsg.includes(errmsg), true);

performFsyncLockUnlockWithReadWriteOperations();

// Make sure the lock and unlock commands still work as expected after transitioning to a dedicated
// config server.
st.s.adminCommand({movePrimary: dbName, to: st.shard1.shardName});
ConfigShardUtil.transitionToDedicatedConfigServer(st);
performFsyncLockUnlockWithReadWriteOperations();

st.stop();
}());
