/**
 *    Copyright (C) 2022-present MongoDB, Inc.
 *
 *    This program is free software: you can redistribute it and/or modify
 *    it under the terms of the Server Side Public License, version 1,
 *    as published by MongoDB, Inc.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    Server Side Public License for more details.
 *
 *    You should have received a copy of the Server Side Public License
 *    along with this program. If not, see
 *    <http://www.mongodb.com/licensing/server-side-public-license>.
 *
 *    As a special exception, the copyright holders give permission to link the
 *    code of portions of this program with the OpenSSL library under certain
 *    conditions as described in each individual source file and distribute
 *    linked combinations including the program with the OpenSSL library. You
 *    must comply with the Server Side Public License in all respects for
 *    all of the code used other than as permitted herein. If you modify file(s)
 *    with this exception, you may extend this exception to your version of the
 *    file(s), but you are not obligated to do so. If you do not wish to do so,
 *    delete this exception statement from your version. If you delete this
 *    exception statement from all source files in the program, then also delete
 *    it in the license file.
 */

#include "mongo/util/database_name_util.h"

#include <boost/move/utility_core.hpp>
#include <boost/none.hpp>
#include <boost/optional.hpp>
#include <utility>

#include <boost/optional/optional.hpp>

#include "mongo/base/error_codes.h"
#include "mongo/base/status.h"
#include "mongo/base/status_with.h"
#include "mongo/bson/oid.h"
#include "mongo/db/database_name.h"
#include "mongo/db/feature_flag.h"
#include "mongo/db/multitenancy_gen.h"
#include "mongo/db/server_feature_flags_gen.h"
#include "mongo/db/server_options.h"
#include "mongo/util/assert_util.h"
#include "mongo/util/str.h"

namespace mongo {

std::string DatabaseNameUtil::serialize(const DatabaseName& dbName,
                                        const SerializationContext& context) {
    if (!gMultitenancySupport)
        dbName.toString();

    if (context.getSource() == SerializationContext::Source::Command &&
        context.getCallerType() == SerializationContext::CallerType::Reply)
        return serializeForCommands(dbName, context);

    // if we're not serializing a Command Reply, use the default serializing rules
    return serializeForStorage(dbName, context);
}

std::string DatabaseNameUtil::serializeForStorage(const DatabaseName& dbName,
                                                  const SerializationContext& context) {
    if (gFeatureFlagRequireTenantID.isEnabled(serverGlobalParams.featureCompatibility)) {
        return dbName.toString();
    }
    return dbName.toStringWithTenantId();
}

std::string DatabaseNameUtil::serializeForCatalog(const DatabaseName& dbName,
                                                  const SerializationContext& context) {
    return dbName.toStringWithTenantId();
}

std::string DatabaseNameUtil::serializeForRemoteCmdRequest(const DatabaseName& dbName) {
    return dbName.toStringWithTenantId();
}

std::string DatabaseNameUtil::serializeForCommands(const DatabaseName& dbName,
                                                   const SerializationContext& context) {
    // tenantId came from either a $tenant field or security token.
    if (context.receivedNonPrefixedTenantId()) {
        switch (context.getPrefix()) {
            case SerializationContext::Prefix::ExcludePrefix:
                // fallthrough
            case SerializationContext::Prefix::Default:
                return dbName.toString();
            case SerializationContext::Prefix::IncludePrefix:
                return dbName.toStringWithTenantId();
            default:
                MONGO_UNREACHABLE;
        }
    }

    // tenantId came from the prefix.
    switch (context.getPrefix()) {
        case SerializationContext::Prefix::ExcludePrefix:
            return dbName.toString();
        case SerializationContext::Prefix::Default:
            // fallthrough
        case SerializationContext::Prefix::IncludePrefix:
            return dbName.toStringWithTenantId();
        default:
            MONGO_UNREACHABLE;
    }
}

DatabaseName DatabaseNameUtil::parseFromStringExpectTenantIdInMultitenancyMode(StringData dbName) {
    if (!gMultitenancySupport) {
        return DatabaseName(boost::none, dbName);
    }

    auto tenantDelim = dbName.find('_');
    if (tenantDelim == std::string::npos) {
        return DatabaseName(boost::none, dbName);
    }

    auto swOID = OID::parse(dbName.substr(0, tenantDelim));
    if (swOID.getStatus() == ErrorCodes::BadValue) {
        // If we fail to parse an OID, either the size of the substring is incorrect, or there is an
        // invalid character. This indicates that the db has the "_" character, but it does not act
        // as a delimeter for a tenantId prefix.
        return DatabaseName(boost::none, dbName);
    }

    const TenantId tenantId(swOID.getValue());
    return DatabaseName(tenantId, dbName.substr(tenantDelim + 1));
}

DatabaseName DatabaseNameUtil::deserialize(boost::optional<TenantId> tenantId,
                                           StringData db,
                                           const SerializationContext& context) {
    if (db.empty()) {
        return DatabaseName(tenantId, "");
    }

    if (!gMultitenancySupport) {
        uassert(7005302, "TenantId must not be set, but it is: ", tenantId == boost::none);
        return DatabaseName(boost::none, db);
    }

    if (context.getSource() == SerializationContext::Source::Command &&
        context.getCallerType() == SerializationContext::CallerType::Request)
        return deserializeForCommands(std::move(tenantId), db, context);

    // if we're not deserializing a Command Request, use the default deserializing rules
    return deserializeForStorage(std::move(tenantId), db, context);
}

DatabaseName DatabaseNameUtil::deserializeForStorage(boost::optional<TenantId> tenantId,
                                                     StringData db,
                                                     const SerializationContext& context) {
    if (gFeatureFlagRequireTenantID.isEnabled(serverGlobalParams.featureCompatibility)) {
        // TODO SERVER-73113 Uncomment out this conditional to check that we always have a tenantId.
        /* if (db != "admin" && db != "config" && db != "local")
            uassert(7005300, "TenantId must be set", tenantId != boost::none);
        */

        return DatabaseName(std::move(tenantId), db);
    }

    auto dbName = DatabaseNameUtil::parseFromStringExpectTenantIdInMultitenancyMode(db);
    // TenantId could be prefixed, or passed in separately (or both) and namespace is always
    // constructed with the tenantId separately.
    if (tenantId != boost::none) {
        if (!dbName.tenantId()) {
            return DatabaseName(std::move(tenantId), db);
        }
        uassert(7005301, "TenantId must match that in db prefix", tenantId == dbName.tenantId());
    }
    return dbName;
}

DatabaseName DatabaseNameUtil::deserializeForCommands(boost::optional<TenantId> tenantId,
                                                      StringData db,
                                                      const SerializationContext& context) {
    // we only get here if we are processing a Command Request.  We disregard the feature flag in
    // this case, essentially letting the request dictate the state of the feature.

    // We received a tenantId from $tenant or the security token.
    if (tenantId != boost::none) {
        switch (context.getPrefix()) {
            case SerializationContext::Prefix::ExcludePrefix:
                // fallthrough
            case SerializationContext::Prefix::Default:
                return DatabaseName(std::move(tenantId), db);
            case SerializationContext::Prefix::IncludePrefix: {
                auto dbName = parseFromStringExpectTenantIdInMultitenancyMode(db);
                uassert(
                    8423386,
                    str::stream()
                        << "TenantId supplied by $tenant or security token as '"
                        << tenantId->toString()
                        << "' but prefixed tenantId also required given expectPrefix is set true",
                    dbName.tenantId());
                uassert(
                    8423384,
                    str::stream()
                        << "TenantId from $tenant or security token must match prefixed tenantId: "
                        << tenantId->toString() << " prefix " << dbName.tenantId()->toString(),
                    tenantId.value() == dbName.tenantId());
                return dbName;
            }
            default:
                MONGO_UNREACHABLE;
        }
    }

    // We received the tenantId from the prefix.
    auto dbName = parseFromStringExpectTenantIdInMultitenancyMode(db);
    // TODO SERVER-73113 Uncomment out this conditional to check that we always have a tenantId.
    // if ((dbName != DatabaseName::kAdmin) && (dbName != DatabaseName::kLocal) &&
    //     (dbName != DatabaseName::kConfig))
    //     uassert(8423388, "TenantId must be set", dbName.tenantId() != boost::none);

    return dbName;
}

DatabaseName DatabaseNameUtil::deserializeForCatalog(StringData db,
                                                     const SerializationContext& context) {
    // TenantId always prefix in the passed `db` for durable catalog. This method below checks for
    // multitenancy and will either return a DatabaseName with (tenantId, nonPrefixedDb) or
    // (none, prefixedDb).
    return DatabaseNameUtil::parseFromStringExpectTenantIdInMultitenancyMode(db);
}

DatabaseName DatabaseNameUtil::deserializeForErrorMsg(StringData dbInErrMsg) {
    // TenantId always prefix in the error message. This method returns either (tenantId,
    // nonPrefixedDb) or (none, prefixedDb) depending on gMultitenancySupport flag.
    return DatabaseNameUtil::parseFromStringExpectTenantIdInMultitenancyMode(dbInErrMsg);
}

}  // namespace mongo
