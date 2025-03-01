/**
 * Test that $queryStats properly tokenizes find commands, on mongod and mongos.
 */
load("jstests/libs/query_stats_utils.js");
(function() {
"use strict";

const kHashedFieldName = "lU7Z0mLRPRUL+RfAD5jhYPRRpXBsZBxS/20EzDwfOG4=";

function runTest(conn) {
    const db = conn.getDB("test");
    const admin = conn.getDB("admin");

    db.test.drop();
    db.test.insert({v: 1});

    db.test.find({v: 1}).toArray();

    let queryStats = getQueryStatsFindCmd(admin, {transformIdentifiers: true});

    assert.eq(1, queryStats.length);
    assert.eq("find", queryStats[0].key.queryShape.command);
    assert.eq({[kHashedFieldName]: {$eq: "?number"}}, queryStats[0].key.queryShape.filter);

    db.test.insert({v: 2});

    const cursor = db.test.find({v: {$gt: 0, $lt: 3}}).batchSize(1);
    queryStats = getQueryStatsFindCmd(admin, {transformIdentifiers: true});
    // Cursor isn't exhausted, so there shouldn't be another entry yet.
    assert.eq(1, queryStats.length);

    assert.commandWorked(
        db.runCommand({getMore: cursor.getId(), collection: db.test.getName(), batchSize: 2}));

    queryStats = getQueryStatsFindCmd(admin, {transformIdentifiers: true});
    assert.eq(2, queryStats.length);
    assert.eq("find", queryStats[1].key.queryShape.command);
    assert.eq({
        "$and": [{[kHashedFieldName]: {"$gt": "?number"}}, {[kHashedFieldName]: {"$lt": "?number"}}]
    },
              queryStats[1].key.queryShape.filter);
}

let conn = MongoRunner.runMongod({
    setParameter: {
        internalQueryStatsRateLimit: -1,
        featureFlagQueryStats: true,
    }
});
runTest(conn);
MongoRunner.stopMongod(conn);

// TODO SERVER-79494 remove second run with find-command-only feature flag
conn = MongoRunner.runMongod({
    setParameter: {
        internalQueryStatsRateLimit: -1,
        featureFlagQueryStatsFindCommand: true,
    }
});
runTest(conn);
MongoRunner.stopMongod(conn);

let st = new ShardingTest({
    mongos: 1,
    shards: 1,
    config: 1,
    rs: {nodes: 1},
    mongosOptions: {
        setParameter: {
            internalQueryStatsRateLimit: -1,
            featureFlagQueryStats: true,
            'failpoint.skipClusterParameterRefresh': "{'mode':'alwaysOn'}"
        }
    },
});
runTest(st.s);
st.stop();

// TODO SERVER-79494 remove second run with find-command-only feature flag
st = new ShardingTest({
    mongos: 1,
    shards: 1,
    config: 1,
    rs: {nodes: 1},
    mongosOptions: {
        setParameter: {
            internalQueryStatsRateLimit: -1,
            featureFlagQueryStatsFindCommand: true,
            'failpoint.skipClusterParameterRefresh': "{'mode':'alwaysOn'}"
        }
    },
});
runTest(st.s);
st.stop();
}());
