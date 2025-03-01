/**
 *    Copyright (C) 2023-present MongoDB, Inc.
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

#include "mongo/tools/workload_simulation/throughput_probing/throughput_probing_simulator.h"

#include <stop_token>

#include "mongo/db/storage/execution_control/throughput_probing.h"
#include "mongo/db/storage/execution_control/throughput_probing_gen.h"
#include "mongo/db/storage/storage_engine_feature_flags_gen.h"
#include "mongo/db/storage/storage_engine_parameters_gen.h"
#ifdef __linux__
#include "mongo/util/concurrency/priority_ticketholder.h"
#endif
#include "mongo/util/concurrency/semaphore_ticketholder.h"

#define MONGO_LOGV2_DEFAULT_COMPONENT ::mongo::logv2::LogComponent::kTest

namespace mongo::workload_simulation {

ThroughputProbing::ThroughputProbing(
    StringData workloadName, int32_t min, int32_t initial, int32_t max, Milliseconds interval)
    : Simulation("ThroughputProbing", workloadName),
      _minTickets{min},
      _initialTickets{initial},
      _maxTickets{max},
      _probingInterval{interval} {}

void ThroughputProbing::setup() {
    Simulation::setup();

#ifdef __linux__
    if (feature_flags::gFeatureFlagDeprioritizeLowPriorityOperations
            .isEnabledAndIgnoreFCVUnsafeAtStartup()) {
        auto lowPriorityBypassThreshold = gLowPriorityAdmissionBypassThreshold.load();
        _readTicketHolder = std::make_unique<PriorityTicketHolder>(
            _initialTickets, lowPriorityBypassThreshold, svcCtx());
        _writeTicketHolder = std::make_unique<PriorityTicketHolder>(
            _initialTickets, lowPriorityBypassThreshold, svcCtx());
    } else {
        _readTicketHolder = std::make_unique<SemaphoreTicketHolder>(_initialTickets, svcCtx());
        _writeTicketHolder = std::make_unique<SemaphoreTicketHolder>(_initialTickets, svcCtx());
    }
#else
    _readTicketHolder = std::make_unique<SemaphoreTicketHolder>(_initialTickets, svcCtx());
    _writeTicketHolder = std::make_unique<SemaphoreTicketHolder>(_initialTickets, svcCtx());
#endif

    _runner = [svcCtx = svcCtx()] {
        auto runner = std::make_unique<MockPeriodicRunner>();
        auto runnerPtr = runner.get();
        svcCtx->setPeriodicRunner(std::move(runner));
        return runnerPtr;
    }();

    execution_control::throughput_probing::gMinConcurrency = _minTickets;
    execution_control::throughput_probing::gInitialConcurrency = _initialTickets;
    execution_control::throughput_probing::gMaxConcurrency.store(_maxTickets);
    _throughputProbing = std::make_unique<execution_control::ThroughputProbing>(
        svcCtx(), _readTicketHolder.get(), _writeTicketHolder.get(), _probingInterval);

    _probingThread = std::jthread([this](std::stop_token token) {
        while (!token.stop_requested()) {
            if (queue().wait_for(_probingInterval, EventQueue::WaitType::Observer)) {
                _runner->run(client());
            }
        }
    });
}

void ThroughputProbing::teardown() {
    _running.store(false);
    _driver->stop();

    Simulation::teardown();

    _driver.reset();

    _probingThread.request_stop();
    _probingThread.join();

    _throughputProbing.reset();
    _writeTicketHolder.reset();
    _readTicketHolder.reset();
    _runner = nullptr;
}

size_t ThroughputProbing::actorCount() const {
    size_t count = 0;
    if (_readTicketHolder->queued() > 0) {
        count += _readTicketHolder->outof();
    } else {
        count += _readTicketHolder->used();
    }
    if (_writeTicketHolder->queued() > 0) {
        count += _writeTicketHolder->outof();
    } else {
        count += _writeTicketHolder->used();
    }
    // Due to the way the ticket holder implementation resizes down, we have to
    // add a fudge factor here. Otherwise, we could encounter a deadlock, as the
    // ticket holder may be waiting to acquire tickets to burn, while they are
    // held by threads waiting in our queue. The holder implementation only
    // updates the outof() value once it has finished burning all the
    // disappearing tickets.
    return count * (1 - execution_control::throughput_probing::gStepMultiple.loadRelaxed());
}

boost::optional<BSONObj> ThroughputProbing::metrics() const {
    if (!_running.load()) {
        return boost::none;
    }
    return _driver->metrics();
}

void ThroughputProbing::start(std::unique_ptr<TicketedWorkloadDriver>&& driver,
                              int32_t numReaders,
                              int32_t numWriters) {
    // Start up.
    _driver = std::move(driver);
    _driver->start(
        svcCtx(), _readTicketHolder.get(), _writeTicketHolder.get(), numReaders, numWriters);
    _running.store(true);
}

void ThroughputProbing::resize(int32_t numReaders, int32_t numWriters) {
    invariant(_running.load());
    _driver->resize(numReaders, numWriters);
}

void ThroughputProbing::run(Seconds runTime) {
    invariant(_running.load());
    queue().wait_for(runTime, EventQueue::WaitType::Observer);
}


}  // namespace mongo::workload_simulation
